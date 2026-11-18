import { describe, expect, it } from "vitest";
import { ALL_VIEWS, insertClient, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, session, sqlState } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { withDatabase } from "../test-support/store.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 180_000;
const FP = "c".repeat(64);
const BODY = { v: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
const ROLES = ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline", "pi_work", "pi_proxy"] as const;

// Every (tool, kind) pair ledger.agent_writes takes: each on `main` before this migration, and
// this migration's two. Whichever later migration widens either check keeps them all.
const PAIRS: readonly (readonly [string, string])[] = [
  ["record", "note"],
  ["record", "finding"],
  ["record", "handoff"],
  ["propose_about_you", "proposal"],
  ["import_memory", "memory_change"],
];
const KINDS = ["note", "finding", "handoff", "proposal", "memory_change"];

// The expected grants, for the two new tables and the one cell added on
// ledger.memory_projections: each cell is one policy named <role>_<command>.
const POLICIES: Record<string, string[]> = {
  "ledger.restatement_checks": [
    "pi_admin_select SELECT",
    "pi_admin_update UPDATE",
    "pi_owner_insert INSERT",
    "pi_owner_select SELECT",
  ],
  "ledger.memory_imports": [
    "pi_admin_select SELECT",
    "pi_owner_insert INSERT",
    "pi_owner_select SELECT",
    "pi_owner_update UPDATE",
    "pi_writer_select SELECT",
    "pi_writer_update UPDATE",
  ],
  "ledger.memory_projections": [
    "pi_admin_select SELECT",
    "pi_owner_insert INSERT",
    "pi_owner_select SELECT",
    "pi_owner_update UPDATE",
    "pi_writer_select SELECT",
  ],
};
// What each runtime role may do on them, by privilege, table-wide ("SELECT") or on named
// columns ("UPDATE (a, b)"). A role not named holds nothing.
const PRIVILEGES: Record<string, Partial<Record<(typeof ROLES)[number], string[]>>> = {
  "ledger.restatement_checks": { pi_admin: ["SELECT", "UPDATE (cleared_at, cleared_by)"] },
  "ledger.memory_imports": { pi_admin: ["SELECT"], pi_writer: ["SELECT", "UPDATE (mark, record_id)"] },
  "ledger.memory_projections": {
    pi_admin: ["SELECT"],
    pi_writer: ["SELECT (client_id, ended_at, evidence_ids, first_served_at, id, line_fp, tainted_at)"],
  },
};

// Every function this migration makes or replaces, and the roles that execute it.
const FUNCTIONS: Record<string, string | string[]> = {
  "policy.propose_about_you(text,text,text,text,text,text,text[],text[],text[],jsonb)": "pi_reader",
  "policy.import_memory(text,jsonb,text[])": "pi_reader",
  "policy.confirmed_preferences()": "pi_reader",
  "ledger.session_reads(text)": "pi_pipeline",
  "ledger.check_restatement(text,text,text,text,text,integer)": "pi_pipeline",
  "ledger.stale_restatements()": "pi_work",
  "policy.append_record(text,text,text,text,text,text,text[],text[],jsonb,text[],text,text)": "pi_reader",
  "policy.serve_memory(text,text[],text[],text[],text[],jsonb,text[],boolean,text[],boolean,text[],jsonb)": "pi_reader",
  // And the reader, for find_facts' tier of a confirmed person.
  "policy.confirmed_claims(text[])": ["pi_pipeline", "pi_admin", "pi_reader"],
  "ledger.expire_agent_claims()": "pi_pipeline",
  "ledger.add_agent_claim_basis(text,text[])": "pi_pipeline",
};

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// Statements as pi_owner in one transaction that is always rolled back.
const asOwner = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      return await fn(query);
    } finally {
      await query("rollback");
    }
  });
// What one statement as pi_owner was refused with, constraint included, or null; rolled back.
async function ownerRefusal(
  db: TestDatabase,
  sql: string,
  values: unknown[],
): Promise<{ code: string; constraint?: string } | null> {
  try {
    await asOwner(db, (query) => query(sql, values));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    return {
      code: String(error.code),
      ...("constraint" in error && typeof error.constraint === "string" ? { constraint: error.constraint } : {}),
    };
  }
  return null;
}

// A client and a session of it, committed as pi_owner, for rows the tests then write.
async function clientAndSession(db: TestDatabase): Promise<{ client: string; session: string }> {
  const client = await insertClient(db, `rest-${testId("n").slice(-8).toLowerCase()}`, ["own"]);
  const sessionId = testId("ses");
  await session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("insert into ledger.sessions (id, client_id, compartments) values ($1, $2, '{own}')", [
      sessionId,
      client.id,
    ]);
  });
  return { client: client.id, session: sessionId };
}

const INSERT_WRITE = `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc, proposal_scope)
  values ($1, $2, 'rest', $3, $4, $5, $6, '{own}', $7, $8, $8, $9, $10, $11)`;
const writeValues = (
  at: { client: string; session: string },
  tool: string,
  kind: string,
  over: { cites?: string[]; scope?: string | null } = {},
): unknown[] => [
  testId("rec"),
  at.client,
  at.session,
  `request-${testId("r").slice(-16)}`,
  tool,
  kind,
  ALL_VIEWS,
  FP,
  over.cites ?? [],
  BODY,
  over.scope === undefined ? (kind === "proposal" ? "all" : null) : over.scope,
];

describe("NNNN: ledger.agent_writes", { timeout: TIMEOUT }, () => {
  it("agent_writes_kind and agent_writes_tool hold exactly the pinned lists", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      // Every pair of a tool of the agent lane or another tool and a kind pinned or not.
      for (const tool of ["record", "propose_about_you", "import_memory", "search"]) {
        for (const kind of [...KINDS, "observation", "decision", "Note"]) {
          const refused = await ownerRefusal(db, INSERT_WRITE, writeValues(at, tool, kind));
          const pinned = PAIRS.some(([t, k]) => t === tool && k === kind);
          expect(refused?.code ?? null, `${tool} ${kind}`).toBe(pinned ? null : "23514");
        }
      }
      // Both checks are on the table by name.
      const names = await admin<{ name: string }>(
        db,
        "select conname::text as name from pg_constraint where conrelid = 'ledger.agent_writes'::regclass and contype = 'c' and conname in ('agent_writes_kind', 'agent_writes_tool') order by 1",
      );
      expect(names.map((row) => row.name)).toEqual(["agent_writes_kind", "agent_writes_tool"]);
    }));

  it("a proposal has a scope of all or this_client, and no other kind has one", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      for (const [kind, tool, scope] of [
        ["proposal", "propose_about_you", null],
        ["proposal", "propose_about_you", "everyone"],
        ["note", "record", "all"],
        ["memory_change", "import_memory", "this_client"],
      ] as const) {
        expect(
          (await ownerRefusal(db, INSERT_WRITE, writeValues(at, tool, kind, { scope })))?.constraint,
          `${kind} ${scope}`,
        ).toBe("agent_writes_proposal_scope");
      }
      for (const scope of ["all", "this_client"])
        expect(
          await ownerRefusal(db, INSERT_WRITE, writeValues(at, "propose_about_you", "proposal", { scope })),
          scope,
        ).toBeNull();
    }));

  it("a memory change cites nothing", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      expect(
        (await ownerRefusal(db, INSERT_WRITE, writeValues(at, "import_memory", "memory_change", { cites: [FP] })))
          ?.constraint,
      ).toBe("agent_writes_memory_cites");
      // The controls: none, and a cite on a note.
      expect(await ownerRefusal(db, INSERT_WRITE, writeValues(at, "import_memory", "memory_change"))).toBeNull();
      expect(await ownerRefusal(db, INSERT_WRITE, writeValues(at, "record", "note", { cites: [FP] }))).toBeNull();
    }));

  it("proposal_scope and turn_id are clear text columns, null by default", () =>
    withDatabase(async (db) => {
      const columns = await admin<{ name: string; type: string; nullable: string; fallback: string | null }>(
        db,
        `select column_name::text as name, data_type::text as type, is_nullable::text as nullable, column_default::text as fallback from information_schema.columns
         where table_schema = 'ledger' and table_name = 'agent_writes' and column_name in ('proposal_scope', 'turn_id') order by 1`,
      );
      expect(columns).toEqual([
        { name: "proposal_scope", type: "text", nullable: "YES", fallback: null },
        { name: "turn_id", type: "text", nullable: "YES", fallback: null },
      ]);
    }));

  it("policy.tool_names holds propose_about_you and import_memory", () =>
    withDatabase(async (db) => {
      expect(
        (
          await admin<{ name: string }>(
            db,
            "select name from policy.tool_names where name in ('propose_about_you', 'import_memory') order by 1",
          )
        ).map((row) => row.name),
      ).toEqual(["import_memory", "propose_about_you"]);
    }));
});

describe("NNNN: the two new tables and the projection's line", { timeout: TIMEOUT }, () => {
  it("both new tables force row-level security, are owned by pi_owner and have compartments_not_empty", () =>
    withDatabase(async (db) => {
      const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
        db,
        `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
        [["ledger.restatement_checks", "ledger.memory_imports"]],
      );
      expect(tables).toEqual([
        { name: "ledger.memory_imports", enabled: true, forced: true, owner: "pi_owner" },
        { name: "ledger.restatement_checks", enabled: true, forced: true, owner: "pi_owner" },
      ]);
      const checks = await admin<{ table: string }>(
        db,
        "select conrelid::regclass::text as table from pg_constraint where conname = 'compartments_not_empty' and conrelid = any(array['ledger.restatement_checks'::regclass, 'ledger.memory_imports'::regclass]) order by 1",
      );
      expect(checks.map((row) => row.table)).toEqual(["ledger.memory_imports", "ledger.restatement_checks"]);
    }));

  it("the grants equal the expected table", () =>
    withDatabase(async (db) => {
      const policies = await admin<{ table: string; line: string }>(
        db,
        "select schemaname || '.' || tablename as table, policyname || ' ' || cmd as line from pg_policies where schemaname || '.' || tablename = any($1)",
        [Object.keys(POLICIES)],
      );
      for (const [table, lines] of Object.entries(POLICIES)) {
        expect(
          policies
            .filter((row) => row.table === table)
            .map((row) => row.line)
            .sort(),
          table,
        ).toEqual([...lines].sort());
      }
      // Each role's privileges, from the catalogue: table-wide, or the columns it holds one on.
      for (const table of Object.keys(PRIVILEGES)) {
        for (const role of ROLES) {
          const held: string[] = [];
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            if (
              one(
                await admin<{ ok: boolean }>(db, "select has_table_privilege($1::name, $2::text, $3::text) as ok", [
                  role,
                  table,
                  privilege,
                ]),
              ).ok
            ) {
              held.push(privilege);
              continue;
            }
            if (privilege === "DELETE") continue;
            const columns = await admin<{ name: string }>(
              db,
              "select attname::text as name from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and has_column_privilege($2::name, attrelid, attname, $3::text) order by 1",
              [table, role, privilege],
            );
            if (columns.length > 0) held.push(`${privilege} (${columns.map((column) => column.name).join(", ")})`);
          }
          expect(held, `${role} ${table}`).toEqual(PRIVILEGES[table]?.[role] ?? []);
        }
      }
    }));

  it("pi_reader cannot select either new table", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "rest-reader", ["own"]);
      for (const table of ["ledger.restatement_checks", "ledger.memory_imports"]) {
        expect(
          await sqlState(() => readAs(db, client.token, (query) => query(`select count(*) from ${table}`))),
          table,
        ).toBe("42501");
        // The control: the admin reads it.
        expect(await sqlState(() => admin(db, `select count(*) from ${table}`)), table).toBeNull();
      }
    }));

  it("pi_pipeline cannot select ledger.read_log or ledger.restatement_checks, and can execute the two functions", () =>
    withDatabase(async (db) => {
      const asPipeline = (sql: string): Promise<string | null> => sqlState(() => queryAs(db.urls.pipeline, sql));
      for (const table of ["ledger.restatement_checks", "ledger.memory_imports", "ledger.memory_projections"]) {
        expect(await asPipeline(`select count(*) from ${table}`), table).toBe("42501");
      }
      // The read log's fact keys, times and labels alone, for the shadow sampler.
      expect(await asPipeline("select session_id, client_id, shown from ledger.read_log"), "ledger.read_log").toBe(
        "42501",
      );
      expect(await asPipeline("insert into ledger.restatement_checks (claim_key) values ('x')")).toBe("42501");
      // The controls: the two functions it executes, beside the refusals.
      expect(await asPipeline(`select * from ledger.session_reads('${FP}')`)).toBeNull();
      // An evidence id of no agent record is refused by the function itself, not by a grant.
      expect(await asPipeline(`select * from ledger.check_restatement('${FP}', '${FP}', 'new', null, null, 1)`)).toBe(
        "42501",
      );
      expect(
        one(
          await admin<{ ok: boolean }>(
            db,
            "select has_function_privilege('pi_pipeline', 'ledger.check_restatement(text,text,text,text,text,integer)', 'EXECUTE') as ok",
          ),
        ).ok,
      ).toBe(true);
    }));

  it("pi_writer reads seven columns of a projection and writes none, and pi_work reads neither new table", () =>
    withDatabase(async (db) => {
      const asWriter = (sql: string): Promise<string | null> => sqlState(() => queryAs(db.urls.writer, sql));
      expect(
        await asWriter(
          "select id, client_id, evidence_ids, first_served_at, ended_at, tainted_at, line_fp from ledger.memory_projections",
        ),
      ).toBeNull();
      for (const sql of [
        "select audience from ledger.memory_projections",
        "select fact_key_fp from ledger.memory_projections",
        "update ledger.memory_projections set line_fp = null",
        "delete from ledger.memory_projections",
        "select count(*) from ledger.restatement_checks",
        "delete from ledger.memory_imports",
      ]) {
        expect(await asWriter(sql), sql).toBe("42501");
      }
      expect(
        await asWriter("update ledger.memory_imports set mark = mark, record_id = record_id where false"),
      ).toBeNull();
      for (const table of ["ledger.restatement_checks", "ledger.memory_imports"]) {
        expect(await sqlState(() => queryAs(db.urls.work, `select count(*) from ${table}`)), table).toBe("42501");
      }
    }));

  it("ledger.restatement_checks: a fingerprint key, one of four answers, reached and the matched key as the answer needs, cleared with its decision, one row per key", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      const record = testId("rec");
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(INSERT_WRITE, [record, ...writeValues(at, "record", "finding").slice(1)]);
      });
      const INSERT = `insert into ledger.restatement_checks (client_id, record_id, claim_key, answer, reached, matched_fact_key_fp, decision_version, checked_at, cleared_at, cleared_by, compartments)
        values ($1, $2, $3, $4, $5, $6, 1, now(), $7, $8, '{own}')`;
      const row = (over: {
        key?: string;
        answer?: string;
        reached?: string | null;
        matched?: string | null;
        cleared?: boolean;
      }): unknown[] => [
        at.client,
        record,
        over.key ?? FP,
        over.answer ?? "echo",
        over.reached === undefined ? "read" : over.reached,
        over.matched === undefined ? FP : over.matched,
        over.cleared === true ? new Date() : null,
        null,
      ];
      for (const [name, values] of [
        ["a key off its form", row({ key: "C".repeat(64) })],
        ["an answer of another word", row({ answer: "same" })],
        ["new with a reach", row({ answer: "new", matched: null })],
        ["echo with no reach", row({ reached: null })],
        ["a reach of another word", row({ reached: "seen" })],
        ["stale with no matched key", row({ answer: "stale", matched: null })],
        ["new with a matched key", row({ answer: "new", reached: null })],
        ["cleared with no decision", row({ cleared: true })],
      ] as const) {
        expect((await ownerRefusal(db, INSERT, values as unknown[]))?.code, name).toBe("23514");
      }
      // The controls, each of its answers; and a second row for one key is refused.
      for (const values of [
        row({}),
        row({ answer: "stale" }),
        row({ answer: "undecided", matched: null }),
        row({ answer: "undecided" }),
        row({ answer: "new", reached: null, matched: null }),
      ]) {
        expect(await ownerRefusal(db, INSERT, values), JSON.stringify(values)).toBeNull();
      }
      expect(
        await asOwner(db, async (query) => {
          await query(INSERT, row({}));
          return (await sqlState(() => query(INSERT, row({ answer: "stale" })))) ?? "taken";
        }),
      ).toBe("23505");
    }));

  it("ledger.memory_imports: a request id per client once, a locator fingerprint, a change and a mark of their words, matched projection ids, a record only for a stored added change", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      const record = testId("rec");
      await session(db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(INSERT_WRITE, [record, ...writeValues(at, "import_memory", "memory_change").slice(1)]);
      });
      const INSERT = `insert into ledger.memory_imports (client_id, request_id, record_id, locator_fp, change, mark, matched_projection_ids, entry_time, created_at, compartments)
        values ($1, $2, $3, $4, $5, $6, $7, null, now(), '{own}')`;
      const row = (over: {
        request?: string;
        record?: string | null;
        locator?: string;
        change?: string;
        mark?: string;
        matched?: string[];
      }): unknown[] => [
        at.client,
        over.request ?? "request-memory-0001",
        over.record === undefined ? record : over.record,
        over.locator ?? FP,
        over.change ?? "added",
        over.mark ?? "new",
        over.matched ?? [],
      ];
      for (const [name, values] of [
        ["a request id off its form", row({ request: "short" })],
        ["a locator off its form", row({ locator: "x" })],
        ["a change of another word", row({ change: "edited" })],
        ["a mark of another word", row({ mark: "copied" })],
        ["a matched id off its form", row({ matched: ["mpr_1"] })],
        ["a record for a refused change", row({ mark: "refused" })],
        ["a record for a removed change", row({ change: "removed" })],
      ] as const) {
        expect((await ownerRefusal(db, INSERT, values as unknown[]))?.code, name).toBe("23514");
      }
      for (const values of [
        row({}),
        row({ record: null, mark: "refused", matched: [`mpr_${"0".repeat(40)}`] }),
        row({ record: null, change: "removed" }),
      ]) {
        expect(await ownerRefusal(db, INSERT, values), JSON.stringify(values)).toBeNull();
      }
      expect(
        await asOwner(db, async (query) => {
          await query(INSERT, row({}));
          return (await sqlState(() => query(INSERT, row({ record: null })))) ?? "taken";
        }),
      ).toBe("23505");
    }));

  it("ledger.memory_projections.line_fp is null for a row served before it and holds only a fingerprint", () =>
    withDatabase(async (db) => {
      const at = await clientAndSession(db);
      const INSERT = `insert into ledger.memory_projections (id, client_id, audience, template, fact_key_fp, state_fp, evidence_ids, compartments, first_served_at, last_served_at, line_fp)
        values ($1, $2, '{own}', 'active_memory@1', $3, $3, '{}', '{own}', now(), now(), $4)`;
      const id = `mpr_${"1".repeat(40)}`;
      expect((await ownerRefusal(db, INSERT, [id, at.client, FP, "A".repeat(64)]))?.constraint).toBe(
        "memory_projections_line_fp",
      );
      for (const line of [null, FP])
        expect(await ownerRefusal(db, INSERT, [id, at.client, FP, line]), String(line)).toBeNull();
    }));
});

describe("NNNN: the functions' catalogue", { timeout: TIMEOUT }, () => {
  it("every function made or replaced is a definer function owned by pi_owner with the core's search path, PUBLIC holds no EXECUTE, and exactly its roles execute it", () =>
    withDatabase(async (db) => {
      for (const [signature, role] of Object.entries(FUNCTIONS)) {
        const fn = one(
          await admin<{ definer: boolean; owner: string; config: string[]; anyone: boolean }>(
            db,
            `select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                    coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as anyone
             from pg_proc p where p.oid = to_regprocedure($1)`,
            [signature],
          ),
        );
        expect(
          {
            definer: fn.definer,
            owner: fn.owner,
            anyone: fn.anyone,
            config: fn.config.map((setting) => setting.replaceAll(/[\s"]/g, "")),
          },
          signature,
        ).toEqual({
          definer: true,
          owner: "pi_owner",
          anyone: false,
          config: ["search_path=pg_catalog,policy,pg_temp"],
        });
        for (const each of ROLES) {
          const may = one(
            await admin<{ ok: boolean }>(
              db,
              "select has_function_privilege($1::name, to_regprocedure($2), 'EXECUTE') as ok",
              [each, signature],
            ),
          ).ok;
          expect(may, `${each} ${signature}`).toBe([role].flat().includes(each));
        }
        // One function of the name: no old signature is left beside it.
        const name = signature.split("(")[0] as string;
        expect(
          one(
            await admin<{ n: number }>(
              db,
              "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1",
              [name],
            ),
          ).n,
          name,
        ).toBe(1);
      }
    }));

  it("the writing functions' arguments name no client, and serve_memory's last are line_fps and the supports", () =>
    withDatabase(async (db) => {
      const argsOf = async (signature: string): Promise<string> =>
        one(
          await admin<{ args: string }>(db, "select pg_get_function_identity_arguments(to_regprocedure($1)) as args", [
            signature,
          ]),
        ).args;
      expect(await argsOf("policy.propose_about_you(text,text,text,text,text,text,text[],text[],text[],jsonb)")).toBe(
        "session_id text, new_id text, request_id text, scope text, content_fp text, cites_fp text, cites text[], stamps text[], compartments text[], body_enc jsonb",
      );
      expect(await argsOf("policy.import_memory(text,jsonb,text[])")).toBe(
        "session_id text, changes jsonb, compartments text[]",
      );
      expect(
        (
          await argsOf(
            "policy.serve_memory(text,text[],text[],text[],text[],jsonb,text[],boolean,text[],boolean,text[],jsonb)",
          )
        ).endsWith("can_delete boolean, line_fps text[], supports jsonb"),
      ).toBe(true);
      // The old serve_memories are gone: without line_fps, and without the supports.
      expect(
        one(
          await admin<{ gone: boolean }>(
            db,
            `select to_regprocedure('policy.serve_memory(text,text[],text[],text[],text[],jsonb,text[],boolean,text[],boolean)') is null
                and to_regprocedure('policy.serve_memory(text,text[],text[],text[],text[],jsonb,text[],boolean,text[],boolean,text[])') is null as gone`,
          ),
        ).gone,
      ).toBe(true);
    }));
});
