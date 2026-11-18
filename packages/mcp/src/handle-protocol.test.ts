// The protocol: initialize, lists, a request's shape, tokens and the error table.
import type { PersonalReads } from "@intelligence/contracts/personal";
import {
  agentGuideFor,
  ClientView,
  type PersonalLogEvent,
  PersonalToolError,
  TOOL_NAMES,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { handleAtOnce as handle, NO_WORK } from "./test-support/fakes.ts";
import {
  CLIENT,
  call,
  EVERY_REQUEST,
  fakeLog,
  fakeReads,
  MESSAGE_ID,
  NOT_CALLS,
  PERSON,
  request,
  rpcError,
  SELF,
  SENT,
  sentOf,
  TOKEN,
  TOOL_CALLS,
  toolResult,
} from "./test-support/handle-fixtures.ts";

describe("the protocol", () => {
  it("a notification gets no reply", async () => {
    const notifications = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "get_self" } },
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "no/such/method" },
    ];
    for (const token of [TOKEN, undefined]) {
      const { reads, calls } = fakeReads();
      const { log, events } = fakeLog();
      for (const notification of notifications)
        expect(await handle({ provider: reads, work: NO_WORK }, log, token, JSON.stringify(notification))).toBeNull();
      expect(calls).toEqual([]);
      expect(events).toEqual([]);
    }
    // The control: the same method with an id is answered.
    const { reads } = fakeReads();
    expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, request("ping"))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("a client response gets no reply", async () => {
    const { reads, calls } = fakeReads();
    const { log, events } = fakeLog();
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      ),
    ).toBeNull();
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        JSON.stringify({ jsonrpc: "2.0", id: "a", error: { code: -32000, message: "no" } }),
      ),
    ).toBeNull();
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "no" } }),
      ),
    ).toBeNull();
    // A method that is no string does not make it a request.
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5, result: {} }),
      ),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("an unknown method answers -32601", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    for (const method of ["resources/list", "prompts/list", "tools/run", "", "toString"]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request(method, undefined, "q"))).toEqual(
        rpcError("q", -32601, "method_not_found"),
      );
    }
    expect(calls.every((made) => made.method === "client")).toBe(true);
  });

  it("malformed JSON answers -32700", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    for (const text of ["{", '{"jsonrpc":"2.0","id":1,"method":"ping"', "ping", "{'id':1}"]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, text)).toEqual(
        rpcError(null, -32700, "parse_error"),
      );
    }
    expect(calls).toEqual([]);
  });

  it("a batch answers -32600", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    for (const batch of [[ping], [ping, ping], []]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, JSON.stringify(batch))).toEqual(
        rpcError(null, -32600, "invalid_request"),
      );
    }
    expect(calls).toEqual([]);
  });

  it("a null id answers -32600", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    for (const id of [null, 1.5, {}, [1], true]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("ping", undefined, id))).toEqual(
        rpcError(null, -32600, "invalid_request"),
      );
      expect(
        await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("tools/list", undefined, id)),
      ).toEqual(rpcError(null, -32600, "invalid_request"));
    }
    // An integer JavaScript cannot hold exactly could not be echoed unchanged. Written as text, as a client sends it.
    for (const id of ["9007199254740993", "-9007199254740993", "1e400"]) {
      expect(
        await handle({ provider: reads, work: NO_WORK }, log, TOKEN, `{"jsonrpc":"2.0","id":${id},"method":"ping"}`),
        id,
      ).toEqual(rpcError(null, -32600, "invalid_request"));
    }
    // The control: the largest integer it does hold exactly is echoed.
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        '{"jsonrpc":"2.0","id":9007199254740991,"method":"ping"}',
      ),
    ).toEqual({ jsonrpc: "2.0", id: 9007199254740991, result: {} });
    expect(calls).toEqual([]);
  });

  it("a bad shape answers -32600, with the id when it is a valid one", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    const refused = async (message: unknown, id: unknown): Promise<void> => {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, JSON.stringify(message))).toEqual(
        rpcError(id, -32600, "invalid_request"),
      );
    };
    await refused({ jsonrpc: "1.0", id: 7, method: "ping" }, 7);
    await refused({ id: "a", method: "ping" }, "a");
    await refused({ jsonrpc: "2.0", id: 7 }, 7);
    await refused({ jsonrpc: "2.0", id: 7, method: 5 }, 7);
    await refused({ jsonrpc: "2.0", id: 7, method: "tools/list", params: [] }, 7);
    await refused({ jsonrpc: "2.0", id: 7, method: "tools/list", params: null }, 7);
    await refused({ jsonrpc: "2.0", id: 7, method: "tools/list", params: "x" }, 7);
    await refused({ jsonrpc: "2.0", id: null, method: 5 }, null);
    await refused({ jsonrpc: "2.0", method: "ping", params: [] }, null);
    await refused("ping", null);
    await refused(5, null);
    await refused(null, null);
    expect(calls).toEqual([]);
  });

  it("a string id and an integer id are echoed", async () => {
    const { reads } = fakeReads();
    const { log } = fakeLog();
    for (const id of ["a", "", "1", 7, 0, -3]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("ping", undefined, id))).toEqual({
        jsonrpc: "2.0",
        id,
        result: {},
      });
      expect(
        await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("resources/list", undefined, id)),
      ).toEqual(rpcError(id, -32601, "method_not_found"));
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("get_self", {}, id))).toEqual(
        toolResult("get_self", id, SELF),
      );
    }
  });

  it("any requested protocol version gets 2025-06-18", async () => {
    const { reads } = fakeReads();
    const { log } = fakeLog();
    const answer = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "personal-intelligence", version: "unknown" },
        instructions: agentGuideFor(CLIENT.tools),
      },
    };
    // The server's version is the commit it was deployed at, the same for every client.
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(
      await handle({ provider: reads, work: NO_WORK, commit }, log, TOKEN, request("initialize", {})),
    ).toMatchObject({ result: { serverInfo: { name: "personal-intelligence", version: commit } } });
    for (const params of [
      { protocolVersion: "2025-06-18" },
      { protocolVersion: "2024-11-05" },
      { protocolVersion: "2099-01-01" },
      { protocolVersion: 3 },
      {},
      undefined,
    ]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("initialize", params))).toEqual(
        answer,
      );
    }
  });

  it("ping before initialize answers {}", async () => {
    for (const token of [TOKEN, undefined]) {
      const { reads, calls } = fakeReads({ client: async () => null });
      const { log } = fakeLog();
      expect(await handle({ provider: reads, work: NO_WORK }, log, token, request("ping"))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      });
      expect(await handle({ provider: reads, work: NO_WORK }, log, token, request("ping", {}, "p"))).toEqual({
        jsonrpc: "2.0",
        id: "p",
        result: {},
      });
      expect(calls).toEqual([]);
    }
  });

  it("no token answers unauthorized for everything but ping, before any read", async () => {
    // No token: nothing is asked of the provider at all.
    const none = fakeReads();
    for (const message of EVERY_REQUEST)
      expect(await handle({ provider: none.reads, work: NO_WORK }, fakeLog().log, undefined, message)).toEqual(
        rpcError(1, -32001, "unauthorized"),
      );
    expect(await handle({ provider: none.reads, work: NO_WORK }, fakeLog().log, "", request("tools/list"))).toEqual(
      rpcError(1, -32001, "unauthorized"),
    );
    expect(none.calls).toEqual([]);

    // A token the provider does not recognize: it is asked who the client is, and nothing else.
    const unknown = fakeReads({ client: async () => null });
    for (const message of EVERY_REQUEST)
      expect(await handle({ provider: unknown.reads, work: NO_WORK }, fakeLog().log, TOKEN, message)).toEqual(
        rpcError(1, -32001, "unauthorized"),
      );
    expect(unknown.calls).toEqual(EVERY_REQUEST.map(() => ({ method: "client", args: [TOKEN] })));

    expect(await handle({ provider: none.reads, work: NO_WORK }, fakeLog().log, undefined, request("ping"))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(await handle({ provider: unknown.reads, work: NO_WORK }, fakeLog().log, TOKEN, request("ping"))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });

    // The control: the same requests with a recognized token are not refused, and a read runs.
    const known = fakeReads();
    for (const message of EVERY_REQUEST)
      expect(await handle({ provider: known.reads, work: NO_WORK }, fakeLog().log, TOKEN, message)).not.toEqual(
        rpcError(1, -32001, "unauthorized"),
      );
    expect(known.calls.map((made) => made.method)).toContain("getSelf");
  });

  it("client throwing answers -32603", async () => {
    const { reads, calls } = fakeReads({
      client: async () => {
        throw new Error("connection refused at db.example.com");
      },
    });
    for (const message of EVERY_REQUEST) {
      const reply = await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, message);
      expect(reply).toEqual(rpcError(1, -32603, "unavailable"));
      expect(JSON.stringify(reply)).not.toContain("example.com");
    }
    expect(calls.every((made) => made.method === "client")).toBe(true);
  });

  it("a client view that is not as typed answers -32603, and nothing is read", async () => {
    // What the provider must never hand over: nothing, a view with no tools, and tools as text.
    const views: unknown[] = [undefined, { name: "test-client" }, { ...CLIENT, tools: "get_self,search" }];
    for (const view of views) {
      const { reads, calls } = fakeReads({ client: async () => view as ClientView });
      const { log, events } = fakeLog();
      for (const message of EVERY_REQUEST)
        expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, message), JSON.stringify(view)).toEqual(
          rpcError(1, -32603, "unavailable"),
        );
      expect(calls).toEqual(EVERY_REQUEST.map(() => ({ method: "client", args: [TOKEN] })));
      // The client is not known, so the event names none.
      expect(events).toEqual(
        [...NOT_CALLS.map(() => ({})), ...TOOL_CALLS.map((tool) => ({ tool: tool.name }))].map((tool) => ({
          event: "mcp_call",
          code: "unavailable",
          durationMs: expect.any(Number),
          ...tool,
        })),
      );
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("ping"))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      });
    }
    // The control: the same requests under a view as typed are answered, and a read runs.
    const known = fakeReads();
    for (const message of EVERY_REQUEST)
      expect(await handle({ provider: known.reads, work: NO_WORK }, fakeLog().log, TOKEN, message)).not.toEqual(
        rpcError(1, -32603, "unavailable"),
      );
    expect(known.calls.map((made) => made.method)).toContain("getSelf");
  });

  it("client is asked once per message", async () => {
    for (const message of EVERY_REQUEST) {
      const { reads, calls } = fakeReads();
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, message);
      expect(calls.filter((made) => made.method === "client")).toEqual([{ method: "client", args: [TOKEN] }]);
    }
  });

  it("each ReadOutcome code maps to the error table", async () => {
    for (const tool of TOOL_CALLS) {
      for (const code of PersonalToolError.options) {
        const { reads } = fakeReads({ [tool.method]: async () => ({ ok: false, code }) });
        expect(
          await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
        ).toEqual(SENT[code]);
      }
      // An ok value is sent as text and as structured content.
      const { reads, calls } = fakeReads();
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
      ).toEqual(sentOf(tool.name, tool.value));
      expect(calls.map((made) => made.method)).toEqual(["client", tool.method]);
    }
  });

  it("a reads method that throws answers -32603 with no detail", async () => {
    for (const tool of TOOL_CALLS) {
      const { reads } = fakeReads({
        [tool.method]: async () => {
          throw new Error("relation interactions is missing, at ada@example.com");
        },
      });
      const reply = await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args));
      expect(reply).toEqual(rpcError(1, -32603, "unavailable"));
      expect(JSON.stringify(reply)).not.toContain("example.com");
      expect(JSON.stringify(reply)).not.toContain("relation");
    }
  });

  it("tools/call with no name answers -32602", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    for (const params of [
      undefined,
      {},
      { arguments: {} },
      { name: 5 },
      { name: null },
      { name: ["get_self"] },
      { name: { name: "get_self" } },
    ]) {
      expect(await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("tools/call", params))).toEqual(
        rpcError(1, -32602, "invalid_params"),
      );
    }
    expect(calls.every((made) => made.method === "client")).toBe(true);
  });

  it("missing arguments are {}", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    expect(
      await handle({ provider: reads, work: NO_WORK }, log, TOKEN, request("tools/call", { name: "get_self" })),
    ).toEqual(toolResult("get_self", 1, SELF));
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        log,
        TOKEN,
        request("tools/call", { name: "get_self", arguments: {} }),
      ),
    ).toEqual(toolResult("get_self", 1, SELF));
    expect(calls).toEqual([
      { method: "client", args: [TOKEN] },
      { method: "getSelf", args: [TOKEN, {}] },
      { method: "client", args: [TOKEN] },
      { method: "getSelf", args: [TOKEN, {}] },
    ]);
  });

  it("the arguments reach the read, with the token", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    const timeline = { id: PERSON, from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", limit: 10 };
    await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("search", { query: "ada", limit: 5 }));
    await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("get_entity", { id: PERSON }));
    const found = {
      sender: "billing@example.com",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      category: "updates",
      limit: 50,
    };
    const slice = { id: MESSAGE_ID, offset: 20000, limit: 50000 };
    await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("get_timeline", timeline));
    await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("find_messages", found));
    await handle({ provider: reads, work: NO_WORK }, log, TOKEN, call("read_message", slice));
    expect(calls.filter((made) => made.method !== "client")).toEqual([
      { method: "search", args: [TOKEN, { query: "ada", limit: 5 }] },
      { method: "getEntity", args: [TOKEN, { id: PERSON }] },
      { method: "getTimeline", args: [TOKEN, timeline] },
      { method: "findMessages", args: [TOKEN, found] },
      { method: "readMessage", args: [TOKEN, slice] },
    ]);
  });

  it("one mcp_call event per request", async () => {
    const event = (code: string, known = true, tool?: string, why: object = {}) => ({
      event: "mcp_call",
      ...(known ? { ids: { client: "test-client" } } : {}),
      code,
      durationMs: expect.any(Number),
      ...(tool === undefined ? {} : { tool }),
      ...why,
    });
    const cases: { message: string; token?: string; reads?: Partial<PersonalReads>; logged: unknown }[] = [
      { message: request("ping"), logged: event("ok", false) },
      { message: request("initialize"), logged: event("ok") },
      { message: request("tools/list"), logged: event("ok") },
      { message: call("get_self"), logged: event("ok", true, "get_self") },
      {
        message: call("get_entity", { id: PERSON }),
        reads: { getEntity: async () => ({ ok: false, code: "not_found" }) },
        logged: event("not_found", true, "get_entity"),
      },
      {
        message: call("get_self"),
        reads: { getSelf: async () => ({ ok: false, code: "not_permitted" }) },
        logged: event("not_permitted", true, "get_self"),
      },
      {
        message: call("get_self"),
        reads: { getSelf: async () => ({ ok: false, code: "invalid_request" }) },
        logged: event("invalid_request", true, "get_self", { reason: "store" }),
      },
      {
        message: call("get_self"),
        reads: { getSelf: async () => ({ ok: false, code: "unauthorized" }) },
        logged: event("unauthorized", true, "get_self"),
      },
      {
        message: call("get_self"),
        reads: { getSelf: async () => ({ ok: false, code: "unavailable" }) },
        logged: event("unavailable", true, "get_self"),
      },
      {
        message: call("get_self"),
        // A fault nothing expects is a bug, logged by its class and answered `unavailable`.
        reads: { getSelf: () => Promise.reject(new TypeError("no")) },
        logged: event("bug", true, "get_self", { reason: "type_error" }),
      },
      { message: call("no_such_tool"), logged: event("not_permitted", true, "unknown", { reason: "tool_unknown" }) },
      {
        message: call("search", { query: "ada" }),
        reads: { client: async () => ClientView.parse({ ...CLIENT, tools: ["get_self"] }) },
        logged: event("not_permitted", true, "search", { reason: "not_offered" }),
      },
      {
        message: call("search", { query: "" }),
        logged: event("invalid_request", true, "search", { reason: "schema_too_small", argument: "query" }),
      },
      {
        message: call("search", { query: "" }),
        reads: { refused: async () => ({ ok: false, code: "unauthorized" }) },
        logged: event("unauthorized", true, "search"),
      },
      {
        message: call("search", { query: "" }),
        reads: { refused: async () => ({ ok: false, code: "unavailable" }) },
        logged: event("unavailable", true, "search"),
      },
      {
        message: call("search", { query: "" }),
        // A store's error, by its driver's SQLSTATE.
        reads: {
          refused: () =>
            Promise.reject(Object.assign(new Error("no"), { code: "unavailable", cause: { sqlstate: "40001" } })),
        },
        logged: event("unavailable", true, "search", { reason: "sqlstate_40001" }),
      },
      { message: request("tools/call", {}), logged: event("invalid_params", true, "unknown") },
      {
        message: request("resources/list"),
        logged: event("method_not_found", true, undefined, { reason: "resources_list" }),
      },
      { message: "{", logged: event("parse_error", false) },
      { message: "[]", logged: event("invalid_request", false) },
      { message: request("ping", undefined, null), logged: event("invalid_request", false) },
      { message: request("tools/list"), token: "", logged: event("unauthorized", false) },
      { message: request("tools/list"), reads: { client: async () => null }, logged: event("unauthorized", false) },
      {
        message: request("tools/list"),
        reads: { client: () => Promise.reject(Object.assign(new Error("no"), { code: "ECONNREFUSED" })) },
        logged: event("unavailable", false, undefined, { reason: "econnrefused" }),
      },
    ];
    for (const { message, token, reads: over, logged } of cases) {
      const { reads } = fakeReads(over);
      const { log, events } = fakeLog();
      expect(await handle({ provider: reads, work: NO_WORK }, log, token ?? TOKEN, message)).not.toBeNull();
      expect(events).toEqual([logged]);
      expect(Number.isInteger(events[0]?.durationMs)).toBe(true);
    }
  });

  it("a tools/call names its tool only from the tools served: any other name is logged unknown, never as sent", async () => {
    for (const name of TOOL_NAMES) {
      const { log, events } = fakeLog();
      await handle({ provider: fakeReads().reads, work: NO_WORK }, log, TOKEN, call(name));
      expect(
        events.filter((event) => event.event === "mcp_call").map((event) => event.tool),
        name,
      ).toEqual([name]);
    }
    // A name no tool has, near misses and a value that is no name.
    const sent = [
      "no_such_tool",
      "Get_self",
      "get_self ",
      "alex@example.com",
      'get_self\n{"event":"forged"}',
      "x".repeat(200),
    ];
    for (const name of sent) {
      for (const token of [TOKEN, undefined]) {
        const { log, events } = fakeLog();
        await handle(
          { provider: fakeReads().reads, work: NO_WORK },
          log,
          token,
          call(name, { query: "alex@example.com" }),
        );
        expect(
          events.map((event) => event.tool),
          name,
        ).toEqual(["unknown"]);
        expect(JSON.stringify(events), name).not.toContain(name);
        expect(JSON.stringify(events)).not.toContain("example.com");
      }
    }
    for (const params of [{ name: 5 }, { name: ["get_self"] }, {}]) {
      const { log, events } = fakeLog();
      await handle({ provider: fakeReads().reads, work: NO_WORK }, log, TOKEN, request("tools/call", params));
      expect(events.map((event) => event.tool)).toEqual(["unknown"]);
    }
    // Every other method names no tool.
    for (const method of ["ping", "initialize", "tools/list", "resources/list"]) {
      const { log, events } = fakeLog();
      await handle({ provider: fakeReads().reads, work: NO_WORK }, log, TOKEN, request(method));
      expect(
        events.map((event) => "tool" in event),
        method,
      ).toEqual([false]);
    }
  });

  it("a refusal logs why by fixed codes alone, never a name or a value the call sent", async () => {
    const logged = async (message: string, over?: Partial<PersonalReads>): Promise<PersonalLogEvent[]> => {
      const { log, events } = fakeLog();
      await handle({ provider: fakeReads(over).reads, work: NO_WORK }, log, TOKEN, message);
      return events;
    };
    const why = (events: PersonalLogEvent[]) => events.map(({ reason, argument }) => ({ reason, argument }));
    // A name that is no tool, by how near it is to one.
    for (const [name, reason] of [
      ["Get-Self", "tool_spelling"],
      ["get self ", "tool_spelling"],
      ["personal-intelligence__get_self", "tool_prefixed"],
      ["pi.search", "tool_prefixed"],
      ["submit_fact", "tool_unknown"],
      ["myget_self", "tool_unknown"],
    ] as const) {
      expect(why(await logged(call(name))), name).toEqual([{ reason, argument: undefined }]);
    }
    // An argument the tool does not take is never named; one it takes is.
    const unknown = await logged(call("search", { query: "ada", alex_example_com: 1 }));
    expect(why(unknown)).toEqual([{ reason: "schema_unrecognized_keys", argument: undefined }]);
    expect(JSON.stringify(unknown)).not.toContain("alex_example_com");
    expect(why(await logged(call("search", {})))).toEqual([{ reason: "schema_invalid_type", argument: "query" }]);
    // Null arguments are refused whole, as the reply says, never as a missing argument.
    expect(why(await logged(call("search", null)))).toEqual([{ reason: "schema_invalid_type", argument: undefined }]);
    // A claim refusal logs its own code; a store refusal with none logs store.
    expect(
      why(
        await logged(call("about", { subject: { id: PERSON } }), {
          about: async () => ({ ok: false, code: "not_found", refusal: "subject_unknown" }),
        }),
      ),
    ).toEqual([{ reason: "subject_unknown", argument: undefined }]);
    // A method not served, by the methods clients are known to send.
    for (const [method, reason] of [
      ["prompts/list", "prompts_list"],
      ["resources/templates/list", "resource_templates_list"],
      ["alex@example.com", "other_method"],
      ["toString", "other_method"],
    ] as const) {
      const events = await logged(request(method));
      expect(why(events), method).toEqual([{ reason, argument: undefined }]);
      expect(JSON.stringify(events)).not.toContain("example.com");
    }
    expect(why(await logged(call("get_self")))).toEqual([{ reason: undefined, argument: undefined }]);
  });

  it("the token appears in no reply and no log event", async () => {
    const failing = (): Promise<never> => Promise.reject(new Error(`no row for ${TOKEN}`));
    const provider: Partial<PersonalReads>[] = [
      {},
      { client: async () => null },
      { client: failing },
      {
        getSelf: failing,
        search: failing,
        getEntity: failing,
        getTimeline: failing,
        findMessages: failing,
        readMessage: failing,
        findFacts: failing,
        refused: failing,
      },
      ...PersonalToolError.options.map((code) => {
        const refuse = async () => ({ ok: false as const, code });
        return {
          getSelf: refuse,
          search: refuse,
          getEntity: refuse,
          getTimeline: refuse,
          findMessages: refuse,
          readMessage: refuse,
          findFacts: refuse,
          refused: refuse,
        };
      }),
    ];
    const messages = [
      ...EVERY_REQUEST,
      request("ping"),
      request("tools/call", {}),
      request("ping", undefined, null),
      call("no_such_tool"),
      call("search", { query: "ada", extra: true }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      "{",
      "[]",
    ];
    let replies = 0;
    for (const over of provider) {
      const { reads } = fakeReads(over);
      const { log, events } = fakeLog();
      for (const message of messages) {
        const reply = await handle({ provider: reads, work: NO_WORK }, log, TOKEN, message);
        if (reply !== null) replies += 1;
        expect(JSON.stringify(reply)).not.toContain(TOKEN);
      }
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    }
    expect(replies).toBeGreaterThan(0);
  });
});
