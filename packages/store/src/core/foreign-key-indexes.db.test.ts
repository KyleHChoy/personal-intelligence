import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it, vi } from "vitest";
import { asOwner } from "../test-support/connections.ts";
import { withDatabase } from "../test-support/store.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Every foreign key of the migrated database has an index led by its columns, or is allowed by
// db/personal/unindexed-foreign-keys.json with its reason: by itself (`keys`), or because its
// parent's rows are never deleted (`neverDeleted`). A new unindexed key fails here until it is
// indexed or listed; a listed parent that some statement deletes from fails too.

const ROOT = repoRoot();
type Allowed = { keys: Record<string, string>; neverDeleted: Record<string, string> };
const ALLOWED: Allowed = JSON.parse(readFileSync(join(ROOT, "db/personal/unindexed-foreign-keys.json"), "utf8"));

type ForeignKey = { child: string; columns: string; parent: string; cascade: boolean };

// Each foreign key, and whether some index of its table leads with exactly its columns.
const FOREIGN_KEYS = `
  select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.confdeltype = 'c' as cascade,
         (select string_agg(a.attname, ',' order by k.n) from unnest(c.conkey) with ordinality k(attnum, n)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
         exists (select 1 from pg_index i where i.indrelid = c.conrelid
                   and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                   and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey) as indexed
  from pg_constraint c where c.contype = 'f' order by 1, 4`;

// The source that may delete rows: every non-test TypeScript file of the personal apps and
// packages, and every migration. A delete through a table name held in a variable is not seen.
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test-support") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.") && !entry.name.includes("fixtures"))
        out.push({ file: path.slice(ROOT.length + 1), text: readFileSync(path, "utf8") });
    }
  };
  for (const group of ["apps", "packages"]) walk(join(ROOT, group));
  const migrations = join(ROOT, "db/personal/migrations");
  for (const name of readdirSync(migrations))
    out.push({ file: `db/personal/migrations/${name}`, text: readFileSync(join(migrations, name), "utf8") });
  return out;
}

// A migration's delete runs once. Where it removes only rows no child can cite, it costs no scan
// worth an index: the parent is named here with its reason. Runtime code is never excused.
const MIGRATION_ONLY: Readonly<Record<string, string>> = {
  "policy.tool_names": "the removal of tool names no migration ever stored, so no call, read or record row cites one",
};

const deletesFrom = (table: string, text: string): boolean =>
  new RegExp(`delete\\s+from\\s+(only\\s+)?${table.replace(".", "\\.")}\\b`, "i").test(text);

describe("foreign key indexes", () => {
  it("every unindexed foreign key is listed with its reason, and every listing is needed", () =>
    withDatabase(async (db) => {
      const keys = await asOwner(db, (query) => query<ForeignKey & { indexed: boolean }>(FOREIGN_KEYS));
      expect(
        keys.find((key) => key.child === "vault.extraction_reviews" && key.columns === "evidence_id"),
      ).toMatchObject({ indexed: true });
      const unindexed = keys.filter((key) => !key.indexed);
      const named = (key: ForeignKey): string => `${key.child}(${key.columns})`;
      expect(
        unindexed
          .filter((key) => ALLOWED.keys[named(key)] === undefined && ALLOWED.neverDeleted[key.parent] === undefined)
          .map(named),
      ).toEqual([]);
      // No stale entry: each listed key is unindexed, and each listed parent has an unindexed child.
      expect(Object.keys(ALLOWED.keys).filter((name) => !unindexed.some((key) => named(key) === name))).toEqual([]);
      expect(
        Object.keys(ALLOWED.neverDeleted).filter(
          (parent) => !unindexed.some((key) => key.parent === parent && ALLOWED.keys[named(key)] === undefined),
        ),
      ).toEqual([]);
      // A parent listed as never deleted is deleted by no cascading key.
      expect(keys.filter((key) => key.cascade && ALLOWED.neverDeleted[key.child] !== undefined).map(named)).toEqual([]);
    }));

  it("no statement of the personal code or of a migration deletes from a parent listed as never deleted", () => {
    const files = sources();
    // The positive control: the scan finds the deletes that are there.
    expect(files.some((one) => deletesFrom("vault.evidence_items", one.text))).toBe(true);
    const found = Object.keys(ALLOWED.neverDeleted).flatMap((parent) =>
      files
        .filter((one) => deletesFrom(parent, one.text))
        .filter((one) => !(MIGRATION_ONLY[parent] !== undefined && one.file.startsWith("db/personal/migrations/")))
        .map((one) => `${parent} in ${one.file}`),
    );
    expect(found).toEqual([]);
  });
});
