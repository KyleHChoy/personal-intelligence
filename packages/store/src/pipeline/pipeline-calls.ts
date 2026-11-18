import { ModelCallKey, ModelCallRecord } from "@intelligence/contracts";
import { ModelUsageEvent, RunSummary, type UsageLane } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { UNSEALED } from "@intelligence/personal-core/items";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, sha256Hex } from "../core/ids.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";
import { ownerDayOf } from "../core/zone.ts";
import { noteModelExposure } from "../erasure/exposures.ts";
import { CALL_KEY_VERSION, replayedCall, type SavedCall } from "./call-key.ts";
import { lockItem } from "./pipeline-write.ts";

// A saved call. The output is sealed under the item's compartment; the input hash is kept only
// keyed, and the output's hash not at all. The call that answers is `modelId`'s own, or one saved
// before the model was part of the key (call-key.ts); one a retry superseded is kept and never
// replayed.
export async function findCall(tx: Tx, given: ModelCallKey, modelId: string): Promise<ModelCallRecord | null> {
  const key = ModelCallKey.parse(given);
  const rows = await tx.query<SavedCall & { output_enc: Sealed; compartments: string[] }>(
    `select id, key_version, model_id, output_enc, compartments from vault.model_calls
     where evidence_id = $1 and revision = $2 and prompt_id = $3 and prompt_version = $4 and input_fp = $5
       and superseded_at is null
     order by id collate "C"`,
    [key.evidenceId, key.revision, key.promptId, key.promptVersion, fingerprint(tx.keys, "model_input", key.inputHash)],
  );
  const row = replayedCall(rows, modelId);
  if (row === undefined) return null;
  const rawOutput = open(tx.keys, row, "vault.model_calls.output_enc", "throw");
  return {
    key,
    // The sentinel key of an item built in memory: the shared replay reads only a saved call's key,
    // its raw output and that output's hash.
    keys: [{ evidenceId: key.evidenceId, keyRef: UNSEALED }],
    renderedInput: "",
    rawOutput,
    outputHash: sha256Hex(rawOutput),
    label: { compartments: row.compartments, readers: [THE_OWNER] },
    origin: "live",
  };
}

// A call already saved keeps the members it was saved with.
export async function saveCall(
  tx: Tx,
  modelId: string,
  given: ModelCallRecord,
  xmin: string | undefined,
  members: { evidenceId: string; xmin: string | undefined }[] = [],
): Promise<void> {
  const record = ModelCallRecord.parse(given);
  const { key } = record;
  const item = await lockItem(tx, key.evidenceId, xmin);
  if (item.state !== "latest") return;
  for (const member of members) {
    if (member.evidenceId !== key.evidenceId && (await lockItem(tx, member.evidenceId, member.xmin)).state !== "latest")
      return;
  }
  const id = newId("mcl");
  const saved = await tx.query<{ id: string }>(
    `insert into vault.model_calls (id, evidence_id, revision, prompt_id, prompt_version, input_fp, model_id, output_enc, compartments, key_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (evidence_id, revision, prompt_id, prompt_version, input_fp, model_id) where key_version = 2 and superseded_at is null do nothing
     returning id`,
    [
      id,
      key.evidenceId,
      key.revision,
      key.promptId,
      key.promptVersion,
      fingerprint(tx.keys, "model_input", key.inputHash),
      modelId,
      sealUnder(tx.keys, item.compartments, { table: "vault.model_calls", id, column: "output_enc" }, record.rawOutput),
      item.compartments,
      CALL_KEY_VERSION,
    ],
  );
  if (saved.length === 0) return;
  for (const evidenceId of new Set(members.map((member) => member.evidenceId))) {
    await tx.query("insert into vault.model_call_members (call_id, evidence_id, compartments) values ($1, $2, $3)", [
      id,
      evidenceId,
      item.compartments,
    ]);
  }
}

// A usage row: the UTC day, no time of day and no item, and the budget's lane. Under the
// compartment of the item the event names, or `own` when it names none or the item
// is gone.
// The day a row counts on: UTC's for extraction, whose day lines read UTC days; the owner's, in their
// zone, for the night's pass, which runs once a day of theirs (imp_01M6ST6KKR50FH9BHDKKNV89HX).
export async function recordUsageRow(tx: Tx, given: ModelUsageEvent, lane: UsageLane = "extract"): Promise<void> {
  const event = ModelUsageEvent.parse(given);
  const day = lane === "dream" ? await ownerDayOf(tx.query) : null;
  const [item] =
    event.evidenceId === undefined
      ? []
      : await tx.query<{ compartments: string[] }>("select compartments from vault.evidence_items where id = $1", [
          event.evidenceId,
        ]);
  await tx.query(
    `insert into vault.model_usage (id, prompt_id, prompt_version, model_id, input_tokens, output_tokens, cost_microusd, outcome, day, compartments, lane)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($11::date, (now() at time zone 'utc')::date), $9, $10)`,
    [
      newId("mus"),
      event.promptId,
      event.promptVersion,
      event.modelId,
      event.inputTokens,
      event.outputTokens,
      event.costMicroUsd,
      event.outcome,
      item?.compartments ?? ["own"],
      lane,
      day,
    ],
  );
}

// The run's applied thresholds go in its own row, as ids, names and numbers. The lanes a switch
// turned off for the run, sorted, each once; null when the process did not record them.
export type LaneOff = "document" | "meeting" | "moment";
export async function recordRunRow(
  tx: Tx,
  given: RunSummary,
  lanesOff: readonly LaneOff[] | null = null,
): Promise<void> {
  const { code, counts, thresholds } = RunSummary.parse(given);
  await tx.query(
    `insert into vault.extraction_runs (day, code, done, skipped, withheld, failed, waiting, claims, unmapped, unresolved, live_calls,
       beliefs, beliefs_changed, beliefs_mixed, beliefs_failed, beliefs_removed, rebuild_ms, thresholds, compartments, lanes_off)
     values ((now() at time zone 'utc')::date, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '{own}', $18)`,
    [
      code,
      counts.done,
      counts.skipped,
      counts.withheld,
      counts.failed,
      counts.waiting,
      counts.claims,
      counts.unmapped,
      counts.unresolved,
      counts.liveCalls,
      counts.beliefs,
      counts.beliefsChanged,
      counts.beliefsMixed,
      counts.beliefsFailed,
      counts.beliefsRemoved,
      counts.rebuildMs,
      thresholds === undefined ? null : JSON.stringify(thresholds),
      lanesOff === null ? null : [...new Set(lanesOff)].sort(),
    ],
  );
}

// The average cost of a prompt's answered calls; null before any.
export async function callCost(query: Query, promptId: string): Promise<number | null> {
  const [row] = await query<{ cost: number | null }>(
    "select avg(cost_microusd)::float8 as cost from vault.model_usage where prompt_id = $1 and outcome = 'ok'",
    [promptId],
  );
  return row?.cost ?? null;
}

const SPENT =
  "select sum(cost_microusd)::text as spent from vault.model_usage where day >= $1::date and lane = 'extract'";
const SPENT_ON_PROMPT =
  "select sum(cost_microusd)::text as spent from vault.model_usage where day >= $1::date and lane = 'extract' and prompt_id = $2";

// What the extract lane spent from a day on, of one prompt when it is given.
export async function spentSince(query: Query, day: string, promptId?: string): Promise<number> {
  const [row] = await query<{ spent: string | null }>(
    promptId === undefined ? SPENT : SPENT_ON_PROMPT,
    promptId === undefined ? [day] : [day, promptId],
  );
  return Number(row?.spent ?? 0);
}

// Under repeatable read the note's `on conflict` could raise 40001 when a run of the same day wrote
// the same row. The evidence rows are first taken `for share`, as a commit takes them: an erasure
// holds them `for update` from before its hooks read the record until it commits, so a note either
// commits before the erasure links it, or waits and then finds the row gone (23503).
export async function noteModelRoute(
  query: Query,
  modelId: string,
  promptId: string,
  evidenceIds: string[],
): Promise<number> {
  await query("set transaction isolation level read committed");
  await query("select id from vault.evidence_items where id = any($1) order by id for share", [evidenceIds]);
  return noteModelExposure(query, modelId, promptId, evidenceIds);
}
