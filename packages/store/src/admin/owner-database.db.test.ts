import { describe, expect, it } from "vitest";
import { openUnder, sealUnder } from "../core/seal.ts";
import {
  bareCondition,
  OWNER_ONLY,
  PIPELINE_LEDGER_CONDITIONS,
  PIPELINE_LEDGER_GRANTS,
  WRITER_LEDGER_CONDITIONS,
} from "../test-support/catalogue.ts";
import { FEWER_CARDS_CONDITIONS } from "../test-support/catalogue-grants.ts";
import { OWNER_SEALED, RECORD_EVENTS_WORK_INSERT } from "../test-support/catalogue-work.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import {
  one,
  ownerCommitted as ownerCommit,
  type Query,
  readAs,
  session,
  sqlState,
} from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test. The functions' behaviour is in
// owner-functions.db.test.ts.

const TIMEOUT = 180_000;
const AT = "2026-09-01T00:00:00Z";

type Role =
  | "pi_admin"
  | "pi_writer"
  | "pi_reader"
  | "pi_owner"
  | "pi_work"
  | "pi_proxy"
  | "pi_pipeline"
  | "pi_restricted";
type Command = "SELECT" | "INSERT" | "UPDATE";

// The expected grants: one policy for each cell, named <role>_<command>. Later migrations add
// pi_work's reads and card writes and the reader's two row policies; pi_proxy's select on three of
// them and pi_owner's insert of a send decision; and pi_owner's insert of a research card, for
// ledger.file_research.
const POLICIES: Record<string, [Role, Command][]> = {
  "knowledge.owner_decisions": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "UPDATE"],
    ["pi_work", "SELECT"],
    ["pi_owner", "INSERT"],
  ],
  "knowledge.vetoes": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "UPDATE"],
    ["pi_owner", "SELECT"],
  ],
  "ledger.cards": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "INSERT"],
    ["pi_owner", "UPDATE"],
    ["pi_work", "SELECT"],
    ["pi_work", "INSERT"],
    ["pi_proxy", "SELECT"],
    ["pi_pipeline", "SELECT"],
    ["pi_pipeline", "INSERT"],
    ["pi_restricted", "SELECT"],
    ["pi_restricted", "INSERT"],
    ["pi_writer", "SELECT"],
    ["pi_writer", "INSERT"],
    // The pipeline sets a card's match key once; no pi_restricted copy.
    ["pi_pipeline", "UPDATE"],
  ],
  "ledger.record_events": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "INSERT"],
    ["pi_owner", "UPDATE"],
    ["pi_work", "SELECT"],
    ["pi_work", "INSERT"],
    ["pi_reader", "SELECT"],
    ["pi_proxy", "SELECT"],
    ["pi_pipeline", "SELECT"],
    ["pi_pipeline", "INSERT"],
    // pi_restricted's copy of each of pi_pipeline's.
    ["pi_restricted", "SELECT"],
    ["pi_restricted", "INSERT"],
    // The writer raises system:identity's cards at the end of a sync.
    ["pi_writer", "SELECT"],
    ["pi_writer", "INSERT"],
  ],
  "ledger.basis": [
    ["pi_admin", "SELECT"],
    ["pi_owner", "SELECT"],
    ["pi_owner", "INSERT"],
    ["pi_owner", "UPDATE"],
    ["pi_work", "SELECT"],
    ["pi_reader", "SELECT"],
    ["pi_proxy", "SELECT"],
  ],
};
// The two tables the reader reads rows of, within its clearance and never a card's.
const READER_READS = ["ledger.basis", "ledger.record_events"];
const FIVE = Object.keys(POLICIES);

// The table privileges by name, besides the owner's own; and the column-level grants: the admin's
// update of a veto's lift, and pi_work's select of eight columns of a decision.
const TABLE_PRIVILEGES = [
  "knowledge.owner_decisions pi_admin INSERT",
  "knowledge.owner_decisions pi_admin SELECT",
  "knowledge.vetoes pi_admin INSERT",
  "knowledge.vetoes pi_admin SELECT",
  "ledger.basis pi_admin SELECT",
  "ledger.basis pi_proxy SELECT",
  "ledger.basis pi_reader SELECT",
  "ledger.basis pi_work SELECT",
  "ledger.cards pi_admin INSERT",
  "ledger.cards pi_admin SELECT",
  "ledger.cards pi_work INSERT",
  "ledger.cards pi_work SELECT",
  "ledger.cards pi_pipeline INSERT",
  "ledger.cards pi_pipeline SELECT",
  "ledger.record_events pi_admin INSERT",
  "ledger.record_events pi_admin SELECT",
  "ledger.record_events pi_proxy SELECT",
  "ledger.record_events pi_reader SELECT",
  "ledger.record_events pi_work INSERT",
  "ledger.record_events pi_work SELECT",
  "ledger.record_events pi_pipeline INSERT",
  // pi_restricted holds every right pi_pipeline holds.
  "ledger.cards pi_restricted INSERT",
  "ledger.cards pi_restricted SELECT",
  "ledger.record_events pi_restricted INSERT",
  // The writer raises identity cards; its select of the events is by column.
  "ledger.cards pi_writer INSERT",
  "ledger.cards pi_writer SELECT",
  "ledger.record_events pi_writer INSERT",
].sort();
const COLUMN_UPDATES = [
  "knowledge.owner_decisions answer pi_work SELECT",
  "knowledge.owner_decisions card_id pi_work SELECT",
  "knowledge.owner_decisions compartments pi_work SELECT",
  "knowledge.owner_decisions decided_at pi_work SELECT",
  "knowledge.owner_decisions id pi_work SELECT",
  "knowledge.owner_decisions kind pi_work SELECT",
  "knowledge.owner_decisions target_id pi_work SELECT",
  "knowledge.owner_decisions target_kind pi_work SELECT",
  // The lessons wake counts only untainted decisions.
  "knowledge.owner_decisions tainted_at pi_work SELECT",
  "knowledge.vetoes lift_ruling_id pi_admin UPDATE",
  "knowledge.vetoes lifted_at pi_admin UPDATE",
  // pi_proxy reads a card's id and target, and nothing else of it.
  "ledger.cards id pi_proxy SELECT",
  // The pipeline sets a card's match key once.
  "ledger.cards match_fp pi_pipeline UPDATE",
  "ledger.cards target_id pi_proxy SELECT",
  "ledger.cards target_kind pi_proxy SELECT",
  // pi_pipeline reads every column of its cards' events but body_enc.
  ...["at", "by", "compartments", "event", "id", "row_id", "row_kind", "tainted_at"].map(
    (column) => `ledger.record_events ${column} pi_pipeline SELECT`,
  ),
  // pi_writer reads the same columns of system:identity's cards' events.
  ...["at", "by", "compartments", "event", "id", "row_id", "row_kind", "tainted_at"].map(
    (column) => `ledger.record_events ${column} pi_writer SELECT`,
  ),
  ...["at", "by", "compartments", "event", "id", "row_id", "row_kind", "tainted_at"].map(
    (column) => `ledger.record_events ${column} pi_restricted SELECT`,
  ),
].sort();

// The nine core tables the definer functions read, each with one new policy.
const NINE = [
  "knowledge.accounts",
  "knowledge.domains",
  "knowledge.entities",
  "knowledge.event_details",
  "knowledge.event_participants",
  "knowledge.events",
  "knowledge.interaction_log",
  "knowledge.messages",
  "vault.evidence_items",
];

// The eight functions, their kind and who may execute them. `config` is the core's search path (as
// the core's functions have). pi_work holds EXECUTE on all but taint_citing.
const FUNCTIONS: Record<
  string,
  {
    signature: string;
    definer: boolean;
    volatility?: "i" | "s" | "v";
    language?: string;
    returns: string;
    execute: Role[];
  }
> = {
  "ledger.label": {
    signature: "ledger.label(text[])",
    definer: false,
    volatility: "i",
    returns: "text[]",
    execute: ["pi_admin", "pi_writer", "pi_reader", "pi_work", "pi_proxy"],
  },
  "policy.vetoed_by": {
    signature: "policy.vetoed_by(text[],text[],text)",
    definer: true,
    volatility: "s",
    returns: "text",
    execute: ["pi_admin", "pi_work"],
  },
  "policy.vetoed": {
    signature: "policy.vetoed(text[],text[],text)",
    definer: true,
    volatility: "s",
    returns: "boolean",
    execute: ["pi_admin", "pi_work"],
  },
  "ledger.lock_rows": {
    signature: "ledger.lock_rows(text[])",
    definer: false,
    language: "plpgsql",
    returns: "void",
    execute: ["pi_admin", "pi_work", "pi_writer"],
  },
  "ledger.owner_backed": {
    signature: "ledger.owner_backed(text,text)",
    definer: true,
    volatility: "s",
    returns: "boolean",
    execute: ["pi_admin", "pi_work"],
  },
  "ledger.admit_deferred": {
    signature: "ledger.admit_deferred(text)",
    definer: true,
    volatility: "v",
    returns: "integer",
    execute: ["pi_admin", "pi_work"],
  },
  "ledger.add_basis": {
    signature: "ledger.add_basis(text,text,text[],text[],text[],text[])",
    definer: true,
    volatility: "v",
    returns: "boolean",
    execute: ["pi_admin", "pi_work", "pi_writer"],
  },
  "ledger.taint_citing": {
    signature: "ledger.taint_citing(text[],text[],text[])",
    definer: true,
    volatility: "v",
    returns: "integer",
    execute: ["pi_admin", "pi_writer"],
  },
};

// One call of each function that every role may make without touching a row, for the grants.
const CALLS: Record<string, string> = {
  "ledger.label": "select ledger.label(array['own'])",
  "policy.vetoed_by": "select policy.vetoed_by(array[]::text[], array[]::text[], null)",
  "policy.vetoed": "select policy.vetoed(array[]::text[], array[]::text[], null)",
  "ledger.lock_rows": "select ledger.lock_rows(array[]::text[])",
  "ledger.owner_backed": "select ledger.owner_backed('message', 'msg_00000000000000000000000000')",
  "ledger.admit_deferred": "select ledger.admit_deferred('system:nobody')",
  "ledger.add_basis":
    "select ledger.add_basis('card', 'crd_00000000000000000000000000', array['own'], array[]::text[], array[]::text[], null)",
  "ledger.taint_citing": "select ledger.taint_citing(array[]::text[], array[]::text[], array[]::text[])",
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// One row of each of the five tables as pi_admin (and the basis row through add_basis), around
// one message: what the refusal tests below aim at.
async function fiveRows(
  db: TestDatabase,
): Promise<{ decision: string; veto: string; card: string; message: string; evidence: string }> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const evidence = await seed.evidence(["own"]);
    const message = await seed.message(["own"], evidence);
    const decision = testId("rul");
    await query(
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
       values ($1, $2, 'answer', 'message', $3, 'acknowledge', 0, '{}', '{}', $4, '{own}')`,
      [decision, testId("req"), message, AT],
    );
    const veto = testId("rul");
    await query(
      `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', $3, '{own}')`,
      [veto, testId("req"), AT],
    );
    await query(
      `insert into knowledge.vetoes (ruling_id, subject, value_fps, created_at, compartments) values ($1, 'person', $2, $3, '{own}')`,
      [veto, [fingerprint(db.keys, "address", "vetoed@owner-tests.test")], AT],
    );
    const card = testId("crd");
    await query(
      `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, $3, 'system:test', 'notice', '{acknowledge}', '{own}')`,
      [card, testId("req"), AT],
    );
    await query(
      `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:test', '{own}')`,
      [card, AT],
    );
    expect(
      one(
        await query<{ ok: boolean }>(
          "select ledger.add_basis('card', $1, '{own}', '{message}', array[$2], null) as ok",
          [card, message],
        ),
      ).ok,
    ).toBe(true);
    return { decision, veto, card, message, evidence };
  });
}

describe("0006: the owner's tables", { timeout: TIMEOUT }, () => {
  it("every new table has exactly the policies and privileges of the grants table", () =>
    withDatabase(async (db) => {
      const policies = await admin<{
        table: string;
        name: string;
        roles: string[];
        cmd: string;
        permissive: string;
        qual: string | null;
        check: string | null;
      }>(
        db,
        `select schemaname || '.' || tablename as "table", policyname as name, roles::text[] as roles, cmd, permissive, qual, with_check as "check"
         from pg_policies where schemaname || '.' || tablename = any($1)`,
        [FIVE],
      );
      const expected = FIVE.flatMap((table) =>
        (POLICIES[table] ?? []).map(
          ([role, command]) => `${table} ${role}_${command.toLowerCase()} ${role} ${command}`,
        ),
      );
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(expected.sort());
      // Each is permissive and unconditional, as every policy but the reader's is. The reader's
      // read the clearance once per query and leave out every card's row.
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        // pi_pipeline's policies have their own conditions, beside the restricted-compartment
        // clause (bareCondition leaves it out); pi_restricted's copies have the same.
        const condition =
          PIPELINE_LEDGER_CONDITIONS[label] ??
          FEWER_CARDS_CONDITIONS[label] ??
          PIPELINE_LEDGER_CONDITIONS[label.replace(" pi_restricted_", " pi_pipeline_")];
        if (condition !== undefined) {
          expect({ qual: bareCondition(policy.qual), check: bareCondition(policy.check) }, label).toEqual({
            qual: bareCondition(condition.qual),
            check: bareCondition(condition.check),
          });
          for (const text of [policy.qual, policy.check])
            if (text !== null)
              expect(text, label).toMatch(
                policy.roles.includes("pi_pipeline")
                  ? /NOT policy\.is_restricted\(compartments\)/
                  : /AND policy\.is_restricted\(compartments\)/,
              );
          continue;
        }
        if (policy.roles.includes("pi_reader")) {
          expect(policy.qual, label).toMatch(/select\s+(policy\.)?client_clearance\(\)/i);
          expect(policy.qual, label).toMatch(/'card'/);
          expect(policy.check, label).toBeNull();
          continue;
        }
        // pi_proxy reads the send proxy's row kinds alone of the events and the basis, and pi_owner
        // inserts only a decision of its two kinds.
        if (policy.roles.includes("pi_proxy") && READER_READS.includes(policy.table)) {
          expect(policy.qual, label).toMatch(/'draft'/);
          expect(policy.check, label).toBeNull();
          continue;
        }
        // The writer's system:identity cards and their events.
        const writer = WRITER_LEDGER_CONDITIONS[label];
        if (writer !== undefined) {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual(writer);
          continue;
        }
        // pi_owner inserts a card of kind research_request or goal_proposal.
        if (label === "ledger.cards pi_owner_insert") {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual({
            qual: null,
            check: "(kind = ANY (ARRAY['research_request'::text, 'goal_proposal'::text]))",
          });
          continue;
        }
        // pi_work inserts no owner's no with a decline reason.
        if (label === "ledger.record_events pi_work_insert") {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual({
            qual: null,
            check: RECORD_EVENTS_WORK_INSERT,
          });
          continue;
        }
        if (label === "knowledge.owner_decisions pi_owner_insert") {
          expect(policy.qual, label).toBeNull();
          expect(policy.check, label).toMatch(/'send'/);
          expect(policy.check, label).toMatch(/'send_settle'/);
          continue;
        }
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" ? null : "true");
      }

      // Forced row-level security, owned by pi_owner.
      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [FIVE],
      );
      expect(tables).toEqual(
        [...FIVE].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
      );

      // Table privileges by name, with no grant option, and nothing for PUBLIC.
      const privileges = await admin<{ line: string; grantable: boolean }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [FIVE],
      );
      expect(privileges.map((row) => row.line).sort()).toEqual(TABLE_PRIVILEGES);
      expect(privileges.filter((row) => row.grantable)).toEqual([]);

      // Column privileges beyond what a table privilege gives: the admin's update of a veto's two
      // lift columns, and nothing else. Read as pi_owner, who granted them.
      const columns = await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        return query<{ line: string; whole: string }>(
          `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type as line, table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type as whole
           from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
          [FIVE],
        );
      });
      const byTable = new Set(TABLE_PRIVILEGES);
      expect(
        columns
          .filter((row) => !byTable.has(row.whole))
          .map((row) => row.line)
          .sort(),
      ).toEqual(COLUMN_UPDATES);

      // The writer and the reader hold nothing on any of the five, but the reader's select of the
      // two tables it has a row policy on, and the writer's select and insert of the cards and
      // their events, for raising identity cards.
      for (const table of FIVE) {
        for (const role of ["pi_writer", "pi_reader"]) {
          const held = one(
            await admin<{ any: boolean }>(
              db,
              `select has_table_privilege($1, $2, 'SELECT') or has_table_privilege($1, $2, 'INSERT') or has_table_privilege($1, $2, 'UPDATE')
                 or has_table_privilege($1, $2, 'DELETE') or has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE') as any`,
              [role, table],
            ),
          ).any;
          const raises = role === "pi_writer" && (table === "ledger.cards" || table === "ledger.record_events");
          expect(held, `${role} on ${table}`).toBe((role === "pi_reader" && READER_READS.includes(table)) || raises);
        }
      }
      // The control for that reading: the admin holds its select.
      expect(
        one(await admin<{ ok: boolean }>(db, "select has_table_privilege('pi_admin', 'ledger.cards', 'SELECT') as ok"))
          .ok,
      ).toBe(true);

      // The nine core tables each gain one policy for pi_owner, pi_owner_select, and no other; a
      // later migration adds pi_owner_update on knowledge.messages, for policy.request_restriction
      // alone.
      const owners = await admin<{ line: string }>(
        db,
        `select schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '-') as line
         from pg_policies where 'pi_owner' = any (roles) and schemaname || '.' || tablename = any($1) order by 1`,
        [NINE],
      );
      // pi_owner_update on two of them, for vault.mark_recovery.
      const J2_UPDATES = [
        "vault.evidence_items pi_owner_update UPDATE true",
        "knowledge.messages pi_owner_update UPDATE true",
      ];
      // pi_owner_insert on vault.evidence_items, for policy.write_typed_claims alone, which takes a
      // typed finding's record in at its write (its evidence row, `typed`), since the claims it
      // inserts must name an evidence row and pi_reader holds no right in `vault`.
      const QT4_INSERTS = ["vault.evidence_items pi_owner_insert INSERT -"];
      // pi_owner_insert on knowledge.entities, for ledger.propose_project alone: a project's
      // entity, and no other kind's.
      const PROJECT_INSERTS = ["knowledge.entities pi_owner_insert INSERT -"];
      expect(owners.map((row) => row.line).sort()).toEqual(
        [
          ...NINE.map((table) => `${table} pi_owner_select SELECT true`),
          ...J2_UPDATES,
          ...QT4_INSERTS,
          ...PROJECT_INSERTS,
        ].sort(),
      );
    }));

  it("pi_pipeline has exactly the policies and privileges of PIPELINE_LEDGER_GRANTS on the five tables, and can execute exactly the functions it names", () =>
    withDatabase(async (db) => {
      const exists =
        one(await admin<{ n: number }>(db, "select count(*)::int as n from pg_roles where rolname = 'pi_pipeline'"))
          .n === 1;
      // The control for the role lookup: the same statement finds pi_reader.
      expect(
        one(await admin<{ n: number }>(db, "select count(*)::int as n from pg_roles where rolname = 'pi_reader'")).n,
      ).toBe(1);
      // Where that role exists.
      if (!exists) return;

      const policies = await admin<{ line: string }>(
        db,
        `select 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd as line from pg_policies
         where 'pi_pipeline' = any (roles) and schemaname || '.' || tablename = any($1)`,
        [FIVE],
      );
      const privileges = await admin<{ line: string }>(
        db,
        `select 'privilege ' || t.name || ' ' || p.privilege as line
         from unnest($1::text[]) as t(name) cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege)
         where has_table_privilege('pi_pipeline', t.name, p.privilege)
            or (p.privilege <> 'DELETE' and has_any_column_privilege('pi_pipeline', t.name, p.privilege))`,
        [FIVE],
      );
      const executes = await admin<{ line: string }>(
        db,
        `select 'execute ' || f.name as line from unnest($1::text[]) as f(name), unnest($2::text[]) as s(signature)
         where f.name = split_part(s.signature, '(', 1) and has_function_privilege('pi_pipeline', s.signature::regprocedure, 'EXECUTE')`,
        [Object.keys(FUNCTIONS), Object.values(FUNCTIONS).map((fn) => fn.signature)],
      );
      expect([...policies, ...privileges, ...executes].map((row) => row.line).sort()).toEqual(
        [...PIPELINE_LEDGER_GRANTS].sort(),
      );

      // Everything outside the list is refused 42501, as pi_pipeline itself.
      const asPipeline = (sql: string): Promise<string | null> => sqlState(() => queryAs(db.urls.pipeline, sql));
      // The control for that connection: it runs a statement it may.
      expect(await asPipeline("select 1")).toBeNull();
      for (const table of FIVE) {
        if (!PIPELINE_LEDGER_GRANTS.includes(`privilege ${table} SELECT`))
          expect(await asPipeline(`select count(*) from ${table}`), table).toBe("42501");
      }
      for (const [name, sql] of Object.entries(CALLS)) {
        if (!PIPELINE_LEDGER_GRANTS.includes(`execute ${name}`)) expect(await asPipeline(sql), name).toBe("42501");
      }
    }));

  it("the reader reads none of the five tables", () =>
    withDatabase(async (db) => {
      await fiveRows(db);
      const client = await insertClient(db, "owner-tests-reader", ["own"]);
      expect([...OWNER_ONLY].sort()).toEqual([...FIVE].sort());
      for (const table of OWNER_ONLY) {
        const sql = `select count(*) from ${table}`;
        // The reader selects from ledger.basis and ledger.record_events, and sees no row
        // of a card's there: every row here is one.
        if (READER_READS.includes(table)) {
          expect(one(await readAs(db, client.token, (query) => query<{ count: string }>(sql))).count, table).toBe("0");
          expect(one(await admin<{ count: string }>(db, sql)).count, `control: ${table}`).not.toBe("0");
          continue;
        }
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), table).toBe("42501");
        // The positive control: the admin's same statement.
        expect(one(await admin<{ count: string }>(db, sql)).count, `control: ${table}`).not.toBe("0");
      }
      // The control for the reader: under the same token it reads a knowledge table.
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select count(*) from knowledge.messages"))),
      ).toBeNull();
    }));

  // The writer reads and appends to ledger.cards and ledger.record_events, under policies that name
  // system:identity's cards alone (identity-sweep-sync.db.test.ts), and updates and deletes
  // neither.
  it("the writer reads and writes none of them, but for raising identity cards", () =>
    withDatabase(async (db) => {
      await fiveRows(db);
      for (const table of FIVE) {
        const named =
          { "knowledge.owner_decisions": "id", "knowledge.vetoes": "ruling_id", "ledger.cards": "id" }[table] ??
          "row_kind";
        const raises = table === "ledger.cards" || table === "ledger.record_events";
        const statements = [
          `select count(*) from ${table}`,
          `insert into ${table} (${named}) select ${named} from ${table} where false`,
          `update ${table} set ${named} = ${named}`,
          `delete from ${table}`,
        ];
        for (const [index, sql] of statements.entries()) {
          expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe(
            raises && index < 2 ? null : "42501",
          );
        }
        // The positive control: the admin's select.
        expect(await sqlState(() => admin(db, statements[0] ?? "")), `control: ${table}`).toBeNull();
      }
      // The control for the writer: it writes knowledge.messages.
      expect(await sqlState(() => queryAs(db.urls.writer, "update knowledge.messages set held = held"))).toBeNull();
    }));

  it("no role can delete a decision, or update its answer", () =>
    withDatabase(async (db) => {
      const { decision, message, evidence } = await fiveRows(db);
      const client = await insertClient(db, "owner-tests-reader", ["own"]);
      const statements = [
        ["delete from knowledge.owner_decisions where id = $1", [decision]],
        ["update knowledge.owner_decisions set answer = 'changed' where id = $1", [decision]],
      ] as const;
      for (const [sql, values] of statements) {
        expect(await sqlState(() => admin(db, sql, [...values])), `pi_admin: ${sql}`).toBe("42501");
        expect(await sqlState(() => queryAs(db.urls.writer, sql, [...values])), `pi_writer: ${sql}`).toBe("42501");
        expect(
          await sqlState(() => readAs(db, client.token, (query) => query(sql, [...values]))),
          `pi_reader: ${sql}`,
        ).toBe("42501");
      }
      // pi_owner, as the functions run, has no delete policy: its delete removes nothing.
      await ownerCommit(db, (query) => query("delete from knowledge.owner_decisions where id = $1", [decision]));
      expect(await admin(db, "select answer from knowledge.owner_decisions where id = $1", [decision])).toEqual([
        { answer: "acknowledge" },
      ]);

      // The positive control: ledger.taint_citing writes the decision, and keeps its answer.
      expect(
        one(
          await admin<{ n: number }>(db, "select ledger.taint_citing(array[$1], '{message}', array[$2]) as n", [
            evidence,
            message,
          ]),
        ).n,
      ).toBeGreaterThan(0);
      const after = one(
        await admin<{ answer: string; tainted: boolean }>(
          db,
          "select answer, tainted_at is not null as tainted from knowledge.owner_decisions where id = $1",
          [decision],
        ),
      );
      expect(after).toEqual({ answer: "acknowledge", tainted: true });
    }));

  it("no runtime role can set tainted_at or clear body_enc on any of the five tables", () =>
    withDatabase(async (db) => {
      const { card, message, evidence } = await fiveRows(db);
      const client = await insertClient(db, "owner-tests-reader", ["own"]);
      const columns = await admin<{ table: string; column: string }>(
        db,
        `select table_schema || '.' || table_name as "table", column_name::text as "column" from information_schema.columns
         where table_schema || '.' || table_name = any($1) and column_name in ('tainted_at', 'body_enc', 'evidence_id') order by 1, 2`,
        [FIVE],
      );
      // Every table but the vetoes has tainted_at; the three sealed ones a body; the basis its evidence id.
      expect(columns.map((row) => `${row.table}.${row.column}`)).toEqual([
        "knowledge.owner_decisions.body_enc",
        "knowledge.owner_decisions.tainted_at",
        "ledger.basis.evidence_id",
        "ledger.basis.tainted_at",
        "ledger.cards.body_enc",
        "ledger.cards.tainted_at",
        "ledger.record_events.body_enc",
        "ledger.record_events.tainted_at",
      ]);
      for (const { table, column } of columns) {
        const sql =
          column === "tainted_at" ? `update ${table} set tainted_at = now()` : `update ${table} set ${column} = null`;
        expect(await sqlState(() => admin(db, sql)), `pi_admin: ${sql}`).toBe("42501");
        expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `pi_reader: ${sql}`).toBe(
          "42501",
        );
      }
      // The positive control: ledger.taint_citing, as the writer calls it, sets them.
      expect(
        one(
          await queryAs<{ n: number }>(
            db.urls.writer,
            "select ledger.taint_citing(array[$1], '{message}', array[$2]) as n",
            [evidence, message],
          ),
        ).n,
      ).toBeGreaterThan(0);
      expect(
        one(
          await admin<{ tainted: boolean }>(
            db,
            "select tainted_at is not null as tainted from ledger.cards where id = $1",
            [card],
          ),
        ).tainted,
      ).toBe(true);
      expect(
        one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from ledger.basis where ref_id = $1 and tainted_at is not null and evidence_id is null",
            [message],
          ),
        ).n,
      ).toBe(1);
    }));

  it("each function is owned by pi_owner with the core's search path, and exactly the roles of the table can execute it", () =>
    withDatabase(async (db) => {
      const rows = await admin<{
        signature: string;
        definer: boolean;
        owner: string;
        config: string[] | null;
        volatility: string;
        language: string;
        returns: string;
        public: boolean;
      }>(
        db,
        `select p.oid::regprocedure::text as signature, p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                p.provolatile::text as volatility, l.lanname::text as language, pg_get_function_result(p.oid) as returns,
                coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as public
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
         where n.nspname || '.' || p.proname = any($1)`,
        [Object.keys(FUNCTIONS)],
      );
      expect(rows.map((row) => row.signature.replaceAll(" ", "")).sort()).toEqual(
        Object.values(FUNCTIONS)
          .map((fn) => fn.signature)
          .sort(),
      );
      for (const row of rows) {
        const name = row.signature.split("(")[0] ?? "";
        const want = FUNCTIONS[name];
        if (want === undefined) throw new Error(`no function ${name} in the expected table`);
        expect({ definer: row.definer, owner: row.owner, public: row.public, returns: row.returns }, name).toEqual({
          definer: want.definer,
          owner: "pi_owner",
          public: false,
          returns: want.returns,
        });
        expect(
          (row.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")),
          name,
        ).toEqual(["search_path=pg_catalog,policy,pg_temp"]);
        if (want.volatility !== undefined) expect(row.volatility, name).toBe(want.volatility);
        if (want.language !== undefined) expect(row.language, name).toBe(want.language);
        for (const role of ["pi_admin", "pi_writer", "pi_reader", "pi_work"] as const) {
          const can = one(
            await admin<{ ok: boolean }>(db, "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [
              role,
              want.signature,
            ]),
          ).ok;
          expect(can, `${role} ${name}`).toBe(want.execute.includes(role));
        }
      }

      // And by calling each: refused 42501 for a role outside the table, run for one in it.
      const client = await insertClient(db, "owner-tests-reader", ["own"]);
      const as: Record<"pi_admin" | "pi_writer" | "pi_reader" | "pi_work", (sql: string) => Promise<string | null>> = {
        pi_admin: (sql) => sqlState(() => admin(db, sql)),
        pi_writer: (sql) => sqlState(() => queryAs(db.urls.writer, sql)),
        pi_reader: (sql) => sqlState(() => readAs(db, client.token, (query) => query(sql))),
        pi_work: (sql) => sqlState(() => queryAs(db.urls.work, sql)),
      };
      for (const [name, sql] of Object.entries(CALLS)) {
        for (const role of ["pi_admin", "pi_writer", "pi_reader", "pi_work"] as const) {
          expect(await as[role](sql), `${role}: ${sql}`).toBe(FUNCTIONS[name]?.execute.includes(role) ? null : "42501");
        }
      }
    }));
});

describe("0006: the checks", { timeout: TIMEOUT }, () => {
  // The insert of one row of a table with the overrides given, as pi_admin, or as pi_owner for
  // the basis. Each in its own transaction.
  async function inserter(db: TestDatabase) {
    const { card } = await fiveRows(db);
    const row = async (table: string, values: Record<string, unknown>): Promise<string | null> => {
      const base: Record<string, Record<string, unknown>> = {
        "knowledge.owner_decisions": {
          id: testId("rul"),
          request_id: testId("req"),
          kind: "answer",
          queue_depth: 0,
          labels: [],
          details: {},
          decided_at: AT,
          compartments: ["own"],
        },
        "knowledge.vetoes": {},
        "ledger.cards": {
          id: testId("crd"),
          request_id: testId("req"),
          created_at: AT,
          created_by: "system:test",
          kind: "notice",
          options: ["acknowledge"],
          compartments: ["own"],
        },
        "ledger.record_events": {
          row_kind: "card",
          row_id: card,
          event: "pending",
          at: AT,
          by: "system:test",
          compartments: ["own"],
        },
        "ledger.basis": {
          row_kind: "card",
          row_id: card,
          ref_kind: "entity",
          ref_id: testId("ent"),
          source_class: "derived",
          compartments: ["own"],
        },
      };
      if (table === "knowledge.vetoes") {
        const ruling = testId("rul");
        await admin(
          db,
          "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', $3, '{own}')",
          [ruling, testId("req"), AT],
        );
        base[table] = {
          ruling_id: ruling,
          subject: "person",
          value_fps: [fingerprint(db.keys, "address", `${testId("v").toLowerCase()}@owner-tests.test`)],
          created_at: AT,
          compartments: ["own"],
        };
      }
      const full = { ...base[table], ...values };
      const columns = Object.keys(full);
      const sql = `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`;
      const run = async (query: Query): Promise<unknown> =>
        query(
          sql,
          columns.map((column) => full[column]),
        );
      if (table !== "ledger.basis") return sqlState(() => session(db.urls.admin, run));
      return sqlState(() => ownerCommit(db, run));
    };
    return row;
  }

  it("a row with an empty compartments is refused, for each of the five", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      for (const table of FIVE) {
        expect(await insert(table, { compartments: [] }), table).toBe("23514");
        // The positive control: the same row with one compartment.
        expect(await insert(table, { compartments: ["own"] }), `control: ${table}`).toBeNull();
      }
      const named = await admin<{ name: string }>(
        db,
        `select n.nspname || '.' || c.relname as name from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
         where k.conname = 'compartments_not_empty' and n.nspname || '.' || c.relname = any($1) order by 1`,
        [FIVE],
      );
      expect(named.map((row) => row.name)).toEqual([...FIVE].sort());
    }));

  it("a kind, row kind, ref kind or event that is a lower snake case word is taken, and one that is not is refused", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      const columns: [string, string][] = [
        ["knowledge.owner_decisions", "kind"],
        ["knowledge.owner_decisions", "target_kind"],
        ["knowledge.vetoes", "work_kind"],
        ["ledger.cards", "kind"],
        ["ledger.cards", "target_kind"],
        ["ledger.record_events", "row_kind"],
        ["ledger.record_events", "event"],
        ["ledger.basis", "row_kind"],
        ["ledger.basis", "ref_kind"],
      ];
      const target = (_table: string, column: string): Record<string, unknown> =>
        column === "target_kind" ? { target_id: testId("msg") } : {};
      for (const [table, column] of columns) {
        const at = `${table}.${column}`;
        // Words no list holds: the database checks the form only.
        for (const word of ["a", "some_later_kind", `k${"x".repeat(31)}`])
          expect(await insert(table, { [column]: word, ...target(table, column) }), `${at} = ${word}`).toBeNull();
        for (const bad of [
          "Upper",
          "two words",
          "with-dash",
          "9starts_with_digit",
          "_leading",
          "",
          `k${"x".repeat(32)}`,
        ]) {
          expect(
            await insert(table, { [column]: bad, ...target(table, column) }),
            `${at} = ${JSON.stringify(bad)}`,
          ).toBe("23514");
        }
      }
    }));

  it("a source class outside the five is refused", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      for (const taken of ["source", "derived", "owner", "agent", "system"])
        expect(await insert("ledger.basis", { source_class: taken }), taken).toBeNull();
      for (const refused of ["model", "Source", "client", ""])
        expect(await insert("ledger.basis", { source_class: refused }), refused).toBe("23514");
    }));

  it("a decision whose details is not a JSON object is refused", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      for (const taken of [{}, { firstContact: true, newThread: false, released: [] }])
        expect(await insert("knowledge.owner_decisions", { details: taken }), JSON.stringify(taken)).toBeNull();
      // Each handed over as JSON text, so the column receives that JSON value.
      for (const refused of ["[]", "1", '"text"', "null", "true"])
        expect(await insert("knowledge.owner_decisions", { details: refused }), refused).toBe("23514");
      // A decision with no details takes the empty object.
      const id = testId("rul");
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, decided_at, compartments) values ($1, $2, 'answer', 0, '{}', $3, '{own}')",
        [id, testId("req"), AT],
      );
      expect(await admin(db, "select details from knowledge.owner_decisions where id = $1", [id])).toEqual([
        { details: {} },
      ]);
      // And a negative queue depth is refused.
      expect(await insert("knowledge.owner_decisions", { queue_depth: -1 })).toBe("23514");
    }));

  it("a card with both an expires_at and an expires_after_days is refused", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      expect(await insert("ledger.cards", { expires_at: AT, expires_after_days: 7 })).toBe("23514");
      // The positive controls: either alone, or neither.
      expect(await insert("ledger.cards", { expires_at: AT })).toBeNull();
      expect(await insert("ledger.cards", { expires_after_days: 7 })).toBeNull();
      expect(await insert("ledger.cards", {})).toBeNull();
      // Days count from 1 to 90.
      for (const days of [1, 90])
        expect(await insert("ledger.cards", { expires_after_days: days }), String(days)).toBeNull();
      for (const days of [0, 91, -1])
        expect(await insert("ledger.cards", { expires_after_days: days }), String(days)).toBe("23514");
      // A request id is unique for its author.
      const request = testId("req");
      expect(await insert("ledger.cards", { request_id: request })).toBeNull();
      expect(await insert("ledger.cards", { request_id: request })).toBe("23505");
      expect(await insert("ledger.cards", { request_id: request, created_by: "system:other" })).toBeNull();
    }));

  it("a veto's subject and fingerprints are checked", () =>
    withDatabase(async (db) => {
      const insert = await inserter(db);
      const fp = fingerprint(db.keys, "domain", "owner-tests.test");
      // Subject `any` has a work kind and no fingerprint; any other subject at least one fingerprint.
      expect(await insert("knowledge.vetoes", { subject: "any", value_fps: [], work_kind: "intro" })).toBeNull();
      expect(await insert("knowledge.vetoes", { subject: "any", value_fps: [], work_kind: null })).toBe("23514");
      expect(await insert("knowledge.vetoes", { subject: "any", value_fps: [fp], work_kind: "intro" })).toBe("23514");
      expect(await insert("knowledge.vetoes", { subject: "organization", value_fps: [fp] })).toBeNull();
      expect(await insert("knowledge.vetoes", { subject: "organization", value_fps: [] })).toBe("23514");
      expect(await insert("knowledge.vetoes", { subject: "person", value_fps: [] })).toBe("23514");
      expect(await insert("knowledge.vetoes", { subject: "company", value_fps: [fp] })).toBe("23514");
    }));
});

describe("0006: label and sealing", { timeout: TIMEOUT }, () => {
  it("label sorts and removes repeats", () =>
    withDatabase(async (db) => {
      const label = async (list: string[]): Promise<string[]> =>
        one(await admin<{ label: string[] }>(db, "select ledger.label($1::text[]) as label", [list])).label;
      expect(await label(["own", "employer:example", "own"])).toEqual(["employer:example", "own"]);
      expect(await label(["b", "a", "c", "a", "b"])).toEqual(["a", "b", "c"]);
      expect(await label(["own"])).toEqual(["own"]);
      expect(await label([])).toEqual([]);
      // Two lists of the same compartments label equal, whatever their order.
      expect(await label(["own", "agent:helper", "employer:example"])).toEqual(
        await label(["employer:example", "own", "agent:helper", "own"]),
      );
      // The writer and the reader may call it too.
      expect(
        one(await queryAs<{ label: string[] }>(db.urls.writer, "select ledger.label(array['own', 'own']) as label"))
          .label,
      ).toEqual(["own"]);
    }));

  it("each sealed column of the five tables holds a body sealed for its row's compartments, which opens there and with every key only", () =>
    withDatabase(
      async (db) => {
        const compartments = ["employer:example", "own"];
        const text = (place: string): string => `owner sealed body ${place}`;
        const card = testId("crd");
        const decision = testId("rul");
        const ids: Record<string, string> = { "ledger.cards": card, "knowledge.owner_decisions": decision };
        const at = (table: string, id: string) => ({ table, id, column: "body_enc" });
        // A card and a decision as pi_admin, with their bodies; an event of the card, whose id the
        // table makes, written by pi_owner as the functions write it.
        await admin(
          db,
          "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, body_from, compartments, body_enc) values ($1, $2, $3, 'system:test', 'notice', '{acknowledge}', 'code', $4, $5)",
          [
            card,
            testId("req"),
            AT,
            compartments,
            sealUnder(db.keys, compartments, at("ledger.cards", card), text("ledger.cards")),
          ],
        );
        await admin(
          db,
          "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments, body_enc) values ($1, $2, 'answer', 0, '{}', '{}', $3, $4, $5)",
          [
            decision,
            testId("req"),
            AT,
            compartments,
            sealUnder(
              db.keys,
              compartments,
              at("knowledge.owner_decisions", decision),
              text("knowledge.owner_decisions"),
            ),
          ],
        );
        const event = one(
          await admin<{ id: string }>(
            db,
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:test', $3) returning id::text as id",
            [card, AT, compartments],
          ),
        ).id;
        ids["ledger.record_events"] = event;
        await ownerCommit(db, (query) =>
          query("update ledger.record_events set body_enc = $1 where id = $2::bigint", [
            sealUnder(db.keys, compartments, at("ledger.record_events", event), text("ledger.record_events")),
            event,
          ]),
        );

        expect(OWNER_SEALED.map((one) => `${one.table}.${one.column}`).sort()).toEqual([
          "knowledge.owner_decisions.body_enc",
          "ledger.cards.body_enc",
          "ledger.record_events.body_enc",
        ]);
        for (const { table, id, column } of OWNER_SEALED) {
          const place = `${table}.${column}`;
          const type = one(
            await admin<{ type: string; nullable: string }>(
              db,
              "select data_type as type, is_nullable as nullable from information_schema.columns where table_schema || '.' || table_name = $1 and column_name = $2",
              [table, column],
            ),
          );
          expect(type, place).toEqual({ type: "jsonb", nullable: "YES" });
          const row = one(
            await admin<{ id: string; compartments: string[]; sealed: unknown }>(
              db,
              `select (${id})::text as id, compartments, ${column} as sealed from ${table} where ${column} is not null`,
            ),
          );
          expect(row.compartments, place).toEqual(compartments);
          const sealed = row.sealed as Parameters<typeof openUnder>[3];
          expect(openUnder(db.keys, row.compartments, { table, id: row.id, column }, sealed), place).toBe(text(table));
          expect(() => openUnder(db.keys, ["own"], { table, id: row.id, column }, sealed), place).toThrow();
          expect(
            () => openUnder(db.keys, row.compartments, { table, id: `${row.id}0`, column }, sealed),
            place,
          ).toThrow();
          expect(ids[table], place).toBe(row.id);
        }
        // And the text is in no column in plaintext.
        expect(await scanForPlaintext(db.urls.admin, ["owner sealed body"])).toEqual([]);
      },
      { compartments: ["own", "employer:example"] },
    ));
});
