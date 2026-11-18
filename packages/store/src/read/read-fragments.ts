import { OWN_CONTACT_CLAIM, OWNER_ENTITY_ALIASED } from "../core/statements.ts";
import { NAMES_SHOWN, RELEASE_IN_FORCE, sourceShown } from "../core/visibility.ts";
// SQL fragments the reads share: the relation and named-organization claims, built from
// core/visibility.ts's rules.

// The relation claim types.
export const RELATION_TYPES: readonly string[] = Object.freeze(["relationship", "intro_offer"]);

// The relation claims the caller can see: those find_facts would return (read-fact-rows.ts, FIND_FACTS)
// of a message or a document that is not held, a capture (a meeting's or a chat's), or a finding's
// record the token returns, with a release in force, naming no person or organization the token
// does not show. `c`, `m`, `d` and `k` as in RELATIONS_NAMING below.
export const RELATION_SEEN = `c.type = any($2::text[])
    and ${RELEASE_IN_FORCE}
    and ${sourceShown(["message", "document", "capture"], ["released", "record"])}
    and ${NAMES_SHOWN}`;

// The claims that make a named organization seen: RELATION_SEEN's, or a
// claim of one of the owner's own contacts, as FIND_FACTS serves it. A contact under any other
// compartment makes nothing seen.
export const ORGANIZATION_CLAIM_SEEN = `(${RELATION_SEEN}
    or (c.type = any($2::text[]) and ${OWN_CONTACT_CLAIM}
      and ${RELEASE_IN_FORCE} and ${NAMES_SHOWN}))`;

// A name row a read may serve (`o`): not one a contact under another compartment than `own` gave,
// whose wording stays withheld though another item names the same organization.
export const ORG_NAME_SERVED =
  "o.evidence_id not in (select x.evidence_id from knowledge.contacts x where x.compartments <> array['own']::text[])";

// The claims naming an organization by name (`c`), through the name rows of the organization's
// names (`o`) and the claims' name rows (`x`), under one label, with what RELATION_SEEN reads of
// each claim's item (`m`, `d`, `k`). A statement that reads it filters by ORGANIZATION_CLAIM_SEEN,
// with the claim types as `$2`.
export const NAMED_ORG_CLAIMS = `
  knowledge.org_names o
  join knowledge.claim_org_names x on x.name_fp = o.name_fp and x.compartments @> o.compartments and x.compartments <@ o.compartments
  join knowledge.claims c on c.id = x.claim_id
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id`;

// The owner is found by the owner's index, and the accounts by the owner's id: no statement
// reads every entity.
export const OWNER_ADDRESSES = `
  select a.id, a.value_fp, a.compartments, a.value_enc
  from knowledge.accounts a
  where a.entity_id = (${OWNER_ENTITY_ALIASED})
  order by a.id`;

// A message the owner sent makes its recipients ones the owner wrote to only when it had at most this
// many, To, Cc and Bcc together, counted as its outbound interaction rows, one per recipient that is
// a person: a send to a large list is not a correspondence with each person on it. The owner may
// change the number.
export const WROTE_TO_MAX_RECIPIENTS = 10;
