import type { AgentRecordArgs, PersonalTool } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader } from "../../read/read.ts";
import { readAs } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { lines, snapshot } from "../../test-support/snapshot.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { outcomeValue, refusedWith, registration } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

// The owner's reads and removal of agent records, as pi_admin.

const COMPARTMENTS = ["own", "employer:example", "agent:alpha", "agent:beta"];

let store: TestStore;
let admin: Admin;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  store = await openStore({ compartments: COMPARTMENTS });
  admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
  const tools = ["get_self", "record"] as PersonalTool[];
  tokens.alpha = (await admin.clients.addClient(registration("alpha", ["own"], { tools }))).token;
  tokens.beta = (await admin.clients.addClient(registration("beta", ["own", "employer:example"], { tools }))).token;
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

const newSession = (): Reader => new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log });
let requests = 0;
async function write(
  client: "alpha" | "beta",
  over: Partial<AgentRecordArgs> = {},
  reader = newSession(),
): Promise<string> {
  requests += 1;
  const args: AgentRecordArgs = {
    kind: "note",
    body: `the owner's record ${requests}`,
    requestId: `owner-request-${String(requests).padStart(6, "0")}`,
    ...over,
  };
  return outcomeValue(await reader.record(tokens[client] ?? "", args)).recordId;
}
const evidenceOf = async (id: string): Promise<string | null> =>
  (
    await queryAs<{ evidence_id: string | null }>(
      store.db.urls.admin,
      "select evidence_id from ledger.agent_writes where id = $1",
      [id],
    )
  )[0]?.evidence_id ?? null;

describe("the admin: agent records", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the list holds every agent record, of every client and label, and no content", async () => {
    const body = "a body the list never prints";
    const ids = [
      await write("alpha", { body }),
      await write("beta", { kind: "finding", body }),
      await write("beta", { kind: "handoff", body }),
    ];
    const listed = await admin.agents.listRecords();
    expect(listed.map((row) => row.id)).toEqual(expect.arrayContaining(ids));
    const byId = new Map(listed.map((row) => [row.id, row]));
    expect(byId.get((ids[0] ?? "") as never)).toEqual({
      id: ids[0],
      client: "alpha",
      kind: "note",
      createdAt: expect.any(String),
      compartments: ["agent:alpha", "own"],
      state: "appended",
      flagged: false,
    });
    expect(byId.get((ids[1] ?? "") as never)).toMatchObject({
      client: "beta",
      kind: "finding",
      compartments: ["agent:beta", "employer:example", "own"],
    });
    expect(JSON.stringify(listed)).not.toContain(body);
    for (const row of listed)
      expect(Object.keys(row).sort()).toEqual([
        "client",
        "compartments",
        "createdAt",
        "flagged",
        "id",
        "kind",
        "state",
      ]);
    // Newest first, and the filters.
    const times = listed.map((row) => row.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await admin.agents.listRecords({ client: "beta" })).every((row) => row.client === "beta")).toBe(true);
    expect((await admin.agents.listRecords({ kind: "handoff" })).map((row) => row.id)).toEqual([ids[2]]);
    expect(await admin.agents.listRecords({ limit: 1 })).toHaveLength(1);
    for (const bad of [{ kind: "memo" }, { state: "lost" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      expect(await refusedWith(() => admin.agents.listRecords(bad)), JSON.stringify(bad)).toEqual({
        name: "AdminError",
        code: "invalid_argument",
      });
    }
  });

  it("the states are appended, taken, refused and removed, and a row with no body is removed whatever its code", async () => {
    const taken = await write("alpha");
    const refused = await write("alpha");
    const removed = await write("alpha");
    const coded = await write("alpha");
    // Marked as intake marks one, in the writer's columns; emptied as removeOne empties one.
    await queryAs(
      store.db.urls.writer,
      "update ledger.agent_writes set refused_code = 'content_mismatch' where id = $1",
      [refused],
    );
    await queryAs(store.db.urls.writer, "update ledger.agent_writes set refused_code = 'open_failed' where id = $1", [
      coded,
    ]);
    await queryAs(
      store.db.urls.admin,
      "update ledger.agent_writes set body_enc = null, tainted_at = now() where id = any($1)",
      [[removed, coded]],
    );
    await store.writer.takeRecords();
    const appended = await write("alpha");
    const states = new Map(
      (await admin.agents.listRecords({ client: "alpha" })).map((row) => [row.id as string, row.state]),
    );
    expect([taken, refused, removed, coded, appended].map((id) => states.get(id))).toEqual([
      "taken",
      "refused",
      "removed",
      "removed",
      "appended",
    ]);
    const listedRemoved = (await admin.agents.listRecords({ state: "removed", client: "alpha" })).map(
      (row) => row.id as string,
    );
    expect(listedRemoved).toEqual(expect.arrayContaining([removed, coded]));
    expect(listedRemoved).not.toContain(taken);
  });

  it("record opens a body sealed under several compartments", async () => {
    const body = "sealed under three compartments";
    const id = await write("beta", { body, kind: "finding" });
    const view = await admin.agents.record(id);
    expect(view).toMatchObject({
      id,
      client: "beta",
      kind: "finding",
      compartments: ["agent:beta", "employer:example", "own"],
      body,
      cites: [],
      refusedCode: null,
      state: "appended",
    });
    expect(await admin.agents.record("rec_00000000000000000000000000")).toBeNull();
  });

  it("removeRecord leaves no body, no evidence row and no blob, and keeps the row's ids", async () => {
    const id = await write("alpha");
    await store.writer.takeRecords();
    const evidence = await evidenceOf(id);
    expect(evidence).not.toBeNull();
    const [{ blob_ref } = { blob_ref: "" }] = await queryAs<{ blob_ref: string }>(
      store.db.urls.admin,
      "select blob_ref from vault.evidence_items where id = $1",
      [evidence],
    );
    const before = (
      await queryAs(
        store.db.urls.admin,
        "select id, client_id, session_id, request_id, content_fp, cites, evidence_id from ledger.agent_writes where id = $1",
        [id],
      )
    )[0];
    expect(await admin.agents.removeRecord(id)).toEqual({ removed: 1 });
    expect(
      await queryAs(
        store.db.urls.admin,
        "select body_enc, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
        [id],
      ),
    ).toEqual([{ body_enc: null, tainted: true }]);
    expect(await queryAs(store.db.urls.admin, "select id from vault.evidence_items where id = $1", [evidence])).toEqual(
      [],
    );
    expect(
      await queryAs(store.db.urls.admin, "select blob_ref from vault.evidence_blobs where blob_ref = $1", [blob_ref]),
    ).toEqual([]);
    expect(
      (
        await queryAs(
          store.db.urls.admin,
          "select id, client_id, session_id, request_id, content_fp, cites, evidence_id from ledger.agent_writes where id = $1",
          [id],
        )
      )[0],
    ).toEqual(before);
    expect((await admin.agents.record(id))?.body).toBeNull();
  });

  it("removeRecord removes that one agent record: a later one whose session was shown its body in a pack stays", async () => {
    const shown = await write("alpha", { kind: "handoff" });
    const reader = newSession();
    expect((await reader.getSelf(tokens.alpha ?? "")).ok).toBe(true);
    const [sessionRow] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select s.id from ledger.sessions s join policy.clients c on c.id = s.client_id where c.name = 'alpha' order by s.started_at desc, s.id desc limit 1",
    );
    // The pack's read log row, as the pack's read writes it: the handoff's body shown.
    await readAs(store.db, tokens.alpha ?? "", (query) =>
      query("select policy.log_read($1, 'get_self', '{}', $2, '{}')", [sessionRow?.id, [shown]]),
    );
    const later = await write("alpha", { kind: "handoff" }, reader);
    expect(await admin.agents.removeRecord(shown)).toEqual({ removed: 1 });
    expect((await admin.agents.record(later))?.body).not.toBeNull();
  });

  it("removeRecord twice answers 0 the second time", async () => {
    const id = await write("beta");
    expect(await admin.agents.removeRecord(id)).toEqual({ removed: 1 });
    expect(await admin.agents.removeRecord(id)).toEqual({ removed: 0 });
  });

  it("removeRecord of an unknown id answers null and writes nothing", async () => {
    const before = lines(await snapshot(store.db));
    expect(await admin.agents.removeRecord("rec_00000000000000000000000000")).toBeNull();
    expect(await admin.agents.removeRecord("not an id")).toBeNull();
    expect(lines(await snapshot(store.db))).toEqual(before);
  });
});
