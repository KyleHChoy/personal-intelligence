import { type ChildProcess, spawn } from "node:child_process";
import { type ClientRequest, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import {
  type CaptureItem,
  type CardId,
  ErasureReport,
  type ForgetItem,
  LensDeviceView,
  type MeetingItem,
  type MirrorEntry,
  MirrorPage,
  type MomentItem,
  PersonalReadTool,
  REFUSAL_CODE_HINTS,
} from "@intelligence/contracts/personal";
import { FOLD_SETUP, fakeLens } from "@intelligence/personal-core/testing";
import { applyMigrations, createAdmin, journalPath, readJournal } from "@intelligence/personal-store";
import { fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pi as inProcess, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { freePort, spawnPi } from "../test-support/spawn-pi.ts";

// Lens end to end. The capture runs: L1, L2, L8, L17 and L26; the mirror runs: L9, L24 and L28.
// Through the real `pi` and `pi http` processes, against a database with the production roles, the
// box's timer played by hand: `pi sync`, then `pi erase settle`.
//
// The synthetic world is synced in-process once, as the other end-to-end tests sync it, since the
// fake Google sources live in this process; no Google label is connected afterwards, so the real
// `pi sync` drains Lens's inbox alone. `pi lens add mac` prints its two tokens only to a terminal
// and a spawned process's output is a pipe, so it alone runs in-process with `stdoutIsTTY`; every
// other command, `pi http` among them, is a real process. Lens is played by HTTP requests from this
// file with fakeLens's items. The tests run in order and share one store: each step builds on the
// one before. A dump is a database copied with `create database ... template` while nothing is
// connected to it, as erase.e2e.db.test.ts takes one; a restore points the role URLs at the copy
// and keeps the key file and its journal.
//
// Covered elsewhere, not here: L9's erasure committed while a mirror call is between its read and
// its write, which needs two connections held inside one call (mirror-gate.db.test.ts; a real
// process cannot be stopped there); L8's every erasure hook, beyond the ledger taint checked here
// (capture-forget.db.test.ts); the claims a forget removes, since nothing here extracts: with no
// model the meeting lane commits none for these items (capture-erasure.db.test.ts and
// lens-meetings.db.test.ts hold the claims' removal); L2's and L17's every clause at the store
// (lens-database.db.test.ts, lens-revoke.db.test.ts); L26's unit cases (http.test.ts).

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const lens = fakeLens({ now: NOW });
const TEMPLATES = ["lens_mirror@1"];
// What every refusal of a token or a tool answers (http-answers.ts, REFUSED): the code and its hint.
const REFUSED_BODY = JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted });
const WIDE = ["employer:example", "own"];
// World people the mirror shows (world.ts): one of the employer's, one of the owner's own.
const DEVON = "devon.marsh@employer.test";
const HOLLIS = "hollis.crane@example.com";

type Env = Record<string, string>;
type Result = { exit: number | null; stdout: string; stderr: string };
type Store = Pick<TestDatabase, "name" | "urls" | "keys" | "keyFile">;

// Every line any process wrote, for the last test's canary scan.
const outputs: string[] = [];

// A real `pi`, with an explicit environment and nothing else.
async function pi(argv: string[], env: Env): Promise<Result> {
  const result = await spawnPi(argv, env);
  outputs.push(result.stdout, result.stderr);
  return result;
}
const ok = async (argv: string[], env: Env): Promise<string> => {
  const result = await pi(argv, env);
  expect(result.exit, `pi ${argv.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
};
// The log lines a run wrote to stderr; a hint line is left out.
const lines = (stderr: string): Record<string, unknown>[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

// `pi http` as the box runs it, a process of its own on a port of its own, until stop(): SIGTERM,
// as a redeploy ends it. It is ready once it logs http_listening.
type Http = { base: string; port: number; child: ChildProcess; stop(): Promise<number | null> };
async function startHttp(env: Env): Promise<Http> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, "http"], {
    env: { PATH: process.env.PATH ?? "", ...env, PI_HTTP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", (exit) => {
      outputs.push(stdout, stderr);
      resolve(exit);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes('"http_listening"')) resolve();
    });
    void closed.then((exit) => reject(new Error(`pi http ended with ${exit}: ${stderr}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    child,
    async stop() {
      child.kill("SIGTERM");
      return closed;
    },
  };
}

// A copy of the store, as a dump restored is (erase.e2e.db.test.ts): made from it as a template,
// with the database privileges a migration run gives. The key file and its journal are the
// store's: a restore brings the database back, not the volume.
let copies = 0;
const dumps: Store[] = [];
async function dumpOf(source: Store): Promise<Store> {
  copies += 1;
  const name = `${source.name}_l${copies}`;
  const server = source.urls.bootstrap.replace(new RegExp(`/${source.name}$`), "/postgres");
  await queryAs(server, `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(source.name)}`);
  const at = (url: string): string => url.replace(new RegExp(`/${source.name}$`), `/${name}`);
  const urls = {
    bootstrap: at(source.urls.bootstrap),
    admin: at(source.urls.admin),
    writer: at(source.urls.writer),
    reader: at(source.urls.reader),
    pipeline: at(source.urls.pipeline),
    work: at(source.urls.work),
    proxy: at(source.urls.proxy),
    restricted: at(source.urls.restricted),
  };
  await applyMigrations(urls.bootstrap);
  const dump = { name, urls, keys: source.keys, keyFile: source.keyFile };
  dumps.push(dump);
  return dump;
}

// An item's key, fresh: Lens's ULIDs, in Crockford's alphabet.
let serial = 0;
const keyOf = (kind: CaptureItem["kind"]): string => `${kind}:01JPXEND2E${String((serial += 1)).padStart(16, "0")}`;
const fresh = <T extends CaptureItem>(item: T): T => ({ ...structuredClone(item), key: keyOf(item.kind) }) as T;
const byKey = <T extends CaptureItem>(key: string): T => {
  const found = [...lens.meetings, ...lens.moments, ...lens.blocks, ...lens.forgets].find((item) => item.key === key);
  if (found === undefined) throw new Error(`no world item ${key}`);
  return structuredClone(found) as T;
};
const forgetOf = (keys: string[]): ForgetItem => ({ kind: "forget", key: keyOf("forget"), keys });
let batches = 0;
const batchId = (): string => `e2e-batch-${String((batches += 1)).padStart(4, "0")}`;

const failedLine = (code: string): string => JSON.stringify({ event: "command_failed", code });

describe("Lens end to end, through pi and pi http", () => {
  let s: Synced;
  let store: Store;
  let http: Http | undefined;
  let tokens = { capture: "", mirror: "" };
  let ids = { capture: "", mirror: "" };

  const adminEnv = (): Env => ({ PI_DATABASE_URL_ADMIN: store.urls.admin, PI_KEY_FILE: store.keyFile });
  const writerEnv = (): Env => ({ PI_DATABASE_URL_WRITER: store.urls.writer, PI_KEY_FILE: store.keyFile });
  const readerEnv = (): Env => ({ PI_DATABASE_URL_READER: store.urls.reader, PI_KEY_FILE: store.keyFile });
  const sql = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
    queryAs<Row>(store.urls.admin, text, values);
  const count = async (text: string, values?: unknown[]): Promise<number> =>
    (await sql<{ n: number }>(`select count(*)::int as n from ${text}`, values))[0]?.n ?? -1;
  const base = (): string => {
    if (http === undefined) throw new Error("pi http is not running");
    return http.base;
  };

  // The box's timer, once: `pi sync`, then `pi erase settle` after it. The settle's counts and the
  // sync's log lines.
  const timer = async (): Promise<{
    sync: Record<string, unknown>[];
    settle: { settled: number; alreadyRemoved: number; failed: number };
  }> => {
    const synced = await pi(["sync"], writerEnv());
    expect(synced.exit, synced.stderr).toBe(0);
    const settle = JSON.parse(await ok(["erase", "settle"], adminEnv())) as {
      settled: number;
      alreadyRemoved: number;
      failed: number;
    };
    return { sync: lines(synced.stderr), settle };
  };

  const post = (path: string, token: string | null, body: string): Promise<Response> =>
    fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body,
    });
  const push = async (items: unknown[], token: string = tokens.capture): Promise<{ status: number; body: unknown }> => {
    const answer = await post("/v1/tools/push_capture", token, JSON.stringify({ batch: batchId(), items }));
    return { status: answer.status, body: await answer.json() };
  };
  // An ack may also carry `erased`, the device's keys erased since its last push,
  // which capture-erasure.db.test.ts pins; here only the items' outcomes are the case.
  const accepted = (items: CaptureItem[]) => ({
    status: 200,
    body: expect.objectContaining({ items: items.map((item) => ({ key: item.key, outcome: "accepted" })) }),
  });

  // One sync_mirror call over REST, as Lens's mirror reader makes it.
  type Call = { cursor: string | null; erasedDone?: string[] };
  const mirrorCall = async (call: Call, token: string = tokens.mirror): Promise<{ status: number; text: string }> => {
    const answer = await post(
      "/v1/tools/sync_mirror",
      token,
      JSON.stringify({
        templates: TEMPLATES,
        cursor: call.cursor,
        ...(call.erasedDone === undefined ? {} : { erasedDone: call.erasedDone }),
      }),
    );
    return { status: answer.status, text: await answer.text() };
  };
  const page = async (call: Call): Promise<MirrorPage> => {
    const answer = await mirrorCall(call);
    expect(answer.status, answer.text).toBe(200);
    return MirrorPage.parse(JSON.parse(answer.text));
  };
  // Pages until one completes its pass.
  const pass = async (cursor: string | null): Promise<{ pages: MirrorPage[]; cursor: string }> => {
    const pages: MirrorPage[] = [];
    let next = cursor;
    // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
    for (let n = 0; n < 2_000; n += 1) {
      const one = await page({ cursor: next });
      pages.push(one);
      next = one.cursor;
      if (one.passComplete) return { pages, cursor: next };
    }
    throw new Error("no pass completed");
  };
  const entriesOf = (pages: readonly MirrorPage[]): MirrorEntry[] => pages.flatMap((one) => one.entries);
  const removalsOf = (pages: readonly MirrorPage[]): string[] =>
    pages.flatMap((one) => one.removals.map((removal) => removal.projection));
  const liveRows = async (): Promise<string[]> =>
    (
      await sql<{ id: string }>("select id from ledger.mirror_entries where client_id = $1 and ended_at is null", [
        ids.mirror,
      ])
    )
      .map((row) => row.id)
      .sort();

  const captureOf = async (key: string): Promise<{ id: string; evidence: string } | undefined> =>
    (
      await sql<{ id: string; evidence: string }>(
        "select id, evidence_id as evidence from knowledge.captures where capture_key = $1 order by id limit 1",
        [key],
      )
    )[0];
  const stored = async (key: string): Promise<boolean> => (await captureOf(key)) !== undefined;
  const personOf = async (address: string): Promise<string> => {
    const [row] = await sql<{ entity_id: string }>("select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(store.keys, "address", address),
    ]);
    if (row === undefined) throw new Error(`no person for ${address}`);
    return row.entity_id;
  };
  const erase = async (argv: string[]): Promise<ErasureReport> =>
    ErasureReport.parse(JSON.parse(await ok(["erase", ...argv], adminEnv())));
  const journalSeq = async (): Promise<number> => (await readJournal(journalPath(store.keyFile))).seq;
  const audiences = async (): Promise<string[][]> =>
    (await queryAs<{ audience: string[] }>(store.urls.pipeline, "select policy.audiences() as audience"))
      .map((row) => row.audience)
      .sort();

  // The world's items this file pushes, and what each becomes.
  const inScope = byKey<MomentItem>(lens.handles.inScopeMoment);
  const outOfScope = byKey<MomentItem>(lens.handles.outOfScopeMoment);
  const linked = byKey<MeetingItem>(lens.handles.linkedMeeting);
  const room = byKey<MeetingItem>(lens.handles.roomMeeting);
  const thirdParty = byKey<MeetingItem>(lens.handles.thirdPartyMeeting);
  const consented = byKey<MeetingItem>(lens.handles.consentedCall);
  const blockDay = byKey<CaptureItem>(lens.handles.blockDay);
  const worldForget = byKey<ForgetItem>(lens.handles.forget);
  let dumpBeforeForget: Store | undefined;
  let seqAtDump = 0;
  // A card resting on a capture item, which its erasure taints. `ledger.add_basis` resolves no capture ref, so the
  // card is raised with none, as the owner's admin raises one, and its basis row is written as pi_owner, as
  // capture-forget.db.test.ts writes it.
  const cardCiting = async (capture: { id: string; evidence: string }): Promise<CardId> => {
    const owner = createAdmin({ url: store.urls.admin, keys: store.keys, log: quiet });
    const card = `crd_01JPXEND2E${String((serial += 1)).padStart(16, "0")}` as CardId;
    try {
      await owner.cards.raiseCard({
        id: card,
        requestId: `e2e-${card.slice(4)}`,
        kind: "notice",
        author: "system:test",
        options: ["acknowledge"],
        target: null,
        refs: [],
        compartments: ["own"],
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: null,
        run: null,
        body: "e2e card body",
        bodyFrom: "code",
      });
    } finally {
      await owner.close();
    }
    const client = new pg.Client({ connectionString: store.urls.bootstrap });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local role pi_owner");
      await client.query("alter table ledger.basis no force row level security");
      await client.query(
        "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments) values ('card', $1, 'capture', $2, $3, 'source', false, '{own}')",
        [card, capture.id, capture.evidence],
      );
      await client.query("alter table ledger.basis force row level security");
      await client.query("commit");
    } finally {
      await client.end();
    }
    return card;
  };

  // Each test after the setup starts with pi http serving the current store: a test that failed
  // between a stop and a start would otherwise leave every later test without it. A test that
  // stops it stops this one.
  beforeEach(async () => {
    if (store === undefined || (http !== undefined && http.child.exitCode === null && http.child.signalCode === null))
      return;
    http = await startHttp(readerEnv());
  });

  afterAll(async () => {
    await http?.stop().catch(() => null);
    for (const dump of dumps) {
      const server = dump.urls.bootstrap.replace(new RegExp(`/${dump.name}$`), "/postgres");
      await queryAs(server, `drop database if exists ${pg.escapeIdentifier(dump.name)} with (force)`).catch(() => {});
    }
    await s?.drop();
  });

  it("setup: the world synced, pi lens add mac on a terminal, the scope added with pi lens scope add, and pi http serving", async () => {
    s = await syncedWorld({ now: NOW });
    store = s.db;
    // Registration, in-process on a terminal: the mirror cleared for own and the employer, so the
    // capture client's `own` would be an audience of its own if a device were one.
    const added = await inProcess(["lens", "add", "mac", "--compartments", WIDE.join(",")], adminEnv(), { tty: true });
    outputs.push(added.stdout.replace(/pit_[A-Za-z0-9_-]+/g, "pit_"), added.stderr);
    expect({ exit: added.exit, stderr: added.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(Object.keys(JSON.parse(added.stdout) as object)).toEqual(["capture"]);
    const issued = await inProcess(["lens", "rotate", "mac", "--mirror"], adminEnv(), { tty: true });
    outputs.push(issued.stderr);
    expect({ exit: issued.exit, stderr: issued.stderr }).toEqual({ exit: 0, stderr: "" });
    tokens = { capture: (JSON.parse(added.stdout) as { capture: string }).capture, mirror: issued.stdout.trimEnd() };
    expect(tokens.mirror).toMatch(/^pit_/);
    const clients = await sql<{ id: string; name: string }>(
      "select id, name from policy.clients where name in ('mac', 'mac-capture')",
    );
    ids = {
      capture: clients.find((one) => one.name === "mac-capture")?.id ?? "",
      mirror: clients.find((one) => one.name === "mac")?.id ?? "",
    };
    expect(ids.capture).toMatch(/^cli_/);
    expect(ids.mirror).toMatch(/^cli_/);

    // The owner's scope, the world's rules, one `pi lens scope add` each.
    for (const rule of lens.scope) {
      const argv = [
        "lens",
        "scope",
        "add",
        rule.match === "bundle" ? "--bundle" : "--host",
        rule.value,
        ...(rule.account === undefined ? [] : ["--account", rule.account]),
        "--compartment",
        rule.compartment,
        "--kinds",
        rule.kinds.join(","),
      ];
      expect((await ok(argv, adminEnv())).trim()).toMatch(/^csr_/);
    }
    expect(await count("policy.capture_scope")).toBe(lens.scope.length);
    http = await startHttp(readerEnv());
    expect(await audiences()).toEqual([WIDE]);
  });

  // -------------------------------------------------------------------------------------------
  // The capture runs
  // -------------------------------------------------------------------------------------------

  it("L2: with the capture token, every read tool and sync_mirror is refused at pi http, pi_reader with that token reads no labelled row, and the mirror token reads, as the control", async () => {
    for (const tool of PersonalReadTool.options) {
      const refused = await post(`/v1/tools/${tool}`, tokens.capture, "{}");
      expect([refused.status, await refused.text()], tool).toEqual([403, REFUSED_BODY]);
    }
    const listed = await fetch(`${base()}/v1/tools`, { headers: { authorization: `Bearer ${tokens.capture}` } });
    expect(((await listed.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual([
      "push_capture",
    ]);
    const overMcp = await post(
      "/mcp",
      tokens.capture,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_self", arguments: {} } }),
    );
    expect(await overMcp.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [
          { type: "text", text: "not_permitted" },
          { type: "text", text: JSON.stringify({ hint: REFUSAL_CODE_HINTS.not_permitted }) },
        ],
      },
    });
    // The control: the mirror client's token reads its one tool.
    expect((await mirrorCall({ cursor: null })).status).toBe(200);

    // The raw statement: pi_reader, with the capture token set as the reader sets it, selects no
    // row of any table whose reader policy reads the clearance; with the mirror token it does.
    const tables = (
      await sql<{ table: string }>(
        `select distinct schemaname || '.' || tablename as "table" from pg_policies
         where 'pi_reader' = any (roles) and cmd = 'SELECT' and qual ~ 'client_clearance|clearance_keys|clearance_key' order by 1`,
      )
    ).map((row) => row.table);
    expect(tables).toEqual(expect.arrayContaining(["knowledge.messages", "knowledge.captures"]));
    const counts = async (token: string): Promise<Record<string, number>> => {
      const client = new pg.Client({ connectionString: store.urls.reader });
      await client.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('pi.client_token', $1, true)", [token]);
        const seen: Record<string, number> = {};
        for (const table of tables)
          seen[table] = (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n ?? -1;
        await client.query("rollback");
        return seen;
      } finally {
        await client.end();
      }
    };
    expect(await counts(tokens.capture)).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));
    expect((await counts(tokens.mirror))["knowledge.messages"]).toBeGreaterThan(0);
  });

  it("L1: a push carrying a label, a compartment, an entity id or a fact key is 400 invalid_request and writes only its call row; the same item without it is accepted, staged {own}", async () => {
    const calls = (): Promise<{ outcome: string }[]> =>
      sql<{ outcome: string }>("select outcome from policy.calls where client_id = $1 order by id", [ids.capture]);
    const item = fresh(inScope);
    const forged = [
      { ...item, compartments: ["employer:example"] },
      { ...item, label: { compartments: ["employer:example"], readers: ["m-owner"] } },
      { ...item, entity: `ent_${"0".repeat(26)}` },
      { ...item, factKey: "commitment:forged" },
    ];
    for (const one of forged) {
      const before = (await calls()).length;
      // The refusal names the one field the item may not carry, and nothing of its value. An item
      // already has an `entity` (its kind: chat, doc, mail or page), so an entity id there is a
      // bad value, not a new field.
      const field =
        Object.keys(one).find(
          (key) => !(key in item) || (one as Record<string, unknown>)[key] !== (item as Record<string, unknown>)[key],
        ) ?? "";
      const rule = field in item ? "must be one of: chat, doc, mail, page" : "no such field";
      expect(await push([one])).toEqual({
        status: 400,
        body: { error: "invalid_request", arguments: [{ name: `items.0.${field}`, rule }] },
      });
      expect((await calls()).slice(before)).toEqual([{ outcome: "invalid_request" }]);
      expect(
        await count("ledger.capture_inbox where client_id = $1 and source_key_fp = $2", [
          ids.capture,
          fingerprint(store.keys, "source_id", item.key),
        ]),
      ).toBe(0);
    }
    // The control.
    expect(await push([item])).toEqual(accepted([item]));
    // A device client calling any tool but push_capture is not_permitted (L2 holds every read
    // tool; a work tool here too).
    const work = await post("/v1/tools/list_opportunities", tokens.capture, "{}");
    expect([work.status, await work.text()]).toEqual([403, REFUSED_BODY]);

    // policy.push_capture called as pi_reader with the capture token, an item naming compartments
    // of its own: the row is staged {own}, whatever the item said. The item is a forget with a body
    // no key opens, taken out of the queue after, so no settle meets it.
    const id = `cin_01JPXEND2E${"0".repeat(15)}1`;
    const rawItem = {
      id,
      kind: "forget",
      source_key_fp: "c".repeat(64),
      content_fp: "d".repeat(64),
      revision: 0,
      body_bytes: 2,
      body_enc: { v: 1, nonce: "bm9uY2U", ciphertext: "Y2lwaGVy", tag: "dGFn" },
      surfaces: [],
      compartments: ["employer:example"],
    };
    const raw = new pg.Client({ connectionString: store.urls.reader });
    await raw.connect();
    try {
      await raw.query("select set_config('pi.client_token', $1, false)", [tokens.capture]);
      await raw.query("select policy.open_session($1)", [`ses_01JPXEND2E${"0".repeat(15)}1`]);
      await raw.query("select * from policy.push_capture($1, 'e2e-raw-0001', $2::jsonb, false)", [
        `ses_01JPXEND2E${"0".repeat(15)}1`,
        JSON.stringify([rawItem]),
      ]);
    } finally {
      await raw.end();
    }
    expect(await sql("select compartments from ledger.capture_inbox where id = $1", [id])).toEqual([
      { compartments: ["own"] },
    ]);
    await sql("update ledger.capture_inbox set taken_at = now(), body_enc = null where id = $1", [id]);
  });

  it("L26: the 1 MiB route refuses a large body with no token, or with a token that is not a device's, before 64 KiB of it is read; a fifth large body at once is 429", async () => {
    // A request whose body is not sent whole until `finish`: its answer, and the means to end it.
    type Open = { request: ClientRequest; answer: Promise<{ status: number; body: string }>; finish(): void };
    const open = (token: string | null, body: string, sent: number, declare = true): Open => {
      const bytes = Buffer.from(body, "utf8");
      const request = httpRequest({
        host: "127.0.0.1",
        port: http?.port,
        method: "POST",
        path: "/v1/tools/push_capture",
        headers: {
          "content-type": "application/json",
          ...(declare ? { "content-length": String(bytes.length) } : {}),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });
      const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request.on("response", (response) => {
          let text = "";
          response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
        });
        request.on("error", reject);
      });
      request.write(bytes.subarray(0, sent));
      return {
        request,
        answer,
        finish() {
          request.end(bytes.subarray(sent));
        },
      };
    };
    // A batch over 64 KiB, of items no rule admits (out_of_scope at push), so nothing is stored.
    const large = (): string =>
      JSON.stringify({
        batch: batchId(),
        items: Array.from({ length: 50 }, () => ({ ...fresh(outOfScope), text: "w".repeat(4_000) })),
      });
    expect(large().length).toBeGreaterThan(64 * 1024);

    // No token, and the mirror token, each with 1 KiB of the body sent: answered at once.
    for (const token of [null, tokens.mirror]) {
      const one = open(token, large(), 1_024);
      expect(await one.answer, String(token === null)).toEqual({ status: 413, body: '{"error":"invalid_request"}' });
      one.request.destroy();
    }
    // A body of no declared length and no token is refused before it is read.
    const undeclared = open(null, large(), 1_024, false);
    expect((await undeclared.answer).status).toBe(403);
    undeclared.request.destroy();

    // Five large bodies from the capture client at once, each with 70 KiB sent and held. Four take
    // the server's slots and wait for the rest of their bodies; the one that finds none is
    // answered 429 before it is read. So the first answer of the five is a 429, whichever it is.
    const five = Array.from({ length: 5 }, () => open(tokens.capture, large(), 70 * 1024));
    const first = await Promise.race(five.map((one, index) => one.answer.then((answer) => ({ index, answer }))));
    expect(first.answer).toEqual({ status: 429, body: '{"error":"rate_limited"}' });
    five[first.index]?.request.destroy();
    const four = five.filter((_, index) => index !== first.index);
    // The four, sent whole, are answered: every item refused out_of_scope, and nothing stored.
    for (const one of four) one.finish();
    for (const one of four) {
      const answer = await one.answer;
      expect(answer.status).toBe(200);
      const acked = JSON.parse(answer.body) as { items: { outcome: string; code?: string }[] };
      expect(acked.items).toHaveLength(50);
      for (const item of acked.items) expect(item).toMatchObject({ outcome: "refused", code: "out_of_scope" });
    }
  });

  it("the drain: the world's items pushed to pi http, taken by pi sync, every inbox row staged {own}", async () => {
    const items = [inScope, linked, room, thirdParty, consented, blockDay];
    const answer = await push([...items, outOfScope]);
    expect(answer).toEqual({
      status: 200,
      body: {
        items: [
          ...items.map((item) => ({ key: item.key, outcome: "accepted" })),
          { key: outOfScope.key, outcome: "refused", code: "out_of_scope" },
        ],
      },
    });
    expect(
      await sql("select distinct compartments from ledger.capture_inbox where client_id = $1", [ids.capture]),
    ).toEqual([{ compartments: ["own"] }]);
    const { settle } = await timer();
    expect(settle).toEqual({ settled: 0, alreadyRemoved: 0, failed: 0 });
    for (const item of items) expect(await stored(item.key), item.key).toBe(true);
    expect(await stored(outOfScope.key)).toBe(false);
  });

  it("L8: pi erase settle removes what a forget names and everything derived from it, writes no ruling, and a later push of the key is dropped removed", async () => {
    // The dump of a restore to come, taken before the forget with nothing connected.
    await http?.stop();
    dumpBeforeForget = await dumpOf(store);
    seqAtDump = await journalSeq();
    http = await startHttp(readerEnv());

    const meeting = await captureOf(room.key);
    if (meeting === undefined) throw new Error("the room meeting is not stored");
    // What the forget removes, held before it: the evidence row, its blob, the captures row.
    // Claims of it: none here, since nothing extracts (the file's header).
    const held = async () => ({
      evidence: await count("vault.evidence_items where id = $1", [meeting.evidence]),
      blobs: await count(
        "vault.evidence_blobs b where b.blob_ref in (select e.blob_ref from vault.evidence_items e where e.id = $1)",
        [meeting.evidence],
      ),
      captures: await count("knowledge.captures where evidence_id = $1", [meeting.evidence]),
      claims: await count("knowledge.claims where evidence_id = $1", [meeting.evidence]),
    });
    const blobRef =
      (
        await sql<{ blob_ref: string }>("select blob_ref from vault.evidence_items where id = $1", [meeting.evidence])
      )[0]?.blob_ref ?? "";
    expect(await held()).toEqual({ evidence: 1, blobs: 1, captures: 1, claims: 0 });
    // A ledger row resting on it: a card citing the meeting, which the forget must taint.
    const card = await cardCiting(meeting);
    const journal = await journalSeq();
    // The world's forget names the room meeting, stored, and the out-of-scope moment, never stored.
    expect(await push([worldForget])).toEqual(accepted([worldForget]));
    const { settle } = await timer();
    expect(settle).toEqual({ settled: 1, alreadyRemoved: 0, failed: 0 });
    expect(await journalSeq()).toBe(journal + 1);
    expect(await stored(room.key)).toBe(false);
    expect(await held()).toEqual({ evidence: 0, blobs: 0, captures: 0, claims: 0 });
    expect(await count("vault.evidence_blobs where blob_ref = $1", [blobRef])).toBe(0);
    expect(
      await sql(
        "select tainted_at is not null as tainted, body_enc is null as emptied from ledger.cards where id = $1",
        [card],
      ),
    ).toEqual([{ tainted: true, emptied: true }]);
    expect(await sql("select kind, ruling_id from knowledge.erasures")).toEqual([
      { kind: "device_forget", ruling_id: null },
    ]);

    // A later push of the forgotten key, as a new revision, is accepted and dropped at drain.
    const again = { ...room, revision: 1 };
    expect(await push([again])).toEqual(accepted([again]));
    const { sync } = await timer();
    expect(
      sync.some(
        (line) => line.event === "capture_taken" && (line.counts as Record<string, number>).dropped_removed === 1,
      ),
    ).toBe(true);
    expect(await stored(room.key)).toBe(false);
    // pi status shows the device's drop by its code, and nothing of what was dropped.
    const status = await ok(["status"], adminEnv());
    const device = (JSON.parse(status) as { devices: unknown[] }).devices
      .map((one) => LensDeviceView.parse(one))
      .find((one) => one.name === "mac");
    expect(device?.inbox.dropped.removed ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("L8: a forget and a pi erase racing take two journal numbers, and a forget whose settlement fails holds back no other", async () => {
    const before = await journalSeq();
    const item = await captureOf(thirdParty.key);
    expect(await push([forgetOf([consented.key])])).toEqual({
      status: 200,
      body: { items: [expect.objectContaining({ outcome: "accepted" })] },
    });
    // Both at once: each takes the sync lock first, so one may answer sync_running and take no
    // number, or find the journal a step ahead of the other's commit and ask for a replay it does
    // not need; that one is run again after.
    const raced = [
      ["erase", "settle"],
      ["erase", "item", item?.id ?? ""],
    ];
    const results = await Promise.all(raced.map((argv) => pi(argv, adminEnv())));
    for (const [index, result] of results.entries()) {
      if (result.exit === 0) continue;
      expect(result.stderr, raced[index]?.join(" ")).toMatch(/"code":"(?:sync_running|erasure_replay_needed)"/);
      await ok(raced[index] ?? [], adminEnv());
    }
    const journal = await readJournal(journalPath(store.keyFile));
    expect(journal.seq).toBe(before + 2);
    expect(new Set(journal.entries.slice(before).map((entry) => entry.seq)).size).toBe(2);
    expect(await stored(consented.key)).toBe(false);
    expect(await stored(thirdParty.key)).toBe(false);

    // Two forgets, the first unreadable: its body is replaced by the second's, sealed to another
    // row. The second, of a key never sent, settles all the same.
    const broken = forgetOf([blockDay.key]);
    const sound = forgetOf([keyOf("moment")]);
    expect(await push([broken])).toEqual(accepted([broken]));
    expect(await push([sound])).toEqual(accepted([sound]));
    const rowOf = async (forget: ForgetItem): Promise<string> =>
      (
        await sql<{ id: string }>("select id from ledger.capture_inbox where client_id = $1 and source_key_fp = $2", [
          ids.capture,
          fingerprint(store.keys, "source_id", forget.key),
        ])
      )[0]?.id ?? "";
    const [brokenRow, soundRow] = [await rowOf(broken), await rowOf(sound)];
    await sql(
      "update ledger.capture_inbox set body_enc = (select body_enc from ledger.capture_inbox where id = $2) where id = $1",
      [brokenRow, soundRow],
    );
    const { settle } = await timer();
    expect(settle).toEqual({ settled: 1, alreadyRemoved: 0, failed: 1 });
    expect(await stored(blockDay.key)).toBe(true);
    // The broken forget is the test's own doing: taken out of the queue, so later runs count none.
    await sql("update ledger.capture_inbox set taken_at = now(), body_enc = null where id = $1 and taken_at is null", [
      brokenRow,
    ]);
  });

  it("L8: after a restore from a dump taken before the forget, the replay removes it again before the first read and writes no ruling, and the resent forget settles as already_removed", async () => {
    if (dumpBeforeForget === undefined) throw new Error("no dump");
    const seqNow = await journalSeq();
    expect(seqNow).toBeGreaterThan(seqAtDump);
    await http?.stop();
    http = undefined;
    store = dumpBeforeForget;
    // The restored database holds the room meeting again, and nothing reads before the replay.
    expect(await stored(room.key)).toBe(true);
    const refused = await pi(["sync"], writerEnv());
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(failedLine("erasure_replay_needed"));
    const served = await pi(["http"], { ...readerEnv(), PI_HTTP_PORT: String(await freePort()) });
    expect(served.exit).toBe(1);
    expect(served.stderr).toContain(failedLine("erasure_replay_needed"));
    // Every erasure journalled since the dump: the forget, the race's two, and the sound forget.
    expect(JSON.parse(await ok(["erase", "replay"], adminEnv()))).toEqual({
      applied: seqNow - seqAtDump,
      journalled: 0,
    });
    for (const key of [room.key, consented.key, thirdParty.key]) expect(await stored(key), key).toBe(false);
    expect(await stored(blockDay.key)).toBe(true);
    expect(await count("knowledge.captures where capture_key = $1", [room.key])).toBe(0);
    expect(
      (
        await sql<{ ruling_id: string | null }>("select ruling_id from knowledge.erasures where kind = 'device_forget'")
      ).map((row) => row.ruling_id),
    ).toEqual([null, null, null]);

    // Lens's "resend since": the forget again, as sent.
    http = await startHttp(readerEnv());
    expect(await push([worldForget])).toEqual(accepted([worldForget]));
    const { settle } = await timer();
    expect(settle).toEqual({ settled: 0, alreadyRemoved: 2, failed: 0 });
  });

  // -------------------------------------------------------------------------------------------
  // The mirror runs
  // -------------------------------------------------------------------------------------------

  let latest = "";
  let held: MirrorPage[] = [];

  it("the mirror's first pass, over pi http from a null cursor, holds the stored items and the world's people", async () => {
    const first = await pass(null);
    held = first.pages;
    latest = first.cursor;
    const text = JSON.stringify(entriesOf(first.pages));
    const moment = await captureOf(inScope.key);
    expect(text).toContain(moment?.id ?? "-");
    for (const address of [DEVON, HOLLIS]) {
      const person = await personOf(address);
      expect(
        entriesOf(first.pages).some((entry) => entry.section === "entities" && entry.entity.id === person),
        address,
      ).toBe(true);
    }
  });

  it("L9, L28: pi erase item cap_ and pi erase person end the rows resting on them in the erasure's transaction; the next call sends their removals and the key, again until confirmed", async () => {
    const moment = await captureOf(inScope.key);
    if (moment === undefined) throw new Error("the moment is not stored");
    const devon = await personOf(DEVON);
    const projectionOf = (match: (entry: MirrorEntry) => boolean): string =>
      entriesOf(held).find(match)?.stamp.projection ?? "";
    const momentEntry = projectionOf(
      (entry) => entry.section === "captures" && JSON.stringify(entry).includes(moment.id),
    );
    const devonEntry = projectionOf((entry) => entry.section === "entities" && entry.entity.id === devon);
    expect(momentEntry).toMatch(/^mir_/);
    expect(devonEntry).toMatch(/^mir_/);
    const live = await liveRows();
    expect(live).toEqual(expect.arrayContaining([momentEntry, devonEntry]));

    expect((await erase(["item", moment.id])).items).toBe(1);
    const report = await erase(["person", devon]);
    expect(report.more.mirror).toBe(1);
    // Ended in the erasures' own transactions, before any call.
    const after = await liveRows();
    expect(after).not.toContain(momentEntry);
    expect(after).not.toContain(devonEntry);

    // After the pass, before the next is due: removals and the erased key, and no entry.
    // (The race's `pi erase item` of L8 left its key unconfirmed too, so each page may hold it.)
    const one = await page({ cursor: latest });
    expect(one.removals.map((removal) => removal.projection)).toEqual(
      expect.arrayContaining([momentEntry, devonEntry]),
    );
    for (const removal of one.removals) expect(removal.reason).toBe("withdrawn");
    expect(one.captureErased).toContain(inScope.key);
    expect(one.entries).toEqual([]);
    // The page lost: the cursor before the latest sends them again.
    const again = await page({ cursor: latest });
    expect(removalsOf([again])).toEqual(expect.arrayContaining([momentEntry, devonEntry]));
    expect(again.captureErased).toContain(inScope.key);
    // Confirmed by the latest cursor: the removals are told. The key is served until erasedDone
    // lists it (L28).
    const told = await page({ cursor: again.cursor });
    expect(removalsOf([told])).not.toContain(momentEntry);
    expect(removalsOf([told])).not.toContain(devonEntry);
    expect(told.captureErased).toContain(inScope.key);
    const done = await page({ cursor: told.cursor, erasedDone: told.captureErased });
    expect(done.captureErased).toEqual([]);
    const later = await page({ cursor: done.cursor });
    expect(later.captureErased).toEqual([]);
    latest = later.cursor;
  });

  it("L24, L9, L28: after a wipe and a null cursor every visible entry is sent again; a person erased mid-pass is removed in the next call, and serves no key", async () => {
    const hollis = await personOf(HOLLIS);
    const hollisIn = (one: MirrorPage): string | undefined =>
      one.entries.find((entry) => entry.section === "entities" && entry.entity.id === hollis)?.stamp.projection;
    // The wipe: Lens starts from null with an empty mirror, and reads until the page that holds the
    // person.
    const before: MirrorPage[] = [];
    let cursor: string | null = null;
    let hollisEntry: string | undefined;
    for (let n = 0; n < 40 && hollisEntry === undefined; n += 1) {
      const one = await page({ cursor });
      before.push(one);
      cursor = one.cursor;
      hollisEntry = hollisIn(one);
    }
    expect(hollisEntry).toMatch(/^mir_/);
    await erase(["person", hollis]);
    // The next call, mid-pass or after it, removes the person's entry; a person's erasure serves
    // no key (L28).
    const next = await page({ cursor });
    expect(removalsOf([next])).toContain(hollisEntry);
    expect(next.captureErased).toEqual([]);
    const rest = next.passComplete ? { pages: [], cursor: next.cursor } : await pass(next.cursor);
    // The Mac's copy, each page applied removals first: every live row of the client.
    const pages = [...before, next, ...rest.pages];
    const mac = new Set<string>();
    for (const one of pages) {
      for (const removal of one.removals) mac.delete(removal.projection);
      for (const entry of one.entries) mac.add(entry.stamp.projection);
    }
    expect([...mac].sort()).toEqual(await liveRows());
    expect(mac.has(hollisEntry ?? "")).toBe(false);
    // The linked meeting is among them: the control of the restore below.
    const meeting = await captureOf(linked.key);
    expect(JSON.stringify(entriesOf(pages))).toContain(meeting?.id ?? "-");
    held = pages;
    latest = rest.cursor;
  });

  it("L24: after a database restore, the Mac's cursor is 409 stale_cursor, and the rebuilt mirror holds nothing erased after the dump", async () => {
    const meeting = await captureOf(linked.key);
    if (meeting === undefined) throw new Error("the linked meeting is not stored");
    await http?.stop();
    const dump = await dumpOf(store);
    const atDump = await journalSeq();
    http = await startHttp(readerEnv());
    // A call after the dump: its cursor is unknown to the dump.
    const after = await page({ cursor: latest });
    expect((await erase(["item", meeting.id])).items).toBe(1);

    await http.stop();
    http = undefined;
    store = dump;
    expect(JSON.parse(await ok(["erase", "replay"], adminEnv()))).toEqual({
      applied: (await journalSeq()) - atDump,
      journalled: 0,
    });
    http = await startHttp(readerEnv());
    expect(await mirrorCall({ cursor: after.cursor })).toEqual({ status: 409, text: '{"error":"stale_cursor"}' });
    // Lens wipes and starts again from null: nothing of the erased meeting in any entry.
    const rebuilt = await pass(null);
    expect(JSON.stringify(entriesOf(rebuilt.pages))).not.toContain(meeting.id);
    expect(await stored(linked.key)).toBe(false);
    latest = rebuilt.cursor;
  });

  // -------------------------------------------------------------------------------------------
  // L17, both halves, last: it ends the device
  // -------------------------------------------------------------------------------------------

  it("L17: after pi lens revoke, both tokens answer 403 and write no row, the inbox rows pushed before it are still drained, the mirror's rows are ended, and no device client is an audience", async () => {
    const late = fresh(inScope);
    expect(await push([late])).toEqual(accepted([late]));
    expect((await liveRows()).length).toBeGreaterThan(0);
    expect(await ok(["lens", "revoke", "mac"], adminEnv())).toBe("");

    const calls = await count("policy.calls");
    const sessions = await count("ledger.sessions");
    const pushed = await push([fresh(inScope)]);
    expect(pushed).toEqual({ status: 403, body: { error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted } });
    expect(await mirrorCall({ cursor: latest })).toEqual({ status: 403, text: REFUSED_BODY });
    expect(await count("policy.calls")).toBe(calls);
    expect(await count("ledger.sessions")).toBe(sessions);
    // The mirror half: every live row ended by the revocation, withdrawn.
    expect(await liveRows()).toEqual([]);
    expect(
      await count(
        "ledger.mirror_entries where client_id = $1 and ended_at >= now() - interval '10 minutes' and reason <> 'withdrawn'",
        [ids.mirror],
      ),
    ).toBe(0);
    // The drain clause: what was pushed before the revocation is still taken.
    await timer();
    expect(await stored(late.key)).toBe(true);
    expect(await audiences()).toEqual([]);
  });

  it("no line any process wrote holds a canary, a name, an address, a host, a bundle id or a title of the world", async () => {
    await http?.stop();
    http = undefined;
    const needles = [
      ...Object.values(lens.canaries),
      "Devon Marsh",
      "Robin Vale",
      "Hollis Crane",
      DEVON,
      HOLLIS,
      "robin.vale@example.org",
      "wiki.example.org",
      "unruled.example.net",
      "test.example.reader",
      "test.example.meet",
      "Rota review",
      "Kitchen planning",
    ].map((needle) => needle.toLowerCase());
    expect(outputs.length).toBeGreaterThan(20);
    // The positive control: the scan reads the lines the processes wrote, which hold the events
    // each step logs.
    const all = outputs.join("\n");
    for (const event of ["capture_pushed", "capture_taken", "forgets_settled", "mirror_served", "http_listening"])
      expect(all, event).toContain(`"event":"${event}"`);
    for (const output of outputs) {
      const text = output.toLowerCase();
      for (const needle of needles) expect(text.includes(needle), needle).toBe(false);
    }
  });
});
