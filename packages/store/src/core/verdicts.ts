import type { PointVerdict, VerdictSource } from "@intelligence/contracts/personal";
import { type Query, stamp } from "./db.ts";
import { newId } from "./ids.ts";
import type { Keys } from "./keys.ts";
import { sealUnder } from "./seal.ts";

// The verdict rows: the band a probability falls in, and one ledger.point_verdicts row, its answer
// and the call's probability sealed under the call's compartments.

// The six bands' upper edges: the ladder's BANDS. A band is how many edges lie at or below p.
const EDGES = [0.05, 0.2, 0.5, 0.8, 0.95];
export const bandOf = (p: number): number => EDGES.filter((edge) => p >= edge).length;

export const verdictAt = (id: string) => ({ table: "ledger.point_verdicts", id, column: "body_enc" });

export type VerdictInput = {
  point: string;
  version: number;
  callId: string;
  evidenceId: string | null;
  source: VerdictSource;
  verdict: PointVerdict;
  p: number;
  band: number;
  weight: number;
  hurried: boolean;
  deliberate: boolean;
  compartments: string[];
  requestId: string;
};

// One verdict row, in the caller's transaction (a card's answer and a lane retry write theirs in
// the decision's own). A repeated request id writes nothing and returns the first. `now` is the
// caller's clock, the one its views are written on: a review verdict's time is read against its
// call's view, so the two are never stamped by different clocks.
export async function writeVerdict(query: Query, keys: Keys, input: VerdictInput, now: Date): Promise<string> {
  const [repeated] = await query<{ id: string }>(
    "select id from ledger.point_verdicts where created_by = 'owner' and request_id = $1",
    [input.requestId],
  );
  if (repeated !== undefined) return repeated.id;
  const id = newId("pvd");
  const compartments = [...new Set(input.compartments)].sort();
  await query(
    `insert into ledger.point_verdicts (id, request_id, created_at, created_by, compartments, body_enc, point, version, call_id, evidence_id, source, band, weight, deliberate, hurried)
     values ($1, $2, $14, 'owner', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.requestId,
      compartments,
      sealUnder(keys, compartments, verdictAt(id), JSON.stringify({ verdict: input.verdict, p: input.p })),
      input.point,
      input.version,
      input.callId,
      input.evidenceId,
      input.source,
      input.band,
      input.weight,
      input.deliberate,
      input.hurried,
      stamp(now),
    ],
  );
  return id;
}
