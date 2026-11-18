import type { HypothesisId, ProposableKind } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs, session, sqlState } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import type { Work } from "./work.ts";

// `pia work report` counts, per lesson in force, the briefs that carried it, the moves that cited
// it and the owner's answers on their outcome cards. Made-up values only.

const OWN = ["own"];
const BOTH = ["employer:example", "own"];
const REPORT = {
  deliverable: "three people, each with the thread that shows the tie",
  next: "ask the owner which one to approach",
};

async function ownerLesson(w: WorkWorld, text: string): Promise<HypothesisId> {
  const id = testId("hyp");
  await w.admin("select ledger.add_owner_lesson($1, $2, $3::jsonb)", [
    id,
    testId("req"),
    JSON.stringify(sealUnder(w.db.keys, OWN, { table: "ledger.hypotheses", id, column: "body_enc" }, text)),
  ]);
  return id as HypothesisId;
}

async function agent(
  w: WorkWorld,
  name: string,
  compartments = OWN,
  kinds: ProposableKind[] = ["investigate"],
): Promise<{ client: WorkClient; intent: string }> {
  const client = await w.client(name, compartments);
  const intent = await w.intent(kinds, [client]);
  for (const kind of kinds) await w.harness(client, kind, "investigate");
  return { client, intent };
}

// An investigate opportunity about a message, decided go and claimed through `claimer` (its
// brief is served in that Work's session), its move planned through `planner`.
async function held(
  w: WorkWorld,
  client: WorkClient,
  intent: string,
  claimer: Work = w.work,
  planner: Work = claimer,
): Promise<{ opportunity: string; move: string }> {
  const about = await w.message();
  const ref = { kind: "message" as const, id: about.id as never };
  const { opportunity } = ok(
    await w.work.proposeOpportunity(client.token, {
      kind: "investigate",
      about: ref,
      summary: "investigate the cited message",
      basis: [ref],
      requestId: request(),
    }),
  );
  await w.decideGo(opportunity, intent);
  ok(await claimer.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
  const { move } = ok(
    await planner.planMove(client.token, { opportunity, stage: "investigate", requestId: request() }),
  );
  return { opportunity, move };
}

const report = (work: Work, client: WorkClient, move: string, lessonsApplied: string[]) =>
  work.reportMove(client.token, {
    move: move as never,
    outcome: "done",
    report: REPORT,
    lessonsApplied: lessonsApplied as HypothesisId[],
    requestId: request(),
  });

const kept = (w: WorkWorld, move: string) =>
  w
    .admin<{ lesson_id: string }>("select lesson_id from ledger.move_lessons where move_id = $1 order by lesson_id", [
      move,
    ])
    .then((rows) => rows.map((row) => row.lesson_id));

describe("lessons named in a report", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a report's lessonsApplied keeps the ids a brief of its session served, drops the rest with dropped as their count, and never refuses", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "reporter");
      const named = await ownerLesson(w, "served and named");
      const served = await ownerLesson(w, "served and not named");
      const retired = await ownerLesson(w, "retired, so never served");
      await w.status("hypothesis", retired, "retired", "owner");
      const ghost = testId("hyp");

      const first = await held(w, client, intent);
      // The claim's read log row names the lessons its brief served, and no other.
      const logged = await w.admin<{ session_id: string; lessons: string[] }>(
        "select session_id, lessons from ledger.read_log where client_id = $1 and tool = 'claim_opportunity'",
        [client.id],
      );
      expect(logged.map((row) => [...row.lessons].sort())).toEqual([[named, served].sort()]);
      const sessionId = logged[0]?.session_id;

      expect(ok(await report(w.work, client, first.move, [named, retired, ghost]))).toEqual({
        move: first.move,
        opportunity: "done",
        dropped: 2,
      });
      expect(
        await w.admin("select session_id, created_by, lesson_id from ledger.move_lessons where move_id = $1", [
          first.move,
        ]),
      ).toEqual([{ session_id: sessionId, created_by: `client:${client.id}`, lesson_id: named }]);
      expect(await w.latest("move", first.move)).toBe("done");

      // Never refused: a report naming only what was not served is recorded, with all dropped.
      const second = await held(w, client, intent);
      expect(ok(await report(w.work, client, second.move, [ghost]))).toEqual({
        move: second.move,
        opportunity: "done",
        dropped: 1,
      });
      expect(await kept(w, second.move)).toEqual([]);
      expect(await w.latest("move", second.move)).toBe("done");
      // All kept: no count.
      const third = await held(w, client, intent);
      expect(ok(await report(w.work, client, third.move, [served, named]))).toEqual({
        move: third.move,
        opportunity: "done",
      });
      expect(await kept(w, third.move)).toEqual([named, served].sort());
      // None named.
      const fourth = await held(w, client, intent);
      expect(ok(await report(w.work, client, fourth.move, []))).toEqual({ move: fourth.move, opportunity: "done" });
      expect(await kept(w, fourth.move)).toEqual([]);

      // In the function: more than ten ids, or one twice, or one off the id form is refused.
      const direct = (ids: string[]) =>
        sqlState(() =>
          readAs(w.db, client.token, (query) =>
            query(
              "select * from ledger.report_move($1::text, 'done', $2::text, $3::text, null, '{}'::text[], '{}'::text[], $4::text[])",
              [fourth.move, testId("req"), client.session, ids],
            ),
          ),
        );
      expect(await direct(Array.from({ length: 11 }, () => testId("hyp")))).toBe("22023");
      expect(await direct([named, named])).toBe("22023");
      expect(await direct(["hyp_short"])).toBe("22023");
    }));

  it("an id served in another session of the same client is dropped", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "two-sessions");
      const lesson = await ownerLesson(w, "served in the first session only");
      // A second Reader on the same database opens a session of its own for the same client.
      const other = w.workWith(w.db.keys).work;
      const crossed = await held(w, client, intent, w.work, other);
      expect(ok(await report(other, client, crossed.move, [lesson]))).toEqual({
        move: crossed.move,
        opportunity: "done",
        dropped: 1,
      });
      expect(await kept(w, crossed.move)).toEqual([]);
      const sessions = await w.admin<{ n: number }>(
        "select count(distinct session_id)::int as n from ledger.read_log where client_id = $1",
        [client.id],
      );
      expect(sessions).toEqual([{ n: 2 }]);
      // The control: claimed in the second session, it is kept there.
      const same = await held(w, client, intent, other, other);
      expect(ok(await report(other, client, same.move, [lesson]))).toEqual({ move: same.move, opportunity: "done" });
      expect(await kept(w, same.move)).toEqual([lesson]);
    }));

  it("move_lessons carries the move's label", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "wide", BOTH);
      const lesson = await ownerLesson(w, "a lesson under own");
      const { move } = await held(w, client, intent);
      ok(await report(w.work, client, move, [lesson]));
      const [label] = await w.admin<{ compartments: string[] }>("select compartments from ledger.moves where id = $1", [
        move,
      ]);
      expect(await w.admin("select compartments from ledger.move_lessons where move_id = $1", [move])).toEqual([
        { compartments: label?.compartments },
      ]);
      // No runtime role but pi_admin reads it, and none writes it but the definer function.
      expect(
        await sqlState(() => readAs(w.db, client.token, (query) => query("select 1 from ledger.move_lessons"))),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          w.admin(
            "insert into ledger.move_lessons (created_by, session_id, move_id, lesson_id, compartments) values ($1, $2, $3, $4, '{own}')",
            [`client:${client.id}`, client.session, move, lesson],
          ),
        ),
      ).toBe("42501");
    }));

  it("the lessons section counts briefs, citations and the owner's answers on the citing moves' outcome cards, by ids and counts", () =>
    withWorkWorld(async (w) => {
      const { client, intent } = await agent(w, "counted");
      const cited = await ownerLesson(w, "cited twice");
      const quiet = await ownerLesson(w, "served, never cited");
      const retired = await ownerLesson(w, "retired before any brief");
      await w.status("hypothesis", retired, "retired", "owner");
      const moves = [await held(w, client, intent), await held(w, client, intent), await held(w, client, intent)];
      ok(await report(w.work, client, moves[0]?.move ?? "", [cited]));
      ok(await report(w.work, client, moves[1]?.move ?? "", [cited]));
      ok(await report(w.work, client, moves[2]?.move ?? "", []));
      // An outcome card on each move, as the tick raises one for a report, and the owner's answers.
      const card = async (move: string): Promise<string> => {
        const id = testId("crd");
        await w.admin(
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
           values ($1, $1, now(), 'reasoner', 'outcome', 'move', $2, '{acknowledge,dismiss}', 14, null, '{own}')`,
          [id, move],
        );
        await w.status("card", id, "pending", "reasoner");
        return id;
      };
      const cards = [
        await card(moves[0]?.move ?? ""),
        await card(moves[1]?.move ?? ""),
        await card(moves[2]?.move ?? ""),
      ];
      const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
      try {
        const admin = new Admin({ pool, keys: w.db.keys, log: w.log });
        await admin.cards.decide({ cards: [cards[0] as never], answer: "acknowledge", requestId: testId("req") });
        await admin.cards.decide({ cards: [cards[1] as never], answer: "dismiss", requestId: testId("req") });
        // An answer on a move that cited nothing counts for no lesson.
        await admin.cards.decide({ cards: [cards[2] as never], answer: "acknowledge", requestId: testId("req") });
        const { lessons } = await admin.work.report(7);
        expect(lessons.find((one) => one.lesson === cited)).toEqual({
          lesson: cited,
          briefs: 3,
          cited: 2,
          answers: { acknowledge: 1, dismiss: 1 },
        });
        expect(lessons.find((one) => one.lesson === quiet)).toEqual({
          lesson: quiet,
          briefs: 3,
          cited: 0,
          answers: {},
        });
        // Only lessons in force are listed.
        expect(lessons.map((one) => one.lesson)).not.toContain(retired);
        // Ids and counts only: nothing of a lesson's words.
        expect(JSON.stringify(lessons)).not.toMatch(/cited twice|served, never cited/);
        // A tainted move (an erasure reached it) counts for nothing: neither its citation nor the
        // owner's answer on its card. The row keeps no taint of its own; the move's is read.
        await session(w.db.urls.bootstrap, async (query) => {
          await query("begin");
          await query("set local role pi_owner");
          await query("update ledger.moves set tainted_at = now() where id = $1", [moves[1]?.move]);
          await query("commit");
        });
        const after = (await admin.work.report(7)).lessons;
        expect(after.find((one) => one.lesson === cited)).toEqual({
          lesson: cited,
          briefs: 3,
          cited: 1,
          answers: { acknowledge: 1 },
        });
      } finally {
        await pool.end();
      }
    }));

  it("log_read's earlier six-argument behaviour is unchanged", () =>
    withWorkWorld(async (w) => {
      const client = await w.client("logger", OWN);
      const goal = testId("gol");
      const lesson = testId("hyp");
      const call = (text: string, values: unknown[]) =>
        sqlState(() => readAs(w.db, client.token, (query) => query(text, values)));
      const rows = () =>
        w.admin(
          "select tool, bound, shown, fact_key_fps, goals, lessons from ledger.read_log where client_id = $1 order by id",
          [client.id],
        );
      expect(
        await call("select policy.log_read($1, 'list_opportunities', $2::text[], $3::text[], $4::text[], $5::text[])", [
          client.session,
          [],
          [],
          [],
          [goal],
        ]),
      ).toBeNull();
      expect(
        await call("select policy.log_read($1, 'list_opportunities', $2::text[], $3::text[], $4::text[])", [
          client.session,
          [],
          [],
          [],
        ]),
      ).toBeNull();
      expect(await rows()).toEqual([
        { tool: "list_opportunities", bound: [], shown: [], fact_key_fps: [], goals: [goal], lessons: [] },
        { tool: "list_opportunities", bound: [], shown: [], fact_key_fps: [], goals: [], lessons: [] },
      ]);
      // The seventh argument writes the lessons; one off the id form is refused.
      expect(
        await call(
          "select policy.log_read($1, 'list_opportunities', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], $2::text[])",
          [client.session, [lesson]],
        ),
      ).toBeNull();
      expect((await rows()).at(-1)).toEqual({
        tool: "list_opportunities",
        bound: [],
        shown: [],
        fact_key_fps: [],
        goals: [],
        lessons: [lesson],
      });
      expect(
        await call(
          "select policy.log_read($1, 'list_opportunities', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], $2::text[])",
          [client.session, ["hyp_short"]],
        ),
      ).toBe("23514");
      // Its refusals are as before: another client's session, and a tool the caller does not hold.
      const other = await w.client("other", OWN);
      expect(
        await call(
          "select policy.log_read($1, 'list_opportunities', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[])",
          [other.session],
        ),
      ).toBe("42501");
      expect(
        await call("select policy.log_read($1, 'not_a_tool', '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[])", [
          client.session,
        ]),
      ).toBe("42501");
      // Still the reader's alone.
      expect(
        await sqlState(() =>
          w.admin("select policy.log_read($1, 'list_opportunities', '{}'::text[], '{}'::text[], '{}'::text[])", [
            client.session,
          ]),
        ),
      ).toBe("42501");
    }));
});
