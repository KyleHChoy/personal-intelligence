import { type ClientId, EventId } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../core/ids.ts";
import { ALL_VIEWS, sha256Hex, testId } from "../test-support/clients.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { NAMES_KNOWLEDGE } from "../test-support/order.ts";
import { callLog, openStore, recordingReader as readerOf, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// ledger.context_packs and policy.log_pack, the two tool names in the call log, and a pack the
// registration does not allow, refused before any read and recorded. The clients are inserted in
// SQL as pi_admin. Every refusal has its control.

const PACK_TOOLS = ["get_self", "build_context_pack"];
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const INVALID = { ok: false, code: "invalid_request" };
const HEX = "a".repeat(64);
const LOG_PACK = "select policy.log_pack($1, $2, $3, $4, $5, $6)";
// What a refusal before any read may never name: the knowledge schema and the agent records.
const NAMES_RECORDS = /ledger\s*\.\s*agent_writes/i;

type Client = { id: ClientId; name: string; token: string };

let store: TestStore;
const recordingReader = () => readerOf(store);

beforeAll(async () => {
  store = await openStore({ writer: false });
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

async function newClient(options?: { tools?: string[]; views?: string[]; compartments?: string[] }): Promise<Client> {
  const name = `packs-${testId("c").slice(-8).toLowerCase()}`;
  const client = { id: testId("cli") as ClientId, name, token: `pit_test-${name}-${testId("x")}` };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [
      client.id,
      name,
      sha256Hex(client.token),
      options?.compartments ?? ["own"],
      options?.views ?? ALL_VIEWS,
      options?.tools ?? PACK_TOOLS,
    ],
  );
  return client;
}

// A session of the client, opened as the reader opens one.
async function sessionOf(client: Client): Promise<string> {
  const id = newId("ses");
  await readAs(store.db, client.token, (query) => query("select policy.open_session($1)", [id]));
  return id;
}

const logPack = (token: string | null, values: unknown[]) =>
  readAs(store.db, token, (query) => query(LOG_PACK, values));
const packArgs = (
  session: string,
  over: { purpose?: string; template?: string; selector?: string; packFp?: string; itemIds?: string[] } = {},
): unknown[] => [
  session,
  over.purpose ?? "agent_bootstrap",
  over.template ?? "agent_bootstrap@1",
  over.selector ?? "in_order",
  over.packFp ?? HEX,
  over.itemIds ?? ["address:0", "evt_0000000000000000000000000A"],
];
const packRows = (client: ClientId) =>
  queryAs(
    store.db.urls.admin,
    "select session_id, purpose, template, selector, pack_fp, item_ids, compartments from ledger.context_packs where client_id = $1 order by id",
    [client],
  );

describe("ledger.context_packs and policy.log_pack", { timeout: DB_TEST_TIMEOUT }, () => {
  it("log_pack with no client is refused", async () => {
    const client = await newClient();
    const session = await sessionOf(client);
    expect(await sqlState(() => logPack(null, packArgs(session)))).toBe("42501");
    expect(await sqlState(() => logPack(`pit_${"A".repeat(43)}`, packArgs(session)))).toBe("42501");
    // The control: the client's own token.
    expect(await sqlState(() => logPack(client.token, packArgs(session)))).toBeNull();
    expect(await packRows(client.id)).toHaveLength(1);
  });

  it("log_pack refuses another client's session, and a client without build_context_pack", async () => {
    const alpha = await newClient();
    const beta = await newClient();
    const narrow = await newClient({ tools: ["get_self"] });
    const betaSession = await sessionOf(beta);
    const narrowSession = await sessionOf(narrow);
    expect(await sqlState(() => logPack(alpha.token, packArgs(betaSession)))).toBe("42501");
    expect(await sqlState(() => logPack(alpha.token, packArgs(`ses_${"0".repeat(26)}`)))).toBe("42501");
    expect(await sqlState(() => logPack(narrow.token, packArgs(narrowSession)))).toBe("42501");
    expect(await packRows(alpha.id)).toEqual([]);
    expect(await packRows(narrow.id)).toEqual([]);
    // The control: beta's own session, by beta.
    expect(await sqlState(() => logPack(beta.token, packArgs(betaSession)))).toBeNull();
  });

  it("log_pack refuses a pack_fp that is not 64 hex characters, 201 item ids, an item id of 81 characters, and a template off its form", async () => {
    const client = await newClient();
    const session = await sessionOf(client);
    const refused = [
      packArgs(session, { packFp: "A".repeat(64) }),
      packArgs(session, { packFp: "a".repeat(63) }),
      packArgs(session, { itemIds: Array.from({ length: 201 }, (_, index) => `address:${index}`) }),
      packArgs(session, { itemIds: ["x".repeat(81)] }),
      packArgs(session, { itemIds: ["two words"] }),
      packArgs(session, { itemIds: ["a,b"] }),
      packArgs(session, { template: "agent_bootstrap" }),
      packArgs(session, { template: "Agent_bootstrap@1" }),
      packArgs(session, { template: "agent_bootstrap@0" }),
      packArgs(session, { purpose: "Agent bootstrap" }),
      packArgs(session, { purpose: "a".repeat(33) }),
      packArgs(session, { selector: "in order" }),
    ];
    for (const values of refused)
      expect(await sqlState(() => logPack(client.token, values)), JSON.stringify(values.slice(1))).toBe("23514");
    expect(await packRows(client.id)).toEqual([]);
    // The control: the edges that are allowed.
    expect(
      await sqlState(() =>
        logPack(
          client.token,
          packArgs(session, { itemIds: Array.from({ length: 200 }, (_, index) => `address:${index}`) }),
        ),
      ),
    ).toBeNull();
    expect(await sqlState(() => logPack(client.token, packArgs(session, { itemIds: ["x".repeat(80)] })))).toBeNull();
    expect(await sqlState(() => logPack(client.token, packArgs(session, { itemIds: [] })))).toBeNull();
    const rows = await packRows(client.id);
    expect(rows).toHaveLength(3);
    // The clearance is the function's, never an argument.
    expect(rows.map((row) => row.compartments)).toEqual([["own"], ["own"], ["own"]]);
  });

  it("pi_reader, pi_writer and pi_pipeline cannot read or write ledger.context_packs", async () => {
    const client = await newClient();
    const session = await sessionOf(client);
    expect(await sqlState(() => logPack(client.token, packArgs(session)))).toBeNull();
    const insert = `insert into ledger.context_packs (client_id, session_id, purpose, template, selector, pack_fp, item_ids, compartments)
                    values ('${client.id}', '${session}', 'agent_bootstrap', 'agent_bootstrap@1', 'in_order', '${HEX}', '{}', '{own}')`;
    for (const url of [store.db.urls.writer, store.db.urls.pipeline]) {
      for (const sql of [
        "select id from ledger.context_packs",
        insert,
        "update ledger.context_packs set purpose = 'meeting_prep'",
        "delete from ledger.context_packs",
      ]) {
        expect(await sqlState(() => queryAs(url, sql)), sql).toBe("42501");
      }
    }
    for (const sql of [
      "select id from ledger.context_packs",
      insert,
      "update ledger.context_packs set purpose = 'meeting_prep'",
      "delete from ledger.context_packs",
    ]) {
      expect(await sqlState(() => readAs(store.db, client.token, (query) => query(sql))), sql).toBe("42501");
    }
    // pi_admin reads and does not write.
    expect(
      (await queryAs(store.db.urls.admin, "select id from ledger.context_packs where client_id = $1", [client.id]))
        .length,
    ).toBe(1);
    for (const sql of [
      insert,
      "update ledger.context_packs set purpose = 'meeting_prep'",
      "delete from ledger.context_packs",
    ]) {
      expect(await sqlState(() => queryAs(store.db.urls.admin, sql)), sql).toBe("42501");
    }
  });

  it("log_call takes build_context_pack and get_commitments", async () => {
    const client = await newClient({ tools: ["get_self", "build_context_pack", "get_commitments"] });
    for (const tool of ["build_context_pack", "get_commitments"]) {
      expect(
        await sqlState(() =>
          readAs(store.db, client.token, (query) => query("select policy.log_call($1, $2, $3)", [tool, 0, "ok"])),
        ),
        tool,
      ).toBeNull();
    }
    expect(
      await queryAs(store.db.urls.admin, "select tool, outcome from policy.calls where client_id = $1 order by id", [
        client.id,
      ]),
    ).toEqual([
      { tool: "build_context_pack", outcome: "ok" },
      { tool: "get_commitments", outcome: "ok" },
    ]);
    expect(
      (
        await queryAs<{ name: string }>(
          store.db.urls.admin,
          "select name from policy.tool_names where name = any($1) order by name",
          [["build_context_pack", "get_commitments"]],
        )
      ).map((row) => row.name),
    ).toEqual(["build_context_pack", "get_commitments"]);
  });

  it("the table has exactly the expected policies and privileges", async () => {
    const [table] = await queryAs<{ rls: boolean; forced: boolean }>(
      store.db.urls.admin,
      "select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where oid = 'ledger.context_packs'::regclass",
    );
    expect(table).toEqual({ rls: true, forced: true });
    const policies = await queryAs<{ name: string; roles: string[]; cmd: string }>(
      store.db.urls.admin,
      "select policyname::text as name, roles::text[] as roles, cmd from pg_policies where schemaname = 'ledger' and tablename = 'context_packs' order by policyname",
    );
    expect(policies).toEqual([
      { name: "pi_admin_select", roles: ["pi_admin"], cmd: "SELECT" },
      { name: "pi_owner_insert", roles: ["pi_owner"], cmd: "INSERT" },
    ]);
    const privileges = await queryAs<{ grantee: string; privilege: string }>(
      store.db.urls.admin,
      `select grantee::text as grantee, privilege_type::text as privilege from information_schema.role_table_grants
       where table_schema = 'ledger' and table_name = 'context_packs' and grantee <> 'pi_owner' order by grantee, privilege_type`,
    );
    expect(privileges).toEqual([{ grantee: "pi_admin", privilege: "SELECT" }]);
    // policy.log_pack: a definer function, executable by pi_reader alone of the runtime roles.
    const [fn] = await queryAs<{ definer: boolean; owner: string }>(
      store.db.urls.admin,
      "select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'policy' and p.proname = 'log_pack'",
    );
    expect(fn).toEqual({ definer: true, owner: "pi_owner" });
    for (const role of ["pi_reader", "pi_admin", "pi_writer", "pi_pipeline", "public"]) {
      const [row] = await queryAs<{ can: boolean }>(
        store.db.urls.admin,
        role === "public"
          ? "select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'policy.log_pack(text, text, text, text, text, text[])'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as can"
          : "select has_function_privilege($1, 'policy.log_pack(text, text, text, text, text, text[])', 'EXECUTE') as can",
        role === "public" ? [] : [role],
      );
      expect(row?.can, role).toBe(role === "pi_reader");
    }
  });
});

describe("a tool or a purpose the client's registration does not allow is refused before any read, and the refusal is recorded", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  // What a refusal before any read sends: nothing that names knowledge or the agent records.
  const expectNoRead = (statements: string[], name: string): void => {
    for (const text of statements) {
      expect(text, name).not.toMatch(NAMES_KNOWLEDGE);
      expect(text, name).not.toMatch(NAMES_RECORDS);
    }
  };
  const callsOf = (client: Client) =>
    callLog(store.db.urls.admin).then((rows) => rows.filter((row) => row.client === client.name));

  it("a refused build_context_pack is logged", async () => {
    const holds = await newClient();
    const lacks = await newClient({ tools: ["get_self"] });
    const { reader, during } = recordingReader();
    const invalid = await during(() => reader.refused(holds.token, "build_context_pack"));
    expect(invalid.answer).toEqual(INVALID);
    expectNoRead(invalid.statements, "invalid");
    const refused = await during(() => reader.refused(lacks.token, "build_context_pack"));
    expect(refused.answer).toEqual(NOT_PERMITTED);
    expectNoRead(refused.statements, "not_permitted");
    expect(await callsOf(holds)).toEqual([
      { client: holds.name, tool: "build_context_pack", rows: 0, outcome: "invalid_request" },
    ]);
    expect(await callsOf(lacks)).toEqual([
      { client: lacks.name, tool: "build_context_pack", rows: 0, outcome: "not_permitted" },
    ]);
  });

  it("a client without build_context_pack is refused not_permitted, and its call is recorded", async () => {
    const lacks = await newClient({ tools: ["get_self"] });
    const { reader, during } = recordingReader();
    const { answer, statements } = await during(() =>
      reader.buildContextPack(lacks.token, { purpose: "agent_bootstrap" }),
    );
    expect(answer).toEqual(NOT_PERMITTED);
    expectNoRead(statements, "no tool");
    expect(await callsOf(lacks)).toEqual([
      { client: lacks.name, tool: "build_context_pack", rows: 0, outcome: "not_permitted" },
    ]);
  });

  it("a client without the self view is refused not_permitted with no statement naming knowledge or ledger.agent_writes", async () => {
    const lacks = await newClient({ views: ["people"] });
    const { reader, during } = recordingReader();
    for (const args of [
      { purpose: "agent_bootstrap" as const },
      { purpose: "meeting_prep" as const, event: EventId.parse(`evt_${"0".repeat(26)}`) },
    ]) {
      const { answer, statements } = await during(() => reader.buildContextPack(lacks.token, args));
      expect(answer, args.purpose).toEqual(NOT_PERMITTED);
      expectNoRead(statements, args.purpose);
    }
    expect((await callsOf(lacks)).map((row) => row.outcome)).toEqual(["not_permitted", "not_permitted"]);
    expect(await packRows(lacks.id)).toEqual([]);
  });

  it("a client without the people view is refused not_permitted for meeting_prep, before any read", async () => {
    const lacks = await newClient({ views: ["self"] });
    const { reader, during } = recordingReader();
    const { answer, statements } = await during(() =>
      reader.buildContextPack(lacks.token, { purpose: "meeting_prep", event: EventId.parse(`evt_${"0".repeat(26)}`) }),
    );
    expect(answer).toEqual(NOT_PERMITTED);
    expectNoRead(statements, "meeting_prep");
    expect(await callsOf(lacks)).toEqual([
      { client: lacks.name, tool: "build_context_pack", rows: 0, outcome: "not_permitted" },
    ]);
    // The control: the same client may build agent_bootstrap.
    expect((await reader.buildContextPack(lacks.token, { purpose: "agent_bootstrap" })).ok).toBe(true);
  });

  it("bad arguments are refused invalid_request before any read", async () => {
    const client = await newClient();
    const { reader, during } = recordingReader();
    const event = EventId.parse(`evt_${"0".repeat(26)}`);
    for (const args of [
      { purpose: "meeting_prep" },
      { purpose: "agent_bootstrap", event },
      { purpose: "opportunity" },
      { purpose: "agent_bootstrap", more: 1 },
      { purpose: "meeting_prep", event: "evt_bad" },
    ]) {
      const { answer, statements } = await during(() => reader.buildContextPack(client.token, args as never));
      expect(answer, JSON.stringify(args)).toEqual(INVALID);
      expectNoRead(statements, JSON.stringify(args));
    }
    expect(await packRows(client.id)).toEqual([]);
  });
});
