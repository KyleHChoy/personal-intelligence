import { describe, expect, it } from "vitest";
import { queryAs } from "../test-support/database.ts";
import { FUNCTION_COVERAGE } from "../test-support/hidden-rows-every-function.ts";
import { withDatabase } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// Invariant 6 over the definers: every function pi_reader may execute on a database migrated to
// head, read from pg_proc, has one row in FUNCTION_COVERAGE, which says the hidden-rows test that
// calls it, the tool whose hidden-rows asks reach it, or why it cannot leak. A function granted to
// pi_reader by a new migration fails here until it is one or the other. Functions of extensions and
// of the system schemas are left out: no migration writes them.
//
// Do not weaken, skip or delete this test to make a change pass.
describe("the functions pi_reader may execute", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each has one row in the coverage map, and no row names a function it may not execute", () =>
    withDatabase(async (db) => {
      const rows = await queryAs<{ name: string }>(
        db.urls.admin,
        `select distinct n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where has_function_privilege('pi_reader', p.oid, 'EXECUTE')
           and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
           and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
         order by 1`,
      );
      const executable = rows.map((row) => row.name);
      const mapped = Object.keys(FUNCTION_COVERAGE);
      expect(
        executable.filter((name) => !mapped.includes(name)),
        "executable with no row",
      ).toEqual([]);
      expect(
        mapped.filter((name) => !executable.includes(name)),
        "a row pi_reader may not execute",
      ).toEqual([]);
    }));
});
