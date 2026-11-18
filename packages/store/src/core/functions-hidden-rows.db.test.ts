import { DECISION_POINT_PINS, type GateFacts, type OpportunityId } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { one, type Query, readAs, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import {
  factsAsProxy,
  factsAsReader,
  insertInteraction,
  insertMessage,
  madeDraft,
  proxy,
  withSendWorld,
} from "../test-support/send-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";
import type { ToDecide } from "../work/dispatch-read.ts";
import { sealUnder } from "./seal.ts";

// Tests I6, I8, I9, I12 and I13's database half, written from the spec and the implementer's contract, not
// from the functions' bodies. Clients, intents, harness modes, vetoes and erasures are written as pi_admin;
// the tick's rows as pi_work; the rows only the functions write as pi_owner; the functions are called as
// pi_reader under a client's token. Every refusal has its positive control in the same test, and each test
// shows the own client's answer is the same with the hidden rows as without them. Made-up values and reserved
// domains only.

const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["own", "employer:example"];
// A label as ledger.label writes it: each once, sorted bytewise.
const labelOf = (compartments: readonly string[]): string[] => [...new Set(compartments)].sort();
const hoursAhead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pin = (key: string): string => {
  const value = DECISION_POINT_PINS[key];
  if (value === undefined) throw new Error(`no pin for ${key}`);
  return value;
};
const MOVE_PIN = pin("move_clear@1");
const RUN_PIN = pin("run_outcome@1");

// How long a call may run and still have answered at once: far longer than any of these calls
// takes alone, far shorter than a wait for a lock nobody gives back.
const AT_ONCE = "3s";
// The lock ledger.lock_rows takes for one row id, taken as it takes it.
const ROW_LOCK = "select pg_advisory_xact_lock(hashtextextended($1, 0))";
const TOKEN = "select set_config('pi.client_token', $1, true)";

type Ref = readonly [kind: string, id: string];

// ---------------------------------------------------------------------------------------------
// Two connections, and the locks one of them waits for
// ---------------------------------------------------------------------------------------------

type Connection = { client: pg.Client; pid: number; query: Query };

async function withConnection<T>(url: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const query: Query = async <Row>(text: string, values?: unknown[]) =>
      (await client.query(text, values)).rows as Row[];
    const pid = one(await query<{ pid: number }>("select pg_backend_pid() as pid")).pid;
    return await fn({ client, pid, query });
  } finally {
    await client.end().catch(() => {});
  }
}

// Whether a backend is waiting for an advisory lock, polled from pg_locks.
async function waiting(db: TestDatabase, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await queryAs<{ n: number }>(
      db.urls.admin,
      "select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and not granted",
      [pid],
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    await pause(50);
  }
  return false;
}

// Whether a promise has settled, without waiting for it.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await pause(100);
  return done;
}

const outcome = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

// One call under a client's token that must answer at once: a call that waits for a lock is
// cancelled by the statement timeout, and the test fails naming it.
async function atOnce<T>(
  db: TestDatabase,
  client: { token: string },
  name: string,
  run: (query: Query) => Promise<T>,
): Promise<T> {
  try {
    return await readAs(db, client.token, async (query) => {
      await query(`set local statement_timeout = '${AT_ONCE}'`);
      return run(query);
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "no code";
    throw new Error(`${name} did not answer at once (${code})`);
  }
}

// The control of a wait: a second connection takes `hold` in an open transaction, the client's
// call waits for it (seen in pg_locks with granted false), and answers once the holder commits.
// Returns that answer.
async function waitsBehind(
  db: TestDatabase,
  hold: (query: Query) => Promise<unknown>,
  client: { token: string },
  name: string,
  run: (query: Query) => Promise<unknown>,
): Promise<unknown> {
  return withConnection(db.urls.reader, (holder) =>
    withConnection(db.urls.reader, async (caller) => {
      await holder.query("begin");
      await hold(holder.query);
      await caller.query("begin");
      await caller.query(TOKEN, [client.token]);
      const call = outcome(run(caller.query));
      expect(await waiting(db, caller.pid), `${name} waits`).toBe(true);
      expect(await settled(call), `${name} has not answered while the lock is held`).toBe(false);
      await holder.query("commit");
      const done = await call;
      await caller.query(done.ok ? "commit" : "rollback");
      if (!done.ok) throw done.error;
      return done.value;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The calls, as a client makes them
// ---------------------------------------------------------------------------------------------

const answerOf = async (query: Query, text: string, values: unknown[]): Promise<unknown> =>
  one(await query<{ answer: unknown }>(text, values)).answer;

type WorkCall = { name: string; run: (client: WorkClient, id: string) => (query: Query) => Promise<unknown> };

// A test cites `cite`, a message the caller can see.
function workCalls(cite: string): WorkCall[] {
  return [
    {
      name: "claim",
      run: (client, id) => (query) =>
        answerOf(query, "select ledger.claim($1::text, $2::text, $3::text, $4::text) as answer", [
          id,
          testId("asg"),
          testId("req"),
          client.session,
        ]),
    },
    {
      name: "release",
      run: (client, id) => (query) =>
        answerOf(query, "select ledger.release($1::text, $2::text, $3::text, null, null) as answer", [
          id,
          testId("req"),
          client.session,
        ]),
    },
    {
      name: "set_intention",
      run: (client, id) => (query) =>
        answerOf(
          query,
          "select ledger.set_intention($1::text, $2::text, $3::text, $4::text, $5::timestamptz, false, false) as answer",
          [testId("itn"), testId("req"), client.session, id, hoursAhead(2)],
        ),
    },
    {
      name: "plan_move",
      run: (client, id) => (query) =>
        answerOf(
          query,
          "select ledger.plan_move($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text) as answer",
          [testId("mov"), id, "prepare", testId("req"), client.session, 1, MOVE_PIN],
        ),
    },
    {
      name: "record_test",
      run: (client, id) => (query) =>
        query(
          "select test_id, counts from ledger.record_test($1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text[])",
          [testId("tst"), testId("req"), client.session, id, "supports", ["message"], [cite]],
        ),
    },
    {
      name: "report_move",
      run: (client, id) => (query) =>
        answerOf(
          query,
          "select ledger.report_move($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text[], $7::text[]) as answer",
          [id, "done", testId("req"), client.session, null, [], []],
        ),
    },
  ];
}

const callNamed = (calls: WorkCall[], name: string): WorkCall => {
  const found = calls.find((call) => call.name === name);
  if (found === undefined) throw new Error(`no call ${name}`);
  return found;
};

// A proposal by a client, with its id and the call that makes it.
type Proposal = { id: string; run: (query: Query) => Promise<unknown> };

const summary = (db: TestDatabase, compartments: readonly string[], table: string, id: string): string =>
  JSON.stringify(
    sealUnder(db.keys, labelOf(compartments), { table, id, column: "body_enc" }, `a made-up summary for ${id}`),
  );

function hypothesisProposal(
  db: TestDatabase,
  client: WorkClient,
  options: { about: Ref | null; refs: readonly Ref[]; kind?: string },
): Proposal {
  const id = testId("hyp");
  return {
    id,
    run: (query) =>
      answerOf(
        query,
        "select ledger.propose_hypothesis($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text[], $9::text[]) as answer",
        [
          id,
          testId("req"),
          client.session,
          options.kind ?? "open_loop",
          options.about === null ? "owner" : options.about[0],
          options.about === null ? null : options.about[1],
          summary(db, client.compartments, "ledger.hypotheses", id),
          options.refs.map(([kind]) => kind),
          options.refs.map(([, ref]) => ref),
        ],
      ),
  };
}

function opportunityProposal(
  db: TestDatabase,
  client: WorkClient,
  options: { about: Ref | null; refs: readonly Ref[]; kind?: string },
): Proposal {
  const id = testId("opp");
  return {
    id,
    run: (query) =>
      answerOf(
        query,
        "select ledger.propose_opportunity($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::jsonb, $10::text[], $11::text[]) as answer",
        [
          id,
          testId("req"),
          client.session,
          options.kind ?? "investigate",
          options.about === null ? "owner" : options.about[0],
          options.about === null ? null : options.about[1],
          null,
          null,
          summary(db, client.compartments, "ledger.opportunities", id),
          options.refs.map(([kind]) => kind),
          options.refs.map(([, ref]) => ref),
        ],
      ),
  };
}

const callAs = <T>(db: TestDatabase, client: { token: string }, run: (query: Query) => Promise<T>): Promise<T> =>
  readAs(db, client.token, run);

const claimAs = async (world: WorkWorld, client: WorkClient, opportunity: string): Promise<Date | null> =>
  one(
    await world.as<{ until: Date | null }>(
      client,
      "select ledger.claim($1::text, $2::text, $3::text, $4::text) as until",
      [opportunity, testId("asg"), testId("req"), client.session],
    ),
  ).until;

const releaseAs = async (world: WorkWorld, client: WorkClient, opportunity: string): Promise<boolean> =>
  one(
    await world.as<{ released: boolean }>(
      client,
      "select ledger.release($1::text, $2::text, $3::text, null, null) = 'released' as released",
      [opportunity, testId("req"), client.session],
    ),
  ).released;

const checkBack = async (
  world: WorkWorld,
  client: WorkClient,
  opportunity: string,
  id: string = testId("itn"),
): Promise<string | null> =>
  one(
    await world.as<{ id: string | null }>(
      client,
      // Each stands beside the last, so a caller's three count toward the cap.
      "select ledger.set_intention($1::text, $2::text, $3::text, $4::text, $5::timestamptz, true, false) as id",
      [id, testId("req"), client.session, opportunity, hoursAhead(2)],
    ),
  ).id;

const checkBackBlocked = (world: WorkWorld, client: WorkClient, opportunities: string[]) =>
  world.as<{ opportunity_id: string; blocked: boolean }>(
    client,
    "select opportunity_id, blocked from ledger.check_back_blocked($1::text[])",
    [opportunities],
  );

type TestRow = { test_id: string; counts: boolean };
const recordTest = (
  world: WorkWorld,
  client: WorkClient,
  hypothesis: string,
  cite: string,
  id: string = testId("tst"),
): Promise<TestRow[]> =>
  world.as<TestRow>(
    client,
    "select test_id, counts from ledger.record_test($1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text[])",
    [id, testId("req"), client.session, hypothesis, "supports", ["message"], [cite]],
  );

const reportWith = async (
  world: WorkWorld,
  client: WorkClient,
  move: string,
  refs: readonly Ref[],
): Promise<string | null> =>
  one(
    await world.as<{ status: string | null }>(
      client,
      "select ledger.report_move($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text[], $7::text[]) as status",
      [move, "done", testId("req"), client.session, null, refs.map(([kind]) => kind), refs.map(([, ref]) => ref)],
    ),
  ).status;

// ---------------------------------------------------------------------------------------------
// Runs, as the tick queues one and the reasoner works one
// ---------------------------------------------------------------------------------------------

// A queued run, as pi_work: the row and its queued event. A pause first, so runs queued one
// after the other are taken oldest first.
async function queueRun(world: WorkWorld, compartments: readonly string[]): Promise<string> {
  await pause(5);
  const id = testId("run");
  const label = labelOf(compartments);
  await world.work(
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, 'system:tick', $3, 'owner_request', $4, 'run_outcome', 1, 'personal_run', '1')`,
    [id, testId("req"), label, `owner_request:${id}`],
  );
  await world.work(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:tick', $2)",
    [id, label],
  );
  return id;
}

// A tool call step that answered ok.
const appendStep = async (world: WorkWorld, reasoner: WorkClient, run: string, ordinal: number): Promise<boolean> =>
  one(
    await world.as<{ go: boolean }>(
      reasoner,
      "select ledger.append_step($1::text, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::bigint) as go",
      [run, ordinal, reasoner.session, "tool_call", "ok", "search", null, null, null, null, null],
    ),
  ).go;

type Finished = { recorded: number; outcome: string };
const finishRun = (
  world: WorkWorld,
  reasoner: WorkClient,
  run: string,
  actions: unknown[],
  end: { outcome: "finished" | "failed"; code: string | null } = { outcome: "finished", code: null },
) =>
  world.as<Finished>(
    reasoner,
    "select recorded, outcome from ledger.finish_run($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text, $8::jsonb)",
    [run, testId("req"), reasoner.session, end.outcome, end.code, 1, RUN_PIN, JSON.stringify(actions)],
  );
const FAILED = { outcome: "failed" as const, code: "bad_output" };

// A run's propose action about `about`, citing `cite`, sealed under the run's label.
function proposeAction(db: TestDatabase, about: Ref, cite: string) {
  const id = testId("opp");
  return {
    do: "propose",
    id,
    kind: "follow_up",
    about_kind: about[0],
    about_id: about[1],
    ref_kinds: ["message"],
    ref_ids: [cite],
    due_at: hoursAhead(48),
    probability: 0.4,
    probability_if_waiting: 0.2,
    body_enc: sealUnder(
      db.keys,
      OWN,
      { table: "ledger.opportunities", id, column: "body_enc" },
      `a made-up summary for ${id}`,
    ),
  };
}

const runEvent = async (world: WorkWorld, run: string): Promise<{ event: string; code: string | null }> =>
  one(
    await world.admin<{ event: string; code: string | null }>(
      "select event, code from ledger.record_events where row_kind = 'run' and row_id = $1 order by id desc limit 1",
      [run],
    ),
  );

// An erasure as pi_admin writes one, at the next sequence number, with the compartments it touched.
async function erase(world: WorkWorld, touched: readonly string[] | null): Promise<void> {
  const ruling = testId("rul");
  await world.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
    [ruling, testId("req")],
  );
  const { seq } = one(await world.admin<{ seq: number }>("select policy.erasure_mark()::int + 1 as seq"));
  await world.admin(
    "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments, touched) values ($1, $2, 'item', $3, now(), 0, 0, 0, '{own}', $4)",
    [testId("ers"), ruling, seq, touched === null ? null : [...touched]],
  );
}

// ---------------------------------------------------------------------------------------------
// People, vetoes, and what the ledger holds
// ---------------------------------------------------------------------------------------------

// An address of a person under one label, as pi_admin. Returns the address's fingerprint.
async function addAccount(
  db: TestDatabase,
  admin: Query,
  entity: string,
  address: string,
  compartments: readonly string[],
): Promise<string> {
  const id = testId("adr");
  const fp = fingerprint(db.keys, "address", address);
  await admin(
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
    [
      id,
      entity,
      fp,
      fingerprint(db.keys, "domain", address.slice(address.indexOf("@") + 1)),
      sealRow(db.keys, compartments[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, address),
      [...compartments],
    ],
  );
  return fp;
}

let people = 0;
// A person with one address under each label given, in order. Returns the entity and each
// address's fingerprint.
async function personWith(
  db: TestDatabase,
  admin: Query,
  labels: readonly (readonly string[])[],
): Promise<{ id: string; fps: string[] }> {
  people += 1;
  const id = testId("ent");
  await admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [id]);
  const fps: string[] = [];
  for (const [index, compartments] of labels.entries())
    fps.push(await addAccount(db, admin, id, `person-${people}-${index}@inv6-example.test`, compartments));
  return { id, fps };
}

// A veto on a person by address fingerprints, as pi_admin: its decision row, then the veto.
async function veto(admin: Query, fps: string[]): Promise<string> {
  const id = testId("rul");
  await admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
    [id, testId("req")],
  );
  await admin(
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'person', $2, null, now(), '{own}')",
    [id, fps],
  );
  return id;
}

async function lift(admin: Query, ruling: string): Promise<void> {
  const id = testId("rul");
  await admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto_lift', 0, '{}', '{}', now(), '{own}')",
    [id, testId("req")],
  );
  await admin("update knowledge.vetoes set lifted_at = now(), lift_ruling_id = $2 where ruling_id = $1", [ruling, id]);
}

// Every row of the tables the work functions write, with its xmin: equal before and after means
// nothing was written, updated or deleted.
const WRITTEN: [table: string, key: string][] = [
  ["ledger.runs", "id"],
  ["ledger.run_attempts", "run_id || '/' || attempt::text"],
  ["ledger.run_steps", "id"],
  ["ledger.cases", "id"],
  ["ledger.hypotheses", "id"],
  ["ledger.hypothesis_tests", "id"],
  ["ledger.opportunities", "id"],
  ["ledger.opportunity_decisions", "id"],
  ["ledger.assignments", "id"],
  ["ledger.moves", "id"],
  ["ledger.intentions", "id"],
  ["ledger.decision_point_calls", "id"],
  ["ledger.record_events", "id"],
  ["ledger.basis", "id"],
  ["queue.leases", "resource_kind || '/' || resource_id"],
];
async function ledgerRows(admin: Query): Promise<string[]> {
  const lines: string[] = [];
  for (const [table, key] of WRITTEN) {
    for (const row of await admin<{ line: string }>(
      `select '${table} ' || (${key})::text || ' ' || xmin::text as line from ${table}`,
    ))
      lines.push(row.line);
  }
  return lines.sort();
}

// The work world's grants for meeting_prep at its one stage, prepare, to each client given.
async function grantPrepare(world: WorkWorld, clients: WorkClient[]): Promise<string> {
  const intent = await world.intent(
    ["meeting_prep"],
    clients.map((client) => client.id),
  );
  for (const client of clients) await world.harness(client, "meeting_prep", "prepare");
  return intent;
}

// An opportunity under `compartments`, by a run, that the owner sent to go under `intent`.
async function goOpportunity(
  world: WorkWorld,
  intent: string,
  options: { compartments?: string[]; about?: Ref } = {},
): Promise<string> {
  const { id } = await world.opportunity({
    ...(options.compartments === undefined ? {} : { compartments: options.compartments }),
    ...(options.about === undefined ? {} : { about: [options.about[0], options.about[1]] }),
  });
  await world.decision(id, "go", { intent });
  return id;
}

describe("a function locks only a row the caller can see", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a hidden opportunity, hypothesis and move held by another connection make claim, release, record_test, set_intention, plan_move and report_move answer at once, as for an absent id; on a visible one they wait", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const e = await world.agent(WORK);
      const intent = await grantPrepare(world, [a, e]);
      const cite = (await world.mail()).id;
      // Under employer:example, which A cannot see: an opportunity, a hypothesis, and a move E
      // planned on another opportunity there.
      const hiddenOpportunity = (await world.opportunity({ compartments: WORK })).id;
      const hiddenHypothesis = (await world.hypothesis({ compartments: WORK })).id;
      const hiddenMove = await world.claimAndPlan(
        e,
        await goOpportunity(world, intent, { compartments: WORK }),
        "prepare",
      );
      // Under own: the same three, the opportunity A's and the move A's.
      const visibleOpportunity = await goOpportunity(world, intent);
      const visibleMove = await world.claimAndPlan(a, visibleOpportunity, "prepare");
      const visibleHypothesis = (await world.hypothesis()).id;
      const calls = workCalls(cite);

      // Each function on each hidden id, while another connection holds all three, answers at
      // once what it answers for an id that does not exist.
      const hidden = [hiddenOpportunity, hiddenHypothesis, hiddenMove];
      await withConnection(world.db.urls.admin, async (holder) => {
        await holder.query("begin");
        for (const id of hidden) await holder.query(ROW_LOCK, [id]);
        for (const call of calls) {
          const absent = await atOnce(world.db, a, `${call.name} on an absent id`, call.run(a, testId("opp")));
          for (const id of hidden)
            expect(
              await atOnce(world.db, a, `${call.name} on ${id}`, call.run(a, id)),
              `${call.name} on ${id}`,
            ).toEqual(absent);
        }
        await holder.query("commit");
      });

      // The controls: each function on its own kind of row, visible to A and held, waits until
      // the holder commits, then answers.
      const visible: [name: string, id: string][] = [
        ["claim", visibleOpportunity],
        ["set_intention", visibleOpportunity],
        ["plan_move", visibleOpportunity],
        ["record_test", visibleHypothesis],
        ["report_move", visibleMove],
        ["release", visibleOpportunity],
      ];
      for (const [name, id] of visible) {
        await waitsBehind(
          world.db,
          (query) => query(ROW_LOCK, [id]),
          a,
          `${name} on a visible row`,
          callNamed(calls, name).run(a, id),
        );
      }
    }));

  it("a proposal under own does not wait for one under employer:example about the same subject, and waits for one under own", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const b = await world.agent(OWN);
      const e = await world.agent(WORK);
      const ownCite: Ref[] = [["message", (await world.mail()).id]];
      const workCite: Ref[] = [["message", (await world.mail({ compartments: WORK })).id]];
      // Each kind of proposal, about the owner: the same subject for every client. The control
      // uses a second kind of row, so A's control is a case of its own.
      const kinds = [
        { name: "propose_hypothesis", make: hypothesisProposal, first: "open_loop", second: "at_risk" },
        { name: "propose_opportunity", make: opportunityProposal, first: "investigate", second: "follow_up" },
      ];
      for (const kind of kinds) {
        // E's proposal, under employer:example, held open by its transaction: A's, under own,
        // answers at once with its own row, as with no proposal under employer:example at all.
        const byE = kind.make(world.db, e, { about: null, refs: workCite, kind: kind.first });
        const byA = kind.make(world.db, a, { about: null, refs: ownCite, kind: kind.first });
        await withConnection(world.db.urls.reader, async (holder) => {
          await holder.query("begin");
          await holder.query(TOKEN, [e.token]);
          expect(await byE.run(holder.query), `${kind.name} by E`).toBe(byE.id);
          expect(await atOnce(world.db, a, `${kind.name} by A beside E's`, byA.run)).toBe(byA.id);
          await holder.query("commit");
        });

        // The control: B's proposal under own about the same subject, held open, makes A's wait
        // until it commits.
        const byB = kind.make(world.db, b, { about: null, refs: ownCite, kind: kind.second });
        const again = kind.make(world.db, a, { about: null, refs: ownCite, kind: kind.second });
        const answer = await waitsBehind(
          world.db,
          async (query) => {
            await query(TOKEN, [b.token]);
            expect(await byB.run(query), `${kind.name} by B`).toBe(byB.id);
          },
          a,
          `${kind.name} by A beside B's`,
          again.run,
        );
        expect(answer).toBe(again.id);
      }
    }));
});

describe("an entity is what a row is about only through rows the caller can see", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("an entity known only under employer:example is refused by propose_hypothesis, propose_opportunity and finish_run as an absent one is", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const reasoner = await world.reasoner(OWN);
      const cite = (await world.mail()).id;
      const refs: Ref[] = [["message", cite]];
      const known = await personWith(world.db, world.admin, [OWN]);
      const hiddenOnly = await personWith(world.db, world.admin, [WORK]);
      const entities: [name: string, id: string][] = [
        ["known only under employer:example", hiddenOnly.id],
        ["absent", testId("ent")],
      ];

      const before = await ledgerRows(world.admin);
      for (const [name, entity] of entities) {
        expect(
          await callAs(world.db, a, hypothesisProposal(world.db, a, { about: ["entity", entity], refs }).run),
          `propose_hypothesis, ${name}`,
        ).toBeNull();
        expect(
          await callAs(world.db, a, opportunityProposal(world.db, a, { about: ["entity", entity], refs }).run),
          `propose_opportunity, ${name}`,
        ).toBeNull();
      }
      expect(await ledgerRows(world.admin)).toEqual(before);
      // The control: an entity with an address under own is taken.
      const hypothesis = hypothesisProposal(world.db, a, { about: ["entity", known.id], refs });
      expect(await callAs(world.db, a, hypothesis.run)).toBe(hypothesis.id);
      const opportunity = opportunityProposal(world.db, a, { about: ["entity", known.id], refs });
      expect(await callAs(world.db, a, opportunity.run)).toBe(opportunity.id);

      // finish_run: no row, nothing written, and the run still running.
      const run = await queueRun(world, OWN);
      expect(await world.take(reasoner)).toBe(run);
      const taken = await ledgerRows(world.admin);
      for (const [name, entity] of entities) {
        expect(
          await finishRun(world, reasoner, run, [proposeAction(world.db, ["entity", entity], cite)]),
          `finish_run, ${name}`,
        ).toEqual([]);
        expect(await ledgerRows(world.admin), name).toEqual(taken);
        expect((await runEvent(world, run)).event, name).toBe("running");
      }
      expect(await finishRun(world, reasoner, run, [proposeAction(world.db, ["entity", known.id], cite)])).toEqual([
        { recorded: 1, outcome: "finished" },
      ]);
    }));
});

describe("a test wider than its hypothesis does not count", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a test labelled wider than its hypothesis is stored with counts false and moves no status", () =>
    withWorkWorld(async (world) => {
      const wide = await world.agent(BOTH);
      const narrow = await world.agent(OWN);
      const cite = (await world.mail()).id;
      // Two own hypotheses by a run; the wide client tests the first, and the second is its twin
      // with no hidden test.
      const tested = (await world.hypothesis()).id;
      const twin = (await world.hypothesis()).id;
      const wider = testId("tst");
      expect(await recordTest(world, wide, tested, cite, wider)).toEqual([{ test_id: wider, counts: false }]);
      expect(
        await world.admin("select counts, compartments from ledger.hypothesis_tests where id = $1", [wider]),
      ).toEqual([{ counts: false, compartments: labelOf(BOTH) }]);
      expect(await world.latest("hypothesis", tested)).toBe("open");
      expect(await world.latest("hypothesis", tested)).toBe(await world.latest("hypothesis", twin));

      // The control: a test by an own client, within the hypothesis's label, counts and moves it.
      const within = testId("tst");
      expect(await recordTest(world, narrow, tested, cite, within)).toEqual([{ test_id: within, counts: true }]);
      expect(await world.latest("hypothesis", tested)).toBe("supported");
    }));

  it("a test within it moves the status", () =>
    withWorkWorld(async (world) => {
      const wide = await world.agent(BOTH);
      const narrow = await world.agent(OWN);
      const cite = (await world.mail()).id;
      // Under own, an own client's test; under both compartments, the wide client's: each label
      // is within its hypothesis's.
      const ownHypothesis = (await world.hypothesis()).id;
      const wideHypothesis = (await world.hypothesis({ compartments: BOTH })).id;
      const ownTest = testId("tst");
      const wideTest = testId("tst");
      expect(await recordTest(world, narrow, ownHypothesis, cite, ownTest)).toEqual([
        { test_id: ownTest, counts: true },
      ]);
      expect(await recordTest(world, wide, wideHypothesis, cite, wideTest)).toEqual([
        { test_id: wideTest, counts: true },
      ]);
      expect(await world.latest("hypothesis", ownHypothesis)).toBe("supported");
      expect(await world.latest("hypothesis", wideHypothesis)).toBe("supported");
    }));
});

describe("another client's check-back holds a caller off only within its clearance", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  // The check-back falls due as the tick leaves it: the lease run out, the setter's preference
  // kept for 24 hours on the lease row, and the opportunity back at go.
  const fallsDue = async (world: WorkWorld, opportunity: string): Promise<void> => {
    await world.work(
      "update queue.leases set lease_until = now() - interval '1 minute', preferred_until = now() + interval '24 hours' where resource_kind = 'opportunity' and resource_id = $1",
      [opportunity],
    );
    await world.status("opportunity", opportunity, "go", { by: "system:work" });
  };

  it("a wider client's check-back neither blocks an own client nor counts toward three: it does not block", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const b = await world.agent(OWN);
      const wide = await world.agent(BOTH);
      const intent = await grantPrepare(world, [a, b, wide]);
      // The wide client's check-back, labelled with both compartments, on an own opportunity.
      const held = await goOpportunity(world, intent);
      expect(await claimAs(world, wide, held)).toBeInstanceOf(Date);
      expect(await checkBack(world, wide, held)).not.toBeNull();
      await fallsDue(world, held);
      // Its twin with no check-back.
      const plain = await goOpportunity(world, intent);
      // The control: an own client's check-back.
      const ownHeld = await goOpportunity(world, intent);
      expect(await claimAs(world, b, ownHeld)).toBeInstanceOf(Date);
      expect(await checkBack(world, b, ownHeld)).not.toBeNull();
      await fallsDue(world, ownHeld);

      // A sees the wide client's held opportunity as it sees the one with no check-back.
      expect(await checkBackBlocked(world, a, [held, plain])).toEqual(
        [held, plain].sort().map((id) => ({ opportunity_id: id, blocked: false })),
      );
      expect(await checkBackBlocked(world, a, [ownHeld])).toEqual([{ opportunity_id: ownHeld, blocked: true }]);
      expect(await claimAs(world, a, ownHeld)).toBeNull();
      expect(await claimAs(world, a, held)).toBeInstanceOf(Date);
      expect(await claimAs(world, a, plain)).toBeInstanceOf(Date);
    }));

  it("a wider client's check-back neither blocks an own client nor counts toward three: it does not count", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const b = await world.agent(OWN);
      const wide = await world.agent(BOTH);
      const intent = await grantPrepare(world, [a, b, wide]);
      // Three check-backs by a holder, which then gives the opportunity back.
      const threeBy = async (client: WorkClient): Promise<string> => {
        const opportunity = await goOpportunity(world, intent);
        expect(await claimAs(world, client, opportunity)).toBeInstanceOf(Date);
        for (let index = 0; index < 3; index += 1) expect(await checkBack(world, client, opportunity)).not.toBeNull();
        expect(await releaseAs(world, client, opportunity)).toBe(true);
        return opportunity;
      };
      const counted = await threeBy(wide);
      const fresh = await goOpportunity(world, intent);
      const ownCounted = await threeBy(b);

      // A's check-back on the wide client's opportunity is taken as on one with none.
      for (const opportunity of [counted, fresh]) {
        expect(await claimAs(world, a, opportunity)).toBeInstanceOf(Date);
        const id = testId("itn");
        expect(await checkBack(world, a, opportunity, id)).toBe(id);
      }
      // The cap is each client's own, so no other client's check-back counts toward it, an own
      // client's three included: A's first three are taken. The control: A's own fourth is refused
      // with 22023.
      expect(await claimAs(world, a, ownCounted)).toBeInstanceOf(Date);
      for (let index = 0; index < 3; index += 1) expect(await checkBack(world, a, ownCounted)).not.toBeNull();
      expect(await sqlState(() => checkBack(world, a, ownCounted))).toBe("22023");
    }));
});

describe("an erasure moves a run's mark only when it touched the run's clearance", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("an erasure touching only employer:example leaves an own client's erasure_mark unchanged; one touching own, and one with no touched, change it", () =>
    withWorkWorld(async (world) => {
      const reasoner = await world.reasoner(OWN);
      const mark = async (): Promise<string> =>
        one(await world.as<{ mark: string }>(reasoner, "select policy.erasure_mark()::text as mark")).mark;
      // With no client, as the tick reads it: every erasure moves it.
      const globalMark = async (): Promise<string> =>
        one(await world.admin<{ mark: string }>("select policy.erasure_mark()::text as mark")).mark;

      let before = await mark();
      let globalBefore = await globalMark();
      await erase(world, WORK);
      expect(await globalMark(), "the erasure is there").not.toBe(globalBefore);
      expect(await mark()).toBe(before);
      for (const touched of [OWN, null]) {
        before = await mark();
        globalBefore = await globalMark();
        await erase(world, touched);
        expect(await globalMark()).not.toBe(globalBefore);
        expect(await mark(), `touched ${String(touched)}`).not.toBe(before);
      }
    }));

  it("an erasure touching only employer:example leaves an own run's mark unchanged; one touching own, and one with no touched, change it", () =>
    withWorkWorld(async (world) => {
      const reasoner = await world.reasoner(OWN);
      // An own run taken before an erasure under employer:example: its next step and its end
      // answer as with no erasure at all.
      const kept = await queueRun(world, OWN);
      expect(await world.take(reasoner)).toBe(kept);
      expect(await appendStep(world, reasoner, kept, 1)).toBe(true);
      await erase(world, WORK);
      expect(await appendStep(world, reasoner, kept, 2)).toBe(true);
      expect(await finishRun(world, reasoner, kept, [], FAILED)).toEqual([{ recorded: 0, outcome: "failed" }]);
      expect(await runEvent(world, kept)).toEqual({ event: "failed", code: "bad_output" });

      for (const touched of [OWN, null]) {
        const run = await queueRun(world, OWN);
        expect(await world.take(reasoner)).toBe(run);
        expect(await appendStep(world, reasoner, run, 1)).toBe(true);
        await erase(world, touched);
        expect(await appendStep(world, reasoner, run, 2), `touched ${String(touched)}`).toBe(false);
        expect(await finishRun(world, reasoner, run, [], FAILED), `touched ${String(touched)}`).toEqual([
          { recorded: 0, outcome: "stopped" },
        ]);
        expect(await runEvent(world, run)).toEqual({ event: "stopped", code: "erasure" });
      }
    }));
});

describe("next_run takes only a run within the reasoner's clearance", { timeout: DB_TEST_TIMEOUT }, () => {
  it("next_run hands no run outside the reasoner's clearance, and hands an own run", () =>
    withWorkWorld(async (world) => {
      const reasoner = await world.reasoner(OWN);
      // The hidden run is the older one: on the queue's order alone, it would be taken first.
      const hidden = await queueRun(world, WORK);
      const own = await queueRun(world, OWN);
      expect(await world.take(reasoner)).toBe(own);
      expect(await world.take(reasoner)).toBeNull();
      expect(await world.latest("run", hidden)).toBe("queued");
      expect(await world.admin("select attempt from ledger.run_attempts where run_id = $1", [hidden])).toEqual([]);
      // The control: the next own run is taken as if the hidden one were not there.
      const next = await queueRun(world, OWN);
      expect(await world.take(reasoner)).toBe(next);
    }));
});

describe("a recipient is matched to a claim's thread through the claim's own compartments", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("use_only_candidates answers the same with and without an employer:example account for the recipient", () =>
    withSendWorld(async (w) => {
      const seed = seeder(w.db, w.admin);
      const to = "rowan@send-example.test";
      // An own claim on an own message, which names a person through an interaction row.
      const source = await insertMessage(w);
      const claim = await seed.claim(OWN, source.evidence);
      const person = (await personWith(w.db, w.admin, [OWN])).id;
      await insertInteraction(w, source.evidence, person);
      const draft = await madeDraft(w, { to: [to] });
      type Candidate = { claim_id: string; cited_item: boolean; compartments: string[] };
      const sql = "select claim_id, cited_item, compartments from ledger.use_only_candidates($1::text)";
      const asReader = () => readAs(w.db, w.client.token, (query) => query<Candidate>(sql, [draft.id]));
      const asProxy = () => proxy<Candidate>(w.db, sql, [draft.id]);

      const reader = await asReader();
      const sent = await asProxy();
      expect(reader.map((row) => row.claim_id)).toContain(claim);
      // The person gains the recipient's address under employer:example only: nothing changes.
      await addAccount(w.db, w.admin, person, to, WORK);
      expect(await asReader()).toEqual(reader);
      expect(await asProxy()).toEqual(sent);
      // The control: the same address under own puts the recipient on the claim's thread.
      await addAccount(w.db, w.admin, person, to, OWN);
      expect((await asReader()).map((row) => row.claim_id)).not.toContain(claim);
      expect((await asProxy()).map((row) => row.claim_id)).not.toContain(claim);
    }));
});

describe("a veto matched only through employer:example shows the own client one bit", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a veto matched only through an employer:example account refuses claim with null, exactly as a claim refused for a lease another client holds", () =>
    withWorkWorld(async (world) => {
      const a = await world.agent(OWN);
      const b = await world.agent(OWN);
      const intent = await grantPrepare(world, [a, b]);
      // A person with an address under own and one under employer:example; the veto names the
      // second only.
      const vetoed = await personWith(world.db, world.admin, [OWN, WORK]);
      const other = await personWith(world.db, world.admin, [OWN]);
      const target = await goOpportunity(world, intent, { about: ["entity", vetoed.id] });
      // A claim refused for another reason: B holds the lease.
      const held = await goOpportunity(world, intent, { about: ["entity", other.id] });
      expect(await claimAs(world, b, held)).toBeInstanceOf(Date);
      const ruling = await veto(world.admin, [vetoed.fps[1] ?? ""]);

      const before = await ledgerRows(world.admin);
      const byVeto = await claimAs(world, a, target);
      const byLease = await claimAs(world, a, held);
      expect(byVeto).toBeNull();
      expect(byVeto).toEqual(byLease);
      expect(await ledgerRows(world.admin)).toEqual(before);
      // The control: with the veto lifted, the same claim is taken.
      await lift(world.admin, ruling);
      expect(await claimAs(world, a, target)).toBeInstanceOf(Date);
    }));

  it("a veto matched only through an employer:example account makes gate_facts for the reader show the veto fields zeroed and status held, exactly as a held verdict for another reason", () =>
    withSendWorld(async (w) => {
      // Two own messages, each naming a person: the first a person with an address under
      // employer:example that a veto names, the second a person no veto names.
      const vetoed = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [vetoed]);
      await addAccount(w.db, w.admin, vetoed, "vetoed-home@inv6-example.test", OWN);
      const workFp = await addAccount(w.db, w.admin, vetoed, "vetoed-work@inv6-example.test", WORK);
      const other = (await personWith(w.db, w.admin, [OWN])).id;
      const first = await insertMessage(w);
      await insertInteraction(w, first.evidence, vetoed);
      const second = await insertMessage(w);
      await insertInteraction(w, second.evidence, other);
      const ruling = await veto(w.admin, [workFp]);

      // Held by the function's own vetoes row, and held because the client failed freshness.
      const byVeto = await madeDraft(w, { refs: [["message", first.id]] });
      const byFreshness = await madeDraft(w, { refs: [["message", second.id]] }, ["freshness"]);
      const comparable = (facts: GateFacts) => ({ ...facts, draft: { ...facts.draft, ageSeconds: 0 } });
      const vetoFacts = await factsAsReader(w, byVeto.id);
      const freshnessFacts = await factsAsReader(w, byFreshness.id);
      expect(vetoFacts.draft.status).toBe("held");
      expect({ recipients: vetoFacts.recipients, about: vetoFacts.about, killSwitch: vetoFacts.killSwitch }).toEqual({
        recipients: { count: 1, vetoed: 0, suppressed: 0, firstContact: 1 },
        about: { vetoed: false },
        killSwitch: false,
      });
      expect(comparable(vetoFacts)).toEqual(comparable(freshnessFacts));

      // The controls: the veto is matched, globally, for pi_proxy; and with it lifted the same
      // draft is made.
      expect((await factsAsProxy(w, byVeto.id, "send")).about.vetoed).toBe(true);
      expect((await factsAsProxy(w, byFreshness.id, "send")).about.vetoed).toBe(false);
      await lift(w.admin, ruling);
      const after = await madeDraft(w, { refs: [["message", first.id]] });
      expect((await factsAsReader(w, after.id)).draft.status).toBe("made");
    }));
});

describe("a move's basis is within the move's label", { timeout: DB_TEST_TIMEOUT }, () => {
  it("report_move refuses a ref outside the move's label and accepts one inside", () =>
    withWorkWorld(async (world) => {
      // A client cleared for both compartments reports a move on an own opportunity.
      const wide = await world.agent(BOTH);
      const intent = await grantPrepare(world, [wide]);
      const opportunity = await goOpportunity(world, intent);
      const move = await world.claimAndPlan(wide, opportunity, "prepare");
      expect(await world.admin("select compartments from ledger.moves where id = $1", [move])).toEqual([
        { compartments: OWN },
      ]);
      const workMail = await world.mail({ compartments: WORK });
      const ownMail = await world.mail();

      // A ref under employer:example is refused as a ref that does not exist is, and writes nothing.
      const before = await ledgerRows(world.admin);
      expect(await reportWith(world, wide, move, [["message", workMail.id]])).toBeNull();
      expect(await reportWith(world, wide, move, [["message", testId("msg")]])).toBeNull();
      expect(await ledgerRows(world.admin)).toEqual(before);
      // The control: a ref under own is taken, and its basis row carries the move's label.
      expect(await reportWith(world, wide, move, [["message", ownMail.id]])).toBe("done");
      expect(
        await world.admin(
          "select ref_kind, ref_id, compartments from ledger.basis where row_kind = 'move' and row_id = $1",
          [move],
        ),
      ).toEqual([{ ref_kind: "message", ref_id: ownMail.id, compartments: OWN }]);
    }));

  it("deleting an employer:example item taints no row labelled own", () =>
    withWorkWorld(async (world) => {
      const wide = await world.agent(BOTH);
      const intent = await grantPrepare(world, [wide]);
      const workMail = await world.mail({ compartments: WORK });
      const ownMail = await world.mail();
      // What the wide client writes on own rows, citing what it may: a move it reports.
      const move = await world.claimAndPlan(wide, await goOpportunity(world, intent), "prepare");
      await reportWith(world, wide, move, [["message", workMail.id]]);
      await reportWith(world, wide, move, [["message", ownMail.id]]);
      // The control: a row under the wide client's own label that cites the item.
      const wideRow = opportunityProposal(world.db, wide, {
        about: ["message", workMail.id],
        refs: [["message", workMail.id]],
      });
      expect(await callAs(world.db, wide, wideRow.run)).toBe(wideRow.id);

      // The item deleted as the writer deletes one: its rows, and taint_citing with its evidence
      // id and its ref, in one transaction as pi_admin.
      await world.admin("begin");
      await world.admin("delete from knowledge.messages where id = $1", [workMail.id]);
      await world.admin("delete from vault.pipeline_items where evidence_id = $1", [workMail.evidence]);
      const { n } = one(
        await world.admin<{ n: number }>("select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n", [
          [workMail.evidence],
          [workMail.id],
        ]),
      );
      await world.admin("delete from vault.evidence_items where id = $1", [workMail.evidence]);
      await world.admin("commit");

      expect(n).toBeGreaterThan(0);
      expect(
        await world.admin(
          "select tainted_at is not null as tainted, compartments from ledger.opportunities where id = $1",
          [wideRow.id],
        ),
      ).toEqual([{ tainted: true, compartments: labelOf(BOTH) }]);
      const ownTainted: string[] = [];
      for (const table of [
        "ledger.opportunities",
        "ledger.hypotheses",
        "ledger.hypothesis_tests",
        "ledger.intentions",
        "ledger.moves",
        "ledger.runs",
        "ledger.basis",
        "ledger.record_events",
        "ledger.cards",
      ]) {
        const rows = await world.admin<{ line: string }>(
          `select '${table} ' || id::text as line from ${table} where tainted_at is not null and compartments = '{own}'::text[]`,
        );
        ownTainted.push(...rows.map((row) => row.line));
      }
      expect(ownTainted).toEqual([]);
    }));
});

describe("the dispatcher's open count is the owner's control", { timeout: DB_TEST_TIMEOUT }, () => {
  // What the tick reads to decide an own proposed opportunity, as max_open fills under `label`:
  // with one go opportunity under the intent, then with two. Ids are left out.
  const factsAsFilled = (label: string[]) =>
    withWorkWorld(async (world) => {
      const intent = await world.intent(["meeting_prep"], [], { maxOpen: 2 });
      const proposed = (await world.opportunity()).id;
      const dispatch = world.dispatch();
      const read = async (): Promise<unknown> => {
        const found: ToDecide | null = await dispatch.opportunityToDecide(proposed as OpportunityId, new Date());
        if (found === null) throw new Error("the own opportunity is not to be decided");
        return {
          status: found.status,
          facts: {
            ...found.facts,
            intents: found.facts.intents.map((entry) => ({
              intent: entry.id === intent ? "the intent" : entry.id,
              mode: entry.mode,
              open: entry.open,
              maxOpen: entry.maxOpen,
              activeClients: entry.activeClients,
            })),
          },
        };
      };
      const filled: unknown[] = [];
      for (let count = 1; count <= 2; count += 1) {
        const { id } = await world.opportunity({ compartments: label });
        await world.decision(id, "go", { by: "policy", intent });
        filled.push(await read());
      }
      expect(await world.latest("opportunity", proposed)).toBe("proposed");
      return filled;
    });

  it(
    "an intent's max_open reached by employer:example opportunities holds an own opportunity exactly as own ones do",
    async () => {
      const byWork = await factsAsFilled(WORK);
      const byOwn = await factsAsFilled(OWN);
      expect(byWork).toEqual(byOwn);
      // The intent is full at the second, under either label: the tick holds the own opportunity.
      expect(byWork[1]).toMatchObject({
        status: "proposed",
        facts: { intents: [{ intent: "the intent", open: 2, maxOpen: 2 }] },
      });
      // The control: one below max_open, the count is one.
      expect(byWork[0]).toMatchObject({ facts: { intents: [{ intent: "the intent", open: 1, maxOpen: 2 }] } });
    },
    DB_TEST_TIMEOUT,
  );
});
