import { BELIEF_TYPES } from "@intelligence/contracts/personal";
import type { Query } from "./db.ts";
import { NOT_CANARY_SQL } from "./statements.ts";

// The owner's audience, the owner's clearance for their own views, computed when asked: every
// compartment of the stored claims of a belief type that a ruling in force does not remove, sorted,
// but the canary's and a restricted one, which the general key file does not hold; empty with no such
// claim. A claim is removed by a reject of its item and its fact key (by its version 1 keys too, as
// beliefClaims leaves one out). A veto or a retire keeps its claims: a veto counts only for an
// audience that holds its whole label, so leaving its claims out could narrow the audience below the
// veto and show the vetoed fact again. One statement.
const OWNER_AUDIENCE = `
  select coalesce(array_agg(distinct x collate "C" order by x collate "C"), '{}') as audience
  from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  cross join unnest(c.compartments) as x
  where c.type = any ($1::text[]) and ${NOT_CANARY_SQL} and not starts_with(x, 'restricted:')
    and not exists (
      select 1 from knowledge.belief_rulings r
      where r.lifted_at is null
        and r.verdict = 'reject' and r.source_account_id = e.source_account_id and r.source_item_fp = e.source_item_fp
        and r.fact_key_fp in (c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp))`;

// One answer per transaction: the admin gives each transaction its own `query`, so the cache ends
// with it. Never pass a pool's query, which outlives a transaction.
const audiences = new WeakMap<Query, Promise<string[]>>();

export function ownerAudience(query: Query): Promise<string[]> {
  let audience = audiences.get(query);
  if (audience === undefined) {
    audience = query<{ audience: string[] }>(OWNER_AUDIENCE, [[...BELIEF_TYPES]]).then(
      ([built]) => built?.audience ?? [],
    );
    audiences.set(query, audience);
  }
  return audience;
}
