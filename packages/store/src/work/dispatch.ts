import type {
  CardId,
  MoveId,
  OpportunityId,
  PersonalLogger,
  PersonalWakeSource,
  WakeFacts,
} from "@intelligence/contracts/personal";
import { systemNow } from "@intelligence/personal-core";
import { proposeDueRules } from "../cards/question-rules.ts";
import type { Query } from "../core/db.ts";
import { createDb } from "../core/job-db.ts";
import { WORK_SESSION } from "../core/locks.ts";
import { lockedSession } from "../core/session-lock.ts";
import * as triggers from "../pipeline/triggers.ts";
import * as cardWrites from "./dispatch-cards.ts";
import * as drafts from "./dispatch-drafts.ts";
import * as expiryWrites from "./dispatch-expiry.ts";
import * as gaps from "./dispatch-gaps.ts";
import * as learning from "./dispatch-learning.ts";
import * as memory from "./dispatch-memory.ts";
import * as outcomes from "./dispatch-outcomes.ts";
import * as read from "./dispatch-read.ts";
import * as streaks from "./dispatch-streaks.ts";
import * as wakes from "./dispatch-wakes.ts";
import * as write from "./dispatch-write.ts";

// The dispatcher's store object, as pi_work: it reads facts and writes rows, and holds no rule. It
// takes no keys and opens no sealed column. The rows it offers are in the dispatch-*.ts files
// beside it and `triggers.ts`; each write is one transaction here, behind the lock check.

type DispatchOptions = { url: string; log: PersonalLogger; journal: string; now?: () => Date };

type Rows = Record<string, (query: Query, ...args: never[]) => unknown>;
type OnQuery<F> = {
  [K in keyof F]: F[K] extends (query: Query, ...args: infer A) => infer R ? (...args: A) => R : never;
};
type LastLog<F> = {
  [K in keyof F]: F[K] extends (query: Query, ...args: [...infer A, PersonalLogger]) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
type InWrite<F> = {
  [K in keyof F]: F[K] extends (query: Query, ...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

const rowsOf = <T>(rows: Rows, call: (run: Rows[string], args: never[]) => unknown): T =>
  Object.fromEntries(Object.entries(rows).map(([name, run]) => [name, (...args: never[]) => call(run, args)])) as T;

export function createDispatch(options: DispatchOptions) {
  const db = createDb(options.url, options.log);
  const log = options.log;
  const clock = options.now ?? systemNow;
  // Once the lock's connection has gone nothing is written: another tick may hold the lock by now.
  const tick = lockedSession(db, WORK_SESSION);
  const inWrite = <T>(fn: (query: Query) => Promise<T>): Promise<T> => tick.write(() => db.transaction(fn));
  // A table of reads over the dispatch's connection, of writes each one transaction behind the lock
  // check, and of writes that also take the logger last.
  const reads = <F extends Rows>(rows: F): OnQuery<F> => rowsOf(rows, (run, args) => run(db.query, ...args));
  const writes = <F extends Rows>(rows: F): InWrite<F> =>
    rowsOf(rows, (run, args) => inWrite(async (query) => run(query, ...args)));
  const logged = <F extends Rows>(rows: F): LastLog<F> =>
    rowsOf(rows, (run, args) => inWrite(async (query) => run(query, ...args, log as never)));

  return {
    get now(): Date {
      return clock();
    },

    // One tick at a time: the lock is the session's, given back when `fn` ends, and lost with the
    // connection.
    withWorkLock: tick.withLock,
    // One gap pass at a time, this tick's or the pipeline's lanes'.
    underGapPass: <T>(fn: () => Promise<T>): Promise<T> => gaps.underGapPass(db, fn),

    ...reads({
      killSwitch: read.killSwitchOf,
      wakeCandidates: wakes.wakeCandidates,
      vetoedOpen: read.vetoedOpen,
      ownerHypothesesWithoutCard: read.ownerHypothesesWithoutCard,
      plannerHypothesesWithoutCard: read.plannerHypothesesWithoutCard,
      handedWithoutCard: read.handedWithoutCard,
      reportsWithoutCard: read.reportsWithoutCard,
      expired: read.expired,
      dueIntentions: read.dueIntentions,
      failedRunStreak: streaks.failedRunStreak,
      // The drafts that wait for a card, and those past their seven days.
      draftsWithoutCard: drafts.draftsWithoutCard,
      draftsToExpire: drafts.draftsToExpire,
      // The rewrite card: each client and fact key restated stale three times.
      staleRestatements: memory.staleRestatements,
      // The works an applied outcome link's trigger row waits on.
      outcomeWorks: outcomes.outcomeWorks,
      // The gaps that hold now, and the gap flags open or in their quiet days.
      gapCandidates: gaps.gapCandidates,
      gapFlags: gaps.gapFlags,
      gapSupply: gaps.gapSupply,
      // The holds that lapsed unclaimed.
      lapsedHolds: read.lapsedHolds,
    }),

    // Writes: one transaction each, safe to repeat.
    ...writes({
      // The trigger rows raised and marked.
      raiseTriggers: triggers.raiseTriggers,
      // One work's rows raised, its own transaction.
      raiseOutcome: outcomes.raiseOutcome,
      closeGapFlag: gaps.closeGapFlag,
      queueRun: write.queueRun,
      recordSilence: write.recordSilence,
      decideOpportunity: write.decideOpportunity,
      closeVetoed: write.closeVetoed,
      closeHypothesis: cardWrites.closeHypothesis,
      expire: expiryWrites.expire,
      returnToGo: expiryWrites.returnToGo,
      preferClient: expiryWrites.preferClient,
      // One lapse written.
      lapseHold: expiryWrites.lapseHold,
      cancelIntention: expiryWrites.cancelIntention,
      stopRuns: expiryWrites.stopRuns,
      endRun: expiryWrites.endRun,
      expireDraft: drafts.expireDraft,
      // The learning item's second step: it answers how many rows it wrote.
      assessOutcomes: learning.assessOutcomes,
      // The clock's rechecks, its own transaction.
      clockRechecks: triggers.clockRechecks,
      fallBackPings: write.fallBackPings,
      matchOutcomes: learning.matchSentOutcomes,
    }),
    ...logged({
      raiseDecisionCard: write.raiseDecisionCard,
      raiseQuestionCard: cardWrites.raiseQuestionCard,
      raisePlannerCard: cardWrites.raisePlannerCard,
      raiseReminderCard: cardWrites.raiseReminderCard,
      raiseFailureNotice: cardWrites.raiseFailureNotice,
      raiseDraftCard: drafts.raiseDraftCard,
      raiseStaleCard: memory.raiseStaleCard,
    }),

    raiseOutcomeCard: (
      target: { kind: "opportunity"; id: OpportunityId } | { kind: "move"; id: MoveId },
      now: Date,
    ): Promise<CardId | null> => inWrite((query) => cardWrites.raiseOutcomeCard(query, target, now, log)),

    erasureLevel: (): Promise<"level" | "behind"> => read.erasureLevelOf(db.query, options.journal),
    wakeFacts: (source: PersonalWakeSource, now: Date, anchorVetoed = false): Promise<WakeFacts> =>
      read.wakeFacts(db.query, source, anchorVetoed, now),
    proposedOpportunities: (now: Date): Promise<read.ToDecide[]> => read.proposedOpportunities(db.query, now),
    // One opportunity's facts read afresh, or null when it is no longer to be decided: a decision
    // made earlier in the tick changes an intent's open count.
    opportunityToDecide: (id: OpportunityId, now: Date): Promise<read.ToDecide | null> =>
      read.opportunityFacts(db.query, id, now),
    // Rules proposed from the owner's repeated answers, once a day of theirs from its sweep hour:
    // the day proposed for, or null when none was due after `lastDay`.
    proposeQuestionRules: (now: Date, lastDay: string | null): Promise<{ day: string; proposed: number } | null> =>
      inWrite((query) => proposeDueRules(query, now, lastDay)),
    // The task-result cards raised before results became a feed, withdrawn quietly in one
    // transaction; how many.
    async withdrawTaskResultCards(now: Date): Promise<number> {
      const cards = await read.taskResultCards(db.query);
      return cards.length === 0 ? 0 : inWrite((query) => cardWrites.withdrawTaskResultCards(query, cards, now));
    },
    raiseGapFlag: (gap: gaps.GapRow, decide: boolean, check?: gaps.GapRaiseCheck) =>
      gaps.raiseGapChecked(inWrite, gap, decide, check),
    probeGapFlag: (gap: gaps.GapRow, decide: boolean, check: gaps.GapRaiseCheck) =>
      gaps.probeGap(inWrite, gap, decide, check),

    close: (): Promise<void> => db.close(),
  };
}
export type Dispatch = ReturnType<typeof createDispatch>;
