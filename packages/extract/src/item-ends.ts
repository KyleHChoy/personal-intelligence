import type { EvidenceId } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type ExtractionCommit,
  HttpStatus,
  isCoded,
  type PipelineCode,
  type PipelineStatus,
  type ReaskRecord,
  type RestatementCheck,
  type RetryAsk,
  type RulingId,
  type RunCode,
  type TriageLane,
} from "@intelligence/contracts/personal";
import { type ModelClient, ModelClientError, ModelOutputRejected } from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import type { PersonalUnmapped } from "./check.ts";
import { EXTRACT_GENERATION, type ExtractDeps } from "./config.ts";
import { passesThrough, readStored } from "./interpret.ts";

// How one item ends: what an item ends as, the ends a lane calls, and how an error of a call ends it. Every
// lane reads these, and processItem is one lane among them, so they sit below it.

// `held`: the recovery screen held the message; the item ends with no status row.
export type ExtractOutcome = {
  status: PipelineStatus | "gone" | "superseded" | "held";
  code?: PipelineCode;
  // The vendor's status, for `model_refused_item`.
  refusal?: HttpStatus;
  claims: number;
  unmapped: number;
  unresolved: number;
  live: boolean;
};

// `open` threw. The run counts these: two in a row, with `due`'s, end it `store_unavailable`.
export class OpenFailed extends Error {
  constructor(cause: unknown) {
    super("open_failed", { cause });
    this.name = "OpenFailed";
  }
}

// A lane step's failure, which the lane ends its item by (defer, failedCall, failedPlan). Fields set
// in the body: the box's type stripping refuses parameter properties.
export class StepFailed {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}
export async function step<T>(run: () => Promise<T>): Promise<T | StepFailed> {
  try {
    return await run();
  } catch (error) {
    return new StepFailed(error);
  }
}

// An item opened from the store: any failure of the open is OpenFailed, its cause kept.
export async function opening<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (cause) {
    throw new OpenFailed(cause);
  }
}

// A run-ending error (a budget, a refusal of the key) that a lane
// ending several items met after it had committed some of them: the run counts `outcomes`, then
// acts on `reason` as it would have.
// Fields set in the body, not as parameter properties: the box runs TypeScript by Node's type
// stripping, which refuses parameter properties (tests/structure/strip-types.test.ts).
export class StoppedAfter extends Error {
  readonly outcomes: ExtractOutcome[];
  readonly reason: unknown;
  constructor(outcomes: ExtractOutcome[], reason: unknown) {
    super("stopped_after");
    this.name = "StoppedAfter";
    this.outcomes = outcomes;
    this.reason = reason;
  }
}

// A reached budget's run code, read by shape: `budget_reached`, with `cost_missing` its own.
export const budgetCode = (error: unknown): RunCode | undefined => {
  if (!(error instanceof Error) || !isCoded(error, "budget_reached")) return undefined;
  return (error as { reason?: unknown }).reason === "cost_missing" ? "cost_missing" : "budget";
};

// What ended a run: its code, and for `model_refused` the vendor's status when it gave one.
export type Stopped = { code: RunCode; status?: HttpStatus };

// A client that notes whether the vendor answered: a rejected output is an answer.
export function noting(model: ModelClient): { model: ModelClient; answered(): boolean } {
  let answered = false;
  return {
    answered: () => answered,
    model: {
      async complete(request) {
        try {
          const response = await model.complete(request);
          answered = true;
          return response;
        } catch (error) {
          if (error instanceof ModelOutputRejected) answered = true;
          throw error;
        }
      },
      embed: (request) => model.embed(request),
    },
  };
}

export const none = { claims: 0, unmapped: 0, unresolved: 0 };

// A refused request's status, a fixed code such as http_402, read by shape; never its body.
export const statusOf = (error: unknown): HttpStatus | undefined => {
  const parsed = HttpStatus.safeParse((error as { status?: unknown } | null)?.status);
  return parsed.success ? parsed.data : undefined;
};

// A refusal with one of these is about the item's request, not the key or the account.
const ITEM_REFUSALS: ReadonlySet<string> = new Set(["http_400", "http_413", "http_422"]);
export const itemRefusal = (error: unknown): HttpStatus | undefined => {
  const status = error instanceof ModelClientError && error.code === "refused" ? statusOf(error) : undefined;
  return status !== undefined && ITEM_REFUSALS.has(status) ? status : undefined;
};

// How a backlog pass meets a failed screening call: `skip` leaves the item (a refusal of its
// request, an item that no longer reads, a call the shared checks refuse), a code ends the run (a
// budget, a refusal of the key), and `stop` ends the pass, the item still in the backlog (the
// decide model away, a store error).
function backlogFailure(error: unknown, log: ExtractDeps["log"], evidenceId: EvidenceId): "skip" | "stop" | Stopped {
  const budget = budgetCode(error);
  if (budget !== undefined) return { code: budget };
  const refusal = itemRefusal(error);
  if (refusal !== undefined) {
    log.warn({
      event: "extract_item_failed",
      code: "model_refused_item",
      status: refusal,
      ids: { evidence: evidenceId },
    });
    return "skip";
  }
  if (error instanceof ModelClientError && error.code === "refused") {
    const status = statusOf(error);
    return { code: "model_refused", ...(status === undefined ? {} : { status }) };
  }
  if (error instanceof ExtractFailure) {
    log.warn({ event: "extract_item_failed", code: error.code, ids: { evidence: evidenceId } });
    return "skip";
  }
  return "stop";
}

// One backlog item's screening call, through a decide model noted for the run's live calls: its
// answer, `skip` for an item gone or left, or what the failure does to the pass (backlogFailure).
export async function backlogAsk<T>(
  deps: Pick<ExtractDeps, "store" | "log"> & { decideModel: NonNullable<ExtractDeps["decideModel"]> },
  counts: { liveCalls: number },
  item: { evidenceId: EvidenceId; compartments: readonly string[] },
  ask: (stored: Awaited<ReturnType<typeof readStored>>, model: ModelClient) => Promise<T>,
): Promise<{ answer: T } | "skip" | "stop" | Stopped> {
  const noted = noting(deps.decideModel.model);
  try {
    const opened = await deps.store.open(item.evidenceId);
    if (opened === null) return "skip";
    return { answer: await ask(await readStored(opened, item.compartments), noted.model) };
  } catch (error) {
    return backlogFailure(error, deps.log, item.evidenceId);
  } finally {
    if (noted.answered()) counts.liveCalls += 1;
  }
}

// An agent record's claims carry rung 0's restatement answers. `mentions`: the name mentions no one
// resolved, filed with the commit.
export type Found = {
  claims: ClaimRecord[];
  unmapped: PersonalUnmapped[];
  unresolved: number;
  restatements?: RestatementCheck[];
  mentions?: ExtractionCommit["mentions"];
  repaired?: number;
  reasked?: true;
  reask?: ReaskRecord;
};

// How one item ends, a message's, an agent record's or a document's: its models, each
// noting whether the vendor answered; a defer; and a final status through commit. `more` holds a
// refused request's status, and a document's groups and passages left out.
export function itemEnds(evidenceId: EvidenceId, deps: ExtractDeps) {
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const noted = noting(deps.model);
  const notedDecideModel = deps.decideModel === undefined ? undefined : noting(deps.decideModel.model);
  const live = (): boolean => noted.answered() || (notedDecideModel?.answered() ?? false);

  // The item waits, with an attempt unless the model was simply away. A defer that fails too ends
  // the run, `store_unavailable`: every path here comes after a failure.
  const defer = async (lane: TriageLane, code: PipelineCode, attempt: boolean): Promise<ExtractOutcome> => {
    try {
      await deps.store.defer(evidenceId, generation, { code, lane });
      if (attempt) await deps.store.countAttempt([evidenceId], generation);
    } catch {
      throw new Error("store_unavailable");
    }
    deps.log.warn({ event: "extract_item_failed", code, ids: { evidence: evidenceId } });
    return { status: "waiting", code, ...none, live: live() };
  };

  // A final status, through commit, with no claims when there are none.
  const final = async (
    lane: TriageLane,
    status: ExtractionCommit["status"],
    code?: PipelineCode,
    found: Found = { claims: [], unmapped: [], unresolved: 0 },
    more: {
      refusal?: HttpStatus;
      groups?: number;
      leftOut?: number;
      release?: RulingId;
      keep?: true;
      ownerQuoted?: true;
      ask?: RetryAsk;
    } = {},
  ): Promise<ExtractOutcome> => {
    const { refusal, ...counts } = more;
    let answer: Awaited<ReturnType<typeof deps.store.commit>>;
    try {
      answer = await deps.store.commit({
        evidenceId,
        generation,
        lane,
        status,
        ...(code === undefined ? {} : { code }),
        ...found,
        ...counts,
      });
    } catch {
      return defer(lane, "commit_failed", true);
    }
    if (answer !== "committed") return { status: answer, ...none, live: live() };
    if (status === "failed" && code !== undefined)
      deps.log.warn({
        event: "extract_item_failed",
        code,
        ...(refusal === undefined ? {} : { status: refusal }),
        ids: { evidence: evidenceId },
      });
    return {
      status,
      ...(code === undefined ? {} : { code }),
      ...(refusal === undefined ? {} : { refusal }),
      claims: found.claims.length,
      unmapped: found.unmapped.length,
      unresolved: found.unresolved,
      live: live(),
    };
  };

  return { model: noted.model, decideClient: notedDecideModel?.model, live, defer, final, generation };
}

// The ends of one item, as `itemEnds` makes them.
export type ItemEnds = ReturnType<typeof itemEnds>;

// How an error of reading, screening or interpreting ends the item: a code of its own ends it, the
// model away defers it with no attempt, the run's own errors pass through, and any other error
// defers it with an attempt. A refusal of the item's request fails the item. A path that treats a
// call's own failure otherwise (the intake waits; a re-ask keeps the first answer) tests for it
// before calling this.
export function failedCall(error: unknown, lane: TriageLane, ends: ItemEnds): Promise<ExtractOutcome> {
  if (error instanceof ExtractFailure)
    return ends.final(lane, error.code === "too_long" ? "skipped" : "failed", error.code);
  if (error instanceof ModelClientError && error.code === "unavailable" && !(error instanceof ModelOutputRejected))
    return ends.defer(lane, "model_unavailable", false);
  // Nothing was answered, so nothing was saved: a retry asks again.
  const status = itemRefusal(error);
  if (status !== undefined) return ends.final(lane, "failed", "model_refused_item", undefined, { refusal: status });
  if (passesThrough(error)) throw error;
  // A saved call that failed to save, after the vendor answered, or any other store error on the
  // way.
  return ends.defer(lane, "commit_failed", true);
}

// How an error of reading or planning an item, before any call, ends it: a code of its own fails it,
// and any other waits with an attempt under the code the lane gives.
export function failedPlan(
  error: unknown,
  lane: TriageLane,
  ends: Pick<ItemEnds, "final" | "defer">,
  other: PipelineCode,
): Promise<ExtractOutcome> {
  return error instanceof ExtractFailure ? ends.final(lane, "failed", error.code) : ends.defer(lane, other, true);
}

// A lane given by hand that has no prompt on this path: skipped, as having no text its prompt reads.
export const noPromptHere = (ends: Pick<ItemEnds, "final">): Promise<ExtractOutcome> =>
  ends.final("skip", "skipped", "no_text");
