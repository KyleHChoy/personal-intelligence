import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  type CaptureItem,
  MIRROR_QUOTA,
  type MomentItem,
  PersonalReadTool,
  type PushCaptureAck,
  QUOTA_DEFAULTS,
  REFUSAL_CODE_HINTS,
} from "@intelligence/contracts/personal";
import { fakeLens, type LensWorld } from "@intelligence/personal-core/testing";
import { serveHttp } from "@intelligence/personal-mcp";
import { createReader, createWork } from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../commands.ts";
import { quiet } from "../test-support/extract-fixtures.ts";
import { freePort } from "../test-support/spawn-pi.ts";

// `pi http`'s push route against the database. The routes are served as `pi http` serves them, by
// serveHttp over a reader and work on the reader URL, with each reply deadline's wait one turn of
// the event loop; the real `pi http` runs once, in-process, for the variable it reads. One database
// for the file; the device is registered by hand as addDevice makes it. Every refusal has its
// control in the same test.

const TIMEOUT = 120_000;
// What every refusal of a token or a tool answers (http-answers.ts, REFUSED): the code and its hint.
const REFUSED_BODY = JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted });
const NOW = new Date("2026-10-07T12:00:00.000Z");
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Channel = { id: string; name: string; token: string };
let db: TestDatabase;
let lens: LensWorld;
let capture: Channel;
let mirror: Channel;
let served: { base: string; close(): Promise<void> } | undefined;

// The device as `pi lens add mac` makes it, but that its mirror client also holds every read tool,
// as the owner may give it with set-tools: L2's control.
async function addDevice(name: string): Promise<{ capture: Channel; mirror: Channel }> {
  const channel = (client: string): Channel => ({
    id: `cli_01JGATE${randomBytes(10).toString("hex").toUpperCase().slice(0, 19)}`,
    name: client,
    token: `pit_test-${client}-${randomBytes(8).toString("hex")}`,
  });
  const made = { capture: channel(`${name}-capture`), mirror: channel(name) };
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  await queryAs(db.urls.admin, insert, [
    made.capture.id,
    made.capture.name,
    sha256Hex(made.capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await queryAs(db.urls.admin, insert, [
    made.mirror.id,
    made.mirror.name,
    sha256Hex(made.mirror.token),
    ["own"],
    ["self", "people", "work"],
    PersonalReadTool.options,
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await queryAs(
    db.urls.admin,
    "insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ($1, $2, $3)",
    [name, made.capture.id, made.mirror.id],
  );
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    const id = `acc_01JGATE${randomBytes(10).toString("hex").toUpperCase().slice(0, 19)}`;
    await queryAs(
      db.urls.admin,
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, $3, $4, '{own}')",
      [id, `device:${name}`, connector, kind],
    );
  }
  return made;
}

// `pi http` in-process, on a port of its own, until stop(): the SIGTERM listener it added is
// called, and no signal is sent.
type Http = { base: string; stop(): Promise<number> };
async function startHttp(extra: Record<string, string> = {}): Promise<Http> {
  const port = await freePort();
  const signals = { term: new Set(process.rawListeners("SIGTERM")), int: new Set(process.rawListeners("SIGINT")) };
  let listening: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const lines: string[] = [];
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const text = chunk.toString("utf8");
      lines.push(text);
      if (text.includes('"http_listening"')) listening();
      done();
    },
  });
  const stdout = new Writable({ write: (_chunk, _encoding, done) => done() });
  const env = { PI_DATABASE_URL_READER: db.urls.reader, PI_KEY_FILE: db.keyFile, PI_HTTP_PORT: String(port), ...extra };
  const exit = run(["http"], env, { stdout, stderr, stdin: Readable.from([]), stdoutIsTTY: false });
  await Promise.race([
    ready,
    exit.then((code) => Promise.reject(new Error(`pi http ended with ${code}: ${lines.join("")}`))),
  ]);
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      for (const listener of process.rawListeners("SIGTERM").filter((one) => !signals.term.has(one)))
        (listener as (signal: string) => void)("SIGTERM");
      for (const listener of process.rawListeners("SIGINT").filter((one) => !signals.int.has(one)))
        process.removeListener("SIGINT", listener as () => void);
      return exit;
    },
  };
}

let keys = 0;
const ulid = (): string => `01JGATEPVSH${String((keys += 1)).padStart(15, "0")}`;
const fresh = <T extends CaptureItem>(item: T): T => ({ ...structuredClone(item), key: `${item.kind}:${ulid()}` });
const inScope = (): MomentItem =>
  fresh(lens.moments.find((item) => item.key === lens.handles.inScopeMoment) as MomentItem);
let batches = 0;
const batch = (): string => `gate-batch-${String((batches += 1)).padStart(4, "0")}`;

const post = (path: string, token: string | null, body: string, base = served?.base) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body,
  });
const push = (items: unknown[], token: string | null = capture.token, base = served?.base) =>
  post("/v1/tools/push_capture", token, JSON.stringify({ batch: batch(), items }), base);
const inboxHas = async (item: CaptureItem): Promise<boolean> =>
  (
    await queryAs(db.urls.admin, "select 1 from ledger.capture_inbox where client_id = $1 and source_key_fp = $2", [
      capture.id,
      fingerprint(db.keys, "source_id", item.key),
    ])
  ).length > 0;
const captureCalls = () =>
  queryAs<{ tool: string; outcome: string }>(
    db.urls.admin,
    "select tool, outcome from policy.calls where client_id = $1 order by id",
    [capture.id],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  lens = fakeLens({ now: NOW });
  ({ capture, mirror } = await addDevice("mac"));
  for (const rule of lens.scope) {
    const id = `csr_01JGATE${randomBytes(10).toString("hex").toUpperCase().slice(0, 19)}`;
    const fp = (value: string) => fingerprint(db.keys, "capture_scope", value);
    const sealed = (column: string, value: string) =>
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, value);
    await queryAs(
      db.urls.admin,
      "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        id,
        rule.match,
        fp(rule.value),
        sealed("value_enc", rule.value),
        rule.account === undefined ? null : fp(rule.account),
        rule.account === undefined ? null : sealed("account_enc", rule.account),
        rule.compartment,
        rule.kinds,
      ],
    );
  }
  // No reply deadline is waited for: the clock stands still, and each wait ends once every call
  // the dispatcher made of the reader has settled.
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  const inflight = new Set<Promise<unknown>>();
  const tracked = new Proxy(reader, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        if (result instanceof Promise) {
          inflight.add(result);
          result.then(
            () => inflight.delete(result),
            () => inflight.delete(result),
          );
        }
        return result;
      };
    },
  });
  const settle = async (): Promise<void> => {
    do {
      await Promise.allSettled([...inflight]);
      await new Promise((resolve) => setImmediate(resolve));
    } while (inflight.size > 0);
  };
  const server = serveHttp({ provider: tracked, work: createWork({ reader, log: quiet }) }, quiet, {
    clock: () => 0,
    sleep: settle,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  served = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await reader.close();
    },
  };
}, TIMEOUT);

afterAll(async () => {
  await served?.close();
  await db?.drop();
}, TIMEOUT);

describe("pi http, the push route, against the store", { timeout: TIMEOUT }, () => {
  it("L2: with the capture token, every read tool and sync_mirror is refused, and the mirror client's token reads them, as the control", async () => {
    for (const tool of PersonalReadTool.options) {
      const refused = await post(`/v1/tools/${tool}`, capture.token, "{}");
      expect([refused.status, await refused.text()], tool).toEqual([403, REFUSED_BODY]);
      const read = await post(`/v1/tools/${tool}`, mirror.token, "{}");
      expect(read.status, tool).not.toBe(403);
    }
    // Over MCP too, and the capture client is offered push_capture alone.
    const listed = await fetch(`${served?.base}/v1/tools`, { headers: { authorization: `Bearer ${capture.token}` } });
    expect(((await listed.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual([
      "push_capture",
    ]);
    const over = await post(
      "/mcp",
      capture.token,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_self", arguments: {} } }),
    );
    expect(await over.json()).toEqual({
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
  });

  it("L1: a push carrying a compartment is 400 invalid_request and writes only its call row; without it, it is accepted", async () => {
    const item = inScope();
    const before = (await captureCalls()).length;
    const forged = await push([{ ...item, compartments: ["employer:example"] }]);
    // The refusal names the field the item may not carry, and nothing of its value.
    expect([forged.status, await forged.text()]).toEqual([
      400,
      '{"error":"invalid_request","arguments":[{"name":"items.0.compartments","rule":"no such field"}]}',
    ]);
    expect(await inboxHas(item)).toBe(false);
    const after = await captureCalls();
    expect(after.slice(before)).toEqual([{ tool: "push_capture", outcome: "invalid_request" }]);
    const plain = await push([item]);
    expect([plain.status, await plain.json()]).toEqual([200, { items: [{ key: item.key, outcome: "accepted" }] }]);
    expect(await inboxHas(item)).toBe(true);
  });

  it("L26: the push route reads a batch over 64 KiB from the capture client, a request with no token is 403, and /mcp keeps 64 KiB", async () => {
    const items = Array.from({ length: 30 }, () => ({ ...inScope(), text: "x".repeat(4000) }));
    const body = JSON.stringify({ batch: batch(), items });
    expect(body.length).toBeGreaterThan(64 * 1024);
    // With no token, a push is refused as any call is (the unit tests hold the large body's case).
    const none = await push(items.slice(0, 1), null);
    expect([none.status, await none.text()]).toEqual([403, REFUSED_BODY]);
    expect(await inboxHas(items[0] as MomentItem)).toBe(false);
    const overMcp = await post(
      "/mcp",
      capture.token,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "push_capture", arguments: JSON.parse(body) as unknown },
      }),
    );
    expect(overMcp.status).toBe(413);
    expect(await inboxHas(items[0] as MomentItem)).toBe(false);
    const large = await post("/v1/tools/push_capture", capture.token, body);
    expect(large.status).toBe(200);
    expect(((await large.json()) as PushCaptureAck).items).toEqual(
      items.map((item) => ({ key: item.key, outcome: "accepted" })),
    );
    for (const item of items) expect(await inboxHas(item)).toBe(true);
  });

  it("L18: pi http reads PI_CAPTURE_STORAGE_CEILING_BYTES, and at the ceiling every capture item is refused ceiling and every forget is accepted", async () => {
    // The control: under the default ceiling, the moment is accepted.
    const before = inScope();
    expect(await (await push([before])).json()).toEqual({ items: [{ key: before.key, outcome: "accepted" }] });
    const http = await startHttp({ PI_CAPTURE_STORAGE_CEILING_BYTES: "1" });
    try {
      const item = inScope();
      const notice = { kind: "forget", key: `forget:${ulid()}`, keys: [before.key] };
      const answer = await push([item, notice], capture.token, http.base);
      expect([answer.status, await answer.json()]).toEqual([
        200,
        {
          items: [
            { key: item.key, outcome: "refused", code: "ceiling" },
            { key: notice.key, outcome: "accepted" },
          ],
        },
      ]);
      expect(await inboxHas(notice as CaptureItem)).toBe(true);
    } finally {
      expect(await http.stop()).toBe(0);
    }
  });
});
