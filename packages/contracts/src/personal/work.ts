import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { SubjectRef } from "./about.ts";
import { AGENT_MAIL_ARGS, AGENT_MAIL_RESULTS } from "./agent-mail.ts";
import { TYPED_FIELDS } from "./agent-records.ts";
import { AGENT_TIME_ARGS, AGENT_TIME_RESULTS } from "./agent-time.ts";
import { CARD_ATTEMPT_HINTS, CardAttemptAnswer, CardAttemptBrief } from "./card-attempts.ts";
import { CardRelayBrief, RelayCardAnswerArgs, RelayCardAnswerResult } from "./card-relays.ts";
import { RoleName } from "./clients.ts";
import { PersonalCompartment } from "./compartments.ts";
import { BriefRejected } from "./confirm-rates.ts";
import { DREAM_SETTLE_HINTS, DreamFindingBrief, DreamSettle } from "./dream.ts";
import { AffiliationRelation, PreferencePolarity, RelationshipRelation } from "./fact-vocabulary.ts";
import {
  GoalChange,
  GoalProposalStatus,
  GoalTargetProposalStatus,
  goalStatement,
  proposeGoalTargetArgs,
} from "./goal-proposals.ts";
import { IDEA_ARGS, IDEA_RESULTS } from "./ideas.ts";
import {
  AgentRecordId,
  ClientName,
  EntityId,
  EventId,
  GoalId,
  HypothesisId,
  IntentionId,
  MessageId,
  MoveId,
  OpportunityId,
  PersonalEvidenceId,
  RequestId,
  RulingId,
  RunId,
  TestId,
  ULID_PATTERN,
} from "./ids.ts";
import { DecisionPointId } from "./ladder.ts";
import { MEETING_READ_ARGS, MEETING_READ_RESULTS } from "./meeting-read.ts";
import { OpportunityKind, OpportunityStatus } from "./opportunity-words.ts";
import { OwnerQueueBrief } from "./owner-queue.ts";
import { QuestionTried } from "./paid-questions.ts";
import { ConnectionKind } from "./people-ties.ts";
import { ClientRef, DeclineReason, FactKeyFp, parseJsonBody } from "./primitives.ts";
import {
  AreaKey,
  ListProjectsResult,
  PROJECT_ARGS,
  PROJECT_WORK_LISTED,
  ProjectDetailParts,
  ProjectView,
  ProposeProjectResult,
  UpdateProjectResult,
} from "./projects.ts";
import { ReportWrongRelationArgs, ReportWrongRelationResult } from "./relation-reports.ts";
import { ClaimKey } from "./relations.ts";
import { SAME_PERSON_HINTS, SamePersonAnswers, SamePersonBriefPair, SamePersonRefused } from "./same-person.ts";
import { LOOP_TOOL_ARGS, LOOP_TOOL_RESULTS } from "./self-measure.ts";
import { ChangesWaiting } from "./signals.ts";
import { PersonalToolError } from "./tool-errors.ts";
import { PersonalReadTool, type PersonalRunTool, type PersonalWorkTool } from "./tools.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { WEB_REQUEST_MAX } from "./turn.ts";
import { GapMissing } from "./work-fields.ts";
import { ExploreLacks, type ExploreMissing, GapTrigger } from "./work-gaps.ts";
import {
  BRIEF_CHECK_BACK,
  HandOffReason,
  HELD_FIELDS,
  PROGRESS_LINES,
  WorkProgress,
  WorkTrail,
} from "./work-progress.ts";
import { ReportWrongMergeArgs, ReportWrongMergeResult } from "./wrong-merges.ts";

// Durable work: goals, hypotheses, opportunities, moves, intentions and reasoning runs. No shape
// here has a key for a label, a compartment, a reader, a client, a mode, a grant or a destination:
// the provider sets each.

const codePoints = (text: string): number => [...text].length;

// A field of this file that names a stored row takes the row's id alone: no one-time handle is
// issued for one. A ClientRef (owner.ts), a message, an event or an entity named as a ref, still
// takes a handle.
const goal = GoalId;
const hypothesis = HypothesisId;
const opportunity = OpportunityId;
const run = RunId;
const move = MoveId;
const intention = IntentionId;

// An agent record, by the id a fact from it names. Never an About.
export const WorkRef = z.discriminatedUnion("kind", [
  ...ClientRef.options,
  z.strictObject({ kind: z.literal("goal"), id: goal }),
  z.strictObject({ kind: z.literal("hypothesis"), id: hypothesis }),
  z.strictObject({ kind: z.literal("opportunity"), id: opportunity }),
  z.strictObject({ kind: z.literal("agent_record"), id: AgentRecordId }),
]);
export type WorkRef = z.infer<typeof WorkRef>;
// The owner's request in a served basis, the note of the agent that relayed it. Never
// owner-backed, and never a ref a tool takes: propose_opportunity and propose_task write one, from
// a quote (OwnerRequestQuote).
export const OwnerRequestRef = z.strictObject({ kind: z.literal("owner_request"), id: AgentRecordId });
export type OwnerRequestRef = z.infer<typeof OwnerRequestRef>;

// A message, an event, an entity or a goal. A task may also be about the owner (About), still
// read-only; facts about the owner still reach beliefs only through the owner's word.
const TaskAbout = z.discriminatedUnion("kind", [
  ...ClientRef.options,
  z.strictObject({ kind: z.literal("goal"), id: goal }),
]);
// The owner, or what a task may be about.
export const About = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("owner") }), ...TaskAbout.options]);
export type About = z.infer<typeof About>;

// Model-written or agent-written: sealed, served only as an UntrustedString, read by no code
// that decides anything.
export const SUMMARY_MOST = 600;
export const Summary = z.string().refine((text) => codePoints(text) >= 1 && codePoints(text) <= SUMMARY_MOST, {
  message: `1 to ${SUMMARY_MOST} code points`,
});
export type Summary = z.infer<typeof Summary>;

// A proposal's structured details, each the agent's short text, at least one given. Sealed under
// the row's label, rendered on the owner's card by code (each heading a code line, each text an
// agent line), never a claim and never served to another client.
const detailText = z
  .string()
  .refine((text) => codePoints(text.trim()) >= 1 && codePoints(text) <= 500 && !text.includes("\u0000"), {
    message: "1 to 500 code points",
  });
export const PROPOSAL_DETAIL_FIELDS = Object.freeze(["whyNow", "plan", "decisionNeeded", "risks"] as const);
export const ProposalDetails = z
  .strictObject({
    whyNow: detailText.optional(),
    plan: detailText.optional(),
    decisionNeeded: detailText.optional(),
    risks: detailText.optional(),
  })
  .refine((details) => PROPOSAL_DETAIL_FIELDS.some((name) => details[name] !== undefined), {
    message: "at least one of whyNow, plan, decisionNeeded, risks",
  });
export type ProposalDetails = z.infer<typeof ProposalDetails>;

// `belief_changed`: one run for the live belief changes of the reasoner's audience waiting at a
// tick. `idea_pursued` and `lessons_due` are the planner's: the owner's pursue on an idea card, and
// N owner answers since the last lessons run.
export const PersonalWakeSource = z.enum([
  "daily_sweep",
  "calendar",
  "goal_changed",
  "owner_request",
  "commitment_due",
  "belief_changed",
  "idea_pursued",
  "lessons_due",
]);
export type PersonalWakeSource = z.infer<typeof PersonalWakeSource>;

export const HypothesisKind = z.enum(["open_loop", "needs_preparation", "at_risk", "preference"]);
export type HypothesisKind = z.infer<typeof HypothesisKind>;

// The planner's kinds: an idea and a planning lesson (the planner's alone).
const PlannerHypothesisKind = z.enum(["idea", "lesson"]);

// `pursued` and `not_now` are an idea card's answers; its `no` is `rejected`. `retired`, a lesson
// the owner retired; `--lift` writes `confirmed` again.
export const HypothesisStatus = z.enum([
  "open",
  "supported",
  "refuted",
  "asked",
  "confirmed",
  "rejected",
  "expired",
  "withdrawn",
  "pursued",
  "not_now",
  "retired",
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

const TestResult = z.enum(["supports", "refutes", "inconclusive"]);

// owner_question: ask the owner a question that tests a hypothesis; its summary is the question,
// and it rests on that hypothesis. research: a gap in what the system knows, raised by code alone
// as a gap flag. introduction: the owner asking an introducer to introduce them to a person.
// Proposable by an agent, never a task (its plan sends), always a card. The kinds a client or a run
// may propose: every kind but research, which only code raises.
export const ProposableKind = OpportunityKind.exclude(["research"]);
export type ProposableKind = z.infer<typeof ProposableKind>;

export const Stage = z.enum(["investigate", "prepare", "draft", "send", "pay"]);
export type Stage = z.infer<typeof Stage>;

// Read-only, through the system's tools.
export const INTERNAL_STAGES: readonly Stage[] = Object.freeze(["investigate", "prepare"]);

export const STAGE_PLAN: Readonly<Record<OpportunityKind, readonly Stage[]>> = Object.freeze({
  follow_up: Object.freeze(["investigate", "draft", "send"]),
  reply: Object.freeze(["draft", "send"]),
  meeting_prep: Object.freeze(["prepare"]),
  investigate: Object.freeze(["investigate"]),
  goal_step: Object.freeze(["investigate", "prepare"]),
  life_admin: Object.freeze(["investigate", "prepare"]),
  owner_question: Object.freeze(["investigate"]),
  research: Object.freeze(["investigate"]),
  // A draft to the introducer, then its send, both outside stages through the outbound gate, so it
  // is never a task. No investigate stage: the intro_path task that proposes it has done that
  // reading, and policy.intents keeps the kind out, so no agent could clear an internal stage of
  // it.
  introduction: Object.freeze(["draft", "send"]),
} satisfies Record<OpportunityKind, readonly Stage[]>);

// Two tiers of work on one ledger row. A task is read-only work between agents, decided by code
// with no card; an opportunity keeps the owner's go. TASK_KINDS is derived, never listed: every
// kind whose plan holds only internal stages, but owner_question, which asks the owner. That is
// meeting_prep, investigate, goal_step, life_admin and research (goal_step and life_admin
// provisional, the owner's to confirm). A tool's kind can only narrow what work may do; no argument
// names a tier.
export const WorkTier = z.enum(["task", "opportunity"]);
export type WorkTier = z.infer<typeof WorkTier>;
export const TASK_KINDS: readonly OpportunityKind[] = Object.freeze(
  OpportunityKind.options.filter(
    (kind) => kind !== "owner_question" && STAGE_PLAN[kind].every((stage) => INTERNAL_STAGES.includes(stage)),
  ),
);
// The kinds an intent may list, every kind but introduction, so no standing
// mandate decides an introduction and every one is carded. Admitting it is the owner's call.
export const INTENT_KINDS: readonly OpportunityKind[] = Object.freeze(
  OpportunityKind.options.filter((kind) => kind !== "introduction"),
);
// What an agent may propose as a task: every task kind but research, which only code raises.
// An enum of those kinds alone, so the published schema offers no kind a task can never be
// (introduction, owner_question).
export const ProposableTaskKind = ProposableKind.extract(
  ProposableKind.options.filter((kind) => TASK_KINDS.includes(kind)) as [ProposableKind, ...ProposableKind[]],
);
export type ProposableTaskKind = z.infer<typeof ProposableTaskKind>;

// Required on a task.
const ReleaseReason = z.enum(["not_my_role", "blocked", "no_time", "duplicate", "other"]);

// A plan's next stage: the first with no move done.
export const nextStageOf = (kind: OpportunityKind, done: ReadonlySet<string>): Stage | null =>
  STAGE_PLAN[kind].find((stage) => !done.has(stage)) ?? null;

// `outcome_met` and `outcome_not_met`, beside `done`, which keeps meaning the work's own moves are
// finished. Both are closed; only an applied outcome link sets one.

// An opportunity in one of these is open. Every rule that says "open" means this list.
export const OPEN_STATUSES: readonly OpportunityStatus[] = Object.freeze([
  "proposed",
  "later",
  "go",
  "claimed",
  "handed_to_owner",
]);

export const OpportunityDecision = z.enum(["go", "no_go", "later"]);
export type OpportunityDecision = z.infer<typeof OpportunityDecision>;

const HarnessMode = z.enum(["propose", "act_with_check", "act"]);

// Paying is only ever proposed.
export const HarnessModeGrant = z
  .strictObject({ client: ClientName, kind: OpportunityKind, stage: Stage, mode: HarnessMode })
  .refine((grant) => grant.stage !== "pay" || grant.mode === "propose", {
    message: "pay only with propose",
    path: ["mode"],
  });
export type HarnessModeGrant = z.infer<typeof HarnessModeGrant>;

export const IntentMode = z.enum(["owner_decides", "policy_decides"]);
export type IntentMode = z.infer<typeof IntentMode>;

export const MoveStatus = z.enum(["cleared", "done", "failed", "blocked"]);
export type MoveStatus = z.infer<typeof MoveStatus>;

export const IntentionKind = z.enum(["remind", "check_back"]);
export type IntentionKind = z.infer<typeof IntentionKind>;

export const RunOutcome = z.enum(["finished", "failed", "stopped"]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const WorkRunCode = z.enum([
  "turn_limit",
  "tool_limit",
  "bad_output",
  "model_unavailable",
  "context_limit",
  "timeout",
  "kill_switch",
  "erasure",
  "withdrawn",
  "budget",
]);
export type WorkRunCode = z.infer<typeof WorkRunCode>;

const basis = z.array(WorkRef).min(1).max(20);
// propose_opportunity may cite what the owner asked by a short quote; the store
// keeps the quote as the agent's note and cites that note as `owner_request`.
export const OwnerRequestQuote = z.strictObject({
  kind: z.literal("owner_request"),
  quote: z
    .string()
    .refine((value) => codePoints(value.trim()) >= 1 && codePoints(value) <= 500, { message: "1 to 500 code points" }),
});
export type OwnerRequestQuote = z.infer<typeof OwnerRequestQuote>;
const proposeBasis = z
  .array(z.union([WorkRef, OwnerRequestQuote]))
  .min(1)
  .max(20)
  .describe(
    '1 to 20 refs, each {"kind":"message","id":"msg_..."} with an id as a tool gave it, or what the owner said to you, {"kind":"owner_request","quote":"their words"}.',
  );
const probability = z.number().min(0).max(1);

// What work expects, what it watches, and what came of it. Nothing here names a label: an
// expectation and a watch take the opportunity's, and a link the union of its evidence's and the
// opportunity's, each set by the database.

// The outcomes that are not a claim type: a reply from the subject, the meeting taking place, and
// a claim on the work's goal's fact key or its target. Each takes no fields.
export const OUTCOME_EVENTS = Object.freeze(["answered", "meeting_held", "goal_claim"] as const);
// Every kind with typed fields, `status` among them, which is no typed claim's.
const OUTCOME_KINDS = Object.keys(TYPED_FIELDS) as [keyof typeof TYPED_FIELDS, ...(keyof typeof TYPED_FIELDS)[]];
export const OutcomeType = z.union([z.enum(OUTCOME_EVENTS), z.enum(OUTCOME_KINDS)]);
export type OutcomeType = z.infer<typeof OutcomeType>;
const isOutcomeEvent = (type: string): boolean => (OUTCOME_EVENTS as readonly string[]).includes(type);
export const OUTCOME_HORIZON_MOST = 365;
const EXPECTS_MOST = 5;
// A value of an expected outcome: for an outcome event, none; for a claim type, some of that type's
// key and value fields (TYPED_FIELDS), at least one, and none outside them.
function outcomeFieldsValid(type: string, fields: Record<string, unknown>): boolean {
  if (isOutcomeEvent(type)) return Object.keys(fields).length === 0;
  if (!Object.hasOwn(TYPED_FIELDS, type)) return false;
  const schema = TYPED_FIELDS[type as keyof typeof TYPED_FIELDS] as z.ZodObject;
  return Object.keys(fields).length > 0 && schema.partial().safeParse(fields).success;
}
// One expected outcome as an agent states it: who (absent, the work's own subject: what it is
// about, else its goal for `goal_claim`, else whoever its sends go to), the type, the value that
// means success and, for a claim type, optionally the one that means failure, and how many days it
// has. Code checks the fields against the type; the subject is resolved as `about` resolves one.
export const ExpectedOutcome = z
  .strictObject({
    subject: SubjectRef.optional(),
    type: OutcomeType,
    success: z.record(z.string(), z.unknown()),
    failure: z.record(z.string(), z.unknown()).optional(),
    horizonDays: z.number().int().min(1).max(OUTCOME_HORIZON_MOST).optional(),
  })
  .refine((one) => outcomeFieldsValid(one.type, one.success), {
    message: "success holds the type's fields alone",
    path: ["success"],
  })
  .refine(
    (one) => one.failure === undefined || (!isOutcomeEvent(one.type) && outcomeFieldsValid(one.type, one.failure)),
    { message: "failure holds the type's fields alone", path: ["failure"] },
  )
  .refine((one) => one.type !== "goal_claim" || one.subject === undefined, {
    message: "a goal_claim is on the work's own goal",
    path: ["subject"],
  });
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;
const expects = z
  .array(ExpectedOutcome)
  .min(1)
  .max(EXPECTS_MOST)
  .describe(
    "What would mean the work succeeded, 1 to 5: type answered (a reply), meeting_held, goal_claim, or a claim type with some of its fields as success (and failure); subject {id}, {address} or {name}, absent for the work's own; horizonDays. Absent, the kind's default.",
  );

// What work watches. A thread by its fingerprint (and account), a person or organization
// by its id, a document by its id, a calendar series by its fingerprint. `until` is null while the
// work is open, then its close plus the grace period.
const WorkWatchKind = z.enum(["thread", "entity", "document", "series"]);
export const WorkWatch = z.strictObject({
  opportunity: OpportunityId,
  kind: WorkWatchKind,
  key: z.string().min(1).max(64),
  until: Timestamp.nullable(),
});
export type WorkWatch = z.infer<typeof WorkWatch>;
// What plan_move and report_move take to add a watch: cited evidence, a message (its thread) or an
// entity, by id.
export const WatchRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), id: MessageId }),
  z.strictObject({ kind: z.literal("entity"), id: EntityId }),
]);
export type WatchRef = z.infer<typeof WatchRef>;
const watch = z
  .array(WatchRef)
  .min(1)
  .max(10)
  .describe("Evidence to watch for the work's outcome: a message (its thread) or an entity, by id.");

// One outcome link, appended and never edited; a newer link on the same opportunity and
// expectation is what counts. `judge`: `rule`, a model and its prompt version, an agent by its
// client id, or one of the owner's rulings. `attribution`: `caused` when it came on a channel the
// work's own move used, after that move; `observed` otherwise.
export const OutcomeLinkKind = z.enum(["met", "not_met", "partial", "advances"]);
export type OutcomeLinkKind = z.infer<typeof OutcomeLinkKind>;
export const OutcomePath = z.enum(["watched", "open"]);
export type OutcomePath = z.infer<typeof OutcomePath>;
export const OutcomeAttribution = z.enum(["caused", "observed"]);
export type OutcomeAttribution = z.infer<typeof OutcomeAttribution>;
const JUDGE = String.raw`rule|model:[\w./:-]{1,100}@[\w.-]{1,64}(@[1-9]\d{0,3})?|(agent:cli|owner:rul)_${ULID_PATTERN}`;
const OutcomeJudge = z
  .string()
  .max(200)
  .regex(new RegExp(`^(${JUDGE})$`));
export const OutcomeLink = z.strictObject({
  opportunity: OpportunityId,
  goal: GoalId.nullable(),
  evidence: PersonalEvidenceId,
  claimKey: ClaimKey.nullable(),
  kind: OutcomeLinkKind,
  path: OutcomePath,
  judge: OutcomeJudge,
  attribution: OutcomeAttribution,
  // The cited passage, in UTF-16 code units of the evidence's text; none for a rule's link.
  passage: z
    .strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((span) => span.end > span.start, { message: "a span ends after it starts" })
    .nullable(),
  applied: z.boolean(),
  judgedAt: Timestamp,
});
export type OutcomeLink = z.infer<typeof OutcomeLink>;

// The outcome judge's closed answer for one order of an expectation and a passage,
// `personal_outcome_judge@1`: a link kind or `unrelated`, and short phrases copied from the
// passage. Code checks every cite against the passage it sent and reads nothing else of the answer.
const OUTCOME_ANSWERS = Object.freeze(["met", "not_met", "partial", "advances", "unrelated"] as const);
export const OutcomeAnswer = z.strictObject({
  outcome: z.enum(OUTCOME_ANSWERS),
  cites: z
    .array(
      z.strictObject({
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "at most 300 code points" }),
      }),
    )
    .max(6),
});
export type OutcomeAnswer = z.infer<typeof OutcomeAnswer>;

export const ReasoningAction = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("ignore"), reason: z.enum(["nothing_to_do", "below_bar", "waiting_is_better"]) }),
  z.strictObject({ do: z.literal("remind"), about: About, dueAt: Timestamp, summary: Summary, basis }),
  z.strictObject({ do: z.literal("investigate"), kind: HypothesisKind, about: About, summary: Summary, basis }),
  z.strictObject({
    do: z.literal("propose"),
    kind: ProposableKind,
    about: About,
    summary: Summary,
    basis,
    // The index, in this output's actions, of the investigate action whose hypothesis this
    // opportunity follows from (prompt personal_run version 2). finish_run sets the opportunity's
    // hypothesis from it; an index that names no earlier investigate action, or one about the
    // owner, is refused.
    hypothesis: z.number().int().min(0).max(3).optional(),
    dueAt: Timestamp.optional(),
    forecast: z.strictObject({ probability, probabilityIfWaiting: probability }).optional(),
  }),
]);
export type ReasoningAction = z.infer<typeof ReasoningAction>;

// ignore stands alone.
export const ReasoningOutput = z
  .strictObject({ actions: z.array(ReasoningAction).min(1).max(100) })
  .refine((output) => output.actions.length === 1 || output.actions.every((action) => action.do !== "ignore"), {
    message: "ignore stands alone",
  });
export type ReasoningOutput = z.infer<typeof ReasoningOutput>;

// The planner's stages. A run's stage is the prompt it was queued under: a run of
// personal_run is none of them, and answers with ReasoningOutput.
export const PlannerStage = z.enum(["ideas", "translate", "lessons"]);
export type PlannerStage = z.infer<typeof PlannerStage>;
export const STAGE_PROMPT_IDS: Readonly<Record<PlannerStage, string>> = Object.freeze({
  ideas: "personal_ideas",
  translate: "personal_translate",
  lessons: "personal_lessons",
});

// The stage a wake queues: the owner's pursue on an idea queues its translate run, N owner answers
// a lessons run, and every other wake an ideas run.
export const stageOfWake = (source: PersonalWakeSource): PlannerStage =>
  source === "idea_pursued" ? "translate" : source === "lessons_due" ? "lessons" : "ideas";

const text = (most: number) =>
  z.string().refine((value) => codePoints(value.trim()) >= 1 && codePoints(value) <= most, {
    message: `1 to ${most} code points`,
  });

// What an idea is about: the first message, event, person or goal its basis cites, so never the
// owner, and work may rest on it. Null for a basis with none.
export const ideaAbout = (refs: readonly WorkRef[]): About | null => {
  const ref = refs.find(
    (one) => one.kind === "message" || one.kind === "event" || one.kind === "entity" || one.kind === "goal",
  );
  return ref === undefined ? null : (About.parse({ kind: ref.kind, id: ref.id }) as About);
};

// One idea of an ideas run: model-written, sealed as one hypothesis summary, read by no code that
// decides anything. Its basis is what sparked it; code makes it about the first message, event,
// person or goal the basis cites.
export const Idea = z.strictObject({
  idea: text(1000),
  why: text(4000),
  basis,
  confidence: probability,
  test: text(1000),
});
export type Idea = z.infer<typeof Idea>;
// No ideas is an answer: the run records a silence.
export const IdeasOutput = z.strictObject({ ideas: z.array(Idea).max(20) });
export type IdeasOutput = z.infer<typeof IdeasOutput>;

// One planning preference a lessons run proposes, citing the decided cases it learned from. It
// reaches a run only once the owner confirms it on its card. The opportunity kinds and roles a
// lesson is for, each sorted and once, at most 16 roles (the lessons migration's check); an empty
// list is for all.
const sortedOnce = <T extends string>(item: z.ZodType<T>) =>
  z
    .array(item)
    .refine((list) => list.every((one, at) => at === 0 || list[at - 1]! < one), { message: "sorted, each once" });
export const LessonAppliesTo = z.strictObject({
  kinds: sortedOnce(OpportunityKind),
  roles: sortedOnce(RoleName).max(16),
});
export type LessonAppliesTo = z.infer<typeof LessonAppliesTo>;
// A lesson may also cite an owner decision its run was shown in its actions block, by the
// decision's id. Never a ref a tool takes.
const DecisionRef = z.strictObject({ kind: z.literal("decision"), id: RulingId });
const lessonBasis = z
  .array(z.union([WorkRef, DecisionRef]))
  .min(1)
  .max(20);
// `supersedes`: a lesson in force the run was given, which the owner's confirm of this one retires.
export const Lesson = z.strictObject({
  lesson: text(600),
  basis: lessonBasis,
  appliesTo: LessonAppliesTo.optional(),
  supersedes: HypothesisId.optional(),
});
export type Lesson = z.infer<typeof Lesson>;
export const LessonsOutput = z.strictObject({ lessons: z.array(Lesson).max(10) });
export type LessonsOutput = z.infer<typeof LessonsOutput>;

// What finish_run takes: a planner run's actions (personal_run, translate), ideas or lessons.
export const RunOutput = z.union([ReasoningOutput, IdeasOutput, LessonsOutput]);
export type RunOutput = z.infer<typeof RunOutput>;

// How a row ended, on scope closed alone: when, who closed it as the caller may be told (no other
// agent's name), whether a task's report said failed, and the report's words only to a caller whose
// token returns the report and, for another agent's, the finding it cites. Each word is the agent's,
// unchecked.
export const ClosedWork = z.strictObject({
  at: Timestamp,
  by: z.enum(["you", "agent", "owner", "system"]),
  failed: z.literal(true).optional(),
  report: z
    .strictObject({
      summary: UntrustedString.optional(),
      deliverable: UntrustedString.optional(),
      next: UntrustedString.optional(),
      uncertain: UntrustedString.optional(),
      reason: UntrustedString.optional(),
      findings: z.array(AgentRecordId).max(20),
    })
    .optional(),
});
export type ClosedWork = z.infer<typeof ClosedWork>;

// One line of a progress report: 1 to 500 code points, on one line.
const progressLine = z
  .string()
  .refine((value) => codePoints(value.trim()) >= 1 && codePoints(value) <= 500, { message: "1 to 500 code points" })
  .refine((value) => !/[\n\r]/.test(value) && !value.includes("\u0000"), { message: "one line" });

// The most work one task may wait on.
const WORK_BLOCKERS_MOST = 10;

// `stage` is the next stage, `leaseUntil` the caller's own lease. `gap`, what a gap flag finds
// missing; `holder`, on the work board alone, the client that holds a live lease on it.
// `progress`, the latest progress report on it: null, or left out, when it has none.
export const OpportunityView = z.strictObject({
  id: opportunity,
  kind: OpportunityKind,
  status: OpportunityStatus,
  about: About,
  summary: UntrustedString.nullable(),
  basis: z.array(z.union([WorkRef, OwnerRequestRef])),
  hypothesis: hypothesis.nullable(),
  goal: goal.nullable(),
  stage: Stage.nullable(),
  dueAt: Timestamp.nullable(),
  leaseUntil: Timestamp.nullable(),
  tier: WorkTier,
  role: RoleName.nullable(),
  // A commitment_due task's commitment, the fact get_commitments and close_commitment take; what a
  // close_no_tie task asks (GAP_ASK); and an explore task's own list of what is missing.
  gap: z
    .strictObject({
      trigger: GapTrigger,
      missing: GapMissing,
      fact: FactKeyFp.optional(),
      ask: z.string().optional(),
      lacks: ExploreLacks.optional(),
    })
    .optional(),
  holder: ClientName.optional(),
  closed: ClosedWork.optional(),
  progress: WorkProgress.nullable().optional(),
  ...HELD_FIELDS,
  // B5, B6: the project the work belongs to, where the caller sees that project; its parent; and
  // the open work it waits on, which keeps it from being claimed.
  project: EntityId.optional(),
  parent: opportunity.optional(),
  blockedBy: z.array(opportunity).min(1).max(WORK_BLOCKERS_MOST).optional(),
});
export type OpportunityView = z.infer<typeof OpportunityView>;

// What the owner answered on a case's card: an opportunity's go, no_go or later; a question's
// confirm, reject or skip; an idea's pursue, not_now or no.
export const CaseAnswer = z.enum(["go", "no_go", "later", "confirm", "reject", "skip", "pursue", "not_now", "no"]);
export type CaseAnswer = z.infer<typeof CaseAnswer>;

const count = z.number().int().nonnegative();

// What came of a case: an opportunity's moves by their status, a hypothesis's tests by result.
const CaseOutcome = z.strictObject({
  moves: z.strictObject({ done: count, failed: count, blocked: count }),
  tests: z.strictObject({ supports: count, refutes: count, inconclusive: count }),
});

// A case that closed or that the owner decided, of the last 180 days when it shares the run's focus, else
// of the last 30: declined, expired, done, settled by its tests, or answered by the owner. `by` is who
// settled it: the owner answering, a card left to expire, or the system (rung 0, a client's work, a
// test). The optional fields are always set by the store: its summary, untrusted; what the owner answered
// and their note, the note their own words but served as untrusted, since they may quote a source in it;
// and its outcome. `closedAt` is when it closed, or when the owner answered one still open.
export const ClosedCase = z.strictObject({
  rowKind: z.enum(["hypothesis", "opportunity"]),
  kind: z.union([HypothesisKind, PlannerHypothesisKind, OpportunityKind]),
  about: About,
  closedAt: Timestamp,
  by: z.enum(["owner", "expiry", "policy"]),
  id: z.union([hypothesis, opportunity]).optional(),
  status: z.union([HypothesisStatus, OpportunityStatus]).optional(),
  summary: UntrustedString.nullable().optional(),
  decision: CaseAnswer.nullable().optional(),
  note: UntrustedString.nullable().optional(),
  outcome: CaseOutcome.optional(),
  // The reason the owner gave with their no, a code they chose. A run of the reasoner
  // sees it on every case; an agent's brief only on the agent's own work.
  declineReason: DeclineReason.optional(),
});
export type ClosedCase = z.infer<typeof ClosedCase>;

// What a done report of a move needs, by the opportunity's kind and the move's stage.
// `answer_owner_question`: report_move never finishes an owner_question; that tool does.
const DoneRequirement = z.enum(["answer_owner_question", "deliverable", "next", "draft", "sources", "writeback"]);
type DoneRequirement = z.infer<typeof DoneRequirement>;
const DELIVERABLE_KINDS: readonly OpportunityKind[] = [
  "investigate",
  "goal_step",
  "life_admin",
  "meeting_prep",
  "research",
];
export function doneRequires(
  kind: OpportunityKind,
  stage: Stage | null,
  tier: WorkTier = "opportunity",
): DoneRequirement[] {
  if (kind === "owner_question") return ["answer_owner_question"];
  const plan = STAGE_PLAN[kind];
  const draft = plan.indexOf("draft");
  const needs: DoneRequirement[] = DELIVERABLE_KINDS.includes(kind) ? ["deliverable", "next"] : [];
  if (tier === "task" && (stage === null || stage === plan[plan.length - 1])) needs.push("sources", "writeback");
  return draft > 0 && stage !== null && plan[draft - 1] === stage ? [...needs, "draft"] : needs;
}

// A move's report, every text the agent's and sealed with the move. A source or a
// candidate person is a ref the caller can see, or a short name of something outside the owner's
// sources, such as a web page's title or address.
const reportText = z.string().refine((value) => codePoints(value) <= 20_000, { message: "at most 20 000 code points" });
export const ReportSource = z.union([
  WorkRef,
  z
    .string()
    .refine((value) => codePoints(value.trim()) >= 1 && codePoints(value) <= 500, { message: "1 to 500 code points" }),
]);
export type ReportSource = z.infer<typeof ReportSource>;
// What an explore task's research found about its node, each field optional and each citing its
// sources (refs the caller can see, or the addresses of pages it read). An organization by entity
// id, registrable domain or full name; another person or organization in a relation by entity id or
// full name; at most one identifier, an address or a LinkedIn profile URL. The store reads it
// strictly (its rules for an identifier and for a URL) and the claim intake checks every text. On
// report_move's report for an explore task alone. An entity is named by its id, never a handle: the
// store seals the fill as written, so nothing could resolve one later; a handle among its sources
// is answered not_found, as an unknown id is.
const fillText = (most: number) =>
  z
    .string()
    .refine((value) => value.trim() !== "" && codePoints(value) <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });
const fillSources = z.array(ReportSource).min(1).max(20);
const exactlyOneOf =
  (names: readonly string[]) =>
  (value: Record<string, unknown>): boolean =>
    names.filter((name) => value[name] !== undefined).length === 1;
const FillOrganization = z
  .strictObject({ entity: EntityId.optional(), domain: fillText(253).optional(), name: fillText(200).optional() })
  .refine(exactlyOneOf(["entity", "domain", "name"]), { message: "an entity, a domain or a name" });
const FillOther = z
  .strictObject({ entity: EntityId.optional(), name: fillText(200).optional() })
  .refine(exactlyOneOf(["entity", "name"]), { message: "an entity or a name" });
export const Fill = z
  .strictObject({
    identity: z
      .strictObject({ email: fillText(320).optional(), linkedin: fillText(500).optional(), sources: fillSources })
      .refine(exactlyOneOf(["email", "linkedin"]), { message: "an address or a LinkedIn profile" })
      .optional(),
    role: z.strictObject({ title: fillText(200), organization: FillOrganization, sources: fillSources }).optional(),
    affiliation: z
      .strictObject({ organization: FillOrganization, relation: AffiliationRelation, sources: fillSources })
      .optional(),
    domain: z.strictObject({ domain: fillText(253), sources: fillSources }).optional(),
    links: z.strictObject({ urls: z.array(fillText(2000)).min(1).max(5), sources: fillSources }).optional(),
    relations: z
      .array(
        z.strictObject({
          other: FillOther,
          relation: z.union([RelationshipRelation, ConnectionKind]),
          sources: fillSources,
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .refine((fill) => Object.values(fill).some((field) => field !== undefined), { message: "at least one field" });
export type Fill = z.infer<typeof Fill>;
export const MoveReport = z.strictObject({
  deliverable: reportText.optional(),
  sources: z
    .array(ReportSource)
    .max(100)
    .optional()
    .describe('Refs such as {"kind":"agent_record","id":"rec_..."}, or short texts such as a page\'s address.'),
  uncertain: reportText.optional(),
  next: reportText.optional(),
  reason: reportText.optional(),
  draft: reportText.optional(),
  // A progress report's: what is done so far, what the work waits on, and when its holder means
  // to resume. Beside `next`, they are what the outcome progress keeps.
  done: z.array(progressLine).max(PROGRESS_LINES).optional(),
  waitingOn: progressLine.optional(),
  resumeAt: Timestamp.optional(),
  candidates: z.array(ReportSource).max(100).optional(),
  // An explore task's fill; refused on any other task's report.
  samePerson: SamePersonAnswers.optional(),
  settle: DreamSettle.optional(), // settle: a dream_finding task's
  card: CardAttemptAnswer.optional(),
  fill: Fill.optional().describe(
    "An explore task's only, the fields its brief's explore.missing lists, each with sources: identity {email or linkedin}; role {title, organization}; affiliation {organization, relation}; domain {domain}; links {urls}; relations [{other, relation}]. organization is {entity}, {domain} or {name}; other is {entity} or {name}.",
  ),
});
export type MoveReport = z.infer<typeof MoveReport>;

// The missing code each field of a fill fills.
export const FILL_FIELDS = Object.freeze({
  identity: "identity",
  role: "role",
  affiliation: "affiliation",
  domain: "domain",
  links: "links",
  relations: "relations",
} as const satisfies Record<keyof Fill, ExploreMissing>);

export function keptFill(fill: Fill, missing: readonly ExploreMissing[]): { fill: Fill | null; dropped: number } {
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [field, value] of Object.entries(fill)) {
    if (value === undefined) continue;
    if (missing.includes(FILL_FIELDS[field as keyof Fill])) kept[field] = value;
    else dropped += 1;
  }
  return { fill: Object.keys(kept).length === 0 ? null : (kept as Fill), dropped };
}

// A fill as its agent record holds it; the store sets the node, from the task.
export const FillBody = z.strictObject({ v: z.literal(1), node: EntityId, fill: Fill });
export type FillBody = z.infer<typeof FillBody>;
export const parseFillBody = (body: string): FillBody | null => parseJsonBody(FillBody, body);

// Why report_move took no report, each a fixed code the agent acts on.
export const ReportCheckCode = z.enum([
  "ask_owner",
  "needs_deliverable",
  "needs_next",
  "needs_draft",
  "needs_reason",
  "needs_sources",
  "needs_writeback",
  "needs_fill",
  "fill_not_explore",
  "needs_progress",
  "same_person_not_asked",
  "needs_same_person",
  "same_person_no_evidence",
  "card_not_asked",
  "needs_card_answer",
  "card_answer_refused",
  "settle_not_asked",
  "needs_settle",
  "settle_refused",
]);
export type ReportCheckCode = z.infer<typeof ReportCheckCode>;
// The fixed hint sent beside each code of a refused report, naming the fix.
export const REPORT_CHECK_HINTS: Readonly<Record<ReportCheckCode, string>> = Object.freeze({
  ask_owner:
    "An owner_question is finished only by answer_owner_question: ask the owner its question and send their exact words there. Never report it done.",
  needs_deliverable:
    "Put what you produced in report.deliverable: the answer, brief or result your brief's done asks for.",
  needs_next: "Put the next step in report.next: what should happen now, and who should do it.",
  needs_draft: "This stage comes before a draft: put the message text in report.draft.",
  needs_reason: "failed and blocked need report.reason (or a summary): what stopped you, in a sentence or two.",
  needs_sources:
    'report.sources must name at least one source: a ref such as {"kind":"message","id":"msg_..."}, or a short text such as a web page\'s address.',
  // A finding alone; never a proposal made to close the task.
  needs_writeback:
    'A task is done only with a finding: call record with kind finding after you first claimed it, then cite the recordId it answered in report.sources as {"kind":"agent_record","id":"rec_..."}. If you found nothing new worth keeping, report failed with report.reason instead; never propose something to close a task.',
  // An explore task's fill.
  needs_fill:
    "An explore task is done only with report.fill holding at least one field your brief's explore.missing lists, each citing its sources. If you found nothing, report failed with report.reason.",
  fill_not_explore: "Only an explore task's report takes report.fill: remove it.",
  needs_progress:
    "A progress report needs report.done (what is done so far, one short line each) or report.next (what comes next, in one line of at most 500 code points).",
  ...SAME_PERSON_HINTS,
  ...DREAM_SETTLE_HINTS,
  ...CARD_ATTEMPT_HINTS,
});

// What done needs, in words, one line for each requirement doneRequires gives and one for an explore
// task's fill, so a brief says it before a report is refused. Fixed text and code words only.
export const DONE_SAYS: Readonly<Record<DoneRequirement, string>> = Object.freeze({
  answer_owner_question:
    "Ask the owner its summary in your conversation and send their exact words with answer_owner_question; report_move never finishes it.",
  deliverable: "report.deliverable: the answer, brief or result asked for, naming people and things, never ids.",
  next: "report.next: what should happen now, and who should do it.",
  draft: "report.draft: the message text for the next stage.",
  sources: "report.sources: at least one ref or page you read.",
  writeback:
    'A finding you recorded since claiming, cited in report.sources as {"kind":"agent_record","id":"rec_..."}. Nothing new worth keeping: report failed with report.reason.',
});
// A move the caller planned, was cleared and never reported; the tick
// closes it failed once the caller's lease on its opportunity ends.
const UnreportedMove = z.strictObject({ move, opportunity, stage: Stage, say: z.literal("report or release") });

export function doneSays(done: readonly DoneRequirement[], missing?: readonly ExploreMissing[]): string[] {
  const fill =
    missing === undefined
      ? []
      : [`report.fill: at least one of ${missing.join(", ")}, each citing its sources; nothing found: report failed.`];
  return [...done.map((need) => DONE_SAYS[need]), ...fill];
}
// What code marked a recorded report: web_only, people work whose report cites nobody the owner has
// a path to. `mixed_session`, a done report with a draft whose session read untrusted text and a
// sensitive row before it. A mark informs the owner's card and narrows nothing.
export const ReportMark = z.enum(["web_only", "mixed_session"]);
export type ReportMark = z.infer<typeof ReportMark>;

// The sealed body of a report with a `report` or a mark; a summary alone is sealed as its text.
// `request`: a progress report's request id, so a repeat of the request writes no second report.
export const MoveReportBody = z.strictObject({
  v: z.literal(1),
  summary: z.string().optional(),
  report: MoveReport.optional(),
  marks: z.array(ReportMark),
  request: z.string().optional(),
});
export type MoveReportBody = z.infer<typeof MoveReportBody>;

// What an agent is given with an opportunity it holds: built by code from rows its
// token returns, every text untrusted. `preferences` are the owner's active preference and
// constraint beliefs, for a client with the self view; `cases` the related cases the owner answered or
// left a note on; `done` what a done report of its next stage needs.
export const WorkBrief = z.strictObject({
  kind: OpportunityKind,
  summary: UntrustedString.nullable(),
  // `stale` only marks a goal nothing has supported lately; it never closes the goal, which only
  // the owner's word does (invariant 11).
  goal: z.strictObject({ id: goal, statement: UntrustedString, stale: z.literal(true).optional() }).nullable(),
  hypothesis: z
    .strictObject({
      id: hypothesis,
      kind: z.union([HypothesisKind, PlannerHypothesisKind]),
      summary: UntrustedString.nullable(),
      why: UntrustedString.optional(),
      test: UntrustedString.optional(),
    })
    .nullable(),
  lessons: z.array(z.strictObject({ id: hypothesis, lesson: UntrustedString })).max(50),
  preferences: z
    .array(
      z.strictObject({
        kind: z.enum(["preference", "constraint"]),
        what: UntrustedString,
        polarity: PreferencePolarity.optional(),
      }),
    )
    .max(100),
  cases: z.array(ClosedCase).max(20),
  done: z.array(DoneRequirement),
  // Done in words, doneSays' fixed lines.
  doneSays: z.array(z.string().max(300)).max(10).optional(),
  rejected: BriefRejected.optional(),
  // The latest progress reported on the work, by whoever held it: where a claim picks it up.
  progress: WorkProgress.optional(),
  ...BRIEF_CHECK_BACK,
  // One task stands for all of them.
  introPath: z.strictObject({ introducers: z.array(EntityId).max(20), goals: z.array(goal).max(20) }).optional(),
  // Ids and code words only.
  samePerson: z.array(SamePersonBriefPair).optional(),
  dreamFinding: DreamFindingBrief.optional(),
  card: CardAttemptBrief.optional(),
  relay: CardRelayBrief.optional(),
  handover: OwnerQueueBrief.optional(),
  explore: z
    .strictObject({
      missing: ExploreLacks,
      edges: z.array(z.strictObject({ fact: FactId, by: EntityId.nullable(), with: EntityId.nullable() })).max(20),
      goals: z.array(goal).max(20),
    })
    .optional(),
});
export type WorkBrief = z.infer<typeof WorkBrief>;

const positive = z.number().int().positive();

// A trial run: the owner's choice of model, an OpenRouter id, and reasoning effort
// for one run, in place of the reasoner's configured ones. Owner-set config, never model output.
export const TrialModelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/);
export type TrialModelId = z.infer<typeof TrialModelId>;
export const TrialEffort = z.enum(["low", "medium", "high"]);
export type TrialEffort = z.infer<typeof TrialEffort>;
export const RunTrial = z.strictObject({ model: TrialModelId, effort: TrialEffort });
export type RunTrial = z.infer<typeof RunTrial>;

// The owner's brief a planner run starts from, so a run need not open with get_self, a pack,
// get_beliefs and find_facts: built by code from rows the reasoner's token returns, each entry one
// short line with the ref or id a tool takes, every text untrusted. `confirmed`: what the owner
// confirmed, agents' proposals and the owner's answers; `stated`: their own active goals, preferences,
// constraints, situation, needs and capabilities; each newest first. `meetings`: the next seven
// days'; `contacts`: the owner's closest, as get_self ranks them. Cut to a budget, the oldest and least
// relevant first.
export const SELF_BRIEF_KINDS = Object.freeze([
  "goal",
  "preference",
  "constraint",
  "situation",
  "need",
  "capability",
] as const);
const briefFact = z.strictObject({
  kind: z.enum(SELF_BRIEF_KINDS),
  what: UntrustedString,
  polarity: PreferencePolarity.optional(),
  until: z.union([DateOnly, Timestamp]).optional(),
  ref: ClientRef.or(z.strictObject({ kind: z.literal("agent_record"), id: AgentRecordId })).optional(),
});
export const RunSelf = z.strictObject({
  confirmed: z.array(briefFact).max(200),
  stated: z.array(briefFact).max(200),
  meetings: z
    .array(
      z.strictObject({
        id: EventId,
        at: Timestamp.optional(),
        date: DateOnly.optional(),
        title: UntrustedString.optional(),
        with: z.array(UntrustedString).max(5),
      }),
    )
    .max(100),
  contacts: z
    .array(
      z.strictObject({
        id: EntityId,
        name: UntrustedString.optional(),
        address: UntrustedString.optional(),
        emails90d: z.number().int().nonnegative(),
        meetings90d: z.number().int().nonnegative(),
      }),
    )
    .max(20),
});
export type RunSelf = z.infer<typeof RunSelf>;

// `decision`, its id, which a lesson's basis may cite, is the only id: the rest of the line holds
// none. `did`, the verb in plain words, and `answer`, the owner's answer's code word, are code's;
// `object` is what it acted on, in words; `text` that object's text by the fixed rule for its kind,
// when the reasoner can read it; `his` the owner's decline reason and note, their own words,
// untrusted as evidence is (invariant 1).
export const OWNER_ACTIONS_MOST = 60;
const codeWords = z.string().regex(/^[a-z][a-z0-9 ,'_-]{0,79}$/);
export const OwnerAction = z.strictObject({
  decision: RulingId,
  at: Timestamp,
  did: codeWords,
  answer: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .optional(),
  object: codeWords,
  text: UntrustedString.optional(),
  his: z.strictObject({ reason: DeclineReason.optional(), note: UntrustedString.optional() }).optional(),
});
export type OwnerAction = z.infer<typeof OwnerAction>;

// Built afresh for each attempt: nothing of an earlier attempt is in it.
export const RunRequest = z.strictObject({
  id: run,
  attempt: z.union([z.literal(1), z.literal(2)]),
  source: PersonalWakeSource,
  anchors: z.array(WorkRef),
  goals: z.array(z.strictObject({ id: goal, statement: UntrustedString, stale: z.literal(true).optional() })),
  open: z.array(OpportunityView).max(50),
  closed: z.array(ClosedCase).max(50),
  intentions: z.array(
    z.strictObject({ id: intention, kind: IntentionKind, dueAt: Timestamp, opportunity: opportunity.nullable() }),
  ),
  point: z.strictObject({
    id: DecisionPointId,
    version: positive,
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
  }),
  // The planner's, each optional so a request built before them still parses: the owner's own
  // words on what they want from the planner; the planning lessons they confirmed; and a translate
  // run's one idea, with its summary and basis, and what it is about, which its work is about too.
  mission: UntrustedString.nullable().optional(),
  lessons: z
    .array(z.strictObject({ id: hypothesis, lesson: UntrustedString }))
    .max(50)
    .optional(),
  idea: z
    .strictObject({
      id: hypothesis,
      about: About.optional(),
      summary: UntrustedString.nullable(),
      basis: z.array(WorkRef),
    })
    .nullable()
    .optional(),
  // A lessons run's owner actions, newest first; none for a run queued
  // without them.
  actions: z.array(OwnerAction).max(OWNER_ACTIONS_MOST).optional(),
  // A trial run's model and effort: its output is checked as any run's and kept
  // on the run, and it writes nothing else.
  trial: RunTrial.optional(),
  // A planner stage's owner brief; none for a run of personal_run or of lessons.
  self: RunSelf.optional(),
  limits: z.strictObject({
    maxTurns: positive,
    maxToolCalls: positive,
    maxOutputTokens: positive,
    maxInputCodePoints: positive,
    ceilingMicroUsdPerToken: z.number().int().nonnegative(),
  }),
});
export type RunRequest = z.infer<typeof RunRequest>;

// The code checks of a run's output before finish_run (the ladder's checkRunOutput): each
// refusal is an action's index and one of these.
export const RUN_CHECK_CODES = Object.freeze([
  "restates_goal",
  "no_citation",
  "unknown_hypothesis",
  "owner_hypothesis",
  "too_many_hypotheses",
  "too_many_opportunities",
  "external_action",
  "same_case",
  // An action its stage does not take (an investigate or a remind in a translate run).
  "wrong_stage",
] as const);
export const RunCheckCode = z.enum(RUN_CHECK_CODES);
export type RunCheckCode = z.infer<typeof RunCheckCode>;

// A step holds no output and no hash. `tool` is null exactly for a call whose name is no read tool,
// which is refused and was not made. An output_check is one refusal of the code checks of the
// output the model call before it wrote. A model call's code is "truncated" when its reply was cut
// off at the output limit and not used. A model call carries its token counts, when the vendor gave
// them, and its wall-clock time in milliseconds: counts only.
export const RunStep = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("model_call"),
    promptId: z.string().min(1),
    promptVersion: z.string().min(1),
    modelId: z.string().min(1),
    costMicroUsd: z.number().int().nonnegative(),
    // A truncated reply keeps `truncated` whatever its cost. No step is timed_out.
    code: z.enum(["truncated", "cost_missing"]).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    ms: z.number().int().nonnegative().optional(),
  }),
  z
    .strictObject({
      kind: z.literal("tool_call"),
      tool: PersonalReadTool.nullable(),
      status: z.enum(["ok", "refused", "failed", "too_large"]),
      code: PersonalToolError.optional(),
      // The code points of what the call put in the model's context, a count only.
      resultCodePoints: z.number().int().nonnegative().optional(),
    })
    .refine((step) => step.tool !== null || step.status === "refused", {
      message: "a call of no read tool is refused",
      path: ["status"],
    }),
  z.strictObject({ kind: z.literal("output_check"), code: RunCheckCode }),
  // One web search or fetch the vendor ran for the model call before it, with its query or URL. The
  // one step that carries text: the store seals it under the attempt's label, and any erasure drops
  // it.
  z.strictObject({ kind: z.literal("web_search"), text: z.string().min(1).max(WEB_REQUEST_MAX) }),
  z.strictObject({ kind: z.literal("web_fetch"), text: z.string().min(1).max(WEB_REQUEST_MAX) }),
]);
export type RunStep = z.infer<typeof RunStep>;

// The strict arguments of each work and run tool. Every write carries a request id: a repeat
// returns the first result.
export const PersonalWorkArgs = Object.freeze({
  // Agent messages and the improvement store.
  ...AGENT_MAIL_ARGS,
  ...AGENT_TIME_ARGS,
  // Projects.
  ...PROJECT_ARGS,
  ...IDEA_ARGS,
  ...MEETING_READ_ARGS,
  report_wrong_merge: ReportWrongMergeArgs,
  report_wrong_relation: ReportWrongRelationArgs,
  relay_card_answer: RelayCardAnswerArgs,
  // `board`, every open opportunity the caller can see, with who holds it. `tier` and `role` filter
  // what is listed.
  list_opportunities: z.strictObject({
    scope: z.enum(["open", "mine", "board", "closed"]).optional(),
    tier: WorkTier.optional(),
    role: RoleName.optional(),
    project: EntityId.describe("With scope board, only this project's work.").optional(),
    area: AreaKey.describe(
      "With scope board, only the work of this area's projects: a key from list_projects' areas.",
    ).optional(),
    limit: z.number().int().min(1).max(25).optional(),
    after: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .describe("With scope closed, the `next` a page answered, for older work.")
      .optional(),
    excludeDeclined: z
      .boolean()
      .optional()
      .describe("With scope open, leave out work you released or declined in the last 7 days."),
  }),
  claim_opportunity: z.strictObject({ id: opportunity, requestId: RequestId }),
  release_opportunity: z.strictObject({
    id: opportunity,
    reason: ReleaseReason.optional(),
    record: AgentRecordId.optional(),
    requestId: RequestId,
  }),
  propose_task: z.strictObject({
    kind: ProposableTaskKind,
    // The owner too.
    about: About,
    summary: Summary,
    details: ProposalDetails.optional(),
    basis: proposeBasis,
    role: RoleName.optional(),
    hypothesis: hypothesis.optional(),
    dueAt: Timestamp.optional(),
    // What would mean the work succeeded; absent, the kind's default.
    expects: expects.optional(),
    // B5, B6: the project the task belongs to; the task it is a step of, which keeps it from
    // merging into another task about the same subject; and open work it waits on.
    project: EntityId.describe("The project this task belongs to, from list_projects or search.").optional(),
    parent: opportunity
      .describe("The task this one is a step of: it is then never merged into another task about the same subject.")
      .optional(),
    blockedBy: z
      .array(opportunity)
      .min(1)
      .max(WORK_BLOCKERS_MOST)
      .refine((ids) => new Set(ids).size === ids.length, { message: "each once" })
      .describe("Work that must close before this task can be claimed.")
      .optional(),
    bet: z.literal(true).describe("A bet: work nobody asked for, routed to you, from your weekly budget.").optional(),
    requestId: RequestId,
  }),
  // The role `owner` hands an opportunity, never a task, to the owner, and then `record`, a handoff
  // of the caller's, is needed: it is the basis the owner reads.
  hand_off: z.strictObject({
    id: opportunity,
    role: RoleName.nullable().optional(),
    reason: HandOffReason,
    record: AgentRecordId.optional(),
    tried: QuestionTried.optional(),
    requestId: RequestId,
  }),
  propose_hypothesis: z
    .strictObject({
      kind: z.union([HypothesisKind, z.literal("idea")]),
      about: About,
      summary: Summary,
      basis,
      idea: hypothesis.describe("With kind idea, an idea from list_ideas to add this evidence to.").optional(),
      requestId: RequestId,
    })
    .refine((args) => args.idea === undefined || args.kind === "idea", {
      message: "idea with kind idea alone",
      path: ["idea"],
    }),
  record_test: z.strictObject({ hypothesis, result: TestResult, basis, requestId: RequestId }),
  propose_opportunity: z.strictObject({
    kind: ProposableKind,
    about: About,
    summary: Summary,
    details: ProposalDetails.optional(),
    basis: proposeBasis,
    hypothesis: hypothesis.optional(),
    dueAt: Timestamp.optional(),
    // What would mean the work succeeded; absent, the kind's default.
    expects: expects.optional(),
    project: EntityId.describe("The project this work belongs to, from list_projects or search.").optional(),
    tried: QuestionTried.optional(),
    // A bet on read-only work of the caller's own proposing approves it, from the caller's weekly
    // budget: code then starts it with no card. Work with a stage that drafts, sends or pays, an
    // owner_question, or a decision the details ask of the owner is refused bet_needs_owner.
    bet: z
      .literal(true)
      .describe(
        "Approve this read-only work yourself with one of your weekly bets: it starts with no card. Never for work that drafts, sends or pays.",
      )
      .optional(),
    requestId: RequestId,
  }),
  // A goal or a change to one, a card for the owner. `goal` names the goal
  // a change is to (none for `add`); `statement` is the goal's words for `add` and `reword` alone;
  // `compartment`, one of the caller's own, only narrows where an added goal is sealed: the owner
  // chooses at accept.
  propose_goal: z
    .strictObject({
      change: GoalChange,
      goal: goal.optional().describe("The goal to change, from list_goals; for every change but add."),
      statement: goalStatement.optional().describe("The goal's words, for add and reword alone."),
      compartment: PersonalCompartment.optional().describe("One of yours, for add alone."),
      summary: Summary,
      details: ProposalDetails.optional(),
      basis: proposeBasis,
      requestId: RequestId,
    })
    .refine((args) => (args.change === "add") === (args.goal === undefined), {
      message: "goal for every change but add",
      path: ["goal"],
    })
    .refine((args) => (args.change === "add" || args.change === "reword") === (args.statement !== undefined), {
      message: "statement for add and reword alone",
      path: ["statement"],
    })
    .refine((args) => args.change === "add" || args.compartment === undefined, {
      message: "compartment for add alone",
      path: ["compartment"],
    }),
  propose_goal_target: proposeGoalTargetArgs({ goal, summary: Summary, basis: proposeBasis, requestId: RequestId }),
  // `watch`, evidence the work should watch for its outcome.
  plan_move: z.strictObject({ opportunity, stage: Stage, watch: watch.optional(), requestId: RequestId }),
  report_move: z.strictObject({
    move,
    // `progress` keeps the work claimed and the move open: report.done, report.next,
    // report.waitingOn and report.resumeAt are kept as the work's latest progress.
    outcome: z.enum(["done", "failed", "blocked", "progress"]),
    summary: reportText.optional(),
    basis: z.array(WorkRef).max(20).optional(),
    // What done means for the opportunity's kind is checked against it.
    report: MoveReport.optional(),
    // Advisory: code keeps the ones a brief of the reporting session served and drops the rest,
    // never refusing.
    lessonsApplied: z
      .array(HypothesisId)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, { message: "each lesson once" })
      .optional(),
    // Evidence the work should watch for its outcome.
    watch: watch.optional(),
    requestId: RequestId,
  }),
  // `note`, why the work waits, sealed with the intention and served in the pack's my_work.
  set_intention: z.strictObject({
    opportunity,
    kind: z.literal("check_back").optional(),
    dueAt: Timestamp,
    keepEarlier: z.boolean().optional(),
    park: z.boolean().optional(),
    note: progressLine.optional(),
    requestId: RequestId,
  }),
  ...LOOP_TOOL_ARGS,
  next_run: z.strictObject({ requestId: RequestId }),
  append_step: z.strictObject({ run, ordinal: z.number().int().nonnegative(), step: RunStep }),
  finish_run: z.strictObject({
    run,
    outcome: z.enum(["finished", "failed"]),
    code: WorkRunCode.optional(),
    output: RunOutput.optional(),
    requestId: RequestId,
  }),
} satisfies Record<PersonalWorkTool | PersonalRunTool, z.ZodType>);

// The strict result of each work and run tool, beside its arguments.
export const PersonalWorkResults = Object.freeze({
  ...AGENT_MAIL_RESULTS,
  ...AGENT_TIME_RESULTS,
  report_wrong_merge: ReportWrongMergeResult,
  report_wrong_relation: ReportWrongRelationResult,
  relay_card_answer: RelayCardAnswerResult,
  propose_project: ProposeProjectResult,
  update_project: UpdateProjectResult,
  list_projects: ListProjectsResult,
  ...IDEA_RESULTS,
  ...MEETING_READ_RESULTS,
  // B7: the project, its open work by holder with each one's latest progress, its last reports,
  // its latest check-back and hand-off, its next steps and decisions, and what changed in the last
  // seven days.
  get_project: ProjectView.extend({
    work: z.array(OpportunityView.extend(WorkTrail)).max(PROJECT_WORK_LISTED),
    ...ProjectDetailParts,
  }),
  list_opportunities: z.strictObject({
    opportunities: z.array(OpportunityView.extend({ brief: WorkBrief.optional() })),
    roles: z.strictObject({ mine: z.array(RoleName), all: z.array(RoleName) }).optional(),
    // On scope mine, the caller's moves cleared and never reported.
    unreported: z.array(UnreportedMove).max(20).optional(),
    next: z.string().min(1).max(200).optional(),
    changes: ChangesWaiting.optional(),
  }),
  claim_opportunity: z.strictObject({
    opportunity: OpportunityView,
    leaseUntil: Timestamp,
    brief: WorkBrief.optional(),
  }),
  // `declined`, a release of an item the caller could claim but does not
  // hold, which records its decline for 7 days and changes nothing else.
  release_opportunity: z.union([
    z.strictObject({ released: z.literal(true) }),
    z.strictObject({ declined: z.literal(true) }),
  ]),
  // A merge answers the open task's own status; it, a no_go and a card add `next`.
  propose_task: z.strictObject({
    opportunity,
    status: OpportunityStatus,
    merged: z.literal(true).optional(),
    bet: z.literal(true).optional(),
    next: z.string().min(1).max(200).optional(),
  }),
  hand_off: z.strictObject({ handedOff: z.literal(true) }),
  propose_hypothesis: z.strictObject({ hypothesis }),
  record_test: z.strictObject({ test: TestId, counts: z.boolean() }),
  // `bet`: the call placed a bet that approves the work.
  propose_opportunity: z.strictObject({ opportunity, bet: z.literal(true).optional() }),
  propose_goal: z.strictObject({ status: GoalProposalStatus }),
  propose_goal_target: z.strictObject({ status: GoalTargetProposalStatus }),
  plan_move: z.strictObject({ move }),
  // A recorded report, with its marks when it has any; or one refused, with what it lacks.
  report_move: z.union([
    // `dropped`, how many of lessonsApplied no brief of the session served.
    // `samePersonRefused`, the pairs of a same_person report code would not take: the rest were.
    z.strictObject({
      move,
      opportunity: OpportunityStatus,
      heldUntil: Timestamp.optional(),
      marks: z.array(ReportMark).min(1).optional(),
      dropped: z.number().int().positive().optional(),
      samePersonRefused: z.array(SamePersonRefused).min(1).optional(),
    }),
    // `hints`, REPORT_CHECK_HINTS' text for each code refused, added by the agent API.
    z.strictObject({
      move,
      refused: z.array(ReportCheckCode).min(1),
      hints: z.partialRecord(ReportCheckCode, z.string()).optional(),
      samePersonRefused: z.array(SamePersonRefused).min(1).optional(),
    }),
  ]),
  set_intention: z.strictObject({ intention }),
  ...LOOP_TOOL_RESULTS,
  next_run: z.strictObject({ run: RunRequest.nullable() }),
  append_step: z.strictObject({ go: z.boolean() }),
  finish_run: z.strictObject({ recorded: z.number().int().nonnegative(), outcome: RunOutcome }),
} satisfies Record<PersonalWorkTool | PersonalRunTool, z.ZodType>);
