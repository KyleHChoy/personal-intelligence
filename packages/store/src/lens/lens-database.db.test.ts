import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LENS_COLUMN_GRANTS, LENS_TABLE_GRANTS, LENS_TABLES, RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import { labelFixed, labelFixedColumnGrants } from "../test-support/catalogue-labels.ts";
import { ALL_VIEWS, insertClient, sha256Hex, TOOL_NAMES, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, refusal, session, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { type LensDevice, seedBothCompartments, seeder } from "../test-support/seeder.ts";

// The catalogue and the read rules of Lens's inbox migration. One small world for the file, built
// once: a row of every knowledge table under `own` and under `employer:example`, a device, and a
// stored capture item under each label. No test changes what another reads: each that writes
// commits rows of its own or rolls back. Every refusal has its positive control in the same test.

// Below DB_TEST_TIMEOUT (test-support/timeouts.ts): one small world built once.
const TIMEOUT = 60_000;
const PUSH = "policy.push_capture(text,text,jsonb,boolean)";
const ERASED = "ledger.capture_erased(text[],text[],jsonb)";
const PRIVILEGES: Record<string, string[]> = {
  all: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  select: ["SELECT"],
  insert: ["INSERT"],
  update: ["UPDATE"],
  delete: ["DELETE"],
};
// The tables with a label among the six (and the exclude list and account map, which have
// none): each has compartments_not_empty.
const LABELLED = ["ledger.capture_inbox", "ledger.capture_erasures", "knowledge.captures"];

let db: TestDatabase;
let device: LensDevice;
let captures: { own: string; employer: string };
beforeAll(async () => {
  db = await createTestDatabase();
  await seedBothCompartments(db);
  await session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    device = await seed.lensDevice({ name: "lens-mac" });
    captures = {
      own: (await seed.capture(["own"], device)).id,
      employer: (await seed.capture(["employer:example"], device)).id,
    };
  });
}, TIMEOUT);
afterAll(async () => {
  await db?.drop();
});

const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
// What one statement in a transaction that is always rolled back was refused with, or null.
const tried = (
  url: string,
  text: string,
  values: unknown[],
  asOwner = false,
): Promise<{ code: string; constraint?: string } | null> =>
  refusal(() =>
    session(url, async (query) => {
      await query("begin");
      try {
        if (asOwner) await query("set local role pi_owner");
        await query(text, values);
      } finally {
        await query("rollback");
      }
    }),
  );
// Each table's cells with the restricted worker's rule: pi_restricted holds a copy of pi_pipeline's.
const cellsOf = (table: string): Record<string, string[]> => {
  const cells: Record<string, string[]> = { ...(LENS_TABLE_GRANTS[table] ?? {}) };
  if (cells.pi_pipeline !== undefined) cells.pi_restricted = [...cells.pi_pipeline];
  return cells;
};
const COLUMN_CELLS = new Set([
  "ledger.capture_inbox pi_admin update",
  "ledger.capture_inbox pi_writer update",
  "knowledge.captures pi_reader select",
]);

describe("the six tables, and the browsing deny list's two (0112)", { timeout: TIMEOUT }, () => {
  it("each forces row-level security and is owned by pi_owner, and each with a label has compartments_not_empty", async () => {
    const tables = await admin<{ name: string; enabled: boolean; forced: boolean; owner: string }>(
      `select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner)::text as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1) order by 1`,
      [LENS_TABLES],
    );
    expect(tables).toEqual(
      [...LENS_TABLES].sort().map((name) => ({ name, enabled: true, forced: true, owner: "pi_owner" })),
    );
    const constrained = await admin<{ table: string }>(
      "select conrelid::regclass::text as table from pg_constraint where conname = 'compartments_not_empty' and conrelid::regclass::text = any($1) order by 1",
      [LENS_TABLES],
    );
    expect(constrained.map((row) => row.table)).toEqual([...LABELLED].sort());
  });

  it("the policies of the eight, and their privileges for every role, are the grants table of Data", async () => {
    // policy.time_exceptions is the daily time pass's: its grants are catalogue-time.ts's, and database.db.test.ts asks them.
    const EIGHT = LENS_TABLES.filter((table) => table !== "policy.time_exceptions");
    const policies = await admin<{
      table: string;
      name: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      check: string | null;
    }>(
      `select schemaname || '.' || tablename as "table", policyname as name, roles::text[] as roles, cmd, qual, with_check as "check"
       from pg_policies where schemaname || '.' || tablename = any($1)`,
      [EIGHT],
    );
    const expected = EIGHT.flatMap((table) =>
      Object.entries(cellsOf(table)).flatMap(([role, cells]) =>
        cells.map((cell) => `${table} ${role}_${cell} ${role} ${cell.toUpperCase()}`),
      ),
    );
    expect(
      policies.map((policy) => `${policy.table} ${policy.name} ${policy.roles.join(",")} ${policy.cmd}`).sort(),
    ).toEqual(expected.sort());

    // The reader's reads the clearance with the label-key term; the pipeline's leaves out a restricted row;
    // the admin's update of the inbox takes a forget's row alone; every other is unconditional.
    for (const policy of policies) {
      const label = `${policy.table} ${policy.name}`;
      if (policy.name === "pi_reader_select") {
        expect(policy.qual, label).toMatch(/compartments\s*<@\s*\(\s*SELECT\s+(policy\.)?client_clearance\(\)/i);
        expect(policy.qual, label).toMatch(
          /(policy\.)?label_key\(compartments\)\s*=\s*ANY\s*\(\s*\(\s*SELECT\s+(policy\.)?clearance_keys\(\)/i,
        );
      } else if (policy.name === "pi_pipeline_select")
        expect(policy.qual, label).toMatch(/NOT policy\.is_restricted\(compartments\)/);
      else if (label === "ledger.capture_inbox pi_admin_update")
        expect({ qual: policy.qual, check: policy.check }, label).toEqual({
          qual: "(kind = 'forget'::text)",
          check: "(kind = 'forget'::text)",
        });
      else if (label.endsWith(" pi_restricted_select"))
        expect({ qual: policy.qual, check: policy.check }, label).toEqual({
          qual: "(true AND policy.is_restricted(compartments))",
          check: null,
        });
      else {
        expect(policy.qual, label).toBe(policy.cmd === "INSERT" ? null : "true");
        expect(policy.check, label).toBe(policy.cmd === "SELECT" || policy.cmd === "DELETE" ? null : "true");
      }
    }

    // Table privileges, from aclexplode: every role but the owner's own entries.
    const privileges = await admin<{ line: string }>(
      `select n.nspname || '.' || c.relname || ' ' || coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type as line
       from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a left join pg_roles g on g.oid = a.grantee
       where n.nspname || '.' || c.relname = any($1) and a.grantee <> c.relowner`,
      [EIGHT],
    );
    const tablePrivileges = EIGHT.flatMap((table) =>
      Object.entries(cellsOf(table))
        .filter(([role]) => role !== "pi_owner")
        .flatMap(([role, cells]) =>
          cells
            .filter((cell) => !COLUMN_CELLS.has(`${table} ${role} ${cell}`))
            .flatMap((cell) => (PRIVILEGES[cell] ?? []).map((privilege) => `${table} ${role} ${privilege}`))
            // An update held column by column, its label columns left out.
            .filter((line) => !(line.endsWith(" UPDATE") && labelFixed(table, role))),
        ),
    );
    expect(privileges.map((row) => row.line).sort()).toEqual(tablePrivileges.sort());

    // Column privileges beyond those: the admin's and the writer's updates of an inbox row, and
    // the reader's select of the columns of a stored item LENS_READER_COLUMNS names, no more.
    const columns = await session(db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      const rows = await query<{ line: string }>(
        `select table_schema || '.' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type as line
         from information_schema.column_privileges where table_schema || '.' || table_name = any($1) and grantee <> 'pi_owner'`,
        [EIGHT],
      );
      await query("rollback");
      return rows;
    });
    const byTable = new Set(tablePrivileges);
    const onColumns = columns.map((row) => row.line).filter((line) => !byTable.has(line.replace(/^(\S+) \S+ /, "$1 ")));
    const labels = await session(db.urls.admin, (query) => labelFixedColumnGrants(query, EIGHT));
    expect(onColumns.sort()).toEqual([...LENS_COLUMN_GRANTS, ...labels].sort());
    // The control for that reading: the admin's table privileges show on every column.
    expect(columns.some((row) => row.line.startsWith("policy.lens_devices name pi_admin SELECT"))).toBe(true);
  });

  it("each role does on the inbox what its grants say, and no more", async () => {
    const inbox = (set: string) => `update ledger.capture_inbox set ${set} where false`;
    for (const [url, set] of [
      [db.urls.admin, "body_enc = null, taken_at = now()"],
      [
        db.urls.writer,
        "body_enc = null, evidence_id = null, refused_code = null, taken_at = now(), tainted_at = now()",
      ],
    ] as const) {
      expect(await tried(url, inbox(set), []), set).toBeNull();
      expect(await tried(url, "delete from ledger.capture_inbox where false", []), "delete").toBeNull();
    }
    // The admin updates no other column; the writer no other either; neither inserts.
    for (const [url, set] of [
      [db.urls.admin, "evidence_id = null"],
      [db.urls.admin, "compartments = compartments"],
      [db.urls.writer, "compartments = compartments"],
      [db.urls.writer, "scope_fps = scope_fps"],
    ] as const) {
      expect((await tried(url, inbox(set), []))?.code, set).toBe("42501");
    }
    for (const url of [db.urls.admin, db.urls.writer, db.urls.pipeline]) {
      expect(
        (await tried(url, "insert into ledger.capture_inbox (id) select id from ledger.capture_inbox where false", []))
          ?.code,
        url,
      ).toBe("42501");
    }
    // The pipeline and the reader read nothing of the inbox, the scope, the devices or the erased keys,
    // nor of the exclude list or the account map.
    for (const table of [
      "ledger.capture_inbox",
      "policy.capture_scope",
      "policy.lens_devices",
      "ledger.capture_erasures",
      "policy.capture_excludes",
      "policy.capture_accounts",
    ]) {
      expect((await tried(db.urls.pipeline, `select count(*) from ${table}`, []))?.code, table).toBe("42501");
      expect(
        await sqlState(() => readAs(db, device.mirror.token, (query) => query(`select count(*) from ${table}`))),
        table,
      ).toBe("42501");
      // The control: pi_admin reads each.
      expect(await tried(db.urls.admin, `select count(*) from ${table}`, []), table).toBeNull();
    }
    // The writer reads the exclude list and the account map, for the drain, and writes neither.
    for (const table of ["policy.capture_excludes", "policy.capture_accounts"]) {
      expect(await tried(db.urls.writer, `select count(*) from ${table}`, []), table).toBeNull();
      expect((await tried(db.urls.writer, `delete from ${table} where false`, []))?.code, table).toBe("42501");
      expect(await tried(db.urls.admin, `delete from ${table} where false`, []), table).toBeNull();
    }
  });

  it("pi_reader reads a stored capture item's clear columns within the clearance, and never its facts", async () => {
    const own = await insertClient(db, `captures-own-${randomBytes(3).toString("hex")}`, ["own"]);
    const ids = (token: string) =>
      readAs(db, token, (query) =>
        query<{ id: string }>("select id from knowledge.captures where id = any($1) order by id", [
          [captures.own, captures.employer],
        ]),
      );
    expect((await ids(own.token)).map((row) => row.id)).toEqual([captures.own]);
    expect(
      await sqlState(() => readAs(db, own.token, (query) => query("select facts_enc from knowledge.captures"))),
    ).toBe("42501");
    // The controls: a client cleared for both sees both, and the pipeline reads both, facts and all.
    const both = await insertClient(db, `captures-both-${randomBytes(3).toString("hex")}`, ["own", "employer:example"]);
    expect((await ids(both.token)).map((row) => row.id)).toEqual([captures.own, captures.employer].sort());
    expect(
      one(
        await queryAs<{ n: number }>(
          db.urls.pipeline,
          "select count(facts_enc)::int as n from knowledge.captures where id = any($1)",
          [[captures.own, captures.employer]],
        ),
      ).n,
    ).toBe(2);
  });

  it("knowledge.captures.evidence_id is a foreign key to vault.evidence_items", async () => {
    const key = one(
      await admin<{ ref: string; columns: string[] }>(
        `select confrelid::regclass::text as ref, array(select attname::text from pg_attribute where attrelid = conrelid and attnum = any(conkey)) as columns
         from pg_constraint where conrelid = 'knowledge.captures'::regclass and contype = 'f' and confrelid = 'vault.evidence_items'::regclass`,
      ),
    );
    expect(key).toEqual({ ref: "vault.evidence_items", columns: ["evidence_id"] });
    // An item whose evidence is gone is refused; the control is the stored one, which stands.
    expect(
      (
        await tried(db.urls.admin, "update knowledge.captures set evidence_id = $1 where id = $2", [
          testId("evi"),
          captures.own,
        ])
      )?.code,
    ).toBe("23503");
    expect(
      await tried(db.urls.admin, "update knowledge.captures set evidence_id = evidence_id where id = $1", [
        captures.own,
      ]),
    ).toBeNull();
  });
});

describe("the checks Lens's rows widen", { timeout: TIMEOUT }, () => {
  it("a device client, a device's three source accounts, a forget's removed evidence and its erasure with no ruling are taken; their near misses are refused", async () => {
    const client = (kind: string): [string, unknown[]] => [
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind) values ($1, $2, $3, 'active', 'none', 'local', '{own}', '{self}', '{push_capture}', $4)`,
      [testId("cli"), `checks-${randomBytes(3).toString("hex")}`, sha256Hex(randomBytes(8).toString("hex")), kind],
    ];
    expect(await tried(db.urls.admin, ...client("device"))).toBeNull();
    expect((await tried(db.urls.admin, ...client("mirror")))?.constraint).toBe("clients_kind");

    const ACCOUNT =
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc) values ($1, $2, $3, $4, $5, $6, $7)";
    const account = (
      over: { label?: string; connector?: string; kind?: string; compartments?: string[]; address?: boolean } = {},
    ): unknown[] => {
      const id = testId("acc");
      return [
        id,
        over.label ?? "device:checks-mac",
        over.connector ?? "lens_activity",
        over.kind ?? "screen_activity",
        over.compartments ?? ["own"],
        over.address === true ? fingerprint(db.keys, "address", "owner@example.com") : null,
        over.address === true
          ? sealRow(db.keys, "own", { table: "vault.source_accounts", id, column: "address_enc" }, "owner@example.com")
          : null,
      ];
    };
    for (const [connector, kind] of [
      ["lens_meetings", "transcript"],
      ["lens_activity", "screen_activity"],
      ["lens_blocks", "time_block"],
    ] as const) {
      expect(await tried(db.urls.admin, ACCOUNT, account({ connector, kind })), connector).toBeNull();
    }
    for (const [name, values, constraint] of [
      [
        "another connector's kind",
        account({ connector: "lens_blocks", kind: "screen_activity" }),
        "source_accounts_kind_of_connector",
      ],
      ["a label off the device form", account({ label: "checks-mac" }), "source_accounts_lens"],
      ["an upper case device name", account({ label: "device:Checks-mac" }), "source_accounts_lens"],
      // The name is of the ClientName form, 2 to 40 characters, as policy.lens_devices' is.
      ["a one-letter device name", account({ label: "device:c" }), "source_accounts_lens"],
      ["a compartment but own", account({ compartments: ["employer:example"] }), "source_accounts_lens"],
      ["an address", account({ address: true }), "source_accounts_agent_address"],
      // With an address, so the address check, which comes first by name, holds.
      [
        "a connector of no kind",
        account({ connector: "lens_screen", address: true }),
        "source_accounts_connector_check",
      ],
    ] as const) {
      expect((await tried(db.urls.admin, ACCOUNT, [...values]))?.constraint, name).toBe(constraint);
    }

    // knowledge.erasures: kind device_forget with no ruling, and only it. Then a removed-evidence
    // row of reason device_forget under it.
    const ruling = testId("rul");
    await admin(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
      [ruling, testId("req")],
    );
    const seq = (): number => 1_000_000 + randomBytes(3).readUIntBE(0, 3);
    const ERASURE =
      "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, $3, $4, now(), 1, 0, 0, '{own}')";
    expect(await tried(db.urls.admin, ERASURE, [testId("ers"), null, "device_forget", seq()])).toBeNull();
    expect((await tried(db.urls.admin, ERASURE, [testId("ers"), ruling, "device_forget", seq()]))?.code).toBe("23514");
    expect((await tried(db.urls.admin, ERASURE, [testId("ers"), null, "item", seq()]))?.code).toMatch(/^23(514|502)$/);
    expect(await tried(db.urls.admin, ERASURE, [testId("ers"), ruling, "item", seq()])).toBeNull();
    const nullable = one(
      await admin<{ nullable: string }>(
        "select is_nullable::text as nullable from information_schema.columns where table_schema = 'knowledge' and table_name = 'erasures' and column_name = 'ruling_id'",
      ),
    );
    expect(nullable.nullable).toBe("YES");

    const removed = (reason: string): Promise<{ code: string; constraint?: string } | null> =>
      refusal(() =>
        session(db.urls.admin, async (query) => {
          await query("begin");
          try {
            const erasure = testId("ers");
            await query(ERASURE, [erasure, null, "device_forget", seq()]);
            await query(
              "insert into knowledge.removed_evidence (id, erasure_id, source_account_id, source_item_fp, evidence_ids, reason, removed_at, compartments) values ($1, $2, $3, $4, '{}', $5, now(), '{own}')",
              [
                testId("rme"),
                erasure,
                device.accounts.moment,
                fingerprint(db.keys, "source_id", `moment:${testId("k").slice(2)}`),
                reason,
              ],
            );
          } finally {
            await query("rollback");
          }
        }),
      );
    expect(await removed("device_forget")).toBeNull();
    expect(await removed("owner_erasure")).toBeNull();
    expect((await removed("forget"))?.constraint).toBe("removed_evidence_reason");
  });
});

describe("a device reads nothing", { timeout: TIMEOUT }, () => {
  it("a device client is in no audience", async () => {
    // Labels no other client of the file holds, so each audience is this test's own.
    const clientOf = (kind: "agent" | "device", compartments: string[]) =>
      admin(
        `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind) values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7)`,
        [
          testId("cli"),
          `audience-${kind}-${randomBytes(3).toString("hex")}`,
          sha256Hex(randomBytes(8).toString("hex")),
          compartments,
          kind === "device" ? ["self"] : ALL_VIEWS,
          kind === "device" ? ["push_capture"] : ["search"],
          kind,
        ],
      );
    await clientOf("device", ["employer:lens-probe"]);
    await clientOf("agent", ["employer:lens-other"]);
    const audiences = (await queryAs<{ a: string[] }>(db.urls.pipeline, "select a from policy.audiences() a")).map(
      (row) => row.a.join("|"),
    );
    expect(audiences).not.toContain("employer:lens-probe");
    // The control: an agent of a label of its own is an audience.
    expect(audiences).toContain("employer:lens-other");
    // And the device registered for the file is in none, though `own` is: its mirror client is.
    expect(audiences).toContain("own");
  });

  it("client_clearance, clearance_keys and view_keys answer the empty set for a device client", async () => {
    type Answers = { clearance: string[]; keys: string[]; views: string[]; client: string | null };
    const ask = (token: string) =>
      readAs(db, token, async (query) =>
        one(
          await query<Answers>(
            "select policy.client_clearance() as clearance, policy.clearance_keys() as keys, policy.view_keys() as views, (select id from policy.current_client()) as client",
          ),
        ),
      );
    expect(await ask(device.capture.token)).toEqual({ clearance: [], keys: [], views: [], client: device.capture.id });
    // The control: the device's mirror client, cleared for own.
    const mirror = await ask(device.mirror.token);
    expect({ clearance: mirror.clearance, keys: mirror.keys, client: mirror.client }).toEqual({
      clearance: ["own"],
      keys: ["own"],
      client: device.mirror.id,
    });
    expect(mirror.views.length).toBeGreaterThan(0);
  });

  it("with a device client's token set, pi_reader selects no row of any labelled table, and the mirror client's token reads, as the control", async () => {
    // Every table whose reader policy reads the clearance: policy.research_settings, read with
    // using (true), is not one.
    const tables = (
      await admin<{ table: string }>(
        `select distinct schemaname || '.' || tablename as "table" from pg_policies
         where 'pi_reader' = any (roles) and cmd = 'SELECT' and qual ~ 'client_clearance|clearance_keys|clearance_key' order by 1`,
      )
    ).map((row) => row.table);
    expect(tables).toEqual(
      expect.arrayContaining(["knowledge.captures", "knowledge.messages", "knowledge.claims", "ledger.agent_writes"]),
    );
    expect(tables).not.toContain("policy.research_settings");
    const counts = (token: string) =>
      readAs(db, token, async (query: Query) => {
        const seen: Record<string, number> = {};
        for (const table of tables)
          seen[table] = one(await query<{ n: number }>(`select count(*)::int as n from ${table}`)).n;
        return seen;
      });
    expect(await counts(device.capture.token)).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));
    // The control: the mirror client, cleared for own, reads rows of the same tables.
    const mirror = await counts(device.mirror.token);
    for (const table of ["knowledge.captures", "knowledge.messages", "knowledge.claims"])
      expect(mirror[table], table).toBeGreaterThan(0);
  });
});

describe("the functions' catalogue", { timeout: TIMEOUT }, () => {
  it("push_capture and capture_erased are definer functions owned by pi_owner with the core's search path, PUBLIC holds no EXECUTE, and exactly their role executes each", async () => {
    for (const [signature, role, args] of [
      [PUSH, "pi_reader", "session_id text, batch text, items jsonb, ceiling boolean"],
      [ERASED, "pi_admin", "devices text[], capture_keys text[], compartments jsonb"],
    ] as const) {
      const fn = one(
        await admin<{ definer: boolean; owner: string; config: string[] | null; anyone: boolean; args: string }>(
          `select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config,
                  coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), true) as anyone, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p where p.oid = to_regprocedure($1)`,
          [signature],
        ),
      );
      expect(
        { ...fn, config: (fn.config ?? []).map((setting) => setting.replaceAll(/[\s"]/g, "")) },
        signature,
      ).toEqual({
        definer: true,
        owner: "pi_owner",
        config: ["search_path=pg_catalog,policy,pg_temp"],
        anyone: false,
        args,
      });
      for (const each of RUNTIME_ROLES) {
        const may = one(
          await admin<{ ok: boolean }>(
            "select has_function_privilege($1::name, to_regprocedure($2), 'EXECUTE') as ok",
            [each, signature],
          ),
        ).ok;
        expect(may, `${each} ${signature}`).toBe(each === role);
      }
    }
    // push_capture answers each item's outcome by its place in the batch (the shape the comment
    // above policy.push_capture in the migration gives), capture_erased the rows it wrote; there is
    // no ledger.device_forget.
    const result = async (signature: string): Promise<string> =>
      one(await admin<{ result: string }>("select pg_get_function_result(to_regprocedure($1)) as result", [signature]))
        .result;
    expect(await result(PUSH)).toBe("TABLE(ordinal integer, outcome text, code text)");
    expect(await result(ERASED)).toBe("integer");
    expect(
      one(await admin<{ args: string }>("select pg_get_function_arguments(to_regprocedure($1)) as args", [PUSH])).args,
    ).toBe("session_id text, batch text, items jsonb, ceiling boolean");
    expect(
      one(
        await admin<{ n: number }>(
          "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'policy' and p.proname = 'push_capture'",
        ),
      ).n,
    ).toBe(1);
    expect(
      one(
        await admin<{ n: number }>(
          "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger' and p.proname = 'device_forget'",
        ),
      ).n,
    ).toBe(0);
  });

  it("policy.tool_names holds push_capture and sync_mirror", async () => {
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(["push_capture", "sync_mirror"]));
    expect(
      (
        await admin<{ name: string }>(
          "select name from policy.tool_names where name in ('push_capture', 'sync_mirror') order by 1",
        )
      ).map((row) => row.name),
    ).toEqual(["push_capture", "sync_mirror"]);
  });
});
