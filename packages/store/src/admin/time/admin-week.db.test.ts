import { BudgetView, LessonsView, SpendToday, TimeWeek, WeekEvents } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { sealUnder } from "../../core/seal.ts";
import { testId } from "../../test-support/clients.ts";
import { asTablesOwner, session } from "../../test-support/connections.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { warmthWorld } from "../../test-support/warmth-fixtures.ts";

// Rows are written as their stores write them, reserved names and made-up ids only. No model is
// called.

const NOW = new Date("2026-10-28T15:00:00.000Z");
const OWN = ["own"];
const WORK = ["employer:example"];
// A restricted item: its key is never in the general key file, and the read leaves it out unopened.
const RESTRICTED = ["own", "restricted:health"];

let store: TestStore;
// Meetings by name, as event ids; people by name, as entity ids.
const meetings: Record<string, string> = {};
let ada: string;
let ignored: string;
const lessonIds: Record<string, string> = {};

// One committed transaction as pi_owner, as the definer functions write.
const asOwner = (text: string, values: unknown[] = []): Promise<unknown> =>
  session(store.db.urls.bootstrap, async (query: Query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(text, values);
    await query("commit");
  });

const admin = <Row>(text: string, values: unknown[] = []): Promise<Row[]> =>
  session(store.db.urls.admin, (query) => query<Row>(text, values));

async function meeting(
  name: string,
  label: string[],
  people: string[],
  at: string,
  options: { cancelled?: boolean } = {},
): Promise<void> {
  const evidence = await warmthWorld(store.db).meeting(label, people, at, options);
  const [row] = await admin<{ id: string }>("select id from knowledge.events where evidence_id = $1", [evidence]);
  meetings[name] = row?.id ?? "";
}

// A lesson a lessons run proposed, still on its card: its case, the row and its `open` event.
async function proposedLesson(text: string): Promise<string> {
  const run = testId("run");
  const caseId = testId("cas");
  const id = testId("hyp");
  await asOwner(
    "insert into ledger.cases (id, request_id, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $1, $2, $3, $4, 'hypothesis', 'lesson', 'owner', null, 'run')",
    [caseId, `run:${run}`, run, OWN],
  );
  const body = JSON.stringify(
    sealUnder(store.db.keys, OWN, { table: "ledger.hypotheses", id, column: "body_enc" }, text),
  );
  await asOwner(
    `insert into ledger.hypotheses (id, request_id, created_by, run_id, compartments, case_id, kind, about_kind, about_id, about_owner, body_enc)
     values ($1, $1, $2, $3, $4, $5, 'lesson', 'owner', null, true, $6::jsonb)`,
    [id, `run:${run}`, run, OWN, caseId, body],
  );
  await asOwner(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'open', now(), $2, ledger.label($3))",
    [id, `run:${run}`, OWN],
  );
  return id;
}

beforeAll(async () => {
  store = await openStore({ now: NOW, compartments: ["own", "employer:example"] });
  // The owner's audience, which the withheld people are counted within: a belief built for both
  // compartments, over claims under each.
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    await seed.claim(WORK);
    await seed.claim(OWN);
    // Two people, each with an address of their own (one seeder numbers them apart).
    ada = await seed.entity("person");
    await seed.account(OWN, ada);
    ignored = await seed.entity("person");
    await seed.account(OWN, ignored);
  });
  await store.admin.ignores.addIgnore("entity", ignored, { requestId: testId("req") });

  // The week of Monday 26 October, the owner's zone unset (UTC).
  await meeting("monday", OWN, [ada, ignored], "2026-10-26T09:00:00.000Z");
  await meeting("work", WORK, [ada], "2026-10-29T16:00:00.000Z");
  await meeting("cancelled", OWN, [ada], "2026-10-27T09:00:00.000Z", { cancelled: true });
  await meeting("before", OWN, [ada], "2026-10-25T09:00:00.000Z");
  await meeting("restricted", OWN, [ada], "2026-10-28T09:00:00.000Z");
  // Relabelled as the tables' owner: no runtime role updates a label.
  const relabel = (text: string): Promise<unknown[]> =>
    asTablesOwner(store.db, ["knowledge.events", "knowledge.event_details"], (query) =>
      query(text, [meetings.restricted, RESTRICTED]),
    );
  expect(await relabel("update knowledge.events set compartments = $2 where id = $1 returning id")).toHaveLength(1);
  expect(
    await relabel("update knowledge.event_details set compartments = $2 where event_id = $1 returning event_id"),
  ).toHaveLength(1);

  // One block day of coding on Tuesday, an hour no project is credited, as the drain stores it.
  const capture = await session(store.db.urls.admin, (query) => seeder(store.db, query).capture(OWN));
  const work = {
    kind: "block",
    blocks: [
      {
        start: "2026-10-27T09:00:00.000Z",
        end: "2026-10-27T10:00:00.000Z",
        minutes: 60,
        bundle: "test.example.term",
        category: "coding",
      },
    ],
    cut: { blocks: 0, minutes: 0 },
  };
  await admin(
    `update knowledge.captures set kind = 'block', capture_key = 'block:' || substr(capture_key, 8), started_at = $2, ended_at = $3, minutes = 60, local_day = '2026-10-27', work_enc = $4::jsonb where id = $1`,
    [
      capture.id,
      "2026-10-27T09:00:00.000Z",
      "2026-10-27T10:00:00.000Z",
      JSON.stringify(
        sealUnder(
          store.db.keys,
          OWN,
          { table: "knowledge.captures", id: capture.id, column: "work_enc" },
          JSON.stringify(work),
        ),
      ),
    ],
  );

  // Spend: extraction and the dream today, extraction yesterday.
  const usage = (lane: string, day: string, micro: number, label = OWN) =>
    admin(
      `insert into vault.model_usage (id, prompt_id, prompt_version, model_id, input_tokens, output_tokens, cost_microusd, outcome, day, compartments, lane)
       values ($1, 'personal_correspondence', '1', 'seed/model', 10, 5, $2, 'ok', $3, $5, $4)`,
      [testId("mus"), micro, day, lane, label],
    );
  await usage("extract", "2026-10-28", 250_000);
  await usage("extract", "2026-10-28", 50_000);
  await usage("dream", "2026-10-28", 100_000);
  await usage("extract", "2026-10-27", 999_000);
  // A restricted item's extraction today: spend a restricted item caused is left out of the page.
  await usage("extract", "2026-10-28", 777_000, RESTRICTED);

  // Lessons: two in force (one for some kinds and roles), one retired, one pending, one rejected.
  lessonIds.plain = await store.admin.work.addLesson("Ask before the second follow-up.", {
    requestId: testId("req"),
  });
  lessonIds.scoped = await store.admin.work.addLesson("Cite the thread in every brief.", {
    requestId: testId("req"),
    kinds: ["research"],
    roles: ["researcher"],
  });
  const retired = await store.admin.work.addLesson("A lesson the owner retired.", { requestId: testId("req") });
  await store.admin.work.retireLesson(retired);
  lessonIds.pending = await proposedLesson("Group introductions by school.");
  const rejected = await proposedLesson("A lesson the owner rejected.");
  await asOwner(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'rejected', now(), 'owner', ledger.label($2))",
    [rejected, OWN],
  );
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("the owner's week and work settings", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("R-T6: the window's meetings in start order, the restricted, cancelled and outside ones left out, the ignored participant too", async () => {
    const answer = WeekEvents.parse(await store.admin.time.weekEvents("2026-10-26", "2026-11-01"));
    expect(answer.events.map((one) => one.id)).toEqual([meetings.monday, meetings.work]);
    expect(answer.more).toBe(false);
    const [monday] = answer.events;
    expect(monday?.participants.map((one) => one.id)).toEqual([ada]);
    expect(monday?.title).toEqual({ untrusted: expect.any(String) });
    expect(monday?.startsAt).toBe("2026-10-26T09:00:00.000Z");
    // The control: a window over the earlier day holds the meeting before.
    expect((await store.admin.time.weekEvents("2026-10-25", "2026-10-25")).events.map((one) => one.id)).toEqual([
      meetings.before,
    ]);
  });

  it("R-T6: refuses a window that ends before it starts or spans more than 31 days", async () => {
    await expect(store.admin.time.weekEvents("2026-10-26", "2026-10-25")).rejects.toThrow(AdminError);
    await expect(store.admin.time.weekEvents("2026-10-01", "2026-11-01")).rejects.toThrow(AdminError);
    // A date not of the form YYYY-MM-DD, here or in timeWeek.
    await expect(store.admin.time.weekEvents("2026-10-5", "2026-10-26")).rejects.toThrow(AdminError);
    await expect(store.admin.time.week("bad")).rejects.toThrow(AdminError);
    expect((await store.admin.time.weekEvents("2026-10-01", "2026-10-31")).events.length).toBeGreaterThan(0);
  });

  it("R-T7: the week's minutes by day and kind, none credited to a project, shown as unattributed", async () => {
    const week = TimeWeek.parse(await store.admin.time.week("2026-10-26"));
    expect(week.days.map((one) => [one.date, one.minutes])).toEqual([
      ["2026-10-26", 0],
      ["2026-10-27", 60],
      ["2026-10-28", 0],
      ["2026-10-29", 0],
      ["2026-10-30", 0],
      ["2026-10-31", 0],
      ["2026-11-01", 0],
    ]);
    expect(week.byKind).toEqual([{ kind: "coding", minutes: 60 }]);
    expect(week.byProject).toEqual([]);
    // Each day says its credited minutes by project: none here, as the week's.
    expect(week.days.map((one) => one.byProject)).toEqual([[], [], [], [], [], [], []]);
    expect(week.unattributed).toBe(60);
    // The control: the week before holds none of it.
    expect((await store.admin.time.week("2026-10-19")).unattributed).toBe(0);
  });

  it("R-T7: a day's minutes on two credited projects, each by its project, and the week's by project", async () => {
    // Two projects, each anchored by the app its block was in, and two blocks on one day of the
    // week of 12 October, which nothing else in this file touches.
    const request = () => ({ requestId: testId("req") });
    const alpha = await store.admin.projects.add("Alpha Survey", request());
    const beta = await store.admin.projects.add("Beta Ledger", request());
    await store.admin.projects.anchor(alpha, { kind: "app", value: "test.example.alpha" }, request());
    await store.admin.projects.anchor(beta, { kind: "app", value: "test.example.beta" }, request());
    const block = async (start: string, end: string, minutes: number, bundle: string): Promise<void> => {
      const capture = await session(store.db.urls.admin, (query) => seeder(store.db, query).capture(OWN));
      const work = {
        kind: "block",
        blocks: [{ start, end, minutes, bundle, category: "coding" }],
        cut: { blocks: 0, minutes: 0 },
      };
      await admin(
        `update knowledge.captures set kind = 'block', capture_key = 'block:' || substr(capture_key, 8), started_at = $2, ended_at = $3, minutes = $5, local_day = '2026-10-13', work_enc = $4::jsonb where id = $1`,
        [
          capture.id,
          start,
          end,
          JSON.stringify(
            sealUnder(
              store.db.keys,
              OWN,
              { table: "knowledge.captures", id: capture.id, column: "work_enc" },
              JSON.stringify(work),
            ),
          ),
          minutes,
        ],
      );
    };
    await block("2026-10-13T09:00:00.000Z", "2026-10-13T10:00:00.000Z", 60, "test.example.alpha");
    await block("2026-10-13T11:00:00.000Z", "2026-10-13T11:30:00.000Z", 30, "test.example.beta");

    const week = TimeWeek.parse(await store.admin.time.week("2026-10-12"));
    expect(week.days.map((one) => one.byProject)).toEqual([
      [],
      [
        { project: alpha, minutes: 60 },
        { project: beta, minutes: 30 },
      ],
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(week.byProject).toEqual([
      { project: alpha, name: { untrusted: "Alpha Survey" }, minutes: 60 },
      { project: beta, name: { untrusted: "Beta Ledger" }, minutes: 30 },
    ]);
    // The control: the week of the uncredited hour still credits no project.
    expect((await store.admin.time.week("2026-10-26")).byProject).toEqual([]);
  });

  it("R-T8: today's spend in every lane, the owner's local day's alone (UTC while their zone is unset), against each cap the database holds", async () => {
    await store.admin.work.setWorkBudget({ usd: 2.5 });
    const spend = SpendToday.parse(await store.admin.time.spendToday());
    expect(spend).toEqual({
      day: "2026-10-28",
      lanes: [
        { lane: "work", spentUsd: 0, capUsd: 2.5 },
        { lane: "extraction", spentUsd: 0.3, capUsd: null },
        { lane: "dream", spentUsd: 0.1, capUsd: relationRules().dream.usdPerNight },
      ],
    });
  });

  it("R-T9: every setting work budget sets, as it set them", async () => {
    await store.admin.work.setWorkBudget({
      runs: 7,
      usd: 1.25,
      cards: 9,
      inputChars: 4000,
      tokenPrice: 3,
      outputTokens: 2000,
      lessonsEvery: 6,
      sweepHour: 5,
    });
    expect(BudgetView.parse(await store.admin.time.budget())).toEqual({
      runs: 7,
      usd: 1.25,
      cards: 9,
      inputChars: 4000,
      tokenPrice: 3,
      outputTokens: 2000,
      lessonsEvery: 6,
      planner: expect.any(String),
      sweepHour: 5,
    });
  });

  it("R-T10: the lessons in force and pending, newest first, with their kinds and roles; retired and rejected ones left out", async () => {
    const answer = LessonsView.parse(await store.admin.time.lessons());
    expect(answer.lessons).toEqual([
      {
        id: lessonIds.pending,
        state: "pending",
        kinds: [],
        roles: [],
        text: { untrusted: "Group introductions by school." },
      },
      {
        id: lessonIds.scoped,
        state: "in_force",
        kinds: ["research"],
        roles: ["researcher"],
        text: { untrusted: "Cite the thread in every brief." },
      },
      {
        id: lessonIds.plain,
        state: "in_force",
        kinds: [],
        roles: [],
        text: { untrusted: "Ask before the second follow-up." },
      },
    ]);
  });

  // Last: it sets the owner's zone.
  it("R-T6: in the owner's zone, an all-day event is placed by its local day, after the evening before's meeting", async () => {
    await store.admin.accounts.setTimeZone("America/Chicago");
    // Monday 20:00 in Chicago, and Tuesday all day, stored at its UTC midnights.
    await meeting("evening", OWN, [ada], "2026-10-27T01:00:00.000Z");
    await meeting("allDay", OWN, [ada], "2026-10-27T00:00:00.000Z");
    expect(
      await admin(
        "update knowledge.event_details set all_day = true, starts_at = '2026-10-27T00:00:00Z', ends_at = '2026-10-28T00:00:00Z' where event_id = $1 returning event_id",
        [meetings.allDay],
      ),
    ).toHaveLength(1);
    const answer = WeekEvents.parse(await store.admin.time.weekEvents("2026-10-26", "2026-10-27"));
    expect(answer.events.map((one) => one.id)).toEqual([meetings.monday, meetings.evening, meetings.allDay]);
    expect(answer.events[2]).toMatchObject({
      allDay: true,
      date: "2026-10-27",
      lastDate: "2026-10-27",
      startsAt: null,
    });
  });

  // After the zone is set: spend is counted by the owner's local day, never the UTC day. At 15:00 UTC on
  // the 28th it is already the 29th at UTC+14.
  it("R-T8: in the owner's zone, today is their local day", async () => {
    await store.admin.accounts.setTimeZone("Pacific/Kiritimati");
    const spend = SpendToday.parse(await store.admin.time.spendToday());
    expect(spend.day).toBe("2026-10-29");
    expect(spend.lanes.find((one) => one.lane === "extraction")?.spentUsd).toBe(0);
  });
});
