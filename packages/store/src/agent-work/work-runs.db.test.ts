import { DECISION_POINT_PINS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { ALL_TOOLS, revokeClient, testId } from "../test-support/clients.ts";
import { one, readAs, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import {
  AGENT_WORK_TOOLS,
  insertWorkClient,
  openWorkSession,
  RUN_TOOLS,
  type WorkClient,
} from "../test-support/work-clients.ts";

// Written without reading the migration. Runs are queued as pi_work, as the tick queues one;
// clients and settings are written as pi_admin; the functions are called as pi_reader under a
// client's token. Every refusal has its positive control in the same test. Made-up values only.

const OWN = ["own"];
// Sorted bytewise, as ledger.label sorts a label.
const BOTH = ["employer:example", "own"];

const pin = (key: string): string => {
  const value = DECISION_POINT_PINS[key];
  if (value === undefined) throw new Error(`no pin for ${key}`);
  return value;
};
const RUN_PIN = pin("run_outcome@1");
const MOVE_PIN = pin("move_clear@1");

type Message = { id: string; evidence: string };
type Row = Record<string, unknown>;

const admin = <R = Row>(db: TestDatabase, text: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(db.urls.admin, text, values);
const work = <R = Row>(db: TestDatabase, text: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(db.urls.work, text, values);
// One statement in one transaction under a client's token, as pi_reader.
const as = <R = Row>(db: TestDatabase, client: { token: string }, text: string, values?: unknown[]): Promise<R[]> =>
  readAs(db, client.token, (query) => query<R>(text, values));
const req = (): string => testId("req");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hoursAhead = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

// A summary sealed under a label at its row, as the store's Work seals one.
const sealed = (
  db: TestDatabase,
  compartments: string[],
  table: string,
  id: string,
  text = `made-up summary for ${id}`,
) => sealUnder(db.keys, compartments, { table, id, column: "body_enc" }, text);

// ---------------------------------------------------------------------------------------------
// The world: messages, their deletion, clients, runs, settings, the kill switch, erasures
// ---------------------------------------------------------------------------------------------

// Messages as pi_admin, each with an evidence row of its own.
async function messages(db: TestDatabase, count: number, compartments: string[] = OWN): Promise<Message[]> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const made: Message[] = [];
    for (let index = 0; index < count; index += 1) {
      const evidence = await seed.evidence(compartments, await seed.sourceAccount(compartments));
      made.push({ id: await seed.message(compartments, evidence), evidence });
    }
    return made;
  });
}

const first = <T>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) throw new Error("expected an item");
  return item;
};
const pair = <T>(items: T[]): [T, T] => {
  const [a, b] = items;
  if (a === undefined || b === undefined) throw new Error("expected two items");
  return [a, b];
};

// A message deleted as the writer deletes one (writer-item-removal.ts, removeSourceItem): the
// message row, then ledger.taint_citing with its evidence id and its ref, then its evidence row,
// in one transaction as pi_admin, which may do each. Returns what taint_citing answered.
async function deleteMessage(db: TestDatabase, message: Message): Promise<number> {
  return session(db.urls.admin, async (query) => {
    await query("begin");
    await query("delete from knowledge.messages where id = $1", [message.id]);
    const { n } = one(
      await query<{ n: number }>("select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n", [
        [message.evidence],
        [message.id],
      ]),
    );
    await query("delete from vault.evidence_items where id = $1", [message.evidence]);
    await query("commit");
    return n;
  });
}

const taintAgain = async (db: TestDatabase, message: Message): Promise<number> =>
  one(
    await admin<{ n: number }>(db, "select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n", [
      [message.evidence],
      [message.id],
    ]),
  ).n;

const reasoner = (db: TestDatabase, name: string, compartments: string[] = OWN): Promise<WorkClient> =>
  insertWorkClient(db, name, compartments, { kind: "reasoner" });
const agent = (db: TestDatabase, name: string, compartments: string[] = OWN): Promise<WorkClient> =>
  insertWorkClient(db, name, compartments, { kind: "agent" });

// A run queued as the tick queues one: lock_rows, the ledger.runs row, its queued event, and a
// basis row for each anchor through add_basis, in one transaction as pi_work. A pause first, so two
// runs queued one after the other are taken oldest first whether the oldest is found by id or by
// time.
async function queueRun(
  db: TestDatabase,
  anchors: Message[],
  compartments: string[] = OWN,
  id: string = testId("run"),
): Promise<string> {
  await pause(3);
  const request = req();
  await session(db.urls.work, async (query) => {
    await query("begin");
    await query("select ledger.lock_rows($1::text[])", [[id]]);
    await query(
      `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
       values ($1, $2, 'system:work', $3, 'owner_request', $4, 'run_outcome', 1, 'personal_run', '1')`,
      [id, request, compartments, `owner:${request}`],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:work', $2)",
      [id, compartments],
    );
    if (anchors.length > 0) {
      const { ok } = one(
        await query<{ ok: boolean }>(
          "select ledger.add_basis('run', $1, $2::text[], $3::text[], $4::text[], null) as ok",
          [id, compartments, anchors.map(() => "message"), anchors.map((anchor) => anchor.id)],
        ),
      );
      if (!ok) throw new Error("the run's anchors did not resolve");
    }
    await query("commit");
  });
  return id;
}

type Taken = {
  run_id: string;
  attempt: number;
  compartments: string[];
  max_turns: number;
  max_tool_calls: number;
  max_output_tokens: number;
  max_input_code_points: number;
  ceiling_microusd_per_token: number;
};
const nextRun = (
  db: TestDatabase,
  client: WorkClient,
  request: string = req(),
  sessionId: string = client.session,
): Promise<Taken[]> => as<Taken>(db, client, "select * from ledger.next_run($1, $2)", [request, sessionId]);
async function take(
  db: TestDatabase,
  client: WorkClient,
  run: string,
  sessionId: string = client.session,
): Promise<Taken> {
  const taken = one(await nextRun(db, client, req(), sessionId));
  if (taken.run_id !== run) throw new Error("next_run took another run");
  return taken;
}

type Step = { kind: "model_call"; cost: number } | { kind: "tool_call" } | { kind: "output_check" };
const MODEL = (cost = 10): Step => ({ kind: "model_call", cost });
const TOOL: Step = { kind: "tool_call" };
// One refusal of the checks of a run's output.
const CHECK: Step = { kind: "output_check" };
// A model call carries its prompt, model and cost and no status or tool; a tool call its tool
// and status and no cost (RunStep, "Contracts").
async function appendStep(
  db: TestDatabase,
  client: WorkClient,
  run: string,
  ordinal: number,
  step: Step,
  sessionId: string = client.session,
): Promise<boolean> {
  const values =
    step.kind === "model_call"
      ? [run, ordinal, sessionId, "model_call", null, null, null, "personal_run", "1", "test/made-up-model", step.cost]
      : step.kind === "tool_call"
        ? [run, ordinal, sessionId, "tool_call", "ok", "search", null, null, null, null, null]
        : [run, ordinal, sessionId, "output_check", "refused", null, "restates_goal", null, null, null, null];
  return one(
    await as<{ go: boolean }>(
      db,
      client,
      "select ledger.append_step($1, $2::integer, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint) as go",
      values,
    ),
  ).go;
}

type Finished = { recorded: number; outcome: string };
const finishRun = (
  db: TestDatabase,
  client: WorkClient,
  run: string,
  actions: unknown[],
  options: { request?: string; outcome?: string; code?: string | null; session?: string } = {},
): Promise<Finished[]> =>
  as<Finished>(db, client, "select * from ledger.finish_run($1, $2, $3, $4, $5, $6::integer, $7, $8::jsonb)", [
    run,
    options.request ?? req(),
    options.session ?? client.session,
    options.outcome ?? "finished",
    options.code ?? null,
    1,
    RUN_PIN,
    JSON.stringify(actions),
  ]);

const endRun = async (db: TestDatabase, run: string, outcome: string, code: string | null): Promise<boolean> =>
  one(await work<{ ended: boolean }>(db, "select ledger.end_run($1, $2, $3) as ended", [run, outcome, code])).ended;

// finish_run's actions, with the keys of the conventions file's fixed list.
const refsOf = (refs: string[]) => ({ ref_kinds: refs.map(() => "message"), ref_ids: refs });
function propose(
  db: TestDatabase,
  compartments: string[],
  about: string,
  refs: string[],
  options: { id?: string; kind?: string; summary?: string } = {},
) {
  const id = options.id ?? testId("opp");
  return {
    do: "propose",
    id,
    kind: options.kind ?? "follow_up",
    about_kind: "message",
    about_id: about,
    ...refsOf(refs),
    due_at: hoursAhead(48),
    probability: 0.4,
    probability_if_waiting: 0.2,
    body_enc: sealed(db, compartments, "ledger.opportunities", id, options.summary),
  };
}
function remind(db: TestDatabase, compartments: string[], about: string, refs: string[], id: string = testId("itn")) {
  return {
    do: "remind",
    id,
    about_kind: "message",
    about_id: about,
    due_at: hoursAhead(24),
    ...refsOf(refs),
    body_enc: sealed(db, compartments, "ledger.intentions", id),
  };
}
function investigate(
  db: TestDatabase,
  compartments: string[],
  about: string,
  refs: string[],
  id: string = testId("hyp"),
  opportunity: string = testId("opp"),
) {
  return {
    do: "investigate",
    id,
    kind: "open_loop",
    about_kind: "message",
    about_id: about,
    ...refsOf(refs),
    body_enc: sealed(db, compartments, "ledger.hypotheses", id),
    opportunity_id: opportunity,
    opportunity_body_enc: sealed(db, compartments, "ledger.opportunities", opportunity),
  };
}
const IGNORE = { do: "ignore", reason: "nothing_to_do" };

const settings = (db: TestDatabase, values: Record<string, number>): Promise<unknown> => {
  const columns = Object.keys(values);
  return admin(
    db,
    `update policy.work_settings set ${columns.map((column, index) => `${column} = $${index + 1}`).join(", ")}`,
    columns.map((column) => values[column]),
  );
};

const killSwitch = (db: TestDatabase, state: "on" | "off"): Promise<unknown> =>
  admin(
    db,
    "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ($1, 'owner', '{own}', $2)",
    [req(), state],
  );

const erasureMark = async (db: TestDatabase): Promise<number> =>
  one(await admin<{ mark: number }>(db, "select policy.erasure_mark()::int as mark")).mark;

// An erasure as pi_admin writes one: its decision, then the erasure at the next journal
// sequence number, which moves policy.erasure_mark(). Returns the new mark.
async function erase(db: TestDatabase): Promise<number> {
  await session(db.urls.admin, async (query) => {
    const ruling = testId("rul");
    await query(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
      [ruling, req()],
    );
    const { seq } = one(await query<{ seq: number }>("select policy.erasure_mark()::int + 1 as seq"));
    await query(
      "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'item', $3, now(), 0, 0, 0, '{own}')",
      [testId("ers"), ruling, seq],
    );
  });
  return erasureMark(db);
}

// Moves an attempt's take back in time. No runtime role may update ledger.run_attempts, and its
// owner's policies give pi_owner select and insert only, so the owner, through the bootstrap's
// membership, lifts the forced row-level security for one statement and puts it back, all in one
// committed transaction: the catalogue is as it was when it commits.
async function backdateTake(db: TestDatabase, run: string, seconds: number): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query("alter table ledger.run_attempts no force row level security");
    await query(
      "update ledger.run_attempts set taken_at = taken_at - make_interval(secs => $2), created_at = created_at - make_interval(secs => $2) where run_id = $1",
      [run, seconds],
    );
    await query("alter table ledger.run_attempts force row level security");
    await query("commit");
  });
}

// A session's read, logged as the reader logs one: by id with read_message, which binds,
// or in a list with find_messages, which only shows.
const readMessage = (db: TestDatabase, client: WorkClient, sessionId: string, message: Message): Promise<unknown> =>
  as(db, client, "select policy.log_read($1, 'read_message', $2::text[], '{}'::text[], '{}'::text[])", [
    sessionId,
    [message.evidence],
  ]);
const showMessage = (db: TestDatabase, client: WorkClient, sessionId: string, message: Message): Promise<unknown> =>
  as(db, client, "select policy.log_read($1, 'find_messages', '{}'::text[], $2::text[], '{}'::text[])", [
    sessionId,
    [message.evidence],
  ]);

// ---------------------------------------------------------------------------------------------
// What a client's work functions write, for the rows the taint must reach
// ---------------------------------------------------------------------------------------------

async function proposeOpportunity(
  db: TestDatabase,
  client: WorkClient,
  options: { about: string; refs: string[]; kind?: string; sessionId?: string; id?: string },
): Promise<string | null> {
  const id = options.id ?? testId("opp");
  return one(
    await as<{ id: string | null }>(
      db,
      client,
      "select ledger.propose_opportunity($1, $2, $3, $4, 'message', $5, null, null, $6::jsonb, $7::text[], $8::text[]) as id",
      [
        id,
        req(),
        options.sessionId ?? client.session,
        options.kind ?? "follow_up",
        options.about,
        sealed(db, client.compartments, "ledger.opportunities", id),
        options.refs.map(() => "message"),
        options.refs,
      ],
    ),
  ).id;
}

async function proposeHypothesis(
  db: TestDatabase,
  client: WorkClient,
  about: string,
  refs: string[],
): Promise<string | null> {
  const id = testId("hyp");
  return one(
    await as<{ id: string | null }>(
      db,
      client,
      "select ledger.propose_hypothesis($1, $2, $3, 'open_loop', 'message', $4, $5::jsonb, $6::text[], $7::text[]) as id",
      [
        id,
        req(),
        client.session,
        about,
        sealed(db, client.compartments, "ledger.hypotheses", id),
        refs.map(() => "message"),
        refs,
      ],
    ),
  ).id;
}

async function recordTest(db: TestDatabase, client: WorkClient, hypothesis: string, refs: string[]): Promise<string> {
  return one(
    await as<{ test_id: string }>(
      db,
      client,
      "select * from ledger.record_test($1, $2, $3, $4, 'supports', $5::text[], $6::text[])",
      [testId("tst"), req(), client.session, hypothesis, refs.map(() => "message"), refs],
    ),
  ).test_id;
}

// What lets a client claim and move a meeting_prep at its one stage, prepare: a confirmed intent
// that lists the kind and the client, and a harness mode act for the kind and the stage, as
// pi_admin. Returns the intent's id.
async function grantWork(db: TestDatabase, client: WorkClient): Promise<string> {
  const intent = testId("int");
  await admin(
    db,
    "insert into policy.intents (id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at) values ($1, '{meeting_prep}', '{none}', $2, 'owner_decides', 5, now())",
    [intent, [client.id]],
  );
  await admin(
    db,
    "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'meeting_prep', 'prepare', 'act', now())",
    [testId("hrn"), client.id],
  );
  return intent;
}

// The owner's go, as their answer to the opportunity's card writes it: the decision under the intent
// and the opportunity's go event, with the opportunity's label, as pi_admin.
async function ownerGo(db: TestDatabase, opportunity: string, intent: string, compartments: string[]): Promise<void> {
  await admin(
    db,
    `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
     values ($1, 'owner', $2, $3, 'go', 'owner', 4, 'owner_answer', $4)`,
    [req(), compartments, opportunity, intent],
  );
  await admin(
    db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'go', now(), 'owner', $2)",
    [opportunity, compartments],
  );
}

// A meeting_prep the client proposed, the owner sent to go, and the client claimed.
async function claimedOpportunity(
  db: TestDatabase,
  client: WorkClient,
  intent: string,
  about: string,
  refs: string[],
): Promise<string> {
  const opportunity = await proposeOpportunity(db, client, { about, refs, kind: "meeting_prep" });
  if (opportunity === null) throw new Error("the proposal was refused");
  await ownerGo(db, opportunity, intent, client.compartments);
  const { until } = one(
    await as<{ until: string | null }>(db, client, "select ledger.claim($1, $2, $3, $4) as until", [
      opportunity,
      testId("asg"),
      req(),
      client.session,
    ]),
  );
  if (until === null) throw new Error("the claim was refused");
  return opportunity;
}

// That opportunity's prepare move, cleared and reported failed with a summary, which hands the
// opportunity to the owner. `before` runs between the clear and the report.
async function handedWithReport(
  db: TestDatabase,
  client: WorkClient,
  intent: string,
  about: string,
  refs: string[],
  reportRefs: string[],
  before: () => Promise<unknown> = async () => {},
): Promise<{ opportunity: string; move: string }> {
  const opportunity = await claimedOpportunity(db, client, intent, about, refs);
  const move = testId("mov");
  const { cleared } = one(
    await as<{ cleared: string | null }>(
      db,
      client,
      "select ledger.plan_move($1, $2, 'prepare', $3, $4, 1, $5) as cleared",
      [move, opportunity, req(), client.session, MOVE_PIN],
    ),
  );
  if (cleared !== move) throw new Error("the move was not cleared");
  await before();
  const { status } = one(
    await as<{ status: string | null }>(
      db,
      client,
      "select ledger.report_move($1, 'failed', $2, $3, $4::jsonb, $5::text[], $6::text[]) as status",
      [
        move,
        req(),
        client.session,
        sealUnder(
          db.keys,
          client.compartments,
          { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
          "a made-up report",
        ),
        reportRefs.map(() => "message"),
        reportRefs,
      ],
    ),
  );
  if (status !== "handed_to_owner") throw new Error(`the report answered ${String(status)}`);
  return { opportunity, move };
}

// ---------------------------------------------------------------------------------------------
// Reading back, as pi_admin
// ---------------------------------------------------------------------------------------------

// Every row of the tables a run or a work function may write, with its xmin: equal before and
// after means nothing was written, updated or deleted.
const WRITTEN: [table: string, key: string][] = [
  ["ledger.runs", "id"],
  ["ledger.run_attempts", "run_id || '/' || attempt::text"],
  ["ledger.run_steps", "id"],
  ["ledger.silences", "id"],
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
  ["ledger.cards", "id"],
  ["queue.leases", "resource_kind || '/' || resource_id"],
];
async function written(db: TestDatabase): Promise<string[]> {
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

type RunState = {
  event: string | null;
  code: string | null;
  by: string | null;
  holder: string | null;
  lease_until: string | null;
  steps: number;
};
const runState = async (db: TestDatabase, run: string): Promise<RunState> =>
  one(
    await admin<RunState>(
      db,
      `select
         (select e.event from ledger.record_events e where e.row_kind = 'run' and e.row_id = $1 order by e.id desc limit 1) as event,
         (select e.code from ledger.record_events e where e.row_kind = 'run' and e.row_id = $1 order by e.id desc limit 1) as code,
         (select e.by from ledger.record_events e where e.row_kind = 'run' and e.row_id = $1 order by e.id desc limit 1) as by,
         (select l.holder from queue.leases l where l.resource_kind = 'run' and l.resource_id = $1) as holder,
         (select l.lease_until::text from queue.leases l where l.resource_kind = 'run' and l.resource_id = $1) as lease_until,
         (select count(*)::int from ledger.run_steps s where s.run_id = $1) as steps`,
      [run],
    ),
  );

type BodyRow = { tainted: boolean; body: boolean; status: string | null };
// A row with a body: tainted, whether it keeps its body, and its latest status event.
const bodyRow = async (db: TestDatabase, table: string, rowKind: string, id: string): Promise<BodyRow> =>
  one(
    await admin<BodyRow>(
      db,
      `select t.tainted_at is not null as tainted, t.body_enc is not null as body,
         (select e.event from ledger.record_events e where e.row_kind = $2 and e.row_id = t.id order by e.id desc limit 1) as status
       from ${table} t where t.id = $1`,
      [id, rowKind],
    ),
  );
const isTainted = async (db: TestDatabase, table: string, id: string): Promise<boolean> =>
  one(
    await admin<{ tainted: boolean }>(db, `select tainted_at is not null as tainted from ${table} where id = $1`, [id]),
  ).tainted;
const reportEvent = async (db: TestDatabase, move: string): Promise<{ tainted: boolean; body: boolean }> =>
  one(
    await admin<{ tainted: boolean; body: boolean }>(
      db,
      "select tainted_at is not null as tainted, body_enc is not null as body from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
      [move],
    ),
  );
const leases = async (db: TestDatabase, kind: string, id: string): Promise<number> =>
  one(
    await admin<{ n: number }>(
      db,
      "select count(*)::int as n from queue.leases where resource_kind = $1 and resource_id = $2",
      [kind, id],
    ),
  ).n;

const WHOLE_PROPOSED: BodyRow = { tainted: false, body: true, status: "proposed" };
const WITHDRAWN: BodyRow = { tainted: true, body: false, status: "withdrawn" };

// ---------------------------------------------------------------------------------------------
// next_run
// ---------------------------------------------------------------------------------------------

describe("ledger.next_run", { timeout: DB_TEST_TIMEOUT }, () => {
  it("next_run is refused for a client that is not the reasoner", () =>
    withDatabase(async (db) => {
      const run = await queueRun(db, [first(await messages(db, 1))]);
      // An agent that holds the run tools and the work view is still not the reasoner.
      const notReasoner = await insertWorkClient(db, "runs-agent", OWN, {
        kind: "agent",
        tools: [...ALL_TOOLS, "read_message", ...AGENT_WORK_TOOLS, ...RUN_TOOLS],
      });
      const before = await written(db);
      expect(await sqlState(() => nextRun(db, notReasoner))).toBe("42501");
      expect(await written(db)).toEqual(before);
      // The control: the reasoner takes it.
      const thinker = await reasoner(db, "runs-reasoner");
      expect((await nextRun(db, thinker)).map((row) => row.run_id)).toEqual([run]);
    }));

  it("next_run gives no row while the kill switch is on", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await killSwitch(db, "on");
      const before = await written(db);
      expect(await nextRun(db, thinker)).toEqual([]);
      expect(await written(db)).toEqual(before);
      expect((await runState(db, run)).event).toBe("queued");
      // The control: once the switch is off again, the same call takes the run.
      await killSwitch(db, "off");
      expect((await nextRun(db, thinker)).map((row) => row.run_id)).toEqual([run]);
      expect(await runState(db, run)).toMatchObject({ event: "running", holder: thinker.id });
    }));

  it("next_run gives no row while today's spend is at the ceiling", () =>
    withDatabase(async (db) => {
      await settings(db, { max_microusd_per_day: 500 });
      const thinker = await reasoner(db, "runs-reasoner");
      const spending = await queueRun(db, await messages(db, 1));
      await take(db, thinker, spending);
      expect(await appendStep(db, thinker, spending, 1, MODEL(500))).toBe(true);
      const waiting = await queueRun(db, await messages(db, 1));
      const before = await written(db);
      expect(await nextRun(db, thinker)).toEqual([]);
      expect(await written(db)).toEqual(before);
      // The control: a ceiling one micro-dollar above the spend lets the run be taken.
      await settings(db, { max_microusd_per_day: 501 });
      expect((await nextRun(db, thinker)).map((row) => row.run_id)).toEqual([waiting]);
    }));

  it("next_run returns the limits of work_settings, the two new ones included, and takes the run under a 2 400-second lease (0038), which outlasts one model turn", () =>
    withDatabase(async (db) => {
      await settings(db, {
        max_turns: 7,
        max_tool_calls: 9,
        max_output_tokens: 1234,
        max_input_code_points: 54321,
        ceiling_microusd_per_token: 17,
      });
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      const taken = one(await nextRun(db, thinker));
      expect(taken).toMatchObject({
        run_id: run,
        attempt: 1,
        compartments: OWN,
        max_turns: 7,
        max_tool_calls: 9,
        max_output_tokens: 1234,
        max_input_code_points: 54321,
        ceiling_microusd_per_token: 17,
      });
      expect(await runState(db, run)).toMatchObject({ event: "running", holder: thinker.id });
      const { seconds } = one(
        await admin<{ seconds: number }>(
          db,
          `select extract(epoch from l.lease_until - a.taken_at)::float8 as seconds from queue.leases l join ledger.run_attempts a on a.run_id = l.resource_id
           where l.resource_kind = 'run' and l.resource_id = $1`,
          [run],
        ),
      );
      expect(seconds).toBeGreaterThan(2395);
      expect(seconds).toBeLessThanOrEqual(2400);
    }));

  it("a second attempt is a new run_attempts row with its own session", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      expect((await take(db, thinker, run)).attempt).toBe(1);
      // The lease ran out: the tick returns the run to the queue.
      expect(await endRun(db, run, "queued", null)).toBe(true);
      expect(await runState(db, run)).toMatchObject({ event: "queued", holder: null });
      const second = await openWorkSession(db, thinker.token);
      const taken = one(await nextRun(db, thinker, req(), second));
      expect(taken).toMatchObject({ run_id: run, attempt: 2 });
      expect(
        await admin(
          db,
          "select attempt, client_id, session_id from ledger.run_attempts where run_id = $1 order by attempt",
          [run],
        ),
      ).toEqual([
        { attempt: 1, client_id: thinker.id, session_id: thinker.session },
        { attempt: 2, client_id: thinker.id, session_id: second },
      ]);
    }));

  it("a run's attempt carries the clearance of the reasoner that took it, not of the one registered when it was queued, and its session and the erasure mark at the take", () =>
    withDatabase(async (db) => {
      const queuedUnder = await reasoner(db, "runs-reasoner-before", OWN);
      const run = await queueRun(db, await messages(db, 1));
      // An erasure before the take, so the mark the attempt carries is not the default.
      const mark = await erase(db);
      expect(mark).toBeGreaterThan(0);
      await revokeClient(db, queuedUnder);
      const takenBy = await reasoner(db, "runs-reasoner-after", BOTH);
      const taken = one(await nextRun(db, takenBy));
      expect(taken).toMatchObject({ run_id: run, compartments: BOTH });
      expect(
        await admin(
          db,
          "select client_id, compartments, session_id, erasure_mark::int as mark from ledger.run_attempts where run_id = $1",
          [run],
        ),
      ).toEqual([{ client_id: takenBy.id, compartments: BOTH, session_id: takenBy.session, mark }]);
      // The run's own row keeps the label it was queued with.
      expect(
        one(await admin<{ compartments: string[] }>(db, "select compartments from ledger.runs where id = $1", [run]))
          .compartments,
      ).toEqual(OWN);
    }));

  it("a repeated request id returns the first result and writes nothing", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const older = await queueRun(db, await messages(db, 1));
      const younger = await queueRun(db, await messages(db, 1));
      const request = req();
      const answer = await nextRun(db, thinker, request);
      expect(answer.map((row) => row.run_id)).toEqual([older]);
      const before = await written(db);
      expect(await nextRun(db, thinker, request)).toEqual(answer);
      expect(await written(db)).toEqual(before);
      expect((await runState(db, younger)).event).toBe("queued");
      // The control: a new request id takes the next run.
      expect((await nextRun(db, thinker)).map((row) => row.run_id)).toEqual([younger]);
    }));
});

type Bound = {
  name: string;
  settings?: Record<string, number>;
  // The steps that pass, the positive control.
  passing: Step[];
  // What puts the run past the bound, after the passing steps.
  arrange?: (db: TestDatabase, run: string, thinker: WorkClient) => Promise<unknown>;
  // The step that is refused.
  refused: Step;
  // null: the run is unchanged. A code: the run's latest event is failed with it, the lease is gone.
  ends: string | null;
};

const BOUNDS: Bound[] = [
  {
    name: "a run that is not running",
    passing: [MODEL()],
    arrange: (db, run) =>
      work(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('run', $1, 'stopped', now(), 'system:work', '{own}', 'kill_switch')",
        [run],
      ),
    refused: TOOL,
    ends: null,
  },
  {
    name: "a run the caller does not hold",
    passing: [MODEL()],
    arrange: async (db, run) => {
      const other = await agent(db, "runs-other-holder");
      await work(db, "update queue.leases set holder = $2 where resource_kind = 'run' and resource_id = $1", [
        run,
        other.id,
      ]);
    },
    refused: TOOL,
    ends: null,
  },
  { name: "the kill switch", passing: [MODEL()], arrange: (db) => killSwitch(db, "on"), refused: TOOL, ends: null },
  {
    name: "a clearance that changed (R19)",
    passing: [MODEL()],
    arrange: (db, _run, thinker) =>
      admin(db, "update policy.clients set compartments = $2 where id = $1", [thinker.id, BOTH]),
    refused: TOOL,
    ends: null,
  },
  {
    name: "an erasure mark that moved (R33)",
    passing: [MODEL()],
    arrange: (db) => erase(db),
    refused: TOOL,
    ends: null,
  },
  {
    name: "max_turns model calls",
    settings: { max_turns: 2, max_tool_calls: 1 },
    passing: [MODEL(), MODEL()],
    refused: MODEL(),
    ends: "turn_limit",
  },
  {
    name: "max_turns + max_tool_calls steps",
    settings: { max_turns: 2, max_tool_calls: 1 },
    passing: [MODEL(), TOOL, TOOL],
    refused: TOOL,
    ends: "tool_limit",
  },
  {
    name: "today's spend at the ceiling",
    settings: { max_microusd_per_day: 1000 },
    passing: [MODEL(1000)],
    refused: TOOL,
    ends: "budget",
  },
  {
    name: "3 600 seconds since it was taken",
    passing: [MODEL()],
    arrange: (db, run) => backdateTake(db, run, 3601),
    refused: TOOL,
    ends: "timeout",
  },
  // A lease never runs past the 3 600th second, so a run past it has a lease that has just run out.
  {
    name: "3 600 seconds since it was taken, its lease ended at that second",
    passing: [MODEL()],
    arrange: async (db, run) => {
      await backdateTake(db, run, 3601);
      await work(
        db,
        "update queue.leases set lease_until = now() - interval '1 second' where resource_kind = 'run' and resource_id = $1",
        [run],
      );
    },
    refused: TOOL,
    ends: "timeout",
  },
  {
    name: "max_turns model calls, then a tool call",
    settings: { max_turns: 2, max_tool_calls: 5 },
    passing: [MODEL(), MODEL()],
    refused: TOOL,
    ends: "turn_limit",
  },
  { name: "80 output checks", passing: [MODEL(), ...Array<Step>(80).fill(CHECK)], refused: CHECK, ends: "tool_limit" },
];

describe("append_step answers go false at each bound", { timeout: DB_TEST_TIMEOUT }, () => {
  for (const bound of BOUNDS) {
    it(`${bound.name}: go false, and ${bound.ends === null ? "the run is unchanged" : `the run ends failed with ${bound.ends} and its lease is gone`}`, () =>
      withDatabase(async (db) => {
        if (bound.settings !== undefined) await settings(db, bound.settings);
        const thinker = await reasoner(db, "runs-reasoner");
        const run = await queueRun(db, await messages(db, 1));
        await take(db, thinker, run);
        let ordinal = 0;
        for (const step of bound.passing) {
          ordinal += 1;
          expect(await appendStep(db, thinker, run, ordinal, step), `passing step ${ordinal}`).toBe(true);
        }
        await bound.arrange?.(db, run, thinker);
        const state = await runState(db, run);
        const before = await written(db);
        expect(await appendStep(db, thinker, run, ordinal + 1, bound.refused)).toBe(false);
        if (bound.ends === null) {
          expect(await written(db)).toEqual(before);
          expect(await runState(db, run)).toEqual(state);
          return;
        }
        // The step that would have passed the bound is not written.
        expect(await runState(db, run)).toEqual({
          event: "failed",
          code: bound.ends,
          by: "system:bounds",
          holder: null,
          lease_until: null,
          steps: ordinal,
        });
      }));
  }

  it("a step extends the lease by 2 400 seconds and never past the 3 600th", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      // A lease a minute from its end: a step puts it 2 400 seconds ahead.
      await work(
        db,
        "update queue.leases set lease_until = now() + interval '60 seconds' where resource_kind = 'run' and resource_id = $1",
        [run],
      );
      expect(await appendStep(db, thinker, run, 1, MODEL())).toBe(true);
      const { ahead } = one(
        await admin<{ ahead: number }>(
          db,
          "select extract(epoch from lease_until - now())::float8 as ahead from queue.leases where resource_kind = 'run' and resource_id = $1",
          [run],
        ),
      );
      expect(ahead).toBeGreaterThan(2380);
      expect(ahead).toBeLessThanOrEqual(2400);
      // Taken 3 300 seconds ago: the step's lease ends at the 3 600th second, not 2 400 from now.
      await backdateTake(db, run, 3300);
      expect(await appendStep(db, thinker, run, 2, TOOL)).toBe(true);
      const { since } = one(
        await admin<{ since: number }>(
          db,
          `select extract(epoch from l.lease_until - a.taken_at)::float8 as since from queue.leases l join ledger.run_attempts a on a.run_id = l.resource_id
           where l.resource_kind = 'run' and l.resource_id = $1`,
          [run],
        ),
      );
      expect(since).toBe(3600);
    }));

  it("0034: an output check is recorded after the run's last turn, and counts toward no turn and no tool call", () =>
    withDatabase(async (db) => {
      await settings(db, { max_turns: 2, max_tool_calls: 1 });
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      // Checks among the steps leave room for the one tool call and the second model call.
      for (const [index, step] of [MODEL(), CHECK, CHECK, TOOL, MODEL(), CHECK, CHECK].entries())
        expect(await appendStep(db, thinker, run, index + 1, step), `step ${index + 1}`).toBe(true);
      expect((await runState(db, run)).event).toBe("running");
      // The control: anything else past the last turn is the bound.
      expect(await appendStep(db, thinker, run, 8, TOOL)).toBe(false);
      expect(await runState(db, run)).toMatchObject({ event: "failed", code: "turn_limit", steps: 7 });
      // An output check holds a code and nothing a tool or a model call holds.
      expect(
        await admin(
          db,
          "select kind, status, tool, code, cost_microusd from ledger.run_steps where run_id = $1 and kind = 'output_check' order by ordinal limit 1",
          [run],
        ),
      ).toEqual([{ kind: "output_check", status: "refused", tool: null, code: "restates_goal", cost_microusd: null }]);
    }));

  it("0034: an output check with a tool, with no code or with a status but refused breaks the shape", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      const step = (ordinal: number, status: string, tool: string | null, code: string | null) =>
        as<{ go: boolean }>(
          db,
          thinker,
          "select ledger.append_step($1, $2::integer, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint) as go",
          [run, ordinal, thinker.session, "output_check", status, tool, code, null, null, null, null],
        );
      expect(await sqlState(() => step(1, "refused", "search", "same_case"))).toBe("23514");
      expect(await sqlState(() => step(1, "refused", null, null))).toBe("23514");
      expect(await sqlState(() => step(1, "ok", null, "same_case"))).toBe("23514");
      expect(one(await step(1, "refused", null, "same_case")).go).toBe(true);
    }));

  it("a second step with one ordinal is refused", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      expect(await appendStep(db, thinker, run, 1, MODEL())).toBe(true);
      expect(await sqlState(() => appendStep(db, thinker, run, 1, TOOL))).toBe("23505");
      // The control: the next ordinal is taken.
      expect(await appendStep(db, thinker, run, 2, TOOL)).toBe(true);
      expect((await runState(db, run)).steps).toBe(2);
    }));
});

type CallRow = {
  output: string;
  effect: string;
  effect_class: string;
  point: string;
  rung: number;
  subject_kind: string;
  subject_id: string;
  input_hash: string;
};
const callsOf = (db: TestDatabase, run: string): Promise<CallRow[]> =>
  admin<CallRow>(
    db,
    "select output, effect, effect_class, point, rung, subject_kind, subject_id, input_hash from ledger.decision_point_calls where run_id = $1 order by output",
    [run],
  );

describe("ledger.finish_run", { timeout: DB_TEST_TIMEOUT }, () => {
  it("finish_run writes its rows with the run as author, the attempt's compartments and the attempt's session, each action kind its rows and one run_outcome call, in one transaction", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      // The run is queued under its anchor's label; the attempt carries the wider clearance.
      const thinker = await reasoner(db, "runs-reasoner", BOTH);
      const run = await queueRun(db, [m], OWN);
      await take(db, thinker, run);
      const intention = testId("itn");
      const hypothesis = testId("hyp");
      const investigation = testId("opp");
      const proposed = testId("opp");
      const actions = [
        remind(db, BOTH, m.id, [m.id], intention),
        investigate(db, BOTH, m.id, [m.id], hypothesis, investigation),
        propose(db, BOTH, m.id, [m.id], { id: proposed }),
      ];
      expect(await finishRun(db, thinker, run, actions)).toEqual([{ recorded: 3, outcome: "finished" }]);

      const author = { created_by: `run:${run}`, run_id: run, session_id: thinker.session, compartments: BOTH };
      expect(
        await admin(
          db,
          "select id, created_by, run_id, session_id, compartments, kind, about_kind, about_id, about_owner from ledger.hypotheses where run_id = $1",
          [run],
        ),
      ).toEqual([
        { id: hypothesis, ...author, kind: "open_loop", about_kind: "message", about_id: m.id, about_owner: false },
      ]);
      expect(
        await admin(
          db,
          "select id, created_by, run_id, session_id, compartments, kind, hypothesis_id, proposed_by_class from ledger.opportunities where run_id = $1 order by kind",
          [run],
        ),
      ).toEqual([
        { id: proposed, ...author, kind: "follow_up", hypothesis_id: null, proposed_by_class: "run" },
        { id: investigation, ...author, kind: "investigate", hypothesis_id: hypothesis, proposed_by_class: "run" },
      ]);
      expect(
        await admin(
          db,
          "select id, created_by, run_id, session_id, compartments, kind, client_id from ledger.intentions where run_id = $1",
          [run],
        ),
      ).toEqual([{ id: intention, ...author, kind: "remind", client_id: null }]);
      expect((await bodyRow(db, "ledger.hypotheses", "hypothesis", hypothesis)).status).toBe("open");
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", proposed)).toEqual(WHOLE_PROPOSED);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", investigation)).toEqual(WHOLE_PROPOSED);
      expect(await bodyRow(db, "ledger.intentions", "intention", intention)).toEqual({
        tainted: false,
        body: true,
        status: "set",
      });
      // Each row cites the ref it was given.
      for (const [kind, id] of [
        ["hypothesis", hypothesis],
        ["opportunity", proposed],
        ["intention", intention],
      ]) {
        expect(
          await admin(db, "select ref_kind, ref_id from ledger.basis where row_kind = $1 and row_id = $2", [kind, id]),
          `${kind} basis`,
        ).toEqual([{ ref_kind: "message", ref_id: m.id }]);
      }

      const calls = await callsOf(db, run);
      expect(calls.map(({ input_hash: _, subject_id: __, subject_kind: ___, ...call }) => call)).toEqual([
        {
          output: "investigate",
          effect: "open_investigation",
          effect_class: "internal_reversible",
          point: "run_outcome",
          rung: 3,
        },
        {
          output: "propose",
          effect: "propose_opportunity",
          effect_class: "internal_reversible",
          point: "run_outcome",
          rung: 3,
        },
        {
          output: "remind",
          effect: "set_intention",
          effect_class: "internal_reversible",
          point: "run_outcome",
          rung: 3,
        },
      ]);
      const [investigated, offered, reminded] = calls;
      expect([hypothesis, investigation]).toContain(investigated?.subject_id);
      expect(offered).toMatchObject({ subject_kind: "opportunity", subject_id: proposed });
      expect(reminded).toMatchObject({ subject_kind: "intention", subject_id: intention });
      for (const call of calls) expect(call.input_hash).toMatch(/^[0-9a-f]{64}$/);

      expect(await runState(db, run)).toMatchObject({ event: "finished", code: null, holder: null, lease_until: null });
    }));

  it("0033: a proposal that names an investigate action of its output rests on that hypothesis, which then opens no investigate opportunity of its own; any other name is invalid_request", () =>
    withDatabase(async (db) => {
      const [m, n] = await messages(db, 2);
      if (m === undefined || n === undefined) throw new Error("two messages");
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      const hypothesis = testId("hyp");
      const unused = testId("opp");
      const first = testId("opp");
      const second = testId("opp");
      const named = (id: string, ord: number, kind = "goal_step", about = m.id) => ({
        ...propose(db, OWN, about, [m.id], { id, kind }),
        hypothesis_ord: ord,
      });
      // A name that is not an earlier investigate action not about the owner writes nothing.
      for (const actions of [
        [named(first, 1)],
        [named(first, 2), investigate(db, OWN, n.id, [n.id], hypothesis, unused)],
        [propose(db, OWN, n.id, [n.id]), named(first, 1)],
        [
          { ...investigate(db, OWN, n.id, [n.id], hypothesis, unused), about_kind: "owner", about_id: null },
          named(first, 1),
        ],
        [{ ...investigate(db, OWN, n.id, [n.id], hypothesis, unused), hypothesis_ord: 1 }],
      ]) {
        expect(
          await sqlState(() => finishRun(db, thinker, run, actions)),
          JSON.stringify(actions.map((one) => one.do)),
        ).toBe("22023");
      }
      expect(
        await admin(
          db,
          "select id from ledger.opportunities where run_id = $1 union all select id from ledger.hypotheses where run_id = $1",
          [run],
        ),
      ).toEqual([]);

      const actions = [
        investigate(db, OWN, n.id, [n.id], hypothesis, unused),
        named(first, 1),
        named(second, 1, "investigate", n.id),
      ];
      expect(await finishRun(db, thinker, run, actions)).toEqual([{ recorded: 3, outcome: "finished" }]);
      expect(
        await admin(db, "select id, kind, hypothesis_id from ledger.opportunities where run_id = $1 order by kind", [
          run,
        ]),
      ).toEqual([
        { id: first, kind: "goal_step", hypothesis_id: hypothesis },
        { id: second, kind: "investigate", hypothesis_id: hypothesis },
      ]);
      // A hypothesis no proposal names still opens its investigate opportunity, as before.
      const later = await queueRun(db, [m]);
      await take(db, thinker, later);
      const another = testId("hyp");
      const opened = testId("opp");
      expect(await finishRun(db, thinker, later, [investigate(db, OWN, m.id, [m.id], another, opened)])).toEqual([
        { recorded: 1, outcome: "finished" },
      ]);
      expect(await admin(db, "select id, hypothesis_id from ledger.opportunities where run_id = $1", [later])).toEqual([
        { id: opened, hypothesis_id: another },
      ]);
    }));

  // An opportunity's case includes the hypothesis it rests on. A second
  // investigate on one thing that opens a new hypothesis opens its own investigate opportunity,
  // resting on it, in a case of its own; the first's, still open, keeps its basis.
  it("a second investigate on one thing that opens a new hypothesis opens its own investigate opportunity in a case of its own", () =>
    withDatabase(async (db) => {
      const [m, n] = await messages(db, 2);
      if (m === undefined || n === undefined) throw new Error("two messages");
      const thinker = await reasoner(db, "runs-reasoner");
      const before = await queueRun(db, [m]);
      await take(db, thinker, before);
      const [hypothesis, opportunity] = [testId("hyp"), testId("opp")];
      expect(
        await finishRun(db, thinker, before, [investigate(db, OWN, m.id, [m.id], hypothesis, opportunity)]),
      ).toEqual([{ recorded: 1, outcome: "finished" }]);
      // The first hypothesis is refuted; its investigate opportunity is still proposed.
      await admin(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'refuted', now(), 'owner', '{own}')",
        [hypothesis],
      );

      const after = await queueRun(db, [m]);
      await take(db, thinker, after);
      const [second, secondOpportunity] = [testId("hyp"), testId("opp")];
      expect(
        await finishRun(db, thinker, after, [investigate(db, OWN, m.id, [m.id, n.id], second, secondOpportunity)]),
      ).toEqual([{ recorded: 1, outcome: "finished" }]);
      expect(
        await admin(db, "select id from ledger.hypotheses where about_id = $1 order by created_at", [m.id]),
      ).toEqual([{ id: hypothesis }, { id: second }]);
      expect(
        await admin(
          db,
          "select o.id, o.hypothesis_id, k.hypothesis_id as case_hypothesis from ledger.opportunities o join ledger.cases k on k.id = o.case_id where o.kind = 'investigate' and o.about_id = $1 order by o.created_at",
          [m.id],
        ),
      ).toEqual([
        { id: opportunity, hypothesis_id: hypothesis, case_hypothesis: hypothesis },
        { id: secondOpportunity, hypothesis_id: second, case_hypothesis: second },
      ]);
      expect(
        await admin(db, "select ref_id from ledger.basis where row_kind = 'opportunity' and row_id = $1", [
          opportunity,
        ]),
      ).toEqual([{ ref_id: m.id }]);
    }));

  it("an ignore writes a silence for the run's wake on today's UTC day and one run_outcome call on the run", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      expect(await finishRun(db, thinker, run, [IGNORE])).toEqual([{ recorded: 1, outcome: "finished" }]);
      expect(
        await admin(
          db,
          `select s.reason, s.wake_source, s.wake_key = r.wake_key as same_key, s.day = (now() at time zone 'utc')::date as today
           from ledger.silences s cross join ledger.runs r where r.id = $1`,
          [run],
        ),
      ).toEqual([{ reason: "nothing_to_do", wake_source: "owner_request", same_key: true, today: true }]);
      expect((await callsOf(db, run)).map(({ input_hash: _, ...call }) => call)).toEqual([
        {
          output: "ignore",
          effect: "record_silence",
          effect_class: "narrow",
          point: "run_outcome",
          rung: 3,
          subject_kind: "run",
          subject_id: run,
        },
      ]);
      expect((await runState(db, run)).event).toBe("finished");
    }));

  it("a bad action writes none of the output's rows", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      const state = await runState(db, run);
      const before = await written(db);
      // A word outside its closed list is invalid_request (22023), and the good action beside it
      // is not written either.
      expect(
        await sqlState(() =>
          finishRun(db, thinker, run, [
            propose(db, OWN, m.id, [m.id]),
            propose(db, OWN, m.id, [m.id], { kind: "not_a_kind" }),
          ]),
        ),
      ).toBe("22023");
      expect(await written(db)).toEqual(before);
      expect(await runState(db, run)).toEqual(state);
      // The control: the good action alone is written.
      expect(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id])])).toEqual([
        { recorded: 1, outcome: "finished" },
      ]);
    }));

  it("finish_run with a ref that does not resolve answers null, writes nothing and leaves the run running", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      const hidden = first(await messages(db, 1, ["employer:example"]));
      const thinker = await reasoner(db, "runs-reasoner", OWN);
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      const state = await runState(db, run);
      const before = await written(db);
      // A ref that does not exist, and one outside the attempt's clearance, answer alike.
      for (const ref of [testId("msg"), hidden.id]) {
        expect(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id, ref])]), ref).toEqual([]);
        expect(await written(db)).toEqual(before);
        expect(await runState(db, run)).toEqual(state);
      }
      // The control: the same action with refs that resolve.
      expect(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id])])).toEqual([
        { recorded: 1, outcome: "finished" },
      ]);
    }));

  it("finish_run is refused once the reasoner's clearance differs from the attempt's", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      const thinker = await reasoner(db, "runs-reasoner", OWN);
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      await admin(db, "update policy.clients set compartments = $2 where id = $1", [thinker.id, BOTH]);
      const state = await runState(db, run);
      const before = await written(db);
      expect(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id])])).toEqual([]);
      expect(await written(db)).toEqual(before);
      expect(await runState(db, run)).toEqual(state);
      // The control: the clearance back as it was at the take.
      await admin(db, "update policy.clients set compartments = $2 where id = $1", [thinker.id, OWN]);
      expect(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id])])).toEqual([
        { recorded: 1, outcome: "finished" },
      ]);
    }));

  it("a repeated request id returns the first result and writes nothing", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      const request = req();
      const action = propose(db, OWN, m.id, [m.id]);
      const answer = await finishRun(db, thinker, run, [action], { request });
      expect(answer).toEqual([{ recorded: 1, outcome: "finished" }]);
      const before = await written(db);
      expect(await finishRun(db, thinker, run, [action], { request })).toEqual(answer);
      expect(await written(db)).toEqual(before);
    }));

  // The preimage of run_outcome's input_hash is { run, attempt, action, kind, refs }: the run id
  // is in it, so two calls that differ only in a summary are two databases' runs with one id,
  // one attempt and one set of refs, and the rows' ids chosen alike.
  it("two finish_run calls that differ only in an action's summary write the same input_hash, and one that differs in a ref writes another", async () => {
    const run = testId("run");
    const [one1, two1] = [testId("msg"), testId("msg")];
    const [opp0, opp1] = [testId("opp"), testId("opp")];
    // In each database: the two messages under fixed ids, the run, and two propose actions, the
    // first about and citing the first message, the second about the second message and citing
    // `secondRefs`.
    const hashes = (summary: string, secondRefs: (ids: [string, string]) => string[]) =>
      withDatabase(async (db) => {
        const made = await messages(db, 2);
        const ids: [string, string] = [one1, two1];
        for (const [index, message] of made.entries())
          await admin(db, "update knowledge.messages set id = $2 where id = $1", [message.id, ids[index]]);
        const thinker = await reasoner(db, "runs-reasoner");
        await queueRun(db, [], OWN, run);
        await take(db, thinker, run);
        const actions = [
          propose(db, OWN, one1, [one1], { id: opp0, summary }),
          propose(db, OWN, two1, secondRefs(ids), { id: opp1, summary }),
        ];
        expect(await finishRun(db, thinker, run, actions)).toEqual([{ recorded: 2, outcome: "finished" }]);
        const bySubject = new Map((await callsOf(db, run)).map((call) => [call.subject_id, call.input_hash]));
        return [bySubject.get(opp0), bySubject.get(opp1)];
      });
    const [firstA, secondA] = await hashes("one made-up summary", ([a]) => [a]);
    const [firstB, secondB] = await hashes("another made-up summary, longer", ([, b]) => [b]);
    expect(firstA).toMatch(/^[0-9a-f]{64}$/);
    // The same run, attempt, index, kind and refs, a different summary: the same hash.
    expect(firstB).toBe(firstA);
    // The same run, attempt, index and kind, another ref: another hash.
    expect(secondA).toMatch(/^[0-9a-f]{64}$/);
    expect(secondB).not.toBe(secondA);
  });
});

describe("an erasure stops a run in flight", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a run taken before an erasure gets go false at its next step, and its finish_run is answered stopped with the code erasure and writes none of its output", () =>
    withDatabase(async (db) => {
      const m = first(await messages(db, 1));
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, [m]);
      await take(db, thinker, run);
      expect(await appendStep(db, thinker, run, 1, MODEL())).toBe(true);
      await erase(db);
      const state = await runState(db, run);
      const before = await written(db);
      expect(await appendStep(db, thinker, run, 2, TOOL)).toBe(false);
      expect(await written(db)).toEqual(before);
      expect(await runState(db, run)).toEqual(state);

      const proposed = testId("opp");
      const answer = one(await finishRun(db, thinker, run, [propose(db, OWN, m.id, [m.id], { id: proposed })]));
      expect(answer.outcome).toBe("stopped");
      expect(await runState(db, run)).toMatchObject({ event: "stopped", code: "erasure" });
      expect(
        await admin(db, "select id from ledger.opportunities where run_id = $1 or id = $2", [run, proposed]),
      ).toEqual([]);
      expect(await callsOf(db, run)).toEqual([]);
      expect(await admin(db, "select id from ledger.basis where row_id = $1", [proposed])).toEqual([]);
    }));

  it("end_run ends such a run stopped", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      await erase(db);
      expect(await endRun(db, run, "stopped", "erasure")).toBe(true);
      expect(await runState(db, run)).toEqual({
        event: "stopped",
        code: "erasure",
        by: "system:work",
        holder: null,
        lease_until: null,
        steps: 0,
      });
    }));
});

describe("ledger.end_run and ledger.spend_on", { timeout: DB_TEST_TIMEOUT }, () => {
  it("end_run, as pi_work, ends a run failed with its code and drops its lease, and the reader cannot call it", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const run = await queueRun(db, await messages(db, 1));
      await take(db, thinker, run);
      const before = await written(db);
      expect(await sqlState(() => as(db, thinker, "select ledger.end_run($1, 'failed', 'timeout')", [run]))).toBe(
        "42501",
      );
      expect(await written(db)).toEqual(before);
      // The control: the same call as pi_work.
      expect(await endRun(db, run, "failed", "timeout")).toBe(true);
      expect(await runState(db, run)).toEqual({
        event: "failed",
        code: "timeout",
        by: "system:work",
        holder: null,
        lease_until: null,
        steps: 0,
      });
    }));

  it("spend_on is the sum of the day's model call steps' costs, and a tool call adds nothing", () =>
    withDatabase(async (db) => {
      const thinker = await reasoner(db, "runs-reasoner");
      const runs = [await queueRun(db, await messages(db, 1)), await queueRun(db, await messages(db, 1))];
      const [one1, two1] = pair(runs);
      await take(db, thinker, one1);
      await take(db, thinker, two1);
      expect(await appendStep(db, thinker, one1, 1, MODEL(300))).toBe(true);
      expect(await appendStep(db, thinker, one1, 2, TOOL)).toBe(true);
      expect(await appendStep(db, thinker, two1, 1, MODEL(200))).toBe(true);
      expect(await appendStep(db, thinker, two1, 2, TOOL)).toBe(true);
      const today = "select ledger.spend_on((now() at time zone 'utc')::date)::int as spent";
      const yesterday = "select ledger.spend_on((now() at time zone 'utc')::date - 1)::int as spent";
      for (const url of [db.urls.work, db.urls.admin]) {
        expect(await queryAs(url, today)).toEqual([{ spent: 500 }]);
        expect(await queryAs(url, yesterday)).toEqual([{ spent: 0 }]);
      }
    }));
});

describe("a row rests on what its session was given by id", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an opportunity that does not cite a message, written by a client after its session read that message with read_message, is withdrawn and loses its body when the message is deleted", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const client = await agent(db, "runs-agent");
      await readMessage(db, client, client.session, read);
      const after = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id] });
      // The control: another client's opportunity on the same message, in a session that read nothing.
      const other = await agent(db, "runs-agent-other");
      const control = await proposeOpportunity(db, other, { about: cited.id, refs: [cited.id] });
      if (after === null || control === null) throw new Error("a proposal was refused");
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", after)).toEqual(WHOLE_PROPOSED);
      expect(await deleteMessage(db, read)).toBeGreaterThanOrEqual(1);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", after)).toEqual(WITHDRAWN);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", control)).toEqual(WHOLE_PROPOSED);
    }));

  it("the same opportunity written before the read is not", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const client = await agent(db, "runs-agent");
      const before = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id] });
      await pause(5);
      await readMessage(db, client, client.session, read);
      // The positive control: one written after the read, in the same session, is tainted. Another
      // kind, so it is another case and not the first row again.
      const after = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id], kind: "reply" });
      if (before === null || after === null) throw new Error("a proposal was refused");
      await deleteMessage(db, read);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", before)).toEqual(WHOLE_PROPOSED);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", after)).toEqual(WITHDRAWN);
    }));

  it("one written in another session of the same client is not", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const client = await agent(db, "runs-agent");
      const elsewhere = await openWorkSession(db, client.token);
      await readMessage(db, client, client.session, read);
      const other = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id], sessionId: elsewhere });
      // The positive control: the session that read it, on another case.
      const same = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id], kind: "reply" });
      if (other === null || same === null) throw new Error("a proposal was refused");
      await deleteMessage(db, read);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", other)).toEqual(WHOLE_PROPOSED);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", same)).toEqual(WITHDRAWN);
    }));

  it("one whose session was only shown the message, in a list, is not", () =>
    withDatabase(async (db) => {
      const [shown, read, cited] = await messages(db, 3);
      if (shown === undefined || read === undefined || cited === undefined) throw new Error("three messages");
      const client = await agent(db, "runs-agent");
      await showMessage(db, client, client.session, shown);
      const listed = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id] });
      if (listed === null) throw new Error("the proposal was refused");
      await deleteMessage(db, shown);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", listed)).toEqual(WHOLE_PROPOSED);
      // The positive control: the same session given another message by id.
      await readMessage(db, client, client.session, read);
      const bound = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id], kind: "reply" });
      if (bound === null) throw new Error("the proposal was refused");
      await deleteMessage(db, read);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", bound)).toEqual(WITHDRAWN);
    }));

  it("a run's rows written after its attempt's session read the message are tainted", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const thinker = await reasoner(db, "runs-reasoner");
      const reading = await queueRun(db, [cited]);
      const control = await queueRun(db, [cited]);
      const other = await openWorkSession(db, thinker.token);
      await take(db, thinker, reading);
      await take(db, thinker, control, other);
      await readMessage(db, thinker, thinker.session, read);
      const [opportunity, intention, controlOpportunity] = [testId("opp"), testId("itn"), testId("opp")];
      expect(
        await finishRun(db, thinker, reading, [
          propose(db, OWN, cited.id, [cited.id], { id: opportunity }),
          remind(db, OWN, cited.id, [cited.id], intention),
        ]),
      ).toEqual([{ recorded: 2, outcome: "finished" }]);
      // Another kind: every run is one author, so the same kind about the same message would join
      // the first row.
      expect(
        await finishRun(
          db,
          thinker,
          control,
          [propose(db, OWN, cited.id, [cited.id], { id: controlOpportunity, kind: "reply" })],
          { session: other },
        ),
      ).toEqual([{ recorded: 1, outcome: "finished" }]);
      await deleteMessage(db, read);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", opportunity)).toEqual(WITHDRAWN);
      expect(await bodyRow(db, "ledger.intentions", "intention", intention)).toMatchObject({
        tainted: true,
        body: false,
      });
      // A run whose attempt's session never read it keeps its rows.
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", controlOpportunity)).toEqual(WHOLE_PROPOSED);
    }));

  it("a move report's summary event written after its session read the message is tainted", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const client = await agent(db, "runs-agent");
      const intent = await grantWork(db, client);
      const { opportunity, move } = await handedWithReport(db, client, intent, cited.id, [cited.id], [cited.id], () =>
        readMessage(db, client, client.session, read),
      );
      expect(await reportEvent(db, move)).toEqual({ tainted: false, body: true });
      await deleteMessage(db, read);
      expect(await reportEvent(db, move)).toEqual({ tainted: true, body: false });
      // The positive control: the opportunity, proposed in that session before the read, keeps its body.
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", opportunity)).toEqual({
        tainted: false,
        body: true,
        status: "handed_to_owner",
      });
    }));

  it("a second call changes nothing", () =>
    withDatabase(async (db) => {
      const [read, cited] = pair(await messages(db, 2));
      const client = await agent(db, "runs-agent");
      await readMessage(db, client, client.session, read);
      const after = await proposeOpportunity(db, client, { about: cited.id, refs: [cited.id] });
      if (after === null) throw new Error("the proposal was refused");
      expect(await deleteMessage(db, read)).toBeGreaterThanOrEqual(1);
      const before = await written(db);
      expect(await taintAgain(db, read)).toBe(0);
      expect(await written(db)).toEqual(before);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", after)).toEqual(WITHDRAWN);
    }));

  it("a run whose attempt's session read a message that is deleted mid-run is refused by finish_run with not_found, writes none of its rows and stays running", () =>
    withDatabase(async (db) => {
      const [read, cited, other] = await messages(db, 3);
      if (read === undefined || cited === undefined || other === undefined) throw new Error("three messages");
      const thinker = await reasoner(db, "runs-reasoner");
      const reading = await queueRun(db, [cited]);
      const control = await queueRun(db, [cited]);
      const elsewhere = await openWorkSession(db, thinker.token);
      await take(db, thinker, reading);
      await take(db, thinker, control, elsewhere);
      await readMessage(db, thinker, thinker.session, read);
      // The control's session read a message that is not deleted.
      await readMessage(db, thinker, elsewhere, other);
      await deleteMessage(db, read);
      const state = await runState(db, reading);
      const before = await written(db);
      expect(await finishRun(db, thinker, reading, [propose(db, OWN, cited.id, [cited.id])])).toEqual([]);
      expect(await written(db)).toEqual(before);
      expect(await runState(db, reading)).toEqual(state);
      expect(state).toMatchObject({ event: "running", holder: thinker.id });
      // A session that read nothing deleted is not refused.
      expect(
        await finishRun(db, thinker, control, [propose(db, OWN, cited.id, [cited.id])], { session: elsewhere }),
      ).toEqual([{ recorded: 1, outcome: "finished" }]);
      // And the refused run ends the way the loop ends it: failed, bad_output, with no output.
      expect(await finishRun(db, thinker, reading, [], { outcome: "failed", code: "bad_output" })).toEqual([
        { recorded: 0, outcome: "failed" },
      ]);
      expect(await runState(db, reading)).toMatchObject({ event: "failed", code: "bad_output", holder: null });
    }));
});

// ---------------------------------------------------------------------------------------------
// taint_citing's reach into runs, hypotheses and moves
// ---------------------------------------------------------------------------------------------

describe("ledger.taint_citing on this item's tables", { timeout: DB_TEST_TIMEOUT }, () => {
  it("taint_citing taints a run whose anchor is deleted, a hypothesis test whose basis cites a deleted ref, and a move whose report cites it, and a second call changes nothing", () =>
    withDatabase(async (db) => {
      const [gone, kept] = pair(await messages(db, 2));
      const run = await queueRun(db, [gone]);
      const keptRun = await queueRun(db, [kept]);
      const client = await agent(db, "runs-agent");
      const hypothesis = await proposeHypothesis(db, client, kept.id, [kept.id]);
      if (hypothesis === null) throw new Error("the hypothesis was refused");
      const test = await recordTest(db, client, hypothesis, [gone.id]);
      const keptTest = await recordTest(db, client, hypothesis, [kept.id]);
      const intent = await grantWork(db, client);
      const { move } = await handedWithReport(db, client, intent, kept.id, [kept.id], [gone.id]);

      expect(await deleteMessage(db, gone)).toBeGreaterThan(0);
      // Read back as pi_admin.
      expect(await isTainted(db, "ledger.runs", run)).toBe(true);
      expect(await isTainted(db, "ledger.hypothesis_tests", test)).toBe(true);
      expect(await isTainted(db, "ledger.moves", move)).toBe(true);
      // The controls: what cites the message that stays.
      expect(await isTainted(db, "ledger.runs", keptRun)).toBe(false);
      expect(await isTainted(db, "ledger.hypothesis_tests", keptTest)).toBe(false);

      const before = await written(db);
      expect(await taintAgain(db, gone)).toBe(0);
      expect(await written(db)).toEqual(before);
    }));

  it("taint_citing withdraws an open opportunity and an open hypothesis that cite the ref, a handed one included, clears their bodies and their reports' bodies, drops the lease, cancels their intentions, and ends a queued run whose anchor it was as stopped with the code withdrawn", () =>
    withDatabase(async (db) => {
      const [gone, kept, third] = await messages(db, 3);
      if (gone === undefined || kept === undefined || third === undefined) throw new Error("three messages");
      const client = await agent(db, "runs-agent");
      const intent = await grantWork(db, client);
      // Each row about something of its own, so each is a case of its own.
      const hypothesis = await proposeHypothesis(db, client, kept.id, [gone.id]);
      const keptHypothesis = await proposeHypothesis(db, client, third.id, [kept.id]);
      if (hypothesis === null || keptHypothesis === null) throw new Error("a hypothesis was refused");
      // Claimed, with a check-back set.
      const claimed = await claimedOpportunity(db, client, intent, kept.id, [gone.id]);
      const checkBack = one(
        await as<{ id: string | null }>(
          db,
          client,
          "select ledger.set_intention($1, $2, $3, $4, $5::timestamptz, false, false) as id",
          [testId("itn"), req(), client.session, claimed, hoursAhead(3)],
        ),
      ).id;
      if (checkBack === null) throw new Error("the check-back was refused");
      expect(await leases(db, "opportunity", claimed)).toBe(1);
      // Handed to the owner, with a report that carries a summary.
      const { opportunity: handed, move } = await handedWithReport(db, client, intent, third.id, [gone.id], [kept.id]);
      const queued = await queueRun(db, [gone]);
      const keptQueued = await queueRun(db, [kept]);

      await deleteMessage(db, gone);
      expect(await bodyRow(db, "ledger.hypotheses", "hypothesis", hypothesis)).toEqual(WITHDRAWN);
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", claimed)).toEqual(WITHDRAWN);
      expect(await leases(db, "opportunity", claimed)).toBe(0);
      expect((await bodyRow(db, "ledger.intentions", "intention", checkBack)).status).toBe("cancelled");
      expect(await bodyRow(db, "ledger.opportunities", "opportunity", handed)).toEqual(WITHDRAWN);
      expect(await reportEvent(db, move)).toEqual({ tainted: true, body: false });
      expect(await runState(db, queued)).toMatchObject({ event: "stopped", code: "withdrawn" });
      // The controls: what cites only the message that stays, whatever it is about.
      expect(await bodyRow(db, "ledger.hypotheses", "hypothesis", keptHypothesis)).toEqual({
        tainted: false,
        body: true,
        status: "open",
      });
      expect((await runState(db, keptQueued)).event).toBe("queued");
    }));
});
