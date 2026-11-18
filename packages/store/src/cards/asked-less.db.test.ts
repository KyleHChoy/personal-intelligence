import {
  type CardId,
  DECISION_POINT_PINS,
  type DecisionPointCall,
  type MoveId,
  type OpportunityId,
  type RequestId,
  type RunId,
  type RunRequest,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { closeHealth, raiseHealth } from "../core/box-health.ts";
import { request, sha256Hex, testId } from "../test-support/clients.ts";
import { type Query, session } from "../test-support/connections.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { type WorkWorld as LedgerWorld, withWorkWorld as withLedgerWorld } from "../test-support/work-fixtures.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { actionsDue, type WakeCandidate } from "../work/dispatch-wakes.ts";
import { queueRun } from "../work/dispatch-write.ts";
import { ASKED_LESS_BY, BOX_HEALTH_QUIET_HOURS, OUTCOME_SAMPLE_WEEKLY, outcomeSampled } from "./asked-less.ts";

// Made-up values only.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Wednesday at noon, far enough ahead that no week under test holds another test's cards.
const BASE = new Date("2031-01-01T12:00:00.000Z");
const BOTH = ["employer:example", "own"];

// A week, from BASE on, in which a move is drawn for the owner's sample, or is not.
function weekWhere(move: string, drawn: boolean): Date {
  for (let n = 0; n < 2000; n += 1) {
    const at = new Date(BASE.getTime() + n * 7 * DAY);
    if (outcomeSampled(move, at, 0) === drawn) return at;
  }
  throw new Error("no such week");
}

type Reported = { agent: WorkClient; opportunity: string; move: MoveId; evidence: string };
let threads = 0;

// An agent's report, with a summary, on work a policy sent it: what raises an outcome card on a move.
async function reported(world: LedgerWorld, outcome: "done" | "failed" | "blocked" = "done"): Promise<Reported> {
  threads += 1;
  const agent = await world.agent();
  const intent = await world.intent(["meeting_prep"], [agent.id], { mode: "policy" });
  await world.harness(agent, "meeting_prep", "prepare");
  const sent = await world.mail({ direction: "outbound", thread: `asked-less-${threads}` });
  const inbound = await world.mail({ direction: "inbound", thread: `asked-less-${threads}` });
  const { id } = await world.opportunity({
    refs: [
      ["message", inbound.id],
      ["message", sent.id],
    ],
  });
  await world.decision(id, "go", { by: "policy", intent });
  const move = await world.claimAndPlan(agent, id, "prepare");
  // The report answers the work's new status: done, or, after any other end, handed to the owner.
  expect(await world.report(agent, move, outcome, "a summary of what was prepared")).toBe(
    outcome === "done" ? "done" : "handed_to_owner",
  );
  return { agent, opportunity: id, move: move as MoveId, evidence: inbound.evidence };
}

type CardRow = { id: CardId; kind: string; events: { event: string; by: string; code: string | null }[] };
const cardsOn = async (world: LedgerWorld, target: string): Promise<CardRow[]> => {
  const cards = await world.admin<{ id: CardId; kind: string }>(
    "select id, kind from ledger.cards where target_id = $1 order by created_at, id",
    [target],
  );
  const rows: CardRow[] = [];
  for (const card of cards)
    rows.push({
      ...card,
      events: await world.admin(
        "select event, by, code from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
        [card.id],
      ),
    });
  return rows;
};
const decisionsOn = (world: LedgerWorld, card: string) =>
  world.admin("select id from knowledge.owner_decisions where card_id = $1", [card]);

const judged = (world: LedgerWorld, opportunity: string, evidence: string, kind: string, compartments: string[]) =>
  world.owner(
    `insert into ledger.outcome_links (opportunity_id, expected_outcome_id, evidence_id, kind, path, judge, attribution, applied, move_result_link_id, compartments)
     values ($1, null, $2, $3, 'watched', 'rule', 'caused', true, null, $4)`,
    [opportunity, evidence, kind, compartments],
  );

async function asOwner<T>(
  world: { db: LedgerWorld["db"] },
  now: Date,
  fn: (admin: ReturnType<typeof createAdmin>) => Promise<T>,
): Promise<T> {
  const admin = createAdmin({
    url: world.db.urls.admin,
    keys: world.db.keys,
    log: recordingLogger().log,
    now: () => now,
  });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

describe("a report's outcome and the owner", { timeout: DB_TEST_TIMEOUT }, () => {
  it("raises the owner's card for a report in the week's sample, once", () =>
    withLedgerWorld(async (world) => {
      const { move, agent } = await reported(world);
      const now = weekWhere(move, true);
      const dispatch = world.dispatch();
      const card = await dispatch.raiseOutcomeCard({ kind: "move", id: move }, now);
      expect(card).not.toBeNull();
      expect(await cardsOn(world, move)).toEqual([
        { id: card, kind: "outcome", events: [{ event: "pending", by: `client:${agent.id}`, code: null }] },
      ]);
      expect(await dispatch.raiseOutcomeCard({ kind: "move", id: move }, now)).toBeNull();
      expect(await dispatch.reportsWithoutCard()).not.toContain(move);
      expect(await cardsOn(world, move)).toHaveLength(1);
    }));

  it("settles a report outside the sample by code, with the report's own label, and never as the owner", () =>
    withLedgerWorld(async (world) => {
      const dispatch = world.dispatch();
      for (const [outcome, code] of [
        ["done", "settled_met"],
        ["failed", "settled_not_met"],
        ["blocked", "settled_unjudged"],
      ] as const) {
        const { move, agent, opportunity } = await reported(world, outcome);
        const now = weekWhere(move, false);
        if (outcome !== "done") {
          // A report that did not end done hands the work to the owner, whose Done or Drop is the card
          // then: the report has none until the owner has closed the work.
          expect(await dispatch.reportsWithoutCard(), outcome).not.toContain(move);
          expect(await dispatch.raiseOutcomeCard({ kind: "move", id: move }, now), outcome).toBeNull();
          expect(await cardsOn(world, move), outcome).toEqual([]);
          await world.status("opportunity", opportunity, "withdrawn");
        }
        expect(await dispatch.reportsWithoutCard(), outcome).toContain(move);
        expect(await dispatch.raiseOutcomeCard({ kind: "move", id: move }, now), outcome).toBeNull();
        const cards = await cardsOn(world, move);
        expect(cards, outcome).toHaveLength(1);
        expect(cards[0]?.events, outcome).toEqual([
          { event: "pending", by: `client:${agent.id}`, code: null },
          { event: "withdrawn", by: ASKED_LESS_BY, code },
        ]);
        // No answer of the owner's, and nothing the owner's answers are counted from.
        expect(await decisionsOn(world, cards[0]?.id ?? ""), outcome).toEqual([]);
        // A move has one outcome card ever: a second pass finds none to raise and writes nothing.
        expect(await dispatch.reportsWithoutCard(), outcome).not.toContain(move);
        expect(await dispatch.raiseOutcomeCard({ kind: "move", id: move }, now), outcome).toBeNull();
        expect(await cardsOn(world, move), outcome).toEqual(cards);
      }
    }));

  it("settles a drawn report once the week's sample is full", () =>
    withLedgerWorld(async (world) => {
      const { move } = await reported(world);
      const now = weekWhere(move, true);
      for (let n = 0; n < OUTCOME_SAMPLE_WEEKLY; n += 1)
        await world.card({ kind: "outcome", target: ["move", testId("mov")], at: new Date(now.getTime() - HOUR) });
      expect(await world.dispatch().raiseOutcomeCard({ kind: "move", id: move }, now)).toBeNull();
      expect((await cardsOn(world, move))[0]?.events.at(-1)).toEqual({
        event: "withdrawn",
        by: ASKED_LESS_BY,
        code: "settled_met",
      });
    }));

  it("takes the code judge's applied link before the report, and none outside the card's label", () =>
    withLedgerWorld(
      async (world) => {
        const dispatch = world.dispatch();
        const inside = await reported(world, "done");
        await judged(world, inside.opportunity, inside.evidence, "not_met", ["own"]);
        expect(
          await dispatch.raiseOutcomeCard({ kind: "move", id: inside.move }, weekWhere(inside.move, false)),
        ).toBeNull();
        expect((await cardsOn(world, inside.move))[0]?.events.at(-1)?.code).toBe("settled_not_met");

        // A link resting on evidence the card's label does not cover labels nothing (invariant 6).
        const outside = await reported(world, "done");
        const hidden = await world.mail({ compartments: ["employer:example"] });
        await judged(world, outside.opportunity, hidden.evidence, "not_met", BOTH);
        expect(
          await dispatch.raiseOutcomeCard({ kind: "move", id: outside.move }, weekWhere(outside.move, false)),
        ).toBeNull();
        expect((await cardsOn(world, outside.move))[0]?.events.at(-1)?.code).toBe("settled_met");
      },
      { compartments: BOTH },
    ));

  it("always raises the card of work handed to the owner", () =>
    withLedgerWorld(async (world) => {
      const dispatch = world.dispatch();
      for (let n = 0; n < 4; n += 1) {
        const event = await world.event();
        const { id } = await world.opportunity({ kind: "reply", about: ["event", event], refs: [["event", event]] });
        await world.status("opportunity", id, "handed_to_owner");
        const card = await dispatch.raiseOutcomeCard({ kind: "opportunity", id: id as OpportunityId }, BASE);
        expect(card).not.toBeNull();
        expect((await cardsOn(world, id))[0]?.events.map((one) => one.event)).toEqual(["pending"]);
      }
    }));

  it("gives a settled card back on the owner's reopen, and the report counts it honestly each side of that", () =>
    withLedgerWorld(async (world) => {
      const { move, opportunity } = await reported(world);
      const now = weekWhere(move, false);
      const status = await world.latest("opportunity", opportunity);
      expect(await world.dispatch().raiseOutcomeCard({ kind: "move", id: move }, now)).toBeNull();
      const [card] = await cardsOn(world, move);
      const measures = async () => {
        const metrics = await ownerQuestions(
          world.admin,
          new Date(now.getTime() - DAY).toISOString(),
          new Date(now.getTime() + DAY).toISOString(),
          ["own"],
        );
        const of = (name: string) => metrics.find((one) => one.metric === name);
        return {
          asked: of("owner_questions_per_week")?.sample,
          settledByCode: of("owner_questions_per_week")?.parts?.settled_by_code,
          settled: of("settled_without_owner_overturned")?.parts?.settled,
          overturned: of("settled_without_owner_overturned")?.parts?.overturned,
        };
      };
      // Settled: no question of the owner's, one thing settled without the owner, none overturned.
      expect(await measures()).toEqual({ asked: 0, settledByCode: 1, settled: 1, overturned: 0 });

      await asOwner(world, new Date(now.getTime() + HOUR), (admin) =>
        admin.cards.reopenExpiredCard(card?.id as CardId),
      );
      expect((await cardsOn(world, move))[0]?.events.at(-1)).toEqual({ event: "pending", by: "owner", code: null });
      // No status of the work moved: settling moved none, and the reopen gives none back.
      expect(await world.latest("opportunity", opportunity)).toBe(status);
      // Reopened: it reached the owner, and what code settled was overturned.
      expect(await measures()).toEqual({ asked: 1, settledByCode: 0, settled: 1, overturned: 1 });
      // The owner then answers it as any card.
      await asOwner(world, new Date(now.getTime() + 2 * HOUR), (admin) =>
        admin.cards.decide({ cards: [card?.id as CardId], answer: "dismiss", requestId: testId("req") as RequestId }),
      );
      expect(await decisionsOn(world, card?.id ?? "")).toHaveLength(1);
    }));
});

describe("every lesson is asked", { timeout: DB_TEST_TIMEOUT }, () => {
  // An open lesson with no card, citing `support` of the owner's decisions.
  // Each lesson is a case of its own, as a run's are (the fixture alone would merge them into one).
  async function lesson(world: LedgerWorld, support: number, at: Date, refs: [string, string][] = []): Promise<string> {
    const caseId = testId("cas");
    const run = testId("run");
    await world.owner(
      `insert into ledger.cases (id, request_id, created_at, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author, hypothesis_id)
       values ($1, $1, $2, $3, $4, '{own}', 'hypothesis', 'lesson', 'owner', null, 'run', null)`,
      [caseId, at, `run:${run}`, run],
    );
    const { id } = await world.hypothesis({ kind: "lesson", about: "owner", at, caseId, refs });
    for (let n = 0; n < support; n += 1)
      await world.owner(
        `insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, source_class, owner_backed, compartments)
         values ('hypothesis', $1, 'decision', $2, 'owner', true, '{own}')`,
        [id, testId("rul")],
      );
    return id;
  }
  const lessonsDue = async (world: LedgerWorld): Promise<string[]> =>
    (await world.dispatch().plannerHypothesesWithoutCard()).filter((one) => one.kind === "lesson").map((one) => one.id);

  it("asks every open lesson, the most supported first, the oldest first among equals, and every idea", () =>
    withLedgerWorld(async (world) => {
      const made = new Date(BASE.getTime() - 30 * DAY);
      const supports = [1, 4, 0, 3, 3, 6, 2];
      const ids: string[] = [];
      for (const [n, support] of supports.entries())
        ids.push(await lesson(world, support, new Date(made.getTime() + n * HOUR)));
      const mail = await world.mail();
      const idea = await world.hypothesis({ kind: "idea", about: ["message", mail.id], refs: [["message", mail.id]] });

      expect(await lessonsDue(world)).toEqual([ids[5], ids[1], ids[3], ids[4], ids[6], ids[0], ids[2]]);
      expect((await world.dispatch().plannerHypothesesWithoutCard()).map((one) => one.id)).toContain(idea.id);

      // The tick raises every one; none waits for a later week.
      for (const id of await lessonsDue(world))
        expect(await world.dispatch().raisePlannerCard(id as never, "lesson", BASE)).not.toBeNull();
      expect(await lessonsDue(world)).toEqual([]);
      for (const id of ids) expect(await cardsOn(world, id ?? "")).toHaveLength(1);
    }));

  it("a lesson whose basis a veto covers is never asked, and holds no other back", () =>
    withLedgerWorld(async (world) => {
      const made = new Date(BASE.getTime() - 30 * DAY);
      const person = await world.person();
      const covered: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        const mail = await world.mail({ person: person.id });
        covered.push(await lesson(world, 9, made, [["message", mail.id]]));
      }
      const askable: string[] = [];
      for (let n = 0; n < 3; n += 1) askable.push(await lesson(world, 3 - n, made));
      expect(await lessonsDue(world)).toEqual([...covered, ...askable]);

      // The owner vetoes the person: no card is raised on those five, and the rest are asked.
      await world.veto("person", [person.fp]);
      for (const id of covered) expect(await world.dispatch().raisePlannerCard(id as never, "lesson", BASE)).toBeNull();
      expect(await lessonsDue(world)).toEqual(askable);
      for (const id of askable)
        expect(await world.dispatch().raisePlannerCard(id as never, "lesson", BASE)).not.toBeNull();
      expect(await lessonsDue(world)).toEqual([]);
      for (const id of covered) {
        expect(await world.latest("hypothesis", id)).toBe("open");
        expect(await cardsOn(world, id)).toEqual([]);
      }
    }));

  it("lesson cards already raised this week hold no lesson back", () =>
    withLedgerWorld(async (world) => {
      const ids: string[] = [];
      for (let n = 0; n < 4; n += 1) ids.push(await lesson(world, 4 - n, new Date(BASE.getTime() - 30 * DAY)));
      for (let n = 0; n < 7; n += 1)
        await world.card({
          kind: "lesson",
          target: ["hypothesis", testId("hyp")],
          at: new Date(BASE.getTime() - HOUR),
        });
      expect(await lessonsDue(world)).toEqual(ids);
    }));
});

// The lessons run recipe of owner-actions-block.db.test.ts: a decision of the owner's, the run the
// tick queues for it, taken by the reasoner.
const RUN: DecisionPointCall = {
  point: "wake_worth_run",
  version: 1,
  definitionHash: DECISION_POINT_PINS["wake_worth_run@1"] ?? "",
  rung: 0,
  inputHash: sha256Hex("wake_worth_run:run"),
  output: "run",
  effect: "start_run",
  effectClass: "internal_reversible",
  escalated: false,
};

async function asTick<T>(w: WorkWorld, fn: (query: Query) => Promise<T>): Promise<T> {
  return session(w.db.urls.work, async (query) => {
    await query("begin");
    const result = await fn(query);
    await query("commit");
    return result;
  });
}

async function ownerDecision(w: WorkWorld, compartments: string[] = ["own"]): Promise<string> {
  const id = testId("rul");
  await w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'commitment_close', null, null, 'done', 0, '{}', '{}', clock_timestamp(), $3)`,
    [id, testId("req"), compartments],
  );
  return id;
}

async function lessonsRun(
  w: WorkWorld,
  reasoner: WorkClient,
  clearance: string[],
  batches: number,
): Promise<RunRequest> {
  const queued = await asTick(w, async (query) => {
    const due = await actionsDue(query, clearance, batches);
    if (due === null) return null;
    const candidate: WakeCandidate = {
      source: "lessons_due",
      wakeKey: due.key,
      anchors: [],
      compartments: due.block.compartments,
      vetoed: false,
      lessons: [],
      decisions: due.block.decisions,
      cursor: due.block.cursor,
    };
    return queueRun(query, candidate, RUN, new Date());
  });
  expect(queued).not.toBeNull();
  const run = ok(await w.work.nextRun(reasoner.token, { requestId: request() })).run;
  if (run === null) throw new Error("no run was taken");
  return run;
}

const lessonsOf = (w: WorkWorld, run: string) =>
  w.admin<{ id: string; refs: string[] }>(
    `select h.id, array(select b.ref_id from ledger.basis b where b.row_kind = 'hypothesis' and b.row_id = h.id order by b.ref_id collate "C") as refs
     from ledger.hypotheses h where h.run_id = $1 and h.kind = 'lesson' order by h.id`,
    [run],
  );

describe("a lessons run writes no exact duplicate", { timeout: DB_TEST_TIMEOUT }, () => {
  it("writes a lesson stated twice once, with both bases, and none that already stands", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const first = [await ownerDecision(w), await ownerDecision(w)].sort();
      const run = await lessonsRun(w, reasoner, ["own"], 1);
      const decision = (id: string | undefined) => ({ kind: "decision" as const, id: id as never });
      expect(
        ok(
          await w.work.finishRun(reasoner.token, {
            run: run.id as RunId,
            outcome: "finished",
            output: {
              lessons: [
                { lesson: "Ask before booking travel.", basis: [decision(first[0])] },
                { lesson: "  ask before  booking TRAVEL. ", basis: [decision(first[1])] },
                { lesson: "Keep replies short.", basis: [decision(first[0])] },
              ],
            },
            requestId: request(),
          }),
        ).outcome,
      ).toBe("finished");
      const written = await lessonsOf(w, run.id);
      expect(written.map((one) => one.refs).sort((a, b) => b.length - a.length)).toEqual([first, [first[0]]]);

      // A later run that states a standing lesson again, in the same words, writes only what is new.
      const later = await ownerDecision(w);
      const next = await lessonsRun(w, reasoner, ["own"], 2);
      expect(
        ok(
          await w.work.finishRun(reasoner.token, {
            run: next.id as RunId,
            outcome: "finished",
            output: {
              lessons: [
                { lesson: "keep replies short.", basis: [decision(later)] },
                { lesson: "Send drafts before noon.", basis: [decision(later)] },
              ],
            },
            requestId: request(),
          }),
        ).outcome,
      ).toBe("finished");
      expect(await lessonsOf(w, next.id)).toHaveLength(1);
      expect(await w.admin("select count(*)::int as n from ledger.hypotheses where kind = 'lesson'")).toEqual([
        { n: 3 },
      ]);

      // A run whose every lesson already stands writes none, and still finishes.
      const last = await ownerDecision(w);
      const none = await lessonsRun(w, reasoner, ["own"], 3);
      expect(
        ok(
          await w.work.finishRun(reasoner.token, {
            run: none.id as RunId,
            outcome: "finished",
            output: { lessons: [{ lesson: "Send drafts before noon.", basis: [decision(last)] }] },
            requestId: request(),
          }),
        ).outcome,
      ).toBe("finished");
      expect(await lessonsOf(w, none.id)).toEqual([]);
    }));

  it("writes again a lesson that stands only outside the run's label", () =>
    withWorkWorld(async (w) => {
      const wide = await w.client("reasoner", BOTH, { kind: "reasoner" });
      const decision = (id: string) => ({ kind: "decision" as const, id: id as never });
      // A lesson standing under both compartments.
      const work = await ownerDecision(w, ["employer:example"]);
      const both = await lessonsRun(w, wide, BOTH, 1);
      ok(
        await w.work.finishRun(wide.token, {
          run: both.id as RunId,
          outcome: "finished",
          output: { lessons: [{ lesson: "Keep replies short.", basis: [decision(work)] }] },
          requestId: request(),
        }),
      );
      expect(await lessonsOf(w, both.id)).toHaveLength(1);
      // A run under `own` alone is not compared with it: what it may not read changes nothing it writes.
      const own = await ownerDecision(w);
      const narrow = await lessonsRun(w, wide, ["own"], 2);
      expect(narrow.id).not.toBe(both.id);
      ok(
        await w.work.finishRun(wide.token, {
          run: narrow.id as RunId,
          outcome: "finished",
          output: { lessons: [{ lesson: "Keep replies short.", basis: [decision(own)] }] },
          requestId: request(),
        }),
      );
      expect(await lessonsOf(w, narrow.id)).toHaveLength(1);
    }, BOTH));
});

describe("a box health card and the owner's queue", { timeout: DB_TEST_TIMEOUT }, () => {
  const inAdmin = <T>(world: LedgerWorld, fn: (query: Query) => Promise<T>): Promise<T> =>
    session(world.db.urls.admin, async (query) => {
      await query("begin");
      const result = await fn(query);
      await query("commit");
      return result;
    });
  // What the owner is shown and told waits, at a moment.
  const seen = (world: LedgerWorld, now: Date) =>
    asOwner(world, now, async (admin) => ({
      queue: (await admin.cards.listPending({ limit: 50 })).map((card) => card.id).sort(),
      waiting: (await admin.work.status()).cards.pending,
      digest: (await admin.cards.digest()).pending.box_health ?? 0,
      open: await admin.box.openHealthCount(),
    }));

  it("is out of the queue and its counts for its quiet hours, on record throughout, and in them after", () =>
    withLedgerWorld(async (world) => {
      const raised = BASE;
      const card = await inAdmin(world, (query) => raiseHealth(query, raised, world.log, "backup_due", "backup"));
      expect(card).not.toBeNull();
      // Another kind's card raised at the same moment is the owner's at once.
      const other = await world.card({ kind: "outcome", target: ["move", testId("mov")], at: raised });

      for (const hours of [0, 1, BOX_HEALTH_QUIET_HOURS - 1]) {
        const at = await seen(world, new Date(raised.getTime() + hours * HOUR));
        expect(at, `${hours}h`).toEqual({ queue: [other], waiting: 1, digest: 0, open: 1 });
      }
      for (const hours of [BOX_HEALTH_QUIET_HOURS, BOX_HEALTH_QUIET_HOURS + 1, 100]) {
        const at = await seen(world, new Date(raised.getTime() + hours * HOUR));
        expect(at, `${hours}h`).toEqual({ queue: [card, other].sort(), waiting: 2, digest: 1, open: 1 });
      }
      // The owner may mark it seen by its id at any time, inside the quiet hours too.
      await asOwner(world, new Date(raised.getTime() + HOUR), (admin) =>
        admin.cards.decide({ cards: [card as CardId], answer: "seen", requestId: testId("req") as RequestId }),
      );
      expect((await seen(world, new Date(raised.getTime() + 100 * HOUR))).queue).toEqual([other]);
    }));

  it("a hold's card is the owner's at once: a hold stops reads or sync", () =>
    withLedgerWorld(async (world) => {
      const raised = BASE;
      const hold = await inAdmin(world, (query) => raiseHealth(query, raised, world.log, "hold", "read_hold"));
      const other = await inAdmin(world, (query) => raiseHealth(query, raised, world.log, "timed_out", "sync"));
      expect(hold).not.toBeNull();
      expect(other).not.toBeNull();
      for (const hours of [0, 1, BOX_HEALTH_QUIET_HOURS - 1]) {
        const at = await seen(world, new Date(raised.getTime() + hours * HOUR));
        expect(at, `${hours}h`).toEqual({ queue: [hold], waiting: 1, digest: 1, open: 2 });
      }
      const after = await seen(world, new Date(raised.getTime() + BOX_HEALTH_QUIET_HOURS * HOUR));
      expect(after).toEqual({ queue: [hold, other].sort(), waiting: 2, digest: 2, open: 2 });
      // The ledger's card load counts it from its first day, and the other from its second.
      const load = await asOwner(world, new Date(raised.getTime() + 30 * HOUR), (admin) =>
        admin.ledger.cardLoadSeries(2),
      );
      expect(load.days.map((day) => day.pending)).toEqual([1, 2]);
    }));

  it("never reaches the owner when its condition ends inside the quiet hours", () =>
    withLedgerWorld(async (world) => {
      const raised = BASE;
      const card = await inAdmin(world, (query) => raiseHealth(query, raised, world.log, "backup_due", "backup"));
      expect((await seen(world, new Date(raised.getTime() + 22 * HOUR))).queue).toEqual([]);
      expect(
        await inAdmin(world, (query) =>
          closeHealth(query, new Date(raised.getTime() + 23 * HOUR), "backup_due", "backup"),
        ),
      ).toBe(card);
      for (const hours of [23, 25, 100])
        expect(await seen(world, new Date(raised.getTime() + hours * HOUR)), `${hours}h`).toEqual({
          queue: [],
          waiting: 0,
          digest: 0,
          open: 0,
        });
    }));
});
