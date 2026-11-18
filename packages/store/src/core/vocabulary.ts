import type { Query } from "./db.ts";
import { type Fixed, type Sql, sql } from "./sql.ts";

// The store's shared vocabulary about people, as typed SQL, each stated once: who holds a
// fingerprint under a label, what an erasure suppressed, which moments a source sent, and whom the
// owner corresponds with.

// A piece the type checker has already held to a literal, as a fragment.
const piece = (text: string): Sql => text as Sql;

// The accounts `a` whose value_fp equals `fp` (`$1`, or `any($1::text[])`) under labels within
// `label`, with their entities `e`: people's alone, or with `"any"` the owner's and
// organizations' too. A statement selects from it and may add its own grouping and order.
export const holders = <F extends string, L extends string>(
  fp: Fixed<F>,
  label: Fixed<L>,
  kinds: "people" | "any" = "people",
): Sql =>
  piece(
    `knowledge.accounts a join knowledge.entities e on e.id = a.entity_id${kinds === "people" ? " and e.kind = 'person'" : ""}
  where a.value_fp = ${fp} and a.compartments <@ ${label}`,
  );

// Whether an erasure suppressed any of these fingerprints, under any label.
const SUPPRESSED = sql`select exists (select 1 from knowledge.suppressions where value_fp = any($1::text[])) as yes`;
export async function anySuppressed(query: Query, fps: readonly string[]): Promise<boolean> {
  return (await query<{ yes: boolean }>(SUPPRESSED, [fps]))[0]?.yes === true;
}
// The same, only for a suppression under a compartment of `label`: a name is suppressed for the
// labels its erasure covered.
const SUPPRESSED_UNDER = sql`select exists (select 1 from knowledge.suppressions where value_fp = any($1::text[]) and compartments && $2::text[]) as yes`;
export async function anySuppressedUnder(
  query: Query,
  fps: readonly string[],
  label: readonly string[],
): Promise<boolean> {
  return (await query<{ yes: boolean }>(SUPPRESSED_UNDER, [fps, label]))[0]?.yes === true;
}

// A source moment: a moment a source sent (a chat's), which no agent-app rule admitted. On a
// capture aliased `c`.
export const SOURCE_MOMENT = sql`c.kind = 'moment' and c.source is not null and not c.agent_app`;

// The sender's people are the person the message's own interaction rows name its sender, and the
// person of any address one of the owner's live `same` rulings joins to the sender's address (one
// step of the identity group: a sibling who writes from a second address). One of them counts when
// it is a person (never the owner, never an organization) the owner has written to (an outbound
// interaction naming them a recipient) or one a saved contact lists
// (`knowledge.contact_addresses`). Only rows whose label is within the message's own count, so
// nothing under another label moves its lane; a role's policies keep the rest out (pi_pipeline sees
// no restricted row). A message that derives no person (bulk) has no interaction rows. `m` names a
// row with `direction`, `evidence_id`, `sender_fp` and `compartments`.
export function knownCorrespondent<M extends string>(m: Fixed<M>): Sql {
  return piece(`(${m}.direction = 'inbound' and exists (
    select 1 from (
      select s.entity_id from knowledge.interaction_log s
      where s.evidence_id = ${m}.evidence_id and s.entity_role = 'sender'
      union all
      select a.entity_id from knowledge.identity_rulings r
      join knowledge.accounts a on a.value_fp = (case when r.a_fp = ${m}.sender_fp then r.b_fp else r.a_fp end) and a.compartments <@ ${m}.compartments
      where r.verdict = 'same' and r.lifted_at is null and (r.a_fp = ${m}.sender_fp or r.b_fp = ${m}.sender_fp)
    ) p
    join knowledge.entities e on e.id = p.entity_id and e.kind = 'person'
    where exists (select 1 from knowledge.interaction_log o
            where o.entity_id = p.entity_id and o.direction = 'outbound' and o.entity_role = 'recipient' and o.channel <> 'mail_headers' and o.compartments <@ ${m}.compartments)
      or exists (select 1 from knowledge.contact_addresses k where k.entity_id = p.entity_id and k.compartments <@ ${m}.compartments)))`);
}
