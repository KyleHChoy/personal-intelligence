import type { AddressInfo } from "node:net";
import { compactResult, PersonalToolArgs, REFUSAL_CODE_HINTS, SelfView } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_ROUTE } from "./capture-route.ts";
import { handle } from "./handle.ts";
import type { HttpRequest } from "./http.ts";
import { addressKey, createRoutes, MAX_FAILURES, makeRoutes, serveHttp } from "./http.ts";
import { MAX_BODY } from "./http-answers.ts";
import { AT_ONCE, clientView, fakeLog, fakeProvider, NO_WORK, TOKEN } from "./test-support/fakes.ts";

// The agent API over HTTP. Every route but /healthz is one message to `handle`.

const SELF = SelfView.parse({
  addresses: [{ untrusted: "owner@example.com" }],
  timeZone: "Etc/UTC",
  upcoming: [],
  contacts: [],
  changes: [],
});
// get_self's value as it is sent, in its wire form.
const SENT = compactResult("get_self", SELF);
const HOLDER = clientView({ tools: ["get_self", "search"], views: ["self", "people"] });
const AUTH = `Bearer ${TOKEN}`;

function setup(over: { held?: () => boolean; schemaCurrent?: () => boolean; now?: () => number } = {}) {
  const { provider, calls } = fakeProvider(HOLDER, {
    client: async (token) => (token === TOKEN ? HOLDER : null),
    getSelf: async () => ({ ok: true, value: SELF }),
  });
  const { log, events } = fakeLog();
  const routes = createRoutes({ provider, work: NO_WORK }, log, { ...AT_ONCE, ...over });
  const send = (request: Partial<HttpRequest> & { path: string }) =>
    routes({ method: "GET", address: "203.0.113.1", body: "", ...request });
  return { provider, calls, events, send };
}
const body = (answer: { body: string }) => JSON.parse(answer.body) as unknown;

describe("pi http, routes", () => {
  it("/healthz answers ok with no token and reads nothing", async () => {
    const { send, calls } = setup();
    expect(await send({ path: "/healthz" })).toEqual({ status: 200, body: "ok", type: "text/plain" });
    expect(calls).toEqual([]);
  });

  // The host's health check: a deploy whose database is behind this image's migrations, or whose
  // migration state is not known, is never reported healthy, and nothing is read to say so.
  it("/healthz answers 503 schema_behind while the migrations are behind, and ok once they are not", async () => {
    let current = false;
    const { send, calls } = setup({ schemaCurrent: () => current });
    expect(await send({ path: "/healthz" })).toMatchObject({ status: 503 });
    expect(body(await send({ path: "/healthz" }))).toEqual({ error: "schema_behind" });
    current = true;
    expect(await send({ path: "/healthz" })).toEqual({ status: 200, body: "ok", type: "text/plain" });
    expect(calls).toEqual([]);
  });

  it("an unknown path is 404 and a wrong method 405, before any read", async () => {
    const { send, calls } = setup();
    expect((await send({ path: "/admin", authorization: AUTH })).status).toBe(404);
    expect((await send({ path: "/mcp", authorization: AUTH })).status).toBe(405);
    expect((await send({ method: "GET", path: "/v1/tools/get_self", authorization: AUTH })).status).toBe(405);
    expect((await send({ method: "OPTIONS", path: "/v1/tools", authorization: AUTH })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("POST /mcp answers exactly what the stdio dispatcher answers, for every method", async () => {
    const { send, provider } = setup();
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_self", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ];
    for (const message of messages) {
      const text = JSON.stringify(message);
      const answer = await send({ method: "POST", path: "/mcp", authorization: AUTH, body: text });
      expect(answer.status).toBe(200);
      expect(body(answer)).toEqual(await handle({ provider, work: NO_WORK }, fakeLog().log, TOKEN, text, AT_ONCE));
    }
    // A notification has no reply: 202 and no body.
    expect(
      await send({
        method: "POST",
        path: "/mcp",
        authorization: AUTH,
        body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      }),
    ).toEqual({ status: 202, body: "", type: "application/json" });
  });

  it("REST: a tool call returns the tool's value, and the list the client's tools", async () => {
    const { send } = setup();
    const called = await send({ method: "POST", path: "/v1/tools/get_self", authorization: AUTH, body: "{}" });
    expect([called.status, body(called)]).toEqual([200, SENT]);
    expect(body(await send({ method: "POST", path: "/v1/tools/get_self", authorization: AUTH }))).toEqual(SENT);
    const listed = body(await send({ path: "/v1/tools", authorization: AUTH })) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toEqual(["get_self", "search"]);
  });

  it("no token, a bad token, a tool not granted and a name that is no tool answer the same", async () => {
    const { send } = setup();
    const answers = [
      await send({ method: "POST", path: "/v1/tools/get_self", body: "{}" }),
      await send({ method: "POST", path: "/v1/tools/get_self", authorization: "Bearer wrong", body: "{}" }),
      await send({ method: "POST", path: "/v1/tools/read_message", authorization: AUTH, body: '{"id":"x"}' }),
      await send({ method: "POST", path: "/v1/tools/no_such_tool", authorization: AUTH, body: "{}" }),
      await send({ path: "/v1/tools", authorization: "Basic abc" }),
      await send({ path: "/openapi.json" }),
    ];
    for (const answer of answers)
      expect(answer).toEqual({
        status: 403,
        body: JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted }),
        type: "application/json",
      });
  });

  it("REST maps a tool's own refusals, and a body that is not JSON is invalid_request with no read", async () => {
    const { send, calls } = setup();
    // The refused arguments and the rule each broke, from the schema alone.
    expect(
      await send({ method: "POST", path: "/v1/tools/search", authorization: AUTH, body: '{"nope":1}' }),
    ).toMatchObject({
      status: 400,
      body: JSON.stringify({
        error: "invalid_request",
        arguments: [
          { name: "query", rule: "required: a string" },
          { name: "nope", rule: "search has no such argument; it takes query, limit, mode" },
        ],
        hint: REFUSAL_CODE_HINTS.invalid_request,
      }),
    });
    calls.length = 0;
    expect(await send({ method: "POST", path: "/v1/tools/get_self", authorization: AUTH, body: "{" })).toMatchObject({
      status: 400,
      body: '{"error":"invalid_request"}',
    });
    expect(calls).toEqual([]);
  });

  it("GET /openapi.json describes the client's tools from their schemas", async () => {
    const { send } = setup();
    const spec = body(await send({ path: "/openapi.json", authorization: AUTH })) as {
      openapi: string;
      paths: Record<
        string,
        { post: { operationId: string; requestBody: { content: { "application/json": { schema: unknown } } } } }
      >;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(["/v1/tools/get_self", "/v1/tools/search"]);
    expect(spec.paths["/v1/tools/search"]?.post.operationId).toBe("search");
    expect(spec.paths["/v1/tools/search"]?.post.requestBody.content["application/json"].schema).toEqual(
      PersonalToolArgs.search.toJSONSchema({ io: "input", reused: "ref" }),
    );
  });

  it("while the read hold is set, everything but /healthz is unavailable, with no read", async () => {
    const { send, calls } = setup({ held: () => true });
    expect((await send({ method: "POST", path: "/v1/tools/get_self", authorization: AUTH, body: "{}" })).status).toBe(
      503,
    );
    expect((await send({ path: "/healthz" })).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("an address past its failed token checks is refused for the window, and others are not", async () => {
    let now = 0;
    const { send, calls } = setup({ now: () => now });
    for (let n = 0; n < MAX_FAILURES; n += 1)
      expect((await send({ path: "/v1/tools", authorization: "Bearer wrong" })).status).toBe(403);
    calls.length = 0;
    // Throttled now, even with the right token, and nothing is read.
    expect(await send({ path: "/v1/tools", authorization: AUTH })).toMatchObject({
      status: 429,
      body: '{"error":"rate_limited"}',
    });
    expect(calls).toEqual([]);
    expect((await send({ path: "/v1/tools", authorization: AUTH, address: "203.0.113.2" })).status).toBe(200);
    now = 60_000;
    expect((await send({ path: "/v1/tools", authorization: AUTH })).status).toBe(200);
  });

  it("a table full of other addresses frees no address past its failed checks", async () => {
    let now = 0;
    const { send } = setup({ now: () => now });
    const fail = (address?: string) =>
      send({ path: "/v1/tools", authorization: "Bearer wrong", ...(address === undefined ? {} : { address }) });
    const flood = async (from: number) => {
      for (let n = from; n < from + 10_000; n += 1) await fail(`10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
    };
    // Lapsed ones fill the table; they go first.
    await flood(0);
    now = 60_000;
    for (let n = 0; n < MAX_FAILURES; n += 1) expect((await fail()).status).toBe(403);
    expect((await send({ path: "/v1/tools", authorization: AUTH })).status).toBe(429);
    // Live ones fill it; each with fewer failed checks goes before the address past its limit.
    await flood(10_000);
    await flood(20_000);
    expect((await send({ path: "/v1/tools", authorization: AUTH })).status).toBe(429);
  });

  it("a table full of other addresses in flight frees no address's requests in flight", () => {
    const { provider } = fakeProvider(HOLDER, {});
    const { admission } = makeRoutes({ provider, work: NO_WORK }, fakeLog().log, AT_ONCE);
    for (let n = 0; n <= MAX_FAILURES; n += 1) admission.enter("203.0.113.9");
    expect(admission.throttled("203.0.113.9")).toBe(true);
    for (let n = 0; n < 10_000; n += 1) admission.enter(`10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
    expect(admission.throttled("203.0.113.9")).toBe(true);
  });

  it("a burst of bad tokens sent at once is held to the limit too", async () => {
    const { send } = setup();
    const answers = await Promise.all(
      Array.from({ length: MAX_FAILURES + 5 }, () => send({ path: "/v1/tools", authorization: "Bearer wrong" })),
    );
    expect(answers.filter((answer) => answer.status === 429)).toHaveLength(5);
    expect((await send({ path: "/v1/tools", authorization: AUTH })).status).toBe(429);
  });

  it("a tool name that does not decode is refused as any name that is no tool", async () => {
    const { send } = setup();
    expect(await send({ method: "POST", path: "/v1/tools/%E0%A4%A", authorization: AUTH, body: "{}" })).toEqual({
      status: 403,
      body: JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted }),
      type: "application/json",
    });
  });

  it("logs ids, counts and codes only, never the token", async () => {
    const { send, events } = setup();
    await send({ method: "POST", path: "/v1/tools/get_self", authorization: AUTH, body: "{}" });
    await send({ path: "/nowhere" });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events.map((event) => event.event)).toEqual(["mcp_call", "http_refused"]);
  });

  it("a tool call that reaches handle logs its tool the same on both paths, and a name that is no tool as unknown", async () => {
    const { send, events } = setup();
    await send({ method: "POST", path: "/v1/tools/search", authorization: AUTH, body: '{"nope":1}' });
    await send({
      method: "POST",
      path: "/mcp",
      authorization: AUTH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { nope: 1 } },
      }),
    });
    await send({ method: "POST", path: "/v1/tools/no_such_tool", authorization: AUTH, body: "{}" });
    await send({
      method: "POST",
      path: "/mcp",
      authorization: AUTH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_such_tool" } }),
    });
    const calls = events.filter((event) => event.event === "mcp_call").map(({ code, tool }) => ({ code, tool }));
    expect(calls).toEqual([
      { code: "invalid_request", tool: "search" },
      { code: "invalid_request", tool: "search" },
      { code: "not_permitted", tool: "unknown" },
      { code: "not_permitted", tool: "unknown" },
    ]);
    expect(JSON.stringify(events)).not.toContain("no_such_tool");
  });
});

describe("pi http, the server", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function listening(over: { trustForwarded?: boolean } = {}) {
    const { provider } = fakeProvider(HOLDER, {
      client: async (token) => (token === TOKEN ? HOLDER : null),
      getSelf: async () => ({ ok: true, value: SELF }),
    });
    const server = serveHttp({ provider, work: NO_WORK }, fakeLog().log, { ...AT_ONCE, ...over });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves a call end to end, with no CORS header", async () => {
    const base = await listening();
    const answer = await fetch(`${base}/v1/tools/get_self`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(SENT);
    expect([...answer.headers.keys()].filter((key) => key.startsWith("access-control"))).toEqual([]);
    expect(await (await fetch(`${base}/healthz?x=1`)).text()).toBe("ok");
  });

  it("a token check that throws is 503: an expected fault logged unavailable, a bug by its class, never its message", async () => {
    const failing = [
      {
        thrown: Object.assign(new Error("db.example.com"), { code: "ECONNREFUSED" }),
        code: "unavailable",
        reason: "econnrefused",
      },
      { thrown: new TypeError("owner@example.com"), code: "bug", reason: "type_error" },
    ];
    for (const { thrown, code, reason } of failing) {
      const { provider } = fakeProvider(HOLDER, { client: () => Promise.reject(thrown) });
      const { log, events } = fakeLog();
      const server = serveHttp({ provider, work: NO_WORK }, log, AT_ONCE);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // A capture push of no declared length is the one request whose client is checked before
      // its body is read.
      const answer = await fetch(`${base}${CAPTURE_ROUTE}`, {
        method: "POST",
        headers: { authorization: AUTH },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      expect(answer.status).toBe(503);
      expect(events).toContainEqual({ event: "http_refused", code, reason, status: "http_503" });
      expect(JSON.stringify(events)).not.toMatch(/example\.com/);
    }
  });

  // X-Forwarded-For is the caller's own words unless a proxy the owner configured adds it, so
  // without that setting a caller cannot step out of its address's limits by naming another.
  it("keys the failed-check limit on the socket's address unless a proxy is trusted", async () => {
    const failAs = (base: string, address: string) =>
      fetch(`${base}/v1/tools`, { headers: { authorization: "Bearer wrong", "x-forwarded-for": address } });
    const untrusted = await listening();
    for (let n = 0; n < MAX_FAILURES; n += 1) expect((await failAs(untrusted, `198.51.100.${n}`)).status).toBe(403);
    expect((await failAs(untrusted, "198.51.100.200")).status).toBe(429);

    const trusted = await listening({ trustForwarded: true });
    for (let n = 0; n < MAX_FAILURES; n += 1) expect((await failAs(trusted, "198.51.100.1")).status).toBe(403);
    expect((await failAs(trusted, "198.51.100.1")).status).toBe(429);
    // The proxy's own entry is the last one: what the caller put before it names no address.
    expect((await failAs(trusted, "198.51.100.1, 198.51.100.2")).status).toBe(403);
  });

  it("keys the failed-check limit on an IPv6 address's /64", async () => {
    const failAs = (base: string, address: string) =>
      fetch(`${base}/v1/tools`, { headers: { authorization: "Bearer wrong", "x-forwarded-for": address } });
    const trusted = await listening({ trustForwarded: true });
    for (let n = 0; n < MAX_FAILURES; n += 1)
      expect((await failAs(trusted, `2001:db8:1:2::${(n + 1).toString(16)}`)).status).toBe(403);
    expect((await failAs(trusted, "2001:db8:1:2:ffff:ffff:ffff:ffff")).status).toBe(429);
    // The next /64 is another address.
    expect((await failAs(trusted, "2001:db8:1:3::1")).status).toBe(403);
  });

  it("refuses a body past the cap with 413, declared or streamed", async () => {
    const base = await listening();
    const answer = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: "x".repeat(MAX_BODY + 1),
    });
    expect(answer.status).toBe(413);
    // No content-length: the body is streamed in chunks.
    const chunks = new ReadableStream({
      start(controller) {
        for (let n = 0; n < 3; n += 1) controller.enqueue(new TextEncoder().encode("x".repeat(MAX_BODY / 2)));
        controller.close();
      },
    });
    const streamed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: AUTH },
      body: chunks,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
  });
});

describe("addressKey", () => {
  it("is an IPv6 address's /64, however it is written", () => {
    for (const written of [
      "2001:db8:1:2::1",
      "2001:0db8:0001:0002:abcd:ef01:2345:6789",
      "2001:DB8:1:2:0:0:0:0",
      "2001:db8:1:2::1%eth0",
      "2001:db8:1:2::192.0.2.1",
    ])
      expect(addressKey(written), written).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
  });

  it("is an IPv4 address itself, written either way, and is its own key", () => {
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("::FFFF:192.0.2.7")).toBe("192.0.2.7");
    for (const key of ["192.0.2.7", "2001:db8:1:2::/64", "unknown"]) expect(addressKey(key)).toBe(key);
  });

  it("leaves what is not an address as it is", () => {
    for (const odd of ["1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3", "g::1", "12345::1"]) expect(addressKey(odd)).toBe(odd);
  });
});
