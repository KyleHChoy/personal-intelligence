import type { EvidenceId, Timestamp } from "@intelligence/contracts";
import {
  type DueCapture,
  type DueCursor,
  type DueDocument,
  type DueItem,
  RunCounts,
  type RunSummary,
} from "@intelligence/contracts/personal";
import { needQuestions } from "@intelligence/personal-beliefs";
import { ModelClientError } from "@intelligence/personal-models";
import { processBlockDay } from "./activity.ts";
import { screenBacklog } from "./backlog.ts";
import { type CaptureRef, EXTRACT_GENERATION, type ExtractDeps } from "./config.ts";
import { DEFAULT_THRESHOLDS } from "./decision-points.ts";
import { DOCUMENT_SETTLE_MS, processDocument } from "./documents.ts";
import { budgetCode, type ExtractOutcome, OpenFailed, type Stopped, StoppedAfter, statusOf } from "./item-ends.ts";
import { processMeeting } from "./meetings.ts";
import { MOMENT_SETTLE_MS, processMoments } from "./moments.ts";
import { processItem } from "./process-item.ts";
import { screenRecoveryBacklog } from "./recovery.ts";

// One run of `pi extract`: due items fifty at a time, newest first, one at a time, until a cause stops the run
// (none due, a budget, a refusal or an outage); then the meetings, the same way; then, when the owner has
// switched documents on and no message is due, the settled documents, under the same budgets; then the settled
// moment groups, last; then, whatever stopped it, the need questions, the settlement cards and the steps
// after; then, last, the run's row and its one log line. The proposal wake's run takes the first kind's agent
// records alone, then finishes as any run; `pi extract --capture` (`runCapture`) takes one named meeting, or
// the group that holds one named moment, alone, the same way.

const PAGE = 50;
const UNAVAILABLE_IN_A_ROW = 5;
// Past this many item-level refusals the request shape itself is wrong, so the run stops.
const ITEM_REFUSALS = 5;

const zero = (): RunCounts => RunCounts.parse(Object.fromEntries(Object.keys(RunCounts.shape).map((key) => [key, 0])));

// A log line's counts, under the logger's snake-case keys.
export const snake = (counts: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );

// One kind of due item: its pages, where a page ends, and how one is processed. A moment group
// is one due entry whose processing ends several items, one outcome each.
type DueEntry = {
  evidenceId: EvidenceId;
  regenerated?: true | undefined;
  moments?: { evidenceId: EvidenceId }[] | undefined;
};
type Lane<Due extends DueEntry, After> = {
  page(after: After | undefined): Promise<Due[]>;
  cursor(due: Due): After;
  process(due: Due): Promise<ExtractOutcome | ExtractOutcome[]>;
};

// Each outcome into the run's counts.
function tally(counts: RunCounts, outcomes: ExtractOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.status !== "gone" && outcome.status !== "superseded" && outcome.status !== "held")
      counts[outcome.status] += 1;
    counts.claims += outcome.claims;
    counts.unmapped += outcome.unmapped;
    counts.unresolved += outcome.unresolved;
    if (outcome.live) counts.liveCalls += 1;
  }
}

// What carries over from one kind to the next: the items the model was away for, by due entry, and
// the item-level refusals, each the run's own count.
type Streaks = { away: EvidenceId[][]; refusals: number };

// What a run's lanes share: whether it took an item due by a generation change, and the carry-over
// gate's hold, with the items it left for it.
type Seen = { regenerated: boolean; hold?: boolean; held?: number };

// Every due item of one kind, until a cause stops the run. `seen.regenerated` is set when the run
// takes an item due by a generation change. While the gate holds, such an item is passed over and
// keeps its claims; every other item is taken as ever.
async function untilStopped<Due extends DueEntry, After>(
  lane: Lane<Due, After>,
  deps: ExtractDeps,
  counts: RunCounts,
  streaks: Streaks,
  seen: Seen,
): Promise<Stopped> {
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const taken = new Set<EvidenceId>();
  let storeFailures = 0;
  let after: After | undefined;
  const storeFailed = (): boolean => (storeFailures += 1) >= 2;

  for (;;) {
    let page: Due[];
    try {
      page = await lane.page(after);
    } catch {
      if (storeFailed()) return { code: "store_unavailable" };
      continue;
    }
    storeFailures = 0;
    if (page.length === 0) return { code: "ok" };
    for (const due of page) {
      after = lane.cursor(due);
      if (taken.has(due.evidenceId)) continue;
      taken.add(due.evidenceId);
      if (due.regenerated === true && seen.hold === true) {
        seen.held = (seen.held ?? 0) + 1;
        continue;
      }
      if (due.regenerated === true) seen.regenerated = true;
      let outcomes: ExtractOutcome[];
      try {
        const processed = await lane.process(due);
        outcomes = Array.isArray(processed) ? processed : [processed];
      } catch (thrown) {
        // What a moment group committed before a budget or a refusal stopped it.
        let error = thrown;
        if (error instanceof StoppedAfter) {
          tally(counts, error.outcomes);
          error = error.reason;
        }
        if (error instanceof OpenFailed) {
          if (storeFailed()) return { code: "store_unavailable" };
          continue;
        }
        const budget = budgetCode(error);
        if (budget !== undefined) return { code: budget };
        if (error instanceof ModelClientError && error.code === "refused") {
          const status = statusOf(error);
          return { code: "model_refused", ...(status === undefined ? {} : { status }) };
        }
        return { code: "store_unavailable" };
      }
      storeFailures = 0;
      tally(counts, outcomes);
      // The streaks count due entries: a moment group's one request is one, whatever it holds.
      const refused = outcomes.find((outcome) => outcome.code === "model_refused_item");
      if (refused !== undefined && (streaks.refusals += 1) >= ITEM_REFUSALS)
        return { code: "model_refused", ...(refused.refusal === undefined ? {} : { status: refused.refusal }) };
      if (outcomes.some((outcome) => outcome.code === "model_unavailable")) {
        streaks.away.push(due.moments?.map((one) => one.evidenceId) ?? [due.evidenceId]);
        if (streaks.away.length >= UNAVAILABLE_IN_A_ROW) return { code: "model_unavailable" };
      } else if (outcomes.some((outcome) => outcome.live) && streaks.away.length > 0) {
        try {
          await deps.store.countAttempt(streaks.away.flat(), generation);
        } catch {
          return { code: "store_unavailable" };
        }
        streaks.away = [];
      }
    }
  }
}

// Each stage's duration, for the run's log line alone (not RunCounts, so no
// column): a stage the run did not reach stays 0.
type StageMs = {
  blocks_ms: number;
  mail_ms: number;
  meetings_ms: number;
  documents_ms: number;
  moments_ms: number;
};
const noStages = (): StageMs => ({ blocks_ms: 0, mail_ms: 0, meetings_ms: 0, documents_ms: 0, moments_ms: 0 });

type CaptureCursor = { observedAt: Timestamp; evidenceId: EvidenceId };
const captureCursor = (due: DueCapture): CaptureCursor => ({ observedAt: due.observedAt, evidenceId: due.evidenceId });
type Scope = { compartments?: string[]; only?: EvidenceId };

// The meeting lane.
const meetingLane = (deps: ExtractDeps, generation: number, scope: Scope): Lane<DueCapture, CaptureCursor> => ({
  page: (after) =>
    deps.store.dueCaptures("meeting", PAGE, generation, {
      switchedOn: deps.meetings === true,
      ...scope,
      ...(after === undefined ? {} : { after }),
    }),
  cursor: captureCursor,
  process: (due) => processMeeting(due, deps),
});

// The moment lane. With the lane on, batched by default, the moments pushed by the latest 00:00 or
// 12:00 on the owner's clock; continuous, a group settled once its latest moment is two hours old.
// With the lane off no moment is sent, so batching saves nothing and a moment's link waits for no
// half day: the continuous groups commit each, not_extracted. A moment the owner named (`only`) is a
// group of its own, so it waits for no settle or half day.
function momentLane(deps: ExtractDeps, generation: number, scope: Scope): Lane<DueCapture, CaptureCursor> {
  const now = deps.now();
  const settled = new Date(now.getTime() - MOMENT_SETTLE_MS).toISOString() as Timestamp;
  const mode =
    scope.only !== undefined
      ? { settledBefore: now.toISOString() as Timestamp }
      : deps.momentsContinuous === true || deps.moments !== true
        ? { settledBefore: settled }
        : { batchedAt: now.toISOString() as Timestamp };
  // The moment lane's own model, when the owner set one.
  const momentDeps =
    deps.moment === undefined ? deps : { ...deps, model: deps.moment.model, modelId: deps.moment.modelId };
  return {
    page: (after) =>
      deps.store.dueCaptures("moment", PAGE, generation, {
        switchedOn: deps.moments === true,
        ...mode,
        ...scope,
        ...(after === undefined ? {} : { after }),
      }),
    cursor: captureCursor,
    process: (due) => processMoments(due, momentDeps),
  };
}

// `pi extract --capture`: the named item's lane, holding that item alone.
const captureLane = (deps: ExtractDeps, capture: CaptureRef): Lane<DueCapture, CaptureCursor> => {
  const scope = {
    ...(deps.compartments === undefined ? {} : { compartments: deps.compartments }),
    only: capture.evidenceId,
  };
  return (capture.kind === "meeting" ? meetingLane : momentLane)(deps, deps.generation ?? EXTRACT_GENERATION, scope);
};

// The carry-over gate, asked once before the run takes anything: whether the run's generation would
// leave more of the owner's rulings with no carry by code than the owner allows. A gate that cannot
// be read holds, the safer state. What is held is only an item due again by the change of
// generation: its claims, and the rulings on them, stay.
async function gateHolds(deps: ExtractDeps): Promise<boolean> {
  const generation = deps.generation ?? EXTRACT_GENERATION;
  try {
    const gate = await deps.store.carryGate(generation);
    if (gate.refused)
      deps.log.warn({
        event: "carry_gate_refused",
        counts: { generation, unanchored: gate.unanchored, detached: gate.detached, max: gate.max },
      });
    return gate.refused;
  } catch {
    deps.log.error({ event: "carry_gate_failed", code: "unavailable" });
    return true;
  }
}

async function itemsUntilStopped(deps: ExtractDeps, counts: RunCounts, seen: Seen, stages: StageMs): Promise<Stopped> {
  const timed = async (stage: keyof StageMs, run: () => Promise<Stopped>): Promise<Stopped> => {
    const from = deps.now().getTime();
    try {
      return await run();
    } finally {
      stages[stage] = Math.max(0, deps.now().getTime() - from);
    }
  };
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const settledBefore = new Date(deps.now().getTime() - DOCUMENT_SETTLE_MS).toISOString() as Timestamp;
  const compartments = deps.compartments === undefined ? {} : { compartments: deps.compartments };
  const streaks: Streaks = { away: [], refusals: 0 };
  const capture = deps.capture;
  if (capture !== undefined)
    return timed(capture.kind === "meeting" ? "meetings_ms" : "moments_ms", () =>
      untilStopped(captureLane(deps, capture), deps, counts, streaks, seen),
    );
  if (deps.agentRecords !== true) {
    const blocks = await timed("blocks_ms", () =>
      untilStopped<DueCapture, { observedAt: Timestamp; evidenceId: EvidenceId }>(
        {
          page: (after) =>
            deps.store.dueCaptures("block", PAGE, generation, {
              switchedOn: false,
              ...compartments,
              ...(after === undefined ? {} : { after }),
            }),
          cursor: (due) => ({ observedAt: due.observedAt, evidenceId: due.evidenceId }),
          process: (due) => processBlockDay(due, deps),
        },
        deps,
        counts,
        streaks,
        seen,
      ),
    );
    if (blocks.code !== "ok") return blocks;
  }
  const messages = await timed("mail_ms", () =>
    untilStopped<DueItem, DueCursor>(
      {
        page: (after) =>
          deps.store.due(PAGE, generation, {
            ...compartments,
            ...(after === undefined ? {} : { after }),
            ...(deps.agentRecords === true ? { agentRecords: true as const } : {}),
          }),
        cursor: (due) => ({
          sentAt: due.sentAt,
          evidenceId: due.evidenceId,
          ...(due.source === "email" ? { triage: due.triage } : {}),
        }),
        process: (due) => processItem(due, deps),
      },
      deps,
      counts,
      streaks,
      seen,
    ),
  );
  if (messages.code !== "ok" || deps.agentRecords === true) return messages;
  const meetings = await timed("meetings_ms", () =>
    untilStopped(meetingLane(deps, generation, compartments), deps, counts, streaks, seen),
  );
  if (meetings.code !== "ok") return meetings;
  const documents =
    deps.documents === undefined
      ? ({ code: "ok" } as Stopped)
      : await timed("documents_ms", () =>
          untilStopped<DueDocument, { modifiedAt: Timestamp; evidenceId: EvidenceId }>(
            {
              page: (after) =>
                deps.store.dueDocuments(PAGE, generation, {
                  ...compartments,
                  settledBefore,
                  ...(after === undefined ? {} : { after }),
                }),
              cursor: (due) => ({ modifiedAt: due.modifiedAt, evidenceId: due.evidenceId }),
              process: (due) => processDocument(due, deps),
            },
            deps,
            counts,
            streaks,
            seen,
          ),
        );
  if (documents.code !== "ok") return documents;
  return timed("moments_ms", () =>
    untilStopped(momentLane(deps, generation, compartments), deps, counts, streaks, seen),
  );
}

// Beside the items, each run: the owner's needs asked as questions and the held-back settlement
// cards. A failure of either raises none;
// the next run raises them. The reasoner's wakes come from the trigger log (ledger.state_wakes),
// which the after-commit diff writes.
async function besideBeliefs(deps: Pick<ExtractDeps, "store" | "now" | "log">): Promise<void> {
  await survived(deps.log, { event: "need_questions_failed" }, async () =>
    deps.store.raiseNeedQuestions(needQuestions(await deps.store.beliefClaims(), deps.now().toISOString())),
  );
  await survived(deps.log, { event: "settled_claims_failed" }, () => deps.store.raiseSettledClaims());
}

// A step the run survives: its failure is logged under its event, and the run goes on.
async function survived(
  log: ExtractDeps["log"],
  failed: { event: string },
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch {
    log.error({ ...failed, code: "unavailable" });
  }
}

// After the items, the days of each label of warmth's inputs the store's cadence finds due;
// the store logs each label built.
const warmthAfter = (deps: Pick<ExtractDeps, "store" | "log">): Promise<void> =>
  survived(deps.log, { event: "warmth_failed" }, () => deps.store.buildWarmth());

// After the items and before the diff, under the extract lock and never in a reply's path: the
// relation step over the claims the pending rechecks name and those an earlier run left unjudged
// (on a failure the claims wait for the next run); the daily time proposals, on a whole run alone,
// never a wake's or one capture's (on a failure the pass is unfinished, so the next run takes it
// up); then one pass of the after-commit diff, whose owed rechecks become trigger rows, so a
// wake's commits raise at once (on a failure the rechecks stay for the next run); then warmth; then
// the warmth lanes' gap flags, from the days just built (on a failure the next run's pass takes them up).
async function stepsAfter(deps: ExtractDeps): Promise<void> {
  const { relations, timeProposals, gapLanes } = deps;
  if (relations !== undefined) await survived(deps.log, { event: "relation_step_failed" }, relations);
  if (timeProposals !== undefined && deps.agentRecords !== true && deps.capture === undefined)
    await survived(deps.log, { event: "time_pass_failed" }, timeProposals);
  await survived(deps.log, { event: "trigger_pass_failed" }, () => deps.store.triggerPass());
  await warmthAfter(deps);
  if (gapLanes !== undefined) await survived(deps.log, { event: "gap_lanes_failed" }, gapLanes);
}

export const runExtraction = (deps: ExtractDeps): Promise<RunSummary | "already_running"> =>
  deps.store.withExtractLock(() => runLocked(deps));

// `pi extract --capture`: one run of the named meeting or moment alone, under the lock. Not due
// (done, held, withheld, gone, outside the run's compartments, or skipped with its lane off) it is
// `not_due`, with no row and no line: only `pi extract retry --capture`, as pi_admin, deletes its
// saved call and sets it waiting, and this role may do neither.
export function runCapture(
  deps: ExtractDeps,
  capture: CaptureRef,
): Promise<RunSummary | "already_running" | "not_due"> {
  const scoped: ExtractDeps = { ...deps, capture };
  return deps.store.withExtractLock(async () =>
    (await captureLane(scoped, capture).page(undefined)).length === 0 ? "not_due" : runLocked(scoped),
  );
}

// One run, its caller holding the extract lock.
async function runLocked(deps: ExtractDeps): Promise<RunSummary> {
  // First, the items the vendor failed whose retry has come due wait again, so this run takes them.
  // A failure here is logged and the run goes on: they wait for the next.
  await survived(deps.log, { event: "extract_retries_failed" }, async () => {
    const { requeued } = await deps.store.requeueRetries();
    if (requeued > 0) deps.log.info({ event: "extract_retries_requeued", counts: { requeued } });
  });
  const counts = zero();
  const seen: Seen = { regenerated: false, hold: await gateHolds(deps) };
  const stages = noStages();
  // With the decide model on, the screen backlog first; a refusal, a budget or a down store ends the run
  // there. Before it, the recovery backlog. The backlogs take items at the run's generation only, so none of
  // their items is regenerated.
  const stopped =
    (deps.decideModel === undefined || deps.agentRecords === true || deps.capture !== undefined
      ? undefined
      : ((await screenRecoveryBacklog(deps, counts)) ?? (await screenBacklog(deps, counts)))) ??
    (await itemsUntilStopped(deps, counts, seen, stages));
  let code = stopped.code;
  if ((seen.held ?? 0) > 0) deps.log.info({ event: "carry_gate_items_held", counts: { held: seen.held ?? 0 } });
  if (code !== "store_unavailable") {
    await besideBeliefs(deps);
    await stepsAfter(deps);
    try {
      await deps.store.recordRun({
        code,
        counts,
        ...(deps.decideModel === undefined ? {} : { thresholds: (deps.thresholds ?? DEFAULT_THRESHOLDS).applied }),
      });
    } catch {
      code = "store_unavailable";
    }
  }
  // The refusal's status, while it is still what ended the run.
  const status = code === "model_refused" && stopped.status !== undefined ? { status: stopped.status } : {};
  deps.log[code === "store_unavailable" ? "error" : "info"]({
    event: "extract_run",
    code,
    ...status,
    ...(deps.agentRecords === true
      ? { source: "wake" as const }
      : deps.capture !== undefined
        ? { source: "capture" as const }
        : {}),
    counts: { ...snake(counts), ...stages },
  });
  return { code, ...status, counts };
}

// `pi extract age`, under the extract lock: no item is read and no model is called. A status moves
// with the clock when a belief is computed at read, so it rebuilds nothing: the warmth due alone. Its
// counts are a run's, with zero items, in a row and one log line of their own.
export async function runAgeing(
  deps: Pick<ExtractDeps, "store" | "log" | "now">,
): Promise<RunSummary | "already_running"> {
  return deps.store.withExtractLock(async () => {
    const counts = zero();
    await warmthAfter(deps);
    let code: RunSummary["code"] = "ok";
    try {
      await deps.store.recordRun({ code, counts });
    } catch {
      code = "store_unavailable";
    }
    deps.log[code === "store_unavailable" ? "error" : "info"]({ event: "extract_age", code, counts: snake(counts) });
    return { code, counts };
  });
}
