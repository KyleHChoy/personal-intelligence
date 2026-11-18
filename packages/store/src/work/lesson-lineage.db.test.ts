import type { EntityId } from "@intelligence/contracts/personal";
import { afterAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { journalPath } from "../core/journal.ts";
import { sealUnder } from "../core/seal.ts";
import { LESSON_IN_FORCE } from "../core/statements.ts";
import { testId } from "../test-support/clients.ts";
import { ownerCommitted as asOwner } from "../test-support/connections.ts";
import { copyTestDatabase, createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createWriter } from "../write/writer.ts";

// Erasing the person a task was about: the lessons of the run shown the owner's task decision are
// retired, confirmed or not; a lesson of a run not shown it stays in force; a restore from a dump taken
// before the erasure, replayed from the journal, retires them again. Synthetic values only.

const OWN = ["own"];
const log = eventLogger();
const dbs: TestDatabase[] = [];

afterAll(async () => {
  for (const db of dbs) await db.drop().catch(() => {});
}, SLOW_DB_TEST_TIMEOUT);

const adminOf = (db: TestDatabase, journal: string): Admin =>
  createAdmin({ url: db.urls.admin, keys: db.keys, log, journal, now: () => WORLD_NOW, recordEnabled: true });

// A task about a person, and the owner's task_add decision on it, as `pi task add` writes them.
async function task(db: TestDatabase, person: string): Promise<string> {
  const caseId = testId("cas");
  const id = testId("opp");
  await asOwner(db, async (query) => {
    await query(
      "insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $1, 'owner', $2, 'opportunity', 'investigate', 'entity', $3, 'owner')",
      [caseId, OWN, person],
    );
    await query(
      "insert into ledger.opportunities (id, request_id, created_by, compartments, case_id, kind, about_kind, about_id, proposed_by_class, tier) values ($1, $1, 'owner', $2, $3, 'investigate', 'entity', $4, 'owner', 'task')",
      [id, OWN, caseId, person],
    );
  });
  const ruling = testId("rul");
  await queryAs(
    db.urls.admin,
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'task_add', 'opportunity', $3, 0, '{}', '{}', now(), $4)`,
    [ruling, testId("req"), id, OWN],
  );
  return ruling;
}

// A lessons run whose row records the decisions it was shown, and its lessons, each on its card
// (`open`) or confirmed by the owner. None cites anything.
async function lessonsRun(db: TestDatabase, decisions: string[], lessons: ("open" | "confirmed")[]): Promise<string[]> {
  const run = testId("run");
  const ids = lessons.map(() => testId("hyp"));
  // As the tick, pi_work, queues it.
  await queryAs(
    db.urls.work,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version, decisions)
     values ($1, $2, 'system:tick', $3, 'lessons_due', $4, 'run_outcome', 1, 'personal_lessons', '5', $5)`,
    [run, testId("req"), OWN, `lessons:${run}`, decisions],
  );
  await asOwner(db, async (query) => {
    for (const [i, id] of ids.entries()) {
      const caseId = testId("cas");
      await query(
        "insert into ledger.cases (id, request_id, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $1, $2, $3, $4, 'hypothesis', 'lesson', 'owner', null, 'run')",
        [caseId, `run:${run}`, run, OWN],
      );
      await query(
        `insert into ledger.hypotheses (id, request_id, created_by, run_id, compartments, case_id, kind, about_kind, about_id, about_owner, body_enc)
         values ($1, $1, $2, $3, $4, $5, 'lesson', 'owner', null, true, $6::jsonb)`,
        [
          id,
          `run:${run}`,
          run,
          OWN,
          caseId,
          JSON.stringify(
            sealUnder(db.keys, OWN, { table: "ledger.hypotheses", id, column: "body_enc" }, "canary-la5 lesson"),
          ),
        ],
      );
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'open', clock_timestamp(), $2, $3)",
        [id, `run:${run}`, OWN],
      );
      if (lessons[i] === "confirmed") {
        await query(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'confirmed', clock_timestamp(), 'owner', $2)",
          [id, OWN],
        );
      }
    }
  });
  return ids;
}

const inForce = async (db: TestDatabase): Promise<string[]> =>
  (
    await queryAs<{ id: string }>(
      db.urls.admin,
      `select h.id from ledger.hypotheses h where ${LESSON_IN_FORCE} order by h.id collate "C"`,
    )
  ).map((row) => row.id);

const lessonRows = (db: TestDatabase, ids: string[]) =>
  queryAs<{ id: string; tainted: boolean; body: boolean; latest: string }>(
    db.urls.admin,
    `select h.id, h.tainted_at is not null as tainted, h.body_enc is not null as body,
       (select e.event || '/' || e.by from ledger.record_events e where e.row_kind = 'hypothesis' and e.row_id = h.id order by e.id desc limit 1) as latest
     from ledger.hypotheses h where h.id = any($1) order by h.id`,
    [ids],
  );

const cards = async (db: TestDatabase): Promise<number> =>
  (await queryAs<{ n: number }>(db.urls.admin, "select count(*)::int as n from ledger.cards"))[0]?.n ?? 0;

describe("an erasure retires the lessons of runs shown a decision it reached", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("erasing the person a task was about retires its run's lessons, confirmed or not, keeps the others, and a restore's replay retires them again", async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const journal = journalPath(db.keyFile);
    let blake = "" as EntityId;
    let shown: string[] = [];
    let others: string[] = [];
    {
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
      const admin = adminOf(db, journal);
      try {
        const world = await seedWorld(writer, admin);
        blake = world.entityOf(WORLD.both.address) as EntityId;
        const pat = world.entityOf(WORLD.ownOnly.address) as EntityId;
        const blakeTask = await task(db, blake);
        const patTask = await task(db, pat);
        // The run shown blake's task decision (beside pat's), and a run shown pat's alone.
        shown = await lessonsRun(db, [patTask, blakeTask], ["confirmed", "open"]);
        others = await lessonsRun(db, [patTask], ["confirmed"]);
        expect(await inForce(db)).toEqual([shown[0], others[0]].sort());
      } finally {
        await admin.close();
        await writer.close();
      }
    }
    // The dump a restore would bring back, taken before the erasure.
    const dump = await copyTestDatabase(db);
    dbs.push(dump);

    const admin = adminOf(db, journal);
    try {
      const cardsBefore = await cards(db);
      const dry = await admin.erasure.erasePerson(blake, { requestId: testId("req").slice(4), dryRun: true });
      expect(dry.more.shown_lessons).toBe(2);
      expect(await inForce(db)).toEqual([shown[0], others[0]].sort());

      const report = await admin.erasure.erasePerson(blake, { requestId: testId("req").slice(4) });
      expect(report.more.shown_lessons).toBe(2);
      const retired = new Map((await lessonRows(db, [...shown, ...others])).map((row) => [row.id, row]));
      // The one in force is retired and the one on its card withdrawn, each with its body gone.
      expect(retired.get(shown[0]!)).toEqual({
        id: shown[0],
        tainted: true,
        body: false,
        latest: "retired/system:taint",
      });
      expect(retired.get(shown[1]!)).toEqual({
        id: shown[1],
        tainted: true,
        body: false,
        latest: "withdrawn/system:taint",
      });
      expect(retired.get(others[0]!)).toEqual({ id: others[0], tainted: false, body: true, latest: "confirmed/owner" });
      expect(await inForce(db)).toEqual([others[0]]);
      // No card tells the owner: the lesson is gone from those in force.
      expect(await cards(db)).toBe(cardsBefore);
      // A retired lesson cannot be lifted back into force.
      await expect(admin.work.retireLesson(shown[0] as never, { lift: true })).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await admin.close();
    }

    // The restore: the dump beside the journal the box kept; the replay retires them again.
    const restored = adminOf(dump, journal);
    try {
      expect(await inForce(dump)).toEqual([shown[0], others[0]].sort());
      expect(await restored.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      expect(await inForce(dump)).toEqual([others[0]]);
      const again = new Map((await lessonRows(dump, shown)).map((row) => [row.id, row]));
      expect(again.get(shown[0]!)).toEqual({
        id: shown[0],
        tainted: true,
        body: false,
        latest: "retired/system:taint",
      });
      expect(again.get(shown[1]!)).toEqual({
        id: shown[1],
        tainted: true,
        body: false,
        latest: "withdrawn/system:taint",
      });
      // A second replay changes nothing.
      expect(await restored.erasure.replayErasures()).toEqual({ applied: 0, journalled: 0 });
    } finally {
      await restored.close();
    }
  });
});
