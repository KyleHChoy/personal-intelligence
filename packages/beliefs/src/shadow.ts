import type { Belief } from "@intelligence/contracts";
import type { BeliefRecord } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";

// The shadow comparison of a computed belief with the stored one, and the switch's rule over the
// passes. Counts by code only: nothing here keeps or returns a value.

const SHADOW_CODES = ["value", "status", "tier", "disputed", "support"] as const;
type ShadowCode = (typeof SHADOW_CODES)[number];
// Any of these four differing blocks the switch; `support` is logged alone.
const BLOCKING_CODES: readonly ShadowCode[] = ["value", "status", "tier", "disputed"];
export type ShadowCounts = { compared: number } & Record<ShadowCode, number>;

// A stored row as the comparison reads it: its belief opened, and its clear tier.
export type StoredBelief = { factKeyFp: string; belief: Belief; tier: string };

export const noMismatches = (): ShadowCounts => ({
  compared: 0,
  value: 0,
  status: 0,
  tier: 0,
  disputed: 0,
  support: 0,
});

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
// What the belief says: its kind, subject, type and values.
const said = (belief: Belief): string => canonical([belief.kind, belief.subject, belief.type, belief.values]);
const supportOf = (belief: Belief): string => JSON.stringify([...belief.support].sort());

// One audience's rows, by fact key: each key on either side is one row compared. A row on one side
// alone differs in `value`. `computed` rows without a tier are `source`, as the store writes them.
// `named`, when given, takes each row that blocks, by its fact key fingerprint (an id) and its
// first blocking code (`stored_only` and `computed_only` for a row on one side), for the log alone.
export type ShadowMismatch = {
  factKeyFp: string;
  code: "stored_only" | "computed_only" | "value" | "status" | "tier" | "disputed";
};
export function compareBeliefs(
  stored: readonly StoredBelief[],
  computed: readonly BeliefRecord[],
  named?: ShadowMismatch[],
): ShadowCounts {
  const counts = noMismatches();
  const before = new Map(stored.map((row) => [row.factKeyFp, row]));
  const now = new Map(computed.map((row) => [row.factKeyFp, row]));
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    counts.compared += 1;
    const a = before.get(key);
    const b = now.get(key);
    if (a === undefined || b === undefined) {
      counts.value += 1;
      named?.push({ factKeyFp: key, code: a === undefined ? "computed_only" : "stored_only" });
      continue;
    }
    const differs = {
      value: said(a.belief) !== said(b.belief),
      status: a.belief.status !== b.belief.status,
      tier: a.tier !== (b.tier ?? "source"),
      disputed: a.belief.disputed !== b.belief.disputed,
    };
    for (const code of BLOCKING_CODES as readonly (keyof typeof differs)[]) if (differs[code]) counts[code] += 1;
    const first = (BLOCKING_CODES as readonly (keyof typeof differs)[]).find((code) => differs[code]);
    if (first !== undefined) named?.push({ factKeyFp: key, code: first });
    if (supportOf(a.belief) !== supportOf(b.belief)) counts.support += 1;
  }
  return counts;
}

export const addCounts = (a: ShadowCounts, b: ShadowCounts): ShadowCounts => ({
  compared: a.compared + b.compared,
  value: a.value + b.value,
  status: a.status + b.status,
  tier: a.tier + b.tier,
  disputed: a.disputed + b.disputed,
  support: a.support + b.support,
});

export const blocking = (counts: ShadowCounts): number => BLOCKING_CODES.reduce((n, code) => n + counts[code], 0);

// One pass as the switch reads it: when it ran, and its counts.
export type ShadowPass = { passedAt: string; counts: ShadowCounts };
const SWITCH_DAYS = 7;

// The switch holds when SWITCH_DAYS have passed since the clock started and rows were
// compared on at least SWITCH_COMPARED_DAYS distinct UTC days since then. The clock starts at the
// last pass that found a blocking mismatch, or at the first pass when none has. A day with no
// reads, or a pass that compared nothing, is no evidence against the switch, so it neither counts
// nor ends the run; requiring compared rows on several days keeps a quiet week from holding on no
// evidence. `passes` are oldest first and must reach back to the last blocking pass, or to the
// first pass when there is none. Computed from the passes each time, never stored.
const SWITCH_COMPARED_DAYS = 4;
export function switchHolds(passes: readonly ShadowPass[], now: Date): { holds: boolean; days: number } {
  if (passes.length === 0) return { holds: false, days: 0 };
  const lastBlocking = passes.findLastIndex((pass) => blocking(pass.counts) > 0);
  const start = Date.parse((passes[Math.max(lastBlocking, 0)] as ShadowPass).passedAt);
  const days = Math.floor((now.getTime() - start) / DAY_MS);
  const compared = new Set(
    passes
      .slice(lastBlocking + 1)
      .filter((pass) => pass.counts.compared > 0)
      .map((pass) => Math.floor(Date.parse(pass.passedAt) / DAY_MS)),
  );
  return { holds: days >= SWITCH_DAYS && compared.size >= SWITCH_COMPARED_DAYS, days };
}
