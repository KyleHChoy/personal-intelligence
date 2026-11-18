import type { z } from "zod";
import { AgentRecords } from "./agent-record.ts";
import { AgentTimeMarkBody, AgentTimeView } from "./agent-time.ts";
import { AgentSettlements, MarkAgentSettlementBody } from "./card-attempts.ts";
import type { KnownCardKind } from "./card-kinds.ts";
import { RelayedAnswers, ReopenRelayedBody } from "./card-relays.ts";
import { ConfirmRatesView, LearningSwitchBody } from "./confirm-rates.ts";
import { DreamMarkBody, DreamSampleView } from "./dream.ts";
import { OwnerIdeas } from "./ideas.ts";
import { RetireLearningBody } from "./learnings.ts";
import { CloseOpenItemBody, ReopenOpenItemBody } from "./open-items.ts";
import { OwnerActivity } from "./owner-activity.ts";
import { OwnerOpenItems } from "./owner-dashboard.ts";
import { DecideHandedArgs } from "./owner-decide.ts";
import { CoverageRow } from "./owner-health.ts";
import { Digest, FactDetail } from "./owner-memory.ts";
import { PersonPanel } from "./owner-person.ts";
import {
  AgentActivity,
  BudgetView,
  CardArgs,
  CardResult,
  CardsWithLines,
  EntityArgs,
  EntityPageView,
  FactArgs,
  GoalWork,
  GoalWorkArgs,
  LessonsView,
  NoArgs,
  OwnerCommitments,
  OwnerCommitmentsArgs,
  OwnerDraft,
  OwnerDraftArgs,
  OwnerGoals,
  OwnerGoalsArgs,
  OwnerMeeting,
  OwnerMeetingArgs,
  OwnerMessageArgs,
  OwnerTimeline,
  OwnerTimelineArgs,
  PendingCards,
  PendingCardsArgs,
  SpendToday,
  TimeWeek,
  TimeWeekArgs,
  WeekEvents,
  WeekEventsArgs,
} from "./owner-reads.ts";
import {
  ClientRowView,
  CoverageArgs,
  FactRulingNamedView,
  IgnoredView,
  NotesArgs,
  OwnerListView,
  PeopleTiers,
  PeopleTiersArgs,
  PersonWarmth,
  ReleaseGrantView,
  ShownWork,
  ShowWorkArgs,
  SourceAccountView,
  StatusView,
  TimeDay,
  TimeDayArgs,
  VetoNamedView,
  WorkStatusView,
} from "./owner-reads-admin.ts";
import {
  BeliefsAsOf,
  BeliefsAsOfArgs,
  LearnedSince,
  LearnedSinceArgs,
  OwnerSearchArgs,
  OwnerSearchItems,
  OwnerSearchResult,
  SelfReviewArgs,
  SelfReviewPage,
} from "./owner-reads-history.ts";
import {
  CardLoadSeries,
  LedgerDay,
  LedgerDayArgs,
  LedgerFeed,
  LedgerLanes,
  SeriesArgs,
  SpendSeries,
} from "./owner-reads-ledger.ts";
import {
  NetworkArgs,
  NetworkExpandArgs,
  NetworkNeighbours,
  NetworkView,
  OwnerPaths,
  PathsArgs,
} from "./owner-reads-network.ts";
import { OwnerPageArgs } from "./owner-reads-paging.ts";
import { OpenResultArgs, OwnerResult, OwnerResults } from "./owner-results.ts";
import { ExposureStatusView } from "./owner-sources.ts";
import { AgentLongWork, OwnerProjects, SystemDefects, SystemView, WorkSwitchBody } from "./owner-system.ts";
import {
  AddGoalBody,
  AdoptGoalBody,
  CloseCommitmentBody,
  CorrectValueBody,
  DecideCardBody,
  EditGoalBody,
  FactBody,
  FactDomainBody,
  FactKindBody,
  GoalBody,
  GoalStatusBody,
  GoalTargetBody,
  JudgeResultBody,
  ListBody,
  ListCreateBody,
  ListMemberBody,
  ListRenameBody,
  NoteAddBody,
  NoteRetireBody,
  OrganizationNameBody,
  OwnerNoteView,
  OwnerTaskBody,
  OwnerTaskWithdrawBody,
  PeoplePairBody,
  PersonBody,
  PersonNameBody,
  RankGoalBody,
  RulingBody,
  SetTierBody,
  SourceGoalBody,
} from "./owner-words.ts";
import { TimeProposals, TimeVetoBody } from "./time-proposals.ts";
import { MessageView } from "./tools-views.ts";

// The schemas of every route `pi web` serves, by route name: the server's registry
// (`apps/pi/src/web/web-routes.ts`) adds each route's Admin method and what a write decides,
// and checks a request against these; the page takes its names and answers from here as types only,
// so a call to a route that is not here, or a result read as the wrong shape, fails the type check.

// GET /api/<name>.
export const WEB_READS = {
  pendingCards: { args: PendingCardsArgs, result: PendingCards },
  card: { args: CardArgs, result: CardResult },
  agentActivity: { args: NoArgs, result: AgentActivity },
  cardsWithLines: { args: OwnerPageArgs, result: CardsWithLines },
  results: { args: OwnerPageArgs, result: OwnerResults },
  openResult: { args: OpenResultArgs, result: OwnerResult },
  digest: { args: NoArgs, result: Digest },
  entityPage: { args: EntityArgs, result: EntityPageView },
  factShow: { args: FactArgs, result: FactDetail.nullable() },
  listIgnore: { args: NoArgs, result: IgnoredView.array() },
  listVetoes: { args: NoArgs, result: VetoNamedView.array() },
  exposureStatus: { args: NoArgs, result: ExposureStatusView },
  person: { args: EntityArgs, result: PersonPanel },
  timeline: { args: OwnerTimelineArgs, result: OwnerTimeline },
  paths: { args: PathsArgs, result: OwnerPaths },
  network: { args: NetworkArgs, result: NetworkView },
  networkExpand: { args: NetworkExpandArgs, result: NetworkNeighbours },
  goals: { args: OwnerGoalsArgs, result: OwnerGoals },
  goalWork: { args: GoalWorkArgs, result: GoalWork },
  weekEvents: { args: WeekEventsArgs, result: WeekEvents },
  timeWeek: { args: TimeWeekArgs, result: TimeWeek },
  spendToday: { args: NoArgs, result: SpendToday },
  budget: { args: NoArgs, result: BudgetView },
  lessons: { args: NoArgs, result: LessonsView },
  commitments: { args: OwnerCommitmentsArgs, result: OwnerCommitments },
  openItems: { args: NoArgs, result: OwnerOpenItems },
  ledgerDay: { args: LedgerDayArgs, result: LedgerDay },
  ledgerLanes: { args: LedgerDayArgs, result: LedgerLanes },
  ledgerFeed: { args: OwnerPageArgs, result: LedgerFeed },
  spendSeries: { args: SeriesArgs, result: SpendSeries },
  cardLoadSeries: { args: SeriesArgs, result: CardLoadSeries },
  beliefsAsOf: { args: BeliefsAsOfArgs, result: BeliefsAsOf },
  selfReview: { args: SelfReviewArgs, result: SelfReviewPage },
  selfActivity: { args: OwnerPageArgs, result: OwnerActivity },
  learnedSince: { args: LearnedSinceArgs, result: LearnedSince },
  timeDay: { args: TimeDayArgs, result: TimeDay },
  timeProposals: { args: NoArgs, result: TimeProposals },
  peopleTiers: { args: PeopleTiersArgs, result: PeopleTiers },
  personWarmth: { args: EntityArgs, result: PersonWarmth },
  lists: { args: NoArgs, result: OwnerListView.array() },
  notes: { args: NotesArgs, result: OwnerNoteView.array() },
  showWork: { args: ShowWorkArgs, result: ShownWork },
  listClients: { args: NoArgs, result: ClientRowView.array() },
  releaseGrants: { args: NoArgs, result: ReleaseGrantView.array() },
  confirmRates: { args: NoArgs, result: ConfirmRatesView },
  listSourceAccounts: { args: NoArgs, result: SourceAccountView.array() },
  status: { args: NoArgs, result: StatusView },
  coverage: { args: CoverageArgs, result: CoverageRow.array() },
  listFactRulings: { args: NoArgs, result: FactRulingNamedView.array() },
  workStatus: { args: NoArgs, result: WorkStatusView },
  message: { args: OwnerMessageArgs, result: MessageView },
  draft: { args: OwnerDraftArgs, result: OwnerDraft },
  meeting: { args: OwnerMeetingArgs, result: OwnerMeeting },
  system: { args: NoArgs, result: SystemView },
  defects: { args: NoArgs, result: SystemDefects },
  projects: { args: NoArgs, result: OwnerProjects },
  longWork: { args: NoArgs, result: AgentLongWork },
  relayedAnswers: { args: NoArgs, result: RelayedAnswers },
  agentSettlements: { args: NoArgs, result: AgentSettlements },
  agentRecords: { args: NoArgs, result: AgentRecords },
  ideas: { args: NoArgs, result: OwnerIdeas },
  // What agents set on work time, and the week's sample.
  agentTime: { args: NoArgs, result: AgentTimeView },
  // The week's sample of what dreaming found, for the owner to mark.
  dreamSample: { args: NoArgs, result: DreamSampleView },
} as const;

// POST /api/<name>: a read whose argument is free text, so it comes in a JSON body, never in a URL.
export const WEB_POST_READS = {
  search: { args: OwnerSearchArgs, result: OwnerSearchResult },
  searchItems: { args: OwnerSearchArgs, result: OwnerSearchItems },
} as const;

// POST /api/<name>, one owner decision each.
export const WEB_WRITES = {
  decide: { body: DecideCardBody },
  decideHanded: { body: DecideHandedArgs },
  judgeResult: { body: JudgeResultBody },
  setLearning: { body: LearningSwitchBody },
  vetoTime: { body: TimeVetoBody },
  closeCommitment: { body: CloseCommitmentBody },
  reopenCommitment: { body: FactBody },
  closeOpenItem: { body: CloseOpenItemBody },
  reopenOpenItem: { body: ReopenOpenItemBody },
  addGoal: { body: AddGoalBody },
  setGoalStatus: { body: GoalStatusBody },
  setGoalTarget: { body: GoalTargetBody },
  editGoal: { body: EditGoalBody },
  rankGoal: { body: RankGoalBody },
  adoptGoal: { body: AdoptGoalBody },
  unadoptGoal: { body: GoalBody },
  hideGoal: { body: SourceGoalBody },
  unhideGoal: { body: SourceGoalBody },
  setTier: { body: SetTierBody },
  clearTier: { body: PersonBody },
  samePerson: { body: PeoplePairBody },
  differentPeople: { body: PeoplePairBody },
  liftIdentity: { body: RulingBody },
  liftFactRuling: { body: RulingBody },
  ignorePerson: { body: PersonBody },
  liftIgnore: { body: RulingBody },
  liftVeto: { body: RulingBody },
  retireFact: { body: FactBody },
  rejectClaim: { body: FactBody },
  vetoFact: { body: FactBody },
  liftRuling: { body: RulingBody },
  factDomain: { body: FactDomainBody },
  factKind: { body: FactKindBody },
  nameOrganization: { body: OrganizationNameBody },
  namePerson: { body: PersonNameBody },
  liftPersonName: { body: RulingBody },
  addTask: { body: OwnerTaskBody },
  withdrawTask: { body: OwnerTaskWithdrawBody },
  addNote: { body: NoteAddBody },
  retireNote: { body: NoteRetireBody },
  correctValue: { body: CorrectValueBody },
  createList: { body: ListCreateBody },
  renameList: { body: ListRenameBody },
  deleteList: { body: ListBody },
  addToList: { body: ListMemberBody },
  removeFromList: { body: ListMemberBody },
  stopWork: { body: WorkSwitchBody },
  reopenRelayed: { body: ReopenRelayedBody },
  markAgentSettlement: { body: MarkAgentSettlementBody },
  retireLearning: { body: RetireLearningBody },
  markAgentTime: { body: AgentTimeMarkBody },
  markDreamCheck: { body: DreamMarkBody },
} as const;

// The card kinds whose answer can be lifted, each by a `pi` command and by the page's write that
// runs it: the undo of the `decide` write.
export const CARD_LIFTS = {
  about_you: { command: "correct lift", write: "liftRuling" },
  same_person: { command: "identity lift", write: "liftIdentity" },
  same_fact: { command: "facts lift", write: "liftFactRuling" },
} as const satisfies Partial<Record<KnownCardKind, { command: string; write: keyof typeof WEB_WRITES }>>;

export type WebReadName = keyof typeof WEB_READS;
export type WebPostReadName = keyof typeof WEB_POST_READS;
export type WebWriteName = keyof typeof WEB_WRITES;
export type WebReadResult<N extends WebReadName> = z.output<(typeof WEB_READS)[N]["result"]>;
export type WebPostReadResult<N extends WebPostReadName> = z.output<(typeof WEB_POST_READS)[N]["result"]>;
// The query a read takes: its arguments by name, each as the text a URL carries.
export type WebReadArgs<N extends WebReadName> = {
  readonly [K in keyof z.input<(typeof WEB_READS)[N]["args"]>]?: string;
};
