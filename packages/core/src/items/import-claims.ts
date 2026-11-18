import { type AffiliationRelation, ClaimRecord, type ImportedExtras } from "@intelligence/contracts/personal";
import { sha256 } from "../hash.ts";
import {
  CONTACT_CLAIMS_V1,
  CONTACT_CLAIMS_V4,
  type ContactClaimsVersion,
  contactQuality,
  factKeyOf,
  kept,
  keyVersionOf,
  organizationMade,
  relationOfTitle,
  underQualityRules,
} from "./contact-claims.ts";
import { linkClaims } from "./person-links.ts";
import type { ContactFacts } from "./types.ts";

// Contact import: the claims code makes from an imported contact, by code and with no model, about
// each person its addresses resolved to, as contactClaims makes a saved contact's: its current role
// (an `employee` affiliation and, with a title, a `role`), each past role the same with its end as
// `validTo`, each board as a `board` affiliation, each school as an `alumnus` affiliation, and each
// organization row the file says it works at as an `employee` affiliation, and each of its links as
// a `link`. Each is a third party's statement in a source the owner holds: origin `source`, basis
// `third_party`, disclosure `third_party` (use-only), under the contact's evidence label, with the
// row's confidence and standing. Industries, a location, tags, notes and the relations between
// people make no claim: the ontology has no kind for the first two, tags are the owner's words, and
// a third party's relationship counts in no belief. Pure.

export type ImportClaimsInput = {
  evidenceId: string;
  compartments: readonly string[];
  readers: readonly string[];
  // The contact's revision time: the row's `asOf`, else when it was imported.
  observedAt: string;
  // The current role, as the contact's one organization.
  organizations: ContactFacts["organizations"];
  imported: ImportedExtras;
  // The row's links, each a `link` claim (person-links.ts).
  links?: ContactFacts["links"];
  people: readonly { entity: string }[];
  // Every identifier the contact lists, which the rules of contact-import@5 read.
  addresses: readonly string[];
};

// What an imported contact's claims are made by, at each fact key version, as the contact claims':
// the key version 2 one is made from the time the first claim with a version 2 key was stored, which makes CONTACT_CLAIMS_V2 the writer's. `@3` and
// `@4` make link claims too; `@2` is registered and never made. `@5` is made at contact-claims@3
// under the contact quality rules, and `@6` at contact-claims@4, the relation read from the title.
export const IMPORT_CLAIMS_VERSION = "contact-import@3";
export const IMPORT_CLAIMS_V2 = "contact-import@4";
export const IMPORT_CLAIMS_V3 = "contact-import@5";
const IMPORT_CLAIMS_V4 = "contact-import@6";
const IMPORT_VERSIONS: Record<ContactClaimsVersion, string> = {
  "contact-claims@1": IMPORT_CLAIMS_VERSION,
  "contact-claims@2": IMPORT_CLAIMS_V2,
  "contact-claims@3": IMPORT_CLAIMS_V3,
  "contact-claims@4": IMPORT_CLAIMS_V4,
};

type Made = {
  span: string;
  type: "role" | "affiliation";
  fields: Record<string, string>;
  validFrom: string;
  validTo?: string;
};

// Each claim's content once per item, whatever rows or fields stated it. By the contact quality
// rules when `quality` is given.
function madeOf(input: ImportClaimsInput, quality: ReturnType<typeof contactQuality>, titled: boolean): Made[] {
  const made: Made[] = [];
  const seen = new Set<string>();
  const add = (one: Made): void => {
    const key = JSON.stringify([one.type, one.fields, one.validTo ?? null]);
    if (seen.has(key)) return;
    seen.add(key);
    made.push(one);
  };
  const organization = (
    span: string,
    given: AffiliationRelation | "job",
    name: string | null | undefined,
    title: string | null | undefined,
    times: { validFrom: string; validTo?: string },
  ): void => {
    const { name: org, title: role } = organizationMade(kept(name), kept(title), quality);
    // From contact-claims@4, a job's relation by the title the rules kept.
    const relation = given !== "job" ? given : titled ? relationOfTitle(role) : "employee";
    if (org !== null) add({ span, type: "affiliation", fields: { relation, organization_name: org }, ...times });
    // Only a job's row names a title: a board, a school and a `works_at` relation give none.
    if (role !== null)
      add({
        span,
        type: "role",
        fields: { title: role, ...(org === null ? {} : { organization_name: org }) },
        ...times,
      });
  };
  const now = { validFrom: input.observedAt };
  input.organizations.forEach((one, i) => {
    organization(`organizations/${i}`, "job", one.name, one.title, now);
  });
  const { pastRoles, boards, education, relations } = input.imported;
  pastRoles.forEach((past, i) => {
    // A past role ended by its end date, or, with none, by the row's time.
    const validTo = past.to === undefined ? input.observedAt : `${past.to}T23:59:59.999Z`;
    const from = past.from === undefined ? validTo : `${past.from}T00:00:00.000Z`;
    organization(`imported/pastRoles/${i}`, "job", past.organization, past.title, {
      validFrom: from <= validTo ? from : validTo,
      validTo,
    });
  });
  boards.forEach((board, i) => {
    organization(`imported/boards/${i}`, "board", board.organization, null, now);
  });
  education.forEach((school, i) => {
    organization(`imported/education/${i}`, "alumnus", school, null, now);
  });
  relations.forEach((relation, i) => {
    if (relation.kind === "works_at") organization(`imported/relations/${i}`, "employee", relation.name, null, now);
  });
  return made;
}

// At the contact claims version `contactVersion`: contact-claims@1 makes contact-import@3,
// @2 makes @4, @3 makes @5, and @4 makes @6.
export function importClaims(
  input: ImportClaimsInput,
  contactVersion: ContactClaimsVersion = CONTACT_CLAIMS_V1,
): ClaimRecord[] {
  const keyVersion = keyVersionOf(contactVersion);
  const version = IMPORT_VERSIONS[contactVersion];
  const quality = contactQuality(input.addresses, underQualityRules(contactVersion));
  // A function's mailbox makes no claim about a person.
  if (quality?.mailbox === true) return [];
  const { confidence, standing } = input.imported.provenance;
  const subjects = [...new Set(input.people.map((one) => one.entity))];
  const made = madeOf(input, quality, contactVersion === CONTACT_CLAIMS_V4);
  const links = linkClaims(
    {
      ...input,
      links: input.links ?? [],
      ...(confidence === undefined ? {} : { confidence }),
      ...(standing === undefined ? {} : { standing }),
    },
    version,
  );
  const organizational = subjects.flatMap((subject) =>
    made.map(({ span, type, fields, validFrom, validTo }) =>
      ClaimRecord.parse({
        claim: {
          id: sha256(`${version}\n${input.evidenceId}\n${subject}\n${span}\n${type}`),
          content: { type, subject, fields },
          statementKind: "stated_fact",
          basis: "third_party",
          validFrom,
          ...(validTo === undefined ? {} : { validTo }),
          evidence: [{ evidenceId: input.evidenceId, span }],
          primaryEvidenceId: input.evidenceId,
          label: { compartments: [...input.compartments], readers: [...input.readers] },
          destination: "personal",
          pipelineVersion: version,
          extractorGeneration: 0,
          changeKind: "live",
          systemOriginated: false,
          origin: "source",
          identityEpoch: 0,
        },
        subjectKind: "person",
        disclosure: ["third_party"],
        factKey: factKeyOf(type, subject, fields, input.compartments, keyVersion),
        ...(keyVersion === 2 ? { legacyFactKey: factKeyOf(type, subject, fields, input.compartments, 1) } : {}),
        lane: "correspondence",
        fieldKinds: Object.fromEntries(
          Object.keys(fields).map((field) => [field, field === "relation" ? "enum" : "text"]),
        ),
        entities: [subject],
        origin: "source",
        answersSystem: false,
        ...(confidence === undefined ? {} : { confidence }),
        ...(standing === undefined ? {} : { standing }),
      }),
    ),
  );
  return [...organizational, ...links];
}

// The claims a record makes about each person it names, by type, with no subject yet: for a
// dry run's counts, at the version in force, under its contact quality rules.
export function importClaimCounts(
  input: Pick<ImportClaimsInput, "organizations" | "imported" | "links" | "addresses">,
): { role: number; affiliation: number; link: number } {
  const quality = contactQuality(input.addresses, true);
  if (quality?.mailbox === true) return { role: 0, affiliation: 0, link: 0 };
  const made = madeOf(
    { ...input, evidenceId: "", compartments: [], readers: [], observedAt: "1970-01-01T00:00:00.000Z", people: [] },
    quality,
    true,
  );
  return {
    role: made.filter((one) => one.type === "role").length,
    affiliation: made.filter((one) => one.type === "affiliation").length,
    link: input.links?.length ?? 0,
  };
}
