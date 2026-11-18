import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import { one, refusal, session } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";

// The mirror migration's shape. Its policies, grants and functions' behaviour are
// lens-mirror-functions.db.test.ts's.

const TIMEOUT = 120_000;

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, TIMEOUT);
afterAll(async () => {
  await db?.drop();
});

const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

const MIRROR_TABLES = [
  ["ledger", "mirror_cursors"],
  ["ledger", "mirror_entries"],
] as const;

// Each function, its result, and the one runtime role that executes it. mirror_cursor and
// mirror_tokens are serve_mirror's two reads of the client's own mirror state.
const FUNCTIONS = [
  {
    signature: "ledger.end_mirror(text)",
    result: "integer",
    role: "pi_admin",
  },
  {
    signature: "ledger.taint_mirror_entities(text[])",
    result: "integer",
    role: "pi_admin",
  },
  {
    signature: "policy.mirror_cursor(text,text)",
    result:
      "TABLE(standing text, pass integer, rebuild boolean, section text, after_key text, completed_at timestamp with time zone, rebuilt_at timestamp with time zone)",
    role: "pi_reader",
  },
  {
    signature: "policy.mirror_tokens(text,text,text,text,text)",
    result: "TABLE(entry_key text, confirmed_token text)",
    role: "pi_reader",
  },
  {
    signature: "policy.serve_mirror(text,text,text,text[],text,text,text,text[],jsonb,boolean,integer,integer)",
    result:
      "TABLE(kind text, projection_id text, entry_key text, state text, reason text, ended_at timestamp with time zone, capture_key text, new_cursor_id text, pass integer, pass_complete boolean, truncated boolean)",
    role: "pi_reader",
  },
] as const;

describe("the Lens mirror migration", { timeout: TIMEOUT }, () => {
  // It applies after the Lens capture migrations: the folder's order.
  it("the mirror migration makes exactly its two tables", async () => {
    // Exactly its two tables, each with row-level security enabled and forced, owned by pi_owner.
    const tables = await queryAs<{ schema: string; name: string; enabled: boolean; forced: boolean; owner: string }>(
      db.urls.bootstrap,
      `select n.nspname as schema, c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and c.relname like '%mirror%' and n.nspname in ('policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue')
       order by 1, 2`,
    );
    expect(tables.map((row) => [row.schema, row.name])).toEqual(MIRROR_TABLES.map((table) => [...table]));
    for (const table of tables)
      expect({ enabled: table.enabled, forced: table.forced, owner: table.owner }, table.name).toEqual({
        enabled: true,
        forced: true,
        owner: "pi_owner",
      });

    // No sealed column in either, and no label on a cursor; an entry's label is checked non-empty.
    const columns = await admin<{ table: string; column: string }>(
      "select table_name::text as table, column_name::text as column from information_schema.columns where table_schema = 'ledger' and table_name in ('mirror_entries', 'mirror_cursors')",
    );
    expect(columns.filter((row) => row.column.endsWith("_enc"))).toEqual([]);
    expect(columns.filter((row) => row.column === "compartments").map((row) => row.table)).toEqual(["mirror_entries"]);
    const labelled = await admin<{ table: string }>(
      "select conrelid::regclass::text as table from pg_constraint where conname = 'compartments_not_empty' and conrelid::regclass::text like 'ledger.mirror%'",
    );
    expect(labelled.map((row) => row.table)).toEqual(["ledger.mirror_entries"]);

    // Its indexes: one live row per client, section and key; the client's ended rows;
    // GIN on the evidence ids and on the entity ids; and the cursors by client and time.
    const indexes = await admin<{ name: string; definition: string }>(
      "select indexname::text as name, indexdef as definition from pg_indexes where schemaname = 'ledger' and tablename in ('mirror_entries', 'mirror_cursors') order by 1",
    );
    expect(indexes.map((row) => row.name)).toEqual([
      "mirror_cursors_client_issued",
      "mirror_cursors_pkey",
      "mirror_entries_client_ended",
      "mirror_entries_entities",
      "mirror_entries_evidence",
      "mirror_entries_live",
      "mirror_entries_pkey",
    ]);
    const definition = (name: string): string => indexes.find((row) => row.name === name)?.definition ?? "";
    expect(definition("mirror_entries_live")).toMatch(
      /^CREATE UNIQUE INDEX mirror_entries_live ON ledger\.mirror_entries USING btree \(client_id, section, entry_key\) WHERE \(ended_at IS NULL\)$/,
    );
    expect(definition("mirror_entries_evidence")).toMatch(/USING gin \(evidence_ids\)$/);
    expect(definition("mirror_entries_entities")).toMatch(/USING gin \(entity_ids\)$/);

    // The five functions: definer, owned by pi_owner, the core's search path, no EXECUTE for
    // PUBLIC, and EXECUTE for exactly one runtime role each. The two reads are stable.
    const functions = await admin<{
      signature: string;
      result: string;
      definer: boolean;
      owner: string;
      config: string[] | null;
      public: boolean;
      volatility: string;
    }>(
      `select p.oid::regprocedure::text as signature, pg_get_function_result(p.oid) as result, p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner,
              p.provolatile::text as volatility,
              p.proconfig::text[] as config, coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as public
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'policy' and p.proname in ('serve_mirror', 'mirror_cursor', 'mirror_tokens')) or (n.nspname = 'ledger' and p.proname in ('taint_mirror_entities', 'end_mirror'))
       order by 1`,
    );
    expect(functions.map((row) => [row.signature.replaceAll(" ", ""), row.result])).toEqual(
      FUNCTIONS.map((fn) => [fn.signature, fn.result]),
    );
    for (const row of functions) {
      expect({ definer: row.definer, owner: row.owner, public: row.public }, row.signature).toEqual({
        definer: true,
        owner: "pi_owner",
        public: false,
      });
      expect(row.volatility, row.signature).toBe(row.signature.startsWith("policy.mirror_") ? "s" : "v");
      expect(
        (row.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")),
        row.signature,
      ).toEqual(["search_path=pg_catalog,policy,pg_temp"]);
      const want = FUNCTIONS.find((fn) => fn.signature === row.signature.replaceAll(" ", ""))?.role;
      for (const role of RUNTIME_ROLES) {
        const can = one(
          await admin<{ ok: boolean }>("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [
            role,
            row.signature,
          ]),
        ).ok;
        expect(can, `${role} ${row.signature}`).toBe(role === want);
      }
    }

    // The policies it adds on earlier tables, for serve_mirror as pi_owner, and no privilege for
    // any runtime role there.
    const owner = await admin<{ line: string }>(
      `select schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd as line from pg_policies
       where 'pi_owner' = any (roles) and schemaname || '.' || tablename = any ($1)`,
      [["ledger.capture_erasures", "ledger.erasure_exposures", "knowledge.projects", "knowledge.project_anchors"]],
    );
    expect(owner.map((row) => row.line).sort()).toEqual(
      [
        "ledger.capture_erasures pi_owner_select SELECT",
        "ledger.capture_erasures pi_owner_insert INSERT",
        "ledger.capture_erasures pi_owner_update UPDATE",
        "ledger.capture_erasures pi_owner_delete DELETE",
        "ledger.erasure_exposures pi_owner_select SELECT",
        "knowledge.projects pi_owner_select SELECT",
        "knowledge.projects pi_owner_insert INSERT",
        "knowledge.projects pi_owner_update UPDATE",
        "knowledge.project_anchors pi_owner_select SELECT",
      ].sort(),
    );

    // erasure_exposures' new column: nullable, a plain key to a mirror row, and its unique key.
    const link = await admin<{ type: string; nullable: string }>(
      "select data_type::text as type, is_nullable::text as nullable from information_schema.columns where table_schema = 'ledger' and table_name = 'erasure_exposures' and column_name = 'mirror_entry_id'",
    );
    expect(link).toEqual([{ type: "text", nullable: "YES" }]);
    const keys = await admin<{ name: string; definition: string }>(
      "select conname::text as name, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'ledger.erasure_exposures'::regclass and conname in ('erasure_exposures_mirror', 'erasure_exposures_mirror_entry_id_fkey') order by 1",
    );
    expect(keys).toEqual([
      { name: "erasure_exposures_mirror", definition: "UNIQUE (erasure_id, mirror_entry_id)" },
      {
        name: "erasure_exposures_mirror_entry_id_fkey",
        definition: "FOREIGN KEY (mirror_entry_id) REFERENCES ledger.mirror_entries(id)",
      },
    ]);
  });

  it("erasure_exposures takes exactly one of an exposure, a memory exposure and a mirror entry", async () => {
    const made = await session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      const erasure = String(await seed.into("knowledge.erasures")(["own"]));
      const second = String(await seed.into("knowledge.erasures")(["own"]));
      const exposure = String(await seed.into("ledger.exposures")(["own"]));
      await seed.into("ledger.memory_exposures")(["own"]);
      const memory = one(await query<{ id: string }>("select max(id)::text as id from ledger.memory_exposures")).id;
      const mirror = await seed.mirrorEntry(["own"]);
      return { erasure, second, exposure, memory, mirror };
    });
    const link = (
      erasure: string,
      columns: { exposure_id?: string; memory_exposure_id?: string; mirror_entry_id?: string },
    ) => {
      const names = Object.keys(columns);
      const values = Object.values(columns);
      return refusal(() =>
        admin(
          `insert into ledger.erasure_exposures (erasure_id, ${[...names, "compartments"].join(", ")}) values ($1, ${values.map((_, index) => `$${index + 2}`).join(", ")}${values.length > 0 ? ", " : ""}'{own}')`,
          [erasure, ...values],
        ),
      );
    };
    const ONE = { code: "23514", constraint: "erasure_exposures_one" };

    // None, two or three of them: refused by the restated check, and nothing is written.
    expect(await link(made.erasure, {})).toEqual(ONE);
    expect(await link(made.erasure, { exposure_id: made.exposure, mirror_entry_id: made.mirror })).toEqual(ONE);
    expect(await link(made.erasure, { memory_exposure_id: made.memory, mirror_entry_id: made.mirror })).toEqual(ONE);
    expect(await link(made.erasure, { exposure_id: made.exposure, memory_exposure_id: made.memory })).toEqual(ONE);
    expect(
      await link(made.erasure, {
        exposure_id: made.exposure,
        memory_exposure_id: made.memory,
        mirror_entry_id: made.mirror,
      }),
    ).toEqual(ONE);
    expect(
      one(
        await admin<{ n: number }>("select count(*)::int as n from ledger.erasure_exposures where erasure_id = $1", [
          made.erasure,
        ]),
      ).n,
    ).toBe(0);

    // Exactly one: each of the three links (the controls).
    expect(await link(made.erasure, { mirror_entry_id: made.mirror })).toBeNull();
    expect(await link(made.erasure, { exposure_id: made.exposure })).toBeNull();
    expect(await link(made.erasure, { memory_exposure_id: made.memory })).toBeNull();

    // A mirror row is linked once per erasure (erasure_exposures_mirror), and by another erasure
    // too; a mirror id with no row is refused by the key.
    expect(await link(made.erasure, { mirror_entry_id: made.mirror })).toEqual({
      code: "23505",
      constraint: "erasure_exposures_mirror",
    });
    expect(await link(made.second, { mirror_entry_id: made.mirror })).toBeNull();
    expect((await link(made.second, { mirror_entry_id: `mir_${"0".repeat(40)}` }))?.code).toBe("23503");
    expect(
      (
        await admin<{ mirror: string | null }>(
          "select mirror_entry_id as mirror from ledger.erasure_exposures where mirror_entry_id is not null order by erasure_id",
        )
      ).map((row) => row.mirror),
    ).toEqual([made.mirror, made.mirror]);
  });
});
