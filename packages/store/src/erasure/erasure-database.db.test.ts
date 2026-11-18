import { describe, expect, it } from "vitest";
import { insertClient, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test. Made-up values only.

const TIMEOUT = 180_000;
const AT = "2026-09-01T00:00:00Z";

type Role = "pi_admin" | "pi_writer" | "pi_owner" | "pi_pipeline";
type Command = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

// The expected grants: one policy for each cell, named <role>_<command>, and pi_owner's select of
// the two it reads.
const POLICIES: Record<string, [Role, Command][]> = {
  "knowledge.erasures": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "UPDATE"],
    ["pi_owner", "SELECT"],
  ],
  "knowledge.removed_evidence": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "DELETE"],
    ["pi_writer", "SELECT"],
    ["pi_owner", "SELECT"],
  ],
  "knowledge.suppressions": [
    ["pi_admin", "SELECT"],
    ["pi_admin", "INSERT"],
    ["pi_admin", "DELETE"],
    ["pi_writer", "SELECT"],
    ["pi_owner", "SELECT"],
    // The time pass judges a title against suppressions, its fingerprint alone.
    ["pi_pipeline", "SELECT"],
  ],
};
const THREE = Object.keys(POLICIES);

const TABLE_PRIVILEGES = [
  "knowledge.erasures pi_admin INSERT",
  "knowledge.erasures pi_admin SELECT",
  "knowledge.removed_evidence pi_admin DELETE",
  "knowledge.removed_evidence pi_admin INSERT",
  "knowledge.removed_evidence pi_admin SELECT",
  "knowledge.removed_evidence pi_writer SELECT",
  "knowledge.suppressions pi_admin DELETE",
  "knowledge.suppressions pi_admin INSERT",
  "knowledge.suppressions pi_admin SELECT",
  "knowledge.suppressions pi_writer SELECT",
];
const COLUMN_GRANTS = [
  "knowledge.erasures lift_seq pi_admin UPDATE",
  "knowledge.erasures lifted_at pi_admin UPDATE",
  "knowledge.suppressions value_fp pi_pipeline SELECT",
];

const MARK = "select policy.erasure_mark()::int as mark";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// One decision, one erasure, one removed-evidence row and one suppression, as pi_admin, each
// with its compartments; `seq` is the erasure's journal sequence number.
async function erasureRows(
  db: TestDatabase,
  query: Query,
  seq: number,
  existing?: string,
): Promise<{ erasure: string; account: string; fp: string }> {
  const account = existing ?? (await seeder(db, query).sourceAccount());
  const ruling = testId("rul");
  await query(
    `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', $3, '{own}')`,
    [ruling, testId("req"), AT],
  );
  const erasure = testId("ers");
  await query(
    `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', $3, $4, 1, 1, 0, '{own}')`,
    [erasure, ruling, seq, AT],
  );
  const fp = fingerprint(db.keys, "source_id", `erased-item-${seq}`);
  await query(
    `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
     values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, '{own}')`,
    [testId("rme"), erasure, account, fp, AT],
  );
  await query(
    `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, '{own}')`,
    [testId("sup"), erasure, fingerprint(db.keys, "address", `erased-${seq}@erasure-tests.test`), AT],
  );
  return { erasure, account, fp };
}

describe("0007: the erasure's tables", { timeout: TIMEOUT }, () => {
  it("the three tables have exactly the policies and privileges of the grants table", () =>
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
        [THREE],
      );
      const expected = THREE.flatMap((table) =>
        (POLICIES[table] ?? []).map(
          ([role, command]) => `${table} ${role}_${command.toLowerCase()} ${role} ${command}`,
        ),
      );
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(expected.sort());
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true");
      }

      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [THREE],
      );
      expect(tables).toEqual(
        [...THREE].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
      );

      const privileges = await admin<{ line: string; grantable: boolean }>(
        db,
        `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname::text, 'PUBLIC') || ' ' || a.privilege_type as line, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [THREE],
      );
      expect(privileges.map((row) => row.line).sort()).toEqual(TABLE_PRIVILEGES);
      expect(privileges.filter((row) => row.grantable)).toEqual([]);

      const columns = await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        return query<{ line: string; whole: string }>(
          `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type as line, table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type as whole
           from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
          [THREE],
        );
      });
      const byTable = new Set(TABLE_PRIVILEGES);
      expect(
        columns
          .filter((row) => !byTable.has(row.whole))
          .map((row) => row.line)
          .sort(),
      ).toEqual(COLUMN_GRANTS);
    }));

  it("the reader reads none of them, and the writer reads removed evidence and suppressions and writes neither", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, (query) => erasureRows(db, query, 1));
      const client = await insertClient(db, "erasure-tests-reader", ["own"]);
      for (const table of THREE) {
        const sql = `select count(*) from ${table}`;
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), `reader: ${table}`).toBe("42501");
        expect(one(await admin<{ count: string }>(db, sql)).count, `control: ${table}`).toBe("1");
      }
      // The control for the reader: under the same token it reads a knowledge table.
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select count(*) from knowledge.messages"))),
      ).toBeNull();

      expect(await sqlState(() => queryAs(db.urls.writer, "select count(*) from knowledge.erasures"))).toBe("42501");
      for (const table of ["knowledge.removed_evidence", "knowledge.suppressions"]) {
        expect(
          one(await queryAs<{ count: string }>(db.urls.writer, `select count(*) from ${table}`)).count,
          `writer reads ${table}`,
        ).toBe("1");
        for (const sql of [
          `insert into ${table} (id) select id from ${table} where false`,
          `update ${table} set id = id`,
          `delete from ${table}`,
        ]) {
          expect(await sqlState(() => queryAs(db.urls.writer, sql)), `pi_writer: ${sql}`).toBe("42501");
        }
        // The positive control: the admin's delete.
        expect(await sqlState(() => admin(db, `delete from ${table} where false`)), `control: ${table}`).toBeNull();
      }
    }));

  it("erasure_mark is 0 with no erasure, and the greatest sequence after an erasure and a lift", () =>
    withDatabase(async (db) => {
      expect(one(await admin<{ mark: number }>(db, MARK)).mark).toBe(0);
      const { erasure, account } = await session(db.urls.admin, (query) => erasureRows(db, query, 1));
      // Read through the function, which runs as pi_owner: without its policy on the table it
      // would see no row here.
      expect(one(await admin<{ mark: number }>(db, MARK)).mark).toBe(1);
      await admin(db, "update knowledge.erasures set lift_seq = 2, lifted_at = $2 where id = $1", [erasure, AT]);
      expect(one(await admin<{ mark: number }>(db, MARK)).mark).toBe(2);
      await session(db.urls.admin, (query) => erasureRows(db, query, 3, account));
      for (const url of [db.urls.admin, db.urls.writer, db.urls.reader, db.urls.pipeline, db.urls.work])
        expect(one(await queryAs<{ mark: number }>(url, MARK)).mark).toBe(3);
    }));

  it("pi_admin can update an agent record's evidence_id and nothing it could not update before, and ledger.agent_writes has the same policies as before this migration", () =>
    withDatabase(async (db) => {
      const updatable = await admin<{ column: string }>(
        db,
        `select a.attname as column from pg_attribute a
         where a.attrelid = 'ledger.agent_writes'::regclass and a.attnum > 0 and not a.attisdropped
           and has_column_privilege('pi_admin', 'ledger.agent_writes', a.attname, 'UPDATE') order by 1`,
      );
      // flagged_at is for `pi agent-records release`.
      expect(updatable.map((row) => row.column)).toEqual(["body_enc", "evidence_id", "flagged_at", "tainted_at"]);
      const policies = await admin<{ line: string }>(
        db,
        "select policyname || ' ' || cmd || ' ' || array_to_string(roles::text[], ',') as line from pg_policies where schemaname = 'ledger' and tablename = 'agent_writes' order by 1",
      );
      // The erasure migration adds none to these.
      expect(policies.filter((row) => row.line.includes("pi_admin")).map((row) => row.line)).toEqual([
        "pi_admin_select SELECT pi_admin",
        "pi_admin_update UPDATE pi_admin",
      ]);
      expect(await sqlState(() => admin(db, "update ledger.agent_writes set evidence_id = evidence_id"))).toBeNull();
      expect(await sqlState(() => admin(db, "update ledger.agent_writes set kind = kind"))).toBe("42501");
    }));

  it("exactly the four roles can execute it", () =>
    withDatabase(async (db) => {
      const roles = await admin<{ role: string }>(
        db,
        `select r.rolname as role from pg_roles r where r.rolname like 'pi\\_%' and has_function_privilege(r.rolname, 'policy.erasure_mark()', 'EXECUTE') order by 1`,
      );
      // pi_owner owns it. pi_work runs it for the tick's start check, pi_proxy for pi send's, and
      // pi_restricted holds every right pi_pipeline does.
      expect(roles.map((row) => row.role)).toEqual([
        "pi_admin",
        "pi_owner",
        "pi_pipeline",
        "pi_proxy",
        "pi_reader",
        "pi_restricted",
        "pi_work",
        "pi_writer",
      ]);
      const fn = one(
        await admin<{ definer: boolean; volatility: string; owner: string; public: boolean }>(
          db,
          `select p.prosecdef as definer, p.provolatile as volatility, pg_get_userbyid(p.proowner)::text as owner,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public
           from pg_proc p where p.oid = 'policy.erasure_mark()'::regprocedure`,
        ),
      );
      expect(fn).toEqual({ definer: true, volatility: "s", owner: "pi_owner", public: false });
    }));

  it("pi_pipeline can execute erasure_mark and read a suppression's fingerprint, and nothing else of this migration", () =>
    withDatabase(async (db) => {
      expect(one(await queryAs<{ mark: number }>(db.urls.pipeline, MARK)).mark).toBe(0);
      for (const table of THREE.filter((name) => name !== "knowledge.suppressions"))
        expect(await sqlState(() => queryAs(db.urls.pipeline, `select count(*) from ${table}`)), table).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select value_fp from knowledge.suppressions"))).toBeNull();
      for (const sql of [
        "select id from knowledge.suppressions",
        "select erasure_id from knowledge.suppressions",
        "select compartments from knowledge.suppressions",
        "select * from knowledge.suppressions",
        "delete from knowledge.suppressions",
        "update knowledge.suppressions set value_fp = value_fp",
      ])
        expect(await sqlState(() => queryAs(db.urls.pipeline, sql)), sql).toBe("42501");
      const held = await admin<{ table: string }>(
        db,
        `select t.name as table from unnest($1::text[]) as t(name)
         where has_table_privilege('pi_pipeline', t.name, 'SELECT') or has_table_privilege('pi_pipeline', t.name, 'INSERT')
            or has_table_privilege('pi_pipeline', t.name, 'UPDATE') or has_table_privilege('pi_pipeline', t.name, 'DELETE')`,
        [THREE],
      );
      expect(held).toEqual([]);
      expect(
        one(
          await admin<{ ok: boolean }>(
            db,
            "select has_column_privilege('pi_pipeline', 'ledger.agent_writes', 'evidence_id', 'UPDATE') as ok",
          ),
        ).ok,
      ).toBe(false);
    }));

  it("a second removed-evidence row for one source item is refused", () =>
    withDatabase(async (db) => {
      const { erasure, account, fp } = await session(db.urls.admin, (query) => erasureRows(db, query, 1));
      const insert = (itemFp: string) =>
        admin(
          db,
          `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
           values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, '{own}')`,
          [testId("rme"), erasure, account, itemFp, AT],
        );
      expect(await refusal(() => insert(fp))).toEqual({ code: "23505", constraint: "removed_evidence_source_item" });
      expect(await refusal(() => insert(fingerprint(db.keys, "source_id", "another-item")))).toBeNull();
    }));

  it("a removed-evidence row with a reason other than owner_erasure is refused", () =>
    withDatabase(async (db) => {
      const { erasure, account } = await session(db.urls.admin, (query) => erasureRows(db, query, 1));
      const insert = (reason: string, item: string) =>
        admin(
          db,
          `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
           values ($1, $2, $3, $4, '{}', $5, $6, '{own}')`,
          [testId("rme"), erasure, account, fingerprint(db.keys, "source_id", item), reason, AT],
        );
      expect(await refusal(() => insert("source_deleted", "first"))).toEqual({
        code: "23514",
        constraint: "removed_evidence_reason",
      });
      expect(await refusal(() => insert("owner_erasure", "second"))).toBeNull();
    }));

  it("a row with an empty compartments is refused, for each of the three", () =>
    withDatabase(async (db) => {
      const { erasure, account } = await session(db.urls.admin, (query) => erasureRows(db, query, 1));
      const [decision] = await admin<{ ruling_id: string }>(
        db,
        "select ruling_id from knowledge.erasures where id = $1",
        [erasure],
      );
      const inserts: Record<string, (compartments: string[]) => Promise<unknown>> = {
        "knowledge.erasures": (compartments) =>
          admin(
            db,
            `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments)
             values ($1, $2, 'item', (select coalesce(max(journal_seq), 0) + 1 from knowledge.erasures), $3, 0, 0, 0, $4)`,
            [testId("ers"), decision?.ruling_id, AT, compartments],
          ),
        "knowledge.removed_evidence": (compartments) =>
          admin(
            db,
            `insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments)
             values ($1, $2, $3, $4, '{}', 'owner_erasure', $5, $6)`,
            [testId("rme"), erasure, account, fingerprint(db.keys, "source_id", testId("item")), AT, compartments],
          ),
        "knowledge.suppressions": (compartments) =>
          admin(
            db,
            `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, $4, $5)`,
            [
              testId("sup"),
              erasure,
              fingerprint(db.keys, "address", `${testId("x").toLowerCase()}@erasure-tests.test`),
              AT,
              compartments,
            ],
          ),
      };
      for (const [table, insert] of Object.entries(inserts)) {
        expect(await refusal(() => insert([])), table).toEqual({ code: "23514", constraint: "compartments_not_empty" });
        expect(await refusal(() => insert(["own"])), `control: ${table}`).toBeNull();
      }
    }));
});
