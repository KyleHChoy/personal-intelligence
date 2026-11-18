// What a computed belief is keyed and fingerprinted by: its id for an audience, the state a change
// compares, its stored claim ids, and a commitment's due value as an interval.
import { type BeliefRecord, dayAfter, startOfDay } from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Tx } from "../core/tx.ts";
import { beliefState } from "./pipeline-write.ts";

// An audience's sorted form.
export const sortedAudience = (audience: readonly string[]): string[] => [...audience].sort(byText);

// A belief's id: the same for every computation of one fact for one audience.
export const beliefId = (tx: Tx, factKeyFp: string, audience: string[]): string =>
  `blf_${fingerprint(tx.keys, "fact", [factKeyFp, ...audience].join("\n")).slice(0, 40)}`;

export const storedBelief = (tx: Tx, record: BeliefRecord) => ({
  state: fingerprint(tx.keys, "belief_state", canonicalJson(record.belief)),
  support: record.belief.support.map((claim) => fingerprint(tx.keys, "claim", claim)),
  tier: record.tier ?? "source",
  phraseClaim: record.phraseClaim === undefined ? null : fingerprint(tx.keys, "claim", record.phraseClaim),
  group: record.group ?? null,
});

// What a reported change compares: a change of support alone is none.
export const stateOf = (belief: BeliefRecord["belief"]): string => beliefState(belief);

// A day is the owner's local day in `zone`, UTC's while they have set none; an instant is itself;
// and a value that is neither is no interval.
export function dueInterval(due: string, zone: string | null): [string, string] | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const start = new Date(`${due}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== due) return null;
    return [new Date(startOfDay(due, zone)).toISOString(), new Date(startOfDay(dayAfter(due), zone)).toISOString()];
  }
  const at = Date.parse(due);
  if (Number.isNaN(at)) return null;
  const instant = new Date(at).toISOString();
  return [instant, instant];
}
