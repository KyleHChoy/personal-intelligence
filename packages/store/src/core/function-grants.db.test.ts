import { describe, expect, it } from "vitest";
import { FUNCTION_EXECUTORS, FUNCTION_ROLES } from "../test-support/catalogue-functions.ts";
import { queryAs } from "../test-support/database.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// The catalogue's function grants against a migrated database: each function is executed by the
// roles the catalogue names and by no other role asked, whichever migration last defined it.
describe("the catalogued functions", { timeout: DB_TEST_TIMEOUT }, () => {
  it("are each executed by exactly the roles the catalogue names", () =>
    withDatabase(async (db) => {
      const held = await queryAs<{ name: string; roles: string[] }>(
        db.urls.admin,
        `select n.nspname || '.' || p.proname as name,
           array(select r from unnest($1::text[]) r where has_function_privilege(r, p.oid, 'EXECUTE') order by 1) as roles
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname || '.' || p.proname = any($2::text[]) order by 1`,
        [[...FUNCTION_ROLES], Object.keys(FUNCTION_EXECUTORS)],
      );
      // One row a name: a function under two signatures would be two.
      expect(held.map((row) => row.name)).toEqual(Object.keys(FUNCTION_EXECUTORS).sort());
      expect(Object.fromEntries(held.map((row) => [row.name, row.roles]))).toEqual(
        Object.fromEntries(Object.entries(FUNCTION_EXECUTORS).map(([name, roles]) => [name, [...roles].sort()])),
      );
    }));
});
