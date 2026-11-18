import { describe, expect, it } from "vitest";
import { insertClient, testId } from "../test-support/clients.ts";
import { one, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// The database's gate for documents. Written in SQL as each role, with the rows seeded as pi_admin.
// Every refusal has its positive control in the same test, and a permission refusal is SQLSTATE
// 42501.

const TIMEOUT = 180_000;
const TABLES = ["knowledge.documents", "policy.drive_roots"];
// pi_restricted holds a copy of each of pi_pipeline's cells.
const ROLES = ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline", "pi_restricted"] as const;
type Role = (typeof ROLES)[number];

// The expected table grants: each cell one policy and the same privileges, but a document's update,
// which pi_admin and pi_writer hold on every column but its label.
const GRANTS: Record<string, Partial<Record<Role, string[]>>> = {
  "policy.drive_roots": { pi_admin: ["SELECT", "INSERT", "UPDATE", "DELETE"], pi_writer: ["SELECT"] },
  "knowledge.documents": {
    pi_admin: ["SELECT", "INSERT", "DELETE"],
    pi_writer: ["SELECT", "INSERT", "DELETE"],
    pi_reader: ["SELECT"],
    pi_pipeline: ["SELECT"],
    pi_restricted: ["SELECT"],
  },
};

const urlOf = (db: TestDatabase, role: Exclude<Role, "pi_restricted">): string =>
  role === "pi_admin"
    ? db.urls.admin
    : role === "pi_writer"
      ? db.urls.writer
      : role === "pi_pipeline"
        ? db.urls.pipeline
        : db.urls.reader;

// A root sealed under `own` and a document under it, held or not, in `own`.
async function seedDocuments(db: TestDatabase): Promise<{ rootId: string; shown: string; held: string }> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const account = await seed.documentAccount(["own"]);
    const rootId = await seed.driveRoot(account.label, "fldGdGateRoot0001");
    const shown = await seed.document(["own"], { accountId: account.id, rootId });
    const held = await seed.document(["own"], {
      accountId: account.id,
      rootId,
      held: true,
      title: "Reset your password",
    });
    return { rootId, shown, held };
  });
}

describe("the documents gate", { timeout: TIMEOUT }, () => {
  it("the two tables have exactly the policies and privileges of the grants table, for every role", () =>
    withDatabase(async (db) => {
      const policies = await queryAs<{
        table: string;
        name: string;
        roles: string[];
        cmd: string;
        permissive: string;
        qual: string | null;
        check: string | null;
      }>(
        db.urls.admin,
        `select schemaname || '.' || tablename as "table", policyname::text as name, roles::text[] as roles, cmd, permissive, qual, with_check as "check"
         from pg_policies where schemaname || '.' || tablename = any($1)`,
        [TABLES],
      );
      expect(
        policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
      ).toEqual(
        [
          "policy.drive_roots pi_admin_all pi_admin ALL",
          "policy.drive_roots pi_writer_select pi_writer SELECT",
          "knowledge.documents pi_admin_all pi_admin ALL",
          "knowledge.documents pi_writer_all pi_writer ALL",
          "knowledge.documents pi_reader_select pi_reader SELECT",
          "knowledge.documents pi_pipeline_select pi_pipeline SELECT",
          // write_typed_claims reads a document as pi_owner, to refuse a claim that cites a held one.
          "knowledge.documents pi_owner_select pi_owner SELECT",
          "knowledge.documents pi_restricted_select pi_restricted SELECT",
        ].sort(),
      );
      for (const policy of policies) {
        const label = `${policy.table} ${policy.name}`;
        expect(policy.permissive, label).toBe("PERMISSIVE");
        if (policy.name === "pi_reader_select") {
          // The clearance rule every knowledge table has, and the hold.
          expect(policy.qual, label).toMatch(/select\s+(policy\.)?client_clearance\(\)/i);
          expect(policy.qual, label).toMatch(/\bnot\s*\(*\s*(documents\.)?held\b/i);
          expect(policy.check, label).toBeNull();
          continue;
        }
        // pi_pipeline's policy on a labelled table sees no restricted row, and pi_restricted's restricted rows
        // alone.
        expect(policy.qual, label).toBe(
          label === "knowledge.documents pi_pipeline_select"
            ? "(true AND (NOT policy.is_restricted(compartments)))"
            : label === "knowledge.documents pi_restricted_select"
              ? "(true AND policy.is_restricted(compartments))"
              : "true",
        );
        expect(policy.check, label).toBe(policy.cmd === "SELECT" ? null : "true");
      }

      // The table privileges, from the catalogue: exactly the cells, none grantable, none to PUBLIC.
      const privileges = await queryAs<{ table: string; grantee: string; privilege: string; grantable: boolean }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as "table", coalesce(g.rolname::text, 'PUBLIC') as grantee, a.privilege_type::text as privilege, a.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
         where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
        [TABLES],
      );
      const expected = Object.entries(GRANTS).flatMap(([table, cells]) =>
        Object.entries(cells).flatMap(([role, list]) => list.map((privilege) => `${table} ${role} ${privilege}`)),
      );
      expect(privileges.map((grant) => `${grant.table} ${grant.grantee} ${grant.privilege}`).sort()).toEqual(
        expected.sort(),
      );
      expect(privileges.filter((grant) => grant.grantable)).toEqual([]);

      // And as each role sees it: every privilege it was granted, and no other.
      for (const table of TABLES) {
        for (const role of ROLES) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            const has = one(
              await queryAs<{ has: boolean }>(db.urls.admin, "select has_table_privilege($1, $2, $3) as has", [
                role,
                table,
                privilege,
              ]),
            ).has;
            expect(has, `${role} ${privilege} ${table}`).toBe(GRANTS[table]?.[role]?.includes(privilege) === true);
          }
        }
      }
      // Both tables force row-level security, and are owned by pi_owner.
      const tables = await queryAs<{ name: string; forced: boolean; owner: string }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as name, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [TABLES],
      );
      expect(tables).toEqual([
        { name: "knowledge.documents", forced: true, owner: "pi_owner" },
        { name: "policy.drive_roots", forced: true, owner: "pi_owner" },
      ]);
    }));

  it("the reader cannot read a root, and the pipeline cannot read one", () =>
    withDatabase(async (db) => {
      const { rootId } = await seedDocuments(db);
      const client = await insertClient(db, "own-only", ["own"]);
      const select = "select id, root_enc from policy.drive_roots";

      expect(await sqlState(() => readAs(db, client.token, (query) => query(select)))).toBe("42501");
      expect(await sqlState(() => readAs(db, null, (query) => query(select)))).toBe("42501");
      expect(await sqlState(() => queryAs(db.urls.pipeline, select))).toBe("42501");
      // The positive controls: the admin and the writer read the root, and the reader under the
      // same token reads the documents table.
      for (const url of [db.urls.admin, db.urls.writer])
        expect((await queryAs<{ id: string }>(url, select)).map((row) => row.id)).toEqual([rootId]);
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select id from knowledge.documents"))),
      ).toBeNull();
      expect(await sqlState(() => queryAs(db.urls.pipeline, "select id from knowledge.documents"))).toBeNull();
    }));

  it("the writer cannot change a root", () =>
    withDatabase(async (db) => {
      const { rootId } = await seedDocuments(db);
      const id = testId("drt");
      const root = "fldGdGateWriter0001";
      const insert: [string, unknown[]] = [
        "insert into policy.drive_roots (id, label, kind, root_fp, mode, created_at, root_enc) values ($1, 'personal', 'folder', $2, 'extract', now(), $3)",
        [
          id,
          fingerprint(db.keys, "source_id", root),
          sealRow(db.keys, "own", { table: "policy.drive_roots", id, column: "root_enc" }, root),
        ],
      ];
      const update: [string, unknown[]] = ["update policy.drive_roots set mode = 'reference' where id = $1", [rootId]];
      const remove: [string, unknown[]] = ["delete from policy.drive_roots where id = $1", [id]];

      for (const [sql, values] of [insert, update, remove]) {
        expect(await sqlState(() => queryAs(db.urls.writer, sql, values)), `pi_writer: ${sql}`).toBe("42501");
        // The positive control: the admin's same statement.
        expect(await sqlState(() => queryAs(db.urls.admin, sql, values)), `pi_admin: ${sql}`).toBeNull();
      }
      // The admin's statements ran: the mode changed and the inserted root is gone again.
      expect(await queryAs(db.urls.admin, "select id, mode from policy.drive_roots order by id")).toEqual([
        { id: rootId, mode: "reference" },
      ]);
      // The writer still reads it.
      expect(await sqlState(() => queryAs(db.urls.writer, "select id from policy.drive_roots"))).toBeNull();
    }));

  it("the reader sees no held document row, and the writer and the admin see it", () =>
    withDatabase(async (db) => {
      const { shown, held } = await seedDocuments(db);
      const client = await insertClient(db, "own-only", ["own"]);
      const select = "select id from knowledge.documents order by id";
      const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

      // Not by id, not by the flag, and not in a count.
      expect(ids(await readAs(db, client.token, (query) => query<{ id: string }>(select)))).toEqual([shown]);
      expect(
        await readAs(db, client.token, (query) => query("select id from knowledge.documents where id = $1", [held])),
      ).toEqual([]);
      expect(await readAs(db, client.token, (query) => query("select id from knowledge.documents where held"))).toEqual(
        [],
      );
      expect(
        one(
          await readAs(db, client.token, (query) =>
            query<{ n: number }>("select count(id)::int as n from knowledge.documents"),
          ),
        ).n,
      ).toBe(1);
      // The reader cannot release it.
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) =>
            query("update knowledge.documents set held = false where id = $1", [held]),
          ),
        ),
      ).toBe("42501");

      // The positive controls: the writer, the admin and the pipeline see both rows.
      const both = [shown, held].sort();
      for (const role of ["pi_writer", "pi_admin", "pi_pipeline"] as const)
        expect(ids(await queryAs<{ id: string }>(urlOf(db, role), select)), role).toEqual(both);
      // And the reader sees the held row once it is released.
      await queryAs(db.urls.admin, "update knowledge.documents set held = false where id = $1", [held]);
      expect(ids(await readAs(db, client.token, (query) => query<{ id: string }>(select)))).toEqual(both);
      // A client cleared for another compartment sees neither.
      const other = await insertClient(db, "employer-only", ["employer:example"]);
      expect(await readAs(db, other.token, (query) => query(select))).toEqual([]);
    }));

  it("a document row whose compartment is not its account's is refused", () =>
    withDatabase(async (db) => {
      await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const ownAccount = await seed.documentAccount(["own"]);
        const rootId = await seed.driveRoot(ownAccount.label, "fldGdGateCompartment0001");
        expect(await refusal(() => seed.document(["employer:example"], { accountId: ownAccount.id, rootId }))).toEqual({
          code: "23503",
          constraint: "documents_account_compartments",
        });
        expect(
          await refusal(() => seed.document(["own", "employer:example"], { accountId: ownAccount.id, rootId })),
        ).toEqual({ code: "23503", constraint: "documents_account_compartments" });
        // The positive control: the same row under its account's compartment.
        expect(await refusal(() => seed.document(["own"], { accountId: ownAccount.id, rootId }))).toBeNull();
        expect(one(await query<{ n: number }>("select count(*)::int as n from knowledge.documents")).n).toBe(1);
      });
    }));
});
