import { createHash } from "node:crypto";
import {
  BELIEF_TYPES,
  type CaptureId,
  type CaptureKey,
  type ClientView,
  type DeviceAnchorView,
  type EntityId,
  type EventId,
  MIRROR_SECTION_VIEW,
  type MirrorEntry,
  type MirrorSection,
  type MirrorTemplate,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { mirrorValue } from "@intelligence/personal-core/lens";
import { byText, stamp, stampOrNull } from "../core/db.ts";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import { type ClientGroups, type Ctx, Unavailable } from "../core/read-ctx.ts";
import { open, type Sealed } from "../core/seal.ts";
import { OWN_CONTACT_CLAIM, SOURCE_NOT_HELD } from "../core/statements.ts";
import { RELEASE_IN_FORCE } from "../core/visibility.ts";
import { asOfOf, beliefIdOf, beliefsAt, clearanceOf } from "../read/computed-beliefs.ts";
import type { FactRow as MirrorFactRow } from "../read/read-fact-rows.ts";
import { packEntity } from "../read/read-pack-items.ts";
import { MIRROR_TIES, TIE_TYPES } from "../read/read-ties.ts";
import { DETAIL_CONTACTS, entityOf } from "../read/read-tools-entity.ts";
import { MEETING_COLUMNS, type MeetingRow, meetingsOf } from "../read/read-who.ts";
import { beliefMarkTokens } from "./mirror-belief-tokens.ts";
import { mirrorBeliefs, mirrorFactViews } from "./mirror-facts.ts";

// Lens's mirror, its five sections. Each section reads its source rows under the caller's token, in
// its key order, from a position: the clear columns its source token is made of, and nothing
// sealed. A row whose member the chosen version does not list is left out of the scan, as a row the
// client cannot see. Only the rows mirror-sync.ts builds are opened, each built as the read tool
// whose shape it serves builds it (get_entity, get_beliefs, find_facts, MeetingView), and
// normalized by core's mirrorValue. No text of a message, a document or a capture item is in any
// value.

// The most source rows one call scans.
export const SCAN_ROWS = 2000;
// The days either side of the call an event is served in, and the days a moment is.
const EVENT_DAYS = 180;
const MOMENT_DAYS = 90;
// The most device anchors a project's entry carries.
const ANCHORS = 50;

// One source row as scanned: its entry key, its source token, and what its build
// needs.
export type ScanRow = { key: string; token: string };
// One entry built: its value (the section's field), what serve_mirror checks it against, and the
// fact key fingerprint for a belief or a fact.
export type Built = {
  section: MirrorSection;
  value: unknown;
  fact: string | null;
  evidence: string[];
  entities: string[];
  anchors: string[];
  compartments: string[];
  source?: string;
  // A person's entry: its group's visible members, and its group contacts' evidence
  // ids.
  members?: string[];
  contactEvidence?: string[];
  // An organization's entry: the evidence ids of the claims its names may come from; a belief's: its support.
  claimEvidence?: string[];
  support?: string[];
};
// `last` is the key of the last source row the scan covered, kept or not, so a scan whose every
// row was filtered out is not read as the section's end; null when the scan covered nothing.
type Scan<Row extends ScanRow = ScanRow> = { rows: Row[]; complete: boolean; last: string | null };

// What a section is read with: the call's token, its client, the version chosen, the call's time
// and the client's groups.
export type SectionContext = {
  ctx: Ctx;
  client: ClientView;
  template: MirrorTemplate;
  now: Date;
  groups: ClientGroups;
};

export type Section<Row extends ScanRow = ScanRow> = {
  name: MirrorSection;
  // Whether the client holds the section's view at all.
  open(client: ClientView): boolean;
  scan(at: SectionContext, after: string | null): Promise<Scan<Row>>;
  // The rows built, by key; a row absent from the map is one the client cannot see.
  build(at: SectionContext, rows: Row[]): Promise<Map<string, Built>>;
};

const sha = (parts: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(byText);
// A label in text order.
const labelled = (compartments: readonly string[]): string[] => [...compartments].sort(byText);
const grouped = <Row>(rows: Row[], keyOf: (row: Row) => string): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const row of rows) out.set(keyOf(row), [...(out.get(keyOf(row)) ?? []), row]);
  return out;
};
// A scan of one row more than asked: complete when the section ended within it.
const scanned = <Row extends ScanRow>(rows: Row[]): Scan<Row> => {
  const kept = rows.slice(0, SCAN_ROWS);
  return { rows: kept, complete: rows.length <= SCAN_ROWS, last: kept.at(-1)?.key ?? null };
};

// ---------------------------------------------------------------------------------------------
// entities: every person, organization and project the client sees, as get_entity builds a
// PackEntity, a project's with its live device anchors. A person who is not the
// lowest visible member of their group is not an entry: get_entity answers for the group by that
// id.
// ---------------------------------------------------------------------------------------------

const ENTITIES = `
  select e.id, e.kind from knowledge.entities e
  where e.kind = any($1::text[]) and ($2::text is null or e.id > ($2::text collate "C"))
  order by e.id collate "C"
  limit $3`;
const ENTITY_ACCOUNTS =
  "select a.entity_id, a.id, a.compartments, a.value_fp from knowledge.accounts a where a.entity_id = any($1) order by a.entity_id, a.id";
const ENTITY_ALIASES =
  "select s.entity_id, s.id, s.compartments, s.value_fp, s.evidence_id from knowledge.aliases s where s.entity_id = any($1) order by s.entity_id, s.id";
const ENTITY_DOMAINS =
  "select d.entity_id, d.id, d.compartments, d.domain_fp as value_fp from knowledge.domains d where d.entity_id = any($1) order by d.entity_id, d.id";
// The visible contacts that list an address of one of the given people, each with the people its
// visible addresses resolved to: a group's contacts are those of two to nineteen addresses, every
// one a member (read-tools.ts' GROUPS_CONTACTS, whose names get_entity serves for the group).
const ENTITY_CONTACTS = `
  select c.id, c.evidence_id, c.updated_at, c.compartments,
    array(select a.entity_id from knowledge.contact_addresses a where a.contact_id = c.id order by a.entity_id) as people
  from knowledge.contacts c
  where exists (select 1 from knowledge.contact_addresses a where a.contact_id = c.id and a.entity_id = any($1))
  order by c.id`;
// The owner's own contacts with an address on one of the given organizations' domains, whose
// organization get_entity serves as a use-only detail.
const ORGANIZATION_CONTACTS = `
  select distinct c.id, c.evidence_id, c.updated_at, c.compartments, d.entity_id as organization
  from knowledge.contacts c
  join knowledge.contact_addresses x on x.contact_id = c.id
  join knowledge.accounts a on a.value_fp = x.value_fp
  join knowledge.domains d on d.domain_fp = a.domain_fp
  where c.compartments = array['own']::text[] and d.entity_id = any($1)
  order by d.entity_id, c.id`;
// The role and affiliation claims that name one of the given organizations, whose
// organization_name get_entity serves among its names. Every one the token returns, not only
// those organizationNames keeps, so an entry rests on at least the claims its names came from:
// one more can only taint it more.
const ORGANIZATION_CLAIMS = `
  select distinct n.entity_id as organization, c.id, c.evidence_id, c.compartments
  from knowledge.claim_entities n
  join knowledge.claims c on c.id = n.claim_id
  where n.entity_id = any($1)
    and (c.type in ('role', 'affiliation') or starts_with(c.type, 'role.') or starts_with(c.type, 'affiliation.'))
    and ${RELEASE_IN_FORCE}
  order by n.entity_id, c.id`;
// The organizations of the given people's accounts, by domain: get_entity's ORGANIZATIONS_OF.
const ENTITY_ORGANIZATIONS = `
  select a.entity_id, d.entity_id as organization from knowledge.accounts a
  join knowledge.domains d on d.domain_fp = a.domain_fp
  where a.entity_id = any($1)
  order by a.entity_id, d.entity_id`;
const ENTITY_PROJECTS =
  "select p.id, p.status, p.compartments, md5(p.name_enc::text) as name_fp from knowledge.projects p where p.id = any($1) order by p.id";
// A project's live device anchors: a thread anchor is never served, nor a window
// title's, which has no value: an anchor with no sealed value is left out, as
// policy.serve_mirror refuses one.
const LIVE_ANCHORS = `
  select a.id, a.project_id, a.kind, a.compartments from knowledge.project_anchors a
  where a.project_id = any($1) and a.lifted_at is null and a.value_enc is not null
  order by a.project_id, a.id collate "C"`;
const ANCHOR_VALUES = `
  select a.id, a.kind, a.compartments, a.value_enc from knowledge.project_anchors a
  where a.project_id = $1 and a.lifted_at is null and a.value_enc is not null
  order by a.id collate "C"`;

type EntityRow = ScanRow & {
  key: EntityId;
  kind: SubjectKind;
  members: string[];
  evidence: string[];
  contactEvidence: string[];
  claimEvidence: string[];
  compartments: string[];
  anchorIds: string[];
};
type Labelled = { entity_id: string; id: string; compartments: string[]; value_fp: string };
type ContactRow = { id: string; evidence_id: string; updated_at: Date; compartments: string[]; people: string[] };
// A row cited by its evidence, under its label.
type Cited = { id: string; evidence_id: string; compartments: string[] };

const entityKinds = (at: { client: ClientView; template: MirrorTemplate }): string[] =>
  at.template.members.entityKinds.filter((kind) => {
    const view = MIRROR_SECTION_VIEW.entities[kind];
    return view !== undefined && at.client.views.includes(view);
  });

// What an entity's entry rests on, read for every row of a scan at once, each by entity.
async function entitySourcesOf(
  ctx: Ctx,
  kept: readonly { id: string; kind: SubjectKind }[],
  members: ReadonlyMap<string, string[]>,
  anchorKinds: readonly string[],
) {
  const everyone = sorted([...members.values()].flat());
  const accounts = grouped(await ctx.run<Labelled>(ENTITY_ACCOUNTS, [everyone]), (row) => row.entity_id);
  const aliases = grouped(
    await ctx.run<Labelled & { evidence_id: string }>(ENTITY_ALIASES, [everyone]),
    (row) => row.entity_id,
  );
  const domains = grouped(await ctx.run<Labelled>(ENTITY_DOMAINS, [everyone]), (row) => row.entity_id);
  const projectIds = kept.filter((row) => row.kind === "project").map((row) => row.id);
  const projects = new Map(
    (
      await ctx.run<{ id: string; status: string; compartments: string[]; name_fp: string }>(ENTITY_PROJECTS, [
        projectIds,
      ])
    ).map((row) => [row.id, row]),
  );
  const anchors = grouped(
    (
      await ctx.run<{ id: string; project_id: string; kind: string; compartments: string[] }>(LIVE_ANCHORS, [
        projectIds,
      ])
    ).filter((row) => anchorKinds.includes(row.kind)),
    (row) => row.project_id,
  );
  // A group's contacts, and every `own` contact behind get_entity's details: a
  // person's, as detailsOf reads them, and an organization's, as organizationNames does. A
  // contact deleted or changed then changes the entry's token.
  const people = kept.filter((row) => row.kind === "person").flatMap((row) => members.get(row.id) ?? []);
  const contacts = people.length === 0 ? [] : await ctx.run<ContactRow>(ENTITY_CONTACTS, [sorted(people)]);
  // The confirmed ties and links get_entity serves.
  const tieRows = grouped(
    people.length === 0 ? [] : await ctx.run<Cited & { entity_id: string }>(MIRROR_TIES, [sorted(people), TIE_TYPES]),
    (row) => row.entity_id,
  );
  const orgIds = kept.filter((row) => row.kind === "organization").map((row) => row.id);
  const orgContacts = grouped(
    orgIds.length === 0 ? [] : await ctx.run<ContactRow & { organization: string }>(ORGANIZATION_CONTACTS, [orgIds]),
    (row) => row.organization,
  );
  // And an organization's role and affiliation claims, whose names it serves.
  const orgClaims = grouped(
    orgIds.length === 0 ? [] : await ctx.run<Cited & { organization: string }>(ORGANIZATION_CLAIMS, [orgIds]),
    (row) => row.organization,
  );
  const organizations = grouped(
    await ctx.run<{ entity_id: string; organization: string }>(ENTITY_ORGANIZATIONS, [everyone]),
    (row) => row.entity_id,
  );
  return { accounts, aliases, domains, projects, anchors, contacts, tieRows, orgContacts, orgClaims, organizations };
}
type EntitySources = Awaited<ReturnType<typeof entitySourcesOf>>;

const newest = (a: ContactRow, b: ContactRow): number =>
  b.updated_at.getTime() - a.updated_at.getTime() || byText(a.id, b.id);

// The contacts behind an entry: an organization's own contacts, or a person's group contacts and
// the newest `own` contacts get_entity's details read.
function contactsOf(row: { id: string; kind: SubjectKind }, of: string[], sources: EntitySources): ContactRow[] {
  if (row.kind === "organization") return sources.orgContacts.get(row.id) ?? [];
  if (row.kind !== "person") return [];
  const group =
    of.length < 2
      ? []
      : sources.contacts.filter(
          (one) =>
            one.people.length >= 2 && one.people.length <= 19 && one.people.every((person) => of.includes(person)),
        );
  const details = sources.contacts
    .filter(
      (one) =>
        one.compartments.length === 1 &&
        one.compartments.includes("own") &&
        one.people.some((person) => of.includes(person)),
    )
    .sort(newest)
    .slice(0, DETAIL_CONTACTS);
  return [...new Map([...group, ...details].map((one) => [one.id, one])).values()].sort((a, b) => byText(a.id, b.id));
}

const labelOf = (rows: Labelled[] | undefined) =>
  (rows ?? []).map((row) => [row.id, labelled(row.compartments), row.value_fp]);
const labelsOf = (rows: { compartments: string[] }[] | undefined) => (rows ?? []).flatMap((row) => row.compartments);

// One entity's entry as scanned: its token over everything its build reads, and what serve_mirror
// checks it against. `shared`: a person's group's shared mark.
function entityRow(
  row: { id: EntityId; kind: SubjectKind },
  of: string[],
  sources: EntitySources,
  shared: boolean,
): EntityRow {
  const { accounts, aliases, domains, organizations } = sources;
  const project = sources.projects.get(row.id);
  const anchorIds = (sources.anchors.get(row.id) ?? []).map((one) => one.id);
  const theirs = contactsOf(row, of, sources);
  const claims = sources.orgClaims.get(row.id) ?? [];
  const ties = [
    ...new Map(of.flatMap((member) => sources.tieRows.get(member) ?? []).map((one) => [one.id, one])).values(),
  ].sort((a, b) => byText(a.id, b.id));
  return {
    key: row.id,
    kind: row.kind,
    token: sha([
      "entities",
      row.kind,
      of,
      of.map((member) => [labelOf(accounts.get(member)), labelOf(aliases.get(member)), labelOf(domains.get(member))]),
      // With its evidence, so a revision that keeps the contact's time (a re-import with the same
      // `asOf`) still changes the links and the owner's words served.
      theirs.map((one) => [one.id, one.evidence_id, one.updated_at.toISOString(), labelled(one.compartments)]),
      claims.map((one) => one.id),
      // Each confirmed tie and link, with its evidence and label, so a confirm, a lift, a veto or an
      // erasure rebuilds the entry. Its evidence is in the token and not in `evidence`: serve_mirror
      // checks an entry's evidence against the aliases, contacts and organization claims it finds
      // itself.
      ties.map((one) => [one.id, one.evidence_id, labelled(one.compartments)]),
      // A person's organization and its shared mark, as get_entity reads them.
      sorted(of.flatMap((member) => (organizations.get(member) ?? []).map((one) => one.organization))),
      shared,
      project === undefined ? null : [project.status, labelled(project.compartments), project.name_fp],
      anchorIds,
    ]),
    members: of,
    // The evidence serve_mirror finds for it: every member's visible aliases, the group's contacts,
    // and an organization's claims. A project rests on no evidence row.
    evidence:
      row.kind === "project"
        ? []
        : sorted([
            ...of.flatMap((member) => (aliases.get(member) ?? []).map((one) => one.evidence_id)),
            ...theirs.map((one) => one.evidence_id),
            ...claims.map((one) => one.evidence_id),
          ]),
    contactEvidence: sorted(theirs.map((one) => one.evidence_id)),
    claimEvidence: sorted(claims.map((one) => one.evidence_id)),
    // Its label as serve_mirror finds it: a project's own, or what its members are seen by.
    compartments:
      row.kind === "project"
        ? sorted(project?.compartments ?? [])
        : sorted([
            ...of.flatMap((member) => [
              ...labelsOf(accounts.get(member)),
              ...labelsOf(domains.get(member)),
              ...labelsOf(aliases.get(member)),
            ]),
            ...labelsOf(theirs),
            ...labelsOf(claims),
          ]),
    anchorIds,
  };
}

const entities: Section<EntityRow> = {
  name: "entities",
  open: (client) => Object.values(MIRROR_SECTION_VIEW.entities).some((view) => client.views.includes(view)),
  async scan(at, after) {
    const { ctx, groups, template } = at;
    const found = await ctx.run<{ id: EntityId; kind: SubjectKind }>(ENTITIES, [entityKinds(at), after, SCAN_ROWS + 1]);
    const scan = scanned(found.map((row) => ({ ...row, key: row.id, token: "" })));
    // A person stands for its group, by its lowest visible member.
    const kept = scan.rows.filter((row) => row.kind !== "person" || groups.idOf(row.id) === row.id);
    const members = new Map(kept.map((row) => [row.id, row.kind === "person" ? groups.membersOf(row.id) : [row.id]]));
    const sources = await entitySourcesOf(ctx, kept, members, template.members.anchorKinds);
    const rows = kept.map((row) =>
      entityRow(row, members.get(row.id) ?? [row.id], sources, row.kind === "person" && groups.shared(row.id)),
    );
    // The last row scanned, a group member left out included.
    return { rows, complete: scan.complete, last: scan.last };
  },
  async build(at, rows) {
    const { ctx, client, template, now } = at;
    const out = new Map<string, Built>();
    for (const row of rows) {
      const found = await entityOf(ctx, { id: row.key }, now, { brief: false, views: client.views });
      if (found === null || found.value.id !== row.key) continue;
      // A person's lead counts their open commitments, which a version that lists no
      // commitment must not show.
      const value = packEntity(found.value);
      const listsCommitments = template.members.beliefKinds.includes("commitment");
      const entity = mirrorValue(
        value.lead === undefined || listsCommitments
          ? value
          : { ...value, lead: { ...value.lead, openCommitments: null } },
      ) as Record<string, unknown>;
      let anchors: DeviceAnchorView[] | undefined;
      if (row.kind === "project") {
        const listed = (
          await ctx.run<{
            id: DeviceAnchorView["id"];
            kind: DeviceAnchorView["kind"];
            compartments: string[];
            value_enc: Sealed;
          }>(ANCHOR_VALUES, [row.key])
        )
          .filter((one) => template.members.anchorKinds.includes(one.kind))
          .slice(0, ANCHORS);
        anchors = listed.map((one) => {
          let value: string;
          try {
            value = open(ctx.keys, one, "knowledge.project_anchors.value_enc", "throw");
          } catch {
            throw new Unavailable();
          }
          return { id: one.id, kind: one.kind, value: { untrusted: value } };
        });
      }
      out.set(row.key, {
        section: "entities",
        value: anchors === undefined ? entity : { ...entity, anchors },
        fact: null,
        evidence: row.evidence,
        entities: sorted(row.members),
        anchors: (anchors ?? []).map((one) => one.id),
        compartments: row.compartments,
        ...(row.members.length > 1 ? { members: sorted(row.members) } : {}),
        ...(row.contactEvidence.length > 0 ? { contactEvidence: row.contactEvidence } : {}),
        ...(row.claimEvidence.length > 0 ? { claimEvidence: row.claimEvidence } : {}),
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// beliefs: every belief the client's clearance builds, computed when asked, as get_beliefs compiles
// one, by id. Its member and its subject's view are asked when it is built. A scan compares the
// clear-column tokens of mirror-belief-tokens.ts; only the rows whose token moved are computed. What
// changes with the clock alone (a belief going stale) is the daily rebuild pass's to serve.
// ---------------------------------------------------------------------------------------------

// Every fact key of a belief type the client sees, first known by `$2`.
const BELIEF_FACTS = `select distinct c.fact_key_fp from knowledge.claims c
  where c.type = any ($1::text[]) and c.first_known_at <= $2::timestamptz order by 1`;
// Unfiltered by the release: these ids are the entry's lineage, so an erasure reaches it, and no word
// of them is served. A belief's value comes from the compiled read, which takes releases in force.
const SUPPORT_CLAIMS = "select c.id, c.evidence_id from knowledge.claims c where c.id = any($1) order by c.id";
const CLAIM_ENTITIES =
  "select n.claim_id, n.entity_id from knowledge.claim_entities n where n.claim_id = any($1) order by n.claim_id, n.entity_id";

type BeliefScanRow = ScanRow & { fact: string };

const beliefs: Section<BeliefScanRow> = {
  name: "beliefs",
  open: (client) => Object.values(MIRROR_SECTION_VIEW.beliefs).some((view) => client.views.includes(view)),
  async scan({ ctx }, after) {
    const asOf = (await asOfOf(ctx)).toISOString();
    const facts = (await ctx.run<{ fact_key_fp: string }>(BELIEF_FACTS, [[...BELIEF_TYPES], asOf])).map(
      (row) => row.fact_key_fp,
    );
    const tokens = await beliefMarkTokens(ctx, facts);
    const audience = labelled(await clearanceOf(ctx));
    const found = facts
      .map(
        (fact): BeliefScanRow => ({ key: beliefIdOf(ctx.keys, fact, audience), token: tokens.get(fact) ?? "", fact }),
      )
      .filter((one) => after === null || byText(one.key, after) > 0)
      .sort((a, b) => byText(a.key, b.key))
      .slice(0, SCAN_ROWS + 1);
    return scanned(found);
  },
  async build({ ctx, client, template }, rows) {
    // The beliefs of the rows' fact keys, computed now; a key whose belief is built under another
    // key of its joined set, or that builds none, is no entry of its own.
    const wanted = new Set(rows.map((one) => one.key));
    const facts = rows.map((one) => one.fact);
    const computed = (await beliefsAt(ctx, facts, await asOfOf(ctx))).filter((one) => wanted.has(one.row.id));
    const list = computed.map((one) => one.row);
    const compiled = await mirrorBeliefs(
      ctx,
      computed,
      (belief, subjectKind) =>
        template.members.beliefKinds.some((kind) => kind === belief.kind) &&
        client.views.includes(MIRROR_SECTION_VIEW.beliefs[subjectKind]),
    );
    const kept = list.filter((row) => compiled.has(row.id));
    const support = sorted(kept.flatMap((row) => row.support));
    const claims = await ctx.run<{ id: string; evidence_id: string }>(SUPPORT_CLAIMS, [support]);
    const named = grouped(
      await ctx.run<{ claim_id: string; entity_id: string }>(CLAIM_ENTITIES, [claims.map((one) => one.id)]),
      (one) => one.claim_id,
    );
    const evidenceOf = new Map(claims.map((one) => [one.id, one.evidence_id]));
    const out = new Map<string, Built>();
    for (const row of kept) {
      const visible = row.support.filter((id) => evidenceOf.has(id));
      out.set(row.id, {
        section: "beliefs",
        value: mirrorValue(compiled.get(row.id)),
        fact: row.fact_key_fp,
        evidence: sorted(visible.map((id) => evidenceOf.get(id) ?? "")),
        entities: sorted(visible.flatMap((id) => (named.get(id) ?? []).map((one) => one.entity_id))),
        anchors: [],
        compartments: labelled(row.compartments),
        source: row.state_fp,
        support: sorted(row.support),
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// facts: every claim the client sees, of every listed type, as find_facts serves one, under the
// rule FIND_FACTS holds (read-facts.ts): never a held message's or document's, a finding's only
// when the token returns its agent record, and never one naming an entity the token does not show.
// Keyed by the claim's evidence id and fact key, never its claim id; of two claims on
// one key, the lowest id's is the entry. And a capture item's claim,
// as find_facts serves it, when the token returns its knowledge.captures row, which the reader's
// policy holds to the label key as every row; never an unconfirmed title link (capture.project),
// which reaches the Mac only as a cite of its confirmed belief.
// ---------------------------------------------------------------------------------------------

const FACTS = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, m.id as message_id, d.id as document_id,
    g.id as page_id, g.page_enc, g.fetched_at, g.compartments as page_compartments, c.evidence_id, k.id as capture_id,
    (case when m.id is null and d.id is null and g.id is null and k.id is null
      then (select w.id from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is null order by w.id limit 1) end) as record_id,
    c.evidence_id || ':' || c.fact_key_fp as key
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.pages g on g.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id
  where (${SOURCE_NOT_HELD} or g.id is not null or k.id is not null
      or (m.id is null and d.id is null and g.id is null and k.id is null and (c.evidence_id in (select w.evidence_id from ledger.agent_writes w where w.evidence_id is not null and w.flagged_at is null)
        or ${OWN_CONTACT_CLAIM})))
    and c.type = any($1::text[])
    and c.type <> '${TITLE_LINK_TYPE}'
    and ${RELEASE_IN_FORCE}
    and ($2::text is null or (c.evidence_id || ':' || c.fact_key_fp) > ($2::text collate "C"))
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id
        and (select e.id from knowledge.entities e where e.id = n.entity_id and e.kind in ('person', 'organization', 'project')) is null)
  order by (c.evidence_id || ':' || c.fact_key_fp) collate "C", c.id collate "C"
  limit $3`;
// What a fact's value reads beside its claims: the belief on each fact key the client's clearance
// builds, computed when asked, whose support and state give the fact's status (an agent_claim card's
// answer reaches the value only through it: pi_reader reads no card), and the projects the claims
// name.
const FACT_PROJECTS = `
  select n.claim_id, p.id, p.compartments, md5(p.name_enc::text) as name_fp
  from knowledge.claim_entities n join knowledge.projects p on p.id = n.entity_id
  where n.claim_id = any($1)
  order by n.claim_id, p.id`;
// Every claim of the keys the client sees, whatever FIND_FACTS' rule: the claims serve_mirror
// reads for a fact's label and the entities it names.
const KEY_CLAIMS = `
  select c.id, c.evidence_id || ':' || c.fact_key_fp as key from knowledge.claims c
  where (c.evidence_id || ':' || c.fact_key_fp) = any($1)
  order by c.id`;

type FactScanRow = ScanRow & { row: MirrorFactRow & { key: string }; claims: string[] };

const facts: Section<FactScanRow> = {
  name: "facts",
  open: (client) => client.views.includes(MIRROR_SECTION_VIEW.facts),
  async scan({ ctx, template }, after) {
    const found = await ctx.run<MirrorFactRow & { key: string }>(FACTS, [
      [...template.members.factTypes],
      after,
      SCAN_ROWS + 1,
    ]);
    const complete = found.length <= SCAN_ROWS;
    const rows = found.slice(0, SCAN_ROWS);
    const byKey = grouped(rows, (row) => row.key);
    // The status a fact serves is its key's belief's: the key's belief token, from clear columns.
    const beliefTokensOf = await beliefMarkTokens(ctx, sorted(rows.map((row) => row.fact_key_fp)));
    const projectsOf = grouped(
      await ctx.run<{ claim_id: string; id: string; compartments: string[]; name_fp: string }>(FACT_PROJECTS, [
        rows.map((row) => row.id),
      ]),
      (row) => row.claim_id,
    );
    // A key whose claims the scan cut is left to the next call, unless it is the only one.
    const keys = [...byKey.keys()];
    if (!complete && keys.length > 1) keys.pop();
    return {
      rows: keys.map((key): FactScanRow => {
        const claims = byKey.get(key) ?? [];
        const first = claims[0] as MirrorFactRow & { key: string };
        const ids = claims.map((one) => one.id);
        return {
          key,
          token: sha([
            "facts",
            claims.map((one) => [
              one.id,
              labelled(one.compartments),
              one.record_id ?? null,
              (projectsOf.get(one.id) ?? []).map((project) => [
                project.id,
                labelled(project.compartments),
                project.name_fp,
              ]),
              // A capture item's claim names its row; no other claim's token changes.
              ...((one.capture_id ?? null) === null ? [] : [one.capture_id]),
            ]),
            beliefTokensOf.get(first.fact_key_fp) ?? null,
          ]),
          row: first,
          claims: ids,
        };
      }),
      complete,
      // A key whose claims the scan cut is read again by the next call: the scan covered up to
      // the last key it keeps.
      last: keys.at(-1) ?? null,
    };
  },
  async build({ ctx, template }, list) {
    const views = await mirrorFactViews(
      ctx,
      list.map((one) => one.row),
      template.members.beliefKinds,
    );
    const all = await ctx.run<{ id: string; key: string }>(KEY_CLAIMS, [list.map((one) => one.key)]);
    const named = grouped(
      await ctx.run<{ claim_id: string; entity_id: string }>(CLAIM_ENTITIES, [all.map((one) => one.id)]),
      (one) => one.claim_id,
    );
    const claimsOf = grouped(all, (one) => one.key);
    const out = new Map<string, Built>();
    list.forEach((one, index) => {
      out.set(one.key, {
        section: "facts",
        value: mirrorValue(views[index]),
        fact: one.row.fact_key_fp,
        evidence: [one.row.evidence_id],
        entities: sorted(
          (claimsOf.get(one.key) ?? []).flatMap((claim) => (named.get(claim.id) ?? []).map((row) => row.entity_id)),
        ),
        anchors: [],
        compartments: labelled(one.row.compartments),
        source: one.row.id,
      });
    });
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// events: every event from 180 days before the call to 180 days after, as MeetingView, its
// participants grouped as every tool groups them.
// ---------------------------------------------------------------------------------------------

const EVENTS = `
  select ${MEETING_COLUMNS}, v.compartments as event_compartments
  from knowledge.events v
  join knowledge.event_details d on d.event_id = v.id
  where coalesce(d.starts_at, v.occurred_at) between $1 and $2
    and ($3::text is null or v.id > ($3::text collate "C"))
  order by v.id collate "C"
  limit $4`;
const PARTICIPANTS =
  "select p.event_id, p.entity_id from knowledge.event_participants p where p.event_id = any($1) order by p.event_id, p.entity_id";

type EventScanRow = ScanRow & { row: MeetingRow; participants: string[] };

const events: Section<EventScanRow> = {
  name: "events",
  open: (client) => client.views.includes(MIRROR_SECTION_VIEW.events),
  async scan({ ctx, now, groups }, after) {
    const from = new Date(now.getTime() - EVENT_DAYS * DAY_MS).toISOString();
    const to = new Date(now.getTime() + EVENT_DAYS * DAY_MS).toISOString();
    const found = scanned(
      (await ctx.run<MeetingRow & { event_compartments: string[] }>(EVENTS, [from, to, after, SCAN_ROWS + 1])).map(
        (row) => ({ key: row.id, token: "", row }),
      ),
    );
    const people = grouped(
      await ctx.run<{ event_id: string; entity_id: string }>(PARTICIPANTS, [found.rows.map((one) => one.key)]),
      (one) => one.event_id,
    );
    return {
      rows: found.rows.map((one): EventScanRow => {
        const participants = sorted((people.get(one.key) ?? []).map((row) => row.entity_id));
        const { row } = one;
        return {
          key: one.key,
          row,
          participants,
          token: sha([
            "events",
            row.evidence_id,
            [...row.event_compartments].sort(byText),
            labelled(row.compartments),
            participants,
            participants.map((id) => groups.idOf(id)),
          ]),
        };
      }),
      complete: found.complete,
      last: found.last,
    };
  },
  async build({ ctx, groups }, list) {
    const meetings = await meetingsOf(
      ctx,
      list.map((one) => one.row),
      groups,
      { instants: true },
    );
    const out = new Map<string, Built>();
    for (const one of list) {
      const meeting = meetings.get(one.key);
      if (meeting === undefined) continue;
      out.set(one.key, {
        section: "events",
        value: mirrorValue(meeting),
        fact: null,
        evidence: [one.row.evidence_id],
        entities: one.participants,
        anchors: [],
        compartments: labelled(one.row.compartments),
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// captures: the stored meetings, and the moments started within 90 days, as MirrorCapture, in cap_
// id order. Its token is the row's id, evidence id, compartments and event; an event
// the token does not show is served as none.
// ---------------------------------------------------------------------------------------------

const CAPTURES = `
  select x.id, x.evidence_id, x.compartments, x.capture_key, x.revision, x.kind, x.started_at, x.ended_at,
    (select v.id from knowledge.events v where v.id = x.event_id) as event_id
  from knowledge.captures x
  where x.kind = any($1::text[]) and (x.kind = 'meeting' or x.started_at >= $2)
    and ($3::text is null or x.id > ($3::text collate "C"))
  order by x.id collate "C"
  limit $4`;

type CaptureRow = {
  id: CaptureId;
  evidence_id: string;
  compartments: string[];
  capture_key: CaptureKey;
  revision: number;
  kind: "meeting" | "moment";
  started_at: Date;
  ended_at: Date | null;
  event_id: EventId | null;
};
type CaptureScanRow = ScanRow & { row: CaptureRow };

const captures: Section<CaptureScanRow> = {
  name: "captures",
  open: (client) => client.views.includes(MIRROR_SECTION_VIEW.captures),
  async scan({ ctx, now, template }, after) {
    const since = new Date(now.getTime() - MOMENT_DAYS * DAY_MS).toISOString();
    const found = await ctx.run<CaptureRow>(CAPTURES, [
      [...template.members.captureKinds],
      since,
      after,
      SCAN_ROWS + 1,
    ]);
    return scanned(
      found.map(
        (row): CaptureScanRow => ({
          key: row.id,
          token: sha(["captures", row.id, row.evidence_id, labelled(row.compartments), row.event_id, row.revision]),
          row,
        }),
      ),
    );
  },
  build(_at, rows) {
    const out = new Map<string, Built>();
    for (const { key, row } of rows) {
      out.set(key, {
        section: "captures",
        value: {
          capture: row.id,
          key: row.capture_key,
          revision: row.revision,
          kind: row.kind,
          startedAt: stamp(row.started_at),
          endedAt: stampOrNull(row.ended_at),
          event: row.event_id,
        },
        fact: null,
        evidence: [row.evidence_id],
        entities: [],
        anchors: [],
        compartments: labelled(row.compartments),
      });
    }
    return Promise.resolve(out);
  },
};

export const SECTIONS: Readonly<Record<MirrorSection, Section>> = Object.freeze({
  entities,
  beliefs,
  facts,
  events,
  captures,
});

// The client's groups, read once a call (nothing is opened).

// An entry of a section, its value in the section's field.
export function entryOf(built: Built, stamp: MirrorEntry["stamp"]): unknown {
  switch (built.section) {
    case "entities":
      return { section: "entities", stamp, entity: built.value };
    case "beliefs":
      return { section: "beliefs", stamp, belief: built.value };
    case "facts":
      return { section: "facts", stamp, fact: built.value };
    case "events":
      return { section: "events", stamp, event: built.value };
    case "captures":
      return { section: "captures", stamp, capture: built.value };
  }
}
