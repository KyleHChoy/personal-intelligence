import { type AddressInfo, connect } from "node:net";
import {
  type MomentItem,
  PersonalTool,
  type PushCaptureAck,
  PushCaptureArgs,
  REFUSAL_CODE_HINTS,
  type ReadOutcome,
} from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_ROUTE, MAX_CAPTURE_BODY, MAX_LARGE_BODIES } from "./capture-route.ts";
import { handle } from "./handle.ts";
import { createRoutes, serveHttp } from "./http.ts";
import { MAX_BODY } from "./http-answers.ts";
import type { Provider } from "./test-support/fakes.ts";
import {
  AT_ONCE,
  call,
  clientView,
  fakeLog,
  fakeProvider,
  NO_WORK,
  request,
  TOKEN,
  toolError,
  toolResult,
} from "./test-support/fakes.ts";

// push_capture at the agent API and the push route of `pi http`. Hand-written items on reserved
// domains.

const DEVICE = "device-token-5b1c37";
const MIXED = "mixed-token-90e2d4";
const DEVICE_VIEW = clientView({ name: "mac-capture", tools: ["push_capture"], views: ["self"] });
const AGENT_VIEW = clientView({ tools: ["get_self", "search"], views: ["self", "people"] });
// Holds push_capture beside another tool: not exactly push_capture, so not a device.
const MIXED_VIEW = clientView({ name: "mixed-client", tools: ["push_capture", "get_self"], views: ["self"] });

const key = (n: number): string => `moment:01JMCPTEST${String(n).padStart(16, "0")}`;
const moment = (n: number, text = "The alpha plan, second draft."): MomentItem => ({
  kind: "moment",
  key: key(n),
  revision: 0,
  observedAt: "2026-10-07T07:00:00-05:00",
  endedAt: "2026-10-07T07:05:00-05:00",
  app: { bundle: "test.example.reader", name: "Reader" },
  url: "https://wiki.example.org/teams/alpha",
  entity: "doc",
  participants: [],
  text,
  read: "ax",
});
const ARGS: PushCaptureArgs = { batch: "unit-batch-0001", items: [moment(1)] };
// Over 64 KiB and under 1 MiB: 30 moments of 4 000 code points each.
const LARGE = JSON.stringify({
  batch: "unit-batch-0002",
  items: Array.from({ length: 30 }, (_, n) => moment(n + 2, "x".repeat(4000))),
});
const ackOf = (args: PushCaptureArgs): PushCaptureAck => ({
  items: args.items.map((item) => ({ key: item.key, outcome: "accepted" as const })),
});

const VIEWS: Record<string, typeof DEVICE_VIEW> = { [DEVICE]: DEVICE_VIEW, [TOKEN]: AGENT_VIEW, [MIXED]: MIXED_VIEW };

// Each token's own view, and a refusal decided by that view, as the store's reader decides it.
function provider(over: Partial<Provider> = {}) {
  return fakeProvider(DEVICE_VIEW, {
    client: async (token) => VIEWS[token] ?? null,
    refused: async (token, tool) => ({
      ok: false,
      code: VIEWS[token]?.tools.includes(tool) === true ? "invalid_request" : "not_permitted",
    }),
    pushCapture: async (_token, args) => ({ ok: true, value: ackOf(args) }),
    ...over,
  });
}

describe("push_capture at the agent API", () => {
  it("The capture client has no read tool, and the agent API offers it none: tools/list offers push_capture alone, with its schema", async () => {
    const { provider: reads } = provider();
    const reply = (await handle(
      { provider: reads, work: NO_WORK },
      fakeLog().log,
      DEVICE,
      request("tools/list"),
      AT_ONCE,
    )) as {
      result: { tools: { name: string; description: string; inputSchema: unknown }[] };
    };
    expect(reply.result.tools.map((tool) => tool.name)).toEqual(["push_capture"]);
    const [tool] = reply.result.tools;
    expect(tool?.inputSchema).toEqual(PushCaptureArgs.toJSONSchema({ io: "input", reused: "ref" }));
    // A fixed description: for Lens's capture process, which is a program.
    expect(tool?.description).toMatch(/Lens/);
    expect(tool?.description).toMatch(/program/i);
  });

  it("push_capture makes one provider call and answers its ack", async () => {
    const { provider: reads, calls } = provider();
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, DEVICE, call("push_capture", ARGS), AT_ONCE),
    ).toEqual(toolResult(1, ackOf(ARGS)));
    expect(calls.map((made) => made.method)).toEqual(["client", "pushCapture"]);
    expect(calls[1]?.args).toEqual([DEVICE, ARGS]);
  });

  it("L1: arguments carrying a compartment, a label or an entity id are invalid_request, and pushCapture is never called", async () => {
    for (const forged of [
      { ...ARGS, compartments: ["employer:example"] },
      { ...ARGS, items: [{ ...moment(3), compartments: ["own"] }] },
      { ...ARGS, items: [{ ...moment(3), label: { compartments: ["own"] } }] },
      { ...ARGS, items: [{ ...moment(3), entityId: `ent_${"0".repeat(26)}` }] },
      { ...ARGS, items: [{ ...moment(3), url: "https://wiki.example.org/teams/alpha?reset=1" }] },
    ]) {
      const { provider: reads, calls } = provider();
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, DEVICE, call("push_capture", forged), AT_ONCE),
      ).toEqual(toolError(1, "invalid_request"));
      expect(calls.map((made) => made.method)).not.toContain("pushCapture");
    }
  });

  it("L1: a device client calling any tool but push_capture is not_permitted, and no port method but the refusal is reached", async () => {
    for (const name of PersonalTool.options.filter((tool) => tool !== "push_capture")) {
      const { provider: reads, calls } = provider();
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, DEVICE, call(name, {}), AT_ONCE),
        name,
      ).toEqual(toolError(1, "not_permitted"));
      for (const made of calls) expect(["client", "refused"], name).toContain(made.method);
    }
    // The control: the tool it holds.
    const { provider: reads } = provider();
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, DEVICE, call("push_capture", ARGS), AT_ONCE),
    ).toEqual(toolResult(1, ackOf(ARGS)));
  });

  it("push_capture's rate_limited from the port is the tool's rate_limited", async () => {
    const { provider: reads } = provider({ pushCapture: async () => ({ ok: false, code: "rate_limited" }) });
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, DEVICE, call("push_capture", ARGS), AT_ONCE),
    ).toEqual(toolError(1, "rate_limited"));
  });
});

describe("the push route: REST answers", () => {
  const routesWith = (outcome: ReadOutcome<PushCaptureAck>, over: { held?: () => boolean } = {}) => {
    const made = provider({ pushCapture: async () => outcome });
    const routes = createRoutes({ provider: made.provider, work: NO_WORK }, fakeLog().log, { ...AT_ONCE, ...over });
    const send = (token: string, body: string) =>
      routes({ method: "POST", path: CAPTURE_ROUTE, authorization: `Bearer ${token}`, address: "203.0.113.7", body });
    return { send, calls: made.calls };
  };

  it("A push answers like any REST tool call: 200 with each item's outcome, and 400, 403, 429 or 503 for the whole batch", async () => {
    const ack: PushCaptureAck = { items: [{ key: key(1), outcome: "refused", code: "out_of_scope" }] };
    const ok = await routesWith({ ok: true, value: ack }).send(DEVICE, JSON.stringify(ARGS));
    expect([ok.status, JSON.parse(ok.body)]).toEqual([200, ack]);
    for (const [code, status] of [
      ["invalid_request", 400],
      ["not_permitted", 403],
      ["rate_limited", 429],
      ["unavailable", 503],
    ] as const) {
      expect(await routesWith({ ok: false, code }).send(DEVICE, JSON.stringify(ARGS)), code).toMatchObject({
        status,
        body: JSON.stringify({
          error: code,
          ...(code === "not_permitted" ? { hint: REFUSAL_CODE_HINTS.not_permitted } : {}),
        }),
      });
    }
    // A body the contract refuses is 400 with no push.
    const { send, calls } = routesWith({ ok: true, value: ack });
    expect((await send(DEVICE, JSON.stringify({ ...ARGS, compartments: ["own"] }))).status).toBe(400);
    expect(calls.map((made) => made.method)).not.toContain("pushCapture");
  });

  it("a token that is not a device's is refused on the push route as on any route, and the read hold answers 503", async () => {
    for (const token of [TOKEN, "no-such-token"]) {
      const { send, calls } = routesWith({ ok: true, value: ackOf(ARGS) });
      expect(await send(token, JSON.stringify(ARGS)), token).toEqual({
        status: 403,
        body: JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted }),
        type: "application/json",
      });
      expect(calls.map((made) => made.method)).not.toContain("pushCapture");
    }
    // The control: the device's token.
    expect((await routesWith({ ok: true, value: ackOf(ARGS) }).send(DEVICE, JSON.stringify(ARGS))).status).toBe(200);
    const { send, calls } = routesWith({ ok: true, value: ackOf(ARGS) }, { held: () => true });
    expect((await send(DEVICE, JSON.stringify(ARGS))).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("GET /v1/tools and /openapi.json show the capture client push_capture alone", async () => {
    const { provider: reads } = provider();
    const routes = createRoutes({ provider: reads, work: NO_WORK }, fakeLog().log, AT_ONCE);
    const get = (path: string) =>
      routes({ method: "GET", path, authorization: `Bearer ${DEVICE}`, address: "203.0.113.7", body: "" });
    expect(
      (JSON.parse((await get("/v1/tools")).body) as { tools: { name: string }[] }).tools.map((tool) => tool.name),
    ).toEqual(["push_capture"]);
    expect(
      Object.keys((JSON.parse((await get("/openapi.json")).body) as { paths: Record<string, unknown> }).paths),
    ).toEqual([CAPTURE_ROUTE]);
  });
});

// A request written on a socket of its own, so a test controls how much of the body is sent and
// sees the status line as soon as the server writes it.
type Open = { status: Promise<number>; send(text: string): void; close(): void };
function open(port: number, path: string, headers: Record<string, string>, first: string): Open {
  const socket = connect(port, "127.0.0.1");
  const head = [
    `POST ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  socket.write(head + first);
  let seen = "";
  const status = new Promise<number>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      const line = /^HTTP\/1\.1 (\d{3})/.exec(seen);
      if (line?.[1] !== undefined) resolve(Number(line[1]));
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("closed with no answer")));
  });
  status.catch(() => {});
  return { status, send: (text) => void socket.write(text), close: () => void socket.destroy() };
}

// The status, which must come while the rest of the body is unsent. The bound is reached only
// when the server waits for the body, which is the failure.
async function answeredUnsent(request: Open): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("no answer while the body was unsent")), 4_000);
  });
  try {
    return await Promise.race([request.status, bound]);
  } finally {
    clearTimeout(timer);
    request.close();
  }
}

// Turns of the event loop, never a sleep, until `check` holds.
async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5_000 && !check(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  if (!check()) throw new Error("never held");
}

describe("the push route: L26, the 1 MiB body", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function listening(over: Partial<Provider> = {}, options: { held?: () => boolean } = {}) {
    const made = provider(over);
    // The addresses below are X-Forwarded-For's, as a trusted proxy would add them.
    const server = serveHttp({ provider: made.provider, work: NO_WORK }, fakeLog().log, {
      ...AT_ONCE,
      trustForwarded: true,
      ...options,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return { port, base: `http://127.0.0.1:${port}`, calls: made.calls };
  }

  it("L26: a request with no token, or a token that is not a device's, is refused before 64 KiB of its body is read", async () => {
    const { port, base, calls } = await listening();
    const declared = (headers: Record<string, string>) =>
      open(
        port,
        CAPTURE_ROUTE,
        { "Content-Type": "application/json", "Content-Length": String(LARGE.length), ...headers },
        LARGE.slice(0, 1024),
      );
    const chunked = (headers: Record<string, string>) =>
      open(
        port,
        CAPTURE_ROUTE,
        { "Content-Type": "application/json", "Transfer-Encoding": "chunked", ...headers },
        `400\r\n${LARGE.slice(0, 1024)}\r\n`,
      );
    for (const [label, request] of [
      ["no token, declared", () => declared({})],
      ["no token, chunked", () => chunked({})],
      ["an unknown token", () => declared({ Authorization: "Bearer no-such-token" })],
      ["an agent's token", () => declared({ Authorization: `Bearer ${TOKEN}` })],
      ["push_capture beside another tool", () => declared({ Authorization: `Bearer ${MIXED}` })],
    ] as const) {
      expect([403, 413], label).toContain(await answeredUnsent(request()));
    }
    expect(calls.map((made) => made.method)).not.toContain("pushCapture");
    // The control: the device's token, the whole body sent, is read and pushed.
    const answer = await fetch(`${base}${CAPTURE_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE}`, "content-type": "application/json" },
      body: LARGE,
    });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as PushCaptureAck).items).toHaveLength(30);
    expect(calls.filter((made) => made.method === "pushCapture")).toHaveLength(1);
  });

  it("L26: a fifth body over 64 KiB at once answers 429, across addresses, and the four are read", async () => {
    const { port, base, calls } = await listening();
    const large = (address: string) =>
      open(
        port,
        CAPTURE_ROUTE,
        {
          Authorization: `Bearer ${DEVICE}`,
          "Content-Type": "application/json",
          "Content-Length": String(LARGE.length),
          "X-Forwarded-For": address,
        },
        LARGE.slice(0, 1024),
      );
    const held = Array.from({ length: MAX_LARGE_BODIES }, (_, n) => large(`198.51.100.${n + 1}`));
    // Each has passed its token check, before its body.
    await until(
      () => calls.filter((made) => made.method === "client" && made.args[0] === DEVICE).length >= MAX_LARGE_BODIES,
    );
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    const fifth = large("198.51.100.99");
    expect(await answeredUnsent(fifth)).toBe(429);
    // The four are read to the end and answered.
    for (const request of held) request.send(LARGE.slice(1024));
    expect(await Promise.all(held.map((request) => request.status))).toEqual(held.map(() => 200));
    for (const request of held) request.close();
    // The control: with the four done, another large body is read.
    const after = await fetch(`${base}${CAPTURE_ROUTE}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEVICE}`,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: LARGE,
    });
    expect(after.status).toBe(200);
  });

  it("L26: a large push whose connection drops while its token is checked, or while its body is read, frees its slot", async () => {
    // client() answers the eight dropped requests after 150 ms, so each socket can close while
    // its check is in hand; then at once, as handle's deadlines under AT_ONCE need.
    const checks: Promise<unknown>[] = [];
    const slow = async (token: string) => {
      if (checks.length >= 2 * MAX_LARGE_BODIES) return VIEWS[token] ?? null;
      const check = new Promise((resolve) => setTimeout(resolve, 150)).then(() => VIEWS[token] ?? null);
      checks.push(check);
      return check;
    };
    const { port, base } = await listening({ client: slow });
    const large = (address: string) =>
      open(
        port,
        CAPTURE_ROUTE,
        {
          Authorization: `Bearer ${DEVICE}`,
          "Content-Type": "application/json",
          "Content-Length": String(LARGE.length),
          "X-Forwarded-For": address,
        },
        LARGE.slice(0, 1024),
      );
    const dropped = Array.from({ length: MAX_LARGE_BODIES }, (_, n) => large(`198.51.100.${n + 1}`));
    await until(() => checks.length >= MAX_LARGE_BODIES);
    for (const request of dropped) request.close();
    await Promise.all(checks);
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    // And four whose sockets close after the check, while the body is read.
    const reading = Array.from({ length: MAX_LARGE_BODIES }, (_, n) => large(`198.51.100.${n + 11}`));
    await until(() => checks.length >= 2 * MAX_LARGE_BODIES);
    await Promise.all(checks);
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    for (const request of reading) request.close();
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    // A fifth large push is read, not refused 429: no slot was kept.
    const after = await fetch(`${base}${CAPTURE_ROUTE}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEVICE}`,
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
      body: LARGE,
    });
    expect(after.status).toBe(200);
  });

  it("the read hold answers 503 to a large push before its body is read, whatever its size, with no token check", async () => {
    const { port, calls } = await listening({}, { held: () => true });
    const over = (length: number) =>
      answeredUnsent(
        open(
          port,
          CAPTURE_ROUTE,
          { Authorization: `Bearer ${DEVICE}`, "Content-Type": "application/json", "Content-Length": String(length) },
          LARGE.slice(0, 1024),
        ),
      );
    expect(await over(LARGE.length)).toBe(503);
    expect(await over(MAX_CAPTURE_BODY + 1)).toBe(503);
    expect(
      await answeredUnsent(
        open(
          port,
          CAPTURE_ROUTE,
          { Authorization: `Bearer ${DEVICE}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
          `400\r\n${LARGE.slice(0, 1024)}\r\n`,
        ),
      ),
    ).toBe(503);
    expect(calls).toEqual([]);
  });

  it("L26: every other route, /mcp included, keeps 64 KiB, and the push route keeps 1 MiB", async () => {
    const { port, base } = await listening();
    const post = (path: string, body: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${DEVICE}`, "content-type": "application/json" },
        body,
      });
    // Each declares its length and sends the first KiB: the answer comes before the rest.
    const over = (path: string, length: number) =>
      answeredUnsent(
        open(
          port,
          path,
          { Authorization: `Bearer ${DEVICE}`, "Content-Type": "application/json", "Content-Length": String(length) },
          "x".repeat(1024),
        ),
      );
    for (const path of ["/mcp", "/v1/tools/sync_mirror", "/v1/tools/get_self"])
      expect(await over(path, MAX_BODY + 1), path).toBe(413);
    expect(await over(CAPTURE_ROUTE, MAX_CAPTURE_BODY + 1)).toBe(413);
    expect(
      (
        await post(
          "/mcp",
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "push_capture", arguments: JSON.parse(LARGE) as unknown },
          }),
        )
      ).status,
    ).toBe(413);
    // The controls: a push over 64 KiB on its route, and a small one over /mcp.
    expect((await post(CAPTURE_ROUTE, LARGE)).status).toBe(200);
    expect((await post("/mcp", call("push_capture", ARGS))).status).toBe(200);
  });
});
