import type { Timestamp } from "@intelligence/contracts";
import type { BeliefRecord } from "@intelligence/contracts/personal";
import { beliefAt } from "@intelligence/personal-beliefs";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import type { SupportOf } from "../core/work-time-read.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";

// The fact keys one read of policy.belief_inputs_under takes, as the readers batch theirs.
const KEYS_PER_READ = 1000;

// Every belief of `factKeys` a reader of `clearance` is given, computed by `beliefAt` as of
// `asOf` from what policy.belief_inputs_under returns for that clearance (no stored
// answer). Run by a role that holds the function: pi_pipeline, for the same-fact sweep and the
// Pipeline's sweepBeliefs.
export async function computedBeliefs(
  query: Query,
  keys: Keys,
  clearance: readonly string[],
  factKeys: readonly string[],
  asOf: string,
): Promise<BeliefRecord[]> {
  const records: BeliefRecord[] = [];
  for (let start = 0; start < factKeys.length; start += KEYS_PER_READ) {
    const some = factKeys.slice(start, start + KEYS_PER_READ);
    const inputs = await readBeliefInputsUnder(query, keys, clearance, some, asOf);
    records.push(...beliefAt(inputs, clearance, some, asOf as Timestamp));
  }
  return records;
}

// The work-time gathering's SupportOf under one clearance: each computed belief's support by stored
// claim id, as of the database's now().
export const supportsUnder =
  (query: Query, keys: Keys, clearance: readonly string[]): SupportOf =>
  async (factKeys) => {
    if (factKeys.length === 0 || clearance.length === 0) return [];
    const [clock] = await query<{ now: Date }>("select now() as now");
    const asOf = (clock?.now ?? new Date()).toISOString();
    const records = await computedBeliefs(query, keys, clearance, factKeys, asOf);
    return records.map((record) => record.belief.support.map((claim) => fingerprint(keys, "claim", claim)));
  };
