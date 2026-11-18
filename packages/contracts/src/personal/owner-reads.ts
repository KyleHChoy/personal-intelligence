import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { ActivityCategory } from "./activity.ts";
import { RoleName } from "./clients.ts";
import { ListedGoal } from "./goals.ts";
import {
  AgentRecordId,
  CaptureId,
  CardId,
  ClientName,
  DraftId,
  EntityId,
  EventId,
  GoalId,
  HypothesisId,
  MessageId,
  MoveId,
  OpportunityId,
} from "./ids.ts";
import { LifeDomain } from "./knowledge-model.ts";
import { OpportunityKind, OpportunityStatus } from "./opportunity-words.ts";
import { CardDetail, CardView } from "./owner.ts";
import { finishedFields, GoalNextStep, OwnerEvent, owedFields } from "./owner-dashboard.ts";
import {
  code,
  count,
  minutes,
  next,
  OWNER_PAGE_MOST,
  OwnerPageArgs,
  queryBool,
  queryInt,
  usd,
} from "./owner-reads-paging.ts";
import { CommitmentItem, CompiledFacts } from "./packs.ts";
import { DraftStatus } from "./send.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { Who } from "./tools-views.ts";
import { MoveStatus, OutcomeLinkKind, Stage } from "./work.ts";

// The owner's reads: what the dashboard's rooms read under pi_admin, computed at read inside the
// owner's own audience. Arguments carry ids, dates, codes and cursors only: free text reaches the
// server only in a POST body (search). Every name, title and statement from evidence or the owner's own
// sealed words is served inside { untrusted } and rendered as text.

// A read that takes no argument.
export const NoArgs = z.strictObject({});
export type NoArgs = z.infer<typeof NoArgs>;

// Reads that exist, as the page asks for them. A card is opened (and its view recorded) only by
// `card`, on the owner's request.
export const PendingCardsArgs = z.strictObject({
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .optional(),
  limit: queryInt(1, OWNER_PAGE_MOST).optional(),
});
export type PendingCardsArgs = z.infer<typeof PendingCardsArgs>;
export const CardArgs = z.strictObject({ card: CardId });
export type CardArgs = z.infer<typeof CardArgs>;
export const EntityArgs = z.strictObject({ entity: EntityId });
export type EntityArgs = z.infer<typeof EntityArgs>;
export const FactArgs = z.strictObject({ fact: FactId });
export type FactArgs = z.infer<typeof FactArgs>;
export const PendingCards = z.array(CardView);
export type PendingCards = z.infer<typeof PendingCards>;
export const CardResult = CardDetail.nullable();
export type CardResult = z.infer<typeof CardResult>;
// `entityPage`'s answer: the person or organization, and the beliefs and claims about it.
export const EntityPageView = z.strictObject({ entity: Who, facts: CompiledFacts }).nullable();
export type EntityPageView = z.infer<typeof EntityPageView>;

// `lateDays` is null when it has no due date or is not late; `stale` is 7 days past its due date
// or, undated, 30 days after it was made. `party`: only those with this person on the other side,
// as a person's panel shows them.
export const OwnerCommitmentsArgs = OwnerPageArgs.extend({
  state: z.enum(["open", "closed"]).optional(),
  direction: z.enum(["owed_by_owner", "owed_to_owner"]).optional(),
  party: EntityId.optional(),
});
export type OwnerCommitmentsArgs = z.infer<typeof OwnerCommitmentsArgs>;
export const OwnerCommitment = z.strictObject({
  item: CommitmentItem,
  lateDays: z.number().int().positive().nullable(),
  ageDays: count,
  stale: z.boolean(),
  ...owedFields,
});
export type OwnerCommitment = z.infer<typeof OwnerCommitment>;
export const OwnerCommitments = z.strictObject({ commitments: z.array(OwnerCommitment).max(OWNER_PAGE_MOST), next });
export type OwnerCommitments = z.infer<typeof OwnerCommitments>;

export const OwnerGoalsArgs = z.strictObject({ stale: queryBool.optional() });
export type OwnerGoalsArgs = z.infer<typeof OwnerGoalsArgs>;
// `rank`: the owner's place for a goal within its life domain (`pi goal rank`; a goal stated in a
// source by its key too), 1 first; absent while the owner has not ranked it. The goals come by domain, each
// domain's ranked first by rank, then the rest newest first. `from`: for a goal stated in a
// source, the kind of source its words came from, which the page says as context.
// `targetRemoved`: true when the owner removed the goal's target from their people: the goal keeps its
// name, marked so.
const GOAL_SOURCES = ["mail", "meeting", "calendar", "chat", "agent_chat", "document", "agent", "other"] as const;
export const GoalSource = z.enum(GOAL_SOURCES);
export type GoalSource = z.infer<typeof GoalSource>;
export const OwnerGoal = z.strictObject({
  goal: ListedGoal,
  domain: LifeDomain.nullable(),
  target: Who.nullable(),
  targetRemoved: z.boolean().optional(),
  setBy: z.enum(["owner", "stated"]),
  rank: z.number().int().min(1).optional(),
  from: GoalSource.optional(),
});
export type OwnerGoal = z.infer<typeof OwnerGoal>;
export const OwnerGoals = z.strictObject({ goals: z.array(OwnerGoal).max(OWNER_PAGE_MOST) });
export type OwnerGoals = z.infer<typeof OwnerGoals>;

// One piece of agent work as the rooms show it. `summary` is the agent's own words, opened and
// marked as its; `holder` is the client holding it now.
const workItem = {
  opportunity: OpportunityId,
  kind: OpportunityKind,
  task: z.boolean(),
  status: OpportunityStatus,
  role: RoleName.nullable(),
  holder: ClientName.nullable(),
  move: z.strictObject({ id: MoveId, stage: Stage, status: MoveStatus.nullable(), at: Timestamp }).nullable(),
  outcome: OutcomeLinkKind.nullable(),
  summary: UntrustedString.nullable(),
  // What it is about, so work its agent has not described is titled by it: a person or organization
  // by name within the owner's audience (null for one withheld or unnamed), a goal by its id (the page
  // names it from the owner's goals), the owner, or a message or meeting. Served by `agentActivity`; absent from
  // reads that do not name it.
  about: z
    .strictObject({
      kind: z.enum(["owner", "message", "event", "entity", "goal"]),
      id: z.string().max(80).nullable(),
      name: UntrustedString.nullable(),
    })
    .nullable()
    .optional(),
};
export const OwnerWorkItem = z.strictObject(workItem);
export type OwnerWorkItem = z.infer<typeof OwnerWorkItem>;

export const GoalWorkArgs = z.strictObject({ goal: GoalId.or(FactId) });
export type GoalWorkArgs = z.infer<typeof GoalWorkArgs>;
// `next` and `proposals`: owner-dashboard.ts `GoalNextStep`.
export const GoalWork = z.strictObject({
  work: z.array(OwnerWorkItem).max(OWNER_PAGE_MOST),
  next: GoalNextStep.nullable().optional(),
  proposals: z.array(CardView).max(OWNER_PAGE_MOST).optional(),
});
export type GoalWork = z.infer<typeof GoalWork>;

// A blocked item carries its report's code and the agent's reason, marked as the agent's. A finished item
// ends as owner-dashboard.ts `finishedFields` says.
export const AgentActivity = z.strictObject({
  needsYou: z.strictObject({
    cards: z.array(CardView).max(OWNER_PAGE_MOST),
    handedToYou: z.array(OwnerWorkItem).max(OWNER_PAGE_MOST),
  }),
  working: z.array(z.strictObject({ ...workItem, since: Timestamp })).max(OWNER_PAGE_MOST),
  finished: z
    .array(z.strictObject({ ...workItem, ...finishedFields, findings: z.array(AgentRecordId).max(OWNER_PAGE_MOST) }))
    .max(OWNER_PAGE_MOST),
  blocked: z.array(z.strictObject({ ...workItem, code, reason: UntrustedString.nullable() })).max(OWNER_PAGE_MOST),
});
export type AgentActivity = z.infer<typeof AgentActivity>;

export const CardsWithLines = z.strictObject({ cards: z.array(CardDetail).max(OWNER_PAGE_MOST), next });
export type CardsWithLines = z.infer<typeof CardsWithLines>;

export const WeekEventsArgs = z.strictObject({ from: DateOnly, to: DateOnly });
export type WeekEventsArgs = z.infer<typeof WeekEventsArgs>;
// At most OWNER_PAGE_MOST in local start order; `more` when the window held more.
export const WeekEvents = z.strictObject({ events: z.array(OwnerEvent).max(OWNER_PAGE_MOST), more: z.boolean() });
export type WeekEvents = z.infer<typeof WeekEvents>;

// Minutes credited to no project are `unattributed`, shown as such.
export const TimeWeekArgs = z.strictObject({ weekStart: DateOnly });
export type TimeWeekArgs = z.infer<typeof TimeWeekArgs>;
export const TimeWeek = z.strictObject({
  // Each day's credited minutes by project, most first (absent from a week served before it).
  days: z
    .array(
      z.strictObject({
        date: DateOnly,
        minutes,
        deepMinutes: minutes,
        longestSessionMinutes: minutes,
        byProject: z.array(z.strictObject({ project: EntityId, minutes })).optional(),
      }),
    )
    .length(7),
  byProject: z.array(z.strictObject({ project: EntityId, name: UntrustedString.nullable(), minutes })),
  byKind: z.array(z.strictObject({ kind: ActivityCategory, minutes })),
  unattributed: minutes,
});
export type TimeWeek = z.infer<typeof TimeWeek>;

// A cap is the budget's, which the work lane still enforces on the UTC day, so near the owner's
// midnight the two windows differ. A cap is null where the database holds none: extraction's day cap
// is the host's PI_EXTRACT_DAY_USD.
export const SpendLane = z.enum(["work", "extraction", "dream"]);
export type SpendLane = z.infer<typeof SpendLane>;
export const SpendToday = z.strictObject({
  day: DateOnly,
  lanes: z.array(z.strictObject({ lane: SpendLane, spentUsd: usd, capUsd: usd.nullable() })),
});
export type SpendToday = z.infer<typeof SpendToday>;

export const BudgetView = z.strictObject({
  runs: count,
  usd,
  cards: count,
  inputChars: count,
  tokenPrice: count,
  outputTokens: count,
  lessonsEvery: count,
  planner: z.enum(["split", "one_pass", "research_only"]),
  sweepHour: z.number().int().min(0).max(23),
});
export type BudgetView = z.infer<typeof BudgetView>;

// `kinds` and `roles` are those a lesson is for; empty, every one.
export const LessonsView = z.strictObject({
  lessons: z
    .array(
      z.strictObject({
        id: HypothesisId,
        state: z.enum(["in_force", "pending"]),
        kinds: z.array(OpportunityKind),
        roles: z.array(RoleName),
        text: UntrustedString,
      }),
    )
    .max(OWNER_PAGE_MOST),
});
export type LessonsView = z.infer<typeof LessonsView>;

export const OwnerTimelineArgs = OwnerPageArgs.extend({ entity: EntityId });
export type OwnerTimelineArgs = z.infer<typeof OwnerTimelineArgs>;
export const OwnerTimelineEntry = z.strictObject({
  kind: z.enum(["mail", "meeting", "captured_meeting", "imessage", "fact", "work_session"]),
  id: z.string().min(1).max(80),
  at: Timestamp,
  title: UntrustedString.nullable(),
});
export type OwnerTimelineEntry = z.infer<typeof OwnerTimelineEntry>;
export const OwnerTimeline = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  entries: z.array(OwnerTimelineEntry),
  next,
});
export type OwnerTimeline = z.infer<typeof OwnerTimeline>;

// The owner's notes are read by `notes`.

export const OwnerMessageArgs = z.strictObject({ message: MessageId });
export type OwnerMessageArgs = z.infer<typeof OwnerMessageArgs>;

// Sending stays in the terminal ("Never in a browser"): no send code, reveal code or gate answer, which
// are `pi send show`'s. Its account by label; its recipients, subject and text as the agent wrote them,
// untrusted; `text` null for a draft whose body was cleared (tainted).
export const OwnerDraftArgs = z.strictObject({ draft: DraftId });
export type OwnerDraftArgs = z.infer<typeof OwnerDraftArgs>;
export const OwnerDraft = z.strictObject({
  id: DraftId,
  status: DraftStatus,
  at: Timestamp,
  account: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .nullable(),
  to: z.array(UntrustedString).max(10),
  cc: z.array(UntrustedString).max(10),
  subject: UntrustedString.nullable(),
  text: UntrustedString.nullable(),
  newThread: z.boolean(),
  // Each recipient the owner knows, by name within their audience, and whether it goes to someone
  // this account never wrote to, so the page shows the exact send command, with the flags `pi send
  // show` names.
  names: z.array(z.strictObject({ address: UntrustedString, name: UntrustedString })).max(20),
  firstContact: z.boolean(),
});
export type OwnerDraft = z.infer<typeof OwnerDraft>;

export const OWNER_MEETING_FACTS_MOST = 50;
export const OwnerMeetingArgs = z.strictObject({ meeting: EventId.or(CaptureId) });
export type OwnerMeetingArgs = z.infer<typeof OwnerMeetingArgs>;
export const OwnerMeetingFact = z.strictObject({ id: FactId, words: UntrustedString });
export type OwnerMeetingFact = z.infer<typeof OwnerMeetingFact>;
export const OwnerMeeting = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("meeting"), meeting: OwnerEvent }),
  z.strictObject({
    kind: z.literal("captured_meeting"),
    id: CaptureId,
    title: UntrustedString.nullable(),
    startsAt: Timestamp,
    endsAt: Timestamp.nullable(),
    participants: z.array(Who),
    facts: z.array(OwnerMeetingFact).max(OWNER_MEETING_FACTS_MOST),
  }),
]);
export type OwnerMeeting = z.infer<typeof OwnerMeeting>;
