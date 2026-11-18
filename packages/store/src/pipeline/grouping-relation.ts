import { ClaimRecord } from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import { claimKey } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { openedUnder } from "../core/tx.ts";
import { ensureValueRows, insertRelation, type keyedClaim, labelOf, restricted } from "./code-relations.ts";
import type { Held } from "./owner-support.ts";

type ClaimRow = Parameters<typeof keyedClaim>[1];

// One fact_groupings row as a `same_fact` relation, for the conversion and for the sweep from then
// on: for a pair a model or code said is one fact (band `accept`, accepted or proposed), the newest
// claim on each key within the row's audience, judged by the grouping's rung (code's at rung 0) or
// the model and prompt of its last saved call. The owner's joins and splits stay rulings. What it
// did, as a code.
export type GroupingRelationRow = {
  audience: string[];
  a_fp: string;
  b_fp: string;
  band: string;
  rung: number;
  state: string;
  calls: string[];
};
export type GroupingRelationCode = "written" | "kept" | "not_same" | "no_claim" | "no_judge" | "restricted";
const RULE_SAME_FACT_PHRASE = "rule:same_fact.key_phrase";
const JUDGE = /^model:[A-Za-z0-9_./:-]{1,100}@[A-Za-z0-9_.-]{1,64}(@[1-9][0-9]{0,3})?$/;

export async function groupingRelation(
  query: Query,
  keys: Keys,
  row: GroupingRelationRow,
): Promise<GroupingRelationCode> {
  // Only a pair the system or the owner accepted: a proposed one waits on the owner's card (invariant 11).
  if (row.band !== "accept" || row.state !== "accepted") return "not_same";
  const newest = async (fp: string): Promise<Held | undefined> => {
    const rows = await query<ClaimRow>(
      `select id, evidence_id, fact_key_fp, legacy_fact_key_fp, legacy_alt_fact_key_fp, compartments, content_enc from knowledge.claims
       where fact_key_fp = $1 and compartments <@ $2::text[] and not released and not closes order by valid_from desc, id collate "C" desc limit 1`,
      [fp, row.audience],
    );
    const [one] = rows;
    if (one === undefined || !one.compartments.every((compartment) => keys.compartments.has(compartment)))
      return undefined;
    const record = ClaimRecord.safeParse(
      JSON.parse(
        openedUnder(
          keys,
          one.compartments,
          { table: "knowledge.claims", id: one.id, column: "content_enc" },
          one.content_enc,
        ),
      ),
    );
    return record.success ? { row: one, record: record.data } : undefined;
  };
  const [a, b] = [await newest(row.a_fp), await newest(row.b_fp)];
  if (a === undefined || b === undefined) return "no_claim";
  const compartments = labelOf(a.row.compartments, b.row.compartments);
  if (restricted(compartments)) return "restricted";
  let judge = RULE_SAME_FACT_PHRASE;
  let version = 1;
  if (row.rung !== 0) {
    const [call] =
      row.calls.length === 0
        ? []
        : await query<{ model_id: string; prompt_id: string; prompt_version: string }>(
            "select model_id, prompt_id, prompt_version from vault.decision_calls where id = $1",
            [row.calls.at(-1)],
          );
    judge = call === undefined ? "" : `model:${call.model_id}@${call.prompt_id}@${Number(call.prompt_version)}`;
    version = Number(call?.prompt_version ?? "1");
    if (!JUDGE.test(judge) || !(version >= 1)) return "no_judge";
  }
  await ensureValueRows(query, keys, [a, b]);
  const [from, to] = [a, b].map((one) => claimKey(keys, one.row.evidence_id, one.row.fact_key_fp)) as [string, string];
  return (await insertRelation(query, { from, to, kind: "same_fact", judge, version, compartments }))
    ? "written"
    : "kept";
}
