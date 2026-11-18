import type { Query } from "../core/db.ts";
import { lever } from "../core/settings.ts";

// The carry-over gate: before a run takes an item due again by a change of generation, what that
// generation would do to the owner's rulings, read from stored rows alone (`policy.carry_gate`). It
// counts the rulings no code could carry: one with no anchor whose key still names a claim
// (`unanchored`), and one whose evidence, already read at the generation, holds claims of its type
// and not exactly one fact naming its entities (`detached`). Over the owner's lever
// `extract.carry_gate_max` the gate refuses, and the run leaves those items as they are. Ids and
// counts only.

type GateRow = { ruling_id: string; state: string };

export type CarryGateReport = {
  generation: number;
  max: number;
  refused: boolean;
  // The rulings the gate counts, by id.
  unanchored: string[];
  detached: string[];
  // What it does not count: not yet read at the generation; detached before it had an anchor; its
  // fact no longer stated; and carried by code when the sweep runs.
  pending: number;
  lost: number;
  gone: number;
  carries: number;
};

// The rule: refused when the rulings counted are more than `max`. A state the function does not
// name counts as detached, the safer reading.
export function gateOf(generation: number, rows: readonly GateRow[], max: number): CarryGateReport {
  const of = (state: string): string[] => rows.filter((row) => row.state === state).map((row) => row.ruling_id);
  const known = ["unanchored", "detached", "pending", "lost", "gone", "carries"];
  const unanchored = of("unanchored");
  const detached = [...of("detached"), ...rows.filter((row) => !known.includes(row.state)).map((row) => row.ruling_id)];
  return {
    generation,
    max,
    refused: unanchored.length + detached.length > max,
    unanchored,
    detached,
    pending: of("pending").length,
    lost: of("lost").length,
    gone: of("gone").length,
    carries: of("carries").length,
  };
}

export async function carryGate(query: Query, generation: number): Promise<CarryGateReport> {
  const rows = await query<GateRow>("select ruling_id, state from policy.carry_gate($1::integer)", [generation]);
  return gateOf(generation, rows, await lever(query, "extract.carry_gate_max"));
}
