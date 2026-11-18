import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, ownerCommitted as ownerCommit, readAs, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import type { Connection } from "../test-support/waits.ts";
import { connectTo as connect, settled, waitingForLock as waiting } from "../test-support/waits.ts";
import { insertWorkClient, openWorkSession, type WorkClient } from "../test-support/work-clients.ts";

// A client calls the functions as pi_reader under its token; the tick's rows (a decision and its
// event, a lease moved in time) are written as pi_work, and the owner's (intents, harness modes,
// the kill switch, an owner's go) as pi_admin, each as the spec's grants table allows. Every
// refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const BOTH = { compartments: ["own", "employer:example"] };
// What the store hands plan_move for move_clear: its version and its pinned hash.
const MOVE_CLEAR = { version: 1, hash: sha256Hex("move_clear@1") };
// The first stage of each kind's plan (STAGE_PLAN).
const FIRST_STAGE: Record<string, string> = {
  follow_up: "investigate",
  reply: "draft",
  meeting_prep: "prepare",
  investigate: "investigate",
  goal_step: "investigate",
  life_admin: "investigate",
};

type Ref = [kind: string, id: string];
type Mail = { id: string; evidence: string };

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const work = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.work, text, values);
// One call under a client's token, as pi_reader, in its own committed transaction.
const as = <Row = Record<string, unknown>>(
  db: TestDatabase,
  client: { token: string },
  text: string,
  values: unknown[],
): Promise<Row[]> => readAs(db, client.token, (query) => query<Row>(text, values));

const inMinutes = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
const sealed = (db: TestDatabase, compartments: string[], table: string, id: string, text: string): string =>
  JSON.stringify(sealUnder(db.keys, compartments, { table, id, column: "body_enc" }, text));
const labelled = (compartments: string[]): string[] => [...new Set(compartments)].sort();

// ---------------------------------------------------------------------------------------------
// A small world, in SQL as pi_admin. Every message is under `own`. Thread one holds the owner's
// sent message and the inbound messages that the thread rule lets stand beside it.
// ---------------------------------------------------------------------------------------------

type World = {
  // A person with an address, for a veto on what an opportunity is about.
  person: string;
  personFp: string;
  // Outbound, not bulk: owner-backed. Thread one, judged clean.
  out: Mail;
  // Inbound, thread one, clean.
  inbound: Mail;
  // Inbound, thread two, clean.
  otherThread: Mail;
  // Inbound, thread one: withheld; skipped (not screened); with no status row; and clean, to be
  // marked held by a test.
  withheld: Mail;
  skipped: Mail;
  noStatus: Mail;
  toHold: Mail;
  // Inbound, thread three, clean: for a session to read, and for a test to delete.
  read: Mail;
  spare: Mail;
};

async function seedWorld(db: TestDatabase): Promise<World> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const own = ["own"];
    const account = await seed.sourceAccount(own);
    const mail = async (
      direction: "inbound" | "outbound",
      thread: string,
      status: "done" | "withheld" | "skipped" | "none",
    ): Promise<Mail> => {
      const evidence = await seed.evidence(own, account);
      const id = await seed.message(own, evidence);
      await query("update knowledge.messages set direction = $2, bulk = false, thread_fp = $3 where id = $1", [
        id,
        direction,
        fingerprint(db.keys, "thread", thread),
      ]);
      if (status !== "none") {
        await seed.pipelineItem(own, evidence);
        await query(
          "update vault.pipeline_items set waiting = false, withheld = $2, screened = $3 where evidence_id = $1",
          [evidence, status === "withheld", status !== "skipped"],
        );
      }
      return { id, evidence };
    };
    const person = await seed.entity("person");
    await seed.account(own, person);
    const personFp = one(
      await query<{ fp: string }>("select value_fp as fp from knowledge.accounts where entity_id = $1", [person]),
    ).fp;
    return {
      person,
      personFp,
      out: await mail("outbound", "thread-one", "done"),
      inbound: await mail("inbound", "thread-one", "done"),
      otherThread: await mail("inbound", "thread-two", "done"),
      withheld: await mail("inbound", "thread-one", "withheld"),
      skipped: await mail("inbound", "thread-one", "skipped"),
      noStatus: await mail("inbound", "thread-one", "none"),
      toHold: await mail("inbound", "thread-one", "done"),
      read: await mail("inbound", "thread-three", "done"),
      spare: await mail("inbound", "thread-three", "done"),
    };
  });
}

const clean = (w: World): Ref[] => [
  ["message", w.out.id],
  ["message", w.inbound.id],
];

async function freshEntity(db: TestDatabase): Promise<string> {
  const id = testId("ent");
  await admin(db, "insert into knowledge.entities (id, kind) values ($1, 'person')", [id]);
  await admin(
    db,
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $3, '{}', '{own}')",
    [testId("adr"), id, sha256Hex(id)],
  );
  return id;
}

// ---------------------------------------------------------------------------------------------
// The owner's rows, as pi_admin; the tick's, as pi_work
// ---------------------------------------------------------------------------------------------

let serial = 0;
const agent = (
  db: TestDatabase,
  compartments: string[] = ["own"],
  options?: Parameters<typeof insertWorkClient>[3],
): Promise<WorkClient> => {
  serial += 1;
  return insertWorkClient(db, `work-agent-${serial}`, compartments, options);
};

async function intent(
  db: TestDatabase,
  kinds: string[],
  clients: string[],
  options: { mode?: string; maxOpen?: number } = {},
): Promise<string> {
  const id = testId("int");
  await admin(
    db,
    `insert into policy.intents (id, goal_id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at)
     values ($1, null, $2, '{none}', $3, $4, $5, now())`,
    [id, kinds, clients, options.mode ?? "policy_decides", options.maxOpen ?? 5],
  );
  return id;
}

async function harness(
  db: TestDatabase,
  client: WorkClient,
  kind: string,
  stage: string,
  mode = "act",
): Promise<string> {
  const id = testId("hrn");
  await admin(
    db,
    "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, $5, now())",
    [id, client.id, kind, stage, mode],
  );
  return id;
}

const killSwitch = (db: TestDatabase, state: "on" | "off"): Promise<unknown> =>
  admin(
    db,
    "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ($1, 'owner', '{own}', $2)",
    [testId("req"), state],
  );

// A veto as pi_admin: its decision row, then the veto. Returns its ruling id.
async function veto(
  db: TestDatabase,
  subject: "person" | "any",
  fps: string[],
  workKind: string | null = null,
): Promise<string> {
  const id = testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
    [id, testId("req")],
  );
  await admin(
    db,
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')",
    [id, subject, fps, workKind],
  );
  return id;
}

async function lift(db: TestDatabase, ruling: string): Promise<void> {
  const id = testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto_lift', 0, '{}', '{}', now(), '{own}')",
    [id, testId("req")],
  );
  await admin(db, "update knowledge.vetoes set lifted_at = now(), lift_ruling_id = $2 where ruling_id = $1", [
    ruling,
    id,
  ]);
}

const labelOf = async (db: TestDatabase, opportunity: string): Promise<string[]> =>
  one(
    await admin<{ compartments: string[] }>(db, "select compartments from ledger.opportunities where id = $1", [
      opportunity,
    ]),
  ).compartments;

// A decision on an opportunity and its status event: the tick's (`policy`, as pi_work) or the
// owner's (`owner`, as pi_admin, with their answer as its ruling).
async function decide(
  db: TestDatabase,
  opportunity: string,
  options: { intent: string | null; by?: "policy" | "owner"; decision?: "go" | "later" | "no_go"; event?: boolean },
): Promise<void> {
  const by = options.by ?? "policy";
  const decision = options.decision ?? "go";
  const compartments = await labelOf(db, opportunity);
  const url = by === "policy" ? db.urls.work : db.urls.admin;
  const author = by === "policy" ? "system:work" : "owner";
  await session(url, async (query) => {
    await query("begin");
    let ruling: string | null = null;
    if (by === "owner") {
      ruling = testId("rul");
      await query(
        `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
         values ($1, $2, 'answer', 'opportunity', $3, $4, 0, '{}', '{}', now(), $5)`,
        [ruling, testId("req"), opportunity, decision, compartments],
      );
    }
    await query(
      `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id, ruling_id)
       values ($1, $2, $3, $4, $5, $6, $7, $5, $8, $9)`,
      [testId("req"), author, compartments, opportunity, decision, by, by === "policy" ? 0 : 4, options.intent, ruling],
    );
    if (options.event !== false) {
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, $2, now(), $3, $4)",
        [opportunity, decision, author, compartments],
      );
    }
    await query("commit");
  });
}

// The tick's own event on an opportunity, as pi_work.
const tickEvent = async (db: TestDatabase, opportunity: string, event: string): Promise<void> => {
  await work(
    db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, $2, now(), 'system:work', $3)",
    [opportunity, event, await labelOf(db, opportunity)],
  );
};

// ---------------------------------------------------------------------------------------------
// The functions, as a client calls them
// ---------------------------------------------------------------------------------------------

async function propose(
  db: TestDatabase,
  client: WorkClient,
  options: {
    refs: Ref[];
    kind?: string;
    about?: Ref | null;
    hypothesis?: string | null;
    id?: string;
    requestId?: string;
  },
): Promise<string | null> {
  const id = options.id ?? testId("opp");
  const about = options.about === undefined ? (["entity", await freshEntity(db)] as Ref) : options.about;
  return one(
    await as<{ id: string | null }>(
      db,
      client,
      "select ledger.propose_opportunity($1, $2, $3, $4, $5, $6, $7::text, $8::timestamptz, $9::jsonb, $10::text[], $11::text[]) as id",
      [
        id,
        options.requestId ?? testId("req"),
        client.session,
        options.kind ?? "investigate",
        about === null ? "owner" : about[0],
        about === null ? null : about[1],
        options.hypothesis ?? null,
        null,
        sealed(db, client.compartments, "ledger.opportunities", id, `summary of ${id}`),
        options.refs.map(([kind]) => kind),
        options.refs.map(([, ref]) => ref),
      ],
    ),
  ).id;
}

// A proposal that must be taken as a new row.
async function proposed(db: TestDatabase, client: WorkClient, options: Parameters<typeof propose>[2]): Promise<string> {
  const id = options.id ?? testId("opp");
  expect(await propose(db, client, { ...options, id })).toBe(id);
  return id;
}

async function proposeHypothesis(
  db: TestDatabase,
  client: WorkClient,
  about: Ref | null,
  refs: Ref[],
): Promise<string> {
  const id = testId("hyp");
  const answer = one(
    await as<{ id: string | null }>(
      db,
      client,
      "select ledger.propose_hypothesis($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9::text[]) as id",
      [
        id,
        testId("req"),
        client.session,
        "open_loop",
        about === null ? "owner" : about[0],
        about === null ? null : about[1],
        sealed(db, client.compartments, "ledger.hypotheses", id, `hypothesis ${id}`),
        refs.map(([kind]) => kind),
        refs.map(([, ref]) => ref),
      ],
    ),
  ).id;
  expect(answer).toBe(id);
  return id;
}

type Call = { requestId?: string; sessionId?: string };

const claim = async (
  db: TestDatabase,
  client: WorkClient,
  opportunity: string,
  options: Call & { assignment?: string } = {},
): Promise<Date | null> =>
  one(
    await as<{ lease: Date | null }>(db, client, "select ledger.claim($1, $2, $3, $4) as lease", [
      opportunity,
      options.assignment ?? testId("asg"),
      options.requestId ?? testId("req"),
      options.sessionId ?? client.session,
    ]),
  ).lease;

const release = async (
  db: TestDatabase,
  client: WorkClient,
  opportunity: string,
  options: Call = {},
): Promise<boolean> =>
  one(
    await as<{ ok: boolean }>(
      db,
      client,
      "select coalesce(ledger.release($1, $2, $3, null, null) = 'released', false) as ok",
      [opportunity, options.requestId ?? testId("req"), options.sessionId ?? client.session],
    ),
  ).ok;

const plan = async (
  db: TestDatabase,
  client: WorkClient,
  opportunity: string,
  stage: string,
  options: Call & { move?: string } = {},
): Promise<string | null> =>
  one(
    await as<{ move: string | null }>(
      db,
      client,
      "select ledger.plan_move($1, $2, $3, $4, $5, $6::integer, $7) as move",
      [
        options.move ?? testId("mov"),
        opportunity,
        stage,
        options.requestId ?? testId("req"),
        options.sessionId ?? client.session,
        MOVE_CLEAR.version,
        MOVE_CLEAR.hash,
      ],
    ),
  ).move;

const report = async (
  db: TestDatabase,
  client: WorkClient,
  move: string,
  outcome: "done" | "failed" | "blocked",
  options: Call & { summary?: string | null } = {},
): Promise<string | null> =>
  one(
    await as<{ status: string | null }>(
      db,
      client,
      "select ledger.report_move($1, $2, $3, $4, $5::jsonb, $6::text[], $7::text[]) as status",
      [
        move,
        outcome,
        options.requestId ?? testId("req"),
        options.sessionId ?? client.session,
        options.summary === undefined || options.summary === null
          ? null
          : sealed(db, client.compartments, "ledger.record_events", `${move}/reported`, options.summary),
        [],
        [],
      ],
    ),
  ).status;

const setIntention = async (
  db: TestDatabase,
  client: WorkClient,
  opportunity: string,
  dueAt: string,
  options: Call & { id?: string } = {},
): Promise<string | null> =>
  one(
    await as<{ id: string | null }>(
      db,
      client,
      "select ledger.set_intention($1, $2, $3, $4, $5::timestamptz, true, false) as id",
      [
        options.id ?? testId("itn"),
        options.requestId ?? testId("req"),
        options.sessionId ?? client.session,
        opportunity,
        dueAt,
      ],
    ),
  ).id;

// ---------------------------------------------------------------------------------------------
// What the ledger holds
// ---------------------------------------------------------------------------------------------

type Event = { event: string; by: string; compartments: string[]; body: boolean };
const eventsOf = (db: TestDatabase, kind: string, id: string): Promise<Event[]> =>
  admin<Event>(
    db,
    "select event, by, compartments, body_enc is not null as body from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
    [kind, id],
  );

async function statusOf(db: TestDatabase, kind: string, id: string): Promise<string | undefined> {
  return (await eventsOf(db, kind, id)).at(-1)?.event;
}

type Lease = { holder: string; lease_until: Date; first_taken_at: Date; preferred_until: Date | null };
const leaseOf = (db: TestDatabase, opportunity: string): Promise<Lease[]> =>
  admin<Lease>(
    db,
    "select holder, lease_until, first_taken_at, preferred_until from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
    [opportunity],
  );

// Every row of the tables these functions write, with its xmin: a call that writes nothing
// leaves this unchanged.
const WRITTEN: [table: string, key: string][] = [
  ["ledger.record_events", "id"],
  ["ledger.basis", "id"],
  ["ledger.cases", "id"],
  ["ledger.opportunities", "id"],
  ["ledger.opportunity_decisions", "id"],
  ["ledger.assignments", "id"],
  ["ledger.moves", "id"],
  ["ledger.intentions", "id"],
  ["ledger.decision_point_calls", "id"],
  ["queue.leases", "resource_kind || ':' || resource_id"],
];
async function ledgerRows(db: TestDatabase): Promise<string[]> {
  const lines: string[] = [];
  for (const [table, key] of WRITTEN) {
    for (const row of await admin<{ line: string }>(
      db,
      `select '${table} ' || (${key})::text || ' ' || xmin::text as line from ${table}`,
    ))
      lines.push(row.line);
  }
  return lines.sort();
}

type MoveCounts = { moves: number; clear: number; refuse: number };
const moveCounts = async (db: TestDatabase): Promise<MoveCounts> =>
  one(
    await admin<MoveCounts>(
      db,
      `select (select count(*)::int from ledger.moves) as moves,
              (select count(*)::int from ledger.decision_point_calls where point = 'move_clear' and output = 'clear') as clear,
              (select count(*)::int from ledger.decision_point_calls where point = 'move_clear' and output = 'refuse') as refuse`,
    ),
  );

// It answers null, or `refused:` and the code when that is the caller's own standing.
async function refusedMove(
  db: TestDatabase,
  client: WorkClient,
  opportunity: string,
  stage: string,
  answer: string | null = null,
): Promise<void> {
  const before = await moveCounts(db);
  const move = testId("mov");
  expect(await plan(db, client, opportunity, stage, { move })).toBe(answer);
  expect(await moveCounts(db)).toEqual({ ...before, refuse: before.refuse + 1 });
  expect(await admin(db, "select id from ledger.moves where id = $1", [move])).toEqual([]);
}

// The control: every link holds, so the move is cleared, with one move_clear call clear.
async function clearedMove(db: TestDatabase, client: WorkClient, opportunity: string, stage: string): Promise<string> {
  const before = await moveCounts(db);
  const move = testId("mov");
  expect(await plan(db, client, opportunity, stage, { move })).toBe(move);
  expect(await moveCounts(db)).toEqual({ moves: before.moves + 1, clear: before.clear + 1, refuse: before.refuse });
  expect(await statusOf(db, "move", move)).toBe("cleared");
  return move;
}

type Chain = { client: WorkClient; intent: string; opportunity: string; stage: string };
async function chain(
  db: TestDatabase,
  w: World,
  options: {
    client?: WorkClient;
    intent?: string;
    kind?: string;
    modes?: [stage: string, mode: string][];
    refs?: Ref[];
    about?: Ref | null;
    hypothesis?: string;
    by?: "policy" | "owner";
    decisionIntent?: boolean;
    claim?: boolean;
    id?: string;
  } = {},
): Promise<Chain> {
  const kind = options.kind ?? "investigate";
  const stage = FIRST_STAGE[kind] ?? "investigate";
  const client = options.client ?? (await agent(db));
  const intentId = options.intent ?? (await intent(db, [kind], [client.id]));
  for (const [modeStage, mode] of options.modes ??
    (options.client === undefined ? [[stage, "act"] as [string, string]] : []))
    await harness(db, client, kind, modeStage, mode);
  const opportunity = await proposed(db, client, {
    kind,
    refs: options.refs ?? clean(w),
    ...(options.about === undefined ? {} : { about: options.about }),
    ...(options.hypothesis === undefined ? {} : { hypothesis: options.hypothesis }),
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  await decide(db, opportunity, {
    intent: options.decisionIntent === false ? null : intentId,
    by: options.by ?? "policy",
  });
  if (options.claim !== false) expect(await claim(db, client, opportunity)).not.toBeNull();
  return { client, intent: intentId, opportunity, stage };
}

// ---------------------------------------------------------------------------------------------
// Two connections
// ---------------------------------------------------------------------------------------------

describe("ledger.claim", { timeout: TIMEOUT }, () => {
  it("a client whose clearance does not cover the opportunity's compartments is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const proposer = await agent(db, ["own", "employer:example"]);
      const narrow = await agent(db, ["own"]);
      const wide = await agent(db, ["own", "employer:example"]);
      const intentId = await intent(db, ["investigate"], [narrow.id, wide.id]);
      await harness(db, narrow, "investigate", "investigate");
      await harness(db, wide, "investigate", "investigate");
      const opportunity = await proposed(db, proposer, { refs: clean(w) });
      expect(await labelOf(db, opportunity)).toEqual(["employer:example", "own"]);
      await decide(db, opportunity, { intent: intentId });
      expect(await claim(db, narrow, opportunity)).toBeNull();
      expect(await leaseOf(db, opportunity)).toEqual([]);
      // The control: a client cleared for both.
      expect(await claim(db, wide, opportunity)).not.toBeNull();
      expect((await leaseOf(db, opportunity)).map((lease) => lease.holder)).toEqual([wide.id]);
    }, BOTH));

  it("a client with no intent that lists it and the kind is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      await harness(db, a, "investigate", "investigate");
      // An intent for another kind is no intent for this one.
      await intent(db, ["meeting_prep"], [a.id]);
      const opportunity = await proposed(db, a, { refs: clean(w) });
      await decide(db, opportunity, { intent: null });
      expect(await claim(db, a, opportunity)).toBeNull();
      // An intent listing the kind opens nothing until a decision names it.
      const listing = await intent(db, ["investigate"], [a.id]);
      expect(await claim(db, a, opportunity)).toBeNull();
      await decide(db, opportunity, { intent: listing, event: false });
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("a client whose only intent is revoked is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      await harness(db, a, "investigate", "investigate");
      const revoked = await intent(db, ["investigate"], [a.id]);
      await admin(db, "update policy.intents set revoked_at = now() where id = $1", [revoked]);
      const opportunity = await proposed(db, a, { refs: clean(w) });
      await decide(db, opportunity, { intent: revoked });
      expect(await claim(db, a, opportunity)).toBeNull();
      const standing = await intent(db, ["investigate"], [a.id]);
      await decide(db, opportunity, { intent: standing, event: false });
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("a client that the intent does not list is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const other = await agent(db);
      await harness(db, a, "investigate", "investigate");
      const intentId = await intent(db, ["investigate"], [other.id]);
      const opportunity = await proposed(db, a, { refs: clean(w) });
      await decide(db, opportunity, { intent: intentId });
      expect(await claim(db, a, opportunity)).toBeNull();
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [intentId, [other.id, a.id]]);
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("a client with no harness mode for the kind and its next stage is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id]);
      // A mode for another stage of the kind, and one for the stage under another kind.
      await harness(db, a, "investigate", "prepare");
      await harness(db, a, "goal_step", "investigate");
      const opportunity = await proposed(db, a, { refs: clean(w) });
      await decide(db, opportunity, { intent: intentId });
      expect(await claim(db, a, opportunity)).toBeNull();
      await harness(db, a, "investigate", "investigate");
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("an opportunity that is proposed or later is not claimable, and one that is go is", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id]);
      await harness(db, a, "investigate", "investigate");
      const opportunity = await proposed(db, a, { refs: clean(w) });
      expect(await statusOf(db, "opportunity", opportunity)).toBe("proposed");
      expect(await claim(db, a, opportunity)).toBeNull();
      await decide(db, opportunity, { intent: null, decision: "later" });
      expect(await claim(db, a, opportunity)).toBeNull();
      expect(await leaseOf(db, opportunity)).toEqual([]);
      await decide(db, opportunity, { intent: intentId });
      expect(await claim(db, a, opportunity)).not.toBeNull();
      expect(await statusOf(db, "opportunity", opportunity)).toBe("claimed");
    }));

  it("a tainted opportunity is not claimable", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id]);
      await harness(db, a, "investigate", "investigate");
      const tainted = await proposed(db, a, { refs: clean(w) });
      const whole = await proposed(db, a, { refs: clean(w) });
      await decide(db, tainted, { intent: intentId });
      await decide(db, whole, { intent: intentId });
      await ownerCommit(db, (query) =>
        query("update ledger.opportunities set tainted_at = now() where id = $1", [tainted]),
      );
      expect(await claim(db, a, tainted)).toBeNull();
      expect(await leaseOf(db, tainted)).toEqual([]);
      expect(await claim(db, a, whole)).not.toBeNull();
    }));

  it("an opportunity held by another client under a live lease is refused, and taken once released", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, intent: intentId, opportunity } = await chain(db, w);
      const b = await agent(db);
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [intentId, [a.id, b.id]]);
      await harness(db, b, "investigate", "investigate");
      const before = await leaseOf(db, opportunity);
      expect(await claim(db, b, opportunity)).toBeNull();
      expect(await leaseOf(db, opportunity)).toEqual(before);
      expect(await release(db, a, opportunity)).toBe(true);
      expect(await claim(db, b, opportunity)).not.toBeNull();
      expect((await leaseOf(db, opportunity)).map((lease) => lease.holder)).toEqual([b.id]);
    }));

  it("an opportunity a veto covers is refused, and claimable once the veto is lifted", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, opportunity } = await chain(db, w, { about: ["entity", w.person], claim: false });
      const ruling = await veto(db, "person", [w.personFp]);
      expect(await claim(db, a, opportunity)).toBeNull();
      expect(await leaseOf(db, opportunity)).toEqual([]);
      await lift(db, ruling);
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("no claim is taken while the kill switch is on", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, opportunity } = await chain(db, w, { claim: false });
      await killSwitch(db, "on");
      expect(await claim(db, a, opportunity)).toBeNull();
      expect(await leaseOf(db, opportunity)).toEqual([]);
      await killSwitch(db, "off");
      expect(await claim(db, a, opportunity)).not.toBeNull();
    }));

  it("inside the 24 hours a due check-back gives its setter, another client is refused and the setter is not", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const b = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id, b.id]);
      await harness(db, a, "investigate", "investigate");
      await harness(db, b, "investigate", "investigate");
      const { opportunity } = await chain(db, w, { client: a, intent: intentId });
      expect(await setIntention(db, a, opportunity, inMinutes(120))).not.toBeNull();
      // The check-back falls due: the tick returns the opportunity to go and keeps the setter's
      // preference for 24 hours on the lease row.
      await work(
        db,
        "update queue.leases set lease_until = now() - interval '1 minute', preferred_until = now() + interval '24 hours' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      await tickEvent(db, opportunity, "go");
      expect(await claim(db, b, opportunity)).toBeNull();
      expect(await statusOf(db, "opportunity", opportunity)).toBe("go");
      expect(await claim(db, a, opportunity)).not.toBeNull();
      expect((await leaseOf(db, opportunity)).map((lease) => lease.holder)).toEqual([a.id]);
      // The control for the other client: an opportunity with no preference on it.
      const free = await chain(db, w, { client: a, intent: intentId, claim: false });
      expect(await claim(db, b, free.opportunity)).not.toBeNull();
    }));

  it("check_back_blocked answers true for another client inside a check-back's 24 hours and false for its setter, after them, and with none; no row for an opportunity the caller cannot see; 42501 for a reasoner", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const b = await agent(db);
      const outside = await agent(db, ["employer:example"]);
      const reasoner = await agent(db, ["own"], { kind: "reasoner" });
      const intentId = await intent(db, ["investigate"], [a.id, b.id]);
      await harness(db, a, "investigate", "investigate");
      await harness(db, b, "investigate", "investigate");
      const { opportunity } = await chain(db, w, { client: a, intent: intentId });
      const free = await chain(db, w, { client: a, intent: intentId, claim: false });
      expect(await setIntention(db, a, opportunity, inMinutes(120))).not.toBeNull();
      await work(
        db,
        "update queue.leases set lease_until = now() - interval '1 minute', preferred_until = now() + interval '24 hours' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      await tickEvent(db, opportunity, "go");

      const blocked = (client: WorkClient) =>
        as<{ opportunity_id: string; blocked: boolean }>(
          db,
          client,
          "select opportunity_id, blocked from ledger.check_back_blocked($1::text[])",
          [[opportunity, free.opportunity, testId("opp")]],
        );
      const both = [opportunity, free.opportunity].sort();
      const answer = (held: boolean) => both.map((id) => ({ opportunity_id: id, blocked: held && id === opportunity }));
      expect(await blocked(b)).toEqual(answer(true));
      expect(await blocked(a)).toEqual(answer(false));
      // Each answer is what ledger.claim does with it.
      expect(await claim(db, b, opportunity)).toBeNull();
      expect(await blocked(outside)).toEqual([]);
      expect(await sqlState(() => blocked(reasoner))).toBe("42501");
      // The 24 hours over: nobody is held off.
      await work(
        db,
        "update queue.leases set preferred_until = now() - interval '1 second' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      expect(await blocked(b)).toEqual(answer(false));
    }));

  it("the holder's second claim extends the lease and keeps its first claim's time", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, opportunity } = await chain(db, w);
      const [first] = await leaseOf(db, opportunity);
      if (first === undefined) throw new Error("a lease");
      await work(
        db,
        "update queue.leases set lease_until = now() + interval '1 minute' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      const extended = await claim(db, a, opportunity);
      expect(extended).not.toBeNull();
      expect(extended?.getTime() ?? 0).toBeGreaterThan(Date.now() + 25 * 60_000);
      const [after] = await leaseOf(db, opportunity);
      expect(after?.holder).toBe(a.id);
      expect(after?.lease_until).toEqual(extended);
      expect(after?.first_taken_at).toEqual(first.first_taken_at);
    }));

  it("a renewal has no limit from the first claim, and a lease that ran out more than 24 hours ago is another client's to take", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, intent: intentId, opportunity } = await chain(db, w);
      await work(
        db,
        "update queue.leases set first_taken_at = now() - interval '14000 seconds', lease_until = now() + interval '5 minutes' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      const renewed = await claim(db, a, opportunity);
      const [lease] = await leaseOf(db, opportunity);
      if (lease === undefined || renewed === null) throw new Error("a lease");
      // Past the four hours a renewal once stopped at.
      expect(renewed.getTime()).toBeGreaterThan(lease.first_taken_at.getTime() + 14_400_000);
      expect(renewed.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      await work(
        db,
        "update queue.leases set first_taken_at = now() - interval '3 days', lease_until = now() + interval '5 minutes' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      expect((await claim(db, a, opportunity))?.getTime() ?? 0).toBeGreaterThan(Date.now() + 25 * 60_000);

      const b = await agent(db);
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [intentId, [a.id, b.id]]);
      await harness(db, b, "investigate", "investigate");
      expect(await claim(db, b, opportunity)).toBeNull();
      await work(
        db,
        "update queue.leases set first_taken_at = now() - interval '3 days', lease_until = now() - interval '25 hours' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      expect(await claim(db, b, opportunity)).not.toBeNull();
      expect((await leaseOf(db, opportunity))[0]?.holder).toBe(b.id);
    }));

  it("two claims at once give one lease", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const b = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id, b.id]);
      await harness(db, a, "investigate", "investigate");
      await harness(db, b, "investigate", "investigate");
      const { opportunity } = await chain(db, w, { client: a, intent: intentId, claim: false });
      const [first, second] = [await connect(db.urls.reader), await connect(db.urls.reader)];
      try {
        const call = (connection: Connection, client: WorkClient) =>
          connection.query<{ lease: Date | null }>("select ledger.claim($1, $2, $3, $4) as lease", [
            opportunity,
            testId("asg"),
            testId("req"),
            client.session,
          ]);
        await first.query("begin");
        await first.query("select set_config('pi.client_token', $1, true)", [a.token]);
        await second.query("begin");
        await second.query("select set_config('pi.client_token', $1, true)", [b.token]);
        expect(one(await call(first, a)).lease).not.toBeNull();
        const racing = call(second, b);
        expect(await waiting(db, second.pid)).toBe(true);
        expect(await settled(racing)).toBe(false);
        await first.query("commit");
        expect(one(await racing).lease).toBeNull();
        await second.query("commit");
      } finally {
        await first.client.end().catch(() => {});
        await second.client.end().catch(() => {});
      }
      expect((await leaseOf(db, opportunity)).map((lease) => lease.holder)).toEqual([a.id]);
      expect(
        (await eventsOf(db, "opportunity", opportunity))
          .filter((event) => event.event === "claimed")
          .map((event) => event.by),
      ).toEqual([`client:${a.id}`]);
    }));

  it("a claim on an opportunity claimed under a lease that ran out over 24 hours ago takes it, and writes a go event by system:lease and then its own claimed event", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const b = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id, b.id]);
      await harness(db, a, "investigate", "investigate");
      await harness(db, b, "investigate", "investigate");
      const { opportunity } = await chain(db, w, { client: a, intent: intentId });
      // The control: under the live lease, the other client is refused.
      expect(await claim(db, b, opportunity)).toBeNull();
      // Inside the holder's 24 hours the other client is still refused, and the holder is not.
      await work(
        db,
        "update queue.leases set lease_until = now() - interval '1 second' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      expect(await claim(db, b, opportunity)).toBeNull();
      await work(
        db,
        "update queue.leases set lease_until = now() - interval '25 hours' where resource_kind = 'opportunity' and resource_id = $1",
        [opportunity],
      );
      expect(await statusOf(db, "opportunity", opportunity)).toBe("claimed");
      expect(await claim(db, b, opportunity)).not.toBeNull();
      expect(
        (await eventsOf(db, "opportunity", opportunity)).slice(-3).map((event) => [event.event, event.by]),
      ).toEqual([
        ["claimed", `client:${a.id}`],
        ["go", "system:lease"],
        ["claimed", `client:${b.id}`],
      ]);
      expect((await leaseOf(db, opportunity)).map((lease) => lease.holder)).toEqual([b.id]);
    }));

  it("a client is not refused for another client's claims under the same intent", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const b = await agent(db);
      // max_open is applied at go, not at the claim.
      const intentId = await intent(db, ["investigate"], [a.id, b.id], { maxOpen: 1 });
      await harness(db, a, "investigate", "investigate");
      await harness(db, b, "investigate", "investigate");
      const first = await chain(db, w, { client: a, intent: intentId });
      const second = await chain(db, w, { client: a, intent: intentId, claim: false });
      expect(await claim(db, b, second.opportunity)).not.toBeNull();
      expect((await leaseOf(db, first.opportunity)).map((lease) => lease.holder)).toEqual([a.id]);
      expect((await leaseOf(db, second.opportunity)).map((lease) => lease.holder)).toEqual([b.id]);
    }));

  it("a report that closes an opportunity cancels its intentions in the same transaction", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const closed = await chain(db, w);
      const open = await chain(db, w, { client: closed.client, intent: closed.intent });
      const cancelled = await setIntention(db, closed.client, closed.opportunity, inMinutes(120));
      const kept = await setIntention(db, closed.client, open.opportunity, inMinutes(120));
      if (cancelled === null || kept === null) throw new Error("two intentions");
      const move = await clearedMove(db, closed.client, closed.opportunity, closed.stage);
      expect(await report(db, closed.client, move, "done")).toBe("done");
      expect((await eventsOf(db, "intention", cancelled)).map((event) => event.event)).toEqual(["set", "cancelled"]);
      const tx = async (kind: string, id: string, event: string): Promise<string> =>
        one(
          await admin<{ tx: string }>(
            db,
            "select xmin::text as tx from ledger.record_events where row_kind = $1 and row_id = $2 and event = $3",
            [kind, id, event],
          ),
        ).tx;
      expect(await tx("intention", cancelled, "cancelled")).toBe(await tx("opportunity", closed.opportunity, "done"));
      // The control: an intention on an opportunity that stays open is still set.
      expect((await eventsOf(db, "intention", kept)).map((event) => event.event)).toEqual(["set"]);
    }));
});

describe("ledger.work_grants and ledger.release", { timeout: TIMEOUT }, () => {
  it("work_grants gives the kinds and stages a confirmed, unrevoked intent and an unrevoked harness mode of the client cover, and no row while the kill switch is on", () =>
    withDatabase(async (db) => {
      const a = await agent(db);
      const b = await agent(db);
      const intentId = await intent(db, ["investigate", "goal_step"], [a.id]);
      const revokedIntent = await intent(db, ["meeting_prep"], [a.id]);
      await admin(db, "update policy.intents set revoked_at = now() where id = $1", [revokedIntent]);
      const investigate = await harness(db, a, "investigate", "investigate");
      const prepare = await harness(db, a, "goal_step", "prepare", "propose");
      // Under a revoked intent, under no intent, and revoked itself: none gives a row.
      await harness(db, a, "meeting_prep", "prepare");
      await harness(db, a, "life_admin", "investigate");
      const revokedMode = await harness(db, a, "goal_step", "investigate");
      await admin(db, "update policy.harness_modes set revoked_at = now() where id = $1", [revokedMode]);
      // Another client's mode, under no intent that lists it.
      await harness(db, b, "investigate", "investigate");

      const grants = (client: WorkClient) =>
        as<{ intent_id: string; opportunity_kind: string; stage: string; harness_mode_id: string }>(
          db,
          client,
          "select intent_id, opportunity_kind, stage, harness_mode_id from ledger.work_grants() order by opportunity_kind, stage, intent_id",
          [],
        );
      const expected = [
        { intent_id: intentId, opportunity_kind: "goal_step", stage: "prepare", harness_mode_id: prepare },
        { intent_id: intentId, opportunity_kind: "investigate", stage: "investigate", harness_mode_id: investigate },
      ];
      expect(await grants(a)).toEqual(expected);
      expect(await grants(b)).toEqual([]);
      await killSwitch(db, "on");
      expect(await grants(a)).toEqual([]);
      await killSwitch(db, "off");
      expect(await grants(a)).toEqual(expected);
    }));

  it("release is refused for a client that does not hold the opportunity, and the holder's release returns it to go and drops the lease", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { client: a, opportunity } = await chain(db, w);
      const b = await agent(db);
      const before = await ledgerRows(db);
      expect(await release(db, b, opportunity)).toBe(false);
      expect(await ledgerRows(db)).toEqual(before);
      expect(await release(db, a, opportunity)).toBe(true);
      expect((await eventsOf(db, "opportunity", opportunity)).at(-1)).toMatchObject({
        event: "go",
        by: `client:${a.id}`,
        body: false,
      });
      expect(await leaseOf(db, opportunity)).toEqual([]);
      // Released, it is held by nobody: a second release, under a new request id, is refused.
      const released = await ledgerRows(db);
      expect(await release(db, b, opportunity)).toBe(false);
      expect(await ledgerRows(db)).toEqual(released);
    }));
});

describe("ledger.plan_move, one test for each link", { timeout: TIMEOUT }, () => {
  it("no move is cleared while the kill switch is on", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await killSwitch(db, "on");
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:kill_switch");
      await killSwitch(db, "off");
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a client that does not hold the opportunity's lease is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      // Listed by the intent, with a harness mode, and no lease.
      const b = await agent(db);
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [c.intent, [c.client.id, b.id]]);
      await harness(db, b, "investigate", "investigate");
      await refusedMove(db, b, c.opportunity, c.stage);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("an opportunity whose latest decision is not go is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await decide(db, c.opportunity, { intent: null, decision: "later", event: false });
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:not_go");
      await decide(db, c.opportunity, { intent: c.intent, event: false });
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a go decision that names no intent is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await decide(db, c.opportunity, { intent: null, event: false });
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:no_intent");
      await decide(db, c.opportunity, { intent: c.intent, event: false });
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a go under an intent revoked since is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await admin(db, "update policy.intents set revoked_at = now() where id = $1", [c.intent]);
      // The claim's lease stands; another intent keeps the client's grant.
      const again = await intent(db, ["investigate"], [c.client.id]);
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:intent_revoked");
      await decide(db, c.opportunity, { intent: again, event: false });
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a go under an intent that no longer lists the kind is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await admin(db, "update policy.intents set opportunity_kinds = '{meeting_prep}' where id = $1", [c.intent]);
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:kind_not_listed");
      await admin(db, "update policy.intents set opportunity_kinds = '{meeting_prep,investigate}' where id = $1", [
        c.intent,
      ]);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a go under an intent that no longer lists the caller is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const other = await agent(db);
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [c.intent, [other.id]]);
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:client_not_listed");
      await admin(db, "update policy.intents set client_ids = $2 where id = $1", [c.intent, [other.id, c.client.id]]);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a caller with no harness mode for the kind and stage is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await admin(db, "delete from policy.harness_modes where client_id = $1", [c.client.id]);
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:no_harness_mode");
      await harness(db, c.client, "investigate", "investigate");
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a caller whose harness mode was revoked is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await admin(db, "update policy.harness_modes set revoked_at = now() where client_id = $1", [c.client.id]);
      await refusedMove(db, c.client, c.opportunity, c.stage, "refused:no_harness_mode");
      await harness(db, c.client, "investigate", "investigate");
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a harness mode other than act is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      for (const mode of ["propose", "act_with_check"]) {
        const c = await chain(db, w);
        await admin(db, "update policy.harness_modes set revoked_at = now() where client_id = $1", [c.client.id]);
        await harness(db, c.client, "investigate", "investigate", mode);
        await refusedMove(db, c.client, c.opportunity, c.stage, "refused:not_act");
        await admin(db, "update policy.harness_modes set revoked_at = now() where client_id = $1", [c.client.id]);
        await harness(db, c.client, "investigate", "investigate", "act");
        await clearedMove(db, c.client, c.opportunity, c.stage);
      }
    }));

  it("a stage that is not the opportunity's next is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      // goal_step: investigate, then prepare.
      const c = await chain(db, w, {
        kind: "goal_step",
        modes: [
          ["investigate", "act"],
          ["prepare", "act"],
        ],
      });
      await refusedMove(db, c.client, c.opportunity, "prepare", "refused:not_next_stage");
      await clearedMove(db, c.client, c.opportunity, "investigate");
    }));

  it("a stage that is not internal is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      // reply: draft, then send. Its next stage is draft, with an act mode for it.
      const c = await chain(db, w, { kind: "reply", modes: [["draft", "act"]] });
      await refusedMove(db, c.client, c.opportunity, "draft", "refused:not_internal");
      // The control: the same client's internal stage on another kind.
      await harness(db, c.client, "investigate", "investigate");
      const control = await chain(db, w, {
        client: c.client,
        intent: await intent(db, ["investigate"], [c.client.id]),
      });
      await clearedMove(db, c.client, control.opportunity, control.stage);
    }));

  it("a tainted ref of the basis is refused, under a go policy decided and under a go the owner decided", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const policy = await chain(db, w);
      const owner = await chain(db, w, { client: policy.client, intent: policy.intent, by: "owner" });
      const untainted = await chain(db, w, { client: policy.client, intent: policy.intent, by: "owner" });
      for (const c of [policy, owner]) {
        await ownerCommit(db, (query) =>
          query(
            "update ledger.basis set tainted_at = now() where row_kind = 'opportunity' and row_id = $1 and ref_id = $2",
            [c.opportunity, w.inbound.id],
          ),
        );
        await refusedMove(db, c.client, c.opportunity, c.stage);
      }
      await clearedMove(db, untainted.client, untainted.opportunity, untainted.stage);
    }));

  it("a veto on what the opportunity is about is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w, { about: ["entity", w.person] });
      const ruling = await veto(db, "person", [w.personFp]);
      await refusedMove(db, c.client, c.opportunity, c.stage);
      await lift(db, ruling);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a veto on a message of the basis is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const sender = one(
        await admin<{ fp: string }>(db, "select sender_fp as fp from knowledge.messages where id = $1", [w.inbound.id]),
      ).fp;
      const ruling = await veto(db, "person", [sender]);
      await refusedMove(db, c.client, c.opportunity, c.stage);
      await lift(db, ruling);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("a veto on the opportunity's kind is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      // A veto on another kind, which covers nothing here and stays.
      await veto(db, "any", [], "meeting_prep");
      const ruling = await veto(db, "any", [], "investigate");
      await refusedMove(db, c.client, c.opportunity, c.stage);
      await lift(db, ruling);
      await clearedMove(db, c.client, c.opportunity, c.stage);
    }));

  it("an opportunity that rests on a hypothesis about the owner is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id]);
      await harness(db, a, "investigate", "investigate");
      const aboutOwner = await proposeHypothesis(db, a, null, [["message", w.out.id]]);
      expect(
        one(
          await admin<{ about_owner: boolean }>(db, "select about_owner from ledger.hypotheses where id = $1", [
            aboutOwner,
          ]),
        ).about_owner,
      ).toBe(true);
      // propose_opportunity refuses such a row, so it is written as the functions write one, as
      // pi_owner: its case, the row, its basis and its first event.
      const opportunity = testId("opp");
      const author = `client:${a.id}`;
      const label = labelled(a.compartments);
      const about = await freshEntity(db);
      await ownerCommit(db, async (query) => {
        const caseId = `cas_${opportunity.slice(4)}`;
        await query(
          `insert into ledger.cases (id, request_id, created_by, session_id, compartments, row_kind, kind, about_kind, about_id, author)
           values ($1, $2, $3, $4, $5, 'opportunity', 'investigate', 'entity', $6, $3)`,
          [caseId, testId("req"), author, a.session, label, about],
        );
        await query(
          `insert into ledger.opportunities (id, request_id, created_by, session_id, compartments, case_id, kind, hypothesis_id, about_kind, about_id, proposed_by_class, body_enc)
           values ($1, $2, $3, $4, $5, $6, 'investigate', $7, 'entity', $8, 'client', $9::jsonb)`,
          [
            opportunity,
            testId("req"),
            author,
            a.session,
            label,
            caseId,
            aboutOwner,
            about,
            sealed(db, label, "ledger.opportunities", opportunity, "on the owner"),
          ],
        );
      });
      const refs = clean(w);
      expect(
        one(
          await admin<{ ok: boolean }>(
            db,
            "select ledger.add_basis('opportunity', $1, $2, $3::text[], $4::text[], $5::text[]) as ok",
            [opportunity, label, refs.map(([kind]) => kind), refs.map(([, id]) => id), label],
          ),
        ).ok,
      ).toBe(true);
      await work(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'proposed', now(), $2, $3)",
        [opportunity, author, label],
      );
      await decide(db, opportunity, { intent: intentId });
      expect(await claim(db, a, opportunity)).not.toBeNull();
      await refusedMove(db, a, opportunity, "investigate");

      // The control: an opportunity that rests on a hypothesis about someone else.
      const aboutOther = await proposeHypothesis(db, a, ["entity", await freshEntity(db)], [["message", w.out.id]]);
      const control = await chain(db, w, { client: a, intent: intentId, hypothesis: aboutOther });
      await clearedMove(db, a, control.opportunity, control.stage);
    }));
});

type R2Case = {
  name: string;
  refs: (db: TestDatabase, w: World, client: WorkClient) => Promise<Ref[]>;
  after?: (db: TestDatabase, w: World) => Promise<unknown>;
};
const R2_CASES: R2Case[] = [
  {
    name: "a basis of agent refs alone",
    refs: async (db, w, client) => [
      ["hypothesis", await proposeHypothesis(db, client, ["entity", await freshEntity(db)], clean(w))],
      ["opportunity", await proposed(db, client, { refs: clean(w) })],
    ],
  },
  { name: "a basis with no owner-backed ref", refs: async (_db, w) => [["message", w.inbound.id]] },
  {
    name: "an inbound message beside an owner-backed message of another thread",
    refs: async (_db, w) => [
      ["message", w.out.id],
      ["message", w.otherThread.id],
    ],
  },
  {
    name: "a withheld message",
    refs: async (_db, w) => [
      ["message", w.out.id],
      ["message", w.withheld.id],
    ],
  },
  {
    name: "a held message",
    refs: async (_db, w) => [
      ["message", w.out.id],
      ["message", w.toHold.id],
    ],
    // Held after the proposal: a held message is not visible to propose_opportunity.
    after: (db, w) => admin(db, "update knowledge.messages set held = true where id = $1", [w.toHold.id]),
  },
  {
    name: "a message with no status row",
    refs: async (_db, w) => [
      ["message", w.out.id],
      ["message", w.noStatus.id],
    ],
  },
  {
    name: "a skipped message",
    refs: async (_db, w) => [
      ["message", w.out.id],
      ["message", w.skipped.id],
    ],
  },
];

describe("the basis under a go policy decided", { timeout: TIMEOUT }, () => {
  for (const r2 of R2_CASES) {
    it(`${r2.name} is refused`, () =>
      withDatabase(async (db) => {
        const w = await seedWorld(db);
        const a = await agent(db);
        const intentId = await intent(db, ["investigate"], [a.id]);
        await harness(db, a, "investigate", "investigate");
        const c = await chain(db, w, { client: a, intent: intentId, refs: await r2.refs(db, w, a) });
        await r2.after?.(db, w);
        await refusedMove(db, a, c.opportunity, c.stage);
        const control = await chain(db, w, { client: a, intent: intentId });
        await clearedMove(db, a, control.opportunity, control.stage);
      }));
  }

  it("case that refuses under a policy go clears under a go the owner decided", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const intentId = await intent(db, ["investigate"], [a.id]);
      await harness(db, a, "investigate", "investigate");
      for (const r2 of R2_CASES) {
        const c = await chain(db, w, { client: a, intent: intentId, refs: await r2.refs(db, w, a), by: "owner" });
        await r2.after?.(db, w);
        await clearedMove(db, a, c.opportunity, c.stage);
      }
    }));
});

describe("and move_clear's input hash", { timeout: TIMEOUT }, () => {
  it("plan_move for draft, send or pay is refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w, {
        kind: "reply",
        modes: [
          ["draft", "act"],
          ["send", "act"],
          ["pay", "propose"],
        ],
      });
      await refusedMove(db, c.client, c.opportunity, "draft", "refused:not_internal");
      await refusedMove(db, c.client, c.opportunity, "send", "refused:not_next_stage");
      await refusedMove(db, c.client, c.opportunity, "pay", "refused:not_act");
      await harness(db, c.client, "investigate", "investigate");
      const control = await chain(db, w, {
        client: c.client,
        intent: await intent(db, ["investigate"], [c.client.id]),
      });
      await clearedMove(db, c.client, control.opportunity, control.stage);
    }));

  it(
    "plan_move's move_clear call has the input_hash of its opportunity, stage, move and broken link, whatever the request id",
    async () => {
      // One opportunity id and one move id in three databases, so no call meets another's row.
      const opportunity = testId("opp");
      const move = testId("mov");
      const hashOf = (stage: string, requestId: string) =>
        withDatabase(async (db) => {
          const w = await seedWorld(db);
          const c = await chain(db, w, { id: opportunity });
          await plan(db, c.client, c.opportunity, stage, { move, requestId });
          return one(
            await admin<{ input_hash: string; request_id: string }>(
              db,
              "select input_hash, request_id from ledger.decision_point_calls where point = 'move_clear'",
            ),
          );
        });
      const first = await hashOf("investigate", testId("req"));
      const second = await hashOf("investigate", testId("req"));
      expect(second.request_id).not.toBe(first.request_id);
      expect(second.input_hash).toBe(first.input_hash);
      expect(first.input_hash).toMatch(/^[0-9a-f]{64}$/);
      const otherStage = await hashOf("prepare", testId("req"));
      expect(otherStage.input_hash).not.toBe(first.input_hash);
    },
    TIMEOUT,
  );
});

describe("ledger.report_move", { timeout: TIMEOUT }, () => {
  // An opportunity proposed under `own`, carried by a client cleared for more.
  async function widerReporter(db: TestDatabase, w: World) {
    const proposer = await agent(db, ["own"]);
    const reporter = await agent(db, ["own", "employer:example"]);
    const intentId = await intent(db, ["investigate"], [reporter.id]);
    await harness(db, reporter, "investigate", "investigate");
    const opportunity = await proposed(db, proposer, { refs: clean(w) });
    await decide(db, opportunity, { intent: intentId });
    expect(await claim(db, reporter, opportunity)).not.toBeNull();
    const move = await clearedMove(db, reporter, opportunity, "investigate");
    expect(await report(db, reporter, move, "done", { summary: "what came of it" })).toBe("done");
    return { reporter, opportunity, move };
  }

  it("a report writes a status event on the move and on the opportunity with their own label and no body, and the summary as a second event under the reporter's clearance", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { reporter, opportunity, move } = await widerReporter(db, w);
      const moveLabel = one(
        await admin<{ compartments: string[] }>(db, "select compartments from ledger.moves where id = $1", [move]),
      ).compartments;
      const events = await eventsOf(db, "move", move);
      expect(events.find((event) => event.event === "done")).toEqual({
        event: "done",
        by: `client:${reporter.id}`,
        compartments: moveLabel,
        body: false,
      });
      expect(events.find((event) => event.event === "reported")).toEqual({
        event: "reported",
        by: `client:${reporter.id}`,
        compartments: ["employer:example", "own"],
        body: true,
      });
      expect(events.map((event) => event.event).sort()).toEqual(["cleared", "done", "reported"]);
      expect((await eventsOf(db, "opportunity", opportunity)).at(-1)).toEqual({
        event: "done",
        by: `client:${reporter.id}`,
        compartments: ["own"],
        body: false,
      });
    }, BOTH));

  it("a second client cleared for the opportunity sees the move done and not the summary of a reporter cleared for more", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const { reporter, opportunity, move } = await widerReporter(db, w);
      const second = await agent(db, ["own"]);
      const seen = (client: WorkClient, kind: string, id: string) =>
        as<{ event: string }>(
          db,
          client,
          "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
          [kind, id],
        ).then((rows) => rows.map((row) => row.event));
      expect(await seen(second, "move", move)).toEqual(["cleared", "done"]);
      expect((await seen(second, "opportunity", opportunity)).at(-1)).toBe("done");
      // The control: the reporter sees its own summary event.
      expect((await seen(reporter, "move", move)).sort()).toEqual(["cleared", "done", "reported"]);
    }, BOTH));

  it("report_move closes on the last stage, hands to the owner on failed, blocked or a next stage that is not internal, and is refused for a client that did not plan the move", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const a = await agent(db);
      const kinds = ["investigate", "follow_up", "goal_step"];
      const intentId = await intent(db, kinds, [a.id]);
      for (const kind of kinds) await harness(db, a, kind, "investigate");
      const reported = async (
        kind: string,
        outcome: "done" | "failed" | "blocked",
      ): Promise<{ status: string | null; opportunity: string; move: string }> => {
        const c = await chain(db, w, { client: a, intent: intentId, kind });
        const move = await clearedMove(db, a, c.opportunity, c.stage);
        return { status: await report(db, a, move, outcome), opportunity: c.opportunity, move };
      };

      // Not the planner: refused, and nothing written.
      const c = await chain(db, w, { client: a, intent: intentId });
      const move = await clearedMove(db, a, c.opportunity, c.stage);
      const b = await agent(db);
      const before = await ledgerRows(db);
      expect(await report(db, b, move, "done")).toBeNull();
      expect(await ledgerRows(db)).toEqual(before);
      expect(await report(db, a, move, "done")).toBe("done");

      for (const [kind, outcome, status] of [
        ["investigate", "done", "done"],
        ["investigate", "failed", "handed_to_owner"],
        ["investigate", "blocked", "handed_to_owner"],
        // follow_up: investigate, then draft, which is not internal.
        ["follow_up", "done", "handed_to_owner"],
        // goal_step: investigate, then prepare, which is: it stays with its holder.
        ["goal_step", "done", "claimed"],
      ] as const) {
        const result = await reported(kind, outcome);
        expect(result.status, `${kind} ${outcome}`).toBe(status);
        expect(await statusOf(db, "opportunity", result.opportunity), `${kind} ${outcome}`).toBe(status);
        expect(await statusOf(db, "move", result.move), `${kind} ${outcome}`).toBe(outcome);
      }
    }));
});

describe("ledger.set_intention", { timeout: TIMEOUT }, () => {
  it("only the holder sets a check-back, and it writes its set event", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const b = await agent(db);
      const before = await ledgerRows(db);
      expect(await setIntention(db, b, c.opportunity, inMinutes(120))).toBeNull();
      expect(await ledgerRows(db)).toEqual(before);
      const id = testId("itn");
      expect(await setIntention(db, c.client, c.opportunity, inMinutes(120), { id })).toBe(id);
      const row = one(
        await admin<{
          kind: string;
          opportunity_id: string;
          client_id: string;
          compartments: string[];
          session_id: string;
          created_by: string;
        }>(
          db,
          "select kind, opportunity_id, client_id, compartments, session_id, created_by from ledger.intentions where id = $1",
          [id],
        ),
      );
      expect(row).toEqual({
        kind: "check_back",
        opportunity_id: c.opportunity,
        client_id: c.client.id,
        compartments: ["own"],
        session_id: c.client.session,
        created_by: `client:${c.client.id}`,
      });
      expect(await eventsOf(db, "intention", id)).toEqual([
        { event: "set", by: `client:${c.client.id}`, compartments: ["own"], body: false },
      ]);
    }));

  it("a check-back due less than an hour ahead is refused with 22023", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const before = await ledgerRows(db);
      expect(await sqlState(() => setIntention(db, c.client, c.opportunity, inMinutes(58)))).toBe("22023");
      expect(await ledgerRows(db)).toEqual(before);
      expect(await setIntention(db, c.client, c.opportunity, inMinutes(62))).not.toBeNull();
    }));

  it("a fourth check-back on one opportunity is refused with 22023", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      for (const minutes of [90, 120, 150])
        expect(await setIntention(db, c.client, c.opportunity, inMinutes(minutes))).not.toBeNull();
      const before = await ledgerRows(db);
      expect(await sqlState(() => setIntention(db, c.client, c.opportunity, inMinutes(180)))).toBe("22023");
      expect(await ledgerRows(db)).toEqual(before);
      // The control: another opportunity of the same holder takes one.
      const other = await chain(db, w, { client: c.client, intent: c.intent });
      expect(await setIntention(db, c.client, other.opportunity, inMinutes(180))).not.toBeNull();
    }));
});

// A message read in a session with read_message, its evidence id under bound.
const readMessage = (
  db: TestDatabase,
  client: WorkClient,
  sessionId: string,
  mail: Mail,
  list: "bound" | "shown" = "bound",
): Promise<unknown> =>
  as(db, client, "select policy.log_read($1, 'read_message', $2::text[], $3::text[], '{}')", [
    sessionId,
    list === "bound" ? [mail.evidence] : [],
    list === "shown" ? [mail.evidence] : [],
  ]);

// The message deleted at its source, with its status row and its evidence row.
async function deleteMessage(db: TestDatabase, mail: Mail): Promise<void> {
  await session(db.urls.admin, async (query) => {
    await query("begin");
    await query("delete from vault.pipeline_items where evidence_id = $1", [mail.evidence]);
    await query("delete from knowledge.messages where id = $1", [mail.id]);
    await query("delete from vault.evidence_items where id = $1", [mail.evidence]);
    await query("commit");
  });
}

describe("a session that read an item since deleted is refused at write", {
  timeout: TIMEOUT,
}, () => {
  for (const summary of ["a summary", null]) {
    it(`report_move ${summary === null ? "with no summary" : "with a summary"} is refused with not_found and writes nothing`, () =>
      withDatabase(async (db) => {
        const w = await seedWorld(db);
        const c = await chain(db, w);
        const move = await clearedMove(db, c.client, c.opportunity, c.stage);
        await readMessage(db, c.client, c.client.session, w.read);
        await deleteMessage(db, w.read);
        const before = await ledgerRows(db);
        expect(await report(db, c.client, move, "done", { summary })).toBeNull();
        expect(await ledgerRows(db)).toEqual(before);
        // The control: the same client's report from a session that read nothing deleted.
        const fresh = await openWorkSession(db, c.client.token);
        expect(await report(db, c.client, move, "done", { summary, sessionId: fresh })).toBe("done");
      }));
  }

  it("set_intention is refused with not_found and writes nothing", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await readMessage(db, c.client, c.client.session, w.read);
      await deleteMessage(db, w.read);
      const before = await ledgerRows(db);
      expect(await setIntention(db, c.client, c.opportunity, inMinutes(120))).toBeNull();
      expect(await ledgerRows(db)).toEqual(before);
      const fresh = await openWorkSession(db, c.client.token);
      expect(await setIntention(db, c.client, c.opportunity, inMinutes(120), { sessionId: fresh })).not.toBeNull();
    }));

  it("a session that read nothing deleted is not refused, also when a message it was only shown is deleted", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      await readMessage(db, c.client, c.client.session, w.spare);
      await readMessage(db, c.client, c.client.session, w.read, "shown");
      await deleteMessage(db, w.read);
      expect(await setIntention(db, c.client, c.opportunity, inMinutes(120))).not.toBeNull();
      const move = await clearedMove(db, c.client, c.opportunity, c.stage);
      expect(await report(db, c.client, move, "done", { summary: "it went well" })).toBe("done");
    }));
});

// ---------------------------------------------------------------------------------------------
// A repeated request id returns the first result and writes nothing
// ---------------------------------------------------------------------------------------------

describe("a repeated request id returns the first result and writes nothing", { timeout: TIMEOUT }, () => {
  it("claim", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w, { claim: false });
      const call = { requestId: testId("req"), assignment: testId("asg") };
      const first = await claim(db, c.client, c.opportunity, call);
      expect(first).not.toBeNull();
      const before = await ledgerRows(db);
      expect(await claim(db, c.client, c.opportunity, call)).toEqual(first);
      expect(await ledgerRows(db)).toEqual(before);
    }));

  it("release", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const call = { requestId: testId("req") };
      expect(await release(db, c.client, c.opportunity, call)).toBe(true);
      const before = await ledgerRows(db);
      expect(await release(db, c.client, c.opportunity, call)).toBe(true);
      expect(await ledgerRows(db)).toEqual(before);
    }));

  it("plan_move, cleared and refused", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const call = { requestId: testId("req"), move: testId("mov") };
      expect(await plan(db, c.client, c.opportunity, c.stage, call)).toBe(call.move);
      const before = await ledgerRows(db);
      expect(await plan(db, c.client, c.opportunity, c.stage, call)).toBe(call.move);
      expect(await ledgerRows(db)).toEqual(before);

      const refused = await chain(db, w, { client: c.client, intent: c.intent });
      await killSwitch(db, "on");
      const again = { requestId: testId("req"), move: testId("mov") };
      expect(await plan(db, c.client, refused.opportunity, refused.stage, again)).toBe("refused:kill_switch");
      const counts = await moveCounts(db);
      const rows = await ledgerRows(db);
      expect(await plan(db, c.client, refused.opportunity, refused.stage, again)).toBe("refused:kill_switch");
      expect(await moveCounts(db)).toEqual(counts);
      expect(await ledgerRows(db)).toEqual(rows);
    }));

  it("report_move", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const move = await clearedMove(db, c.client, c.opportunity, c.stage);
      const call = { requestId: testId("req"), summary: "done once" };
      expect(await report(db, c.client, move, "done", call)).toBe("done");
      const before = await ledgerRows(db);
      expect(await report(db, c.client, move, "done", call)).toBe("done");
      expect(await ledgerRows(db)).toEqual(before);
    }));

  it("set_intention", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const c = await chain(db, w);
      const call = { requestId: testId("req"), id: testId("itn") };
      const due = inMinutes(120);
      expect(await setIntention(db, c.client, c.opportunity, due, call)).toBe(call.id);
      const before = await ledgerRows(db);
      expect(await setIntention(db, c.client, c.opportunity, due, call)).toBe(call.id);
      expect(await ledgerRows(db)).toEqual(before);
    }));
});
