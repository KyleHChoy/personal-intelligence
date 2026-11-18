import { CardLoadSeries, LedgerDay, LedgerFeed, LedgerLanes, SpendSeries } from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { Admin } from "../admin.ts";
import { eventCursor } from "./admin-ledger.ts";

// Made-up ids and values.

const TIMEOUT = 120_000;
const DAY = "2026-10-20";
const at = (time: string): string => `${DAY}T${time}:00.000Z`;
const LATER = new Date("2026-10-21T12:00:00.000Z");

let store: TestStore;
let admin: Admin;
const ids: {
  r1: string;
  r2: string;
  r3: string;
  move: string;
  opportunity: string;
  client: string;
  clientName: string;
  answered?: string;
} = {
  r1: "",
  r2: "",
  r3: "",
  move: "",
  opportunity: "",
  client: "",
  clientName: "",
};

const asAdmin = <Row = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  queryAs<Row>(store.db.urls.admin, text, values);

// One statement as pi_owner, the table's owner, past its forced row security: to set a time the
// table's own writer gives as now().
const asOwner = (table: string, text: string, values: unknown[]): Promise<unknown> =>
  session(store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} force row level security`);
    }
  });

const event = (
  rowKind: string,
  rowId: string,
  name: string,
  when: string,
  by = "system:test",
  compartments = ["own"],
  code: string | null = null,
) =>
  asAdmin(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ($1, $2, $3, $4, $5, $6, $7)",
    [rowKind, rowId, name, when, by, compartments, code],
  );

const run = async (createdAt: string): Promise<string> => {
  const id = testId("run");
  await asAdmin(
    `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, $3, 'system:test', '{own}', 'daily_sweep', $4, 'wake_worth_run', 1, 'personal_run', '1')`,
    [id, testId("req"), createdAt, `test:${id}`],
  );
  return id;
};

const card = async (expiresAt: string | null = null, expiresAfterDays: number | null = null): Promise<string> => {
  const id = testId("crd");
  await asAdmin(
    "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments, expires_at, expires_after_days) values ($1, $2, $3, 'system:test', 'notice', '{acknowledge}', '{own}', $4, $5)",
    [id, testId("req"), at("00:00"), expiresAt, expiresAfterDays],
  );
  return id;
};

beforeAll(async () => {
  store = await openStore({ now: LATER, compartments: ["own", "employer:example"], writer: false });
  admin = store.admin;

  // Runs: one on the day, ended; one the evening before, still open; one the next UTC night.
  ids.r1 = await run(at("10:00"));
  await event("run", ids.r1, "running", at("10:00"));
  await event("run", ids.r1, "done", at("10:05"), "system:work", ["own"], "ok");
  ids.r2 = await run("2026-10-19T23:00:00.000Z");
  await event("run", ids.r2, "running", "2026-10-19T23:00:00.000Z");
  ids.r3 = await run("2026-10-21T03:00:00.000Z");

  // A move on the day, planned and reported by its client; a read log of two items shown.
  // One seeder for every seeded row, so no two of its clients share a name.
  const { sessionId, clientId, firstMove } = await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    await seed.into("ledger.moves")(["own"]);
    const [first] = await query<{ id: string }>("select id from ledger.moves");
    // Two more moves, for the moves never reported: their events come later.
    await seed.into("ledger.moves")(["own"]);
    await seed.into("ledger.moves")(["own"]);
    const { id, clientId: reader } = (await seed.into("ledger.sessions")(["own"])) as { id: string; clientId: string };
    // Claims: one in the owner's audience and one outside it, both made on the day. The owner's
    // audience is every compartment of a claim of a belief type: the own claim is a commitment, the
    // employer's a plan, which builds no belief.
    await seed.claim(["own"], undefined, "commitment");
    await seed.claim(["employer:example"]);
    // A run's step, made a model call below.
    await seed.into("ledger.run_steps")(["own"]);
    // A sync on the day, from 06:00 to 06:10: what it read is its accounts' outcomes recorded while
    // it ran; one recorded after it ended is another sync's.
    const account = await seed.sourceAccount(["own"]);
    for (const [at6, counts] of [
      ["06:02", [12, 9, 2, 1, 0]],
      ["06:08", [3, 2, 0, 0, 1]],
      ["06:30", [50, 50, 0, 0, 0]],
    ] as const) {
      await queryAs(
        store.db.urls.writer,
        `insert into vault.sync_outcomes (account_id, sync_kind, started_at, code, added, decided, stored, junk, held, removed, compartments)
         select id, 'fast', $2, 'ok', null, $3, $4, $5, $6, $7, compartments from vault.source_accounts where id = $1`,
        [account, at(at6), ...counts],
      );
    }
    await queryAs(
      store.db.urls.writer,
      "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('sync', 'fast', false, $1, $2, 'ok')",
      [at("06:00"), at("06:10")],
    );
    await queryAs(
      store.db.urls.writer,
      "insert into ledger.job_runs (job, sync_kind, read_hold, started_at, ended_at, code) values ('sync', 'fast', false, $1, $2, 'reconnect_google')",
      [at("07:00"), at("07:01")],
    );
    return { sessionId: id, clientId: reader, firstMove: first?.id };
  });
  // A work model call the next UTC night, 03:00, which is the owner's evening of the day in Chicago.
  await asOwner(
    "ledger.run_steps",
    `update ledger.run_steps set kind = 'model_call', status = null, tool = null, code = null, prompt_id = 'personal_run', prompt_version = '1', model_id = 'seed/model',
       cost_microusd = 400000, created_at = '2026-10-21T03:00:00.000Z'`,
    [],
  );
  const [move] = await asAdmin<{ id: string; opportunity_id: string; client_id: string; name: string }>(
    "select m.id, m.opportunity_id, a.client_id, k.name from ledger.moves m join ledger.assignments a on a.id = m.assignment_id join policy.clients k on k.id = a.client_id where m.id = $1",
    [firstMove],
  );
  if (move === undefined) throw new Error("no move");
  Object.assign(ids, {
    move: move.id,
    opportunity: move.opportunity_id,
    client: move.client_id,
    clientName: move.name,
  });
  await asOwner("ledger.moves", "update ledger.moves set created_at = $2 where id = $1", [ids.move, at("11:00")]);
  await event("move", ids.move, "cleared", at("11:00"), `client:${ids.client}`);
  await event("move", ids.move, "done", at("11:30"), `client:${ids.client}`);
  await session(store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'search', $3, '{own}', '{}', $4, '{}')",
      [sessionId, clientId, at("12:00"), ["a".repeat(64), "b".repeat(64)]],
    );
  });

  await asOwner("knowledge.claims", "update knowledge.claims set created_at = $1", [at("09:00")]);

  // The owner's decisions: a release and a send on the day.
  for (const [kind, time] of [
    ["release", "13:00"],
    ["send", "14:00"],
  ] as const) {
    await asAdmin(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, $3, 0, '{}', '{}', $4, '{own}')",
      [testId("rul"), testId("req"), kind, at(time)],
    );
  }

  // Spend: extraction and dream on the day, and dream under a restricted compartment, which the
  // page leaves out as spendToday does.
  for (const [lane, micro, compartments] of [
    ["extract", 1_500_000, ["own"]],
    ["dream", 250_000, ["own"]],
    ["dream", 9_000_000, ["restricted:health"]],
  ] as const) {
    await asAdmin(
      "insert into vault.model_usage (id, prompt_id, prompt_version, model_id, input_tokens, output_tokens, cost_microusd, outcome, day, compartments, lane) values ($1, 'personal_test', '1', 'seed/model', 1, 1, $2, 'ok', $3, $4, $5)",
      [testId("mus"), micro, DAY, compartments, lane],
    );
  }

  // Cards: one pending the day before and answered on the day; one pending from the day on; one
  // pending on the day that expired that evening.
  const answered = await card();
  ids.answered = answered;
  await event("card", answered, "pending", "2026-10-19T10:00:00.000Z");
  await event("card", answered, "answered", at("09:00"), "owner");
  const waiting = await card();
  await event("card", waiting, "pending", at("08:00"));
  const lapsed = await card(at("20:00"));
  await event("card", lapsed, "pending", at("08:00"));
  // And one that lapses a day after it waited, by its days alone: still waiting at the day's end.
  const relative = await card(null, 1);
  await event("card", relative, "pending", at("08:00"));
}, TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("the owner's ledger", { timeout: TIMEOUT }, () => {
  it("R-L1: a day's tally counts its runs, moves, items shown, claims in the owner's audience, decisions and sends, and spend by lane", async () => {
    const day = await admin.ledger.day(DAY);
    expect(LedgerDay.parse(day)).toEqual(day);
    expect(day).toEqual({
      day: DAY,
      runs: 1,
      moves: 1,
      spend: [
        { lane: "work", usd: 0 },
        { lane: "extraction", usd: 1.5 },
        { lane: "dream", usd: 0.25 },
      ],
      itemsRead: 2,
      claimsMade: 1,
      decisions: 1,
      sends: 1,
    });
    // The owner's day is in their zone: in Chicago the run of the next UTC night is their evening.
    await admin.accounts.setTimeZone("America/Chicago");
    try {
      const local = await admin.ledger.day(DAY);
      expect(local.runs).toBe(2);
      // And so is spend: the model call of the next UTC night is the owner's day's work.
      expect(local.spend.find((one) => one.lane === "work")?.usd).toBe(0.4);
    } finally {
      await asAdmin("update policy.owner_settings set time_zone = null");
    }
    expect((await admin.ledger.day("2026-10-10")).runs).toBe(0);
  });

  it("R-L2: a day's lanes: each run the reasoner's, the move its client's to its report, an open run open, a sync with what it read", async () => {
    const lanes = await admin.ledger.lanes(DAY);
    expect(LedgerLanes.parse(lanes)).toEqual(lanes);
    expect(lanes.spans).toEqual([
      { worker: "reasoner", from: "2026-10-19T23:00:00.000Z", to: null, work: ids.r2 },
      {
        worker: "pipeline",
        from: at("06:00"),
        to: at("06:10"),
        work: null,
        read: { decided: 15, stored: 11, junk: 2, held: 1, removed: 1 },
        code: "ok",
      },
      // A sync that recorded no outcome, and failed: no counts, and why it stopped.
      { worker: "pipeline", from: at("07:00"), to: at("07:01"), work: null, code: "reconnect_google" },
      { worker: "reasoner", from: at("10:00"), to: at("10:05"), work: ids.r1 },
      { worker: `client:${ids.clientName}`, from: at("11:00"), to: at("11:30"), work: ids.opportunity },
    ]);
    expect((await admin.ledger.lanes("2026-10-10")).spans).toEqual([]);
  });

  it("R-L3: the feed pages every event newest first, naming clients by name and each event's piece of work", async () => {
    // The owner's decision on a card names the card, as the card read shows it.
    await event("card", ids.answered as string, "decided", at("09:01"), "owner", ["own"], "acknowledge");
    const first = await admin.ledger.feed({ limit: 2 });
    expect(LedgerFeed.parse(first)).toEqual(first);
    const all = [...first.events];
    const works = [...first.works];
    const cards = [...first.cards];
    let next = first.next;
    while (next !== null) {
      const page = await admin.ledger.feed({ limit: 2, cursor: next });
      all.push(...page.events);
      works.push(...page.works);
      cards.push(...page.cards);
      // Each page names the opportunities its events belong to, and no other.
      const held = new Set(page.events.map((one) => one.work));
      expect(page.works.every((one) => held.has(one.work))).toBe(true);
      next = page.next;
    }
    // The opportunity's summary, opened as the agent's words, so its row reads as what it is.
    expect(works).toContainEqual({ work: ids.opportunity, summary: { untrusted: "Seed opportunity" } });
    // Every card an event of the feed is on, the system's too, by what it asks.
    const onCards = new Set(all.flatMap((one) => (one.row.kind === "card" ? [one.row.id] : [])));
    expect(onCards.size).toBeGreaterThan(1);
    expect(new Set(cards.map((one) => one.id))).toEqual(onCards);
    expect(cards.find((one) => one.id === ids.answered)).toMatchObject({ kind: "notice", state: "decided" });
    // Shown, not opened: no view of it is recorded.
    const [views] = await asAdmin<{ n: number }>(
      "select count(*)::int as n from ledger.owner_views where target_id = $1",
      [ids.answered],
    );
    expect(views?.n).toBe(0);
    const [total] = await asAdmin<{ n: number }>("select count(*)::int as n from ledger.record_events");
    expect(all).toHaveLength(total?.n ?? -1);
    expect(all.map((one) => one.id)).toEqual([...all.map((one) => one.id)].sort((a, b) => b - a));
    const done = all.find((one) => one.row.id === ids.move && one.event === "done");
    expect(done).toMatchObject({
      row: { kind: "move", id: ids.move },
      by: `client:${ids.clientName}`,
      work: ids.opportunity,
      code: null,
    });
    expect(all.find((one) => one.row.id === ids.r1 && one.event === "done")).toMatchObject({
      by: "system:work",
      work: ids.r1,
      code: "ok",
    });
    await expect(
      admin.ledger.feed({ cursor: Buffer.from(JSON.stringify(["x"])).toString("base64url") }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("R-L5: spend by the owner's day and lane, and pending cards at the end of each day", async () => {
    const later = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, now: () => LATER });
    const spend = await later.ledger.spendSeries(3);
    expect(SpendSeries.parse(spend)).toEqual(spend);
    expect(spend.days.map((one) => one.day)).toEqual([
      "2026-10-19",
      "2026-10-19",
      "2026-10-19",
      DAY,
      DAY,
      DAY,
      "2026-10-21",
      "2026-10-21",
      "2026-10-21",
    ]);
    expect(spend.days.filter((one) => one.usd > 0)).toEqual([
      { day: DAY, lane: "extraction", usd: 1.5 },
      { day: DAY, lane: "dream", usd: 0.25 },
      { day: "2026-10-21", lane: "work", usd: 0.4 },
    ]);
    // In Chicago the model call is the owner's evening of the day, never the UTC day's.
    await admin.accounts.setTimeZone("America/Chicago");
    try {
      expect((await later.ledger.spendSeries(3)).days.filter((one) => one.lane === "work" && one.usd > 0)).toEqual([
        { day: DAY, lane: "work", usd: 0.4 },
      ]);
    } finally {
      await asAdmin("update policy.owner_settings set time_zone = null");
    }
    const load = await later.ledger.cardLoadSeries(3);
    expect(CardLoadSeries.parse(load)).toEqual(load);
    expect(load.days).toEqual([
      { day: "2026-10-19", pending: 1 },
      { day: DAY, pending: 2 },
      { day: "2026-10-21", pending: 1 },
    ]);
    // Today's point is counted at now, not at the day's end: the card that lapses this evening
    // still waits at noon, so the series ends on the count the waiting list shows (one definition).
    const noon = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      now: () => new Date(at("12:00")),
    });
    const waitingNow = (await noon.cards.listPending({})).length;
    expect(waitingNow).toBe(3);
    expect((await noon.ledger.cardLoadSeries(1)).days).toEqual([{ day: DAY, pending: waitingNow }]);
  });

  // A move never reported runs from its plan to its last step, never to now; one its agent still
  // holds the claim for may still report, and says when that claim runs out. Seeded on the next day
  // (now is its noon), after the reads above, so their counts stand.
  it("R-L2: a move never reported ends at its last step, and one still held says when its claim runs out", async () => {
    const NEXT = (time: string): string => `2026-10-21T${time}:00.000Z`;
    // The two moves seeded with the first, which no event has named yet.
    const added = await asAdmin<{ id: string; opportunity_id: string; client_id: string; name: string }>(
      "select m.id, m.opportunity_id, a.client_id, k.name from ledger.moves m join ledger.assignments a on a.id = m.assignment_id join policy.clients k on k.id = a.client_id where m.id <> $1 order by m.id",
      [ids.move],
    );
    const [quiet, held] = added;
    if (quiet === undefined || held === undefined) throw new Error("no moves");
    // The quiet one: planned at 08:00, its agent picked the work up again at 08:20 (its last step),
    // and the system put it back on the board at 09:00, which is not its agent's step.
    await asOwner("ledger.moves", "update ledger.moves set created_at = $2 where id = $1", [quiet.id, NEXT("08:00")]);
    await event("opportunity", quiet.opportunity_id, "claimed", NEXT("07:55"), `client:${quiet.client_id}`);
    await event("move", quiet.id, "cleared", NEXT("08:00"), `client:${quiet.client_id}`);
    await event("opportunity", quiet.opportunity_id, "claimed", NEXT("08:20"), `client:${quiet.client_id}`);
    await event("opportunity", quiet.opportunity_id, "go", NEXT("09:00"), "system:lease", ["own"], "lease_expired");
    // After the work left it, its agent picked it up again with no new start: not this move's step.
    await event("opportunity", quiet.opportunity_id, "claimed", NEXT("09:30"), `client:${quiet.client_id}`);
    // The held one: planned at 11:30 under a claim taken at 11:20 that runs to 12:20.
    await asOwner("ledger.moves", "update ledger.moves set created_at = $2 where id = $1", [held.id, NEXT("11:30")]);
    await event("move", held.id, "cleared", NEXT("11:30"), `client:${held.client_id}`);
    const lease = (opportunity: string, holder: string, taken: string, until: string) =>
      asOwner(
        "queue.leases",
        "insert into queue.leases (resource_kind, resource_id, holder, lease_until, first_taken_at) values ('opportunity', $1, $2, $3, $4)",
        [opportunity, holder, until, taken],
      );
    // The quiet one's lease of its agent's lapsed at 08:25: no longer held.
    await lease(quiet.opportunity_id, quiet.client_id, NEXT("07:55"), NEXT("08:25"));
    await lease(held.opportunity_id, held.client_id, NEXT("11:20"), NEXT("12:20"));

    const lanes = await admin.ledger.lanes("2026-10-21");
    expect(LedgerLanes.parse(lanes)).toEqual(lanes);
    expect(lanes.spans.filter((one) => one.worker.startsWith("client:"))).toEqual([
      {
        worker: `client:${quiet.name}`,
        from: NEXT("08:00"),
        to: null,
        work: quiet.opportunity_id,
        lastStep: NEXT("08:20"),
      },
      {
        worker: `client:${held.name}`,
        from: NEXT("11:30"),
        to: null,
        work: held.opportunity_id,
        lastStep: NEXT("11:30"),
        heldUntil: NEXT("12:20"),
      },
    ]);

    // The next day, with both claims run out, neither is drawn on to now.
    const later = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      now: () => new Date("2026-10-22T00:30:00.000Z"),
    });
    expect((await later.ledger.lanes("2026-10-22")).spans.filter((one) => one.worker.startsWith("client:"))).toEqual(
      [],
    );
    // A claim taken again after the plan (a lapse and a new claim) does not hold the old move.
    await asOwner("queue.leases", "update queue.leases set first_taken_at = $2 where resource_id = $1", [
      held.opportunity_id,
      NEXT("11:40"),
    ]);
    expect(
      (await admin.ledger.lanes("2026-10-21")).spans.find((one) => one.work === held.opportunity_id),
    ).not.toHaveProperty("heldUntil");
  });
});

describe("R-L4: the event stream's poll", { timeout: TIMEOUT }, () => {
  it("delivers an event committed out of order inside the lag window once, and never one outside the key file's compartments", async () => {
    const insert =
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:test', $2) returning id::int as id";
    const [top] = await asAdmin<{ n: number }>("select coalesce(max(id), 0)::int as n from ledger.record_events");
    // A stream opened at the top delivers nothing above it yet.
    let polled = await admin.ledger.events(eventCursor(top?.n ?? 0));
    expect(polled.events.every((one) => one.id <= (top?.n ?? 0))).toBe(true);

    // A takes its id first and commits last; B commits between.
    const slow = new pg.Client({ connectionString: store.db.urls.admin });
    await slow.connect();
    try {
      await slow.query("begin");
      const a = (await slow.query<{ id: number }>(insert, [testId("crd"), ["own"]])).rows[0]?.id;
      const [b] = await asAdmin<{ id: number }>(insert, [testId("crd"), ["own"]]);
      const [hidden] = await asAdmin<{ id: number }>(insert, [testId("crd"), ["restricted:health"]]);
      expect(a).toBeLessThan(b?.id ?? 0);

      polled = await admin.ledger.events(polled.cursor);
      expect(polled.events.map((one) => one.id)).toEqual([b?.id]);
      expect(polled.cursor.after).toBe(b?.id);

      await slow.query("commit");
      polled = await admin.ledger.events(polled.cursor);
      expect(polled.events.map((one) => one.id)).toEqual([a]);
      expect(polled.cursor.after).toBe(b?.id);

      // Once: neither again, however often it polls inside the window.
      for (let n = 0; n < 3; n += 1) {
        polled = await admin.ledger.events(polled.cursor);
        expect(polled.events).toEqual([]);
      }
      expect(hidden?.id).toBeGreaterThan(b?.id ?? 0);
      // The control: a new event after them is delivered.
      const [c] = await asAdmin<{ id: number }>(insert, [testId("crd"), ["own"]]);
      polled = await admin.ledger.events(polled.cursor);
      expect(polled.events.map((one) => one.id)).toEqual([c?.id]);
      // A stream reopened at the top (a reconnect) delivers the window at or below it again, so a
      // late commit is never lost between two streams; the page keeps each id once.
      const reopened = await admin.ledger.events(eventCursor(c?.id ?? 0));
      expect(reopened.events.map((one) => one.id)).toEqual(expect.arrayContaining([a, b?.id, c?.id]));
    } finally {
      await slow.end();
    }
  });
});
