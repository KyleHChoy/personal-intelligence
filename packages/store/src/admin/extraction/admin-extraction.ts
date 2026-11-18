import { randomBytes } from "node:crypto";
import type { AskedLane, CaptureLane } from "@intelligence/contracts/personal";
import {
  currentDefinition,
  type MessageId,
  type MessageTriageRow,
  type PipelineCode,
  type PipelineStatus,
  type TriageLane,
} from "@intelligence/contracts/personal";
import type { TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { TRY_EXTRACT } from "../../core/locks.ts";
import { lockRows, recordRelease } from "../../core/queue.ts";
import { waitToReplay, writeStatus } from "../../core/replay.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { openStatus, type StatusFacts } from "../../core/status-facts.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { bandOf, writeVerdict } from "../../core/verdicts.ts";
import { knownCorrespondent } from "../../core/vocabulary.ts";
import { triageRowOf } from "../../pipeline/pipeline-due.ts";
import { supersedeCalls } from "../../write/writer-removal.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { type KeptVersions, retryCost, SAVED } from "./admin-extraction-cost.ts";

// The owner's write side of extraction, run as pi_admin: the extract lock and its refusal, setting
// items waiting (`pi extract retry`, documents again, replay, a record waiting), reroute, release,
// the lane verdict, and one message's item view.

// Beside all, a status and one message: one document by its id, one kind of capture item (alone
// or by status), one meeting or moment by its `cap_` id or capture key, or the items one message
// lane holds (alone or by status), so a lane's history is asked its current version again.
export type RetryKind = CaptureLane;
export type RetrySelection =
  | { all: true }
  | { status: Exclude<PipelineStatus, "waiting"> }
  | { messageId: string }
  | { documentId: string }
  | { kind: RetryKind; status?: Exclude<PipelineStatus, "waiting"> }
  | { capture: string }
  | { inLane: RetryLane; status?: Exclude<PipelineStatus, "waiting"> };
export type RetryLane = AskedLane;

// How many items a retry by status or for all changes without `confirmed`.
const CONFIRM_OVER = 50;

type StatusRow = {
  evidence_id: string;
  compartments: string[];
  facts_enc: Sealed;
  extractor_generation: number;
  waiting: boolean;
};

// Within the compartments this key set opens: an owner's commands hold no key to the standing check's items, and
// one such row would otherwise fail every command that reads the status.
export async function statusRows(tx: Tx): Promise<{ row: StatusRow; facts: StatusFacts }[]> {
  const rows = await tx.query<StatusRow>(
    'select evidence_id, compartments, facts_enc, extractor_generation, waiting from vault.pipeline_items where compartments <@ $1::text[] order by evidence_id collate "C"',
    [[...tx.keys.compartments.keys()]],
  );
  return rows.map((row) => ({ row, facts: openStatus(tx, row.compartments, row.evidence_id, row.facts_enc) }));
}

// The extract lock, tried and not waited on, held to the commit: no run that resolved before the
// change can commit after it and clear an item's waiting mark.
export async function tryExtractLock(tx: Tx): Promise<void> {
  const [lock] = await tx.query<{ held: boolean }>(TRY_EXTRACT);
  if (lock?.held !== true) throw new AdminError("extract_running");
}

// An agent record's item set waiting for the next run, as a retry sets one but with its saved calls
// kept: its status as it stands, with no code and `more` over it (the owner's release of a flagged
// record, or the clearing of its restatement check). Under the status row's label, or the record's
// when it has none.
export async function setRecordWaiting(
  tx: Tx,
  evidenceId: string,
  compartments: string[],
  more: Partial<StatusFacts>,
): Promise<void> {
  const [status] = await tx.query<{ facts_enc: Sealed; compartments: string[] }>(
    "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
    [evidenceId],
  );
  const facts = status === undefined ? undefined : openStatus(tx, status.compartments, evidenceId, status.facts_enc);
  const { code: _code, ...rest } = facts ?? {
    lane: "agent" as const,
    override: false,
    status: "waiting" as const,
    attempts: 0,
    claims: 0,
    unmapped: 0,
    unresolved: 0,
  };
  await writeStatus(tx, evidenceId, status?.compartments ?? compartments, { ...rest, ...more, status: "waiting" });
}

const evidenceOfMessage = async (
  tx: Tx,
  messageId: string,
): Promise<{ evidence_id: string; compartments: string[] } | undefined> =>
  (
    await tx.query<{ evidence_id: string; compartments: string[] }>(
      "select evidence_id, compartments from knowledge.messages where id = $1",
      [messageId],
    )
  )[0];

const evidenceOfDocument = async (
  tx: Tx,
  documentId: string,
): Promise<{ evidence_id: string; compartments: string[] } | undefined> =>
  (
    await tx.query<{ evidence_id: string; compartments: string[] }>(
      "select evidence_id, compartments from knowledge.documents where id = $1",
      [documentId],
    )
  )[0];

// `lane`: the lane written for an item with no status row, a capture item's being its kind's.
type Selected = { evidenceId: string; compartments: string[]; facts: StatusFacts | undefined; lane?: TriageLane };

// The stored meeting or moment a `--capture` names, by its `cap_` id or its capture
// key; its latest revision when the key has several rows. A block day makes no claim, so it is not
// one.
const captureOf = async (
  tx: Tx,
  value: string,
): Promise<{ evidence_id: string; compartments: string[]; kind: RetryKind } | undefined> =>
  (
    await tx.query<{ evidence_id: string; compartments: string[]; kind: RetryKind }>(
      "select evidence_id, compartments, kind from knowledge.captures where (id = $1 or capture_key = $1) and kind in ('meeting', 'moment') order by revision desc limit 1",
      [value],
    )
  )[0];

// No claim is removed: the next run's commit does that.
export async function retry(
  tx: Tx,
  selection: RetrySelection,
  // `keepAnswers`, the versions of each lane for a retry that keeps its saved calls.
  options: { lane?: TriageLane; confirmed?: boolean; keepAnswers?: Readonly<Record<RetryLane, KeptVersions>> } = {},
): Promise<{ selected: number; asked?: number; chars?: number }> {
  await tryExtractLock(tx);
  const rows = await statusRows(tx);
  let selected: Selected[];
  if ("messageId" in selection || "documentId" in selection) {
    const item =
      "messageId" in selection
        ? await evidenceOfMessage(tx, selection.messageId)
        : await evidenceOfDocument(tx, selection.documentId);
    if (item === undefined) throw new AdminError("not_found");
    const found = rows.find(({ row }) => row.evidence_id === item.evidence_id);
    selected = [{ evidenceId: item.evidence_id, compartments: item.compartments, facts: found?.facts }];
  } else if ("capture" in selection) {
    const item = await captureOf(tx, selection.capture);
    if (item === undefined) throw new AdminError("not_found");
    const found = rows.find(({ row }) => row.evidence_id === item.evidence_id);
    selected = [
      { evidenceId: item.evidence_id, compartments: item.compartments, facts: found?.facts, lane: item.kind },
    ];
  } else {
    // A kind selects that kind's capture items alone, so no other item, and no claim
    // of another lane, is touched.
    const ofKind =
      "kind" in selection
        ? new Set(
            (
              await tx.query<{ evidence_id: string }>("select evidence_id from knowledge.captures where kind = $1", [
                selection.kind,
              ])
            ).map((row) => row.evidence_id),
          )
        : undefined;
    const status = "status" in selection ? selection.status : undefined;
    // A lane selects the items it holds now: the owner's lane when one is set, else triage's.
    const inLane = "inLane" in selection ? selection.inLane : undefined;
    const chosen = rows.filter(
      ({ row, facts }) =>
        (ofKind === undefined || ofKind.has(row.evidence_id)) &&
        (status === undefined || facts.status === status) &&
        (inLane === undefined || (facts.laneOverride ?? facts.lane) === inLane),
    );
    selected = chosen.map(({ row, facts }) => ({ evidenceId: row.evidence_id, compartments: row.compartments, facts }));
    const keeping = options.keepAnswers !== undefined && "inLane" in selection;
    if (!keeping && selected.length > CONFIRM_OVER && options.confirmed !== true)
      throw new AdminError("confirm_needed", selected.length);
  }
  if ("messageId" in selection && options.lane !== undefined) await laneVerdict(tx, selected[0], options.lane);
  // A lane is the item's kind's: a bulk retry's message lane leaves a document's as it
  // was, and `skip` is a lane of both.
  const documents = new Set(
    (
      await tx.query<{ evidence_id: string }>(
        "select evidence_id from knowledge.documents where evidence_id = any ($1)",
        [selected.map((one) => one.evidenceId)],
      )
    ).map((row) => row.evidence_id),
  );
  // A lane's retry that keeps its saved answers: each replays at no cost, but what it chose, for its words or a project
  // it is in, and one with no saved call, which the run asks anew. It may pay at any size, so without `confirmed` it
  // changes nothing and says what it would pay.
  if (options.keepAnswers !== undefined && "inLane" in selection) {
    const ids = selected.map((one) => one.evidenceId);
    const versions = options.keepAnswers[selection.inLane];
    const cost = await retryCost(tx, ids, versions, selection.inLane === "correspondence");
    const counts = { asked: cost.asked, chars: cost.chars };
    if (options.confirmed !== true)
      throw new AdminError("confirm_needed", selected.length, undefined, undefined, counts);
    await waitToReplay(
      tx,
      ids.filter((id) => !cost.chosen.has(id)),
    );
    if (versions.ask !== null)
      await waitToReplay(tx, [...cost.chosen], { ask: { lane: selection.inLane, version: versions.ask.version } });
    return { selected: selected.length, ...counts };
  }
  await setWaiting(tx, selected, options.lane, documents);
  return { selected: selected.length };
}

// The fact cleanup's re-extraction (`pia facts clean --apply`): these items set waiting as a retry
// sets them, their saved calls deleted, so the next run asks each its lane's version anew. The
// caller holds the extract lock. Returns how many were set waiting.
export async function retryItems(tx: Tx, evidenceIds: readonly string[]): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  const chosen = (await statusRows(tx)).filter(({ row }) => evidenceIds.includes(row.evidence_id));
  await setWaiting(
    tx,
    chosen.map(({ row, facts }) => ({ evidenceId: row.evidence_id, compartments: row.compartments, facts })),
    undefined,
    new Set(),
  );
  return chosen.length;
}

// The caller holds the extract lock.
export async function documentsWaitAgain(tx: Tx, rootId: string): Promise<void> {
  const documents = await tx.query<{ evidence_id: string; compartments: string[] }>(
    'select evidence_id, compartments from knowledge.documents where root_id = $1 order by evidence_id collate "C"',
    [rootId],
  );
  const rows = new Map((await statusRows(tx)).map(({ row, facts }) => [row.evidence_id, facts]));
  await setWaiting(
    tx,
    documents.map((one) => ({
      evidenceId: one.evidence_id,
      compartments: one.compartments,
      facts: rows.get(one.evidence_id),
    })),
    undefined,
    new Set(documents.map((one) => one.evidence_id)),
  );
}

const laneOf = (lane: TriageLane | undefined, document: boolean): TriageLane | undefined =>
  lane === undefined || lane === "skip" || (lane === "document") === document ? lane : undefined;

async function setWaiting(
  tx: Tx,
  selected: Selected[],
  given: TriageLane | undefined,
  documents: ReadonlySet<string>,
): Promise<void> {
  // The item's saved calls are kept and no longer replayed, so the next run asks anew. A moment
  // group's call goes the same way when the item retried is one of its members.
  await supersedeCalls(
    tx.query,
    selected.map((one) => one.evidenceId),
  );
  for (const { evidenceId, compartments, facts, lane: unseen } of selected) {
    const lane = laneOf(given, documents.has(evidenceId));
    const laneOverride = lane ?? facts?.laneOverride;
    await writeStatus(tx, evidenceId, compartments, {
      lane: lane ?? facts?.lane ?? unseen ?? (documents.has(evidenceId) ? "document" : "correspondence"),
      ...(laneOverride === undefined ? {} : { laneOverride }),
      override: false,
      status: "waiting",
      attempts: 0,
      claims: facts?.claims ?? 0,
      unmapped: facts?.unmapped ?? 0,
      unresolved: facts?.unresolved ?? 0,
      // The owner asked for it again, so its next commit replaces its claims.
      retried: true,
    });
  }
}

// `pia extract replay-refused`. The done messages and agent findings at this generation
// with a candidate refused `bad_fields`, or with a claim a repair kept, which is how a switched-off
// repair reaches an item it kept whole: such an item has no refusal row. Each is set waiting as `waitToReplay` sets an item and marked
// `rerouted`, so the commit that takes each is backfill and wakes no agent. Only an item with a saved
// call of `saved`'s version for the lane it was committed in (what a run replays whatever its
// switches), and that triage would leave in it, so none buys a new answer; `skipped` counts the rest.
// A document is counted `skipped` and left: triage reads its age at the run, and one past its window
// would commit skipped and lose its claims. Only within the key file's compartments but the restricted ones. An item never due is left out: a held
// message or document, a typed finding. Moments are left out: one moment set waiting alone would
// change its group's call. Over CONFIRM_OVER items without `confirmed` it changes nothing.
const REPLAYABLE = `
  from vault.pipeline_items p
  join vault.evidence_items e on e.id = p.evidence_id
  where p.extractor_generation = $1 and not p.waiting and not p.withheld
    and e.source_kind = any ($2::text[]) and not e.typed and p.compartments <@ $3::text[]
    and not exists (select 1 from knowledge.messages m where m.evidence_id = e.id and m.held)
    and not exists (select 1 from knowledge.documents d where d.evidence_id = e.id and d.held)`;
const REFUSED_ROWS = `
  select u.id, u.evidence_id, u.compartments, u.facts_enc from vault.unmapped_claims u
  where u.evidence_id in (select p.evidence_id ${REPLAYABLE})`;
const REPLAYABLE_STATUS = `select p.evidence_id, p.compartments, p.facts_enc ${REPLAYABLE}`;
const REPLAYABLE_KINDS = ["email", "agent_record", "document"];

export async function replayRefused(
  tx: Tx,
  options: { generation: number; confirmed: boolean; saved: Readonly<Record<string, string>> },
): Promise<{ selected: number; skipped: number; replayed: number }> {
  const { generation } = options;
  const within = unrestrictedOf(tx.keys);
  const statuses = new Map<string, StatusFacts>();
  for (const row of await tx.query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
    REPLAYABLE_STATUS,
    [generation, REPLAYABLE_KINDS, within],
  ))
    statuses.set(row.evidence_id, openStatus(tx, row.compartments, row.evidence_id, row.facts_enc));
  const chosen = new Set([...statuses].filter(([, facts]) => (facts.repaired ?? 0) > 0).map(([id]) => id));
  for (const row of await tx.query<{ id: string; evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
    REFUSED_ROWS,
    [generation, REPLAYABLE_KINDS, within],
  )) {
    const facts = JSON.parse(open(tx.keys, row, "vault.unmapped_claims.facts_enc", "throw")) as { reason: string };
    if (facts.reason === "bad_fields") chosen.add(row.evidence_id);
  }
  // Triage's known-correspondent line would move it, and the lane it moves to has no saved answer.
  const moving = new Set(
    (await tx.query<{ evidence_id: string }>(REROUTABLE, [generation, [...tx.keys.compartments.keys()]])).map(
      (row) => row.evidence_id,
    ),
  );
  const replays = new Set<string>();
  for (const row of await tx.query<{ evidence_id: string; saved: string }>(SAVED, [[...chosen]])) {
    const status = statuses.get(row.evidence_id);
    if (status === undefined || options.saved[status.lane] !== row.saved) continue;
    if (status.lane === "transaction" && status.laneOverride === undefined && moving.has(row.evidence_id)) continue;
    replays.add(row.evidence_id);
  }
  const ids = [...replays];
  const counts = { selected: ids.length, skipped: chosen.size - ids.length };
  if (ids.length > CONFIRM_OVER && !options.confirmed) return { ...counts, replayed: 0 };
  return { ...counts, replayed: await waitToReplay(tx, ids, { rerouted: true }) };
}

// `pia extract reroute`. The done items of the transaction lane, at this generation,
// that triage's line 4 now sends to correspondence: inbound mail that is not bulk or held, from
// someone the owner corresponds with, that no owner's lane placed. Each is set waiting as
// `waitToReplay` sets an item, its saved calls kept (the decide model's answer replays at no cost) and its
// owner's release as it was, and marked `rerouted`, so the next runs extract it in the
// correspondence lane at this generation, its commit replaces its claims, and both are backfill.
// A dry run counts and writes nothing. Counts only: the items, and their text's code points, for
// an estimate of what the correspondence lane will cost.
const REROUTABLE = `
  select p.evidence_id, p.compartments, p.facts_enc as status_facts, m.id as message_id, m.compartments as message_compartments, m.facts_enc as message_facts
  from vault.pipeline_items p
  join knowledge.messages m on m.evidence_id = p.evidence_id
  where p.extractor_generation = $1 and not p.waiting and not p.withheld and p.compartments <@ $2::text[]
    and m.direction = 'inbound' and not m.bulk and not m.held and ${knownCorrespondent("m")}
  order by p.evidence_id collate "C"`;

export async function reroute(
  tx: Tx,
  options: { generation: number; dryRun: boolean },
): Promise<{ selected: number; chars: number; rerouted: number }> {
  const { generation } = options;
  if (!options.dryRun) await tryExtractLock(tx);
  const rows = await tx.query<{
    evidence_id: string;
    compartments: string[];
    status_facts: Sealed;
    message_id: string;
    message_compartments: string[];
    message_facts: unknown;
  }>(REROUTABLE, [generation, [...tx.keys.compartments.keys()]]);
  let chars = 0;
  const chosen: string[] = [];
  for (const row of rows) {
    const facts = openStatus(tx, row.compartments, row.evidence_id, row.status_facts);
    if (facts.status !== "done" || facts.lane !== "transaction" || facts.laneOverride !== undefined) continue;
    const sealed = JSON.parse(
      openedUnder(
        tx.keys,
        row.message_compartments,
        { table: "knowledge.messages", id: row.message_id, column: "facts_enc" },
        row.message_facts,
      ),
    ) as { chars?: unknown };
    chars += typeof sealed.chars === "number" ? sealed.chars : 0;
    chosen.push(row.evidence_id);
  }
  if (options.dryRun) return { selected: chosen.length, chars, rerouted: 0 };
  const rerouted = await waitToReplay(tx, chosen, { rerouted: true });
  return { selected: chosen.length, chars, rerouted };
}

// `pia extract item --message ID`, one message's extraction as ids, codes and
// counts: its status row's lane, status, code, generation and the owner's marks; what triage reads
// of it, as flags; the decide model's `human_written`, as a number, when a saved call of the triage point's
// current prompt on the message's current revision holds one; and its claims by type and its unmapped claims by reason. No text and
// no name. Null for an id that names no message.
export type ItemView = {
  message: string;
  evidence: string;
  status: {
    lane: TriageLane;
    laneOverride: TriageLane | null;
    override: boolean;
    status: PipelineStatus;
    code: PipelineCode | null;
    generation: number;
    waiting: boolean;
    attempts: number;
  } | null;
  triage: MessageTriageRow;
  humanWritten: number | null;
  claims: Record<string, number>;
  unmapped: Record<string, number>;
};

export async function itemView(tx: Tx, messageId: string): Promise<ItemView | null> {
  const item = await evidenceOfMessage(tx, messageId);
  if (item === undefined) return null;
  const triage = await triageRowOf(tx, item.evidence_id);
  if (triage === null) return null;
  const [row] = await tx.query<StatusRow>(
    "select evidence_id, compartments, facts_enc, extractor_generation, waiting from vault.pipeline_items where evidence_id = $1",
    [item.evidence_id],
  );
  const facts = row === undefined ? undefined : openStatus(tx, row.compartments, row.evidence_id, row.facts_enc);
  let humanWritten: number | null = null;
  const prompt = TRIAGE_POINT.prompts?.[0];
  if (prompt !== undefined) {
    const [call] = await tx.query<{ id: string; compartments: string[]; output_enc: Sealed }>(
      `select c.id, c.compartments, c.output_enc from vault.model_calls c join vault.evidence_items e on e.id = c.evidence_id and e.revision = c.revision
       where c.evidence_id = $1 and c.prompt_id = $2 and c.prompt_version = $3 and c.superseded_at is null order by c.created_at desc, c.id limit 1`,
      [item.evidence_id, prompt.id, prompt.version],
    );
    if (call !== undefined) {
      try {
        const p = (
          JSON.parse(open(tx.keys, call, "vault.model_calls.output_enc", "throw")) as { human_written?: unknown }
        ).human_written;
        if (typeof p === "number" && p >= 0 && p <= 1) humanWritten = p;
      } catch {
        // A saved answer that is not JSON gave no number.
      }
    }
  }
  const claims: Record<string, number> = {};
  for (const one of await tx.query<{ type: string; n: number }>(
    "select type, count(*)::int as n from knowledge.claims where evidence_id = $1 group by type order by type",
    [item.evidence_id],
  ))
    claims[one.type] = one.n;
  const unmapped: Record<string, number> = {};
  for (const one of await tx.query<{ id: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, compartments, facts_enc from vault.unmapped_claims where evidence_id = $1",
    [item.evidence_id],
  )) {
    const { reason } = JSON.parse(open(tx.keys, one, "vault.unmapped_claims.facts_enc", "throw")) as { reason: string };
    unmapped[reason] = (unmapped[reason] ?? 0) + 1;
  }
  return {
    message: messageId,
    evidence: item.evidence_id,
    status:
      row === undefined || facts === undefined
        ? null
        : {
            lane: facts.lane,
            laneOverride: facts.laneOverride ?? null,
            override: facts.override,
            status: facts.status,
            code: facts.code ?? null,
            generation: row.extractor_generation,
            waiting: row.waiting,
            attempts: facts.attempts,
          },
    triage,
    humanWritten,
    claims,
    unmapped,
  };
}

// `transaction` and `skip` are no, since the decide model lanes an item so when human_written is under the line. The
// decide model laned it only where triage's line 5 decided: an inbound message with text, no lane the owner had set, a
// saved call of the point's current prompt answering human_written, and the lane's rung 1 not suspended. Any other lane,
// and an item rung 0 laned (outbound, no text), writes none.
const LANE_VERDICTS: Partial<Record<TriageLane, "yes" | "no">> = {
  correspondence: "yes",
  transaction: "no",
  skip: "no",
};
const TRIAGE_POINT = currentDefinition("extract_triage");

async function laneVerdict(
  tx: Tx,
  item: { evidenceId: string; facts: StatusFacts | undefined } | undefined,
  lane: TriageLane,
): Promise<void> {
  const verdict = LANE_VERDICTS[lane];
  const prompt = TRIAGE_POINT.prompts?.[0];
  if (item === undefined || verdict === undefined || prompt === undefined || item.facts?.laneOverride !== undefined)
    return;
  const row = await triageRowOf(tx, item.evidenceId);
  if (row === null || row.direction !== "inbound" || row.unreadable || row.chars === 0) return;
  const [suspended] = await tx.query<{ id: string }>(
    "select id from policy.rung_suspensions where point = $1 and version = $2 and lifted_at is null",
    [TRIAGE_POINT.id, TRIAGE_POINT.version],
  );
  if (suspended !== undefined) return;
  const [call] = await tx.query<{ id: string; compartments: string[]; output_enc: Sealed }>(
    "select id, compartments, output_enc from vault.model_calls where evidence_id = $1 and prompt_id = $2 and prompt_version = $3 and superseded_at is null order by created_at desc, id limit 1",
    [item.evidenceId, prompt.id, prompt.version],
  );
  if (call === undefined) return;
  let p: unknown;
  try {
    p = (JSON.parse(open(tx.keys, call, "vault.model_calls.output_enc", "throw")) as { human_written?: unknown })
      .human_written;
  } catch {
    return;
  }
  if (typeof p !== "number" || !(p >= 0 && p <= 1)) return;
  await lockRows(tx.query, []);
  // The retry's own clock: its other rows are stamped by the database's now() in this transaction.
  const { now } = (await tx.query<{ now: Date }>("select now() as now"))[0] as { now: Date };
  await writeVerdict(
    tx.query,
    tx.keys,
    {
      point: TRIAGE_POINT.id,
      version: TRIAGE_POINT.version,
      callId: call.id,
      evidenceId: item.evidenceId,
      source: "lane_retry",
      verdict,
      p,
      band: bandOf(p),
      weight: 1,
      hurried: false,
      deliberate: true,
      compartments: call.compartments,
      requestId: `lane_${randomBytes(12).toString("base64url")}`,
    },
    now,
  );
}

// The message row and then the evidence row are locked before anything is written and before
// `recordRelease` takes the shared taint lock, the order that spec gives the owner's release, so a
// holder of the taint lock alone, which locks those rows first, never waits on this one.
export async function release(tx: Tx, messageId: string, options: { requestId: string; now: Date }): Promise<void> {
  await tryExtractLock(tx);
  const [message] = await tx.query<{ evidence_id: string; compartments: string[] }>(
    "select evidence_id, compartments from knowledge.messages where id = $1 for update",
    [messageId],
  );
  if (message !== undefined)
    await tx.query("select 1 from vault.evidence_items where id = $1 for share", [message.evidence_id]);
  const found =
    message === undefined
      ? undefined
      : (await statusRows(tx)).find(({ row }) => row.evidence_id === message.evidence_id);
  if (message === undefined || found === undefined || found.facts.status !== "withheld")
    throw new AdminError("not_found");
  const { code: _code, ...facts } = found.facts;
  await writeStatus(tx, message.evidence_id, message.compartments, { ...facts, override: true, status: "waiting" });
  await recordRelease(tx.query, messageId as MessageId, {
    requestId: options.requestId,
    batch: false,
    now: options.now,
  });
}

// It writes one `release` decision, with a request id of this call's own, as `releaseHeld` does.
export function releaseItem(tx: TxAt, messageId: string): Promise<void> {
  const requestId = `${randomBytes(12).toString("base64url")}_${messageId.slice(4)}`;
  return release(tx, messageId, { requestId, now: tx.now });
}
