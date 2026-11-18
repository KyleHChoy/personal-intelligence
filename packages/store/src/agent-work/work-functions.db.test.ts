import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { ALL_TOOLS, ALL_VIEWS, revokeClient, sha256Hex, testId } from "../test-support/clients.ts";
import { asOwner, one, type Query, readAs, session, sqlState } from "../test-support/connections.ts";
import { queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { UNKNOWN_TOKEN } from "../test-support/values.ts";
import { insertWorkClient, openWorkSession, WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";

// Clients, intents and harness modes are inserted as pi_admin; a session is opened with
// policy.open_session and a read logged with policy.log_read under the client's token; the
// functions are called as pi_reader with the token set; a run is queued, and an owner's go written,
// as pi_work. Every refusal has its positive control in the same test.

const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["own", "employer:example"];
// Every read tool the fixtures know, read_message among them, and all twelve work and run tools:
// the kind and registration tests take one away at a time.
const EVERY_TOOL = [...ALL_TOOLS, "find_messages", "read_message", ...WORK_TOOLS];
const HASH = sha256Hex("work functions test definition");
// A label as ledger.label writes it: each once, sorted bytewise.
const labelOf = (compartments: readonly string[]): string[] => [...new Set(compartments)].sort();
const hoursAhead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

type Ref = readonly [kind: string, id: string];
type About = readonly ["owner", null] | readonly [kind: string, id: string];
type Message = { id: string; evidence: string };
const kindsOf = (refs: readonly Ref[]): string[] => refs.map(([kind]) => kind);
const idsOf = (refs: readonly Ref[]): string[] => refs.map(([, id]) => id);

// ---------------------------------------------------------------------------------------------
// The calls, with the signatures of the conventions file: session_id follows request_id, every
// id and word is text.
// ---------------------------------------------------------------------------------------------

const SQL = {
  clientKind: "select policy.current_client_kind() as kind",
  workGrants: "select intent_id, opportunity_kind, stage, harness_mode_id from ledger.work_grants()",
  proposeHypothesis:
    "select ledger.propose_hypothesis($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text[], $9::text[]) as id",
  recordTest:
    "select test_id, counts from ledger.record_test($1::text, $2::text, $3::text, $4::text, $5::text, $6::text[], $7::text[])",
  proposeOpportunity:
    "select ledger.propose_opportunity($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::jsonb, $10::text[], $11::text[]) as id",
  setIntention:
    "select ledger.set_intention($1::text, $2::text, $3::text, $4::text, $5::timestamptz, false, false) as id",
  claim: "select ledger.claim($1::text, $2::text, $3::text, $4::text) as until",
  release: "select ledger.release($1::text, $2::text, $3::text, null, null) = 'released' as released",
  planMove: "select ledger.plan_move($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text) as id",
  reportMove:
    "select ledger.report_move($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text[], $7::text[]) as status",
  nextRun: "select run_id, attempt, compartments from ledger.next_run($1::text, $2::text)",
  appendStep:
    "select ledger.append_step($1::text, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::bigint) as go",
  finishRun:
    "select recorded, outcome from ledger.finish_run($1::text, $2::text, $3::text, $4::text, $5::text, $6::integer, $7::text, $8::jsonb)",
};

// A summary, sealed as the store seals one, under the label of the row it goes on.
const summary = (db: TestDatabase, table: string, id: string, label: readonly string[]): string =>
  JSON.stringify(sealUnder(db.keys, labelOf(label), { table, id, column: "body_enc" }, `a summary for ${id}`));

type HypothesisArgs = {
  id: string;
  requestId: string;
  session: string | null;
  kind: string;
  about: About;
  refs: readonly Ref[];
  body: string;
};
const proposeHypothesis =
  (a: HypothesisArgs) =>
  async (query: Query): Promise<string | null> =>
    one(
      await query<{ id: string | null }>(SQL.proposeHypothesis, [
        a.id,
        a.requestId,
        a.session,
        a.kind,
        a.about[0],
        a.about[1],
        a.body,
        kindsOf(a.refs),
        idsOf(a.refs),
      ]),
    ).id;

type OpportunityArgs = {
  id: string;
  requestId: string;
  session: string | null;
  kind: string;
  about: About;
  hypothesis: string | null;
  dueAt: string | null;
  refs: readonly Ref[];
  body: string;
};
const proposeOpportunity =
  (a: OpportunityArgs) =>
  async (query: Query): Promise<string | null> =>
    one(
      await query<{ id: string | null }>(SQL.proposeOpportunity, [
        a.id,
        a.requestId,
        a.session,
        a.kind,
        a.about[0],
        a.about[1],
        a.hypothesis,
        a.dueAt,
        a.body,
        kindsOf(a.refs),
        idsOf(a.refs),
      ]),
    ).id;

type TestArgs = {
  id: string;
  requestId: string;
  session: string | null;
  hypothesis: string;
  result: string;
  refs: readonly Ref[];
};
type TestRow = { test_id: string; counts: boolean };
const recordTest =
  (a: TestArgs) =>
  (query: Query): Promise<TestRow[]> =>
    query<TestRow>(SQL.recordTest, [
      a.id,
      a.requestId,
      a.session,
      a.hypothesis,
      a.result,
      kindsOf(a.refs),
      idsOf(a.refs),
    ]);

const setIntention =
  (a: { id: string; requestId: string; session: string | null; opportunity: string; dueAt: string }) =>
  async (query: Query): Promise<string | null> =>
    one(await query<{ id: string | null }>(SQL.setIntention, [a.id, a.requestId, a.session, a.opportunity, a.dueAt]))
      .id;

const claim =
  (a: { opportunity: string; assignment: string; requestId: string; session: string | null }) =>
  async (query: Query): Promise<Date | null> =>
    one(await query<{ until: Date | null }>(SQL.claim, [a.opportunity, a.assignment, a.requestId, a.session])).until;

const release =
  (a: { opportunity: string; requestId: string; session: string | null }) =>
  async (query: Query): Promise<boolean | null> =>
    one(await query<{ released: boolean | null }>(SQL.release, [a.opportunity, a.requestId, a.session])).released;

const planMove =
  (a: { move: string; opportunity: string; stage: string; requestId: string; session: string | null }) =>
  async (query: Query): Promise<string | null> =>
    one(
      await query<{ id: string | null }>(SQL.planMove, [
        a.move,
        a.opportunity,
        a.stage,
        a.requestId,
        a.session,
        1,
        HASH,
      ]),
    ).id;

const reportMove =
  (a: { move: string; outcome: string; requestId: string; session: string | null }) =>
  async (query: Query): Promise<string | null> =>
    one(
      await query<{ status: string | null }>(SQL.reportMove, [a.move, a.outcome, a.requestId, a.session, null, [], []]),
    ).status;

type RunRow = { run_id: string; attempt: number; compartments: string[] };
const nextRun =
  (a: { requestId: string; session: string | null }) =>
  (query: Query): Promise<RunRow[]> =>
    query<RunRow>(SQL.nextRun, [a.requestId, a.session]);

// A tool call step: a read tool that answered ok. It carries no cost and no prompt.
const appendStep =
  (a: { run: string; ordinal: number; session: string | null }) =>
  async (query: Query): Promise<boolean | null> =>
    one(
      await query<{ go: boolean | null }>(SQL.appendStep, [
        a.run,
        a.ordinal,
        a.session,
        "tool_call",
        "ok",
        "search",
        null,
        null,
        null,
        null,
        null,
      ]),
    ).go;

type FinishRow = { recorded: number; outcome: string };
const finishRun =
  (a: {
    run: string;
    requestId: string;
    session: string | null;
    outcome: string;
    code: string | null;
    actions: unknown[];
  }) =>
  (query: Query): Promise<FinishRow[]> =>
    query<FinishRow>(SQL.finishRun, [
      a.run,
      a.requestId,
      a.session,
      a.outcome,
      a.code,
      1,
      HASH,
      JSON.stringify(a.actions),
    ]);

// ---------------------------------------------------------------------------------------------
// A world: two agents and a reasoner, all under `own`, each holding every tool and view; a
// revoked twin of each kind with a session opened before the revocation; one confirmed intent
// that lists both agents for `investigate` and `follow_up`; a harness mode `act` of each agent
// for `investigate` at its one stage, `investigate`.
// ---------------------------------------------------------------------------------------------

type World = {
  db: TestDatabase;
  admin: Query;
  seed: ReturnType<typeof seeder>;
  a: WorkClient;
  b: WorkClient;
  r: WorkClient;
  aRevoked: WorkClient;
  rRevoked: WorkClient;
  intent: string;
  harness: { a: string; b: string };
  message(compartments?: readonly string[], options?: { held?: boolean }): Promise<Message>;
};

async function withWorld<T>(
  fn: (world: World) => Promise<T>,
  clearance: { a?: string[]; b?: string[] } = {},
): Promise<T> {
  return withDatabase((db) =>
    session(db.urls.admin, async (admin) => {
      const seed = seeder(db, admin);
      const agent = { kind: "agent" as const, tools: EVERY_TOOL };
      const reasoner = { kind: "reasoner" as const, tools: EVERY_TOOL };
      const a = await insertWorkClient(db, "agent-a", clearance.a ?? OWN, agent);
      const b = await insertWorkClient(db, "agent-b", clearance.b ?? OWN, agent);
      const aRevoked = await insertWorkClient(db, "agent-revoked", OWN, agent);
      await revokeClient(db, aRevoked);
      // Revoked before the active one is registered: a second active reasoner is refused.
      const rRevoked = await insertWorkClient(db, "reasoner-revoked", OWN, reasoner);
      await revokeClient(db, rRevoked);
      const r = await insertWorkClient(db, "reasoner", OWN, reasoner);

      const intent = testId("int");
      await admin(
        `insert into policy.intents (id, goal_id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at)
         values ($1, null, $2, '{none}', $3, 'owner_decides', 5, now())`,
        [intent, ["investigate", "follow_up"], [a.id, b.id]],
      );
      const grant = async (clientId: string): Promise<string> => {
        const id = testId("hrn");
        await admin(
          "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'investigate', 'investigate', 'act', now())",
          [id, clientId],
        );
        return id;
      };
      const harness = { a: await grant(a.id), b: await grant(b.id) };

      const message = async (
        compartments: readonly string[] = OWN,
        options: { held?: boolean } = {},
      ): Promise<Message> => {
        const label = [...compartments];
        const evidence = await seed.evidence(label, await seed.sourceAccount(label.slice(0, 1)));
        return { id: await seed.message(label, evidence, { held: options.held ?? false }), evidence };
      };
      return fn({ db, admin, seed, a, b, r, aRevoked, rRevoked, intent, harness, message });
    }),
  );
}

const call = <T>(db: TestDatabase, client: { token: string }, fn: (query: Query) => Promise<T>): Promise<T> =>
  readAs(db, client.token, fn);
const asWork = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.work, text, values);

// Arguments for a proposal by a client about a fresh message of its own label, citing it.
async function hypothesisArgs(
  w: World,
  client: WorkClient,
  options: { about?: About; refs?: readonly Ref[]; kind?: string } = {},
): Promise<HypothesisArgs> {
  const id = testId("hyp");
  const refs = options.refs ?? [["message", (await w.message(client.compartments)).id]];
  return {
    id,
    requestId: testId("req"),
    session: client.session,
    kind: options.kind ?? "open_loop",
    about: options.about ?? (refs[0] as About),
    refs,
    body: summary(w.db, "ledger.hypotheses", id, client.compartments),
  };
}

async function opportunityArgs(
  w: World,
  client: WorkClient,
  options: { about?: About; refs?: readonly Ref[]; kind?: string; hypothesis?: string | null } = {},
): Promise<OpportunityArgs> {
  const id = testId("opp");
  const refs = options.refs ?? [["message", (await w.message(client.compartments)).id]];
  return {
    id,
    requestId: testId("req"),
    session: client.session,
    kind: options.kind ?? "investigate",
    about: options.about ?? (refs[0] as About),
    hypothesis: options.hypothesis ?? null,
    dueAt: null,
    refs,
    body: summary(w.db, "ledger.opportunities", id, client.compartments),
  };
}

const testArgs = (client: WorkClient, hypothesis: string, refs: readonly Ref[], result = "supports"): TestArgs => ({
  id: testId("tst"),
  requestId: testId("req"),
  session: client.session,
  hypothesis,
  result,
  refs,
});

async function hypothesisBy(w: World, client: WorkClient, options: { about?: About } = {}): Promise<string> {
  const args = await hypothesisArgs(w, client, options);
  const id = await call(w.db, client, proposeHypothesis(args));
  expect(id, "a prepared hypothesis").toBe(args.id);
  return args.id;
}

async function opportunityBy(w: World, client: WorkClient): Promise<string> {
  const args = await opportunityArgs(w, client);
  const id = await call(w.db, client, proposeOpportunity(args));
  expect(id, "a prepared opportunity").toBe(args.id);
  return args.id;
}

// A status event as pi_work writes one: no body, the row's own label.
const statusEvent = (
  w: World,
  rowKind: string,
  rowId: string,
  event: string,
  compartments: readonly string[],
  by = "owner",
): Promise<unknown> =>
  asWork(
    w.db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, now(), $4, $5)",
    [rowKind, rowId, event, by, [...compartments]],
  );

const labelOfRow = async (w: World, table: string, id: string): Promise<string[]> =>
  one(await w.admin<{ compartments: string[] }>(`select compartments from ${table} where id = $1`, [id])).compartments;

// The owner's go on an opportunity, under the world's intent: the decision row and the status
// event, as the card's effect writes them.
async function decideGo(w: World, opportunity: string): Promise<void> {
  const compartments = await labelOfRow(w, "ledger.opportunities", opportunity);
  await asWork(
    w.db,
    `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
     values ($1, 'owner', $2, $3, 'go', 'owner', 4, 'owner_answer', $4)`,
    [testId("req"), compartments, opportunity, w.intent],
  );
  await statusEvent(w, "opportunity", opportunity, "go", compartments);
}

async function goOpportunity(w: World, client: WorkClient): Promise<string> {
  const opportunity = await opportunityBy(w, client);
  await decideGo(w, opportunity);
  return opportunity;
}

async function claimedOpportunity(w: World, client: WorkClient): Promise<string> {
  const opportunity = await goOpportunity(w, client);
  const until = await call(
    w.db,
    client,
    claim({ opportunity, assignment: testId("asg"), requestId: testId("req"), session: client.session }),
  );
  expect(until, "the claim of a prepared opportunity").toBeInstanceOf(Date);
  return opportunity;
}

async function plannedMove(w: World, client: WorkClient): Promise<{ opportunity: string; move: string }> {
  const opportunity = await claimedOpportunity(w, client);
  const move = testId("mov");
  expect(
    await call(
      w.db,
      client,
      planMove({ move, opportunity, stage: "investigate", requestId: testId("req"), session: client.session }),
    ),
    "a prepared move",
  ).toBe(move);
  return { opportunity, move };
}

// A run as the tick queues one, as pi_work: the row and its `queued` event.
async function queuedRun(w: World): Promise<string> {
  const id = testId("run");
  await asWork(
    w.db,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, 'system:tick', $3, 'owner_request', $4, 'wake_worth_run', '1', 'reasoning_run', '1')`,
    [id, testId("req"), OWN, `owner_request:${id}`],
  );
  await statusEvent(w, "run", id, "queued", OWN, "system:tick");
  return id;
}

// A run taken by the world's reasoner in its own session.
async function takenRun(w: World): Promise<string> {
  const run = await queuedRun(w);
  const rows = await call(w.db, w.r, nextRun({ requestId: testId("req"), session: w.r.session }));
  expect(
    rows.map((row) => row.run_id),
    "the take of a prepared run",
  ).toEqual([run]);
  return run;
}

const endRun = (w: World, run: string): Promise<unknown> =>
  asWork(w.db, "select ledger.end_run($1::text, 'failed'::text, 'bad_output'::text)", [run]);

const latestEvent = async (w: World, rowKind: string, rowId: string): Promise<string> =>
  one(
    await w.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [rowKind, rowId],
    ),
  ).event;

const basisOf = (w: World, rowKind: string, rowId: string) =>
  w.admin<{ ref_kind: string; ref_id: string }>(
    "select ref_kind, ref_id from ledger.basis where row_kind = $1 and row_id = $2 order by id",
    [rowKind, rowId],
  );

// Each table a work function may write, as "<rows> <newest xmin>": a refused call leaves it as it
// was, an insert and an in-place update (a lease) both change it. Read as pi_owner, which the
// spec gives a select policy on each.
const WATCHED = [
  "ledger.cases",
  "ledger.hypotheses",
  "ledger.hypothesis_tests",
  "ledger.opportunities",
  "ledger.opportunity_decisions",
  "ledger.assignments",
  "ledger.moves",
  "ledger.intentions",
  "ledger.decision_point_calls",
  "ledger.runs",
  "ledger.run_attempts",
  "ledger.run_steps",
  "ledger.silences",
  "ledger.record_events",
  "ledger.basis",
  "queue.leases",
];
const snapshot = (db: TestDatabase): Promise<Record<string, string>> =>
  asOwner(db, async (query) => {
    const lines: Record<string, string> = {};
    for (const table of WATCHED) {
      lines[table] = one(
        await query<{ line: string }>(
          `select count(*)::text || ' ' || coalesce(max(xmin::text::bigint), 0)::text as line from ${table}`,
        ),
      ).line;
    }
    return lines;
  });

// A message's rows deleted as the source's deletion removes them: its message row, its status row
// and its evidence row.
async function deleteMessage(w: World, message: Message): Promise<void> {
  await w.admin("delete from knowledge.messages where id = $1", [message.id]);
  await w.admin("delete from vault.pipeline_items where evidence_id = $1", [message.evidence]);
  await w.admin("delete from vault.evidence_items where id = $1", [message.evidence]);
}

// What read_message logs for a message it served: its evidence id under `bound`.
const logRead = (w: World, client: WorkClient, sessionId: string, message: Message): Promise<unknown> =>
  call(w.db, client, (query) =>
    query("select policy.log_read($1, 'read_message', $2::text[], '{}', '{}')", [sessionId, [message.evidence]]),
  );

// ---------------------------------------------------------------------------------------------
// The twelve functions a client calls, and check_back_blocked, which list_opportunities calls,
// each with valid arguments made fresh for it, so its positive control succeeds. `run` takes the
// session so a test can hand another.
// ---------------------------------------------------------------------------------------------

type Prepared = {
  run: (query: Query, sessionId: string | null) => Promise<unknown>;
  ok: (result: unknown) => void;
  done?: () => Promise<unknown>;
};
type Entry = {
  fn: string;
  tool: string;
  kind: "agent" | "reasoner";
  writes: boolean;
  prepare: (w: World) => Promise<Prepared>;
};

const ENTRIES: readonly Entry[] = [
  {
    fn: "work_grants",
    tool: "list_opportunities",
    kind: "agent",
    writes: false,
    prepare: async (w) => ({
      run: (query) => query(SQL.workGrants),
      ok: (rows) =>
        expect(rows).toContainEqual({
          intent_id: w.intent,
          opportunity_kind: "investigate",
          stage: "investigate",
          harness_mode_id: w.harness.a,
        }),
    }),
  },
  {
    fn: "check_back_blocked",
    tool: "list_opportunities",
    kind: "agent",
    writes: false,
    prepare: async (w) => {
      const opportunity = await goOpportunity(w, w.a);
      return {
        run: (query) =>
          query("select opportunity_id, blocked from ledger.check_back_blocked($1::text[])", [[opportunity]]),
        ok: (rows) => expect(rows).toEqual([{ opportunity_id: opportunity, blocked: false }]),
      };
    },
  },
  {
    fn: "propose_hypothesis",
    tool: "propose_hypothesis",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const args = await hypothesisArgs(w, w.a);
      return {
        run: (query, sessionId) => proposeHypothesis({ ...args, session: sessionId })(query),
        ok: (id) => expect(id).toBe(args.id),
      };
    },
  },
  {
    fn: "record_test",
    tool: "record_test",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const hypothesis = await hypothesisBy(w, w.b);
      const args = testArgs(w.a, hypothesis, [["message", (await w.message()).id]]);
      return {
        run: (query, sessionId) => recordTest({ ...args, session: sessionId })(query),
        ok: (rows) => expect(rows).toEqual([{ test_id: args.id, counts: true }]),
      };
    },
  },
  {
    fn: "propose_opportunity",
    tool: "propose_opportunity",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const args = await opportunityArgs(w, w.a);
      return {
        run: (query, sessionId) => proposeOpportunity({ ...args, session: sessionId })(query),
        ok: (id) => expect(id).toBe(args.id),
      };
    },
  },
  {
    fn: "set_intention",
    tool: "set_intention",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const opportunity = await claimedOpportunity(w, w.a);
      const args = { id: testId("itn"), requestId: testId("req"), opportunity, dueAt: hoursAhead(2) };
      return {
        run: (query, sessionId) => setIntention({ ...args, session: sessionId })(query),
        ok: (id) => expect(id).toBe(args.id),
      };
    },
  },
  {
    fn: "claim",
    tool: "claim_opportunity",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const opportunity = await goOpportunity(w, w.a);
      const args = { opportunity, assignment: testId("asg"), requestId: testId("req") };
      return {
        run: (query, sessionId) => claim({ ...args, session: sessionId })(query),
        ok: (until) => expect(until).toBeInstanceOf(Date),
      };
    },
  },
  {
    fn: "release",
    tool: "release_opportunity",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const opportunity = await claimedOpportunity(w, w.a);
      const args = { opportunity, requestId: testId("req") };
      return {
        run: (query, sessionId) => release({ ...args, session: sessionId })(query),
        ok: (released) => expect(released).toBe(true),
      };
    },
  },
  {
    fn: "plan_move",
    tool: "plan_move",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const opportunity = await claimedOpportunity(w, w.a);
      const args = { move: testId("mov"), opportunity, stage: "investigate", requestId: testId("req") };
      return {
        run: (query, sessionId) => planMove({ ...args, session: sessionId })(query),
        ok: (id) => expect(id).toBe(args.move),
      };
    },
  },
  {
    fn: "report_move",
    tool: "report_move",
    kind: "agent",
    writes: true,
    prepare: async (w) => {
      const { move } = await plannedMove(w, w.a);
      // `investigate` has one stage, so a done report closes the opportunity done.
      const args = { move, outcome: "done", requestId: testId("req") };
      return {
        run: (query, sessionId) => reportMove({ ...args, session: sessionId })(query),
        ok: (status) => expect(status).toBe("done"),
      };
    },
  },
  {
    fn: "next_run",
    tool: "next_run",
    kind: "reasoner",
    writes: true,
    prepare: async (w) => {
      const run = await queuedRun(w);
      const requestId = testId("req");
      return {
        run: (query, sessionId) => nextRun({ requestId, session: sessionId })(query),
        ok: (rows) => expect(rows).toEqual([{ run_id: run, attempt: 1, compartments: OWN }]),
        done: () => endRun(w, run),
      };
    },
  },
  {
    fn: "append_step",
    tool: "append_step",
    kind: "reasoner",
    writes: true,
    prepare: async (w) => {
      const run = await takenRun(w);
      return {
        run: (query, sessionId) => appendStep({ run, ordinal: 1, session: sessionId })(query),
        ok: (go) => expect(go).toBe(true),
        done: () => endRun(w, run),
      };
    },
  },
  {
    fn: "finish_run",
    tool: "finish_run",
    kind: "reasoner",
    writes: true,
    prepare: async (w) => {
      const run = await takenRun(w);
      // A failed run with no output: it writes no row with a body.
      const args = { run, requestId: testId("req"), outcome: "failed", code: "bad_output", actions: [] };
      return {
        run: (query, sessionId) => finishRun({ ...args, session: sessionId })(query),
        ok: (rows) => expect(rows).toEqual([{ recorded: 0, outcome: "failed" }]),
      };
    },
  },
];

const clientFor = (w: World, entry: Entry): WorkClient => (entry.kind === "agent" ? w.a : w.r);

// Whether a call is refused with 42501.
const refusedAs = (
  db: TestDatabase,
  token: string | null,
  prepared: Prepared,
  sessionId: string | null,
): Promise<string | null> => sqlState(() => readAs(db, token, (query) => prepared.run(query, sessionId)));

describe("who may call a work function", { timeout: DB_TEST_TIMEOUT }, () => {
  it("current_client_kind answers the kind of the current client, and null with no token, an unknown one or a revoked one", () =>
    withWorld(async (w) => {
      const kind = async (token: string | null): Promise<string | null> =>
        one(await readAs(w.db, token, (query) => query<{ kind: string | null }>(SQL.clientKind))).kind;
      expect(await kind(w.a.token)).toBe("agent");
      expect(await kind(w.r.token)).toBe("reasoner");
      expect(await kind(null)).toBeNull();
      expect(await kind(UNKNOWN_TOKEN)).toBeNull();
      expect(await kind(w.aRevoked.token)).toBeNull();
      expect(await kind(w.rRevoked.token)).toBeNull();
    }));

  it("a function with no token, an unknown token or a revoked token is refused (42501), and the same call under the registered client's token succeeds", () =>
    withWorld(async (w) => {
      for (const entry of ENTRIES) {
        const client = clientFor(w, entry);
        const revoked = entry.kind === "agent" ? w.aRevoked : w.rRevoked;
        const prepared = await entry.prepare(w);
        const before = await snapshot(w.db);
        expect(await refusedAs(w.db, null, prepared, client.session), `${entry.fn} with no token`).toBe("42501");
        expect(
          await refusedAs(w.db, UNKNOWN_TOKEN, prepared, client.session),
          `${entry.fn} with an unknown token`,
        ).toBe("42501");
        expect(
          await refusedAs(w.db, revoked.token, prepared, revoked.session),
          `${entry.fn} with a revoked token`,
        ).toBe("42501");
        expect(await snapshot(w.db), `${entry.fn} refused wrote nothing`).toEqual(before);
        prepared.ok(await readAs(w.db, client.token, (query) => prepared.run(query, client.session)));
        await prepared.done?.();
      }
    }));

  it("a client whose registration lacks the function's tool, or the work view, is refused (42501), and succeeds once it holds both", () =>
    withWorld(async (w) => {
      const register = (client: WorkClient, tools: string[], views: string[]): Promise<unknown> =>
        w.admin("update policy.clients set tools = $2, views = $3 where id = $1", [client.id, tools, views]);
      for (const entry of ENTRIES) {
        const client = clientFor(w, entry);
        const prepared = await entry.prepare(w);
        const before = await snapshot(w.db);
        await register(
          client,
          EVERY_TOOL.filter((tool) => tool !== entry.tool),
          ALL_VIEWS,
        );
        expect(await refusedAs(w.db, client.token, prepared, client.session), `${entry.fn} without ${entry.tool}`).toBe(
          "42501",
        );
        await register(
          client,
          EVERY_TOOL,
          ALL_VIEWS.filter((view) => view !== "work"),
        );
        expect(await refusedAs(w.db, client.token, prepared, client.session), `${entry.fn} without the work view`).toBe(
          "42501",
        );
        await register(client, EVERY_TOOL, ALL_VIEWS);
        expect(await snapshot(w.db), `${entry.fn} refused wrote nothing`).toEqual(before);
        prepared.ok(await readAs(w.db, client.token, (query) => prepared.run(query, client.session)));
        await prepared.done?.();
      }
    }));

  it("a function for the reasoner is refused for an agent, and one for an agent is refused for the reasoner (42501), though each holds the tool and the view", () =>
    withWorld(async (w) => {
      for (const entry of ENTRIES) {
        const client = clientFor(w, entry);
        const wrong = entry.kind === "agent" ? w.r : w.a;
        const prepared = await entry.prepare(w);
        const before = await snapshot(w.db);
        expect(await refusedAs(w.db, wrong.token, prepared, wrong.session), `${entry.fn} for the ${wrong.kind}`).toBe(
          "42501",
        );
        expect(await snapshot(w.db), `${entry.fn} refused wrote nothing`).toEqual(before);
        prepared.ok(await readAs(w.db, client.token, (query) => prepared.run(query, client.session)));
        await prepared.done?.();
      }
    }));

  it("a session id that is null, is no session, or is another client's is refused (42501) by each writing function, and the caller's own session is taken", () =>
    withWorld(async (w) => {
      for (const entry of ENTRIES.filter((entry) => entry.writes)) {
        const client = clientFor(w, entry);
        const another = entry.kind === "agent" ? w.b : w.a;
        const prepared = await entry.prepare(w);
        const before = await snapshot(w.db);
        expect(await refusedAs(w.db, client.token, prepared, null), `${entry.fn} with no session`).toBe("42501");
        expect(await refusedAs(w.db, client.token, prepared, testId("ses")), `${entry.fn} with no such session`).toBe(
          "42501",
        );
        expect(
          await refusedAs(w.db, client.token, prepared, another.session),
          `${entry.fn} with another client's session`,
        ).toBe("42501");
        expect(await snapshot(w.db), `${entry.fn} refused wrote nothing`).toEqual(before);
        prepared.ok(await readAs(w.db, client.token, (query) => prepared.run(query, client.session)));
        await prepared.done?.();
      }
    }));
});

describe("a row's author, label, class and session are the token's", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a proposal's author, label, class and session are the token's, read back from the rows", () =>
    withWorld(
      async (w) => {
        // Registered unsorted: the label is the clearance through ledger.label.
        expect(w.a.compartments).toEqual(["own", "employer:example"]);
        const label = ["employer:example", "own"];
        const author = `client:${w.a.id}`;
        // A second session of the same client: the row carries the one handed, which is its own.
        const second = await openWorkSession(w.db, w.a.token);
        const cited = await w.message(OWN);

        const hypothesis = { ...(await hypothesisArgs(w, w.a, { refs: [["message", cited.id]] })), session: second };
        expect(await call(w.db, w.a, proposeHypothesis(hypothesis))).toBe(hypothesis.id);
        const opportunity = {
          ...(await opportunityArgs(w, w.a, { refs: [["message", cited.id]], kind: "follow_up" })),
          session: second,
        };
        expect(await call(w.db, w.a, proposeOpportunity(opportunity))).toBe(opportunity.id);
        const test = { ...testArgs(w.a, hypothesis.id, [["message", cited.id]]), session: second };
        expect(await call(w.db, w.a, recordTest(test))).toEqual([{ test_id: test.id, counts: false }]);

        const hypothesisRow = one(
          await w.admin<{ case_id: string }>(
            "select created_by, compartments, session_id, run_id, about_kind, about_id, about_owner, case_id from ledger.hypotheses where id = $1",
            [hypothesis.id],
          ),
        );
        expect(hypothesisRow).toEqual({
          created_by: author,
          compartments: label,
          session_id: second,
          run_id: null,
          about_kind: "message",
          about_id: cited.id,
          about_owner: false,
          case_id: expect.any(String),
        });
        const opportunityRow = one(
          await w.admin<{ case_id: string }>(
            "select created_by, compartments, session_id, run_id, proposed_by_class, case_id from ledger.opportunities where id = $1",
            [opportunity.id],
          ),
        );
        expect(opportunityRow).toEqual({
          created_by: author,
          compartments: label,
          session_id: second,
          run_id: null,
          proposed_by_class: "client",
          case_id: expect.any(String),
        });
        expect(
          await w.admin(
            "select created_by, compartments, session_id, run_id, counts from ledger.hypothesis_tests where id = $1",
            [test.id],
          ),
        ).toEqual([{ created_by: author, compartments: label, session_id: second, run_id: null, counts: false }]);

        // The cases: the author and the label of the token.
        const caseOf = (id: string) =>
          w.admin(
            "select row_kind, kind, about_kind, about_id, author, compartments, created_by, session_id from ledger.cases where id = $1",
            [id],
          );
        expect(await caseOf(hypothesisRow.case_id)).toEqual([
          {
            row_kind: "hypothesis",
            kind: "open_loop",
            about_kind: "message",
            about_id: cited.id,
            author,
            compartments: label,
            created_by: author,
            session_id: second,
          },
        ]);
        expect(await caseOf(opportunityRow.case_id)).toEqual([
          {
            row_kind: "opportunity",
            kind: "follow_up",
            about_kind: "message",
            about_id: cited.id,
            author,
            compartments: label,
            created_by: author,
            session_id: second,
          },
        ]);

        // The first status events: by the client, under the row's label, with no body, in the session.
        const firstEvent = (rowKind: string, rowId: string) =>
          w.admin(
            "select event, by, compartments, body_enc is null as bodiless, session_id from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
            [rowKind, rowId],
          );
        expect(await firstEvent("hypothesis", hypothesis.id)).toEqual([
          { event: "open", by: author, compartments: label, bodiless: true, session_id: second },
        ]);
        expect(await firstEvent("opportunity", opportunity.id)).toEqual([
          { event: "proposed", by: author, compartments: label, bodiless: true, session_id: second },
        ]);

        // The basis rows carry the row's label, whatever the ref's own.
        for (const [rowKind, rowId] of [
          ["hypothesis", hypothesis.id],
          ["opportunity", opportunity.id],
          ["test", test.id],
        ] as const) {
          expect(
            await w.admin(
              "select ref_kind, ref_id, compartments from ledger.basis where row_kind = $1 and row_id = $2",
              [rowKind, rowId],
            ),
            rowKind,
          ).toEqual([{ ref_kind: "message", ref_id: cited.id, compartments: label }]);
        }

        // The control: the other session of the same client is written when it is the one handed.
        const inFirst = await hypothesisArgs(w, w.a);
        expect(await call(w.db, w.a, proposeHypothesis(inFirst))).toBe(inFirst.id);
        expect(
          one(
            await w.admin<{ session_id: string }>("select session_id from ledger.hypotheses where id = $1", [
              inFirst.id,
            ]),
          ).session_id,
        ).toBe(w.a.session);
      },
      { a: ["own", "employer:example"] },
    ));
});

describe("every ref names a row visible under the author's clearance", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  // One proposal of each kind and one test, all citing `refs`.
  async function attempts(w: World, hypothesis: string, refs: readonly Ref[]) {
    const about: About = ["message", (await w.message(OWN)).id];
    return {
      hypothesis: await hypothesisArgs(w, w.a, { about, refs }),
      opportunity: await opportunityArgs(w, w.a, { about, refs }),
      test: testArgs(w.a, hypothesis, refs),
    };
  }

  it("a ref the client cannot see refuses the row, as a ref that does not exist does", () =>
    withWorld(
      async (w) => {
        const seen = await w.message(OWN);
        const hidden = await w.message(WORK);
        // B is cleared for employer:example alone: A cannot see its hypothesis.
        const hiddenHypothesis = await hypothesisBy(w, w.b);
        const own = await hypothesisBy(w, w.a);
        const cases: [string, Ref[]][] = [
          ["a hidden message", [["message", hidden.id]]],
          ["a missing message", [["message", testId("msg")]]],
          ["a hidden hypothesis", [["hypothesis", hiddenHypothesis]]],
          ["a missing hypothesis", [["hypothesis", testId("hyp")]]],
          [
            "a seen message beside a hidden one",
            [
              ["message", seen.id],
              ["message", hidden.id],
            ],
          ],
          [
            "a seen message beside a missing one",
            [
              ["message", seen.id],
              ["message", testId("msg")],
            ],
          ],
        ];
        const before = await snapshot(w.db);
        for (const [name, refs] of cases) {
          const tries = await attempts(w, own, refs);
          // The same answer for each, hidden or missing, and no error.
          expect(await call(w.db, w.a, proposeHypothesis(tries.hypothesis)), `propose_hypothesis, ${name}`).toBeNull();
          expect(
            await call(w.db, w.a, proposeOpportunity(tries.opportunity)),
            `propose_opportunity, ${name}`,
          ).toBeNull();
          expect(await call(w.db, w.a, recordTest(tries.test)), `record_test, ${name}`).toEqual([]);
        }
        expect(await snapshot(w.db)).toEqual(before);

        // The positive control: what A can see, a message and its own hypothesis, resolves.
        const tries = await attempts(w, own, [
          ["message", seen.id],
          ["hypothesis", own],
        ]);
        expect(await call(w.db, w.a, proposeHypothesis(tries.hypothesis))).toBe(tries.hypothesis.id);
        expect(await call(w.db, w.a, proposeOpportunity(tries.opportunity))).toBe(tries.opportunity.id);
        expect(await call(w.db, w.a, recordTest(tries.test))).toEqual([{ test_id: tries.test.id, counts: false }]);
        expect(await basisOf(w, "opportunity", tries.opportunity.id)).toEqual([
          { ref_kind: "message", ref_id: seen.id },
          { ref_kind: "hypothesis", ref_id: own },
        ]);
      },
      { b: WORK },
    ));

  it("a held message as a ref refuses the row the same way", () =>
    withWorld(async (w) => {
      const held = await w.message(OWN, { held: true });
      const own = await hypothesisBy(w, w.a);
      const before = await snapshot(w.db);
      for (const refs of [[["message", held.id]], [["message", testId("msg")]]] as Ref[][]) {
        const tries = await attempts(w, own, refs);
        expect(await call(w.db, w.a, proposeHypothesis(tries.hypothesis)), refs[0]?.[1]).toBeNull();
        expect(await call(w.db, w.a, proposeOpportunity(tries.opportunity)), refs[0]?.[1]).toBeNull();
        expect(await call(w.db, w.a, recordTest(tries.test)), refs[0]?.[1]).toEqual([]);
      }
      expect(await snapshot(w.db)).toEqual(before);
      // The control: the same message once its hold is lifted.
      await w.admin("update knowledge.messages set held = false where id = $1", [held.id]);
      const tries = await attempts(w, own, [["message", held.id]]);
      expect(await call(w.db, w.a, proposeHypothesis(tries.hypothesis))).toBe(tries.hypothesis.id);
      expect(await call(w.db, w.a, proposeOpportunity(tries.opportunity))).toBe(tries.opportunity.id);
      expect(await call(w.db, w.a, recordTest(tries.test))).toEqual([{ test_id: tries.test.id, counts: false }]);
    }));
});

describe("a hypothesis about the owner", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an opportunity that rests on a hypothesis about the owner is refused (22023) and writes nothing", () =>
    withWorld(async (w) => {
      const aboutOwner = await hypothesisBy(w, w.a, { about: ["owner", null] });
      const aboutMessage = await hypothesisBy(w, w.a);
      const refused = await opportunityArgs(w, w.a, { hypothesis: aboutOwner });
      const before = await snapshot(w.db);
      expect(await sqlState(() => call(w.db, w.a, proposeOpportunity(refused)))).toBe("22023");
      expect(await snapshot(w.db)).toEqual(before);
      // The control: one that rests on a hypothesis about a message.
      const taken = await opportunityArgs(w, w.a, { hypothesis: aboutMessage });
      expect(await call(w.db, w.a, proposeOpportunity(taken))).toBe(taken.id);
      expect(await w.admin("select hypothesis_id from ledger.opportunities where id = $1", [taken.id])).toEqual([
        { hypothesis_id: aboutMessage },
      ]);
    }));

  it("a hypothesis about the owner has about_owner true whatever the caller did, and one about a message false", () =>
    withWorld(async (w) => {
      const aboutOwner = await hypothesisBy(w, w.a, { about: ["owner", null] });
      const aboutMessage = await hypothesisBy(w, w.a);
      const row = (id: string) =>
        w.admin("select about_kind, about_id, about_owner from ledger.hypotheses where id = $1", [id]);
      expect(await row(aboutOwner)).toEqual([{ about_kind: "owner", about_id: null, about_owner: true }]);
      expect(await row(aboutMessage)).toEqual([
        { about_kind: "message", about_id: expect.any(String), about_owner: false },
      ]);
    }));

  it("propose_opportunity on a hypothesis the caller cannot see answers as for one that does not exist, also when that hypothesis is about the owner", () =>
    withWorld(
      async (w) => {
        const hiddenAboutMessage = await hypothesisBy(w, w.b);
        const hiddenAboutOwner = await hypothesisBy(w, w.b, { about: ["owner", null] });
        const before = await snapshot(w.db);
        for (const [name, hypothesis] of [
          ["hidden, about a message", hiddenAboutMessage],
          ["hidden, about the owner", hiddenAboutOwner],
          ["missing", testId("hyp")],
        ] as const) {
          const args = await opportunityArgs(w, w.a, { hypothesis });
          // Not 22023: a hidden hypothesis tells nothing of what it is about.
          expect(await sqlState(() => call(w.db, w.a, proposeOpportunity(args))), name).toBeNull();
          expect(await call(w.db, w.a, proposeOpportunity(args)), name).toBeNull();
        }
        expect(await snapshot(w.db)).toEqual(before);
        // The controls: A's own hypothesis about the owner is refused as invalid, and its own
        // about a message is taken.
        const ownAboutOwner = await hypothesisBy(w, w.a, { about: ["owner", null] });
        expect(
          await sqlState(() =>
            opportunityArgs(w, w.a, { hypothesis: ownAboutOwner }).then((args) =>
              call(w.db, w.a, proposeOpportunity(args)),
            ),
          ),
        ).toBe("22023");
        const ownAboutMessage = await hypothesisBy(w, w.a);
        const taken = await opportunityArgs(w, w.a, { hypothesis: ownAboutMessage });
        expect(await call(w.db, w.a, proposeOpportunity(taken))).toBe(taken.id);
      },
      { b: WORK },
    ));
});

describe("a case is one kind of row, about one thing, by one author, under one label", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  const bodyOf = async (w: World, table: string, id: string): Promise<string> =>
    one(await w.admin<{ body: string }>(`select body_enc::text as body from ${table} where id = $1`, [id])).body;
  const countAbout = async (w: World, table: string, about: string): Promise<number> =>
    one(await w.admin<{ n: number }>(`select count(*)::int as n from ${table} where about_id = $1`, [about])).n;

  it("a second proposal by the same client for one case adds its basis and returns the first id", () =>
    withWorld(async (w) => {
      const about = await w.message();
      const more = await w.message();
      // An opportunity.
      const first = await opportunityArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "follow_up",
      });
      expect(await call(w.db, w.a, proposeOpportunity(first))).toBe(first.id);
      const body = await bodyOf(w, "ledger.opportunities", first.id);
      const second = await opportunityArgs(w, w.a, {
        about: ["message", about.id],
        refs: [
          ["message", about.id],
          ["message", more.id],
        ],
        kind: "follow_up",
      });
      expect(await call(w.db, w.a, proposeOpportunity(second))).toBe(first.id);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(1);
      expect(await basisOf(w, "opportunity", first.id)).toEqual([
        { ref_kind: "message", ref_id: about.id },
        { ref_kind: "message", ref_id: more.id },
      ]);
      // Its own summary is dropped.
      expect(await bodyOf(w, "ledger.opportunities", first.id)).toBe(body);

      // A hypothesis the same way.
      const firstHypothesis = await hypothesisArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", about.id]],
      });
      expect(await call(w.db, w.a, proposeHypothesis(firstHypothesis))).toBe(firstHypothesis.id);
      const secondHypothesis = await hypothesisArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", more.id]],
      });
      expect(await call(w.db, w.a, proposeHypothesis(secondHypothesis))).toBe(firstHypothesis.id);
      expect(await countAbout(w, "ledger.hypotheses", about.id)).toBe(1);
      expect(await basisOf(w, "hypothesis", firstHypothesis.id)).toEqual([
        { ref_kind: "message", ref_id: about.id },
        { ref_kind: "message", ref_id: more.id },
      ]);

      // The control: another kind about the same thing is another case.
      const otherKind = await opportunityArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "investigate",
      });
      expect(await call(w.db, w.a, proposeOpportunity(otherKind))).toBe(otherKind.id);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(2);
    }));

  it("a client's proposal on a run's case is a second row", () =>
    withWorld(async (w) => {
      const about = await w.message();
      const run = await takenRun(w);
      const runOpportunity = testId("opp");
      const action = {
        do: "propose",
        id: runOpportunity,
        kind: "follow_up",
        about_kind: "message",
        about_id: about.id,
        due_at: null,
        body_enc: JSON.parse(summary(w.db, "ledger.opportunities", runOpportunity, OWN)) as unknown,
        ref_kinds: ["message"],
        ref_ids: [about.id],
        probability: null,
        probability_if_waiting: null,
      };
      expect(
        await call(
          w.db,
          w.r,
          finishRun({
            run,
            requestId: testId("req"),
            session: w.r.session,
            outcome: "finished",
            code: null,
            actions: [action],
          }),
        ),
      ).toEqual([{ recorded: 1, outcome: "finished" }]);
      expect(
        await w.admin("select created_by, run_id from ledger.opportunities where id = $1", [runOpportunity]),
      ).toEqual([{ created_by: `run:${run}`, run_id: run }]);

      // The same kind, about the same thing, under the same label, by a client.
      const mine = await opportunityArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "follow_up",
      });
      const answer = await call(w.db, w.a, proposeOpportunity(mine));
      expect(answer).toBe(mine.id);
      expect(answer).not.toBe(runOpportunity);
      // Ordered by author: "client:" before "run:".
      expect(
        await w.admin("select id, created_by from ledger.opportunities where about_id = $1 order by created_by", [
          about.id,
        ]),
      ).toEqual([
        { id: mine.id, created_by: `client:${w.a.id}` },
        { id: runOpportunity, created_by: `run:${run}` },
      ]);
      // The run's row keeps its basis alone.
      expect(await basisOf(w, "opportunity", runOpportunity)).toEqual([{ ref_kind: "message", ref_id: about.id }]);
    }));

  it("two clients with equal clearance on one case make two rows, and neither call returns the other's id", () =>
    withWorld(async (w) => {
      const about = await w.message();
      const byA = await opportunityArgs(w, w.a, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "follow_up",
      });
      const byB = await opportunityArgs(w, w.b, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "follow_up",
      });
      expect(await call(w.db, w.a, proposeOpportunity(byA))).toBe(byA.id);
      expect(await call(w.db, w.b, proposeOpportunity(byB))).toBe(byB.id);
      expect(byA.id).not.toBe(byB.id);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(2);
      // And each client's repeat of the case still joins its own row.
      const againByB = await opportunityArgs(w, w.b, {
        about: ["message", about.id],
        refs: [["message", about.id]],
        kind: "follow_up",
      });
      expect(await call(w.db, w.b, proposeOpportunity(againByB))).toBe(byB.id);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(2);
    }));

  it("a proposal for a case whose open row the caller cannot see makes a second row", () =>
    withWorld(
      async (w) => {
        const about = await w.message(OWN);
        const wide = await opportunityArgs(w, w.a, {
          about: ["message", about.id],
          refs: [["message", about.id]],
          kind: "follow_up",
        });
        expect(await call(w.db, w.a, proposeOpportunity(wide))).toBe(wide.id);
        expect(await labelOfRow(w, "ledger.opportunities", wide.id)).toEqual(["employer:example", "own"]);
        // A's clearance narrowed: its open row under both compartments is out of its sight.
        await w.admin("update policy.clients set compartments = $2 where id = $1", [w.a.id, OWN]);
        const narrow = await opportunityArgs(
          w,
          { ...w.a, compartments: OWN },
          { about: ["message", about.id], refs: [["message", about.id]], kind: "follow_up" },
        );
        const answer = await call(w.db, w.a, proposeOpportunity(narrow));
        expect(answer).toBe(narrow.id);
        expect(answer).not.toBe(wide.id);
        expect(await labelOfRow(w, "ledger.opportunities", narrow.id)).toEqual(OWN);
        expect(await basisOf(w, "opportunity", wide.id)).toEqual([{ ref_kind: "message", ref_id: about.id }]);
        expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(2);
      },
      { a: BOTH },
    ));

  it("a proposal for a case whose row is handed_to_owner adds its basis to that row, and for one that is done makes a new row", () =>
    withWorld(async (w) => {
      const about = await w.message();
      const proposal = async (refs: Ref[]) =>
        opportunityArgs(w, w.a, { about: ["message", about.id], refs, kind: "follow_up" });
      const first = await proposal([["message", about.id]]);
      expect(await call(w.db, w.a, proposeOpportunity(first))).toBe(first.id);

      await statusEvent(w, "opportunity", first.id, "handed_to_owner", OWN, "system:test");
      const more = await w.message();
      expect(await call(w.db, w.a, proposeOpportunity(await proposal([["message", more.id]])))).toBe(first.id);
      expect(await basisOf(w, "opportunity", first.id)).toEqual([
        { ref_kind: "message", ref_id: about.id },
        { ref_kind: "message", ref_id: more.id },
      ]);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(1);

      await statusEvent(w, "opportunity", first.id, "done", OWN, "owner");
      const after = await proposal([["message", about.id]]);
      expect(await call(w.db, w.a, proposeOpportunity(after))).toBe(after.id);
      expect(after.id).not.toBe(first.id);
      expect(await countAbout(w, "ledger.opportunities", about.id)).toBe(2);
      expect(await latestEvent(w, "opportunity", after.id)).toBe("proposed");
      expect(await latestEvent(w, "opportunity", first.id)).toBe("done");
    }));
});

describe("a client cannot support its own hypothesis", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a test by the proposer is stored with counts false, and by another client that can see the hypothesis with counts true", () =>
    withWorld(async (w) => {
      const hypothesis = await hypothesisBy(w, w.a);
      const cited: Ref[] = [["message", (await w.message()).id]];
      const byProposer = testArgs(w.a, hypothesis, cited);
      expect(await call(w.db, w.a, recordTest(byProposer))).toEqual([{ test_id: byProposer.id, counts: false }]);
      // A test that does not count supports nothing.
      expect(await latestEvent(w, "hypothesis", hypothesis)).toBe("open");

      // A client that cannot see the hypothesis is answered as for one that does not exist.
      const blind = await insertWorkClient(w.db, "agent-blind", WORK, { kind: "agent", tools: EVERY_TOOL });
      const byBlind = testArgs(blind, hypothesis, [["message", (await w.message(WORK)).id]]);
      expect(await call(w.db, blind, recordTest(byBlind))).toEqual([]);

      const byOther = testArgs(w.b, hypothesis, cited);
      expect(await call(w.db, w.b, recordTest(byOther))).toEqual([{ test_id: byOther.id, counts: true }]);
      expect(
        await w.admin(
          "select id, created_by, counts from ledger.hypothesis_tests where hypothesis_id = $1 order by counts",
          [hypothesis],
        ),
      ).toEqual([
        { id: byProposer.id, created_by: `client:${w.a.id}`, counts: false },
        { id: byOther.id, created_by: `client:${w.b.id}`, counts: true },
      ]);
      expect(await latestEvent(w, "hypothesis", hypothesis)).toBe("supported");
    }));
});

// ---------------------------------------------------------------------------------------------
// ledger.basis_flagged, called as pi_work
// ---------------------------------------------------------------------------------------------

describe("ledger.basis_flagged", { timeout: DB_TEST_TIMEOUT }, () => {
  const flagged = async (w: World, refs: readonly Ref[]): Promise<boolean> =>
    one(
      await asWork<{ flagged: boolean }>(w.db, "select ledger.basis_flagged($1::text[], $2::text[]) as flagged", [
        kindsOf(refs),
        idsOf(refs),
      ]),
    ).flagged;

  // A message with the extraction's status row, set as extraction leaves it: done is waiting
  // false, withheld false, screened true.
  async function judged(
    w: World,
    status: { waiting?: boolean; withheld?: boolean; screened?: boolean; facts?: string; held?: boolean } = {},
  ): Promise<Message> {
    const message = await w.message(OWN, { held: status.held ?? false });
    await w.seed.pipelineItem(OWN, message.evidence);
    await w.admin("update vault.pipeline_items set waiting = $2, withheld = $3, screened = $4 where evidence_id = $1", [
      message.evidence,
      status.waiting ?? false,
      status.withheld ?? false,
      status.screened ?? true,
    ]);
    if (status.facts !== undefined) {
      const facts = {
        lane: "correspondence",
        override: false,
        status: status.facts,
        attempts: 1,
        claims: 0,
        unmapped: 0,
        unresolved: 0,
      };
      await w.admin("update vault.pipeline_items set facts_enc = $2 where evidence_id = $1", [
        message.evidence,
        JSON.stringify(
          sealRow(
            w.db.keys,
            "own",
            { table: "vault.pipeline_items", id: message.evidence, column: "facts_enc" },
            JSON.stringify(facts),
          ),
        ),
      ]);
    }
    return message;
  }

  it("a message whose item is done and not withheld, and that is not held, is not flagged", () =>
    withWorld(async (w) => {
      const clean = await judged(w);
      expect(await flagged(w, [["message", clean.id]])).toBe(false);
      // The control: beside a withheld one, the basis is flagged.
      const withheld = await judged(w, { withheld: true });
      expect(
        await flagged(w, [
          ["message", clean.id],
          ["message", withheld.id],
        ]),
      ).toBe(true);
    }));

  it("a withheld message is flagged", () =>
    withWorld(async (w) => {
      expect(await flagged(w, [["message", (await judged(w, { withheld: true })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w)).id]])).toBe(false);
    }));

  it("a held message is flagged", () =>
    withWorld(async (w) => {
      expect(await flagged(w, [["message", (await judged(w, { held: true })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w, { held: false })).id]])).toBe(false);
    }));

  it("a message with no status row is flagged", () =>
    withWorld(async (w) => {
      expect(await flagged(w, [["message", (await w.message()).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w)).id]])).toBe(false);
    }));

  it("a message still waiting is flagged", () =>
    withWorld(async (w) => {
      // Waiting, whatever its other marks: withheld_items answers nothing for it.
      expect(await flagged(w, [["message", (await judged(w, { waiting: true, screened: true })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w, { waiting: true, screened: false })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w)).id]])).toBe(false);
    }));

  it("a skipped message and a failed one are flagged", () =>
    withWorld(async (w) => {
      expect(await flagged(w, [["message", (await judged(w, { screened: false, facts: "skipped" })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w, { screened: false, facts: "failed" })).id]])).toBe(true);
      expect(await flagged(w, [["message", (await judged(w, { facts: "done" })).id]])).toBe(false);
    }));

  it("an event, an entity, a goal, a hypothesis and an opportunity are never flagged", () =>
    withWorld(async (w) => {
      const event = testId("evt");
      await w.admin(
        "insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers) values ($1, 'meeting', now(), $2, $3, '{m-owner}')",
        [event, (await w.message()).evidence, OWN],
      );
      const entity = await w.seed.entity("person");
      await w.seed.account(OWN, entity);
      const refs: Ref[] = [
        ["event", event],
        ["entity", entity],
        ["goal", await goal(w, OWN)],
        ["hypothesis", await hypothesisBy(w, w.a)],
        ["opportunity", await opportunityBy(w, w.a)],
      ];
      for (const ref of refs) expect(await flagged(w, [ref]), ref[0]).toBe(false);
      expect(await flagged(w, refs)).toBe(false);
      // The control: beside a message with no status row, the same refs are flagged.
      expect(await flagged(w, [...refs, ["message", (await w.message()).id]])).toBe(true);
    }));

  it("an agent_record ref is flagged when its record has flagged_at set, and not otherwise", () =>
    withWorld(async (w) => {
      const record = async (flaggedAt: string | null): Promise<string> => {
        const id = testId("rec");
        await session(w.db.urls.bootstrap, async (owner) => {
          await owner("begin");
          await owner("set local role pi_owner");
          await owner(
            `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, flagged_at)
             values ($1, $2, $3, $4, $5, 'record', 'note', $6, $7, $8, $9, '{}', $10)`,
            [
              id,
              w.a.id,
              w.a.name,
              w.a.session,
              `request-${id.slice(-12)}`,
              ["agent:agent-a", "own"],
              ALL_VIEWS,
              sha256Hex(id),
              sha256Hex(""),
              flaggedAt,
            ],
          );
          await owner("commit");
        });
        return id;
      };
      expect(await flagged(w, [["agent_record", await record(new Date().toISOString())]])).toBe(true);
      expect(await flagged(w, [["agent_record", await record(null)]])).toBe(false);
    }));
});

// A goal, as `pi goal add` writes it as pi_admin: the owner's goal_set decision and the projection.
async function goal(w: World, compartments: readonly string[]): Promise<string> {
  const ruling = testId("rul");
  const label = [...compartments];
  await w.admin(
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'goal_set', 0, '{}', '{}', now(), $3)",
    [ruling, testId("req"), label],
  );
  const id = testId("gol");
  await w.admin(
    "insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, compartments, statement_enc) values ($1, 'active', $2, now(), now(), $3, $4)",
    [
      id,
      ruling,
      label,
      JSON.stringify(
        sealUnder(
          w.db.keys,
          labelOf(label),
          { table: "projections.goal_state", id, column: "statement_enc" },
          "a goal statement",
        ),
      ),
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------------------------
// ledger.add_basis, as this migration replaces it: the three new ref kinds
// ---------------------------------------------------------------------------------------------

describe("ledger.add_basis resolves a goal, a hypothesis and an opportunity", { timeout: DB_TEST_TIMEOUT }, () => {
  it("add_basis resolves a goal, a hypothesis and an opportunity, with their classes, and answers false for one outside the clearance as for one that does not exist", () =>
    withWorld(
      async (w) => {
        const card = async (): Promise<string> => {
          const id = testId("crd");
          await w.admin(
            "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now(), 'system:test', 'notice', '{acknowledge}', '{own}')",
            [id, testId("req")],
          );
          return id;
        };
        const add = async (row: string, refs: readonly Ref[], clearance: string[] | null): Promise<boolean> =>
          one(
            await w.admin<{ ok: boolean }>(
              "select ledger.add_basis('card', $1, '{own}', $2::text[], $3::text[], $4::text[]) as ok",
              [row, kindsOf(refs), idsOf(refs), clearance],
            ),
          ).ok;
        const rowsOf = (row: string) =>
          w.admin(
            "select ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments from ledger.basis where row_kind = 'card' and row_id = $1 order by id",
            [row],
          );

        const ownGoal = await goal(w, OWN);
        const hypothesis = await hypothesisBy(w, w.a);
        const opportunity = await opportunityBy(w, w.a);
        const resolved = await card();
        expect(
          await add(
            resolved,
            [
              ["goal", ownGoal],
              ["hypothesis", hypothesis],
              ["opportunity", opportunity],
            ],
            OWN,
          ),
        ).toBe(true);
        expect(await rowsOf(resolved)).toEqual([
          {
            ref_kind: "goal",
            ref_id: ownGoal,
            evidence_id: null,
            source_class: "owner",
            owner_backed: false,
            compartments: OWN,
          },
          {
            ref_kind: "hypothesis",
            ref_id: hypothesis,
            evidence_id: null,
            source_class: "agent",
            owner_backed: false,
            compartments: OWN,
          },
          {
            ref_kind: "opportunity",
            ref_id: opportunity,
            evidence_id: null,
            source_class: "agent",
            owner_backed: false,
            compartments: OWN,
          },
        ]);

        // Outside the clearance, and missing: the same false, nothing written.
        const workGoal = await goal(w, WORK);
        const workHypothesis = await hypothesisBy(w, w.b);
        const workOpportunity = await opportunityBy(w, w.b);
        const refused = await card();
        for (const ref of [
          ["goal", workGoal],
          ["hypothesis", workHypothesis],
          ["opportunity", workOpportunity],
          ["goal", testId("gol")],
          ["hypothesis", testId("hyp")],
          ["opportunity", testId("opp")],
        ] as Ref[]) {
          expect(await add(refused, [["goal", ownGoal], ref], OWN), ref.join(" ")).toBe(false);
        }
        expect(await rowsOf(refused)).toEqual([]);
        // The control: under a clearance that covers them, the same rows resolve.
        expect(
          await add(
            refused,
            [
              ["goal", workGoal],
              ["hypothesis", workHypothesis],
              ["opportunity", workOpportunity],
            ],
            BOTH,
          ),
        ).toBe(true);
        expect((await rowsOf(refused)).map((row) => [row.ref_kind, row.source_class])).toEqual([
          ["goal", "owner"],
          ["hypothesis", "agent"],
          ["opportunity", "agent"],
        ]);
      },
      { b: WORK },
    ));
});

describe("a session that was given a deleted item writes nothing", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  it("a session that read a message with read_message, after which the message is deleted, is refused with not_found and no row by propose_hypothesis, propose_opportunity and record_test", () =>
    withWorld(async (w) => {
      const read = await w.message();
      const cited = await w.message();
      const hypothesis = await hypothesisBy(w, w.b);
      // A second session of the same client, which read only what stays.
      const other = await openWorkSession(w.db, w.a.token);
      await logRead(w, w.a, w.a.session, read);
      await logRead(w, w.a, other, cited);
      await deleteMessage(w, read);

      const refs: Ref[] = [["message", cited.id]];
      const proposal = await hypothesisArgs(w, w.a, { refs });
      const opportunity = await opportunityArgs(w, w.a, { refs });
      const test = testArgs(w.a, hypothesis, refs);
      const before = await snapshot(w.db);
      expect(await call(w.db, w.a, proposeHypothesis(proposal))).toBeNull();
      expect(await call(w.db, w.a, proposeOpportunity(opportunity))).toBeNull();
      expect(await call(w.db, w.a, recordTest(test))).toEqual([]);
      expect(await snapshot(w.db)).toEqual(before);

      // The control: the same calls in the client's other session are taken.
      expect(await call(w.db, w.a, proposeHypothesis({ ...proposal, session: other }))).toBe(proposal.id);
      expect(await call(w.db, w.a, proposeOpportunity({ ...opportunity, session: other }))).toBe(opportunity.id);
      expect(await call(w.db, w.a, recordTest({ ...test, session: other }))).toEqual([
        { test_id: test.id, counts: true },
      ]);
    }));

  it("a session that read nothing deleted is not refused", () =>
    withWorld(async (w) => {
      const stays = await w.message();
      const gone = await w.message();
      const hypothesis = await hypothesisBy(w, w.b);
      // A read a message that stays; B read the one that is deleted.
      await logRead(w, w.a, w.a.session, stays);
      await logRead(w, w.b, w.b.session, gone);
      await deleteMessage(w, gone);

      const refs: Ref[] = [["message", stays.id]];
      const proposal = await hypothesisArgs(w, w.a, { refs });
      expect(await call(w.db, w.a, proposeHypothesis(proposal))).toBe(proposal.id);
      const opportunity = await opportunityArgs(w, w.a, { refs });
      expect(await call(w.db, w.a, proposeOpportunity(opportunity))).toBe(opportunity.id);
      const test = testArgs(w.a, hypothesis, refs);
      expect(await call(w.db, w.a, recordTest(test))).toEqual([{ test_id: test.id, counts: true }]);

      // The control: B's session, which read the deleted message, is refused the same calls.
      const before = await snapshot(w.db);
      const byB = await hypothesisArgs(w, w.b, { refs });
      expect(await call(w.db, w.b, proposeHypothesis(byB))).toBeNull();
      expect(await call(w.db, w.b, proposeOpportunity(await opportunityArgs(w, w.b, { refs })))).toBeNull();
      expect(await call(w.db, w.b, recordTest(testArgs(w.b, proposal.id, refs)))).toEqual([]);
      expect(await snapshot(w.db)).toEqual(before);
    }));
});

// ---------------------------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------------------------

describe("a repeated request id", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a repeated request id returns the first result and writes nothing, for propose_hypothesis, propose_opportunity and record_test", () =>
    withWorld(async (w) => {
      const hypothesis = await hypothesisArgs(w, w.a);
      const first = await call(w.db, w.a, proposeHypothesis(hypothesis));
      expect(first).toBe(hypothesis.id);
      let before = await snapshot(w.db);
      expect(await call(w.db, w.a, proposeHypothesis(hypothesis))).toBe(first);
      expect(await snapshot(w.db), "propose_hypothesis").toEqual(before);

      const opportunity = await opportunityArgs(w, w.a);
      const opportunityId = await call(w.db, w.a, proposeOpportunity(opportunity));
      expect(opportunityId).toBe(opportunity.id);
      before = await snapshot(w.db);
      expect(await call(w.db, w.a, proposeOpportunity(opportunity))).toBe(opportunityId);
      expect(await snapshot(w.db), "propose_opportunity").toEqual(before);

      // A test by another client, so it counts and moves the hypothesis's status: the repeat
      // writes no second status event either.
      const test = testArgs(w.b, hypothesis.id, hypothesis.refs);
      const answer = await call(w.db, w.b, recordTest(test));
      expect(answer).toEqual([{ test_id: test.id, counts: true }]);
      before = await snapshot(w.db);
      expect(await call(w.db, w.b, recordTest(test))).toEqual(answer);
      expect(await snapshot(w.db), "record_test").toEqual(before);

      // The control: a new request id is a new call.
      const fresh = await hypothesisArgs(w, w.a);
      expect(await call(w.db, w.a, proposeHypothesis(fresh))).toBe(fresh.id);
      expect(await snapshot(w.db)).not.toEqual(before);
    }));
});
