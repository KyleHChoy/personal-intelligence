import type { Envelope } from "@intelligence/contracts";
import { ContactCandidate } from "@intelligence/contracts/personal";
import { personLink } from "@intelligence/personal-core/items";
import type { Keys } from "../core/keys.ts";
import { open } from "../core/seal.ts";

// A phone is its canonical form when Google gave one, else its value. A row that does not open or
// parse throws: the caller counts it, and the check fails, never passes.

export const CONTACT_CANDIDATES = "select contact_id, compartments, facts_enc from ledger.contact_candidates($1::text)";

export type ContactCandidateRow = { contact_id: string; compartments: string[]; facts_enc: Envelope };

export type ContactFacts = Sealed;
type Sealed = {
  names?: unknown;
  phones?: { value?: unknown; canonical?: unknown }[];
  organizations?: { name?: unknown; title?: unknown }[];
  birthday?: unknown;
  links?: { url?: unknown }[];
  imported?: { profiles?: unknown[] };
};

// A contact's links, and an import's profile URLs, which an older sealed contact holds without
// links, each in its normal form, each once.
export function contactLinks(facts: ContactFacts): string[] {
  const profiles = (facts.imported?.profiles ?? []).map((one) =>
    typeof one === "string" ? personLink(one)?.url : undefined,
  );
  return [
    ...new Set(
      [...(facts.links ?? []).map((one) => one.url), ...profiles].filter(
        (url): url is string => typeof url === "string",
      ),
    ),
  ];
}

export function openContactCandidate(keys: Keys, row: ContactCandidateRow): ContactCandidate {
  const facts = JSON.parse(
    open(
      keys,
      { id: row.contact_id, compartments: row.compartments, facts_enc: row.facts_enc },
      "knowledge.contacts.facts_enc",
      "throw",
    ),
  ) as Sealed;
  const links = contactLinks(facts);
  return ContactCandidate.parse({
    id: row.contact_id,
    names: facts.names,
    phones: (facts.phones ?? []).map((phone) => (typeof phone.canonical === "string" ? phone.canonical : phone.value)),
    organizations: (facts.organizations ?? []).map((one) => ({ name: one.name ?? null, title: one.title ?? null })),
    birthday: facts.birthday ?? null,
    ...(links.length === 0 ? {} : { links }),
  });
}

// A held contact field as `released` names it and as the reveal code orders it.
export const contactRef = (field: { id: string; field: string; index: number | null }): string =>
  `${field.id}:${field.field}:${field.index ?? ""}`;
