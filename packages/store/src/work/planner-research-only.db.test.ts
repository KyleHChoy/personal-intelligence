import {
  type CardId,
  DECISION_POINT_PINS,
  type DecisionPointCall,
  type HypothesisId,
  type RequestId,
  type RunTrial,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { createTestDatabase, queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { type WorkClient, type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";

// Under the `research_only` planner no wake queues an ideas or a
// translate run, the owner's `pi work run` is refused, a pursue on an idea card raised before the
// switch is recorded with no translate run, the reasoner takes only lessons runs, and the owner's
// mode command ends the queued runs of the retired stages; lessons still queue. `split` is the way back. The test databases run `split` unless asked (testing.ts), so
// each test names its mode. Made-up values only.

const TIMEOUT = 240_000;
const HOUR = 3_600_000;
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
const SKIP: DecisionPointCall = {
  ...RUN,
  inputHash: sha256Hex("wake_worth_run:skip"),
  output: "skip",
  effect: "record_silence",
  effectClass: "narrow",
};

const HAIKU: RunTrial = { model: "anthropic/claude-haiku-5.5", effort: "high" };
const planner = (w: WorkWorld, mode: string) => w.admin("update policy.work_settings set planner = $1", [mode]);

// A world where every kind of wake is due: the sweep, a meeting, a goal (whose goal_set is the
// owner's decision that, with lessons_every 1, wakes lessons), and a pending card.
async function everyWake(w: WorkWorld): Promise<{ now: Date; reasoner: WorkClient }> {
  const now = new Date();
  const reasoner = await w.reasoner(["own"]);
  await w.settings({ sweep_hour_utc: 0, lessons_every: 1 });
  await w.event({ startsAt: new Date(now.getTime() + 2 * HOUR) });
  await w.goal();
  const opportunity = await w.opportunity();
  await w.status("opportunity", opportunity.id, "no_go");
  const other = await w.opportunity({ kind: "investigate" });
  await w.card({ kind: "opportunity_decision", target: ["opportunity", other.id] });
  return { now, reasoner };
}

const sources = async (w: WorkWorld, now: Date): Promise<string[]> =>
  (await w.dispatch().wakeCandidates(now)).map((one) => one.source).sort();

describe("the research_only planner", () => {
  it(
    "queues no ideas run from any wake, and still queues lessons runs; split and one_pass are ways back",
    () =>
      withWorkWorld(async (w) => {
        const { now } = await everyWake(w);
        await planner(w, "split");
        expect(await sources(w, now)).toEqual(["calendar", "daily_sweep", "goal_changed", "lessons_due"]);
        // one_pass learns lessons too.
        await planner(w, "one_pass");
        expect(await sources(w, now)).toEqual(["calendar", "daily_sweep", "goal_changed", "lessons_due"]);
        await planner(w, "research_only");
        expect(await sources(w, now)).toEqual(["lessons_due"]);

        // A candidate read before the switch queues nothing after it; lessons queue under their own
        // prompt.
        await planner(w, "split");
        const before = await w.dispatch().wakeCandidates(now);
        await planner(w, "research_only");
        const dispatch = w.dispatch();
        for (const candidate of before) {
          const run = await dispatch.queueRun(candidate, RUN, now);
          if (candidate.source === "lessons_due") expect(run, candidate.source).not.toBeNull();
          else expect(run, candidate.source).toBeNull();
        }
        expect(await w.admin("select wake_source, prompt_id from ledger.runs order by wake_source")).toEqual([
          { wake_source: "lessons_due", prompt_id: "personal_lessons" },
        ]);
        // No silence either: the keys stay unused for the day ideas are back on.
        expect(await w.admin("select reason from ledger.silences")).toEqual([]);
        await planner(w, "split");
        expect(await sources(w, now)).toEqual(["calendar", "daily_sweep", "goal_changed"]);
      }),
    TIMEOUT,
  );

  it(
    "the reasoner takes only lessons runs, and an ideas run queued before the switch waits for split",
    () =>
      withWorkWorld(async (w) => {
        const { now, reasoner } = await everyWake(w);
        await planner(w, "split");
        const dispatch = w.dispatch();
        const byStage = new Map<string, string>();
        for (const candidate of await dispatch.wakeCandidates(now)) {
          const run = await dispatch.queueRun(candidate, RUN, now);
          if (run !== null) byStage.set(candidate.source, run);
        }
        expect([...byStage.keys()].sort()).toEqual(["calendar", "daily_sweep", "goal_changed", "lessons_due"]);
        await planner(w, "research_only");
        const taken = [await w.take(reasoner), await w.take(reasoner)];
        expect(taken[0]).toBe(byStage.get("lessons_due"));
        expect(taken[1]).toBeNull();
        await planner(w, "split");
        expect([byStage.get("calendar"), byStage.get("daily_sweep"), byStage.get("goal_changed")]).toContain(
          await w.take(reasoner),
        );
      }),
    TIMEOUT,
  );

  it(
    "the owner's run on request and an idea's translate run are refused with research_only; a pursue is recorded with no translate run",
    () =>
      withWorkWorld(async (w) => {
        await w.reasoner(["own"]);
        await planner(w, "research_only");
        const mail = await w.mail();
        const idea = await w.hypothesis({ kind: "idea", about: ["message", mail.id], refs: [["message", mail.id]] });
        const card = testId("crd") as CardId;
        await w.admin(
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
           values ($1, $1, now(), 'reasoner', 'idea', 'hypothesis', $2, '{pursue,not_now,no}', 30, '{own}')`,
          [card, idea.id],
        );
        await w.status("card", card, "pending", { by: "reasoner" });
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
        try {
          const facts = await admin.work.wakeFacts();
          expect(facts.source).toBe("owner_request");
          await expect(admin.work.queueRequestedRun({}, RUN, { requestId: testId("req") })).rejects.toMatchObject({
            code: "research_only",
          });
          await expect(
            admin.work.silenceRequestedRun({}, "budget", SKIP, { requestId: testId("req") }),
          ).rejects.toMatchObject({
            code: "research_only",
          });

          await admin.cards.decide({ cards: [card], answer: "pursue", requestId: testId("req") as RequestId });
          expect(await w.latest("hypothesis", idea.id)).toBe("pursued");
          expect(await w.admin("select id from ledger.runs")).toEqual([]);
          await expect(admin.work.queueIdeaRun(idea.id as HypothesisId)).rejects.toMatchObject({
            code: "research_only",
          });
          // Nor a trial of ideas or translate; a lessons trial is queued.
          await expect(admin.work.queueTrial({ stage: "ideas", trial: HAIKU })).rejects.toMatchObject({
            code: "research_only",
          });
          await expect(
            admin.work.queueTrial({ stage: "translate", trial: HAIKU, idea: idea.id as HypothesisId }),
          ).rejects.toMatchObject({ code: "research_only" });
          const lessons = await admin.work.queueTrial({ stage: "lessons", trial: HAIKU });
          expect(await w.admin("select prompt_id from ledger.runs where id = $1", [lessons])).toEqual([
            { prompt_id: "personal_lessons" },
          ]);

          // The way back: under split the pursued idea's translate run is queued on request.
          await planner(w, "split");
          const run = await admin.work.queueIdeaRun(idea.id as HypothesisId);
          expect(await w.admin("select wake_source, prompt_id from ledger.runs where id = $1", [run])).toEqual([
            { wake_source: "idea_pursued", prompt_id: "personal_translate" },
          ]);
          expect((await admin.work.status()).planner).toBe("split");
        } finally {
          await admin.close();
        }
      }),
    TIMEOUT,
  );

  it(
    "the owner's mode command ends every queued run of a retired stage, and leaves lessons runs and a taken run",
    () =>
      withWorkWorld(async (w) => {
        const { now, reasoner } = await everyWake(w);
        await planner(w, "split");
        const dispatch = w.dispatch();
        const candidates = await dispatch.wakeCandidates(now);
        // One ideas run taken before the switch is left to end as it would: the meeting's, queued
        // and taken first.
        const meeting = candidates.find((one) => one.source === "calendar");
        if (meeting === undefined) throw new Error("no meeting wake");
        await dispatch.queueRun(meeting, RUN, now);
        const taken = await w.take(reasoner);
        for (const candidate of candidates) if (candidate !== meeting) await dispatch.queueRun(candidate, RUN, now);
        const [takenRun] = await w.admin<{ prompt_id: string }>("select prompt_id from ledger.runs where id = $1", [
          taken,
        ]);
        expect(takenRun?.prompt_id).toBe("personal_ideas");
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
        try {
          await admin.work.setWorkBudget({ planner: "research_only", usd: 20 });
          expect((await admin.work.status()).planner).toBe("research_only");
        } finally {
          await admin.close();
        }
        const states = await w.admin<{ id: string; prompt_id: string; event: string; code: string | null; by: string }>(
          `select x.id, x.prompt_id, e.event, e.code, e.by from ledger.runs x
           join lateral (select r.event, r.code, r.by from ledger.record_events r where r.row_kind = 'run' and r.row_id = x.id order by r.id desc limit 1) e on true`,
        );
        for (const run of states) {
          if (run.id === taken) expect(run, "the taken run").toMatchObject({ event: "running", code: null });
          else if (run.prompt_id === "personal_lessons")
            expect(run, run.prompt_id).toMatchObject({ event: "queued", code: null });
          else
            expect(run, run.prompt_id).toMatchObject({ event: "stopped", code: "planner_research_only", by: "owner" });
        }
        expect(states.filter((run) => run.event === "stopped")).toHaveLength(2);
      }),
    TIMEOUT,
  );

  it(
    "no silence is written for a wake whose run the planner does not queue",
    () =>
      withWorkWorld(async (w) => {
        const { now } = await everyWake(w);
        await planner(w, "split");
        const candidates = await w.dispatch().wakeCandidates(now);
        await planner(w, "research_only");
        const dispatch = w.dispatch();
        for (const candidate of candidates) {
          const written = await dispatch.recordSilence(candidate, "budget", SKIP, now);
          expect(written, candidate.source).toBe(candidate.source === "lessons_due");
        }
        expect(
          (await w.admin<{ wake_source: string }>("select wake_source from ledger.silences order by wake_source")).map(
            (row) => row.wake_source,
          ),
        ).toEqual(["lessons_due"]);
      }),
    TIMEOUT,
  );
});

describe("the schema", () => {
  it(
    "makes research_only the column's default and the settings row's mode",
    async () => {
      const db = await createTestDatabase({ planner: "migrated" });
      try {
        expect(await queryAs(db.urls.admin, "select planner from policy.work_settings")).toEqual([
          { planner: "research_only" },
        ]);
        expect(
          await queryAs(
            db.urls.bootstrap,
            `select pg_get_expr(d.adbin, d.adrelid) as column_default from pg_attrdef d
             join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
             join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'policy' and c.relname = 'work_settings' and a.attname = 'planner'`,
          ),
        ).toEqual([{ column_default: "'research_only'::text" }]);
      } finally {
        await db.drop();
      }
    },
    TIMEOUT,
  );
});
