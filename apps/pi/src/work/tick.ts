import { readFile, writeFile } from "node:fs/promises";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { decide, opportunityGo, REGISTRY, type Registry, wakeWorthRun } from "@intelligence/personal-ladder";
import { createDispatch, type Dispatch, withJobRun } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { codeOf, refusal } from "../env.ts";
import { closesAtOnce, gapPass, tickGapReads } from "./gap-pass.ts";

// pi work tick: one tick under the work lock, the ladder
// called between the store's reads and its writes. The store holds no rule and the ladder reads
// nothing; this file only puts the two in order: read, decide, write. Every write is the store's own
// transaction, safe to repeat, so a tick killed after any write and run again ends where one
// uninterrupted tick would.

// `shadowTriggers`, the switch for the trigger rows' raised marks (step 4c), off unless set, since
// nothing reads them; `warned`, the warning counts the last tick logged, so a
// warning is logged again only when its count changes (the command keeps them in PI_WORK_STATE),
// and beside them the day the question rules were last proposed for; with none, every warning is
// logged.
export type TickDeps = {
  dispatch: Dispatch;
  registry: Registry;
  log: PersonalLogger;
  now: () => Date;
  shadowTriggers?: boolean;
  warned?: Record<string, number>;
};

// `links` and `assessed` are the learning item's.
// `failed`, the steps that failed, there only when one did.
export type TickCounts = {
  queued: number;
  silenced: number;
  decided: number;
  cards: number;
  expired: number;
  vetoed: number;
  links: number;
  assessed: number;
  failed?: number;
};

const NEWS_DAYS = 7;
// A count map's keys under one prefix, for a log line's counts.
// The key the day the rules were last proposed for is kept under, beside the warning counts.
const RULES_DAY = "question_rules_day";

const prefixed = (prefix: string, counts: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).map(([key, n]) => [`${prefix}_${key}`, n]));

export async function runTick({
  dispatch,
  registry,
  log,
  now,
  shadowTriggers = false,
  warned,
}: TickDeps): Promise<TickCounts | "already_running"> {
  // Nothing is read or written before the erasures made since a restore are applied
  //.
  if ((await dispatch.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
  const at = now();
  const warnOnChange = (event: string, n: number): void => {
    if (n > 0 && (warned === undefined || warned[event] !== n)) log.warn({ event, counts: { deferred: n } });
    if (warned !== undefined) warned[event] = n;
  };
  // Steps 1 to 7: what the tick does.
  const effects = async (): Promise<TickCounts> => {
    const counts: TickCounts = {
      queued: 0,
      silenced: 0,
      decided: 0,
      cards: 0,
      expired: 0,
      vetoed: 0,
      links: 0,
      assessed: 0,
    };
    const card = (raised: unknown): void => {
      if (raised !== null) counts.cards += 1;
    };
    // Each step its own, and each row of a step's list its own, so one bad row stops neither the
    // rows after it nor the tick: a step or a row that throws is one `step_failed` line with the
    // step and its code, counted, and the next runs.
    const stepFailed = (name: string, error: unknown): void => {
      counts.failed = (counts.failed ?? 0) + 1;
      log.error({ event: "step_failed", code: codeOf(error), counts: { [`step_${name}`]: 1 } });
    };
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        stepFailed(name, error);
      }
    };
    // A step over a list: the list read as a step, then each row as one.
    const each = <T>(name: string, list: () => Promise<readonly T[]>, fn: (row: T) => Promise<void>): Promise<void> =>
      step(name, async () => {
        for (const row of await list()) await step(name, () => fn(row));
      });

    // 1. The kill switch stops every queued and running run, and the tick's effects. The outcome
    // steps still run: they record and change nothing. A switch that cannot be read stops the
    // effects as the switch would.
    const switched = { on: true };
    await step("kill_switch", async () => {
      switched.on = await dispatch.killSwitch();
      if (switched.on) await dispatch.stopRuns();
    });
    if (switched.on) return counts;

    // 2. Vetoes first: every open opportunity a veto covers is closed by the veto's ruling.
    await each(
      "vetoes",
      () => dispatch.vetoedOpen(),
      async ({ id, ruling }) => {
        if (await dispatch.closeVetoed(id, ruling, at)) counts.vetoed += 1;
      },
    );

    // 3. What is past its time.
    await each(
      "expired",
      () => dispatch.expired(at),
      async (item) => {
        if (await dispatch.expire(item, at)) counts.expired += 1;
      },
    );
    // The send proxy's second tick step: a draft made or held for seven days,
    // with no send of it in flight.
    await each(
      "drafts_expired",
      () => dispatch.draftsToExpire(),
      async (id) => {
        if (await dispatch.expireDraft(id)) counts.expired += 1;
      },
    );

    // 3b. Gap flags: close those whose gap filled, then raise research for the gaps that hold, at
    // most GAP_FLAGS_PER_TICK a label, the rest logged as waiting for the next tick. A gap the
    // owner declined comes back from a new source as their card (step 6 raises it). `waiting`: those
    // no intent of the owner's authorizes yet, gone, or vetoed since the scan. `withheld`: those rung 0
    // would close no_go at once, for which no row is spent, and which hold no place: the tick plans
    // again without them, so what they hold, which may rest on a no a viewer cannot see, goes to the
    // next (invariant 6). Each gap is tried once a tick. The three warmth lanes, close_no_tie,
    // close_no_role and the frontier's explore nodes, are the pipeline's pass, run with the same
    // plan after each day build: the tick reads, raises and closes none of them. Both passes read a
    // label's supply and raise against its cap, so each runs under the gap pass lock.
    await step("gap_flags", async () => {
      const { gaps, held, supply } = await dispatch.underGapPass(() =>
        gapPass(tickGapReads(dispatch), at, {
          raise: (gap, card) => dispatch.raiseGapFlag(gap, card, { now: at, closesAtOnce }),
          close: (id) => dispatch.closeGapFlag(id, at),
          log,
        }),
      );
      if (held.raised + held.capped > 0) {
        const numbers = [...supply.values()];
        log.info({
          event: "gap_raise_cap",
          counts: {
            labels: numbers.length,
            raised_today: numbers.reduce((sum, one) => sum + one.raisedToday, 0),
            claimed: numbers.reduce((sum, one) => sum + one.claimed, 0),
            done: numbers.reduce((sum, one) => sum + one.done, 0),
            ...held,
          },
        });
      }
      if (Object.values(gaps).some((n) => n > 0)) log.info({ event: "gap_flags", counts: gaps });
      warnOnChange("gap_flags_over_threshold", gaps.deferred);
    });

    // 4. Intentions due. A check-back acts only while its opportunity is claimed or go, and on
    // claimed work only when the client that set it is the one holding it: a check-back an
    // earlier holder left is cancelled, so it never takes the work from the client that has it.
    // On work back on the board, preferClient cancels it the same way while another client's
    // hold still runs.
    await each(
      "intentions",
      () => dispatch.dueIntentions(at),
      async (due) => {
        if (due.kind === "remind") {
          card(await dispatch.raiseReminderCard(due.id, at));
          return;
        }
        const preferred = due.client === null ? undefined : { client: due.client, intention: due.id };
        if (
          due.opportunity !== null &&
          preferred !== undefined &&
          due.opportunityStatus === "claimed" &&
          due.holder === preferred.client
        )
          await dispatch.returnToGo(due.opportunity, at, preferred);
        else if (due.opportunity !== null && preferred !== undefined && due.opportunityStatus === "go")
          await dispatch.preferClient(due.opportunity, preferred, at);
        else await dispatch.cancelIntention(due.id, at);
      },
    );
    // 4b. A check-back hold that ended with its item unclaimed, noticed once.
    await each(
      "lapsed_holds",
      () => dispatch.lapsedHolds(at),
      async (id) => {
        await dispatch.lapseHold(id, at);
      },
    );

    // 4c. Query-time triggers. The clock asks for the commitments falling due, as rechecks the
    // extraction computes on its next run; its `due` rows are the only source of the
    // commitment_due wakes below (ledger.state_wakes reads the trigger log), so it
    // runs on every tick. Behind its switch, off by default, the rows written since the last tick
    // are counted and marked, which nothing reads. Each step's failure is logged by its code and
    // stops nothing.
    try {
      await dispatch.clockRechecks(at);
    } catch (error) {
      counts.failed = (counts.failed ?? 0) + 1;
      log.error({ event: "work_triggers_failed", code: codeOf(error) });
    }
    if (shadowTriggers) {
      try {
        const triggers = await dispatch.raiseTriggers(at);
        if (triggers.marked > 0)
          log.info({
            event: "work_triggers",
            counts: {
              marked: triggers.marked,
              ...prefixed("raise", triggers.byRaise),
              ...prefixed("cause", triggers.byCause),
            },
          });
      } catch (error) {
        counts.failed = (counts.failed ?? 0) + 1;
        log.error({ event: "work_triggers_failed", code: codeOf(error) });
      }
    }
    // 4d. The applied outcome links' trigger rows, raised, not in shadow: each work's status moved
    // and its agent told, after the matters check. A work's failure is logged by its code and stops
    // neither the other works nor the tick. `held_owner` and `held_bound`: works whose model links
    // counted for nothing, the owner's word outranking them or the overturn bound turning them off.
    const raised = { works: 0, moved: 0, woke: 0, skipped: 0, held_owner: 0, held_bound: 0, failed: 0 };
    let waiting: Awaited<ReturnType<Dispatch["outcomeWorks"]>> = [];
    try {
      waiting = await dispatch.outcomeWorks();
    } catch (error) {
      raised.failed += 1;
      log.error({ event: "work_outcomes_failed", code: codeOf(error) });
    }
    for (const id of waiting) {
      try {
        const one = await dispatch.raiseOutcome(id, at);
        raised.works += 1;
        if (one.status !== null) raised.moved += 1;
        if (one.woke !== null) raised.woke += 1;
        if (one.skip !== null) raised.skipped += 1;
        if (one.held === "owner") raised.held_owner += 1;
        if (one.held === "overturn_bound") raised.held_bound += 1;
      } catch (error) {
        raised.failed += 1;
        log.error({ event: "work_outcomes_failed", code: codeOf(error) });
      }
    }
    if (raised.works + raised.failed > 0) log.info({ event: "work_outcomes", counts: raised });
    if (raised.failed > 0) counts.failed = (counts.failed ?? 0) + raised.failed;

    // 5. Wakes. Each candidate's facts are read afresh: a run queued just now counts.
    await each(
      "wakes",
      () => dispatch.wakeCandidates(at),
      async (candidate) => {
        const facts = await dispatch.wakeFacts(candidate.source, at, candidate.vetoed);
        // The rung 0 functions are pure: asked again, each gives the answer `decide` recorded,
        // with the reason the write keeps.
        const call = decide(registry, "wake_worth_run", facts, wakeWorthRun);
        const rung0 = wakeWorthRun(facts);
        if (rung0 === "cannot_decide") return;
        if (rung0.output === "run") {
          if ((await dispatch.queueRun(candidate, call, at)) !== null) counts.queued += 1;
        } else if (await dispatch.recordSilence(candidate, rung0.reason, call, at)) counts.silenced += 1;
      },
    );

    // 6. Decisions: rung 0, or a card for the owner.
    await each(
      "decisions",
      () => dispatch.proposedOpportunities(at),
      async (listed) => {
        // Read again: a go decided earlier in this loop counts against its intent's max_open.
        const item = await dispatch.opportunityToDecide(listed.id, at);
        if (item === null) return;
        const call = decide(registry, "opportunity_go", item.facts, opportunityGo);
        const rung0 = opportunityGo(item.facts);
        if (call.escalated || rung0 === "cannot_decide") {
          card(await dispatch.raiseDecisionCard(item.id, call, at));
          return;
        }
        const intent = "intent" in rung0 ? rung0.intent : null;
        if (await dispatch.decideOpportunity(item.id, call, { output: rung0.output, reason: rung0.reason, intent }, at))
          counts.decided += 1;
      },
    );

    // An unclaimed ping's next place in the owner's order, once its wait is over.
    await step("ping_fallback", async () => {
      await dispatch.fallBackPings(at);
    });

    // 7. Questions, outcomes and notices. A veto on a card's subject means the card is not
    // raised (each raise checks it).
    await each(
      "questions",
      () => dispatch.ownerHypothesesWithoutCard(at),
      async (hypothesis) => {
        const closed = hypothesis.caseClosed;
        if (closed !== null && (!closed.newSourceRef || closed.daysSince < NEWS_DAYS))
          await dispatch.closeHypothesis(hypothesis.id, at);
        else card(await dispatch.raiseQuestionCard(hypothesis.id, at));
      },
    );
    // The planner's ideas, and every lesson that can be asked: each a card the owner answers.
    await each(
      "planner_cards",
      () => dispatch.plannerHypothesesWithoutCard(),
      async (planned) => card(await dispatch.raisePlannerCard(planned.id, planned.kind, at)),
    );
    // A pattern the owner answered alike, proposed once as a rule for the owner to confirm, on the
    // first tick of the owner's day from its sweep hour. The day last proposed for is kept beside the
    // warning counts, as a number; with none kept, each tick from that hour proposes, and a pattern
    // a rule already holds is never proposed twice.
    await step("question_rules", async () => {
      const kept = warned?.[RULES_DAY];
      const last = kept === undefined ? null : String(kept).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const ran = await dispatch.proposeQuestionRules(at, last);
      if (ran === null) return;
      if (warned !== undefined) warned[RULES_DAY] = Number(ran.day.replaceAll("-", ""));
      if (ran.proposed > 0) log.info({ event: "question_rules_proposed", counts: { proposed: ran.proposed } });
    });
    await each(
      "handed_cards",
      () => dispatch.handedWithoutCard(),
      async (id) => card(await dispatch.raiseOutcomeCard({ kind: "opportunity", id }, at)),
    );
    // A task's report raises no card: it is in the owner's Results feed, and the task-result cards raised
    // before it are withdrawn quietly, with no notice.
    await step("task_results", async () => {
      await dispatch.withdrawTaskResultCards(at);
    });
    await each(
      "report_cards",
      () => dispatch.reportsWithoutCard(),
      async (id) => card(await dispatch.raiseOutcomeCard({ kind: "move", id }, at)),
    );
    // The send proxy's first tick step: a made draft's card in the owner's
    // queue, unless a veto covers it or the owner rejected its case. A held draft gets none.
    await each(
      "draft_cards",
      () => dispatch.draftsWithoutCard(),
      async (id) => card(await dispatch.raiseDraftCard(id, at)),
    );
    // The rewrite card: a client that restated one superseded fact three times. It
    // queues no run.
    await each(
      "stale_cards",
      () => dispatch.staleRestatements(),
      async (stale) => card(await dispatch.raiseStaleCard(stale, at)),
    );
    await step("failure_notice", async () => {
      const failed = await dispatch.failedRunStreak();
      if (failed !== null) card(await dispatch.raiseFailureNotice(failed, at));
    });
    return counts;
  };
  // 8. The learning item's two steps, after the others, the kill switch on or off, since they
  // record and change nothing: the links from each send to what followed it, then the
  // assessments. Each is its own transaction, so a failure undoes nothing written before it. It is
  // logged with its code, the other step still runs, and the tick then fails with it.
  let failure: unknown;
  const outcomes = async (counts: TickCounts): Promise<TickCounts> => {
    for (const [key, step] of [
      ["links", () => dispatch.matchOutcomes(at)],
      ["assessed", () => dispatch.assessOutcomes(at)],
    ] as const) {
      try {
        counts[key] = await step();
      } catch (error) {
        log.error({ event: "outcomes_failed", code: codeOf(error) });
        failure ??= error;
      }
    }
    return counts;
  };
  const result = await dispatch.withWorkLock(async () => outcomes(await effects()));
  if (result === "already_running") return result;
  const { failed, ...counted } = result;
  log.info({ event: "work_tick", counts: failed === undefined ? counted : { ...counted, steps_failed: failed } });
  if (failure !== undefined) throw failure;
  return result;
}

// The warning counts the last tick logged, from PI_WORK_STATE, a small JSON file of pi's on the
// volume: counts by event code alone. One missing or unreadable is none.
async function readWarned(path: string | undefined): Promise<Record<string, number> | undefined> {
  if (path === undefined || path === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const kept = Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {}).filter(
      (entry): entry is [string, number] => /^[a-z][a-z0-9_]{0,63}$/.test(entry[0]) && Number.isSafeInteger(entry[1]),
    );
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

// The command: the dispatch from PI_DATABASE_URL_WORK and PI_ERASURE_JOURNAL, and no key file. It
// exits 0 when the tick ended or another tick holds the lock, and fails otherwise. For the coverage
// report: one ledger.job_runs row at its end, whatever its outcome, as pi_work. A row
// that cannot be written is logged by its code and changes nothing of the exit. Its code is
// `steps_failed` when a step failed, so a run of them is a failure streak; the trigger rows' marks
// run only with PI_WORK_SHADOW_TRIGGERS=1 (the clock's rechecks run on every tick); and a warning is logged again only when its count
// changed, the counts kept in PI_WORK_STATE when it is set.
export function tickCommand({ env, log }: CommandContext): Promise<0 | 1> {
  return withJobRun(
    { url: env.PI_DATABASE_URL_WORK ?? "", log },
    { job: "work_tick" },
    async () => {
      const dispatch = createDispatch({
        url: env.PI_DATABASE_URL_WORK ?? "",
        log,
        journal: env.PI_ERASURE_JOURNAL ?? "",
      });
      const state = env.PI_WORK_STATE;
      const warned = await readWarned(state);
      const before = JSON.stringify(warned ?? {});
      try {
        const result = await runTick({
          dispatch,
          registry: REGISTRY,
          log,
          now: () => new Date(),
          shadowTriggers: env.PI_WORK_SHADOW_TRIGGERS === "1",
          ...(warned === undefined ? {} : { warned }),
        });
        if (result === "already_running") log.info({ event: "already_running" });
        return result === "already_running" ? result : (result.failed ?? 0) > 0 ? "steps_failed" : "ok";
      } finally {
        // Kept whatever the tick's end, a failed outcome step's included.
        if (warned !== undefined && state !== undefined && JSON.stringify(warned) !== before)
          await writeFile(state, `${JSON.stringify(warned)}\n`, { mode: 0o600 }).catch(() =>
            log.warn({ event: "work_state_unwritten", code: "unavailable" }),
          );
        await dispatch.close();
      }
    },
    { ofError: codeOf, ofResult: (code) => code },
  ).then(() => 0 as const);
}
