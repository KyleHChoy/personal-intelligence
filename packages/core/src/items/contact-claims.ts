import { type AffiliationRelation, ClaimRecord } from "@intelligence/contracts/personal";
import { sha256 } from "../hash.ts";
import { keyPhrase } from "../key-phrase.ts";
import { isFormat, normalChars } from "../text.ts";
import { mailboxContact, organizationReading, ownDomainsOf, titleKept } from "./contact-quality.ts";
import { extend, linkClaims } from "./person-links.ts";
import type { ContactFacts } from "./types.ts";

// Each is a third party's statement in a source the owner holds: origin `source`, basis `third_party`, disclosure `third_party`
// (use-only), labelled as the contact's evidence. Pure.

export type ContactClaimsInput = {
  evidenceId: string;
  // The evidence row's label, which every claim of it carries (the database holds it so).
  compartments: readonly string[];
  readers: readonly string[];
  // The contact's revision time.
  observedAt: string;
  organizations: ContactFacts["organizations"];
  // Its links, each a `link` claim (person-links.ts).
  links?: ContactFacts["links"];
  people: readonly { entity: string }[];
  // Every identifier the contact lists (its raw item's), which the rules of contact-claims@3 read:
  // its own domains and whether it is a function's mailbox.
  addresses: readonly string[];
};

// What a contact's claims are made by, in place of a model and a prompt. Version 2 keys a role by
// its title as well, as fact key version 2 does; version 1 stays for the claims stored before it,
// which `pi contacts reclaim` makes again.
export const CONTACT_CLAIMS_V1 = "contact-claims@1";
export const CONTACT_CLAIMS_V2 = "contact-claims@2";
// Version 2 under the contact quality rules (contact-quality.ts): no organization from a domain or
// a headline, and no claim from a function's mailbox. `pi contacts reclaim` makes every stored
// contact's claims again at it, removing those it no longer makes.
export const CONTACT_CLAIMS_V3 = "contact-claims@3";
// Version 3 with the affiliation's relation read from the title (relationOfTitle). Its key holds the
// relation, so `pi contacts reclaim` removes the `employee` affiliation version 3 made for a founder.
export const CONTACT_CLAIMS_V4 = "contact-claims@4";
export const CONTACT_CLAIMS_VERSION = CONTACT_CLAIMS_V4;
export type ContactClaimsVersion =
  | typeof CONTACT_CLAIMS_V1
  | typeof CONTACT_CLAIMS_V2
  | typeof CONTACT_CLAIMS_V3
  | typeof CONTACT_CLAIMS_V4;

// Whether a version reads a contact under the contact quality rules.
export const underQualityRules = (version: ContactClaimsVersion): boolean =>
  version === CONTACT_CLAIMS_V3 || version === CONTACT_CLAIMS_V4;

// What a title says of a person's tie to the organization, from a pinned list, general and about no
// one; a title it does not place is a job, as every title was before version 4. A pattern must match
// one whole part of the title (parts split at "&", ",", "/", "|" and "and", less a trailing "at X" or
// "of X"), so "Founding Engineer", "Founder's Associate", "Chief of Staff to the Founder", "Product
// Owner", "Investor Relations Manager" and "Financial Advisor" are jobs.
const TITLE_RELATIONS: readonly (readonly [RegExp, AffiliationRelation])[] = [
  [/^(?:(?:co[- ]?)?founder|founding partner)$/, "founder"],
  [/^(?:(?:co[- ]?)?owner|(?:business|company|firm|shop|store) owner)$/, "owner"],
  [/^(?:(?:angel|seed|venture) )?investor$/, "investor"],
  [/^(?:board (?:member|director)|(?:chair|chairman|chairwoman) of the board)$/, "board"],
  [/^(?:(?:board|strategic|startup) )?advis[eo]r$/, "advisor"],
  [/^(?:(?:independent )?contractor|freelancer)$/, "contractor"],
  [/^(?:\p{L}+ )?student$/u, "student"],
  [/^(?:\p{L}+ )?volunteer$/u, "volunteer"],
];
export function relationOfTitle(title: string | null): AffiliationRelation {
  if (title === null) return "employee";
  const parts = title
    .toLowerCase()
    .split(/\s*[&,/|]\s*|\s+and\s+/)
    .map((part) => part.trim());
  for (const [pattern, relation] of TITLE_RELATIONS)
    for (const part of parts)
      if (pattern.test(part) || pattern.test(part.replace(/ (?:at|of) .+$/, ""))) return relation;
  return "employee";
}

// The fact key version a contact claims version keys at.
export const keyVersionOf = (version: ContactClaimsVersion): 1 | 2 => (version === CONTACT_CLAIMS_V1 ? 1 : 2);

// What one organization row makes, by the rules when `quality` holds (from contact-claims@3 and
// contact-import@5), from its kept name and title. Its name as written, or with one trailing
// parenthetical set aside; a name the rules refuse makes no affiliation and leaves a role its title
// alone; a name that is the contact's own domain makes neither; a title the rules refuse makes no
// role.
export function organizationMade(
  name: string | null,
  title: string | null,
  quality: { ownDomains: readonly string[] } | null,
): { name: string | null; title: string | null } {
  if (quality === null) return { name, title };
  const reading = name === null ? null : organizationReading(name, quality.ownDomains);
  if (reading?.kind === "own_domain") return { name: null, title: null };
  return {
    name: reading?.kind === "name" ? reading.name : null,
    title: title !== null && titleKept(title) ? title : null,
  };
}

// The rules' reading of a contact, or null at a version before them; `mailbox` when it makes no
// claim about a person.
export function contactQuality(
  addresses: readonly string[],
  on: boolean,
): { ownDomains: string[]; mailbox: boolean } | null {
  return on ? { ownDomains: ownDomainsOf(addresses), mailbox: mailboxContact(addresses) } : null;
}

// A value is kept up to this many code points; a longer organization or title is not a claim.
const MAX_VALUE = 200;

// The extract package's normal form of a phrase (grounding.ts `normal`): format characters
// dropped, NFKC, curly quotes straight, every dash `-`, each run of white space one space, lower
// case. A test in packages/extract holds the keys below equal to `personalFactKey`.
const normalPhrase = (text: string): string =>
  normalChars([...text].filter((point) => !isFormat(point)).flatMap((point) => [...point.normalize("NFKC")])).trim();

// `personalFactKey` for a global role or affiliation that names its organization by name only: the
// shared key over type, subject and the typed fields the ontology declares (a role has none, an
// affiliation its relation), then `name:` and the organization's normal form, at key version 2 a
// role's `title:` and its title's key phrase, then `compartment:` and the sorted compartments.
export function factKeyOf(
  type: "role" | "affiliation",
  subject: string,
  fields: Record<string, string>,
  compartments: readonly string[],
  keyVersion: 1 | 2,
): string {
  const typed = type === "affiliation" ? `{"relation":${JSON.stringify(fields.relation)}}` : "{}";
  let key = sha256(
    `{"context":{"kind":"global"},"fields":${typed},"subject":${JSON.stringify(subject)},"type":${JSON.stringify(type)}}`,
  );
  const name = fields.organization_name;
  if (name !== undefined) key = extend(key, `name:${normalPhrase(name)}`);
  const title = fields.title;
  if (keyVersion === 2 && type === "role" && title !== undefined) key = extend(key, `title:${keyPhrase(title)}`);
  return extend(key, `compartment:${[...compartments].sort().join(",")}`);
}

export const kept = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || [...trimmed].length > MAX_VALUE ? null : trimmed;
};

export function contactClaims(
  input: ContactClaimsInput,
  version: ContactClaimsVersion = CONTACT_CLAIMS_VERSION,
): ClaimRecord[] {
  const keyVersion = keyVersionOf(version);
  const quality = contactQuality(input.addresses, underQualityRules(version));
  // A function's mailbox makes no claim about a person.
  if (quality?.mailbox === true) return [];
  const subjects = [...new Set(input.people.map((one) => one.entity))];
  const records: ClaimRecord[] = [];
  input.organizations.forEach((organization, index) => {
    const { name, title } = organizationMade(kept(organization.name), kept(organization.title), quality);
    const relation = version === CONTACT_CLAIMS_V4 ? relationOfTitle(title) : "employee";
    const made: { type: "role" | "affiliation"; fields: Record<string, string> }[] = [
      ...(name === null ? [] : [{ type: "affiliation" as const, fields: { relation, organization_name: name } }]),
      ...(title === null
        ? []
        : [{ type: "role" as const, fields: { title, ...(name === null ? {} : { organization_name: name }) } }]),
    ];
    for (const subject of subjects) {
      for (const { type, fields } of made) {
        const claim = {
          id: sha256(`${version}\n${input.evidenceId}\n${subject}\n${index}\n${type}`),
          content: { type, subject, fields },
          statementKind: "stated_fact",
          basis: "third_party",
          validFrom: input.observedAt,
          evidence: [{ evidenceId: input.evidenceId, span: `organizations/${index}` }],
          primaryEvidenceId: input.evidenceId,
          label: { compartments: [...input.compartments], readers: [...input.readers] },
          destination: "personal",
          pipelineVersion: version,
          extractorGeneration: 0,
          changeKind: "live",
          systemOriginated: false,
          origin: "source",
          identityEpoch: 0,
        };
        records.push(
          ClaimRecord.parse({
            claim,
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
          }),
        );
      }
    }
  });
  // A contact's links, under the same version: no contact stored before links were read has any,
  // so the claims of every stored contact at this version are as they were.
  return [...records, ...linkClaims({ ...input, links: input.links ?? [] }, version)];
}
