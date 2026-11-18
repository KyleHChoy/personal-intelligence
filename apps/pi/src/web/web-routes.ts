import {
  CARD_LIFTS,
  EventsArgs,
  LedgerEvent,
  type OwnerDecisionKind,
  type OwnerWebRefusal,
  WEB_POST_READS,
  WEB_READS,
  WEB_WRITES,
  type WebPostReadName,
  type WebReadName,
  type WebWriteName,
} from "@intelligence/contracts/personal";
import type { Admin } from "@intelligence/personal-store";

// The dashboard's route registry, kept as data. Every read names its Admin method, and takes the
// schemas of its arguments and result from the contract's table, which the page's calls are typed by;
// every write names its Admin method, the `pi` command it equals, the owner decision kinds it writes
// and its undo, so the page can say before the owner answers that a write has none. `pi web` serves
// exactly these routes; a request for anything on the "Never in a browser" list answers `not_here`. No
// behaviour lives here. web-routes.test.ts checks it against `pi`'s command table.

// A schema as the registry needs it: Zod's, from contracts. `pi` takes no Zod of its own.
type Schema = { safeParse(value: unknown): { success: boolean } };

type Methods<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] & string;
// The Admin's domain sub-objects: work, cards, facts and the rest.
type Groups<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K }[keyof T] & string;
// A method of one of the Admin's sub-objects, as `cards.decide`.
export type AdminMethod = { [G in Groups<Admin>]: `${G}.${Methods<Admin[G]>}` }[Groups<Admin>];

export type ReadRoute = { method: AdminMethod; args: Schema; result: Schema };

// How a write is undone: by a command (with its variant, where the command takes several), by a
// command of the terminal alone (one "Never in a browser" covers), by a card kind's own lift, by
// ruling again (the undo of a lift), or not at all.
type Undo =
  | { command: string; variant?: string }
  | { terminal: string }
  | { byCardKind: Readonly<Record<string, string>> }
  | "rule_again"
  | "none";

export type WriteRoute = {
  method: AdminMethod;
  body: Schema;
  // The `pi` command it equals, and the variant of that command where it takes several forms.
  command: string;
  variant?: string;
  // Arguments the route fixes, where one Admin method serves several commands: the server passes
  // them, never the body.
  fixed?: Readonly<Record<string, string>>;
  // Every owner decision kind the call may write; none for a write whose only row is its own (the
  // kill switch's).
  decisions: readonly OwnerDecisionKind[];
  undo: Undo;
};

// GET /api/<name>, ids and dates in the path or query. `card` opens one card and records its view:
// the client calls it only when the owner opens a card.
export const READS = {
  pendingCards: { method: "cards.listPending", ...WEB_READS.pendingCards },
  card: { method: "cards.card", ...WEB_READS.card },
  agentActivity: { method: "agents.activity", ...WEB_READS.agentActivity },
  cardsWithLines: { method: "cards.withLines", ...WEB_READS.cardsWithLines },
  results: { method: "cards.results", ...WEB_READS.results },
  openResult: { method: "cards.openResult", ...WEB_READS.openResult },
  digest: { method: "cards.digest", ...WEB_READS.digest },
  entityPage: { method: "people.entityPage", ...WEB_READS.entityPage },
  factShow: { method: "facts.show", ...WEB_READS.factShow },
  // Settings names each ruling by whom it covers (IgnoredView, VetoNamedView); the terminal's lists do not.
  listIgnore: { method: "ignores.listIgnore", ...WEB_READS.listIgnore },
  listVetoes: { method: "cards.listVetoes", ...WEB_READS.listVetoes },
  exposureStatus: { method: "erasure.exposureStatus", ...WEB_READS.exposureStatus },
  // The graph carries ids, names, tiers, weights, kinds and claim ids, never claim text; its first
  // load is bounded.
  person: { method: "people.person", ...WEB_READS.person },
  timeline: { method: "people.timeline", ...WEB_READS.timeline },
  paths: { method: "people.paths", ...WEB_READS.paths },
  network: { method: "people.network", ...WEB_READS.network },
  networkExpand: { method: "people.networkExpand", ...WEB_READS.networkExpand },
  goals: { method: "work.ownerGoals", ...WEB_READS.goals },
  goalWork: { method: "work.goalWork", ...WEB_READS.goalWork },
  // Lessons and the budget are read here only: `work lesson` and `work budget` stay on the Never in
  // a browser list.
  weekEvents: { method: "time.weekEvents", ...WEB_READS.weekEvents },
  timeWeek: { method: "time.week", ...WEB_READS.timeWeek },
  spendToday: { method: "time.spendToday", ...WEB_READS.spendToday },
  budget: { method: "time.budget", ...WEB_READS.budget },
  lessons: { method: "time.lessons", ...WEB_READS.lessons },
  commitments: { method: "commitments.list", ...WEB_READS.commitments },
  openItems: { method: "openItems.list", ...WEB_READS.openItems },
  ledgerDay: { method: "ledger.day", ...WEB_READS.ledgerDay },
  ledgerLanes: { method: "ledger.lanes", ...WEB_READS.ledgerLanes },
  ledgerFeed: { method: "ledger.feed", ...WEB_READS.ledgerFeed },
  spendSeries: { method: "ledger.spendSeries", ...WEB_READS.spendSeries },
  cardLoadSeries: { method: "ledger.cardLoadSeries", ...WEB_READS.cardLoadSeries },
  beliefsAsOf: { method: "facts.beliefsAsOf", ...WEB_READS.beliefsAsOf },
  selfReview: { method: "self.reviewPage", ...WEB_READS.selfReview },
  selfActivity: { method: "self.activity", ...WEB_READS.selfActivity },
  learnedSince: { method: "facts.learnedSince", ...WEB_READS.learnedSince },
  // The reads that existed before the dashboard, as the rooms call them. Today: the owner's day's
  // half-days and deep work. People: warmth by tier, paged, and one person's; the owner's lists; a
  // person's notes. Work: one run, move, opportunity or hypothesis.
  timeDay: { method: "time.day", ...WEB_READS.timeDay },
  timeProposals: { method: "time.proposals", ...WEB_READS.timeProposals },
  peopleTiers: { method: "tiers.peopleTiers", ...WEB_READS.peopleTiers },
  personWarmth: { method: "tiers.personWarmth", ...WEB_READS.personWarmth },
  lists: { method: "lists.all", ...WEB_READS.lists },
  notes: { method: "notes.listNotes", ...WEB_READS.notes },
  showWork: { method: "work.showWork", ...WEB_READS.showWork },
  // Settings, each row's state, read only; what changes it stays a write or in the terminal. None
  // holds a token, a secret, a key or a message's content: a client says whether it has a
  // work-notice address, the status when each Google token was written.
  listClients: { method: "clients.listClients", ...WEB_READS.listClients },
  // The owner's standing releases, each by its agent's name with its counts; its switch is the terminal's
  // (`facts grant`, `facts grant-lift`).
  releaseGrants: { method: "releases.grants", ...WEB_READS.releaseGrants },
  // How often the owner confirms what each agent proposes about them, by kind, with each agent's switch.
  confirmRates: { method: "releases.confirmRates", ...WEB_READS.confirmRates },
  listSourceAccounts: { method: "accounts.listSourceAccounts", ...WEB_READS.listSourceAccounts },
  status: { method: "accounts.status", ...WEB_READS.status },
  coverage: { method: "box.coverage", ...WEB_READS.coverage },
  listFactRulings: { method: "facts.listFactRulings", ...WEB_READS.listFactRulings },
  workStatus: { method: "work.status", ...WEB_READS.workStatus },
  // A message as read_message serves it; a draft an agent made, to read before the owner sends it
  // at a terminal (`send *` stays there).
  message: { method: "items.message", ...WEB_READS.message },
  draft: { method: "items.draft", ...WEB_READS.draft },
  meeting: { method: "items.meeting", ...WEB_READS.meeting },
  // The System room: each measure's latest stored reading against its healthy line, with the commit
  // this server was deployed at; and the open defects, by ids, counts and codes, no title or detail.
  system: { method: "box.measures", ...WEB_READS.system },
  defects: { method: "box.improvements", ...WEB_READS.defects },
  // The Projects room: every project with where it stands, its open work by holder with each
  // piece's latest progress, and what changed in seven days. And who is on what across days: the
  // work each agent holds and the work parked. A name and an agent's lines are served { untrusted }.
  projects: { method: "projects.overview", ...WEB_READS.projects },
  longWork: { method: "agents.longWork", ...WEB_READS.longWork },
  relayedAnswers: { method: "cards.listRelays", ...WEB_READS.relayedAnswers },
  // this week's sample of the cards agents settled, for the owner to mark.
  agentSettlements: { method: "cards.listSettled", ...WEB_READS.agentSettlements },
  agentRecords: { method: "agents.records", ...WEB_READS.agentRecords },
  ideas: { method: "agents.ideas", ...WEB_READS.ideas },
  agentTime: { method: "time.agents", ...WEB_READS.agentTime },
  // The week's sample of each kind dreaming found, for the owner to mark.
  dreamSample: { method: "extraction.dreamSample", ...WEB_READS.dreamSample },
} as const satisfies Record<WebReadName, ReadRoute>;

export type StreamRoute = { method: AdminMethod; args: Schema; event: Schema };
export const STREAMS = {
  events: { method: "ledger.events", args: EventsArgs, event: LedgerEvent },
} as const satisfies Record<string, StreamRoute>;

// POST /api/<name>: a read whose argument is free text, so it comes in a JSON body, never in a URL,
// and is never logged. Search as the owner types.
export const POST_READS = {
  search: { method: "search.entities", ...WEB_POST_READS.search },
  searchItems: { method: "search.factsAndMail", ...WEB_POST_READS.searchItems },
} as const satisfies Record<WebPostReadName, ReadRoute>;

const LIFT_A_RULING = { command: "correct lift" } as const;

// POST /api/<name>, one owner decision each: the table of the dashboard's writes.
export const WRITES = {
  decide: {
    method: "cards.decide",
    ...WEB_WRITES.decide,
    command: "decide",
    // An about-you card's Edit writes the answer from the owner and a correction.
    decisions: ["answer", "correction"],
    // The kinds with a lift; every other kind's answer has none, which the page says first. A
    // finding's dismiss on its outcome card is this write, with `reason` and `note` in the body;
    // the store takes the reason only on a handed opportunity's outcome (`declineAnswersOfCard`).
    undo: { byCardKind: Object.fromEntries(Object.entries(CARD_LIFTS).map(([kind, lift]) => [kind, lift.command])) },
  },
  // Done or Drop on work handed to the owner, from its row, answered on its outcome card, raised for it
  // when none is live. The same answer `pi decide` gives that card; an outcome card's answer has no
  // lift.
  decideHanded: {
    method: "cards.decideHanded",
    ...WEB_WRITES.decideHanded,
    command: "decide",
    decisions: ["answer"],
    undo: "none",
  },
  // The owner's Keep or Not useful on a result in the feed, with no card; undone by judging it again
  // (`none` clears their first).
  judgeResult: {
    method: "cards.judgeResult",
    ...WEB_WRITES.judgeResult,
    command: "work result",
    decisions: ["result_eval"],
    undo: { command: "work result" },
  },
  // The owner's switch for learning from one agent's proposals: off, no card proposes a standing
  // release or its lift for it and its brief says nothing of what they reject; undone by switching back.
  setLearning: {
    method: "releases.setLearning",
    ...WEB_WRITES.setLearning,
    command: "facts learning",
    decisions: ["learning_switch"],
    undo: { command: "facts learning" },
  },
  // The owner's veto of a proposed time ruling, with the project it belongs to instead when the owner says.
  vetoTime: {
    method: "time.veto",
    ...WEB_WRITES.vetoTime,
    command: "time veto",
    decisions: ["time_veto", "time_ruling"],
    undo: "none",
  },
  closeCommitment: {
    method: "commitments.closeCommitment",
    ...WEB_WRITES.closeCommitment,
    command: "commitments close",
    decisions: ["commitment_close"],
    undo: { command: "commitments reopen" },
  },
  reopenCommitment: {
    method: "commitments.reopenCommitment",
    ...WEB_WRITES.reopenCommitment,
    command: "commitments reopen",
    decisions: ["commitment_reopen"],
    undo: { command: "commitments close" },
  },
  closeOpenItem: {
    method: "openItems.close",
    ...WEB_WRITES.closeOpenItem,
    command: "open-items close",
    decisions: ["open_item_close"],
    undo: { command: "open-items reopen" },
  },
  reopenOpenItem: {
    method: "openItems.reopen",
    ...WEB_WRITES.reopenOpenItem,
    command: "open-items reopen",
    decisions: ["open_item_reopen"],
    undo: { command: "open-items close" },
  },
  addGoal: {
    method: "work.addGoal",
    ...WEB_WRITES.addGoal,
    command: "goal add",
    decisions: ["goal_set"],
    undo: { command: "goal set" },
  },
  setGoalStatus: {
    method: "work.setGoalStatus",
    ...WEB_WRITES.setGoalStatus,
    command: "goal set",
    decisions: ["goal_status"],
    undo: { command: "goal set" },
  },
  setGoalTarget: {
    method: "work.setGoalTarget",
    ...WEB_WRITES.setGoalTarget,
    command: "goal target",
    decisions: ["goal_target"],
    undo: { command: "goal target" },
  },
  editGoal: {
    method: "work.editGoal",
    ...WEB_WRITES.editGoal,
    command: "goal edit",
    decisions: ["goal_reword"],
    undo: { command: "goal edit" },
  },
  rankGoal: {
    method: "work.rankGoal",
    ...WEB_WRITES.rankGoal,
    command: "goal rank",
    decisions: ["goal_rank"],
    undo: { command: "goal rank" },
  },
  // Their Remove of one hides it; undone by `unhideGoal`.
  adoptGoal: {
    method: "work.adoptGoal",
    ...WEB_WRITES.adoptGoal,
    command: "goal adopt",
    decisions: ["goal_set", "goal_adopt", "goal_rank", "goal_reword", "goal_status", "goal_target", "goal_hide"],
    undo: { command: "goal unadopt" },
  },
  unadoptGoal: {
    method: "work.unadoptGoal",
    ...WEB_WRITES.unadoptGoal,
    command: "goal unadopt",
    decisions: ["goal_adopt_undo", "goal_status", "goal_rank", "goal_hide_lift"],
    undo: "none",
  },
  hideGoal: {
    method: "work.hideGoal",
    ...WEB_WRITES.hideGoal,
    command: "goal hide",
    decisions: ["goal_hide"],
    undo: { command: "goal unhide" },
  },
  unhideGoal: {
    method: "work.unhideGoal",
    ...WEB_WRITES.unhideGoal,
    command: "goal unhide",
    decisions: ["goal_hide_lift"],
    undo: { command: "goal hide" },
  },
  setTier: {
    method: "tiers.setTier",
    ...WEB_WRITES.setTier,
    command: "people tier",
    decisions: ["warmth_tier"],
    undo: { command: "people tier", variant: "clear" },
  },
  clearTier: {
    method: "tiers.clearTier",
    ...WEB_WRITES.clearTier,
    command: "people tier",
    variant: "clear",
    decisions: ["warmth_tier_lift"],
    undo: "rule_again",
  },
  samePerson: {
    method: "identity.linkPeople",
    ...WEB_WRITES.samePerson,
    command: "identity link",
    fixed: { verdict: "same" },
    decisions: ["identity"],
    undo: { command: "identity lift" },
  },
  differentPeople: {
    method: "identity.linkPeople",
    ...WEB_WRITES.differentPeople,
    command: "identity differ",
    fixed: { verdict: "different" },
    decisions: ["identity"],
    undo: { command: "identity lift" },
  },
  liftIdentity: {
    method: "identity.liftIdentity",
    ...WEB_WRITES.liftIdentity,
    command: "identity lift",
    decisions: ["identity_lift"],
    undo: "rule_again",
  },
  // A join or split of facts lifted, as `pi facts lift` lifts it: the page's Undo of a same_fact
  // answer, by the answer's ruling.
  liftFactRuling: {
    method: "facts.liftFactRuling",
    ...WEB_WRITES.liftFactRuling,
    command: "facts lift",
    decisions: ["fact_ruling_lift"],
    undo: "rule_again",
  },
  ignorePerson: {
    method: "ignores.addIgnore",
    ...WEB_WRITES.ignorePerson,
    command: "ignore add",
    variant: "entity",
    fixed: { target: "entity" },
    decisions: ["ignore"],
    undo: { command: "ignore lift" },
  },
  liftIgnore: {
    method: "ignores.liftIgnore",
    ...WEB_WRITES.liftIgnore,
    command: "ignore lift",
    decisions: ["ignore_lift"],
    undo: "rule_again",
  },
  // A veto of a kind of fact (`pi veto`), lifted as `pi veto lift` lifts it; a fact's own veto is liftRuling.
  liftVeto: {
    method: "cards.liftVeto",
    ...WEB_WRITES.liftVeto,
    command: "veto lift",
    decisions: ["veto_lift"],
    undo: "rule_again",
  },
  retireFact: {
    method: "facts.retireFact",
    ...WEB_WRITES.retireFact,
    command: "self retire",
    decisions: ["fact_retire"],
    undo: LIFT_A_RULING,
  },
  rejectClaim: {
    method: "facts.rejectClaim",
    ...WEB_WRITES.rejectClaim,
    command: "correct reject",
    decisions: ["correction"],
    undo: LIFT_A_RULING,
  },
  vetoFact: {
    method: "facts.vetoFact",
    ...WEB_WRITES.vetoFact,
    command: "correct veto",
    decisions: ["fact_veto"],
    undo: LIFT_A_RULING,
  },
  liftRuling: {
    method: "facts.liftRuling",
    ...WEB_WRITES.liftRuling,
    command: "correct lift",
    decisions: [
      "correction_lift",
      "fact_veto_lift",
      "fact_retire_lift",
      "fact_domain_lift",
      "fact_kind_lift",
      "confirmation_lift",
      "correction",
    ],
    undo: "rule_again",
  },
  factDomain: {
    method: "facts.reclassifyFact",
    ...WEB_WRITES.factDomain,
    command: "facts domain",
    fixed: { verdict: "domain" },
    decisions: ["fact_domain"],
    undo: LIFT_A_RULING,
  },
  // A fact's kind changed from the page, among the kinds `rulable` accepts; the lift undoes it to
  // the claim's own kind.
  factKind: {
    method: "facts.reclassifyFact",
    ...WEB_WRITES.factKind,
    command: "facts kind",
    fixed: { verdict: "kind" },
    decisions: ["fact_kind"],
    undo: LIFT_A_RULING,
  },
  nameOrganization: {
    method: "identity.nameOrganization",
    ...WEB_WRITES.nameOrganization,
    command: "org name",
    decisions: ["organization_name"],
    undo: { command: "org name" },
  },
  namePerson: {
    method: "identity.namePerson",
    ...WEB_WRITES.namePerson,
    command: "person name",
    decisions: ["person_name", "person_name_lift"],
    undo: { command: "person name lift" },
  },
  liftPersonName: {
    method: "identity.liftPersonName",
    ...WEB_WRITES.liftPersonName,
    command: "person name lift",
    decisions: ["person_name_lift"],
    undo: { command: "person name lift" },
  },
  addTask: {
    method: "work.addTask",
    ...WEB_WRITES.addTask,
    command: "work task",
    decisions: ["task_add"],
    undo: { command: "work task withdraw" },
  },
  withdrawTask: {
    method: "work.withdrawTask",
    ...WEB_WRITES.withdrawTask,
    command: "work task withdraw",
    decisions: ["task_withdraw"],
    undo: "none",
  },
  addNote: {
    method: "notes.addNote",
    ...WEB_WRITES.addNote,
    command: "note add",
    decisions: ["note_add", "fact_retire"],
    undo: { command: "note retire" },
  },
  retireNote: {
    method: "notes.retireNote",
    ...WEB_WRITES.retireNote,
    command: "note retire",
    decisions: ["fact_retire"],
    undo: LIFT_A_RULING,
  },
  correctValue: {
    method: "notes.correctValue",
    ...WEB_WRITES.correctValue,
    command: "correct value",
    decisions: ["correction"],
    undo: LIFT_A_RULING,
  },
  // A deleted list is not restored: the owner makes it again.
  createList: {
    method: "lists.createList",
    ...WEB_WRITES.createList,
    command: "lists create",
    decisions: ["list_create"],
    undo: { command: "lists delete" },
  },
  renameList: {
    method: "lists.renameList",
    ...WEB_WRITES.renameList,
    command: "lists rename",
    decisions: ["list_rename"],
    undo: { command: "lists rename" },
  },
  deleteList: {
    method: "lists.deleteList",
    ...WEB_WRITES.deleteList,
    command: "lists delete",
    decisions: ["list_delete"],
    undo: "none",
  },
  addToList: {
    method: "lists.addToList",
    ...WEB_WRITES.addToList,
    command: "lists add",
    decisions: ["list_add"],
    undo: { command: "lists remove" },
  },
  removeFromList: {
    method: "lists.removeFromList",
    ...WEB_WRITES.removeFromList,
    command: "lists remove",
    decisions: ["list_remove"],
    undo: { command: "lists add" },
  },
  // The brake: the owner's stop of all agent work, one row of the kill switch and no owner
  // decision. A stop ends runs and cancels sends a start does not bring back, which the page says
  // before the owner confirms; the state is the route's, never the body's. The resume is no write
  // of the page: it lets agents spend again, so it stays the owner's command (below).
  stopWork: {
    method: "work.setKillSwitch",
    ...WEB_WRITES.stopWork,
    command: "work stop",
    fixed: { state: "on" },
    decisions: [],
    undo: { terminal: "work start" },
  },
  // The card comes back pending and the owner answers it on the page, which is its only undo. Only
  // a card a relay decided: the route reopens no expired card and no settlement, which stay `pi
  // cards reopen`'s other forms.
  reopenRelayed: {
    method: "cards.reopenRelayed",
    ...WEB_WRITES.reopenRelayed,
    command: "cards reopen",
    variant: "relayed",
    decisions: ["relay_lift"],
    undo: "none",
  },
  // the owner's mark, right or wrong, on a card an agent's answer settled. It writes the
  // mark on the agent's answer and no owner decision; marking again replaces it.
  markAgentSettlement: {
    method: "cards.markSettled",
    ...WEB_WRITES.markAgentSettlement,
    command: "cards mark",
    decisions: [],
    undo: { command: "cards mark" },
  },
  // It writes the learning's own veto and no owner decision; its undo is the same command's lift.
  retireLearning: {
    method: "work.retireLearning",
    ...WEB_WRITES.retireLearning,
    command: "work learning",
    variant: "retire",
    decisions: [],
    undo: { command: "work learning", variant: "lift" },
  },
  // The owner's right or wrong on an agent's anchor or ruling, the measure of the
  // agents' precision. It writes the row's own mark and no owner decision; marking again replaces it.
  markAgentTime: {
    method: "time.markAgent",
    ...WEB_WRITES.markAgentTime,
    command: "time agents mark",
    decisions: [],
    undo: { command: "time agents mark" },
  },
  // The owner's right or wrong, and new to the owner, on a sampled check of what
  // dreaming found: the owner's own check row, never an owner decision, and never relayed by an agent.
  markDreamCheck: {
    method: "extraction.markDreamCheck",
    ...WEB_WRITES.markDreamCheck,
    command: "dream mark",
    decisions: [],
    undo: { command: "dream mark" },
  },
} as const satisfies Record<WebWriteName, WriteRoute>;

// The answer to a request for anything below, by route or forged.
export const NOT_HERE: OwnerWebRefusal = "not_here";

// "Never in a browser": what stays in the terminal. A name ending in ` *` covers every command it
// begins; a `variant` covers only that form of the command. The page shows each one's state where
// it has one, and its `pia` command.
export type NeverEntry = { command: string; variant?: string };
export const NEVER_IN_A_BROWSER: readonly NeverEntry[] = Object.freeze([
  // Erasure, and declassification.
  { command: "erase *" },
  { command: "declassify *" },
  // Promotion: what leaves this instance, and what another instance sends it.
  { command: "promotion *" },
  // Domain ignores.
  { command: "ignore add", variant: "domain" },
  // Clients, OAuth, Lens tokens and scopes, keys.
  { command: "clients *" },
  { command: "oauth *" },
  { command: "lens *" },
  { command: "keys *" },
  // Intents (standing grants) and harness modes.
  { command: "intent *" },
  { command: "harness *" },
  // Budgets and model settings.
  { command: "work budget" },
  { command: "work pings" },
  { command: "models *" },
  { command: "relations *" },
  // A kind's line and the checker's gate are the owner's measures, set in the terminal.
  { command: "dream line" },
  { command: "dream model" },
  // Work start: resuming lets agents spend again. The stop is a write of the page: the brake.
  { command: "work start" },
  // The planner's mission, task cancel, lessons.
  { command: "work mission" },
  { command: "work cancel" },
  { command: "work lesson" },
  // Automatic merges and the sweep.
  { command: "identity merges" },
  { command: "identity sweep" },
  { command: "identity dream-merges" },
  // Agent closes.
  { command: "commitments agent-closes" },
  // Fact releases and groupings.
  { command: "facts release" },
  { command: "facts grouping" },
  // A standing release and its lift.
  { command: "facts grant" },
  { command: "facts grant-lift" },
  // Every send command; Google connect and disconnect.
  { command: "send *" },
  { command: "google connect" },
  { command: "google disconnect" },
  // Retention, memory purges, agent-record removal.
  { command: "retain *" },
  { command: "memory purge" },
  { command: "agent-records rm" },
  { command: "research lift" },
  // Extraction controls (among them the export of decrypted mail).
  { command: "extract *" },
  // Releases that widen what agents see, and grants: held messages and documents, agent records,
  // restricted items, and the ladder's thresholds.
  { command: "messages release" },
  { command: "documents release" },
  { command: "agent-records release" },
  { command: "restricted *" },
  { command: "thresholds *" },
  { command: "ladder *" },
  // Work that spends: runs, ticks, trials, the dream.
  { command: "work run" },
  { command: "work tick" },
  { command: "work gaps" },
  { command: "work trial" },
  { command: "dream" },
  // The database, and commands that print a token, a secret or decrypted mail besides those above:
  // the page's own login link, and its server.
  { command: "db *" },
  { command: "web *" },
]);

// Whether a never entry covers a command and variant. `extract *` covers `extract` itself and every
// `extract ...`, never `extractor`.
export const covers = (entry: NeverEntry, command: string, variant?: string): boolean => {
  const base = entry.command.endsWith(" *") ? entry.command.slice(0, -2) : null;
  const named = base === null ? command === entry.command : command === base || command.startsWith(`${base} `);
  return named && (entry.variant === undefined || entry.variant === variant);
};
