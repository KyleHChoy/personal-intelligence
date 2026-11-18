import type { IdentityException } from "@intelligence/contracts/personal";
import { employersDiffer } from "@intelligence/personal-core/planner";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { wholePeople } from "./identity-questions.ts";
import { type Provable, provablePairs } from "./same-person-facts.ts";

// Both known and one full name merges by the owner's standing rule, but saved cards can say otherwise:
// different employers, or one phone, which is a father and son or two front desks under one name. A wrong join
// is the worst outcome, so those are held as a name that may be two people's, and code does not merge them.
// A move holds a pair too, which is why the dry run counts this hold on its own.

// The companies on a saved card, or none where it does not open.
function readCard(admin: { keys: Keys }, row: { id: string; compartments: string[]; facts_enc: Sealed }): string[] {
  try {
    const facts = JSON.parse(open(admin.keys, row, "knowledge.contacts.facts_enc", "throw")) as {
      organizations?: { name?: string | null }[];
    };
    return (facts.organizations ?? []).flatMap((one) => (one.name ? [one.name] : []));
  } catch {
    return [];
  }
}

type Card = { compartments: string[]; companies: string[]; phones: string[] };

type Candidate = {
  kind: "same_person";
  a: { entity: string };
  b: { entity: string };
  basis: string;
  labels: readonly string[];
  exception?: IdentityException;
  heldByCards?: true;
};

// Marks the pairs held back, of those nothing else holds. Only cards within a pair's own labels speak to it: what
// its viewers can't see changes nothing they see (invariant 6).
export async function holdBackByCards(
  admin: { keys: Keys },
  query: Query,
  list: readonly (Candidate | { kind: "shared_address" })[],
): Promise<void> {
  const pairs = list.flatMap((one) =>
    one.kind === "same_person" && one.exception === undefined && one.basis !== "contact" && one.basis !== "phone"
      ? [one]
      : [],
  );
  if (pairs.length === 0) return;
  const rows = await query<{
    entity_id: string;
    id: string;
    compartments: string[];
    facts_enc: Sealed;
    phone_fps: string[] | null;
  }>(
    `select a.entity_id, c.id, c.compartments, c.facts_enc, c.phone_fps from knowledge.contact_addresses a
     join knowledge.contacts c on c.id = a.contact_id where a.entity_id = any($1::text[])`,
    [[...new Set(pairs.flatMap((one) => [one.a.entity, one.b.entity]))]],
  );
  const cards = new Map<string, Card[]>();
  for (const row of rows)
    cards.set(row.entity_id, [
      ...(cards.get(row.entity_id) ?? []),
      { compartments: row.compartments, companies: readCard(admin, row), phones: row.phone_fps ?? [] },
    ]);
  for (const pair of pairs) {
    const said = (entity: string): Card[] =>
      (cards.get(entity) ?? []).filter((card) => card.compartments.every((part) => pair.labels.includes(part)));
    const [a, b] = [said(pair.a.entity), said(pair.b.entity)];
    const line = new Set(b.flatMap((card) => card.phones));
    const held =
      a.some((card) => card.phones.some((one) => line.has(one))) ||
      employersDiffer(
        a.flatMap((card) => card.companies),
        b.flatMap((card) => card.companies),
      );
    if (held) {
      pair.exception = "common_name";
      pair.heldByCards = true;
    }
  }
}

// The dry run's count of what records alone could settle, each person whole.
export const provableOf = (
  admin: { keys: Keys; transaction<T>(work: (query: Query) => Promise<T>): Promise<T> },
  pairs: readonly { a: string; b: string; label: readonly string[] }[],
): Promise<Provable> =>
  admin.transaction(async (query) => {
    const whole = await wholePeople(query);
    return provablePairs(admin, query, (entity) => [...whole(entity)], pairs);
  });

// Two saved contacts holding one phone under one name, one listing each person, and their labels.
export const phonePairs = (query: Query): Promise<{ a: string; b: string; labels: string[] }[]> =>
  query(
    `select x.entity_id as a, y.entity_id as b, array_agg(distinct one) as labels from knowledge.contact_addresses x
     join knowledge.contacts cx on cx.id = x.contact_id
     join knowledge.contacts cy on cy.id <> cx.id and cy.phone_fps && cx.phone_fps and cy.name_fps && cx.name_fps
     join knowledge.contact_addresses y on y.contact_id = cy.id and x.entity_id < y.entity_id
     cross join lateral unnest(cx.compartments || cy.compartments) as one
     group by x.entity_id, y.entity_id`,
  );
