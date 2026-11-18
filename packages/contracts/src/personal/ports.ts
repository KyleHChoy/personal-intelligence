import type { BeliefStatus } from "../belief.ts";
import type { DateOnly, EvidenceId, Timestamp } from "../ids.ts";
import type { HumanDecision } from "../knowledge.ts";
import type { ModelCallStore } from "../ports.ts";
import type {
  BacklogItem,
  BeliefClaim,
  ClaimRecord,
  DueCapture,
  DueDocument,
  DueItem,
  EmailDueItem,
  MessageTriageRow,
  PipelineCode,
  RunSummary,
  TriageLane,
} from "./extraction.ts";
import type { ExtractionCommit, ModelUsageEvent } from "./extraction-commit.ts";
import type {
  LinkContext,
  OpenedBlockDay,
  OpenedCapture,
  OpenedItem,
  OpenedMoment,
  OpenedRecord,
} from "./extraction-opened.ts";
import type { FactGrouping, FactRulingVerdict, GroupingMode } from "./knowledge-model.ts";
import type { UsageLane } from "./log-event.ts";
import type { BeliefRelation, RelationSwitchRow } from "./relations.ts";

// A page's last item, as the due order reads it: its lane comes from its own triage row, so a
// cursor whose item is gone keeps its place. An agent record's has no triage row: it ranks with
// the rest.
export type DueCursor = { sentAt: DueItem["sentAt"]; evidenceId: DueItem["evidenceId"]; triage?: MessageTriageRow };

// What the extraction pipeline reads and writes through, implemented by the store's Pipeline (role
// pi_pipeline). Every method that writes rejects "unavailable" once the extract lock's connection
// is lost. A granted threshold as a run reads it, the latest unrevoked grant of its point, version
// and name; and a suspended rung 1. Ids, words and numbers.
export type ThresholdGrant = {
  id: string;
  point: string;
  version: number;
  name: string;
  value: number;
  source: "proposal" | "set";
};
type RungSuspension = { point: string; version: number };

// `factKeyFp` is its stored keyed fingerprint. `belief` is its fact key's belief built for the writing
// client's audience, with its status and its latest supporting claim (by valid_from, then id; null when none
// opens), or null when there is none. `rejected` when a reject ruling in force names it.
export type RestatementCandidate = {
  record: ClaimRecord;
  factKeyFp: string;
  reached: "read" | "held";
  belief: { status: BeliefStatus; latest: ClaimRecord | null } | null;
  rejected: boolean;
};

// The store of `completeKeyedWithReplay`, for a call that is not about one evidence item (a
// candidate pair, a draft). Its key names the point and the subject, a word built by code from ids
// and keyed fingerprints. `refs` are the ids and fingerprints the input rested on, and
// `compartments` the union of every label it read. No rendered input is passed or kept.
export type KeyedCallKey = {
  point: string;
  version: number;
  promptId: string;
  promptVersion: string;
  subject: string;
  inputHash: string;
};
export type KeyedCallRecord = {
  key: KeyedCallKey;
  rawOutput: string;
  outputHash: string;
  refs: string[];
  compartments: string[];
  modelId: string;
};
export type KeyedCallStore = {
  find(key: KeyedCallKey): Promise<KeyedCallRecord | null>;
  save(record: KeyedCallRecord): Promise<void>;
};

// A retire in force, `pi self retire`'s ruling on a fact key: the fact was true and is past, until
// the owner states it again. `compartments` are those an audience must hold for it to count, as a
// fact veto's.
// The owner's reopen of a commitment, which counts as confirming it: `at` the reopen's time and
// `compartments` the label an audience must hold for it to count.
export type CommitmentReopen = { factKeyFp: string; at: Timestamp; compartments: string[] };

export type FactRetirement = { id: string; factKeyFp: string; at: Timestamp; compartments: string[] };

// `compartments` are those an audience must hold for it to count, as a fact veto's.
export type FactReclassification = {
  id: string;
  factKeyFp: string;
  verdict: "domain" | "kind";
  value: string;
  at: Timestamp;
  compartments: string[];
};

// `compartments` are the union of the two keys' claims', those an audience must hold for it to
// count.
export type FactRuling = {
  id: string;
  verdict: FactRulingVerdict;
  a: string;
  b: string;
  at: Timestamp;
  compartments: string[];
};

// One pass of the after-commit diff: the fact keys it computed and the rechecks it took, the
// trigger rows it wrote and how many of them raise, the keys it could not compute (their rechecks
// kept for the next pass), and its time. Counts only.
export type TriggerPassSummary = {
  keys: number;
  rechecks: number;
  written: number;
  raised: number;
  failed: number;
  ms: number;
};

export type PersonalPipelineStore = {
  withExtractLock<T>(fn: () => Promise<T>): Promise<T | "already_running">;
  // With `agentRecords`, agent records alone, for the proposal wake's run.
  due(
    limit: number,
    generation: number,
    options?: { compartments?: string[]; after?: DueCursor; agentRecords?: true },
  ): Promise<DueItem[]>;
  // The items the decide model's backlog pass screens (BacklogItem), newest first, at most `limit`. The mark
  // is a saved call of `prompt` for the item's revision, whatever the model: the items without
  // one, or with `saved` (to replay a trial) those with one.
  backlog(
    limit: number,
    generation: number,
    prompt: { promptId: string; promptVersion: string },
    options?: { compartments?: string[]; saved?: boolean },
  ): Promise<BacklogItem[]>;
  // The newest findings done at this generation, untyped and neither waiting nor withheld, with no
  // saved call of the prompt, or with `saved` those with one: the agent lane's trial reads them.
  findingBacklog(
    limit: number,
    generation: number,
    prompt: { promptId: string; promptVersion: string },
    options?: { compartments?: string[]; saved?: boolean },
  ): Promise<Extract<DueItem, { source: "agent_record" }>[]>;
  // The messages with a refused candidate, newest first, at most `limit`, for `pi extract
  // refusals`; and what one call of a prompt has cost on average, null when none has answered.
  refusedItems(limit: number, generation: number, options?: { compartments?: string[] }): Promise<BacklogItem[]>;
  callCost(promptId: string): Promise<number | null>;
  // `projects`: also read the item's projects, which only the mail lane with its switch on uses.
  open(evidenceId: EvidenceId, options?: { projects?: boolean }): Promise<OpenedItem | null>;
  // An agent record; null when the row is gone or is not one.
  openRecord(evidenceId: EvidenceId): Promise<OpenedRecord | null>;
  // Whether documents are taken at all is the caller's (PI_EXTRACT_DOCUMENTS).
  dueDocuments(
    limit: number,
    generation: number,
    options: {
      compartments?: string[];
      settledBefore: Timestamp;
      after?: { modifiedAt: Timestamp; evidenceId: EvidenceId };
    },
  ): Promise<DueDocument[]>;
  openDocument(evidenceId: EvidenceId): Promise<OpenedItem | null>;
  // For `meeting`: evidence rows of source kind `transcript` (a time block never) whose
  // knowledge.captures row the role reads (never a restricted one), due as `due`'s rows are (no
  // status row, waiting, or another generation unless withheld), newest `observedAt` first, the
  // evidence id breaking a tie in byte order; `compartments` keeps only rows whose label is within
  // it, and `after` is the previous page's last item. `switchedOn` is the lane's switch
  // (PI_EXTRACT_MEETINGS): with it false an item committed skipped `not_extracted` at `generation` is
  // not due, and with it true it is due again. For `moment`: rows of source kind `screen_activity`,
  // each due as a meeting is, grouped by code: the moments of one group share the bundle fingerprint,
  // the thread fingerprint (none counts as one value), `local_day` and the label, at most
  // MOMENT_GROUP_MAX of them, earliest first, chunked in observed order. A group is due once its
  // latest moment is at or before `settledBefore`, which a moment call requires. Groups come newest
  // latest moment first, the latest's evidence id breaking a tie, and `limit` and `after` count and
  // page groups by it. An agent app's moment is never grouped with another's. `batchedAt`, the moment
  // lane's batched mode: the run's time. The store reads the owner's time zone and takes only moments
  // first pushed at or before the last 00:00 or 12:00 there before it (`momentBatchCutoff`), each
  // group at most MOMENT_BATCH_GROUP_MAX, with no settle: one group per thread, day and label for
  // each half day. `block`: the stored block day splits, due as meetings are, for the activity step;
  // `switchedOn` is false for it, so a split committed not_extracted is not due again until it is set
  // waiting or a new generation runs. `only` (`pi extract --capture`): that one item alone, due as
  // any other; a moment is then a group of its own.
  dueCaptures(
    lane: "meeting" | "moment" | "block",
    limit: number,
    generation: number,
    options: {
      switchedOn: boolean;
      compartments?: string[];
      after?: { observedAt: Timestamp; evidenceId: EvidenceId };
      settledBefore?: Timestamp;
      batchedAt?: Timestamp;
      only?: EvidenceId;
    },
  ): Promise<DueCapture[]>;
  // One meeting opened, with its knowledge.captures row's clear columns and sealed facts;
  // null when the evidence row or its blob is gone, when it is no meeting, or when its capture row
  // is not one the role reads (a restricted label).
  openCapture(evidenceId: EvidenceId): Promise<OpenedCapture | null>;
  // One moment opened, as openCapture opens a meeting; null as it is, or when it is no moment.
  openMoment(evidenceId: EvidenceId, options?: { projects?: boolean }): Promise<OpenedMoment | null>;
  linkContext(evidenceId: EvidenceId): Promise<LinkContext | null>;
  openBlockDay(evidenceId: EvidenceId): Promise<OpenedBlockDay | null>;
  // The saved calls under one model. `members` are the moments a group's call was asked for, its
  // key's first among them; `save` keeps them with the call, in its transaction, so the removal of
  // any one of them removes the call. None for a call of one item.
  calls(modelId: string, members?: EvidenceId[]): ModelCallStore;
  // `lane` is `dream` for `pi dream`'s calls, else `extract`; `spentSince`, extraction's day
  // budget, sums the `extract` lane alone.
  recordUsage(event: ModelUsageEvent, lane?: UsageLane): Promise<void>;
  spentSince(day: DateOnly): Promise<number>;
  // The carry-over gate: how many of the owner's rulings in force `generation` would leave with no
  // carry by code, from stored rows, and whether that is over the owner's line. A run that is
  // refused takes no item due again by a change of generation.
  carryGate(generation: number): Promise<{ refused: boolean; max: number; unanchored: number; detached: number }>;
  spentOnPromptSince(promptId: string, day: DateOnly): Promise<number>;
  // Which hold a line of the owner's is known only by opening them.
  ownLineCandidates(limit: number, options: { compartments?: string[] }): Promise<DueCapture[]>;
  recordRun(run: RunSummary): Promise<void>;
  // None for an item that is no agent record with a body.
  restatementCandidates(
    evidenceId: EvidenceId,
    asked: { claim: ClaimRecord; heldKeys: string[] }[],
  ): Promise<RestatementCandidate[][]>;
  commit(batch: ExtractionCommit): Promise<"committed" | "superseded" | "gone">;
  // The lanes get fingerprints for a filing's `subjectFp` and `speakerFp`, never the key.
  keyFingerprint(key: { kind: "address" | "name"; value: string }): string | null;
  defer(evidenceId: EvidenceId, generation: number, outcome: { code: PipelineCode; lane: TriageLane }): Promise<void>;
  countAttempt(evidenceIds: EvidenceId[], generation: number): Promise<void>;
  // The items that failed because the model vendor was away and whose next automatic retry has
  // come due, set waiting again (personal-core's vendorRetry bounds the tries and spaces them). An
  // item that failed for its content is never one: only the owner's retry runs it again.
  requeueRetries(): Promise<{ requeued: number }>;
  // For one wording of the re-ask, each refusal code's latest re-asks (at most personal-core's
  // REASK_WINDOW, by the item's last commit): how many, and how many left their item a claim. The
  // stop rule reads it before a re-ask is bought.
  reaskRates(wording: string): Promise<{ code: string; asked: number; rescued: number }[]>;
  audiences(): Promise<string[][]>;
  // `retirements`: the retires in force, each a fact key, its time and the compartments an audience must
  // hold; the belief build closes the belief only while no counted claim is dated after `at`.
  // `reclassifications`, the domain and kind rulings in force; `goAt`, the time the first claim with a
  // version 2 fact key was stored (the go), or null before it, which bounds a fact veto carried by a
  // version 1 key: it leaves out a claim dated before it. `factRulings`, the joins and splits in force;
  // `groupings`, the accepted fact_grouping rows; `groupingMode`, the owner's setting.
  beliefDecisions(): Promise<{
    mark: number;
    decisions: HumanDecision[];
    retirements: FactRetirement[];
    reclassifications: FactReclassification[];
    goAt: Timestamp | null;
    reopens?: CommitmentReopen[];
    factRulings?: FactRuling[];
    groupings?: FactGrouping[];
    groupingMode?: GroupingMode;
    // Every relation the Pipeline may read, by claim key, and every relation kind's switch rows.
    relations?: BeliefRelation[];
    switches?: RelationSwitchRow[];
  }>;
  // Every claim of a type that builds a belief, with its origin and its subject's kind, by fact key: an
  // agent record's only when the owner confirmed it, and none a reject in force holds for. The belief rules
  // read the subject's kind.
  beliefClaims(): Promise<{ factKeyFp: string; claims: BeliefClaim[] }[]>;
  // An about_you card for each claim named, in the order given, by system:extract, each the owner's
  // need asked as a question; none for a claim that already has one, and none past the day's cap,
  // counted over every such card of the last 24 hours. How many it raised.
  raiseNeedQuestions(claimIds: string[]): Promise<{ raised: number }>;
  // The card of each settlement the owner reopened, and of the first claim waiting on a card that
  // ended without an answer from the owner. How many it raised.
  raiseSettledClaims(): Promise<{ raised: number }>;
  // The owner's audience: every compartment of the stored claims of a type that builds a belief,
  // sorted, a finding's not yet confirmed included. Empty when there is none.
  ownerAudience(): Promise<string[]>;
  // After a run: each label of warmth's inputs the cadence finds due (never built,
  // emptied by a removal, counted by another rule table or zone, or with changed inputs and not
  // built within ten minutes) counted into days again, each in a transaction of its own under the
  // beliefs lock; reads rank the days at read. `built` and `failed` count labels,
  // `days` the rows written. Optional: the in-memory store builds none.
  buildWarmth(): Promise<{ built: number; failed: number; days: number; ms: number }>;
  secret(name: string): Promise<string | null>;
  // Answers the rows written; rejects "unavailable" on any failure, and then no request may be
  // sent.
  noteExposure(modelId: string, promptId: string, evidenceIds: EvidenceId[]): Promise<number>;
  // In shadow, after a run and on a wake, one pass of the after-commit diff: the rechecks each
  // change wrote in its own transaction, each fact key computed with personal-beliefs' `beliefsFor`
  // under every active audience's clearance that holds its label, and a ledger.trigger_log row for
  // each transition. Optional: the in-memory store has none.
  triggerPass(): Promise<TriggerPassSummary>;
  // The recovery screen's mark (vault.mark_recovery): `recovery_screened_at` always, and the hold
  // when `hold` is true and the owner never released the message. True when it held.
  markRecovery(evidenceId: EvidenceId, hold: boolean): Promise<boolean>;
  // Stored email items, latest revision, not held and never released, with no recovery mark, newest
  // first, at most `limit`.
  recoveryBacklog(limit: number, options?: { compartments?: string[] }): Promise<EmailDueItem[]>;
  // The owner's grants and the suspended rungs, read once a run.
  thresholds(): Promise<ThresholdGrant[]>;
  suspensions(): Promise<RungSuspension[]>;
};
