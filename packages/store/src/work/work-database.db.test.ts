import { INTERNAL_STAGES, STAGE_PLAN } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { TABLES, WORK_TABLES } from "../test-support/catalogue.ts";
import { RUNTIME_ROLES, schemaOf } from "../test-support/catalogue-grants.ts";
import { labelFixed, labelFixedColumnGrants } from "../test-support/catalogue-labels.ts";
import {
  isWorkColumnGrant,
  RECORD_EVENTS_WORK_INSERT,
  WORK_COLUMN_GRANTS,
  WORK_GRANTS_ON_EARLIER,
  WORK_READER_CONDITIONS,
  WORK_SEALED,
  WORK_TABLE_GRANTS,
  type WorkCell,
  type WorkRole,
  workColumnsOf,
} from "../test-support/catalogue-work.ts";
import { ALL_TOOLS, ALL_VIEWS, insertClient, revokeClient, sha256Hex, testId } from "../test-support/clients.ts";
import { asOwner, one, readAs, roleState, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { readerWriteProbes } from "../test-support/probes.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { insertWorkClient, WORK_TOOLS } from "../test-support/work-clients.ts";

// Every refusal has its positive control in the same test. The functions' behaviour is in
// work-functions, work-moves, work-runs and work-order.

const AT = "2026-09-01T00:00:00Z";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const asWork = (db: TestDatabase, text: string, values?: unknown[]): Promise<string | null> =>
  sqlState(() => queryAs(db.urls.work, text, values));

const COMMAND: Record<WorkCell, string> = {
  all: "ALL",
  select: "SELECT",
  insert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
};
const PRIVILEGES: Record<WorkCell, string[]> = {
  all: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  select: ["SELECT"],
  insert: ["INSERT"],
  update: ["UPDATE"],
  delete: ["DELETE"],
};
const EARLIER = Object.keys(WORK_GRANTS_ON_EARLIER);
// The two earlier tables the reader gains a row policy on.
const READER_ON_EARLIER = EARLIER.filter((table) => WORK_GRANTS_ON_EARLIER[table]?.pi_reader !== undefined);

const madeHere = (table: string, roles: string[]): boolean =>
  !roles.includes("pi_proxy") &&
  !roles.includes("pi_notify") &&
  (WORK_TABLES.includes(table) ||
    roles.includes("pi_work") ||
    (roles.includes("pi_reader") && READER_ON_EARLIER.includes(table)));
const cellsOf = (table: string): [WorkRole, WorkCell[]][] =>
  Object.entries(WORK_TABLE_GRANTS[table] ?? WORK_GRANTS_ON_EARLIER[table] ?? {}) as [WorkRole, WorkCell[]][];

const NEW_FUNCTIONS = [
  "policy.current_client_kind",
  "ledger.work_grants",
  "ledger.check_back_blocked",
  "ledger.propose_hypothesis",
  "ledger.record_test",
  "ledger.propose_opportunity",
  "ledger.set_intention",
  "ledger.claim",
  "ledger.release",
  "ledger.plan_move",
  "ledger.report_move",
  "ledger.next_run",
  "ledger.append_step",
  "ledger.finish_run",
  "ledger.end_run",
  "ledger.spend_on",
  "ledger.basis_flagged",
];
const EXECUTE: Record<string, { definer: boolean; roles: string[] }> = {
  ...Object.fromEntries(NEW_FUNCTIONS.slice(0, 14).map((name) => [name, { definer: true, roles: ["pi_reader"] }])),
  "ledger.end_run": { definer: true, roles: ["pi_work"] },
  "ledger.spend_on": { definer: false, roles: ["pi_admin", "pi_work"] },
  "ledger.basis_flagged": { definer: true, roles: ["pi_work"] },
  // Earlier functions, which pi_work gains; and taint_citing, which it does not.
  "policy.vetoed": { definer: true, roles: ["pi_admin", "pi_work"] },
  "policy.vetoed_by": { definer: true, roles: ["pi_admin", "pi_work"] },
  "ledger.add_basis": { definer: true, roles: ["pi_admin", "pi_work", "pi_writer"] },
  "ledger.label": {
    definer: false,
    roles: ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline", "pi_work", "pi_proxy", "pi_restricted"],
  },
  "ledger.lock_rows": { definer: false, roles: ["pi_admin", "pi_pipeline", "pi_work", "pi_restricted", "pi_writer"] },
  "ledger.admit_deferred": { definer: true, roles: ["pi_admin", "pi_work"] },
  "ledger.owner_backed": { definer: true, roles: ["pi_admin", "pi_work"] },
  "policy.erasure_mark": {
    definer: true,
    roles: ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline", "pi_work", "pi_proxy", "pi_restricted"],
  },
  "ledger.taint_citing": { definer: true, roles: ["pi_admin", "pi_writer"] },
};

const REPORT_MOVE_WRAPPER = { definer: false, roles: ["pi_reader"] };

// The arguments of each function, by name and type, in order, with `session_id` after
// `request_id`, and the conventions' types where none is fixed.
const ARGUMENTS: Record<string, [string, string][]> = {
  "policy.current_client_kind": [],
  "ledger.work_grants": [],
  "ledger.check_back_blocked": [["opportunity_ids", "text[]"]],
  "ledger.propose_hypothesis": [
    ["id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["kind", "text"],
    ["about_kind", "text"],
    ["about_id", "text"],
    ["body_enc", "jsonb"],
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
    ["idea", "text"],
  ],
  "ledger.record_test": [
    ["id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["hypothesis_id", "text"],
    ["result", "text"],
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
  ],
  "ledger.propose_opportunity": [
    ["id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["kind", "text"],
    ["about_kind", "text"],
    ["about_id", "text"],
    ["hypothesis_id", "text"],
    ["due_at", "timestamp with time zone"],
    ["body_enc", "jsonb"],
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
  ],
  "ledger.set_intention/8": [
    ["id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["opportunity_id", "text"],
    ["due_at", "timestamp with time zone"],
    ["keep_earlier", "boolean"],
    ["park", "boolean"],
    ["body_enc", "jsonb"],
  ],
  "ledger.set_intention/7": [
    ["id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["opportunity_id", "text"],
    ["due_at", "timestamp with time zone"],
    ["keep_earlier", "boolean"],
    ["park", "boolean"],
  ],
  "ledger.claim": [
    ["opportunity_id", "text"],
    ["assignment_id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
  ],
  "ledger.release": [
    ["opportunity_id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["reason", "text"],
    ["record_id", "text"],
  ],
  "ledger.plan_move": [
    ["move_id", "text"],
    ["opportunity_id", "text"],
    ["stage", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["point_version", "integer"],
    ["definition_hash", "text"],
  ],
  // An overloaded name's forms are keyed by their argument count.
  "ledger.report_move/8": [
    ["move_id", "text"],
    ["outcome", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["body_enc", "jsonb"],
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
    ["lessons_applied", "text[]"],
  ],
  "ledger.report_move/7": [
    ["move_id", "text"],
    ["outcome", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    ["body_enc", "jsonb"],
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
  ],
  "ledger.next_run": [
    ["request_id", "text"],
    ["session_id", "text"],
  ],
  "ledger.append_step": [
    ["run_id", "text"],
    ["ordinal", "integer"],
    ["session_id", "text"],
    ["kind", "text"],
    ["status", "text"],
    ["tool", "text"],
    ["code", "text"],
    ["prompt_id", "text"],
    ["prompt_version", "text"],
    ["model_id", "text"],
    ["cost_microusd", "bigint"],
    ["input_tokens", "integer"],
    ["output_tokens", "integer"],
    ["ms", "integer"],
    ["result_code_points", "integer"],
    ["detail_enc", "jsonb"],
  ],
  "ledger.finish_run": [
    ["run_id", "text"],
    ["request_id", "text"],
    ["session_id", "text"],
    // The argument named `outcome` in the design: Postgres refuses an argument named as a column of the result, and
    // the answer's column is `outcome`.
    ["end_outcome", "text"],
    ["code", "text"],
    ["point_version", "integer"],
    ["definition_hash", "text"],
    ["actions", "jsonb"],
  ],
  "ledger.end_run": [
    ["run_id", "text"],
    ["outcome", "text"],
    ["code", "text"],
  ],
  "ledger.spend_on": [["day", "date"]],
  "ledger.basis_flagged": [
    ["ref_kinds", "text[]"],
    ["ref_ids", "text[]"],
  ],
};

// Each function's input arguments, read from pg_proc: names and types, in order. A name with more
// than one form (ledger.report_move) is keyed `<name>/<argument count>`.
async function argumentsOf(db: TestDatabase, names: string[]): Promise<Record<string, [string, string][]>> {
  const rows = await admin<{ name: string; names: string[] | null; modes: string[] | null; types: string[] }>(
    db,
    `select n.nspname || '.' || p.proname as name, p.proargnames::text[] as names, p.proargmodes::text[] as modes,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality as a(t, i) order by i) as types
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = any($1)`,
    [names],
  );
  const forms = (name: string): number => rows.filter((row) => row.name === name).length;
  return Object.fromEntries(
    rows.map((row) => {
      const inputs = (row.names ?? []).filter((_, index) => row.modes === null || row.modes[index] === "i");
      return [
        forms(row.name) > 1 ? `${row.name}/${row.types.length}` : row.name,
        row.types.map((type, index): [string, string] => [inputs[index] ?? "", type]),
      ];
    }),
  );
}

// One message under `own`, as pi_admin: a ref a client cleared for `own` can see.
const ownMessage = (db: TestDatabase, options?: { held?: boolean }): Promise<string> =>
  session(db.urls.admin, (query) => seeder(db, query).message(["own"], undefined, options));

describe("0008: the work tables", { timeout: DB_TEST_TIMEOUT }, () => {
  it("every table has exactly the policies and privileges of the grants table", () =>
    withDatabase(async (db) => {
      const tables = [...WORK_TABLES, ...EARLIER];

      // One policy for each cell: of every role on this migration's tables, and pi_work's and the
      // reader's new ones on the earlier tables.
      const policies = (
        await admin<{
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
          [tables],
        )
      ).filter((policy) => madeHere(policy.table, policy.roles));
      const expected = tables.flatMap((table) =>
        cellsOf(table).flatMap(([role, cells]) =>
          cells.map((cell) => `${table} ${role}_${cell} ${role} ${COMMAND[cell]}`),
        ),
      );
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(expected.sort());
      // The control for that filter: the earlier tables' own policies are there too.
      expect(
        (
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from pg_policies where schemaname = 'policy' and tablename = 'clients' and policyname = 'pi_admin_all'",
          )
        )[0]?.n,
      ).toBe(1);

      // Each is permissive; the reader's says its condition, and every other is unconditional.
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        if (policy.roles.includes("pi_reader")) {
          for (const pattern of WORK_READER_CONDITIONS[policy.table] ?? [/^$/])
            expect(policy.qual, `${label}: ${pattern.source}`).toMatch(pattern);
          expect(policy.qual, label).not.toMatch(/\bheld\b/i);
          expect(policy.check, label).toBeNull();
          continue;
        }
        if (label === "ledger.record_events pi_work_insert") {
          expect({ qual: policy.qual, check: policy.check }, label).toEqual({
            qual: null,
            check: RECORD_EVENTS_WORK_INSERT,
          });
          continue;
        }
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true");
      }

      // Forced row-level security on each new table, owned by pi_owner.
      const forced = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [WORK_TABLES],
      );
      expect(forced.map((row) => row.name).sort()).toEqual([...WORK_TABLES].sort());
      for (const row of forced) expect(row, row.name).toMatchObject({ enabled: true, forced: true, owner: "pi_owner" });

      // Table privileges by name, with no grant option and nothing for PUBLIC: every cell but the
      // owner's and those granted on columns.
      const privileges = (
        await admin<{ table: string; grantee: string; privilege: string; grantable: boolean }>(
          db,
          `select n.nspname || '.' || c.relname as "table", coalesce(g.rolname::text, 'PUBLIC') as grantee, a.privilege_type as privilege, a.is_grantable as grantable
           from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
           where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
          [tables],
        )
      ).filter((grant) => madeHere(grant.table, [grant.grantee]));
      const expectedPrivileges = tables.flatMap((table) =>
        cellsOf(table)
          .filter(([role]) => role !== "pi_owner")
          .flatMap(([role, cells]) =>
            cells
              .filter((cell) => !isWorkColumnGrant(table, role, cell))
              .flatMap((cell) => PRIVILEGES[cell].map((privilege) => `${table} ${role} ${privilege}`))
              // An update held column by column, its label columns left out.
              .filter((line) => !(line.endsWith(" UPDATE") && labelFixed(table, role))),
          ),
      );
      expect(privileges.map((grant) => `${grant.table} ${grant.grantee} ${grant.privilege}`).sort()).toEqual(
        expectedPrivileges.sort(),
      );
      expect(privileges.filter((grant) => grant.grantable)).toEqual([]);

      // Column privileges beyond what a table privilege gives: exactly the column grants of the
      // spec. Read as pi_owner, who granted them.
      const columns = await asOwner(db, (query) =>
        query<{ table: string; column: string; grantee: string; privilege: string }>(
          `select table_schema || '.' || table_name as "table", column_name::text as "column", grantee::text as grantee, privilege_type::text as privilege
           from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
          [tables],
        ),
      );
      const byTable = new Set(expectedPrivileges);
      const labels = (await session(db.urls.admin, (query) => labelFixedColumnGrants(query, tables))).filter((line) => {
        const [table, , grantee] = line.split(" ");
        return madeHere(table as string, [grantee as string]);
      });
      expect(
        columns
          .filter(
            (grant) =>
              madeHere(grant.table, [grant.grantee]) &&
              !byTable.has(`${grant.table} ${grant.grantee} ${grant.privilege}`),
          )
          .map((grant) => `${grant.table} ${grant.column} ${grant.grantee} ${grant.privilege}`)
          .sort(),
      ).toEqual([...WORK_COLUMN_GRANTS, ...labels].sort());

      // USAGE: pi_work on every schema but vault; pi_reader and pi_admin on queue, and no other
      // runtime role.
      const usage = await admin<{ role: string; schema: string; usage: boolean }>(
        db,
        `select r as role, s as schema, has_schema_privilege(r, s, 'USAGE') as usage
         from unnest(array['pi_admin', 'pi_writer', 'pi_reader', 'pi_pipeline', 'pi_work']) as r, unnest(array['policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue']) as s`,
      );
      const used = (role: string, schema: string): boolean | undefined =>
        usage.find((row) => row.role === role && row.schema === schema)?.usage;
      for (const schema of ["policy", "knowledge", "projections", "ledger", "queue"])
        expect(used("pi_work", schema), `pi_work ${schema}`).toBe(true);
      expect(used("pi_work", "vault")).toBe(false);
      expect([
        used("pi_admin", "queue"),
        used("pi_reader", "queue"),
        used("pi_writer", "queue"),
        used("pi_pipeline", "queue"),
      ]).toEqual([true, true, false, false]);
    }));

  it("the reader has no privilege on run_steps", () =>
    withDatabase(async (db) => {
      const held = one(
        await admin<{ any: boolean }>(
          db,
          `select has_table_privilege('pi_reader', 'ledger.run_steps', 'SELECT') or has_table_privilege('pi_reader', 'ledger.run_steps', 'INSERT')
             or has_table_privilege('pi_reader', 'ledger.run_steps', 'UPDATE') or has_table_privilege('pi_reader', 'ledger.run_steps', 'DELETE')
             or has_any_column_privilege('pi_reader', 'ledger.run_steps', 'SELECT, INSERT, UPDATE') as any`,
        ),
      ).any;
      expect(held).toBe(false);
      const reasoner = await insertWorkClient(db, "run-steps-reasoner", ["own"], { kind: "reasoner" });
      expect(
        await sqlState(() => readAs(db, reasoner.token, (query) => query("select count(*) from ledger.run_steps"))),
      ).toBe("42501");
      // The positive controls: under the same token it reads its attempts, and pi_work reads the steps.
      expect(
        await sqlState(() => readAs(db, reasoner.token, (query) => query("select count(*) from ledger.run_attempts"))),
      ).toBeNull();
      expect(await asWork(db, "select count(*) from ledger.run_steps")).toBeNull();
    }));

  it("record_events has the two new columns and its earlier policies unchanged", () =>
    withDatabase(async (db) => {
      const columns = await admin<{ name: string; type: string; nullable: string }>(
        db,
        `select column_name::text as name, data_type::text as type, is_nullable::text as nullable from information_schema.columns
         where table_schema = 'ledger' and table_name = 'record_events' and column_name in ('session_id', 'code') order by 1`,
      );
      expect(columns).toEqual([
        { name: "code", type: "text", nullable: "YES" },
        { name: "session_id", type: "text", nullable: "YES" },
      ]);
      const keys = await admin<{ definition: string }>(
        db,
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'ledger.record_events'::regclass and contype = 'f'",
      );
      expect(keys.map((key) => key.definition)).toContainEqual(
        expect.stringMatching(/^FOREIGN KEY \(session_id\) REFERENCES (ledger\.)?sessions\(id\)$/),
      );

      const policies = await admin<{ line: string }>(
        db,
        `select policyname || ' ' || cmd || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') as line from pg_policies
         where schemaname = 'ledger' and tablename = 'record_events' and ('pi_admin' = any (roles) or 'pi_owner' = any (roles))`,
      );
      expect(policies.map((row) => row.line).sort()).toEqual(
        [
          "pi_admin_insert INSERT - true",
          "pi_admin_select SELECT true -",
          "pi_owner_insert INSERT - true",
          "pi_owner_select SELECT true -",
          "pi_owner_update UPDATE true true",
        ].sort(),
      );

      // A code is a lower snake case word, and a session id names a session.
      const agent = await insertWorkClient(db, "record-events-agent", ["own"]);
      const insert = (code: string | null, sessionId: string | null): Promise<string | null> =>
        sqlState(() =>
          admin(
            db,
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code, session_id) values ('run', $1, 'failed', $2, 'system:test', '{own}', $3, $4)",
            [testId("run"), AT, code, sessionId],
          ),
        );
      expect(await insert("Not A Word", null)).toBe("23514");
      expect(await insert("turn_limit", testId("ses"))).toBe("23503");
      // The positive controls: a word, the client's own session, and neither.
      expect(await insert("turn_limit", agent.session)).toBeNull();
      expect(await insert(null, null)).toBeNull();
    }));

  it("the reader cannot insert, update or delete in any ledger, queue, projections or policy table", () =>
    withDatabase(async (db) => {
      const agent = await insertWorkClient(db, "reader-writes-agent", ["own"]);
      const probes = (await readerWriteProbes(db, agent.token)).filter((probe) =>
        TABLES.some(
          (table) =>
            ["ledger", "queue", "projections", "policy"].includes(schemaOf(table.name)) &&
            new RegExp(`\\b${table.name.replace(".", "\\.")}\\b`).test(probe.sql),
        ),
      );
      // Three statements for each table of those schemas, this migration's twenty among them.
      expect(probes).toHaveLength(
        TABLES.filter((table) => ["ledger", "queue", "projections", "policy"].includes(schemaOf(table.name))).length *
          3,
      );
      for (const table of WORK_TABLES)
        expect(
          probes.some((probe) => probe.sql.includes(` ${table} `) || probe.sql.endsWith(` ${table} where false`)),
          table,
        ).toBe(true);
      for (const probe of probes) {
        expect(probe.refused, probe.sql).toBe("42501");
        expect(probe.control, `control: ${probe.sql}`).toBeNull();
      }

      // Beside the function that writes the same row: propose_hypothesis writes a hypothesis
      // under the token, and the reader's own insert, update and delete of that row are refused.
      const message = await ownMessage(db);
      const id = testId("hyp");
      const body = sealUnder(
        db.keys,
        ["own"],
        { table: "ledger.hypotheses", id, column: "body_enc" },
        "A loop to close",
      );
      const written = await readAs(db, agent.token, (query) =>
        query<{ id: string | null }>(
          "select ledger.propose_hypothesis($1, $2, $3, 'open_loop', 'message', $4, $5, array['message'], array[$4]) as id",
          [id, testId("req"), agent.session, message, body],
        ),
      );
      expect(one(written).id).toBe(id);
      const row = one(
        await admin<{ case_id: string; about_owner: boolean }>(
          db,
          "select case_id, about_owner from ledger.hypotheses where id = $1",
          [id],
        ),
      );
      const statements: [string, unknown[]][] = [
        [
          `insert into ledger.hypotheses (id, request_id, created_by, compartments, session_id, case_id, kind, about_kind, about_id, about_owner, body_enc)
           values ($1, $2, $3, '{own}', $4, $5, 'open_loop', 'message', $6, false, $7)`,
          [testId("hyp"), testId("req"), `client:${agent.id}`, agent.session, row.case_id, message, body],
        ],
        ["update ledger.hypotheses set about_owner = true where id = $1", [id]],
        ["delete from ledger.hypotheses where id = $1", [id]],
      ];
      for (const [sql, values] of statements)
        expect(await sqlState(() => readAs(db, agent.token, (query) => query(sql, values))), sql).toBe("42501");
      // The row is as the function wrote it, and the reader sees it.
      expect(
        one(await admin<{ about_owner: boolean }>(db, "select about_owner from ledger.hypotheses where id = $1", [id]))
          .about_owner,
      ).toBe(false);
      expect(
        await readAs(db, agent.token, (query) => query("select id from ledger.hypotheses where id = $1", [id])),
      ).toEqual([{ id }]);
    }));

  it("pi_work cannot update or delete a row of any ledger table, or a knowledge or policy row", () =>
    withDatabase(async (db) => {
      const tables = TABLES.filter((table) => ["ledger", "knowledge", "policy"].includes(schemaOf(table.name)));
      expect(tables.length).toBeGreaterThan(WORK_TABLES.length);
      for (const { name, column } of tables) {
        expect(await asWork(db, `update ${name} set ${column} = ${column} where false`), `update ${name}`).toBe(
          "42501",
        );
        expect(await asWork(db, `delete from ${name} where false`), `delete ${name}`).toBe("42501");
      }
      // The positive controls: the lease table is updated in place and its rows deleted, and pi_work
      // reads and inserts where the grants table says.
      expect(await asWork(db, "update queue.leases set holder = holder where false")).toBeNull();
      expect(await asWork(db, "delete from queue.leases where false")).toBeNull();
      expect(await asWork(db, "select count(*) from ledger.runs")).toBeNull();
      expect(
        await asWork(
          db,
          "insert into ledger.silences (request_id, created_by, compartments, reason, wake_source, wake_key, day) values ($1, 'system:tick', '{own}', 'budget', 'daily_sweep', $2, $3)",
          [testId("req"), `goal:${testId("rul")}`, AT.slice(0, 10)],
        ),
      ).toBeNull();
    }));

  // The ledger tables whose rows a runtime role deletes, and who: the Lens inbox, which holds a pushed item
  // until the drain takes it and its fingerprints 30 days after, deleted by pi_writer's drain and by
  // pi_admin.
  const LEDGER_DELETES: Readonly<Record<string, readonly string[]>> = {
    "ledger.capture_inbox": ["pi_admin", "pi_writer"],
    // The meter's rows: the erasure alone deletes one.
    "ledger.recall_checks": ["pi_admin"],
    "ledger.surfaced_items": ["pi_admin"],
    "ledger.trigger_rechecks": ["pi_admin", "pi_pipeline"],
    "ledger.trigger_log": ["pi_admin"],
    "ledger.expected_outcomes": ["pi_admin"],
    "ledger.work_watches": ["pi_admin"],
    "ledger.outcome_links": ["pi_admin"],
    "ledger.outcome_checks": ["pi_admin"],
    "ledger.source_checks": ["pi_admin"],
    "ledger.card_name_holds": ["pi_admin"],
    // A same-person question and its answers go with an erased address, and nothing else deletes one.
    "ledger.identity_questions": ["pi_admin"],
    "ledger.identity_answers": ["pi_admin"],
    "ledger.wrong_merge_reports": ["pi_admin"],
    "ledger.relation_reports": ["pi_admin"],
    // A dream finding, a settlement and a dream merge's candidate go with an erased claim, message
    // or address (the admin's erasure hook), and nothing else deletes one.
    "ledger.dream_findings": ["pi_admin"],
    "ledger.belief_settlements": ["pi_admin"],
    "ledger.dream_identity_candidates": ["pi_admin"],
  };

  it("no runtime role can update a ledger row's plain column, or delete a ledger row", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "ledger-writes-reader", ["own"]);
      const ledger = TABLES.filter((table) => schemaOf(table.name) === "ledger");
      for (const { name, column } of ledger) {
        for (const role of RUNTIME_ROLES) {
          expect(
            await roleState(db, client.token, role, `update ${name} set ${column} = ${column} where false`),
            `${role}: update ${name}.${column}`,
          ).toBe("42501");
          const deletes = LEDGER_DELETES[name]?.includes(role) === true;
          expect(
            await roleState(db, client.token, role, `delete from ${name} where false`),
            `${role}: delete ${name}`,
          ).toBe(deletes ? null : "42501");
        }
      }
      // A same-person question's and a rule's states move under the sweep and the owner's commands, and what the
      // row is about never does: the catalogue tries that column.
      for (const role of ["pi_admin", "pi_writer"] as const)
        expect(
          await roleState(db, client.token, role, "update ledger.identity_questions set state = state where false"),
          role,
        ).toBeNull();
      expect(
        await roleState(db, client.token, "pi_admin", "update ledger.question_rules set status = status where false"),
      ).toBeNull();
      expect(
        await roleState(
          db,
          client.token,
          "pi_admin",
          "update ledger.agent_writes set evidence_id = evidence_id where false",
        ),
      ).toBeNull();
      expect(
        await sqlState(() =>
          asOwner(db, (query) => query("update ledger.runs set tainted_at = tainted_at where false")),
        ),
      ).toBeNull();
    }));

  it("pi_work cannot read the vault, a client's token hash, a secret or a veto, and cannot execute policy.withheld_items", () =>
    withDatabase(async (db) => {
      for (const sql of [
        "select count(*) from vault.evidence_items",
        "select count(*) from vault.pipeline_items",
        "select token_hash from policy.clients",
        "select count(*) from policy.secrets",
        "select count(*) from knowledge.vetoes",
        "select * from policy.withheld_items(array[]::text[])",
      ]) {
        expect(await asWork(db, sql), sql).toBe("42501");
      }
      expect(
        one(await admin<{ usage: boolean }>(db, "select has_schema_privilege('pi_work', 'vault', 'USAGE') as usage"))
          .usage,
      ).toBe(false);
      // The positive controls: pi_work reads a client's four columns and asks the veto lookup; the
      // admin reads the secrets and the vetoes; withheld_items runs as its owner.
      expect(await asWork(db, "select id, kind, status, compartments from policy.clients")).toBeNull();
      expect(await asWork(db, "select policy.vetoed(array[]::text[], array[]::text[], null)")).toBeNull();
      expect(await sqlState(() => admin(db, "select count(*) from policy.secrets"))).toBeNull();
      expect(await sqlState(() => admin(db, "select count(*) from knowledge.vetoes"))).toBeNull();
      expect(
        await sqlState(() => asOwner(db, (query) => query("select * from policy.withheld_items(array[]::text[])"))),
      ).toBeNull();
    }));

  it("pi_work reads only the listed columns of a client, a message, an event and an owner decision", () =>
    withDatabase(async (db) => {
      const tables = [
        "policy.clients",
        "knowledge.messages",
        "knowledge.events",
        "knowledge.event_details",
        "knowledge.owner_decisions",
        "knowledge.entities",
        "projections.goal_state",
      ];
      for (const table of tables) {
        const readable = await admin<{ column: string }>(
          db,
          `select a.attname::text as column from pg_attribute a
           where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege('pi_work', a.attrelid, a.attnum, 'SELECT') order by 1`,
          [table],
        );
        expect(readable.map((row) => row.column).sort(), table).toEqual([...workColumnsOf(table)].sort());
        // The control: each of these tables has columns pi_work does not read.
        const all = one(
          await admin<{ n: number }>(
            db,
            "select count(*)::int as n from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped",
            [table],
          ),
        ).n;
        expect(all, table).toBeGreaterThan(readable.length);
      }

      // pi_work sees a held message, by its five columns, and none of its sealed ones.
      const held = await ownMessage(db, { held: true });
      expect(await queryAs(db.urls.work, "select id from knowledge.messages where id = $1", [held])).toEqual([
        { id: held },
      ]);
      expect(
        await asWork(db, "select id, evidence_id, direction, thread_fp, compartments from knowledge.messages"),
      ).toBeNull();
      for (const column of ["subject_enc", "body_enc", "sender_fp", "held"])
        expect(await asWork(db, `select ${column} from knowledge.messages`), column).toBe("42501");
      expect(await asWork(db, "select details from knowledge.owner_decisions")).toBe("42501");
      expect(await asWork(db, "select id, kind, answer from knowledge.owner_decisions")).toBeNull();
      expect(await asWork(db, "select title_enc from knowledge.event_details")).toBe("42501");
      expect(await asWork(db, "select statement_enc from projections.goal_state")).toBe("42501");
    }));
});

describe("0008: the work functions' catalogue", { timeout: DB_TEST_TIMEOUT }, () => {
  it("every function is a definer function owned by pi_owner with the core's search path, and exactly the expected roles can execute it", () =>
    withDatabase(async (db) => {
      const rows = await admin<{
        oid: string;
        name: string;
        count: number;
        definer: boolean;
        owner: string;
        config: string[] | null;
        public: boolean;
        volatility: string;
      }>(
        db,
        `select p.oid::text as oid, n.nspname || '.' || p.proname as name, p.pronargs::int as count, p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as public, p.provolatile::text as volatility
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = any($1)`,
        [Object.keys(EXECUTE)],
      );
      const WRAPPED = ["ledger.report_move", "ledger.set_intention"];
      expect(rows.map((row) => row.name).sort()).toEqual([...Object.keys(EXECUTE), ...WRAPPED].sort());
      for (const row of rows) {
        const want = WRAPPED.includes(row.name) && row.count === 7 ? REPORT_MOVE_WRAPPER : EXECUTE[row.name];
        if (want === undefined) throw new Error(`no function ${row.name} in the expected table`);
        expect({ definer: row.definer, owner: row.owner, public: row.public }, row.name).toEqual({
          definer: want.definer,
          owner: "pi_owner",
          public: false,
        });
        expect(
          (row.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")),
          row.name,
        ).toEqual(["search_path=pg_catalog,policy,pg_temp"]);
        for (const role of RUNTIME_ROLES) {
          const can = one(
            await admin<{ ok: boolean }>(db, "select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [
              role,
              row.oid,
            ]),
          ).ok;
          expect(can, `${role} ${row.name}`).toBe(want.roles.includes(role));
        }
      }
      // basis_flagged is stable.
      expect(rows.find((row) => row.name === "ledger.basis_flagged")?.volatility).toBe("s");

      // And by calling: the reader gets each client's kind, and no other role may ask.
      const agent = await insertWorkClient(db, "kind-agent", ["own"]);
      const reasoner = await insertWorkClient(db, "kind-reasoner", ["own"], { kind: "reasoner" });
      const kind = (token: string | null) =>
        readAs(db, token, (query) => query<{ kind: string | null }>("select policy.current_client_kind() as kind"));
      expect(await kind(agent.token)).toEqual([{ kind: "agent" }]);
      expect(await kind(reasoner.token)).toEqual([{ kind: "reasoner" }]);
      expect(await kind(null)).toEqual([{ kind: null }]);
      for (const role of ["pi_admin", "pi_writer", "pi_pipeline", "pi_work"] as const) {
        expect(await roleState(db, agent.token, role, "select policy.current_client_kind()"), role).toBe("42501");
      }
      // pi_work runs end_run's grant and basis_flagged; the reader may not.
      expect(await asWork(db, "select ledger.basis_flagged(array[]::text[], array[]::text[])")).toBeNull();
      expect(
        await sqlState(() =>
          readAs(db, agent.token, (query) => query("select ledger.basis_flagged(array[]::text[], array[]::text[])")),
        ),
      ).toBe("42501");
    }));

  it("spend_on is not a definer function", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "spend-reader", ["own"]);
      for (const name of ["spend_on"]) {
        const row = one(
          await admin<{ definer: boolean; owner: string }>(
            db,
            `select prosecdef as definer, pg_get_userbyid(proowner)::text as owner from pg_proc where oid = 'ledger.${name}(date)'::regprocedure`,
          ),
        );
        expect(row, name).toEqual({ definer: false, owner: "pi_owner" });
        // It runs as its caller: pi_admin and pi_work read the steps, and get the day's sum.
        expect(await admin(db, `select ledger.${name}(current_date)::text as spend`), name).toEqual([{ spend: "0" }]);
        expect(await queryAs(db.urls.work, `select ledger.${name}(current_date)::text as spend`), name).toEqual([
          { spend: "0" },
        ]);
        // The control: a role that holds no EXECUTE on it is refused.
        expect(await roleState(db, client.token, "pi_reader", `select ledger.${name}(current_date)`), name).toBe(
          "42501",
        );
        expect(await roleState(db, client.token, "pi_writer", `select ledger.${name}(current_date)`), name).toBe(
          "42501",
        );
      }
    }));

  it("no function has an argument named for an author, a label, a class, a case or a run", () =>
    withDatabase(async (db) => {
      const args = await argumentsOf(db, NEW_FUNCTIONS);
      expect([...new Set(Object.keys(args).map((key) => key.split("/")[0]))].sort()).toEqual([...NEW_FUNCTIONS].sort());
      // A row's author, label, class, case, counts, about_owner, status or decision is the
      // function's to derive; a run's id is an argument only of the run functions, which name the
      // run they act on.
      const forbidden =
        /^(author|created_by|by|client|client_id|holder|compartments?|labels?|readers|clearance|class|source_class|proposed_by_class|case_id|case|counts|about_owner|decision|decided_by|intent_id|harness_mode_id|mode|effect|effect_class|destination)$/;
      const RUN_FUNCTIONS = ["ledger.next_run", "ledger.append_step", "ledger.finish_run", "ledger.end_run"];
      for (const [name, list] of Object.entries(args)) {
        for (const [arg] of list) {
          expect(arg, `${name}(${arg})`).not.toMatch(forbidden);
          if (!RUN_FUNCTIONS.includes(name)) {
            expect(arg, `${name}(${arg})`).not.toMatch(/^(run|run_id|status)$/);
          }
        }
      }
      // The control for that reading: the earlier add_basis takes a compartments argument, and the
      // query finds it.
      expect((await argumentsOf(db, ["ledger.add_basis"]))["ledger.add_basis"]?.map(([arg]) => arg)).toContain(
        "compartments",
      );
    }));

  it("each function takes the expected arguments, by name and type, in order", () =>
    withDatabase(async (db) => {
      expect(await argumentsOf(db, NEW_FUNCTIONS)).toEqual(ARGUMENTS);
    }));

  it("run_steps has no sealed column but a web step's detail_enc, and none named for a hash or an output, its counts only a model call's tokens and time; append_step has no argument for content but that one", () =>
    withDatabase(async (db) => {
      const columnsOf = async (table: string) =>
        admin<{ name: string; type: string }>(
          db,
          "select column_name::text as name, data_type::text as type from information_schema.columns where table_schema || '.' || table_name = $1 order by ordinal_position",
          [table],
        );
      const steps = await columnsOf("ledger.run_steps");
      const content = /(_enc$|_fp$|hash|output|token|text|body|summary|content)/i;
      // The two token counts, whole numbers, are the only names the pattern takes.
      const COUNTS = ["input_tokens", "output_tokens"];
      // A web step's query or URL, sealed, the one text a step holds.
      const WEB = "detail_enc";
      const counted = (column: { name: string }): boolean =>
        content.test(column.name) && !COUNTS.includes(column.name) && column.name !== WEB;
      expect(steps.filter((column) => ["jsonb", "json", "bytea"].includes(column.type))).toEqual([
        { name: WEB, type: "jsonb" },
      ]);
      expect(steps.filter(counted)).toEqual([]);
      expect(steps.filter((column) => COUNTS.includes(column.name)).map((column) => column.type)).toEqual([
        "integer",
        "integer",
      ]);
      // The pattern's columns and the expected ones, the cost among them in clear.
      expect(steps.map((column) => column.name).sort()).toEqual(
        [
          "id",
          "request_id",
          "created_at",
          "created_by",
          "run_id",
          "session_id",
          "compartments",
          "tainted_at",
          "attempt",
          "ordinal",
          "client_id",
          "kind",
          "status",
          "tool",
          "code",
          "prompt_id",
          "prompt_version",
          "model_id",
          "cost_microusd",
          "input_tokens",
          "output_tokens",
          "ms",
          "result_code_points",
          "detail_enc",
        ].sort(),
      );
      // The control for both readings: the call table holds its two hashes and its output word,
      // and the earlier events table a body.
      expect(
        (await columnsOf("ledger.decision_point_calls"))
          .filter((column) => content.test(column.name))
          .map((column) => column.name)
          .sort(),
      ).toEqual(["definition_hash", "input_hash", "output"]);
      expect(
        (await columnsOf("ledger.record_events"))
          .filter((column) => column.type === "jsonb")
          .map((column) => column.name),
      ).toEqual(["body_enc"]);

      const appendStep = (await argumentsOf(db, ["ledger.append_step"]))["ledger.append_step"] ?? [];
      expect(appendStep.length).toBeGreaterThan(0);
      for (const [arg, type] of appendStep) {
        if (arg === WEB) continue;
        if (!COUNTS.includes(arg)) expect(arg, arg).not.toMatch(content);
        expect(type, arg).not.toMatch(/json|bytea/);
      }
      expect(appendStep.filter(([arg]) => arg === WEB)).toEqual([[WEB, "jsonb"]]);
    }));

  it("the sealed columns of this migration's tables are exactly the expected four", () =>
    withDatabase(async (db) => {
      const jsonb = await admin<{ place: string }>(
        db,
        `select table_schema || '.' || table_name || '.' || column_name as place from information_schema.columns
         where table_schema || '.' || table_name = any($1) and data_type in ('jsonb', 'json', 'bytea') order by 1`,
        [[...WORK_TABLES, "ledger.record_events"]],
      );
      // The control: the earlier events table, in the same query, has its sealed body, which holds
      // a trial run's output on its `finished` event.
      expect(jsonb.map((row) => row.place).sort()).toEqual(
        [
          ...WORK_SEALED.map((one) => `${one.table}.${one.column}`),
          "ledger.opportunities.details_enc",
          "ledger.record_events.body_enc",
          "ledger.run_steps.detail_enc",
          "ledger.runs.cards",
          "ledger.runs.answers",
          "policy.work_settings.signal_roles",
          "policy.work_settings.area_defaults",
        ].sort(),
      );
    }));

  it("pi_owner has an update policy on ledger.runs, ledger.hypothesis_tests and ledger.moves for tainted_at alone", () =>
    withDatabase(async (db) => {
      const THREE = ["ledger.runs", "ledger.hypothesis_tests", "ledger.moves"];
      const policies = await admin<{ line: string }>(
        db,
        `select schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') as line
         from pg_policies where 'pi_owner' = any (roles) and cmd = 'UPDATE' and schemaname || '.' || tablename = any($1)`,
        [THREE],
      );
      expect(policies.map((row) => row.line).sort()).toEqual(
        THREE.map((table) => `${table} pi_owner_update UPDATE true true`).sort(),
      );
      // Each has tainted_at and no body to clear.
      const columns = await admin<{ place: string }>(
        db,
        `select table_schema || '.' || table_name || '.' || column_name as place from information_schema.columns
         where table_schema || '.' || table_name = any($1) and column_name in ('tainted_at', 'body_enc') order by 1`,
        [THREE],
      );
      expect(columns.map((row) => row.place).sort()).toEqual(THREE.map((table) => `${table}.tainted_at`).sort());
      // No role but pi_owner holds an update of any column of the three. Read as pi_owner, who
      // granted every privilege on them; the control is its own update of tainted_at.
      const updates = await asOwner(db, (query) =>
        query<{ line: string }>(
          `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee as line from information_schema.column_privileges
           where table_schema || '.' || table_name = any($1) and privilege_type = 'UPDATE'`,
          [THREE],
        ),
      );
      expect(updates.filter((row) => !row.line.endsWith(" pi_owner"))).toEqual([]);
      for (const table of THREE)
        expect(
          updates.map((row) => row.line),
          table,
        ).toContain(`${table} tainted_at pi_owner`);

      // And the policy lets pi_owner set it, on a row of each, which no runtime role can.
      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        for (const table of THREE) await seed.into(table)(["own"]);
      });
      const client = await insertClient(db, "taint-reader", ["own"]);
      for (const table of THREE) {
        const id = one(await admin<{ id: string }>(db, `select id from ${table} order by id limit 1`)).id;
        const updated = await asOwner(db, (query) =>
          query<{ id: string }>(`update ${table} set tainted_at = now() where id = $1 returning id`, [id]),
        );
        expect(updated, table).toEqual([{ id }]);
        for (const role of RUNTIME_ROLES)
          expect(
            await roleState(db, client.token, role, `update ${table} set tainted_at = now() where id = $1`, [id]),
            `${role} ${table}`,
          ).toBe("42501");
      }
    }));
});

describe("0008: the checks", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a second silence for one wake key, reason and day is refused, and one on the next day is taken", () =>
    withDatabase(async (db) => {
      const key = `goal:${testId("rul")}`;
      const silence = (reason: string, day: string): Promise<string | null> =>
        sqlState(() =>
          admin(
            db,
            "insert into ledger.silences (request_id, created_by, compartments, reason, wake_source, wake_key, day) values ($1, 'system:tick', '{own}', $2, 'goal_changed', $3, $4)",
            [testId("req"), reason, key, day],
          ),
        );
      expect(await silence("budget", "2026-09-01")).toBeNull();
      expect(await silence("budget", "2026-09-01")).toBe("23505");
      // The positive controls: the next day, and another reason on the same day.
      expect(await silence("budget", "2026-09-02")).toBeNull();
      expect(await silence("owner_backlog", "2026-09-01")).toBeNull();
      expect(
        one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.silences where wake_key = $1", [key]))
          .n,
      ).toBe(3);
    }));

  it("the stage plan table equals STAGE_PLAN and INTERNAL_STAGES", () =>
    withDatabase(async (db) => {
      const rows = await admin<{ kind: string; ordinal: number; stage: string; internal: boolean }>(
        db,
        "select opportunity_kind as kind, ordinal::int as ordinal, stage, internal from policy.stage_plan order by opportunity_kind, ordinal",
      );
      const plan: Record<string, string[]> = {};
      for (const row of rows) {
        plan[row.kind] = [...(plan[row.kind] ?? []), row.stage];
        expect(row.internal, `${row.kind} ${row.stage}`).toBe(
          (INTERNAL_STAGES as readonly string[]).includes(row.stage),
        );
      }
      expect(plan).toEqual(Object.fromEntries(Object.entries(STAGE_PLAN).map(([kind, stages]) => [kind, [...stages]])));
      // The control: the plan names an internal stage and one that is not.
      expect(rows.some((row) => row.internal)).toBe(true);
      expect(rows.some((row) => !row.internal)).toBe(true);
    }));

  it("a harness mode for pay with a mode other than propose is refused", () =>
    withDatabase(async (db) => {
      const agent = await insertWorkClient(db, "harness-agent", ["own"]);
      const grant = (stage: string, mode: string): Promise<string | null> =>
        sqlState(() =>
          admin(
            db,
            "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'follow_up', $3, $4, $5)",
            [testId("hrn"), agent.id, stage, mode, AT],
          ),
        );
      expect(await grant("pay", "act")).toBe("23514");
      expect(await grant("pay", "act_with_check")).toBe("23514");
      // The positive controls: pay with propose, and another stage with act.
      expect(await grant("pay", "propose")).toBeNull();
      expect(await grant("send", "act")).toBeNull();
    }));

  it("a second active reasoner is refused", () =>
    withDatabase(async (db) => {
      const first = await insertWorkClient(db, "first-reasoner", ["own"], { kind: "reasoner" });
      const reasoner = (name: string, status: string, kind = "reasoner"): Promise<string | null> =>
        sqlState(() =>
          admin(
            db,
            `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, revoked_at)
             values ($1, $2, $3, $4, 'none', 'local', '{own}', $5, $6, $7, case when $4 = 'revoked' then now() end)`,
            [testId("cli"), name, sha256Hex(`pit_test-token-${name}`), status, ALL_VIEWS, ALL_TOOLS, kind],
          ),
        );
      expect(await reasoner("second-reasoner", "active")).toBe("23505");
      // The positive controls: a revoked reasoner beside it, an agent, and a new active reasoner
      // once the first is revoked.
      expect(await reasoner("revoked-reasoner", "revoked")).toBeNull();
      expect(await reasoner("an-agent", "active", "agent")).toBeNull();
      await revokeClient(db, first);
      expect(await reasoner("next-reasoner", "active")).toBeNull();
      // A kind outside the two is refused, and a client inserted with none is an agent.
      expect(await reasoner("a-robot", "active", "robot")).toBe("23514");
      const plain = await insertClient(db, "kindless", ["own"]);
      expect(await admin(db, "select kind from policy.clients where id = $1", [plain.id])).toEqual([{ kind: "agent" }]);
    }));

  it("twelve tool names are in policy.tool_names, and log_call takes each", () =>
    withDatabase(async (db) => {
      const names = await admin<{ name: string }>(db, "select name from policy.tool_names where name = any($1)", [
        [...WORK_TOOLS],
      ]);
      expect(names.map((row) => row.name).sort()).toEqual([...WORK_TOOLS].sort());
      const client = await insertClient(db, "work-tool-caller", ["own"]);
      for (const tool of WORK_TOOLS) {
        expect(
          await sqlState(() =>
            readAs(db, client.token, (query) => query("select policy.log_call($1::text, 0, 'ok')", [tool])),
          ),
          tool,
        ).toBeNull();
      }
      // The control: a name that is not in the table is refused by its foreign key.
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) => query("select policy.log_call('send_message', 0, 'ok')")),
        ),
      ).toBe("23503");
      expect(await admin(db, "select tool from policy.calls where client_id = $1 order by id", [client.id])).toEqual(
        WORK_TOOLS.map((tool) => ({ tool })),
      );
    }));

  it("work_settings holds one row with the expected numbers", () =>
    withDatabase(async (db) => {
      const rows = await admin(
        db,
        `select max_runs_per_day::int as max_runs_per_day, max_microusd_per_day::int as max_microusd_per_day, max_pending_cards::int as max_pending_cards,
                sweep_hour_utc::int as sweep_hour_utc, calendar_lead_hours::int as calendar_lead_hours, max_turns::int as max_turns,
                max_tool_calls::int as max_tool_calls, max_output_tokens::int as max_output_tokens, max_input_code_points::int as max_input_code_points,
                ceiling_microusd_per_token::int as ceiling_microusd_per_token
         from policy.work_settings`,
      );
      expect(rows).toEqual([
        {
          max_runs_per_day: 12,
          max_microusd_per_day: 5_000_000,
          max_pending_cards: 30,
          sweep_hour_utc: 11,
          calendar_lead_hours: 24,
          max_turns: 12,
          max_tool_calls: 40,
          max_output_tokens: 4_000,
          max_input_code_points: 200_000,
          ceiling_microusd_per_token: 20,
        },
      ]);
      // The control: pi_work reads the row the tick runs by; the reader does not.
      expect(await asWork(db, "select max_turns from policy.work_settings")).toBeNull();
      const client = await insertClient(db, "settings-reader", ["own"]);
      expect(await roleState(db, client.token, "pi_reader", "select max_turns from policy.work_settings")).toBe(
        "42501",
      );
    }));
});
