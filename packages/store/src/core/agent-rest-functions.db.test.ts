import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ALL_VIEWS, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import {
  ownerCommitted as asTableOwner,
  recordLabelOf as labelOf,
  one,
  readAs,
  refusal,
  session,
  openSession as sessionOf,
  sqlState,
} from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { memoryClient, seedBeliefs, served, supportsOf, valuesOf } from "../test-support/memory-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Each function is called directly in SQL as its role, with a token set where it takes one, to show
// what the role can do without the store's code. Every refusal has its positive control in the same
// test.

const TIMEOUT = 180_000;
const COMPARTMENTS = ["own", "employer:example", "agent:alpha", "agent:beta", "agent:gamma"];
const FP = "c".repeat(64);
const CITES_FP = "b".repeat(64);
const BODY = { v: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
const TAINT = "hashtext('intelligence personal ledger taint')";
const TOOLS = ["search", "record", "propose_about_you", "import_memory"];
const AT = "2026-09-01T00:00:00Z";

const APPEND = "select outcome, record_id from policy.append_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";
const PROPOSE = "select outcome, record_id from policy.propose_about_you($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";
const IMPORT = "select outcome, received from policy.import_memory($1, $2::jsonb, $3)";

type Client = TestClient & { views: string[] };
type Outcome = { outcome: string; record_id: string | null };
type Imported = { outcome: string; received: number | null };

const withRest = <T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> =>
  withDatabase(fn, { compartments: COMPARTMENTS });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// A client of kind agent that holds the agent-lane tools and its own agent compartment.
async function agent(
  db: TestDatabase,
  name: string,
  clearance: string[] = ["own"],
  tools: string[] = TOOLS,
): Promise<Client> {
  const compartments = [...clearance, `agent:${name}`];
  const client = { id: testId("cli"), name, token: `pit_test-${name}-${testId("x")}`, compartments, views: ALL_VIEWS };
  await admin(
    db,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [client.id, name, sha256Hex(client.token), compartments, ALL_VIEWS, tools],
  );
  return client;
}

const logRead = (
  db: TestDatabase,
  client: Client,
  sessionId: string,
  bound: string[],
  factKeyFps: string[] = [],
): Promise<unknown> =>
  readAs(db, client.token, (query) =>
    query("select policy.log_read($1, 'search', $2, '{}', $3)", [sessionId, bound, factKeyFps]),
  );

let serial = 0;
const request = (): string => {
  serial += 1;
  return `request-${String(serial).padStart(10, "0")}`;
};

type Proposal = {
  session: string;
  label: string[];
  id?: string;
  request?: string;
  scope?: string;
  content?: string;
  cites?: string[];
  stamps?: string[];
  body?: unknown;
};
const proposeArgs = (p: Proposal): unknown[] => [
  p.session,
  p.id ?? testId("rec"),
  p.request ?? request(),
  p.scope ?? "all",
  p.content ?? FP,
  CITES_FP,
  p.cites ?? [],
  p.stamps ?? [],
  p.label,
  p.body ?? BODY,
];
const propose = (db: TestDatabase, client: Client, p: Proposal): Promise<Outcome> =>
  readAs(db, client.token, async (query) => one(await query<Outcome>(PROPOSE, proposeArgs(p))));

type Record_ = {
  session: string;
  label: string[];
  id?: string;
  request?: string;
  kind?: string;
  cites?: string[];
  stamps?: string[];
};
const appendArgs = (r: Record_): unknown[] => [
  r.session,
  r.id ?? testId("rec"),
  r.request ?? request(),
  r.kind ?? "note",
  FP,
  CITES_FP,
  r.cites ?? [],
  r.label,
  BODY,
  r.stamps ?? [],
];
const append = (db: TestDatabase, client: Client, r: Record_): Promise<Outcome> =>
  readAs(db, client.token, async (query) => one(await query<Outcome>(APPEND, appendArgs(r))));

// One memory change as the store hands it to policy.import_memory: an added one carries its new
// record id, its fingerprints and its sealed body; a removed one carries none of them.
type Change = {
  request_id: string;
  locator_fp: string;
  change: "added" | "removed";
  entry_time: string | null;
  record_id?: string;
  content_fp?: string;
  cites_fp?: string;
  body_enc?: unknown;
  stamps: string[];
  line_fps: string[];
};
const added = (over: Partial<Change> = {}): Change => ({
  request_id: request(),
  locator_fp: randomBytes(32).toString("hex"),
  change: "added",
  entry_time: null,
  record_id: testId("rec"),
  content_fp: randomBytes(32).toString("hex"),
  cites_fp: CITES_FP,
  body_enc: BODY,
  stamps: [],
  line_fps: [],
  ...over,
});
const removedChange = (over: Partial<Change> = {}): Change => ({
  request_id: request(),
  locator_fp: randomBytes(32).toString("hex"),
  change: "removed",
  entry_time: null,
  stamps: [],
  line_fps: [],
  ...over,
});
const importMemory = (
  db: TestDatabase,
  client: Client,
  sessionId: string,
  changes: Change[],
  label: string[],
): Promise<Imported> =>
  readAs(db, client.token, async (query) =>
    one(await query<Imported>(IMPORT, [sessionId, JSON.stringify(changes), label])),
  );

type ImportRow = {
  request_id: string;
  record_id: string | null;
  change: string;
  mark: string;
  matched_projection_ids: string[];
  entry_time: Date | null;
  created_at: Date;
  compartments: string[];
};
const importsOf = (db: TestDatabase, client: Client): Promise<ImportRow[]> =>
  admin<ImportRow>(
    db,
    "select request_id, record_id, change, mark, matched_projection_ids, entry_time, created_at, compartments from ledger.memory_imports where client_id = $1 order by id",
    [client.id],
  );
const writesOf = async (db: TestDatabase, client: Client, kind?: string): Promise<number> =>
  one(
    await admin<{ n: number }>(
      db,
      "select count(*)::int as n from ledger.agent_writes where client_id = $1 and ($2::text is null or kind = $2)",
      [client.id, kind ?? null],
    ),
  ).n;

// An evidence row of `own`, as the seeder makes one.
const evidence = (db: TestDatabase): Promise<string> => session(db.urls.admin, (query) => seeder(db, query).evidence());

// One projection row of a client, as policy.serve_memory leaves it, with its line fingerprint.
type ProjectionState = "live" | "ended" | "tainted";
async function projection(
  db: TestDatabase,
  client: Client,
  state: ProjectionState,
  options: { line?: string; fact?: string; servedAt?: string } = {},
): Promise<string> {
  const id = `mpr_${randomBytes(20).toString("hex")}`;
  const at = options.servedAt ?? new Date().toISOString();
  await asTableOwner(db, (query) =>
    query(
      `insert into ledger.memory_projections (id, client_id, audience, template, fact_key_fp, state_fp, evidence_ids, compartments, first_served_at, last_served_at,
         ended_at, reason, tainted_at, line_fp)
       values ($1, $2, '{own}', 'active_memory@1', $3, $3, '{}', '{own}', $4, $4, $5, $6, $7, $8)`,
      [
        id,
        client.id,
        options.fact ?? FP,
        at,
        state === "live" ? null : at,
        state === "live" ? null : "withdrawn",
        state === "tainted" ? at : null,
        options.line ?? null,
      ],
    ),
  );
  return id;
}

// Rows written as pi_owner to fill a client's last 24 hours: `count` agent records of a kind, or
// `count` import rows with no record.
async function filled(db: TestDatabase, client: Client, sessionId: string, kind: string, count: number): Promise<void> {
  const tool = kind === "proposal" ? "propose_about_you" : kind === "memory_change" ? "import_memory" : "record";
  const prefix = randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .replace(/[^0-9A-F]/g, "0");
  await asTableOwner(db, (query) =>
    query(
      `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc, proposal_scope)
       select 'rec_' || $8 || lpad(g::text, 18, '0'), $1, $2, $3, 'filled-' || $8 || '-' || g, $4, $5, $6, $7, $9, $9, '{}', $10, case when $5 = 'proposal' then 'all' end
       from generate_series(1, $11) as g`,
      [
        client.id,
        client.name,
        sessionId,
        tool,
        kind,
        client.compartments.slice().sort(),
        ALL_VIEWS,
        prefix,
        FP,
        BODY,
        count,
      ],
    ),
  );
}
async function filledImports(db: TestDatabase, client: Client, count: number): Promise<void> {
  const prefix = randomBytes(4).toString("hex");
  await asTableOwner(db, (query) =>
    query(
      `insert into ledger.memory_imports (client_id, request_id, record_id, locator_fp, change, mark, matched_projection_ids, entry_time, created_at, compartments)
       select $1, 'filled-' || $2 || '-' || g, null, $3, 'removed', 'new', '{}', null, now(), $4 from generate_series(1, $5) as g`,
      [client.id, prefix, FP, client.compartments.slice().sort(), count],
    ),
  );
}

// A card as raiseCard writes one, with its first event, written as pi_admin.
async function card(
  db: TestDatabase,
  options: {
    kind: string;
    requestId: string;
    targetKind?: string;
    targetId?: string;
    author?: string;
    caseKey?: string;
    compartments?: string[];
  },
): Promise<string> {
  const id = testId("crd");
  const author = options.author ?? "system:extract";
  await admin(
    db,
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
     values ($1, $2, $3, $4, $5, $6, $7, '{confirm,reject}', 30, $8, $9)`,
    [
      id,
      options.requestId,
      AT,
      author,
      options.kind,
      options.targetKind ?? "claim",
      options.targetId ?? options.requestId,
      options.caseKey ?? null,
      options.compartments ?? ["agent:alpha", "own"],
    ],
  );
  await admin(
    db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, $3, $4)",
    [id, AT, author, options.compartments ?? ["agent:alpha", "own"]],
  );
  return id;
}

// The owner's reply to a card, as decide writes it, at `at`: by default a time after every row
// a test writes, so it is never before a mark whatever the clocks of the test and the server say.
async function answer(
  db: TestDatabase,
  cardId: string,
  value: "confirm" | "reject",
  options: { at?: string; supersedes?: string; tainted?: boolean } = {},
): Promise<string> {
  const id = testId("rul");
  await admin(
    db,
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, supersedes, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'answer', 'card', $3, $4, $3, $5, 0, '{}', '{}', $6, '{own}')`,
    [id, testId("req").slice(4), cardId, value, options.supersedes ?? null, options.at ?? "2030-01-01T00:00:00Z"],
  );
  if (options.tainted === true)
    await asTableOwner(db, (query) =>
      query("update knowledge.owner_decisions set tainted_at = now() where id = $1", [id]),
    );
  return id;
}

// A connection of pi_reader, in a transaction of the isolation given, under the client's token.
async function opened(db: TestDatabase, client: Client, isolation: string): Promise<pg.Client> {
  const connection = new pg.Client({ connectionString: db.urls.reader });
  await connection.connect();
  await connection.query(`begin isolation level ${isolation}`);
  await connection.query("select set_config('pi.client_token', $1, true)", [client.token]);
  return connection;
}

const asPipeline = <Row = Record<string, unknown>>(
  db: TestDatabase,
  text: string,
  values?: unknown[],
): Promise<Row[]> => queryAs<Row>(db.urls.pipeline, text, values);

// One agent record of the client taken in: its row with an evidence id, as intake leaves it.
async function takenIn(
  db: TestDatabase,
  client: Client,
  sessionId: string,
  createdAt: string,
  options: { kind?: string; scope?: string } = {},
): Promise<{ id: string; evidence: string }> {
  const id = testId("rec");
  const evidenceId = randomBytes(32).toString("hex");
  const kind = options.kind ?? "finding";
  await asTableOwner(db, (query) =>
    query(
      `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, created_at, compartments, writer_views, content_fp, cites_fp, cites, body_enc, evidence_id, proposal_scope)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, '{}', $12, $13, $14)`,
      [
        id,
        client.id,
        client.name,
        sessionId,
        request(),
        kind === "proposal" ? "propose_about_you" : "record",
        kind,
        createdAt,
        client.compartments.slice().sort(),
        ALL_VIEWS,
        FP,
        BODY,
        evidenceId,
        kind === "proposal" ? (options.scope ?? "all") : null,
      ],
    ),
  );
  return { id, evidence: evidenceId };
}

// A read log row at a time of the test's choosing, as policy.log_read writes one.
const readAt = (
  db: TestDatabase,
  client: Client,
  sessionId: string,
  at: string,
  bound: string[],
  factKeyFps: string[],
): Promise<unknown> =>
  asTableOwner(db, (query) =>
    query(
      "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'read_message', $3, $4, $5, '{}', $6)",
      [sessionId, client.id, at, client.compartments.slice().sort(), bound, factKeyFps],
    ),
  );

const CHECK = "select answer, cleared from ledger.check_restatement($1, $2, $3, $4, $5, $6)";
const check = async (
  db: TestDatabase,
  key: string,
  evidenceId: string,
  answer: string,
  reached: string | null,
  matched: string | null,
): Promise<{ answer: string; cleared: boolean }> =>
  one(
    await asPipeline<{ answer: string; cleared: boolean }>(db, CHECK, [key, evidenceId, answer, reached, matched, 1]),
  );
const key = (n: number | string): string => sha256Hex(`claim key ${n}`);

// An owner's decision with no card, as pi restatements clear writes one, to name in cleared_by.
async function ownerDecision(db: TestDatabase): Promise<string> {
  const id = testId("rul");
  await admin(
    db,
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'restatement_clear', 0, '{}', '{}', now(), '{own}')`,
    [id, testId("req").slice(4)],
  );
  return id;
}

describe("NNNN: R1 on the two new writing functions", { timeout: TIMEOUT }, () => {
  it("propose_about_you and import_memory take the shared taint lock first and refuse a transaction that is not read committed", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const label = await labelOf(db, alpha);
      const calls: [string, () => [string, unknown[]]][] = [
        ["propose_about_you", () => [PROPOSE, proposeArgs({ session: sessionId, label })]],
        ["import_memory", () => [IMPORT, [sessionId, JSON.stringify([added()]), label]]],
      ];
      for (const [name, call] of calls) {
        // A deletion's taint, as ledger.taint_citing takes it, held by another connection.
        const deletion = new pg.Client({ connectionString: db.urls.admin });
        await deletion.connect();
        try {
          await deletion.query("begin");
          await deletion.query(`select pg_advisory_xact_lock(${TAINT})`);
          let settled = false;
          const [sql, values] = call();
          const waiting = readAs(db, alpha.token, (query) => query<{ outcome: string }>(sql, values)).finally(() => {
            settled = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(settled, name).toBe(false);
          await deletion.query("commit");
          expect(one(await waiting).outcome, name).toBe("ok");
        } finally {
          await deletion.end();
        }
        for (const isolation of ["repeatable read", "serializable"]) {
          const connection = await opened(db, alpha, isolation);
          try {
            const [sql, values] = call();
            expect(await sqlState(() => connection.query(sql, values)), `${name} ${isolation}`).toBe("42501");
          } finally {
            await connection.query("rollback");
            await connection.end();
          }
        }
        // The control: the same call read committed, set explicitly, is taken.
        const connection = await opened(db, alpha, "read committed");
        try {
          const [sql, values] = call();
          expect((await connection.query<{ outcome: string }>(sql, values)).rows[0]?.outcome, name).toBe("ok");
          await connection.query("commit");
        } finally {
          await connection.end();
        }
      }
      expect(await writesOf(db, alpha, "proposal")).toBe(2);
      expect(await writesOf(db, alpha, "memory_change")).toBe(2);
    }));

  it("each refuses no current client, a client without its tool and a session of another client with 42501, and writes nothing", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const beta = await agent(db, "beta");
      const bare = await agent(db, "gamma", ["own"], ["search", "record"]);
      const label = await labelOf(db, alpha);
      const own = await sessionOf(db, alpha);
      const betas = await sessionOf(db, beta);
      const bares = await sessionOf(db, bare);
      const bareLabel = await labelOf(db, bare);
      const proposeAs = (token: string | null, values: unknown[]) =>
        sqlState(() => readAs(db, token, (query) => query(PROPOSE, values)));
      const importAs = (token: string | null, values: unknown[]) =>
        sqlState(() => readAs(db, token, (query) => query(IMPORT, values)));
      for (const token of [null, "pit_test-unknown"]) {
        expect(await proposeAs(token, proposeArgs({ session: own, label })), String(token)).toBe("42501");
        expect(await importAs(token, [own, JSON.stringify([added()]), label]), String(token)).toBe("42501");
      }
      // A client without the tools: no memory change is written by a client not given
      // import_memory.
      expect(await proposeAs(bare.token, proposeArgs({ session: bares, label: bareLabel }))).toBe("42501");
      expect(await importAs(bare.token, [bares, JSON.stringify([added()]), bareLabel])).toBe("42501");
      expect(await proposeAs(alpha.token, proposeArgs({ session: betas, label }))).toBe("42501");
      expect(await importAs(alpha.token, [betas, JSON.stringify([added()]), label])).toBe("42501");
      expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.agent_writes")).n).toBe(0);
      expect(one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.memory_imports")).n).toBe(0);
      // The control: the client's own session, with the tools.
      expect((await propose(db, alpha, { session: own, label })).outcome).toBe("ok");
      expect((await importMemory(db, alpha, own, [added()], label)).outcome).toBe("ok");
    }));
});

describe("NNNN: R16, the quotas by kind", { timeout: TIMEOUT }, () => {
  it("500 memory changes in a day leave record's 200 untouched, and 200 records leave import_memory's 500 untouched", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const beta = await agent(db, "beta");
      const label = await labelOf(db, alpha);
      const betaLabel = await labelOf(db, beta);
      const alphas = await sessionOf(db, alpha);
      const betas = await sessionOf(db, beta);

      // 500 memory changes: record is still taken, and the 501st change is rate_limited.
      await filled(db, alpha, alphas, "memory_change", 500);
      await filledImports(db, alpha, 500);
      expect((await append(db, alpha, { session: alphas, label })).outcome).toBe("ok");
      expect(await importMemory(db, alpha, alphas, [added()], label)).toEqual({
        outcome: "rate_limited",
        received: null,
      });
      expect(await writesOf(db, alpha, "memory_change")).toBe(500);

      // 200 records: import_memory is still taken, and the 201st record is rate_limited.
      await filled(db, beta, betas, "note", 200);
      expect(await importMemory(db, beta, betas, [added(), added()], betaLabel)).toEqual({
        outcome: "ok",
        received: 2,
      });
      expect(await append(db, beta, { session: betas, label: betaLabel })).toEqual({
        outcome: "rate_limited",
        record_id: null,
      });
      expect(await writesOf(db, beta, "note")).toBe(200);
    }));

  it("the change that would be the 501st of a day is rate_limited, and the call writes nothing", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      await filledImports(db, alpha, 499);
      // Two changes would make 501: the call is refused whole.
      expect(await importMemory(db, alpha, sessionId, [added(), added()], label)).toEqual({
        outcome: "rate_limited",
        received: null,
      });
      expect(await importsOf(db, alpha)).toHaveLength(499);
      // The control: one makes 500.
      expect(await importMemory(db, alpha, sessionId, [added()], label)).toEqual({ outcome: "ok", received: 1 });
      expect(await importsOf(db, alpha)).toHaveLength(500);
    }));

  it("the 201st proposal of a day is rate_limited, and proposals count toward the 200", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      await filled(db, alpha, sessionId, "proposal", 199);
      expect((await propose(db, alpha, { session: sessionId, label })).outcome).toBe("ok");
      expect(await propose(db, alpha, { session: sessionId, label })).toEqual({
        outcome: "rate_limited",
        record_id: null,
      });
      expect(await writesOf(db, alpha, "proposal")).toBe(200);
      // The 200 proposals use the day's 200 writes: record is refused too.
      expect(await append(db, alpha, { session: sessionId, label })).toEqual({
        outcome: "rate_limited",
        record_id: null,
      });
    }));

  it("proposals count toward the 200: 20 proposals and 180 notes refuse a record and a proposal", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      await filled(db, alpha, sessionId, "proposal", 20);
      expect((await append(db, alpha, { session: sessionId, label })).outcome).toBe("ok");
      await filled(db, alpha, sessionId, "note", 179);
      expect(await append(db, alpha, { session: sessionId, label })).toEqual({
        outcome: "rate_limited",
        record_id: null,
      });
      expect(await propose(db, alpha, { session: sessionId, label })).toEqual({
        outcome: "rate_limited",
        record_id: null,
      });
    }));
});

describe("NNNN: policy.propose_about_you", { timeout: TIMEOUT }, () => {
  it("it writes one agent record of kind proposal, tool propose_about_you, under record_label(), with its scope, and nothing it was not given", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const cited = await evidence(db);
      const id = testId("rec");
      expect(await propose(db, alpha, { session: sessionId, label, id, scope: "this_client", cites: [cited] })).toEqual(
        { outcome: "ok", record_id: id },
      );
      expect(
        await admin(
          db,
          "select client_id, session_id, tool, kind, proposal_scope, compartments, cites, turn_id from ledger.agent_writes where id = $1",
          [id],
        ),
      ).toEqual([
        {
          client_id: alpha.id,
          session_id: sessionId,
          tool: "propose_about_you",
          kind: "proposal",
          proposal_scope: "this_client",
          compartments: label,
          cites: [cited],
          turn_id: null,
        },
      ]);
    }));

  it("a request id used before answers its first record, and a different proposal under it is request_reused", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const id = testId("rec");
      const used = request();
      expect(await propose(db, alpha, { session: sessionId, label, id, request: used })).toEqual({
        outcome: "ok",
        record_id: id,
      });
      expect(await propose(db, alpha, { session: sessionId, label, request: used })).toEqual({
        outcome: "replayed",
        record_id: id,
      });
      expect(await propose(db, alpha, { session: sessionId, label, request: used, content: "d".repeat(64) })).toEqual({
        outcome: "request_reused",
        record_id: null,
      });
      // A record's request id is not a proposal's.
      const recorded = request();
      expect((await append(db, alpha, { session: sessionId, label, request: recorded })).outcome).toBe("ok");
      expect(await propose(db, alpha, { session: sessionId, label, request: recorded })).toEqual({
        outcome: "request_reused",
        record_id: null,
      });
      expect(await writesOf(db, alpha, "proposal")).toBe(1);
    }));

  it("a scope other than all and this_client is refused, and a body that is not an envelope is body_refused", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      expect(await sqlState(() => propose(db, alpha, { session: sessionId, label, scope: "everyone" }))).toBe("23514");
      expect(await propose(db, alpha, { session: sessionId, label, body: { v: 1, text: "plain" } })).toEqual({
        outcome: "body_refused",
        record_id: null,
      });
      expect(await writesOf(db, alpha)).toBe(0);
      for (const scope of ["all", "this_client"])
        expect((await propose(db, alpha, { session: sessionId, label, scope })).outcome, scope).toBe("ok");
    }));

  it("a cite or a bound read of its session that names no evidence row answers not_found; R3: so does a stamp of the client's tainted projection", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const beta = await agent(db, "beta");
      const label = await labelOf(db, alpha);
      const present = await evidence(db);
      const gone = "f".repeat(64);
      const citing = await sessionOf(db, alpha);
      expect(await propose(db, alpha, { session: citing, label, cites: [present, gone] })).toEqual({
        outcome: "not_found",
        record_id: null,
      });
      const reading = await sessionOf(db, alpha);
      await logRead(db, alpha, reading, [gone]);
      expect(await propose(db, alpha, { session: reading, label })).toEqual({ outcome: "not_found", record_id: null });
      const stamping = await sessionOf(db, alpha);
      const tainted = await projection(db, alpha, "tainted");
      const live = await projection(db, alpha, "live");
      const betas = await projection(db, beta, "tainted");
      expect(await propose(db, alpha, { session: stamping, label, stamps: [live, tainted] })).toEqual({
        outcome: "not_found",
        record_id: null,
      });
      expect(await writesOf(db, alpha)).toBe(0);
      // The controls: present cites, its own live projection, another client's tainted one.
      expect((await propose(db, alpha, { session: citing, label, cites: [present] })).outcome).toBe("ok");
      for (const stamps of [[live], [betas], [`mpr_${"0".repeat(40)}`]])
        expect((await propose(db, alpha, { session: stamping, label, stamps })).outcome, stamps.join()).toBe("ok");
    }));
});

describe("NNNN: policy.import_memory", { timeout: TIMEOUT }, () => {
  it("import_memory marks refused, echo, stale and new as the matched projections' states say, and keeps every matched id", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const line = (n: number): string => Buffer.from(`line ${n}`.padEnd(32, "."), "utf8").toString("hex");
      const live = await projection(db, alpha, "live", { line: line(1) });
      const ended = await projection(db, alpha, "ended", { line: line(2) });
      const ended2 = await projection(db, alpha, "ended", { line: line(3) });
      const tainted = await projection(db, alpha, "tainted", { line: line(4) });
      const changes = [
        added({ stamps: [live] }),
        added({ line_fps: [line(2)] }),
        added({ stamps: [ended], line_fps: [line(3)] }),
        added({ stamps: [live, ended] }),
        added({ stamps: [live], line_fps: [line(4)] }),
        added({}),
      ];
      expect(await importMemory(db, alpha, sessionId, changes, label)).toEqual({ outcome: "ok", received: 6 });
      const rows = await importsOf(db, alpha);
      expect(
        rows.map((row) => ({ request: row.request_id, mark: row.mark, matched: row.matched_projection_ids })),
      ).toEqual([
        { request: changes[0]?.request_id, mark: "echo", matched: [live] },
        { request: changes[1]?.request_id, mark: "stale", matched: [ended] },
        { request: changes[2]?.request_id, mark: "stale", matched: [ended, ended2].sort() },
        { request: changes[3]?.request_id, mark: "echo", matched: [live, ended].sort() },
        { request: changes[4]?.request_id, mark: "refused", matched: [live, tainted].sort() },
        { request: changes[5]?.request_id, mark: "new", matched: [] },
      ]);
      // A stored change has its agent record; the refused one has none, and no row of agent_writes.
      expect(rows.map((row) => row.record_id)).toEqual([
        ...changes.slice(0, 4).map((one) => one.record_id),
        null,
        changes[5]?.record_id,
      ]);
      expect(await admin(db, "select id from ledger.agent_writes where id = $1", [changes[4]?.record_id])).toEqual([]);
      expect(
        await admin(db, "select tool, kind, cites, compartments from ledger.agent_writes where id = $1", [
          changes[0]?.record_id,
        ]),
      ).toEqual([{ tool: "import_memory", kind: "memory_change", cites: [], compartments: label }]);
    }));

  it("an import with a line of the client's tainted projection is refused; another client's, and an unknown fingerprint, refuse nothing", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const beta = await agent(db, "beta");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const own = "1".repeat(64);
      const others = "2".repeat(64);
      const tainted = await projection(db, alpha, "tainted", { line: own });
      await projection(db, beta, "tainted", { line: others });
      const betaStamp = await projection(db, beta, "tainted");
      const refused = added({ line_fps: [own] });
      const stamped = added({ stamps: [tainted] });
      const controls = [
        added({ line_fps: [others] }),
        added({ line_fps: ["3".repeat(64)] }),
        added({ stamps: [betaStamp] }),
        added({ stamps: [`mpr_${"0".repeat(40)}`] }),
      ];
      expect(await importMemory(db, alpha, sessionId, [refused, stamped, ...controls], label)).toEqual({
        outcome: "ok",
        received: 6,
      });
      expect((await importsOf(db, alpha)).map((row) => row.mark)).toEqual([
        "refused",
        "refused",
        "new",
        "new",
        "new",
        "new",
      ]);
      expect(await writesOf(db, alpha, "memory_change")).toBe(4);
      // Another client's projections are matched to nothing: no id of theirs is kept.
      expect((await importsOf(db, alpha)).flatMap((row) => row.matched_projection_ids)).toEqual([tainted, tainted]);
    }));

  it("the answer is the number of changes whatever their marks, and a replayed request writes nothing more", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const tainted = await projection(db, alpha, "tainted");
      const stored = added();
      const refused = added({ stamps: [tainted] });
      expect(await importMemory(db, alpha, sessionId, [stored], label)).toEqual({ outcome: "ok", received: 1 });
      expect(await importMemory(db, alpha, sessionId, [refused], label)).toEqual({ outcome: "ok", received: 1 });
      const before = await importsOf(db, alpha);
      // Each again, and both together: the same answer, and no row more.
      expect(await importMemory(db, alpha, sessionId, [stored], label)).toEqual({ outcome: "ok", received: 1 });
      expect(await importMemory(db, alpha, sessionId, [refused], label)).toEqual({ outcome: "ok", received: 1 });
      expect(await importMemory(db, alpha, sessionId, [stored, refused], label)).toEqual({
        outcome: "ok",
        received: 2,
      });
      expect(await importsOf(db, alpha)).toEqual(before);
      expect(await writesOf(db, alpha, "memory_change")).toBe(1);
      // A request id the client used on record or propose_about_you is no change's: the same
      // answer, and nothing written for it.
      const recorded = request();
      const proposed = request();
      expect((await append(db, alpha, { session: sessionId, label, request: recorded })).outcome).toBe("ok");
      expect((await propose(db, alpha, { session: sessionId, label, request: proposed })).outcome).toBe("ok");
      expect(
        await importMemory(
          db,
          alpha,
          sessionId,
          [added({ request_id: recorded }), added({ request_id: proposed }), added()],
          label,
        ),
      ).toEqual({ outcome: "ok", received: 3 });
      expect(await importsOf(db, alpha)).toHaveLength(before.length + 1);
      expect(await writesOf(db, alpha, "memory_change")).toBe(2);
    }));

  it("every change from a session that read an item since deleted is refused", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const reading = await sessionOf(db, alpha);
      const read = await evidence(db);
      await logRead(db, alpha, reading, [read]);
      await queryAs(db.urls.writer, "delete from vault.evidence_items where id = $1", [read]);
      expect(await importMemory(db, alpha, reading, [added(), removedChange()], label)).toEqual({
        outcome: "ok",
        received: 2,
      });
      expect((await importsOf(db, alpha)).map((row) => row.mark)).toEqual(["refused", "refused"]);
      expect(await writesOf(db, alpha)).toBe(0);
      // The control: another session of the client, which read nothing gone.
      const other = await sessionOf(db, alpha);
      expect(await importMemory(db, alpha, other, [added()], label)).toEqual({ outcome: "ok", received: 1 });
      expect(await writesOf(db, alpha, "memory_change")).toBe(1);
    }));

  it("a removed change writes one import row and no agent record, and an entry time after the receipt is kept as the receipt", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const later = added({ entry_time: "2099-01-01T00:00:00Z" });
      const earlier = added({ entry_time: "2026-01-02T03:04:05Z" });
      expect(await importMemory(db, alpha, sessionId, [removedChange(), later, earlier], label)).toEqual({
        outcome: "ok",
        received: 3,
      });
      const [gone, kept, old] = await importsOf(db, alpha);
      expect({ record: gone?.record_id, change: gone?.change, mark: gone?.mark }).toEqual({
        record: null,
        change: "removed",
        mark: "new",
      });
      expect(kept?.entry_time?.getTime()).toBe(kept?.created_at.getTime());
      expect(old?.entry_time?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      expect(await writesOf(db, alpha)).toBe(2);
      expect(
        (await importsOf(db, alpha)).every((row) => JSON.stringify(row.compartments) === JSON.stringify(label)),
      ).toBe(true);
    }));

  it("a change off its form refuses the whole call 23514 and writes nothing", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      const cases: [string, unknown][] = [
        ["no change", []],
        ["51 changes", Array.from({ length: 51 }, () => added())],
        ["not an array", { changes: [added()] }],
        ["a request id off its form", [added({ request_id: "short" })]],
        [
          "one request id twice",
          (() => {
            const twice = added();
            return [twice, { ...added(), request_id: twice.request_id }];
          })(),
        ],
        ["a locator that is not a fingerprint", [added({ locator_fp: "z".repeat(64) })]],
        ["a change of another kind", [{ ...added(), change: "edited" }]],
        ["an added change with no record id", [{ ...added(), record_id: undefined }]],
        ["a removed change with a body", [{ ...removedChange(), body_enc: BODY }]],
        ["a removed change with a stamp", [removedChange({ stamps: [`mpr_${"0".repeat(40)}`] })]],
        ["a stamp off its form", [added({ stamps: ["mpr_1"] })]],
        ["a line fingerprint off its form", [added({ line_fps: ["A".repeat(64)] })]],
        ["a key the function does not take", [{ ...added(), compartments: ["own"] }]],
        ["an entry time that is not a timestamp", [added({ entry_time: "not-a-date" })]],
        ["an entry time with no zone", [added({ entry_time: "2026-01-02T03:04:05" })]],
        ["an entry time that is a word Postgres takes", [added({ entry_time: "-infinity" })]],
        [
          "one record id twice",
          (() => {
            const twice = added();
            return [twice, { ...added(), record_id: twice.record_id }];
          })(),
        ],
      ];
      for (const [name, changes] of cases) {
        const state = await sqlState(() =>
          readAs(db, alpha.token, (query) => query(IMPORT, [sessionId, JSON.stringify(changes), label])),
        );
        expect(state, name).toBe("23514");
      }
      expect(await importsOf(db, alpha)).toEqual([]);
      expect(await writesOf(db, alpha)).toBe(0);
      // The control: one well-formed change.
      expect(await importMemory(db, alpha, sessionId, [added()], label)).toEqual({ outcome: "ok", received: 1 });
    }));
});

describe("NNNN: R51, labels", { timeout: TIMEOUT }, () => {
  it("every new writing function refuses a label other than record_label()", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha", ["own", "employer:example"]);
      const label = await labelOf(db, alpha);
      const sessionId = await sessionOf(db, alpha);
      // Narrower, wider, out of order, and another client's.
      for (const other of [
        ["agent:alpha", "own"],
        [...label, "agent:beta"],
        [...label].reverse(),
        ["agent:beta", "employer:example", "own"],
      ]) {
        expect(await propose(db, alpha, { session: sessionId, label: other }), other.join()).toEqual({
          outcome: "label_mismatch",
          record_id: null,
        });
        expect(await importMemory(db, alpha, sessionId, [added()], other), other.join()).toEqual({
          outcome: "label_mismatch",
          received: null,
        });
      }
      expect(await writesOf(db, alpha)).toBe(0);
      expect(await importsOf(db, alpha)).toEqual([]);
      // The control: record_label() itself, and every row written carries it.
      expect((await propose(db, alpha, { session: sessionId, label })).outcome).toBe("ok");
      expect((await importMemory(db, alpha, sessionId, [added(), removedChange()], label)).outcome).toBe("ok");
      const labels = await admin<{ compartments: string[] }>(
        db,
        "select compartments from ledger.agent_writes union all select compartments from ledger.memory_imports",
      );
      expect(labels).toHaveLength(4);
      for (const row of labels) expect(row.compartments).toEqual(label);
    }));
});

describe("NNNN: R11, policy.confirmed_claims", { timeout: TIMEOUT }, () => {
  const confirmed = async (db: TestDatabase, keys: string[]): Promise<string[]> =>
    (await asPipeline<{ key: string }>(db, "select k as key from policy.confirmed_claims($1) as k", [keys])).map(
      (row) => row.key,
    );

  it("confirmed_claims never answers a key marked echo or stale, even with a confirmed card; it answers it once the mark is cleared", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const record = await takenIn(db, alpha, sessionId, AT);
      for (const [n, mark] of [
        [1, "echo"],
        [2, "stale"],
        [3, "undecided"],
        [4, "new"],
      ] as const) {
        await check(db, key(n), record.evidence, mark, mark === "new" ? null : "read", mark === "new" ? null : FP);
        await answer(db, await card(db, { kind: "agent_claim", requestId: key(n) }), "confirm");
      }
      expect(await confirmed(db, [1, 2, 3, 4].map(key))).toEqual([key(3), key(4)].sort());
      // The owner clears the echo mark: its key is answered.
      const decision = await ownerDecision(db);
      await admin(db, "update ledger.restatement_checks set cleared_at = now(), cleared_by = $2 where claim_key = $1", [
        key(1),
        decision,
      ]);
      expect(await confirmed(db, [1, 2, 3, 4].map(key))).toEqual([key(1), key(3), key(4)].sort());
    }));

  it("a confirm decided before the mark was made keeps its key answered", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const record = await takenIn(db, alpha, sessionId, AT);
      await answer(db, await card(db, { kind: "agent_claim", requestId: key(1) }), "confirm", {
        at: "2026-01-01T00:00:00Z",
      });
      await check(db, key(1), record.evidence, "echo", "held", FP);
      expect(await confirmed(db, [key(1)])).toEqual([key(1)]);
      // The control: a confirm decided after the mark is not answered.
      await check(db, key(2), record.evidence, "echo", "held", FP);
      await answer(db, await card(db, { kind: "agent_claim", requestId: key(2) }), "confirm");
      expect(await confirmed(db, [key(2)])).toEqual([]);
    }));

  it("it answers a confirmed about_you card's key, and not a client_preference card's", () =>
    withRest(async (db) => {
      await answer(db, await card(db, { kind: "about_you", requestId: key(1) }), "confirm");
      await answer(
        db,
        await card(db, {
          kind: "client_preference",
          requestId: key(2),
          targetKind: "agent_record",
          targetId: testId("rec"),
        }),
        "confirm",
      );
      await answer(db, await card(db, { kind: "about_you", requestId: key(3) }), "reject");
      expect(await confirmed(db, [1, 2, 3].map(key))).toEqual([key(1)]);
    }));
});

describe("NNNN: R27, policy.confirmed_preferences", { timeout: TIMEOUT }, () => {
  const preferences = (
    db: TestDatabase,
    client: Client,
  ): Promise<{ record_id: string; evidence_id: string | null; confirmed_at: Date; compartments: string[] }[]> =>
    readAs(db, client.token, (query) =>
      query("select record_id, evidence_id, confirmed_at, compartments from policy.confirmed_preferences()"),
    );
  // A this_client proposal of the client, taken in, and its client_preference card.
  async function preference(
    db: TestDatabase,
    client: Client,
    sessionId: string,
    scope = "this_client",
  ): Promise<{ id: string; evidence: string; card: string }> {
    const record = await takenIn(db, client, sessionId, AT, { kind: "proposal", scope });
    const cardId = await card(db, {
      kind: "client_preference",
      requestId: record.id,
      targetKind: "agent_record",
      targetId: record.id,
      compartments: client.compartments.slice().sort(),
    });
    return { ...record, card: cardId };
  }

  it("confirmed_preferences answers the caller's own confirmed this_client proposals only, none of another client cleared for its agent compartment, none rejected, none removed", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      // Beta is cleared for alpha's agent compartment.
      const beta = await agent(db, "beta", ["own", "agent:alpha"]);
      const sessionId = await sessionOf(db, alpha);
      const kept = await preference(db, alpha, sessionId);
      await answer(db, kept.card, "confirm", { at: "2026-09-02T00:00:00Z" });
      const rejected = await preference(db, alpha, sessionId);
      await answer(db, rejected.card, "reject");
      await preference(db, alpha, sessionId);
      const superseded = await preference(db, alpha, sessionId);
      await answer(db, superseded.card, "reject", { supersedes: await answer(db, superseded.card, "confirm") });
      const tainted = await preference(db, alpha, sessionId);
      await answer(db, tainted.card, "confirm", { tainted: true });
      const removed = await preference(db, alpha, sessionId);
      await answer(db, removed.card, "confirm");
      // As the admin's removal leaves it: pi_owner has no update policy on ledger.agent_writes.
      await admin(db, "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [removed.id]);
      const flagged = await preference(db, alpha, sessionId);
      await answer(db, flagged.card, "confirm");
      await asPipeline(db, "update ledger.agent_writes set flagged_at = now() where id = $1", [flagged.id]);
      // A proposal of scope all, with a client_preference card that someone confirmed, is not one.
      const wide = await preference(db, alpha, sessionId, "all");
      await answer(db, wide.card, "confirm");

      const rows = await preferences(db, alpha);
      expect(
        rows.map((row) => ({ id: row.record_id, evidence: row.evidence_id, at: row.confirmed_at.toISOString() })),
      ).toEqual([{ id: kept.id, evidence: kept.evidence, at: "2026-09-02T00:00:00.000Z" }]);
      expect(rows[0]?.compartments).toEqual(alpha.compartments.slice().sort());
      // Another client sees none of them, though it is cleared for alpha's agent compartment.
      expect(await preferences(db, beta)).toEqual([]);
      // No token is no client.
      expect(
        await sqlState(() => readAs(db, null, (query) => query("select * from policy.confirmed_preferences()"))),
      ).toBe("42501");
    }));

  it("at most 20, the latest confirmed first", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const made: { id: string; at: string }[] = [];
      for (let n = 0; n < 22; n += 1) {
        const one_ = await preference(db, alpha, sessionId);
        const at = new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString();
        await answer(db, one_.card, "confirm", { at });
        made.push({ id: one_.id, at });
      }
      const rows = await preferences(db, alpha);
      expect(rows.map((row) => row.record_id)).toEqual(
        made
          .reverse()
          .slice(0, 20)
          .map((row) => row.id),
      );
    }));
});

describe("NNNN: ledger.check_restatement", { timeout: TIMEOUT }, () => {
  it("check_restatement keeps the first answer for a key", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const record = await takenIn(db, alpha, sessionId, AT);
      expect(await check(db, key(1), record.evidence, "stale", "read", FP)).toEqual({
        answer: "stale",
        cleared: false,
      });
      // A retry, or a generation raise, with another answer: the first stands.
      expect(await check(db, key(1), record.evidence, "new", null, null)).toEqual({ answer: "stale", cleared: false });
      expect(
        await admin(
          db,
          "select client_id, record_id, answer, reached, matched_fact_key_fp, decision_version, compartments, cleared_at from ledger.restatement_checks",
        ),
      ).toEqual([
        {
          client_id: alpha.id,
          record_id: record.id,
          answer: "stale",
          reached: "read",
          matched_fact_key_fp: FP,
          decision_version: 1,
          compartments: alpha.compartments.slice().sort(),
          cleared_at: null,
        },
      ]);
      // Once cleared, the answer says so.
      const decision = await ownerDecision(db);
      await admin(db, "update ledger.restatement_checks set cleared_at = now(), cleared_by = $2 where claim_key = $1", [
        key(1),
        decision,
      ]);
      expect(await check(db, key(1), record.evidence, "echo", "held", FP)).toEqual({ answer: "stale", cleared: true });
    }));

  it("it refuses an evidence id that is no agent record's with 42501, and writes nothing", () =>
    withRest(async (db) => {
      const message = await evidence(db);
      for (const id of [message, "f".repeat(64)])
        expect(await sqlState(() => check(db, key(1), id, "new", null, null)), id).toBe("42501");
      expect(await admin(db, "select id from ledger.restatement_checks")).toEqual([]);
      // The control: an agent record's evidence id.
      const alpha = await agent(db, "alpha");
      const record = await takenIn(db, alpha, await sessionOf(db, alpha), AT);
      expect(await check(db, key(1), record.evidence, "new", null, null)).toEqual({ answer: "new", cleared: false });
    }));
});

describe("NNNN: ledger.session_reads", { timeout: TIMEOUT }, () => {
  it("session_reads answers only read log rows at or before the record's time", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const sessionId = await sessionOf(db, alpha);
      const other = await sessionOf(db, alpha);
      const [a, b, c, d] = ["a".repeat(64), "b".repeat(64), "d".repeat(64), "e".repeat(64)] as const;
      const [fa, fb, fc] = ["1".repeat(64), "2".repeat(64), "3".repeat(64)] as const;
      await readAt(db, alpha, sessionId, "2026-08-31T00:00:00Z", [a], [fa]);
      await readAt(db, alpha, sessionId, AT, [b, a], [fb]);
      await readAt(db, alpha, sessionId, "2026-09-02T00:00:00Z", [c], [fc]);
      await readAt(db, alpha, other, "2026-08-30T00:00:00Z", [d], ["4".repeat(64)]);
      const record = await takenIn(db, alpha, sessionId, AT);
      expect(
        await asPipeline(db, "select bound, fact_key_fps from ledger.session_reads($1)", [record.evidence]),
      ).toEqual([{ bound: [a, b].sort(), fact_key_fps: [fa, fb].sort() }]);
      // An evidence id of no agent record answers nothing.
      expect(
        await asPipeline(db, "select bound, fact_key_fps from ledger.session_reads($1)", ["f".repeat(64)]),
      ).toEqual([]);
    }));
});

describe("NNNN: ledger.stale_restatements", { timeout: TIMEOUT }, () => {
  const stale = (db: TestDatabase) =>
    queryAs<{ client_id: string; fact_key_fp: string; count: number; case_key: string }>(
      db.urls.work,
      "select client_id, fact_key_fp, count::int as count, case_key from ledger.stale_restatements()",
    );

  it("it counts each client's uncleared stale marks by fact key, of records that still have a body, claims and memory changes alike, since the pair's latest decided card", () =>
    withRest(async (db) => {
      const alpha = await agent(db, "alpha");
      const beta = await agent(db, "beta");
      const label = await labelOf(db, alpha);
      const alphas = await sessionOf(db, alpha);
      const betas = await sessionOf(db, beta);
      const fact = "5".repeat(64);
      const other = "6".repeat(64);
      // Two claims of alpha marked stale on `fact`, one on `other`, one cleared, one of a removed record.
      for (const n of [1, 2])
        await check(db, key(`a${n}`), (await takenIn(db, alpha, alphas, AT)).evidence, "stale", "read", fact);
      await check(db, key("a3"), (await takenIn(db, alpha, alphas, AT)).evidence, "stale", "held", other);
      await check(db, key("a4"), (await takenIn(db, alpha, alphas, AT)).evidence, "stale", "read", fact);
      const decision = await ownerDecision(db);
      await admin(db, "update ledger.restatement_checks set cleared_at = now(), cleared_by = $2 where claim_key = $1", [
        key("a4"),
        decision,
      ]);
      const removed = await takenIn(db, alpha, alphas, AT);
      await check(db, key("a5"), removed.evidence, "stale", "read", fact);
      await admin(db, "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [removed.id]);
      // A memory change of alpha matched to an ended projection of `fact`.
      const ended = await projection(db, alpha, "ended", { fact });
      await importMemory(db, alpha, alphas, [added({ stamps: [ended] })], label);
      // One of beta on `fact`.
      await check(db, key("b1"), (await takenIn(db, beta, betas, AT)).evidence, "stale", "read", fact);

      const rows = (await stale(db))
        .map((row) => `${row.client_id === alpha.id ? "alpha" : "beta"} ${row.fact_key_fp[0]} ${row.count}`)
        .sort();
      expect(rows).toEqual(["alpha 5 3", "alpha 6 1", "beta 5 1"]);
      const pair = (await stale(db)).find((row) => row.client_id === alpha.id && row.fact_key_fp === fact);
      expect(pair?.case_key).toBe(`${alpha.id}:${fact.slice(0, 33)}`);

      // A decided card for alpha and `fact`: what came before it is not counted.
      const cardId = await card(db, {
        kind: "stale_restatement",
        requestId: testId("req").slice(4),
        author: "system:memory",
        targetKind: "client",
        targetId: alpha.id,
        caseKey: pair?.case_key as string,
      });
      await admin(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', '{own}')",
        [cardId],
      );
      const after = (await stale(db))
        .map((row) => `${row.client_id === alpha.id ? "alpha" : "beta"} ${row.fact_key_fp[0]} ${row.count}`)
        .sort();
      expect(after).toEqual(["alpha 6 1", "beta 5 1"]);
    }));
});

describe("NNNN: the replaced functions", { timeout: TIMEOUT }, () => {
  it("expire_agent_claims expires system:extract's about_you and client_preference cards beside agent_claim, and add_agent_claim_basis takes them", () =>
    withRest(async (db) => {
      const old = "2026-01-01T00:00:00Z";
      const ids: Record<string, string> = {};
      for (const kind of ["agent_claim", "about_you", "client_preference", "notice"]) {
        const id = testId("crd");
        await admin(
          db,
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
           values ($1, $2, $3, 'system:extract', $4, 'claim', $2, '{confirm,reject}', 30, '{own}')`,
          [id, key(kind), old, kind],
        );
        await admin(
          db,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:extract', '{own}')",
          [id, old],
        );
        ids[kind] = id;
      }
      expect(one(await asPipeline<{ n: number }>(db, "select ledger.expire_agent_claims() as n")).n).toBe(3);
      const state = async (id: string | undefined) =>
        one(
          await admin<{ event: string }>(
            db,
            "select event from ledger.record_events where row_id = $1 order by id desc limit 1",
            [id],
          ),
        ).event;
      for (const kind of ["agent_claim", "about_you", "client_preference"])
        expect(await state(ids[kind]), kind).toBe("expired");
      expect(await state(ids.notice)).toBe("pending");
      const cited = await evidence(db);
      for (const kind of ["agent_claim", "about_you", "client_preference"]) {
        expect(
          one(
            await asPipeline<{ ok: boolean }>(db, "select ledger.add_agent_claim_basis($1, $2) as ok", [
              ids[kind],
              [cited],
            ]),
          ).ok,
          kind,
        ).toBe(false);
      }
      expect(
        await sqlState(() => asPipeline(db, "select ledger.add_agent_claim_basis($1, $2)", [ids.notice, [cited]])),
      ).toBe("42501");
    }));

  it("pi_pipeline inserts system:extract's about_you and client_preference cards, and still no other kind or author", () =>
    withRest(async (db) => {
      const insertCard = (kind: string, author: string): Promise<string | null> =>
        sqlState(() =>
          asPipeline(
            db,
            "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now(), $3, $4, '{confirm,reject}', '{own}')",
            [testId("crd"), testId("req").slice(4), author, kind],
          ),
        );
      for (const kind of ["agent_claim", "about_you", "client_preference"])
        expect(await insertCard(kind, "system:extract"), kind).toBeNull();
      for (const [kind, author] of [
        ["stale_restatement", "system:extract"],
        ["notice", "system:extract"],
        ["about_you", "system:memory"],
        ["client_preference", "owner"],
      ]) {
        expect(await insertCard(kind as string, author as string), `${kind} ${author}`).toBe("42501");
      }
    }));

  it("serve_memory sets line_fp from line_fps, keeps it when called without them, and refuses a list of another length or form", () =>
    withRest(async (db) => {
      // A client with sync_memory, and the belief of one entry it is served.
      const client = await memoryClient(db, "memory-line", ["own"]);
      const entry = served(1);
      await seedBeliefs(db, ["own"], [entry]);
      const SERVE =
        "select kind from policy.serve_memory($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb)";
      const supports = supportsOf({ entries: [entry] });
      const lineOf = async (): Promise<string | null> =>
        one(
          await admin<{ line_fp: string | null }>(db, "select line_fp from ledger.memory_projections where id = $1", [
            entry.id,
          ]),
        ).line_fp;
      const line = "7".repeat(64);
      for (const [name, lines] of [
        ["one fingerprint too many", [line, line]],
        ["a fingerprint off its form", ["G".repeat(64)]],
        ["no fingerprint for the one entry", []],
      ] as const) {
        expect(
          (
            await refusal(() =>
              readAs(db, client.token, (query) => query(SERVE, [...valuesOf({ entries: [entry] }), lines, supports])),
            )
          )?.constraint,
          name,
        ).toBe("serve_memory_line_fps");
      }
      await readAs(db, client.token, (query) => query(SERVE, [...valuesOf({ entries: [entry] }), [line], supports]));
      expect(await lineOf()).toBe(line);
      // The call that passes no line leaves it as it is.
      await readAs(db, client.token, (query) =>
        query(
          "select kind from policy.serve_memory($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, supports => $11::jsonb)",
          [...valuesOf({ entries: [entry] }), supports],
        ),
      );
      expect(await lineOf()).toBe(line);
    }));
});
