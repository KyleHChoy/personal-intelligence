import type { Envelope } from "@intelligence/contracts";
import { ClaimRecord, type ContactDetails, type UntrustedString } from "@intelligence/contracts/personal";
import { type Ctx, noteServed, type Sealed, untrusted } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";
import { FIND_FACTS } from "./read-fact-rows.ts";
import { ORG_NAME_SERVED } from "./read-fragments.ts";

// An organization's names, for get_entity: the owner's (`pi org name`), then the organization_name of each
// role and affiliation claim whose organization is this one, newest first. With `contacts`, the one
// organization each of the owner's own (`own`) saved contacts with an address on the organization's domain
// lists is served apart, as a use-only detail as detailsOf serves a person's. Every row is read under the
// token, so a name comes only from what the caller may see, and a claim is held to find_facts' rules by
// find_facts' own statement. Each statement is sent whatever the organization holds. `shown` and `factKeyFps`
// are what the read log records of what was served: each claim's and each contact's evidence, and each
// claim's fact key.

// The most names a card shows, and the claims of each type read for them.
const NAMES = 10;
const CLAIMS = 20;

const OWNER_NAMES = `
  select n.id, n.compartments, n.name_enc as value_enc
  from knowledge.organization_names n
  where n.domain_fp = any($1)
  order by n.id`;

// The contacts with an address held by an account on one of the domains.
const CONTACTS = `
  select c.id, c.compartments, c.facts_enc, c.evidence_id
  from knowledge.contacts c
  where c.compartments = array['own']::text[]
    and c.id in (select x.contact_id from knowledge.contact_addresses x
                 where x.value_fp in (select a.value_fp from knowledge.accounts a where a.domain_fp = any($1)))
  order by c.id
  limit $2`;

type FactRow = { id: string; compartments: string[]; content_enc: Envelope; evidence_id: string; fact_key_fp: string };

type OrganizationNames = {
  names: UntrustedString[];
  details: ContactDetails[];
  shown: string[];
  factKeyFps: string[];
};

// A role or affiliation claim's fields, as a row of FIND_FACTS holds them; none for a record that
// does not parse.
function claimFieldsOf(ctx: Ctx, row: FactRow): Record<string, unknown> {
  const record = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
  return record.success ? record.data.claim.content.fields : {};
}

export async function organizationNames(
  ctx: Ctx,
  organization: string,
  domainFps: readonly string[],
  options: { contacts: boolean },
): Promise<OrganizationNames> {
  const names: { name: string; evidence: string | null; factKey: string | null }[] = [];
  for (const row of await ctx.run<Sealed>(OWNER_NAMES, [[...domainFps]]))
    names.push({
      name: untrusted(ctx, "knowledge.organization_names", "name_enc", row).untrusted,
      evidence: null,
      factKey: null,
    });
  for (const type of ["role", "affiliation"]) {
    for (const row of await ctx.run<FactRow>(FIND_FACTS, [type, [organization], null, null, CLAIMS])) {
      const fields = claimFieldsOf(ctx, row);
      if (fields.organization === organization && typeof fields.organization_name === "string")
        names.push({ name: fields.organization_name, evidence: row.evidence_id, factKey: row.fact_key_fp });
    }
  }
  const served = new Map<string, { evidence: string | null; factKey: string | null }[]>();
  for (const one of names) {
    const name = one.name.trim();
    if (name === "" || (!served.has(name) && served.size >= NAMES)) continue;
    served.set(name, [...(served.get(name) ?? []), one]);
  }
  const from = [...served.values()].flat();
  const details: ContactDetails[] = [];
  const contactEvidence: string[] = [];
  if (options.contacts) {
    for (const row of await ctx.run<SealedRow<"knowledge.contacts.facts_enc"> & { evidence_id: string }>(CONTACTS, [
      [...domainFps],
      CLAIMS,
    ])) {
      const { organizations } = servedJson(ctx, row, "knowledge.contacts.facts_enc") as { organizations?: unknown };
      const named = Array.isArray(organizations)
        ? organizations.flatMap((one: { name?: unknown }) =>
            typeof one?.name === "string" && one.name.trim() !== "" ? [one.name.trim()] : [],
          )
        : [];
      if (named.length !== 1) continue;
      details.push({
        disclosure: "use_only",
        names: [],
        phones: [],
        organizations: [{ name: { untrusted: named[0] as string }, title: null }],
        birthday: null,
      });
      contactEvidence.push(row.evidence_id);
    }
  }
  return {
    names: [...served.keys()].map((name) => ({ untrusted: name })),
    details,
    shown: [...new Set([...from.flatMap((one) => (one.evidence === null ? [] : [one.evidence])), ...contactEvidence])],
    factKeyFps: [...new Set(from.flatMap((one) => (one.factKey === null ? [] : [one.factKey])))],
  };
}

// The one name whoOf gives each organization among `organizations`, the first of
// get_entity's names but a contact's: the owner's, else the organization_name of the newest role
// claim about it, else of the newest affiliation claim's. Each of the three statements is sent
// whatever `organizations` holds; their claims are read under one limit for all, CLAIMS for each
// organization. With `within`, only rows whose compartments are within it name one, as whoOf's
// `within` ranks people's names. The claim a name came from goes into the call's read log, as
// get_entity's names' claims do: `ctx.served`, which `logRead` adds. An owner's name rests on no
// evidence.
const OWNER_NAMES_OF = `
  select d.entity_id, n.id, n.compartments, n.name_enc as value_enc
  from knowledge.organization_names n
  join knowledge.domains d on d.domain_fp = n.domain_fp
  where d.entity_id = any($1)
  order by d.entity_id, n.id, d.id`;

const ORG_NAME_ROWS = `
  select o.entity_id, o.id, o.compartments, o.name_enc as value_enc, o.evidence_id
  from knowledge.org_names o
  where o.entity_id = any($1::text[]) and ${ORG_NAME_SERVED}
  order by o.entity_id, o.id`;

type NameRow = Sealed & { entity_id: string; evidence_id: string };

// Each organization's first name by its name rows, among rows within `within` when given, and the
// item it came from, which a caller that serves the name puts in the call's read log, as
// organizationNamesOf's claims go. One statement, sent whatever `organizations` holds.
export async function orgNamesOf(
  ctx: Ctx,
  organizations: readonly string[],
  within?: readonly string[],
): Promise<Map<string, { name: UntrustedString; evidence: string }>> {
  const names = new Map<string, { name: UntrustedString; evidence: string }>();
  for (const row of await ctx.run<NameRow>(ORG_NAME_ROWS, [[...organizations]])) {
    if (names.has(row.entity_id) || (within !== undefined && !row.compartments.every((one) => within.includes(one))))
      continue;
    names.set(row.entity_id, {
      name: untrusted(ctx, "knowledge.org_names", "name_enc", row),
      evidence: row.evidence_id,
    });
  }
  return names;
}

// Every distinct name of one organization's name rows the caller sees, in row order, and the items
// they came from.
export async function orgNameList(
  ctx: Ctx,
  organization: string,
): Promise<{ names: UntrustedString[]; shown: string[] }> {
  const rows = await ctx.run<NameRow>(ORG_NAME_ROWS, [[organization]]);
  const names = [
    ...new Set(rows.map((row) => untrusted(ctx, "knowledge.org_names", "name_enc", row).untrusted.trim())),
  ];
  return {
    names: names.map((name) => ({ untrusted: name })),
    shown: [...new Set(rows.map((row) => row.evidence_id))].sort(),
  };
}

export async function organizationNamesOf(
  ctx: Ctx,
  organizations: readonly string[],
  within?: readonly string[],
): Promise<Map<string, UntrustedString>> {
  const fits = (compartments: readonly string[]): boolean =>
    within === undefined || compartments.every((one) => within.includes(one));
  const names = new Map<string, UntrustedString>();
  for (const row of await ctx.run<Sealed & { entity_id: string }>(OWNER_NAMES_OF, [[...organizations]])) {
    if (!names.has(row.entity_id) && fits(row.compartments))
      names.set(row.entity_id, untrusted(ctx, "knowledge.organization_names", "name_enc", row));
  }
  for (const type of ["role", "affiliation"]) {
    for (const row of await ctx.run<FactRow>(FIND_FACTS, [
      type,
      [...organizations],
      null,
      null,
      CLAIMS * Math.max(1, organizations.length),
    ])) {
      if (!fits(row.compartments)) continue;
      const fields = claimFieldsOf(ctx, row);
      const organization = fields.organization;
      const name = typeof fields.organization_name === "string" ? fields.organization_name.trim() : "";
      if (
        typeof organization === "string" &&
        organizations.includes(organization) &&
        !names.has(organization) &&
        name !== ""
      ) {
        names.set(organization, { untrusted: name });
        // Read-logged with the call (ctx.served): the claim's evidence shown and its fact key.
        noteServed(ctx, { shown: [row.evidence_id], factKeyFps: [row.fact_key_fp] });
      }
    }
  }
  return names;
}
