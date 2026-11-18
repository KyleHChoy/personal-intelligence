import { type FactId, OWNER_PAGE_DEFAULT, type ShownWork, type SystemDefects } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION } from "@intelligence/personal-extract";
import { type Admin, COVERAGE_DAYS } from "@intelligence/personal-store";
import { deployedCommit } from "../deployed-commit.ts";
import { type POST_READS, type READS, WRITES } from "./web-routes.ts";

// How `pi web` calls the Admin for each route of the registry. The registry says what a route is;
// this says which arguments the Admin method takes, in its order. A route's `fixed` arguments come
// from the registry, never from the body. A route added to the registry without a call here fails
// the type check.

type Parsed<S> = S extends { parse(value: unknown): infer T } ? T : never;

// The host's settings a read takes as its command does: Drive's ceiling, PI_DRIVE_STORAGE_CEILING_BYTES.
export type ReadHost = { driveCeilingBytes?: number };

// Each call answers its route's result shape, or null for a 404: a store type that drifts from its
// contract fails the type check here rather than the strict parse at run time.
type ReadCalls = {
  [K in keyof typeof READS]: (
    admin: Admin,
    args: Parsed<(typeof READS)[K]["args"]>,
    host: ReadHost,
  ) => Promise<Parsed<(typeof READS)[K]["result"]> | null>;
};
type PostReadCalls = {
  [K in keyof typeof POST_READS]: (admin: Admin, body: Parsed<(typeof POST_READS)[K]["args"]>) => Promise<unknown>;
};
type WriteCalls = {
  [K in keyof typeof WRITES]: (admin: Admin, body: Parsed<(typeof WRITES)[K]["body"]>) => Promise<unknown>;
};

export const READ_CALLS: ReadCalls = {
  pendingCards: (admin, { kind, limit }) =>
    admin.cards.listPending({ ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }) }),
  card: (admin, { card }) => admin.cards.card(card, { view: "web" }),
  agentActivity: (admin) => admin.agents.activity(),
  cardsWithLines: (admin, args) => admin.cards.withLines(args),
  results: (admin, args) => admin.cards.results(args),
  // The result the owner opened, its view recorded as the page's.
  openResult: (admin, { move }) => admin.cards.openResult(move),
  digest: (admin) => admin.cards.digest(),
  entityPage: (admin, { entity }) => admin.people.entityPage(entity),
  factShow: (admin, { fact }) => admin.facts.show(fact),
  // Each ruling with whom it covers, by name (the page's Settings); the store's lists stay ids.
  listIgnore: async (admin) => {
    const rulings = await admin.ignores.listIgnore();
    const who = rulings.length === 0 ? new Map() : await admin.ignores.ignoredWho();
    return rulings.map((ruling) => ({ ...ruling, who: who.get(ruling.id) ?? [] }));
  },
  listVetoes: async (admin) => {
    const vetoes = await admin.cards.listVetoes();
    const on = vetoes.flatMap((veto) => (veto.entity === null ? [] : [veto.entity]));
    const who = on.length === 0 ? new Map() : await admin.names.who(on);
    return vetoes.map((veto) => ({ ...veto, who: veto.entity === null ? null : (who.get(veto.entity) ?? null) }));
  },
  exposureStatus: (admin) => admin.erasure.exposureStatus(),
  person: (admin, { entity }) => admin.people.person(entity),
  timeline: (admin, args) => admin.people.timeline(args),
  paths: (admin, { target, source }) => admin.people.paths(target, source),
  network: (admin, args) => admin.people.network(args),
  networkExpand: (admin, { node }) => admin.people.networkExpand(node),
  goals: (admin, { stale }) => admin.work.ownerGoals(stale === undefined ? {} : { stale }),
  goalWork: (admin, { goal }) => admin.work.goalWork({ goal }),
  weekEvents: (admin, { from, to }) => admin.time.weekEvents(from, to),
  timeWeek: (admin, { weekStart }) => admin.time.week(weekStart),
  spendToday: (admin) => admin.time.spendToday(),
  budget: (admin) => admin.time.budget(),
  lessons: (admin) => admin.time.lessons(),
  commitments: (admin, args) => admin.commitments.list(args),
  openItems: (admin) => admin.openItems.list(),
  ledgerDay: (admin, { day }) => admin.ledger.day(day),
  ledgerLanes: (admin, { day }) => admin.ledger.lanes(day),
  ledgerFeed: (admin, args) => admin.ledger.feed(args),
  spendSeries: (admin, { days }) => admin.ledger.spendSeries(days),
  cardLoadSeries: (admin, { days }) => admin.ledger.cardLoadSeries(days),
  // A subject's beliefs as of a time (null, 404, for an id that is no one's); what was learned
  // since one.
  beliefsAsOf: (admin, args) => admin.facts.beliefsAsOf(args),
  learnedSince: (admin, args) => admin.facts.learnedSince(args),
  timeDay: (admin, { day }) => admin.time.day(day ?? null),
  timeProposals: (admin) => admin.time.proposals(),
  // The page always pages; with no limit the store answers every row, the terminal's.
  peopleTiers: (admin, { tier, dormant, cursor, limit }) =>
    admin.tiers.peopleTiers({
      ...(tier === undefined ? {} : { tier }),
      ...(dormant === undefined ? {} : { dormant }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: limit ?? OWNER_PAGE_DEFAULT,
    }),
  personWarmth: (admin, { entity }) => admin.tiers.personWarmth(entity),
  lists: (admin) => admin.lists.all(),
  notes: (admin, { person }) => admin.notes.listNotes(person),
  // The store types `pi work show` loosely; the strict parse in `served` checks it.
  showWork: (admin, { work }) => admin.work.showWork(work) as Promise<ShownWork | null>,
  listClients: (admin) => admin.clients.listClients(),
  // The owner's standing releases, each with its counts.
  releaseGrants: (admin) => admin.releases.grants(),
  confirmRates: (admin) => admin.releases.confirmRates(),
  listSourceAccounts: (admin) => admin.accounts.listSourceAccounts(),
  // Against the host's Drive ceiling, as `pia status` reads it.
  // Settings shows no table's count: estimates, so the read counts no table (status in admin-accounts.ts).
  status: (admin, _, host) =>
    admin.accounts.status({
      tables: "estimate",
      ...(host.driveCeilingBytes === undefined ? {} : { driveCeilingBytes: host.driveCeilingBytes }),
    }),
  // `pia status --coverage`'s days by default, and the extractor's generation, as the command passes them.
  coverage: (admin, { days }) => admin.box.coverage(days ?? COVERAGE_DAYS.default, { generation: EXTRACT_GENERATION }),
  // Each join or split with the latest claim of each side, rendered in the same read, which the
  // page names it by (never one factShow a side).
  listFactRulings: async (admin) => {
    const rulings = await admin.facts.listFactRulings();
    const claims =
      rulings.length === 0
        ? new Map<string, FactId>()
        : await admin.facts.latestClaims(rulings.flatMap((one) => [one.a, one.b]));
    const views = claims.size === 0 ? new Map<FactId, never>() : await admin.facts.views([...claims.values()]);
    const viewOf = (claim: FactId | undefined) => (claim === undefined ? null : (views.get(claim) ?? null));
    return rulings.map((one) => ({
      ...one,
      aClaim: claims.get(one.a) ?? null,
      bClaim: claims.get(one.b) ?? null,
      aFact: viewOf(claims.get(one.a)),
      bFact: viewOf(claims.get(one.b)),
    }));
  },
  workStatus: (admin) => admin.work.status(),
  message: (admin, { message }) => admin.items.message(message),
  draft: (admin, { draft }) => admin.items.draft(draft),
  meeting: (admin, { meeting }) => admin.items.meeting(meeting),
  // The measures as the filing pass kept them, with the commit this server runs.
  system: async (admin) => ({ ...(await admin.box.measures()), commit: deployedCommit() }),
  // `pia improvements`' open defects alone: the page shows no closed one and no cause's history.
  // The store types its codes loosely; the strict parse in `served` checks them.
  defects: async (admin) => {
    const view = await admin.box.improvements();
    // What an agent wrote of each defect it filed, marked as its words.
    const words = await admin.box.defectWords();
    const said = (text: string | null | undefined) => (text == null ? null : { untrusted: text });
    return {
      at: view.at,
      total: view.total,
      open: view.open,
      defectRole: view.defectRole,
      ownersToChange: view.ownersToChange,
      heldByOne: await admin.box.defectHolds(),
      defects: view.defects.map((one) => {
        const mine = one.cause === null ? words[one.improvement] : undefined;
        return {
          ...one,
          filedBy: one.cause === null ? "agent" : "system",
          words:
            one.cause !== null
              ? null
              : { title: said(mine?.title), detail: said(mine?.detail), evidence: said(mine?.evidence) },
        };
      }),
    } as SystemDefects;
  },
  projects: (admin) => admin.projects.overview(),
  longWork: (admin) => admin.agents.longWork(),
  agentRecords: (admin) => admin.agents.records(),
  ideas: (admin) => admin.agents.ideas(),
  agentTime: (admin) => admin.time.agents(),
  dreamSample: (admin) => admin.extraction.dreamSample(),
  relayedAnswers: async (admin) => ({ relays: await admin.cards.listRelays({ quotes: true }) }),
  agentSettlements: (admin) => admin.cards.listSettled({ sample: true }),
  selfActivity: (admin, page) => admin.self.activity(page),
  selfReview: (admin, { kind, status, ...page }) =>
    admin.self.reviewPage(
      { ...(kind === undefined ? {} : { kind }), ...(status === undefined ? {} : { status }) },
      page,
    ),
};

export const POST_READ_CALLS: PostReadCalls = {
  search: (admin, { term }) => admin.search.entities(term),
  searchItems: (admin, { term }) => admin.search.factsAndMail(term),
};

const id = (body: { requestId: string }) => ({ requestId: body.requestId });

export const WRITE_CALLS: WriteCalls = {
  // One card a request, never a batch.
  decide: (admin, { card, labels, note, reason, compartment, correct, ...body }) =>
    admin.cards.decide({
      cards: [card],
      answer: body.answer,
      ...(correct === undefined ? {} : { correct }),
      ...(labels === undefined ? {} : { labels }),
      ...(note === undefined ? {} : { note }),
      ...(reason === undefined ? {} : { reason }),
      ...(compartment === undefined ? {} : { compartment }),
      requestId: body.requestId,
    }),
  decideHanded: (admin, body) => admin.cards.decideHanded(body),
  judgeResult: (admin, body) => admin.cards.judgeResult(body),
  setLearning: (admin, body) => admin.releases.setLearning(body),
  vetoTime: (admin, { proposal, to, requestId }) =>
    admin.time.veto({ proposal, ...(to === undefined ? {} : { to }), requestId }),
  closeCommitment: (admin, body) => admin.commitments.closeCommitment(body.fact, body.ending, id(body)),
  reopenCommitment: (admin, body) => admin.commitments.reopenCommitment(body.fact, id(body)),
  closeOpenItem: (admin, body) =>
    admin.openItems.close({ source: body.source, key: body.key, ending: body.ending }, id(body)),
  reopenOpenItem: (admin, body) => admin.openItems.reopen(body.key, id(body)),
  addTask: (admin, body) => admin.work.addTask(body),
  withdrawTask: (admin, body) => admin.work.withdrawTask(body),
  // The owner's words in the body only; `pi note add`'s default compartment is the store's.
  addNote: (admin, { requestId, ...note }) => admin.notes.addNote(note, { requestId }),
  retireNote: (admin, body) => admin.notes.retireNote(body.note, id(body)),
  // The owner's value in the body only.
  correctValue: (admin, body) => admin.notes.correctValue(body.fact, body.value, id(body)),
  // `pi goal add`'s default compartment.
  addGoal: (admin, body) =>
    admin.work.addGoal(body.statement, body.compartment ?? "own", { ...id(body), domain: body.domain }),
  setGoalStatus: (admin, body) => admin.work.setGoalStatus(body.goal, body.status, id(body)),
  setGoalTarget: (admin, body) => admin.work.setGoalTarget(body.goal, body.entity, id(body)),
  // The owner's new words in the body only.
  editGoal: (admin, body) => admin.work.editGoal(body.goal, body.statement, id(body)),
  rankGoal: (admin, body) => admin.work.rankGoal(body.goal, body.after, id(body)),
  // A key that is no goal from a source shown the owner is not_found, as the terminal says.
  adoptGoal: async (admin, body) => (await admin.work.adoptGoal(body.fact, body.change, id(body))) ?? false,
  unadoptGoal: (admin, body) => admin.work.unadoptGoal(body.goal, id(body)),
  hideGoal: (admin, body) => admin.work.hideGoal(body.fact, id(body)),
  unhideGoal: (admin, body) => admin.work.unhideGoal(body.fact, id(body)),
  setTier: (admin, body) => admin.tiers.setTier(body.person, body.tier, id(body)),
  clearTier: (admin, body) => admin.tiers.clearTier(body.person, id(body)),
  samePerson: (admin, body) => admin.identity.linkPeople(body.a, body.b, WRITES.samePerson.fixed.verdict, id(body)),
  differentPeople: (admin, body) =>
    admin.identity.linkPeople(body.a, body.b, WRITES.differentPeople.fixed.verdict, id(body)),
  liftIdentity: (admin, body) => admin.identity.liftIdentity(body.ruling, id(body)),
  liftFactRuling: (admin, body) => admin.facts.liftFactRuling(body.ruling, id(body)),
  ignorePerson: (admin, body) => admin.ignores.addIgnore(WRITES.ignorePerson.fixed.target, body.person, id(body)),
  liftIgnore: (admin, body) => admin.ignores.liftIgnore(body.ruling, id(body)),
  liftVeto: (admin, body) => admin.cards.liftVeto(body.ruling, id(body)),
  retireFact: (admin, body) => admin.facts.retireFact(body.fact, id(body)),
  rejectClaim: (admin, body) => admin.facts.rejectClaim(body.fact, id(body)),
  vetoFact: (admin, body) => admin.facts.vetoFact(body.fact, id(body)),
  liftRuling: (admin, body) => admin.facts.liftRuling(body.ruling, id(body)),
  factDomain: (admin, body) =>
    admin.facts.reclassifyFact(body.fact, WRITES.factDomain.fixed.verdict, body.domain, id(body)),
  factKind: (admin, body) => admin.facts.reclassifyFact(body.fact, WRITES.factKind.fixed.verdict, body.kind, id(body)),
  nameOrganization: (admin, body) => admin.identity.nameOrganization(body.organization, body.name, id(body)),
  namePerson: (admin, body) => admin.identity.namePerson(body.person, body.name, id(body)),
  liftPersonName: (admin, body) => admin.identity.liftPersonName(body.ruling, id(body)),
  createList: (admin, body) => admin.lists.createList(body.name, id(body)),
  renameList: (admin, body) => admin.lists.renameList(body.list, body.name, id(body)),
  deleteList: (admin, body) => admin.lists.deleteList(body.list, id(body)),
  addToList: (admin, body) => admin.lists.addToList(body.list, body.person, id(body)),
  removeFromList: (admin, body) => admin.lists.removeFromList(body.list, body.person, id(body)),
  // The brake: the state is the route's.
  stopWork: (admin, body) => admin.work.setKillSwitch(WRITES.stopWork.fixed.state, id(body)),
  // A relayed answer taken back: the card waits for the owner again.
  reopenRelayed: (admin, body) => admin.cards.reopenRelayed(body.card, id(body)),
  // The owner's mark on an agent's settlement.
  markAgentSettlement: (admin, body) => admin.cards.markSettled(body.card, body.mark),
  // The owner's veto of an agent's learning.
  retireLearning: (admin, body) => admin.work.retireLearning(body.learning),
  markAgentTime: (admin, body) => admin.time.markAgent(body.id, body.mark),
  markDreamCheck: (admin, body) => admin.extraction.markDreamCheck(body.check, body.mark, body.newToMe),
};
