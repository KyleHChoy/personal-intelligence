import { sha256 } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMAS } from "../test-support/catalogue-grants.ts";
import { ALL_VIEWS, testId } from "../test-support/clients.ts";
import { type Query, session } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";

// For every table that carries a trigger after the migrations (read from pg_trigger), two
// repeatable-read transactions each take their snapshot, then each writes one row (the first commits
// before the second writes, as two writers at once would), and both must commit: a trigger that
// writes a shared row fails the second with 40001. The rows come from the seeder in
// test-support/seeder.ts, run inside the transaction; a table it cannot seed there is listed with its
// reason. A table no two writers reach is held by what its triggers write, read from the catalogue
// (only inserts), or listed with its reason. Joins every gate that adds a trigger or a migration.
// Synthetic values only.

const TIMEOUT = 120_000;
const AT = "2026-09-01T00:00:00Z";

// One seeder for the whole run, on whichever connection is writing: two seeders on one database
// count from one each, and would make the same ids.
type Shared = { on: (query: Query) => void; into: (table: string) => (compartments: string[]) => Promise<unknown> };
function sharedSeeder(db: TestDatabase): Shared {
  let current: Query = () => Promise.reject(new Error("no connection"));
  const seed = seeder(db, (text, values) => current(text, values));
  return { on: (query) => void (current = query), into: seed.into };
}

// How one table's row is written: on which connection, as which role, with parents committed
// before the snapshots (`prepare`) where the seeder would write them on a connection of its own.
type Writer = {
  url: (db: TestDatabase) => string;
  role?: string;
  prepare?: (db: TestDatabase, seed: Shared) => Promise<unknown>;
  write: (db: TestDatabase, query: Query, parent: unknown) => Promise<unknown>;
};

// A client and its session, as pi_admin and pi_owner write them, committed.
const parentSession = (db: TestDatabase, seed: Shared): Promise<{ id: string; clientId: string }> =>
  session(db.urls.admin, async (query) => {
    seed.on(query);
    return (await seed.into("ledger.sessions")(["own"])) as { id: string; clientId: string };
  });

// The tables whose seeder writes the row, or a parent, on a connection of its own: the same row,
// written inside the transaction, as the role that writes it in the system.
const OWN_WRITERS: Readonly<Record<string, Writer>> = {
  "knowledge.entities": {
    url: (db) => db.urls.admin,
    write: (_db, query) => query("insert into knowledge.entities (id, kind) values ($1, 'person')", [testId("ent")]),
  },
  // The owner's Remove of a person: a decision and the hide, as pi_admin writes them.
  "knowledge.person_hides": {
    url: (db) => db.urls.admin,
    write: async (_db, query) => {
      const ruling = testId("rul");
      await query(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'release', 0, '{}', '{}', $3, '{own}')",
        [ruling, testId("req"), AT],
      );
      await query("insert into knowledge.person_hides (ruling_id, entity_ids, created_at) values ($1, $2, $3)", [
        ruling,
        [testId("ent")],
        AT,
      ]);
    },
  },
  // A filing pass's reading, as pi_admin stores it.
  "ledger.measure_readings": {
    url: (db) => db.urls.admin,
    write: (_db, query) =>
      query(
        "insert into ledger.measure_readings (metric, value, sample, state, compartments) values ('a_measure', 1, 1, 'ok', '{own}')",
        [],
      ),
  },
  // The sweep's judgment of a pair, as pi_pipeline writes it, each writer on two claims of its own,
  // committed before the snapshots: its label trigger reads the two claims.
  "knowledge.same_fact_judgments": {
    url: (db) => db.urls.pipeline,
    prepare: (db, seed) =>
      session(db.urls.admin, async (query) => {
        seed.on(query);
        const claims: unknown[] = [];
        for (let n = 0; n < 4; n += 1) claims.push(await seed.into("knowledge.claims")(["own"]));
        return { pairs: [claims.slice(0, 2), claims.slice(2)], next: 0 };
      }),
    write: (_db, query, parent) => {
      const sides = parent as { pairs: string[][]; next: number };
      const pair = sides.pairs[sides.next] as string[];
      sides.next += 1;
      return query(
        `insert into knowledge.same_fact_judgments (a_fp, b_fp, a_claim, b_claim, band, rung, state, pair_at, compartments)
         select min(fact_key_fp), max(fact_key_fp), (array_agg(id order by fact_key_fp))[1], (array_agg(id order by fact_key_fp))[2],
           'accept', 1, 'proposed', $2, '{own}' from knowledge.claims where id = any ($1)`,
        [pair, AT],
      );
    },
  },
  "ledger.trigger_log": {
    url: (db) => db.urls.pipeline,
    write: (_db, query) =>
      query(
        "insert into ledger.trigger_log (fact_key_fp, clearance_key, state_fp, raise, cause, compartments) values ($1, 'own', repeat('a', 64), 'changed', 'claim', '{own}')",
        [testId("fp")],
      ),
  },
  "ledger.trigger_rechecks": {
    url: (db) => db.urls.work,
    write: (_db, query) =>
      query(
        "insert into ledger.trigger_rechecks (fact_key_fp, clearance_key, cause, exact, window_from, window_to, compartments) values ($1, 'own', 'due', false, now(), now() + interval '1 day', '{own}')",
        [testId("fp")],
      ),
  },
  // As pi_owner, the role policy.append_record writes it as (under the reader's repeatable read).
  "ledger.agent_writes": {
    url: (db) => db.urls.bootstrap,
    role: "pi_owner",
    prepare: parentSession,
    write: async (db, query, parent) => {
      const { id: sessionId, clientId } = parent as { id: string; clientId: string };
      const id = testId("rec");
      await query(
        `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc)
         values ($1, $2, $3, $4, $5, 'record', 'note', '{own}', $6, $7, $8, '{}', $9)`,
        [
          id,
          clientId,
          `seed-writer-${id}`,
          sessionId,
          `seed-request-${id.slice(-12)}`,
          ALL_VIEWS,
          fingerprint(db.keys, "content_hash", sha256(id)),
          fingerprint(db.keys, "cites", ""),
          sealRow(db.keys, "own", { table: "ledger.agent_writes", id, column: "body_enc" }, "seed note"),
        ],
      );
    },
  },
  // As pi_owner, the role policy.log_read writes it as (under the reader's repeatable read).
  "ledger.read_log": {
    url: (db) => db.urls.bootstrap,
    role: "pi_owner",
    prepare: parentSession,
    write: async (_db, query, parent) => {
      const { id, clientId } = parent as { id: string; clientId: string };
      await query(
        "insert into ledger.read_log (session_id, client_id, tool, compartments, bound, shown, fact_key_fps) values ($1, $2, 'search', '{own}', '{}', '{}', '{}')",
        [id, clientId],
      );
    },
  },
};

// Why a table with a trigger is not written here.
const OWN_CONNECTION =
  "the seeder writes the row or a parent on a connection of its own (asLedger as pi_owner, or another role), outside the transaction";
const NO_SEEDER = "test-support/seeder.ts has no seeder for it";
const JOURNAL_SEQ = "the seeder numbers an erasure max(journal_seq) + 1, which two writers at once share";
const ONE_ROW = "a single-row table: there is no second row to write";

const reasons = (reason: string, names: string[]): [string, string][] => names.map((name) => [name, reason]);

// Tables with a trigger and no write here, each with its reason. The list is exact: a new table with
// a trigger needs a seeder that writes inside the transaction, an OWN_WRITERS entry, or a line here.
const UNSEEDED: Readonly<Record<string, string>> = Object.fromEntries([
  ...reasons(NO_SEEDER, ["knowledge.pages", "ledger.work_notices", "policy.lens_devices"]),
  ...reasons(ONE_ROW, ["policy.owner_settings", "projections.planner_mission"]),
  ...reasons(JOURNAL_SEQ, ["knowledge.erasures", "knowledge.removed_evidence", "knowledge.suppressions"]),
  ...reasons(OWN_CONNECTION, [
    "knowledge.captures",
    "knowledge.chat_lines",
    "knowledge.claim_org_names",
    "knowledge.org_names",
    "ledger.agent_learnings",
    "ledger.agent_messages",
    "ledger.agent_rulings",
    "ledger.assignments",
    "ledger.basis",
    "ledger.belief_settlements",
    "ledger.capture_erasures",
    "ledger.capture_inbox",
    "ledger.card_answers",
    "ledger.card_relays",
    "ledger.cases",
    "ledger.context_packs",
    "ledger.draft_beliefs",
    "ledger.drafts",
    "ledger.dream_findings",
    "ledger.dream_identity_candidates",
    "ledger.erasure_exposures",
    "ledger.expected_outcomes",
    "ledger.exposures",
    "ledger.forecasts",
    "ledger.gate_checks",
    "ledger.goal_proposals",
    "ledger.held_out_questions",
    "ledger.hypotheses",
    "ledger.hypothesis_tests",
    "ledger.improvement_events",
    "ledger.improvements",
    "ledger.intentions",
    "ledger.memory_exposures",
    "ledger.memory_imports",
    "ledger.memory_projections",
    "ledger.mirror_entries",
    "ledger.move_lessons",
    "ledger.move_result_links",
    "ledger.moves",
    "ledger.opportunities",
    "ledger.opportunity_decisions",
    "ledger.outcome_assessments",
    "ledger.outcome_checks",
    "ledger.outcome_links",
    "ledger.outcome_test_runs",
    "ledger.outcome_test_tasks",
    "ledger.change_log",
    "ledger.identity_answers",
    "ledger.identity_questions",
    "ledger.question_rules",
    "ledger.recall_checks",
    "ledger.surfaced_items",
    "ledger.relation_checks",
    "ledger.restatement_checks",
    "ledger.run_attempts",
    "ledger.run_steps",
    "ledger.sent_messages",
    "ledger.sessions",
    "ledger.signal_marks",
    "ledger.silence_samples",
    "ledger.silences",
    "ledger.source_checks",
    "ledger.work_dependencies",
    "ledger.work_watches",
    "ledger.wrong_merge_reports",
    "ledger.relation_reports",
    "projections.warmth_day_builds",
    "projections.warmth_days",
    "vault.sync_outcomes",
  ]),
]);

// The tables no two writers reach whose triggers write more than an insert,
// each with why no two repeatable-read writers share the row it writes.
const ON_TAINT =
  "fires only when a row is tainted or erased, which an erasure does at read committed under the taint lock, and writes only the rows derived from that row";
const SHARED_ON_TAINT: Readonly<Record<string, string>> = {
  "knowledge.org_names":
    "updates a goal's state only for a goal whose latest goal_target decision waits on this row's own owner_command item, one to a decision; any other name row matches none and writes nothing",
  "ledger.move_result_links": ON_TAINT,
  "ledger.opportunities": ON_TAINT,
  "ledger.outcome_links": ON_TAINT,
};

type Outcome = { table: string; result: "ok" | "unseeded" | "conflict" | "failed"; code?: string; message?: string };

// One transaction at repeatable read with its snapshot taken, held open until `end`.
async function transaction(url: string, role: string | undefined): Promise<{ query: Query; end: () => Promise<void> }> {
  let release: () => void = () => {};
  let ready: (query: Query) => void = () => {};
  const opened = new Promise<Query>((resolve) => (ready = resolve));
  const closed = session(url, async (inner) => {
    await inner("begin isolation level repeatable read");
    if (role !== undefined) await inner(`set local role ${role}`);
    await inner("select 1");
    ready(inner);
    await new Promise<void>((done) => (release = done));
  });
  const query = await Promise.race([
    opened,
    closed.then(() => Promise.reject(new Error("the transaction did not open"))),
  ]);
  return {
    query,
    end: async () => {
      release();
      await closed;
    },
  };
}

// Rows this transaction inserted into the table, from its own statistics: none means the seeder
// wrote elsewhere.
const inserted = async (query: Query, table: string): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(
        "select coalesce(sum(n_tup_ins), 0)::text as n from pg_stat_xact_all_tables where relid = $1::regclass",
        [table],
      )
    )[0]?.n ?? 0,
  );

const failure = (table: string, error: unknown): Outcome => {
  const code = (error as { code?: string }).code;
  const message = (error as Error).message;
  if (message.startsWith("the fixtures know no table")) return { table, result: "unseeded" };
  return {
    table,
    result: code === "40001" || code === "40P01" ? "conflict" : "failed",
    ...(code === undefined ? {} : { code }),
    message,
  };
};

async function twoWriters(db: TestDatabase, seed: Shared, table: string): Promise<Outcome> {
  const writer: Writer = OWN_WRITERS[table] ?? {
    url: (d) => d.urls.admin,
    write: (_d, query) => {
      seed.on(query);
      return seed.into(table)(["own"]);
    },
  };
  let parent: unknown;
  try {
    parent = await writer.prepare?.(db, seed);
  } catch (error) {
    return failure(table, error);
  }
  const url = writer.url(db);
  const sides: Awaited<ReturnType<typeof transaction>>[] = [];
  try {
    sides.push(await transaction(url, writer.role));
    sides.push(await transaction(url, writer.role));
    for (const side of sides) {
      try {
        await writer.write(db, side.query, parent);
        if ((await inserted(side.query, table)) === 0)
          return { table, result: "failed", message: "written outside the transaction" };
        await side.query("commit");
      } catch (error) {
        return failure(table, error);
      }
    }
    return { table, result: "ok" };
  } finally {
    for (const side of sides) {
      await side.query("rollback").catch(() => undefined);
      await side.end();
    }
  }
}

// What each table's triggers write, read from the catalogue, so a table no
// two writers reach is still held: a trigger function, and every function of these schemas it calls,
// in turn, may only insert. An update, a delete or an upsert writes a row two writers can share.
const WRITES = /\b(update|delete\s+from|insert\s+into)\s+(?:only\s+)?([a-z_]+\.[a-z_0-9]+)([\s\S]*?)(?:;|$)/gi;
const CALLS = /\b((?:vault|knowledge|ledger|projections|policy)\.[a-z_0-9]+)\s*\(/gi;
type SharedWrite = { fn: string; write: string };
async function sharedWrites(url: string, table: string): Promise<SharedWrite[]> {
  const roots = await queryAs<{ name: string }>(
    url,
    `select distinct pn.nspname || '.' || p.proname as name from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
       join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname || '.' || c.relname = $1 order by 1`,
    [table],
  );
  const bodies = new Map<string, string>();
  const queue = roots.map((row) => row.name);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (bodies.has(name)) continue;
    const [schema, proc] = name.split(".");
    const found = await queryAs<{ src: string }>(
      url,
      "select string_agg(p.prosrc, E'\\n') as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.proname = $2",
      [schema, proc],
    );
    const src = (found[0]?.src ?? "").replace(/--[^\n]*/g, "");
    bodies.set(name, src);
    for (const match of src.matchAll(CALLS)) queue.push((match[1] as string).toLowerCase());
  }
  const shared: SharedWrite[] = [];
  for (const [name, src] of bodies) {
    for (const match of src.matchAll(WRITES)) {
      const verb = (match[1] as string).toLowerCase();
      const upsert = verb.startsWith("insert") && /on\s+conflict[\s\S]*?do\s+update/i.test(match[3] as string);
      if (!verb.startsWith("insert") || upsert)
        shared.push({ fn: name, write: `${verb.split(/\s/)[0]} ${match[2]}${upsert ? " (upsert)" : ""}` });
    }
  }
  return shared;
}

let db: TestDatabase;
let tables: string[];
let outcomes: Outcome[];
let shared: Map<string, SharedWrite[]>;

beforeAll(async () => {
  db = await createTestDatabase();
  tables = (
    await queryAs<{ name: string }>(
      db.urls.bootstrap,
      `select distinct n.nspname || '.' || c.relname as name from pg_trigger t
         join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname = any ($1) order by 1`,
      [[...SCHEMAS]],
    )
  ).map((row) => row.name);
  const seed = sharedSeeder(db);
  outcomes = [];
  for (const table of tables) outcomes.push(await twoWriters(db, seed, table));
  shared = new Map();
  for (const table of tables) shared.set(table, await sharedWrites(db.urls.bootstrap, table));
}, TIMEOUT);

afterAll(async () => {
  await db?.drop();
}, TIMEOUT);

describe("two repeatable-read writers of a table with a trigger both commit", {
  timeout: TIMEOUT,
}, () => {
  it("reads the tables with a trigger, and writes most of them", () => {
    // The positive control: tables with triggers of their own are found, and written.
    expect(tables).toEqual(
      expect.arrayContaining(["knowledge.claims", "ledger.agent_writes", "knowledge.fact_rulings"]),
    );
    const ok = outcomes.filter((outcome) => outcome.result === "ok").map((outcome) => outcome.table);
    expect(ok).toEqual(expect.arrayContaining(["knowledge.claims", "ledger.agent_writes", "ledger.read_log"]));
    // The fact rulings' trigger appends a mark rather than bumping one shared counter, so two
    // writers of rulings both commit.
    expect(ok).toContain("knowledge.fact_rulings");
  });

  it("every table with a trigger takes two concurrent repeatable-read writers, or is listed with its reason", () => {
    const listed = outcomes
      .filter((outcome) => outcome.result === "unseeded" || outcome.result === "failed")
      .map((outcome) => outcome.table);
    expect(listed.sort()).toEqual(Object.keys(UNSEEDED).sort());
    expect(outcomes.filter((outcome) => outcome.result === "conflict")).toEqual([]);
  });

  // A table no two writers reached is still held, by what its triggers write.
  it("every table with a trigger no two writers reached has triggers that only insert, or is listed with its reason", () => {
    const reached = new Set(outcomes.filter((outcome) => outcome.result === "ok").map((outcome) => outcome.table));
    const unreached = tables.filter((table) => !reached.has(table));
    expect(shared.get("knowledge.claims")?.map((one) => one.write)).toContain("update policy.owner_settings");
    expect(shared.get("ledger.record_events")?.map((one) => one.write)).toContain(
      "insert ledger.work_notices (upsert)",
    );
    const writing = unreached.filter((table) => (shared.get(table) ?? []).length > 0);
    expect(writing.sort()).toEqual(Object.keys(SHARED_ON_TAINT).sort());
    expect(unreached.length).toBeGreaterThan(0);
  });
});
