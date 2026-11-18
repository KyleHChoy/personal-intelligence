import { OPEN_STATUSES } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, session } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import type { Connection } from "../test-support/waits.ts";
import {
  advisoryLocks as advisory,
  settled,
  waitingForLock as waiting,
  withConnections,
} from "../test-support/waits.ts";
import { insertWorkClient, type WorkClient } from "../test-support/work-clients.ts";

// A client's calls run as pi_reader under its token; the tick's writes run as pi_work, each one
// transaction that begins with ledger.lock_rows and reads the row's state only after it; the
// owner's go, which decide's card effect writes, runs as pi_admin under the same rule. pg_locks
// shows who waits for what.

const TIMEOUT = 180_000;
const TAINT_KEY = "intelligence personal ledger taint";
const KIND = "investigate";
const STAGE = "investigate";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// ---------------------------------------------------------------------------------------------
// Two connections, and the locks one of them holds or waits for (as owner-functions.db.test.ts)
// ---------------------------------------------------------------------------------------------

// The locks a backend holds only once it has written: a transaction id, or a relation lock
// stronger than a read's. A backend that has only read holds neither.
async function writeLocks(db: TestDatabase, pid: number): Promise<string[]> {
  const rows = await admin<{ line: string }>(
    db,
    `select locktype || ' ' || coalesce(relation::text, '') || ' ' || mode as line from pg_locks
     where pid = $1 and (locktype = 'transactionid' or (locktype = 'relation' and mode <> 'AccessShareLock'))`,
    [pid],
  );
  return rows.map((row) => row.line).sort();
}

const taintKey = async (db: TestDatabase): Promise<string> =>
  one(await admin<{ key: string }>(db, "select hashtext($1)::bigint::text as key", [TAINT_KEY])).key;
const rowKey = async (db: TestDatabase, id: string): Promise<string> =>
  one(await admin<{ key: string }>(db, "select hashtextextended($1, 0)::text as key", [id])).key;

// A reader connection's transaction under a client's token, set as the reader sets it.
async function beginAs(connection: Connection, token: string): Promise<void> {
  await connection.query("begin");
  await connection.query("select set_config('pi.client_token', $1, true)", [token]);
}

// ---------------------------------------------------------------------------------------------
// A small world: messages in SQL as pi_admin, an agent with an intent and an act harness mode
// for investigate, and opportunities proposed through the functions
// ---------------------------------------------------------------------------------------------

type Message = { id: string; evidence: string };

async function messages(db: TestDatabase, count: number): Promise<Message[]> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const made: Message[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = await seed.message(["own"]);
      const { evidence } = one(
        await query<{ evidence: string }>("select evidence_id as evidence from knowledge.messages where id = $1", [id]),
      );
      made.push({ id, evidence });
    }
    return made;
  });
}

// A confirmed intent that lists the client and the kind, and a harness mode `act` for its one
// stage, as `pi intent add` and `pi harness grant` write them.
async function grantWork(db: TestDatabase, client: WorkClient): Promise<string> {
  const intent = testId("int");
  await admin(
    db,
    `insert into policy.intents (id, goal_id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at)
     values ($1, null, $2, '{none}', $3, 'owner_decides', 5, now())`,
    [intent, [KIND], [client.id]],
  );
  await admin(
    db,
    "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, 'act', now())",
    [testId("hrn"), client.id, KIND, STAGE],
  );
  return intent;
}

type World = { agent: WorkClient; intent: string; messages: Message[] };

async function workWorld(db: TestDatabase, count: number): Promise<World> {
  const agent = await insertWorkClient(db, "order-agent", ["own"]);
  const intent = await grantWork(db, agent);
  return { agent, intent, messages: await messages(db, count) };
}

const proposeSql =
  "select ledger.propose_opportunity($1, $2, $3, $4, 'message', $5, null, null, $6, '{message}', $7::text[]) as id";
const proposeValues = (db: TestDatabase, client: WorkClient, message: Message): unknown[] => {
  const id = testId("opp");
  return [
    id,
    testId("req"),
    client.session,
    KIND,
    message.id,
    sealUnder(
      db.keys,
      client.compartments,
      { table: "ledger.opportunities", id, column: "body_enc" },
      "synthetic summary",
    ),
    [message.id],
  ];
};

async function propose(db: TestDatabase, client: WorkClient, message: Message): Promise<string> {
  const id = one(
    await readAs(db, client.token, (query) =>
      query<{ id: string | null }>(proposeSql, proposeValues(db, client, message)),
    ),
  ).id;
  if (id === null) throw new Error("propose_opportunity refused its positive control");
  return id;
}

// The owner's go under the intent, as decide's card effect writes it: as pi_admin, one transaction
// that begins with lock_rows on the opportunity.
async function ownerGo(db: TestDatabase, opportunity: string, intent: string): Promise<void> {
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query("select ledger.lock_rows($1::text[])", [[opportunity]]);
    const { compartments } = one(
      await query<{ compartments: string[] }>("select compartments from ledger.opportunities where id = $1", [
        opportunity,
      ]),
    );
    await query(
      `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
       values ($1, 'owner', $2, $3, 'go', 'owner', 4, 'owner_answer', $4)`,
      [testId("req"), compartments, opportunity, intent],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'go', now(), 'owner', $2)",
      [opportunity, compartments],
    );
    await query("commit");
  });
}

async function goOpportunity(db: TestDatabase, world: World, message: Message): Promise<string> {
  const opportunity = await propose(db, world.agent, message);
  await ownerGo(db, opportunity, world.intent);
  return opportunity;
}

const claimSql = "select ledger.claim($1, $2, $3, $4) as until";
const claimValues = (client: WorkClient, opportunity: string): unknown[] => [
  opportunity,
  testId("asg"),
  testId("req"),
  client.session,
];

async function claim(db: TestDatabase, client: WorkClient, opportunity: string): Promise<Date> {
  const until = one(
    await readAs(db, client.token, (query) =>
      query<{ until: Date | null }>(claimSql, claimValues(client, opportunity)),
    ),
  ).until;
  if (until === null) throw new Error("claim refused its positive control");
  return until;
}

const planSql = "select ledger.plan_move($1, $2, $3, $4, $5, 1, $6) as id";
const planValues = (client: WorkClient, opportunity: string): unknown[] => [
  testId("mov"),
  opportunity,
  STAGE,
  testId("req"),
  client.session,
  sha256Hex("move_clear definition"),
];

async function plan(db: TestDatabase, client: WorkClient, opportunity: string): Promise<string> {
  const move = one(
    await readAs(db, client.token, (query) => query<{ id: string | null }>(planSql, planValues(client, opportunity))),
  ).id;
  if (move === null) throw new Error("plan_move refused its positive control");
  return move;
}

// A report of `done` with no summary and no basis.
const reportSql = "select ledger.report_move($1, 'done', $2, $3, null, '{}'::text[], '{}'::text[]) as status";
const reportValues = (client: WorkClient, move: string): unknown[] => [move, testId("req"), client.session];

// The lease runs out: as pi_work, which alone may update queue.leases in place.
const lapse = (db: TestDatabase, opportunity: string): Promise<unknown> =>
  queryAs(
    db.urls.work,
    "update queue.leases set first_taken_at = now() - interval '1 hour', lease_until = now() - interval '1 second' where resource_kind = 'opportunity' and resource_id = $1",
    [opportunity],
  );

// A run queued by the tick as pi_work: one transaction that begins with lock_rows on it.
async function queueRun(db: TestDatabase): Promise<string> {
  const id = testId("run");
  await session(db.urls.work, async (query) => {
    await query("begin");
    await query("select ledger.lock_rows($1::text[])", [[id]]);
    await query(
      `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
       values ($1, $2, 'system:work', '{own}', 'owner_request', $3, 'run_outcome', 1, 'personal_run', '1')`,
      [id, testId("req"), `owner:${testId("req")}`],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:work', '{own}')",
      [id],
    );
    await query("commit");
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// The tick's writes, as pi_work: lock_rows first, the state read after it, nothing written when
// the state has moved (the dispatcher, steps 2 and 3)
// ---------------------------------------------------------------------------------------------

const latestOn = async (query: Query, rowKind: string, id: string): Promise<string | null> =>
  (
    await query<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [rowKind, id],
    )
  )[0]?.event ?? null;

// Step 3: an opportunity's lease past its time returns it to go and deletes the lease row, only
// while it is still claimed and the lease still lapsed. Whether it wrote.
async function expireLease(query: Query, opportunity: string): Promise<boolean> {
  await query("select ledger.lock_rows($1::text[])", [[opportunity]]);
  const status = await latestOn(query, "opportunity", opportunity);
  const lease = await query<{ lapsed: boolean }>(
    "select lease_until < now() as lapsed from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
    [opportunity],
  );
  if (status !== "claimed" || lease[0]?.lapsed !== true) return false;
  const { compartments } = one(
    await query<{ compartments: string[] }>("select compartments from ledger.opportunities where id = $1", [
      opportunity,
    ]),
  );
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'go', now(), 'system:work', $2)",
    [opportunity, compartments],
  );
  await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [opportunity]);
  return true;
}

// Step 2: an open opportunity a veto covers gets a no_go decided by the owner with the veto's
// ruling id, and its lease is dropped. The ruling id, or null when it wrote nothing.
async function closeVetoed(
  query: Query,
  opportunity: string,
  refs: { kinds: string[]; ids: string[] },
): Promise<string | null> {
  await query("select ledger.lock_rows($1::text[])", [[opportunity]]);
  const status = await latestOn(query, "opportunity", opportunity);
  if (status === null || !(OPEN_STATUSES as readonly string[]).includes(status)) return null;
  const { compartments, kind } = one(
    await query<{ compartments: string[]; kind: string }>(
      "select compartments, kind from ledger.opportunities where id = $1",
      [opportunity],
    ),
  );
  const { ruling } = one(
    await query<{ ruling: string | null }>("select policy.vetoed_by($1::text[], $2::text[], $3::text) as ruling", [
      refs.kinds,
      refs.ids,
      kind,
    ]),
  );
  if (ruling === null) return null;
  await query(
    `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, ruling_id)
     values ($1, 'system:work', $2, $3, 'no_go', 'owner', 4, 'vetoed', $4)`,
    [testId("req"), compartments, opportunity, ruling],
  );
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'no_go', now(), 'system:work', $2)",
    [opportunity, compartments],
  );
  await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [opportunity]);
  return ruling;
}

// A veto of every ref for one kind, as pi_admin: its decision row, then the veto.
async function vetoKind(db: TestDatabase, kind: string): Promise<string> {
  const id = testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
    [id, testId("req")],
  );
  await admin(
    db,
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'any', '{}', $2, now(), '{own}')",
    [id, kind],
  );
  return id;
}

// ---------------------------------------------------------------------------------------------
// Reading back, as pi_admin
// ---------------------------------------------------------------------------------------------

const eventsOf = async (db: TestDatabase, rowKind: string, id: string): Promise<{ event: string; by: string }[]> =>
  admin<{ event: string; by: string }>(
    db,
    "select event, by from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
    [rowKind, id],
  );

const latest = async (
  db: TestDatabase,
  rowKind: string,
  id: string,
): Promise<{ event: string; by: string } | undefined> => (await eventsOf(db, rowKind, id)).at(-1);

const leaseOf = async (db: TestDatabase, opportunity: string): Promise<number> =>
  one(
    await admin<{ n: number }>(
      db,
      "select count(*)::int as n from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
      [opportunity],
    ),
  ).n;

// Never done and then anything: done has no way back.
function neverAfterDone(events: { event: string }[]): void {
  const at = events.findIndex((row) => row.event === "done");
  if (at >= 0) expect(events.slice(at + 1)).toEqual([]);
}

describe("two locks order every ledger write", { timeout: TIMEOUT }, () => {
  it("a report_move and a lease expiry at once leave one outcome: the opportunity is done, or it is go with the report refused, and never done and then go", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 2);
      const [first, second] = world.messages;
      if (first === undefined || second === undefined) throw new Error("two messages");

      // The report first: it holds the opportunity's lock; the expiry waits, then reads the
      // state the report left and writes only if the opportunity is still claimed.
      const reported = await goOpportunity(db, world, first);
      await claim(db, world.agent, reported);
      const reportedMove = await plan(db, world.agent, reported);
      await lapse(db, reported);
      await withConnections([db.urls.reader, db.urls.work], async ([reporting, expiring]) => {
        if (reporting === undefined || expiring === undefined) throw new Error("two connections");
        await beginAs(reporting, world.agent.token);
        const { status } = one(
          await reporting.query<{ status: string | null }>(reportSql, reportValues(world.agent, reportedMove)),
        );
        await expiring.query("begin");
        const expiry = expireLease(expiring.query, reported);
        expiry.catch(() => {});
        expect(await waiting(db, expiring.pid)).toBe(true);
        expect(await settled(expiry)).toBe(false);
        await reporting.query("commit");
        const expired = await expiry;
        await expiring.query("commit");
        // One outcome, whichever the report was given under a lease that ran out.
        if (status === "done") {
          expect(expired).toBe(false);
          expect(await latest(db, "opportunity", reported)).toMatchObject({ event: "done" });
          expect(await latest(db, "move", reportedMove)).toMatchObject({ event: "done" });
        } else {
          expect(status).toBeNull();
          expect(expired).toBe(true);
          expect(await latest(db, "opportunity", reported)).toEqual({ event: "go", by: "system:work" });
          expect(await latest(db, "move", reportedMove)).toMatchObject({ event: "cleared" });
        }
      });
      neverAfterDone(await eventsOf(db, "opportunity", reported));

      // The expiry first: it holds the lock and has written go; the report waits, then finds
      // the opportunity no longer claimed, and is refused with nothing written.
      const expiredFirst = await goOpportunity(db, world, second);
      await claim(db, world.agent, expiredFirst);
      const refusedMove = await plan(db, world.agent, expiredFirst);
      await lapse(db, expiredFirst);
      await withConnections([db.urls.work, db.urls.reader], async ([expiring, reporting]) => {
        if (expiring === undefined || reporting === undefined) throw new Error("two connections");
        await expiring.query("begin");
        expect(await expireLease(expiring.query, expiredFirst)).toBe(true);
        await beginAs(reporting, world.agent.token);
        const report = reporting.query<{ status: string | null }>(reportSql, reportValues(world.agent, refusedMove));
        report.catch(() => {});
        expect(await waiting(db, reporting.pid)).toBe(true);
        expect(await settled(report)).toBe(false);
        await expiring.query("commit");
        expect(one(await report).status).toBeNull();
        await reporting.query("commit");
      });
      expect(await latest(db, "opportunity", expiredFirst)).toEqual({ event: "go", by: "system:work" });
      expect(await latest(db, "move", refusedMove)).toMatchObject({ event: "cleared" });
      expect((await eventsOf(db, "move", refusedMove)).map((row) => row.event)).toEqual(["cleared"]);
      expect(await leaseOf(db, expiredFirst)).toBe(0);
      neverAfterDone(await eventsOf(db, "opportunity", expiredFirst));
    }));

  it("a claim and a veto's close at once leave the opportunity no_go and unleased", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 2);
      const [first, second] = world.messages;
      if (first === undefined || second === undefined) throw new Error("two messages");
      const refsOf = (message: Message) => ({ kinds: ["message"], ids: [message.id] });

      // The claim first, before any veto: it holds the lock and has taken the lease. The owner
      // vetoes the kind meanwhile; the tick's close waits, then closes the claimed opportunity
      // and drops the lease the claim took.
      const claimedFirst = await goOpportunity(db, world, first);
      const ruling = await withConnections([db.urls.reader, db.urls.work], async ([claiming, closing]) => {
        if (claiming === undefined || closing === undefined) throw new Error("two connections");
        await beginAs(claiming, world.agent.token);
        const { until } = one(
          await claiming.query<{ until: Date | null }>(claimSql, claimValues(world.agent, claimedFirst)),
        );
        expect(until).not.toBeNull();
        const veto = await vetoKind(db, KIND);
        await closing.query("begin");
        const close = closeVetoed(closing.query, claimedFirst, refsOf(first));
        close.catch(() => {});
        expect(await waiting(db, closing.pid)).toBe(true);
        expect(await settled(close)).toBe(false);
        await claiming.query("commit");
        expect(await close).toBe(veto);
        await closing.query("commit");
        return veto;
      });
      expect(await latest(db, "opportunity", claimedFirst)).toEqual({ event: "no_go", by: "system:work" });
      expect(await leaseOf(db, claimedFirst)).toBe(0);
      expect(
        one(
          await admin<{ decision: string; ruling_id: string | null }>(
            db,
            "select decision, ruling_id from ledger.opportunity_decisions where opportunity_id = $1 order by id desc limit 1",
            [claimedFirst],
          ),
        ),
      ).toEqual({ decision: "no_go", ruling_id: ruling });

      // The close first: it holds the lock and has written no_go; the claim waits, then finds
      // the opportunity not claimable, and takes no lease.
      const closedFirst = await goOpportunity(db, world, second);
      await withConnections([db.urls.work, db.urls.reader], async ([closing, claiming]) => {
        if (closing === undefined || claiming === undefined) throw new Error("two connections");
        await closing.query("begin");
        expect(await closeVetoed(closing.query, closedFirst, refsOf(second))).toBe(ruling);
        await beginAs(claiming, world.agent.token);
        const claimed = claiming.query<{ until: Date | null }>(claimSql, claimValues(world.agent, closedFirst));
        claimed.catch(() => {});
        expect(await waiting(db, claiming.pid)).toBe(true);
        expect(await settled(claimed)).toBe(false);
        await closing.query("commit");
        expect(one(await claimed).until).toBeNull();
        await claiming.query("commit");
      });
      expect(await latest(db, "opportunity", closedFirst)).toEqual({ event: "no_go", by: "system:work" });
      expect(await leaseOf(db, closedFirst)).toBe(0);
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from ledger.assignments where opportunity_id = $1",
            [closedFirst],
          ),
        ).n,
      ).toBe(0);
    }));

  it("a row written by propose_opportunity while its ref is being deleted is tainted or refused, never left whole", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 2);
      const [first, second] = world.messages;
      if (first === undefined || second === undefined) throw new Error("two messages");
      // An opportunity left whole: untainted, citing the message through an untainted basis row.
      const whole = async (message: string): Promise<number> =>
        one(
          await admin<{ n: number }>(
            db,
            `select count(*)::int as n from ledger.basis b join ledger.opportunities o on o.id = b.row_id
             where b.row_kind = 'opportunity' and b.ref_id = $1 and b.tainted_at is null and o.tainted_at is null`,
            [message],
          ),
        ).n;
      const deleteMessage = async (query: Query, message: Message): Promise<number> => {
        await query("delete from knowledge.messages where id = $1", [message.id]);
        return one(
          await query<{ n: number }>("select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n", [
            [message.evidence],
            [message.id],
          ]),
        ).n;
      };

      // The deletion first: it holds the taint lock alone; the proposal waits at its first
      // statement, then finds its ref gone and writes nothing.
      const refusedValues = proposeValues(db, world.agent, first);
      await withConnections([db.urls.writer, db.urls.reader], async ([deleting, writing]) => {
        if (deleting === undefined || writing === undefined) throw new Error("two connections");
        await deleting.query("begin");
        await deleteMessage(deleting.query, first);
        await beginAs(writing, world.agent.token);
        const write = writing.query<{ id: string | null }>(proposeSql, refusedValues);
        write.catch(() => {});
        expect(await waiting(db, writing.pid)).toBe(true);
        expect(await settled(write)).toBe(false);
        await deleting.query("commit");
        expect(one(await write).id).toBeNull();
        await writing.query("commit");
      });
      expect(
        one(
          await admin<{ n: number }>(db, "select count(*)::int as n from ledger.opportunities where id = $1", [
            refusedValues[0],
          ]),
        ).n,
      ).toBe(0);
      expect(
        one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.basis where ref_id = $1", [first.id]))
          .n,
      ).toBe(0);
      expect(await whole(first.id)).toBe(0);

      // The proposal first: it holds the shared lock; the deletion waits, then sees its row and
      // taints it.
      const proposed = await withConnections([db.urls.reader, db.urls.writer], async ([writing, deleting]) => {
        if (writing === undefined || deleting === undefined) throw new Error("two connections");
        await beginAs(writing, world.agent.token);
        const id = one(
          await writing.query<{ id: string | null }>(proposeSql, proposeValues(db, world.agent, second)),
        ).id;
        expect(id).not.toBeNull();
        await deleting.query("begin");
        const deletion = deleteMessage(deleting.query, second);
        deletion.catch(() => {});
        expect(await waiting(db, deleting.pid)).toBe(true);
        expect(await settled(deletion)).toBe(false);
        await writing.query("commit");
        expect(await deletion).toBeGreaterThan(0);
        await deleting.query("commit");
        return id;
      });
      if (proposed === null) throw new Error("a proposal");
      expect(await whole(second.id)).toBe(0);
      expect(
        one(
          await admin<{ tainted: boolean; cleared: boolean }>(
            db,
            "select tainted_at is not null as tainted, body_enc is null as cleared from ledger.opportunities where id = $1",
            [proposed],
          ),
        ),
      ).toEqual({
        tainted: true,
        cleared: true,
      });
      expect(await latest(db, "opportunity", proposed)).toEqual({ event: "withdrawn", by: "system:taint" });
    }));

  it("two proposals for one case at once make one row, and the second returns the first's id", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 2);
      const [first, second] = world.messages;
      if (first === undefined || second === undefined) throw new Error("two messages");
      const hypothesisSql =
        "select ledger.propose_hypothesis($1, $2, $3, 'open_loop', 'message', $4, $5, '{message}', $6::text[]) as id";
      const hypothesisValues = (message: Message): unknown[] => {
        const id = testId("hyp");
        return [
          id,
          testId("req"),
          world.agent.session,
          message.id,
          sealUnder(
            db.keys,
            world.agent.compartments,
            { table: "ledger.hypotheses", id, column: "body_enc" },
            "synthetic hypothesis",
          ),
          [message.id],
        ];
      };
      const cases: { table: string; sql: string; values: () => unknown[] }[] = [
        { table: "ledger.hypotheses", sql: hypothesisSql, values: () => hypothesisValues(first) },
        { table: "ledger.opportunities", sql: proposeSql, values: () => proposeValues(db, world.agent, second) },
      ];
      for (const proposal of cases) {
        // One client from two connections, each with its own request id: the second waits for
        // the first, then finds its open row.
        const ids = await withConnections([db.urls.reader, db.urls.reader], async ([one_, two]) => {
          if (one_ === undefined || two === undefined) throw new Error("two connections");
          await beginAs(one_, world.agent.token);
          const firstId = one(await one_.query<{ id: string | null }>(proposal.sql, proposal.values())).id;
          await beginAs(two, world.agent.token);
          const pending = two.query<{ id: string | null }>(proposal.sql, proposal.values());
          pending.catch(() => {});
          expect(await waiting(db, two.pid), proposal.table).toBe(true);
          await one_.query("commit");
          const secondId = one(await pending).id;
          await two.query("commit");
          return { firstId, secondId };
        });
        expect(ids.firstId, proposal.table).not.toBeNull();
        expect(ids.secondId, proposal.table).toBe(ids.firstId);
        expect(
          one(
            await admin<{ n: number }>(db, `select count(*)::int as n from ${proposal.table} where created_by = $1`, [
              `client:${world.agent.id}`,
            ]),
          ).n,
          proposal.table,
        ).toBe(1);
      }
    }));

  it("two runs finishing on one case at once make one row: the second waits on the case's lock, then adds to the first's row", () =>
    withDatabase(async (db) => {
      const [message] = await messages(db, 1);
      if (message === undefined) throw new Error("a message");
      const reasoner = await insertWorkClient(db, "order-case-reasoner", ["own"], { kind: "reasoner" });
      const take = async (): Promise<string> => {
        const queued = await queueRun(db);
        const { run_id } = one(
          await readAs(db, reasoner.token, (query) =>
            query<{ run_id: string }>("select run_id from ledger.next_run($1, $2)", [testId("req"), reasoner.session]),
          ),
        );
        expect(run_id).toBe(queued);
        return run_id;
      };
      const firstRun = await take();
      const secondRun = await take();
      // One propose action on the message's investigate case, a new opportunity id for each run.
      const finishValues = (run: string): unknown[] => {
        const id = testId("opp");
        const body = sealUnder(
          db.keys,
          ["own"],
          { table: "ledger.opportunities", id, column: "body_enc" },
          "synthetic summary",
        );
        const action = {
          do: "propose",
          kind: KIND,
          about_kind: "message",
          about_id: message.id,
          id,
          body_enc: body,
          ref_kinds: ["message"],
          ref_ids: [message.id],
        };
        return [run, testId("req"), reasoner.session, sha256Hex("run_outcome definition"), JSON.stringify([action])];
      };
      const finishSql =
        "select recorded, outcome from ledger.finish_run($1, $2, $3, 'finished', null, 1, $4, $5::jsonb)";
      // The case key ends with the caller's label key: the reasoner's, own.
      const caseKey = await rowKey(db, `case opportunity ${KIND} message ${message.id} own`);

      const answers = await withConnections([db.urls.reader, db.urls.reader], async ([one_, two]) => {
        if (one_ === undefined || two === undefined) throw new Error("two connections");
        await beginAs(one_, reasoner.token);
        const first = one(await one_.query<{ recorded: number; outcome: string }>(finishSql, finishValues(firstRun)));
        await beginAs(two, reasoner.token);
        const pending = two.query<{ recorded: number; outcome: string }>(finishSql, finishValues(secondRun));
        pending.catch(() => {});
        expect(await waiting(db, two.pid)).toBe(true);
        // It waits on the case's lock, before it has written anything: not on the unique index.
        expect(await advisory(db, two.pid)).toContain(`${caseKey} ExclusiveLock waiting`);
        expect(await writeLocks(db, two.pid)).toEqual([]);
        await one_.query("commit");
        const second = one(await pending);
        await two.query("commit");
        return { first, second };
      });
      expect(answers).toEqual({
        first: { recorded: 1, outcome: "finished" },
        second: { recorded: 1, outcome: "finished" },
      });
      const rows = await admin<{ id: string; run_id: string }>(
        db,
        "select id, run_id from ledger.opportunities where about_id = $1 and created_by like 'run:%'",
        [message.id],
      );
      expect(rows.map((row) => row.run_id)).toEqual([firstRun]);
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from ledger.cases where row_kind = 'opportunity' and about_id = $1 and author = 'run'",
            [message.id],
          ),
        ).n,
      ).toBe(1);
      // The second run's call names the first run's row.
      expect(
        one(
          await admin<{ subject_id: string }>(
            db,
            "select subject_id from ledger.decision_point_calls where run_id = $1",
            [secondRun],
          ),
        ).subject_id,
      ).toBe(rows[0]?.id);
    }));

  it("taint_citing waits for a work function in flight and takes no row lock", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 1);
      const [message] = world.messages;
      if (message === undefined) throw new Error("a message");
      const opportunity = await goOpportunity(db, world, message);
      const taintAt = await taintKey(db);
      await withConnections([db.urls.reader, db.urls.writer], async ([claiming, deleting]) => {
        if (claiming === undefined || deleting === undefined) throw new Error("two connections");
        // A claim in flight: it holds the shared taint lock and the opportunity's lock.
        await beginAs(claiming, world.agent.token);
        expect(
          one(await claiming.query<{ until: Date | null }>(claimSql, claimValues(world.agent, opportunity))).until,
        ).not.toBeNull();
        await deleting.query("begin");
        const tainting = (async () => {
          await deleting.query("delete from knowledge.messages where id = $1", [message.id]);
          return one(
            await deleting.query<{ n: number }>(
              "select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n",
              [[message.evidence], [message.id]],
            ),
          ).n;
        })();
        tainting.catch(() => {});
        expect(await waiting(db, deleting.pid)).toBe(true);
        expect(await settled(tainting)).toBe(false);
        await claiming.query("commit");
        expect(await tainting).toBeGreaterThan(0);
        // It holds the taint lock alone: no row lock, the opportunity's included.
        const held = await advisory(db, deleting.pid);
        expect(held).toContain(`${taintAt} ExclusiveLock granted`);
        expect(held.filter((line) => !line.startsWith(`${taintAt} `))).toEqual([]);
        await deleting.query("commit");
      });
      // It saw what the claim wrote: the claimed opportunity is withdrawn and its lease dropped.
      expect(await latest(db, "opportunity", opportunity)).toEqual({ event: "withdrawn", by: "system:taint" });
      expect(await leaseOf(db, opportunity)).toBe(0);
    }));

  it("every writing function's first statement is the lock call", () =>
    withDatabase(async (db) => {
      const world = await workWorld(db, 2);
      const [first, second] = world.messages;
      if (first === undefined || second === undefined) throw new Error("two messages");
      const reasoner = await insertWorkClient(db, "order-reasoner", ["own"], { kind: "reasoner" });
      const taintAt = await taintKey(db);

      // While another session holds the taint lock alone, the call waits for the shared taint lock
      // and holds nothing else: no row lock, no transaction id and no relation lock of a write, so
      // nothing is written before it.
      async function behindTaintLock<Row>(
        url: string,
        token: string | null,
        text: string,
        values: unknown[],
        locks: string[] = [],
      ): Promise<Row> {
        return withConnections([db.urls.admin, url], async ([holder, caller]) => {
          if (holder === undefined || caller === undefined) throw new Error("two connections");
          await holder.query("begin");
          await holder.query("select pg_advisory_xact_lock(hashtext($1))", [TAINT_KEY]);
          if (token === null) await caller.query("begin");
          else await beginAs(caller, token);
          const pending = caller.query<Row>(text, values);
          pending.catch(() => {});
          expect(await waiting(db, caller.pid), text).toBe(true);
          expect(await advisory(db, caller.pid), text).toEqual([`${taintAt} ShareLock waiting`]);
          expect(await writeLocks(db, caller.pid), text).toEqual([]);
          expect(await settled(pending), text).toBe(false);
          await holder.query("commit");
          const row = one(await pending);
          const held = await advisory(db, caller.pid);
          expect(held, text).toContain(`${taintAt} ShareLock granted`);
          for (const id of locks)
            expect(held, `${text} locks ${id}`).toContain(`${await rowKey(db, id)} ExclusiveLock granted`);
          await caller.query("commit");
          return row;
        });
      }
      const agent = (text: string, values: unknown[], locks: string[] = []) =>
        behindTaintLock<Record<string, unknown>>(db.urls.reader, world.agent.token, text, values, locks);
      const run = (text: string, values: unknown[], locks: string[] = []) =>
        behindTaintLock<Record<string, unknown>>(db.urls.reader, reasoner.token, text, values, locks);

      // propose_hypothesis, then record_test on it.
      const hypothesisId = testId("hyp");
      const hypothesis = await agent(
        "select ledger.propose_hypothesis($1, $2, $3, 'open_loop', 'message', $4, $5, '{message}', $6::text[]) as id",
        [
          hypothesisId,
          testId("req"),
          world.agent.session,
          first.id,
          sealUnder(
            db.keys,
            world.agent.compartments,
            { table: "ledger.hypotheses", id: hypothesisId, column: "body_enc" },
            "synthetic hypothesis",
          ),
          [first.id],
        ],
      );
      expect(hypothesis.id).not.toBeNull();
      const test = await agent(
        "select test_id, counts from ledger.record_test($1, $2, $3, $4, 'supports', '{message}', $5::text[])",
        [testId("tst"), testId("req"), world.agent.session, hypothesis.id, [first.id]],
      );
      expect(test.test_id).not.toBeNull();

      // propose_opportunity; the owner's go; claim, release, claim again; set_intention;
      // plan_move; report_move.
      const opportunity = (await agent(proposeSql, proposeValues(db, world.agent, second))).id;
      if (typeof opportunity !== "string") throw new Error("an opportunity");
      await ownerGo(db, opportunity, world.intent);
      expect((await agent(claimSql, claimValues(world.agent, opportunity), [opportunity])).until).not.toBeNull();
      expect(
        (
          await agent(
            "select ledger.release($1, $2, $3, null, null) = 'released' as released",
            [opportunity, testId("req"), world.agent.session],
            [opportunity],
          )
        ).released,
      ).toBe(true);
      expect((await agent(claimSql, claimValues(world.agent, opportunity), [opportunity])).until).not.toBeNull();
      const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      expect(
        (
          await agent(
            "select ledger.set_intention($1, $2, $3, $4, $5, false, false) as id",
            [testId("itn"), testId("req"), world.agent.session, opportunity, dueAt],
            [opportunity],
          )
        ).id,
      ).not.toBeNull();
      const planned = planValues(world.agent, opportunity);
      const move = (await agent(planSql, planned, [opportunity])).id;
      expect(move).toBe(planned[0]);
      if (typeof move !== "string") throw new Error("a move");
      expect((await agent(reportSql, reportValues(world.agent, move), [move, opportunity])).status).toBe("done");

      // A run queued by the tick as pi_work; next_run, append_step, finish_run.
      const queued = await queueRun(db);
      const taken = await run(
        "select run_id, attempt from ledger.next_run($1, $2)",
        [testId("req"), reasoner.session],
        ["run_queue"],
      );
      expect(taken).toMatchObject({ run_id: queued, attempt: 1 });
      expect(
        (
          await run(
            "select ledger.append_step($1, 1, $2, 'tool_call', 'ok', 'search', null, null, null, null, null) as go",
            [queued, reasoner.session],
            [queued],
          )
        ).go,
      ).toBe(true);
      const finished = await run(
        "select recorded, outcome from ledger.finish_run($1, $2, $3, 'finished', null, 1, $4, $5::jsonb)",
        [
          queued,
          testId("req"),
          reasoner.session,
          sha256Hex("run_outcome definition"),
          JSON.stringify([{ do: "ignore", reason: "nothing_to_do" }]),
        ],
        [queued],
      );
      expect(finished).toEqual({ recorded: 1, outcome: "finished" });

      // end_run, the tick's, as pi_work.
      const stopped = await queueRun(db);
      expect(
        (
          await behindTaintLock<{ ended: boolean }>(
            db.urls.work,
            null,
            "select ledger.end_run($1, 'stopped', 'kill_switch') as ended",
            [stopped],
            [stopped],
          )
        ).ended,
      ).toBe(true);
      expect(await latest(db, "run", stopped)).toMatchObject({ event: "stopped" });
    }));
});
