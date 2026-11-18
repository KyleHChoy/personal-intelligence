import { PersonalReadTool } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { isUnbuiltRead } from "../admin/clients/admin-clients.ts";
import { NAMES_KNOWLEDGE } from "../test-support/order.ts";
import { insideHold, recordingPool } from "../test-support/recording.ts";
import { callLog, leftOn, openStore, type TestStore } from "../test-support/store.ts";
import { MALFORMED_TOKENS, registration, UNKNOWN_TOKEN } from "../test-support/values.ts";
import { Reader } from "./read.ts";

// The refusals the agent API makes before any read, recorded through the reader's `refused`: the
// one policy.calls row each leaves, read back as pi_admin, and the statements sent for it. The
// caller names the tool and no code: the reader decides the code from the client's registration.
// Each refusal has its positive control in the same test.

const UNAUTHORIZED = { ok: false, code: "unauthorized" };
const UNAVAILABLE = { ok: false, code: "unavailable" };
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const INVALID = { ok: false, code: "invalid_request" };
// The read tools the call log takes but build_context_pack, and not the stubs
// (UNBUILT_READ_TOOLS), which the admin registers for no client.
const TOOLS = PersonalReadTool.options.filter((tool) => tool !== "build_context_pack" && !isUnbuiltRead(tool));
// The fixtures' registration holds the four tools the reader serves so far. A client that holds
// every tool of the contract is registered with this.
// find_facts is a tool of the work view.
const EVERY_TOOL = { tools: [...TOOLS], views: ["self", "people", "work"] as ("self" | "people" | "work")[] };
const BOTH = ["own", "employer:example"];
const TIMEOUT = 180_000;
const LOG_CALL = /log_call\s*\(/i;

// A reader on a recording pool over the store's own reader pool, and the statements one call sent.
function recordingReader(store: TestStore, options?: { rejectWhen?: (text: string) => boolean }) {
  const recorded = recordingPool(store.readerPool, options);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: insideHold([...recorded.statements]) };
  };
  return { reader, during };
}

// What a recorded refusal sends: the token, the client, the one log_call, and nothing that
// names `knowledge`. The token is a value, never part of a statement.
function expectOnlyTheLog(statements: string[], token: string, name: string): void {
  expect(statements, name).toHaveLength(5);
  expect(statements[0], name).toMatch(/^\s*begin\b.*\brepeatable\s+read\b/is);
  expect(statements[1], name).toMatch(/set_config\s*\(/i);
  expect(statements[2], name).toMatch(/current_client\s*\(\s*\)/i);
  expect(statements[3], name).toMatch(LOG_CALL);
  expect(statements[4], name).toMatch(/^\s*commit\b/i);
  for (const text of statements) {
    expect(text, name).not.toMatch(NAMES_KNOWLEDGE);
    expect(text, name).not.toContain(token);
  }
}

describe("the reader's refused", { timeout: TIMEOUT }, () => {
  it("a tool outside the registration writes one not_permitted row", async () => {
    const store = await openStore({ writer: false });
    try {
      // A missing tool, and a registered tool whose view is missing.
      const { token: selfTool } = await store.admin.clients.addClient(
        registration("self-tool-only", BOTH, { tools: ["get_self"] }),
      );
      const { token: selfView } = await store.admin.clients.addClient(
        registration("self-view-only", BOTH, { views: ["self"] }),
      );
      const { reader, during } = recordingReader(store);
      const log = () => callLog(store.db.urls.admin);
      expect(await log()).toEqual([]);

      for (const [client, token] of [
        ["self-tool-only", selfTool],
        ["self-view-only", selfView],
      ] as const) {
        for (const tool of ["search", "get_entity", "get_timeline"] as const) {
          const name = `${client} ${tool}`;
          const before = await log();
          const { answer, statements } = await during(() => reader.refused(token, tool));
          expect(answer, name).toEqual(NOT_PERMITTED);
          // Exactly one row, for this client and this tool, with no rows returned.
          expect(await log(), name).toEqual([...before, { client, tool, rows: 0, outcome: "not_permitted" }]);
          expectOnlyTheLog(statements, token, name);
        }
      }

      // The same row the reader writes when it makes the refusal itself.
      const before = await log();
      expect(await reader.search(selfTool, { query: "blake" })).toEqual(NOT_PERMITTED);
      expect(await log()).toEqual([
        ...before,
        before.find((row) => row.client === "self-tool-only" && row.tool === "search"),
      ]);
    } finally {
      await store.close();
    }
  });

  it("bad arguments write one invalid_request row", async () => {
    const store = await openStore({ writer: false });
    try {
      // The client holds every tool and its view, so what is left to refuse is the arguments.
      const { token } = await store.admin.clients.addClient(registration("wide-client", BOTH, EVERY_TOOL));
      const { reader, during } = recordingReader(store);
      const log = () => callLog(store.db.urls.admin);
      expect(await log()).toEqual([]);

      for (const tool of TOOLS) {
        const before = await log();
        const { answer, statements } = await during(() => reader.refused(token, tool));
        expect(answer, tool).toEqual(INVALID);
        expect(await log(), tool).toEqual([
          ...before,
          { client: "wide-client", tool, rows: 0, outcome: "invalid_request" },
        ]);
        expectOnlyTheLog(statements, token, tool);
      }

      // The same row the reader writes when it parses the arguments itself.
      const before = await log();
      expect(await reader.search(token, { query: "blake", limit: 26 })).toEqual(INVALID);
      expect(await log()).toEqual([...before, before.find((row) => row.tool === "search")]);
    } finally {
      await store.close();
    }
  });

  it("refused records not_permitted for a tool the client lacks and invalid_request for one it holds", async () => {
    const store = await openStore({ writer: false });
    try {
      // Three registrations, and what each holds: a tool counts only with its view.
      const clients = [
        {
          name: "search-and-self",
          made: registration("search-and-self", BOTH, { tools: ["get_self", "search"] }),
          holds: ["get_self", "search"],
        },
        {
          name: "people-view-only",
          made: registration("people-view-only", BOTH, { views: ["people"] }),
          holds: ["search", "get_entity", "get_timeline"],
        },
        { name: "wide-client", made: registration("wide-client", BOTH, EVERY_TOOL), holds: [...TOOLS] },
      ];
      const log = () => callLog(store.db.urls.admin);

      for (const { name, made, holds } of clients) {
        const { token } = await store.admin.clients.addClient(made);
        for (const tool of TOOLS) {
          // The same call for every client and tool: only the registration differs.
          const outcome = holds.includes(tool) ? "invalid_request" : "not_permitted";
          const before = await log();
          expect(await store.reader.refused(token, tool), `${name} ${tool}`).toEqual({ ok: false, code: outcome });
          expect(await log(), `${name} ${tool}`).toEqual([...before, { client: name, tool, rows: 0, outcome }]);
        }
      }

      // Both codes were recorded for one tool, and by one client: the caller chose neither.
      const rows = await log();
      expect(new Set(rows.filter((row) => row.tool === "get_entity").map((row) => row.outcome))).toEqual(
        new Set(["not_permitted", "invalid_request"]),
      );
      expect(new Set(rows.filter((row) => row.client === "search-and-self").map((row) => row.outcome))).toEqual(
        new Set(["not_permitted", "invalid_request"]),
      );
      // No other outcome can be recorded through it.
      expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(["not_permitted", "invalid_request"]));
      expect(rows.every((row) => row.rows === 0)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("refused with no current client answers unauthorized and writes nothing", async () => {
    const store = await openStore({ writer: false });
    try {
      const { token: valid } = await store.admin.clients.addClient(registration("wide-client", BOTH, EVERY_TOOL));
      const { token: revoked } = await store.admin.clients.addClient(registration("revoked-client", BOTH));
      expect(await store.admin.clients.revokeClient("revoked-client")).toBe(true);
      const { reader, during } = recordingReader(store);

      // What any tool call with no current client sends: refused takes the same path.
      const path = (await during(() => reader.getSelf(UNKNOWN_TOKEN))).statements;
      expect(path).toHaveLength(4);

      // No token is the empty string; a revoked token and one of no token's shape are no client too.
      for (const bad of ["", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS]) {
        for (const tool of TOOLS) {
          const { answer, statements } = await during(() => reader.refused(bad, tool));
          expect(answer, tool).toEqual(UNAUTHORIZED);
          expect(statements, tool).toEqual(path);
          expect(
            statements.filter((text) => LOG_CALL.test(text) || NAMES_KNOWLEDGE.test(text)),
            tool,
          ).toEqual([]);
        }
      }
      expect(await callLog(store.db.urls.admin)).toEqual([]);

      // The positive control: with a current client the same call is recorded.
      expect(await reader.refused(valid, "search")).toEqual(INVALID);
      expect(await callLog(store.db.urls.admin)).toEqual([
        { client: "wide-client", tool: "search", rows: 0, outcome: "invalid_request" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("refused with a name that is no tool writes no row", async () => {
    // The agent API never sends one: policy.calls takes the six tool names only, and this is
    // what holds it to them if a caller ever did.
    const store = await openStore({ writer: false, readerMax: 1 });
    try {
      const { token } = await store.admin.clients.addClient(registration("wide-client", BOTH, EVERY_TOOL));
      const { reader } = store;
      const { backend } = await leftOn(store.readerPool);

      // A tool beyond the read tools, which the call log does not take until its stage adds it,
      // answers the same: unavailable, with no row and no statement. `record` is served.
      for (const name of [
        "no_such_tool",
        "",
        "getSelf",
        "GET_SELF",
        "claim_opportunity",
        "next_run",
        "draft_message",
      ]) {
        const events = store.log.events.length;
        expect(await reader.refused(token, name as never), name).toEqual(UNAVAILABLE);
        expect(await callLog(store.db.urls.admin), name).toEqual([]);
        expect(store.log.events.slice(events), name).toEqual([{ event: "read_failed", code: "unavailable" }]);
        // The transaction is ended and the token gone from the pool's one connection.
        expect(await leftOn(store.readerPool), name).toEqual({ backend, accounts: 0, token: "", idle: true });
      }

      // The positive control: one of the six is recorded.
      expect(await reader.refused(token, "get_self")).toEqual(INVALID);
      expect(await callLog(store.db.urls.admin)).toEqual([
        { client: "wide-client", tool: "get_self", rows: 0, outcome: "invalid_request" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("refused records the two new tools as it does the four", async () => {
    const store = await openStore({ writer: false });
    try {
      // Registered before the message tools existed, registered for them without their view, and
      // registered for every tool.
      const clients = [
        { name: "four-tools", made: registration("four-tools", BOTH), code: "not_permitted" },
        {
          name: "messages-no-view",
          made: registration("messages-no-view", BOTH, { views: ["self"], tools: ["find_messages", "read_message"] }),
          code: "not_permitted",
        },
        { name: "wide-client", made: registration("wide-client", BOTH, EVERY_TOOL), code: "invalid_request" },
      ];
      const { reader, during } = recordingReader(store);
      const log = () => callLog(store.db.urls.admin);
      const tokens: Record<string, string> = {};

      for (const { name, made, code } of clients) {
        const { token } = await store.admin.clients.addClient(made);
        tokens[name] = token;
        for (const tool of ["find_messages", "read_message"] as const) {
          const label = `${name} ${tool}`;
          const before = await log();
          const { answer, statements } = await during(() => reader.refused(token, tool));
          expect(answer, label).toEqual({ ok: false, code });
          expect(await log(), label).toEqual([...before, { client: name, tool, rows: 0, outcome: code }]);
          expectOnlyTheLog(statements, token, label);
        }
      }
      const recorded = await log();
      const rowOf = (client: string, tool: string) =>
        recorded.find((row) => row.client === client && row.tool === tool);

      // Each row equals the one the reader writes when it makes the refusal itself: a tool or view
      // the client lacks, with no statement naming knowledge, and arguments that do not parse.
      const own: [string, string, () => Promise<unknown>][] = [
        ["four-tools", "find_messages", () => reader.findMessages(tokens["four-tools"] ?? "", {})],
        [
          "four-tools",
          "read_message",
          () => reader.readMessage(tokens["four-tools"] ?? "", { id: `msg_7${"Z".repeat(25)}` } as never),
        ],
        ["messages-no-view", "find_messages", () => reader.findMessages(tokens["messages-no-view"] ?? "", {})],
        [
          "messages-no-view",
          "read_message",
          () => reader.readMessage(tokens["messages-no-view"] ?? "", { id: `msg_7${"Z".repeat(25)}` } as never),
        ],
        ["wide-client", "find_messages", () => reader.findMessages(tokens["wide-client"] ?? "", { limit: 51 })],
        [
          "wide-client",
          "read_message",
          () => reader.readMessage(tokens["wide-client"] ?? "", { id: "not-a-message-id" } as never),
        ],
      ];
      for (const [client, tool, call] of own) {
        const label = `${client} ${tool}, by the reader`;
        const before = await log();
        const { answer, statements } = await during(call);
        const row = rowOf(client, tool);
        expect(answer, label).toEqual({ ok: false, code: row?.outcome });
        expect(await log(), label).toEqual([...before, row]);
        expectOnlyTheLog(statements, tokens[client] ?? "", label);
      }

      const path = (await during(() => reader.getSelf(UNKNOWN_TOKEN))).statements;
      expect(path).toHaveLength(4);
      for (const bad of ["", UNKNOWN_TOKEN, ...MALFORMED_TOKENS]) {
        const calls: [string, () => Promise<unknown>][] = [
          ["find_messages", () => reader.findMessages(bad, {})],
          ["read_message", () => reader.readMessage(bad, { id: `msg_7${"Z".repeat(25)}` } as never)],
          ["refused find_messages", () => reader.refused(bad, "find_messages")],
          ["refused read_message", () => reader.refused(bad, "read_message")],
        ];
        for (const [tool, call] of calls) {
          const { answer, statements } = await during(call);
          expect(answer, tool).toEqual(UNAUTHORIZED);
          expect(statements, tool).toEqual(path);
        }
      }
      expect((await log()).length).toBe(recorded.length + own.length);
    } finally {
      await store.close();
    }
  });

  it("a database error in refused answers unavailable and is logged as read_failed", async () => {
    const store = await openStore({ writer: false, readerMax: 1 });
    try {
      const { token } = await store.admin.clients.addClient(registration("wide-client", BOTH, EVERY_TOOL));
      const { token: narrow } = await store.admin.clients.addClient(
        registration("self-tool-only", BOTH, { tools: ["get_self"] }),
      );
      // The log_call is rejected as a database error is, with an SQLSTATE and a message.
      const { reader: unlogged, during } = recordingReader(store, { rejectWhen: (text) => LOG_CALL.test(text) });
      const { backend } = await leftOn(store.readerPool);

      for (const tool of TOOLS) {
        // Whichever code the row would have carried: invalid_request for the first, and
        // not_permitted for the second on every tool but get_self.
        for (const [client, caller] of [
          ["wide-client", token],
          ["self-tool-only", narrow],
        ] as const) {
          const name = `${client} ${tool}`;
          const events = store.log.events.length;
          const { answer, statements } = await during(() => unlogged.refused(caller, tool));
          // Never a throw, an SQLSTATE or the driver's message.
          expect(answer, name).toEqual(UNAVAILABLE);
          expect(
            statements.filter((text) => LOG_CALL.test(text)),
            name,
          ).toHaveLength(1);
          expect(await callLog(store.db.urls.admin), name).toEqual([]);
          expect(store.log.events.slice(events), name).toEqual([{ event: "read_failed", code: "unavailable" }]);
          expect(await leftOn(store.readerPool), name).toEqual({ backend, accounts: 0, token: "", idle: true });
        }
      }
      expect(JSON.stringify(store.log.events).toLowerCase()).not.toContain("57p01");

      // The positive control: what writes no row is not failed by it, and the same call on a
      // reader that can log is recorded.
      expect(await unlogged.refused(UNKNOWN_TOKEN, "search")).toEqual(UNAUTHORIZED);
      expect(await store.reader.refused(token, "search")).toEqual(INVALID);
      expect(await callLog(store.db.urls.admin)).toEqual([
        { client: "wide-client", tool: "search", rows: 0, outcome: "invalid_request" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("refused records find_facts as it records the others, once its migration has added the name", async () => {
    const store = await openStore({ writer: false });
    try {
      const { token } = await store.admin.clients.addClient(registration("wide-client", BOTH, EVERY_TOOL));
      expect(await store.reader.refused(token, "find_facts")).toEqual(INVALID);
      expect(await callLog(store.db.urls.admin)).toEqual([
        { client: "wide-client", tool: "find_facts", rows: 0, outcome: "invalid_request" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("refused records find_facts as it does the six", async () => {
    const store = await openStore({ writer: false });
    try {
      // Registered without the tool, with the tool and without its view (work), and for every tool.
      const clients = [
        {
          name: "four-tools",
          made: registration("four-tools", BOTH, { views: ["self", "people", "work"] }),
          code: "not_permitted",
        },
        {
          name: "facts-no-view",
          made: registration("facts-no-view", BOTH, { views: ["self", "people"], tools: ["find_facts"] }),
          code: "not_permitted",
        },
        { name: "wide-client", made: registration("wide-client", BOTH, EVERY_TOOL), code: "invalid_request" },
      ];
      const { reader, during } = recordingReader(store);
      const log = () => callLog(store.db.urls.admin);

      for (const { name, made, code } of clients) {
        const { token } = await store.admin.clients.addClient(made);
        const before = await log();
        const { answer, statements } = await during(() => reader.refused(token, "find_facts"));
        expect(answer, name).toEqual({ ok: false, code });
        const row = { client: name, tool: "find_facts", rows: 0, outcome: code };
        expect(await log(), name).toEqual([...before, row]);
        expectOnlyTheLog(statements, token, name);

        // The same row, and the same statements, as when the reader makes the refusal itself:
        // the tool or view the client lacks, or arguments that do not parse.
        const own = await during(() =>
          reader.findFacts(token, code === "not_permitted" ? {} : ({ limit: 51 } as never)),
        );
        expect(own.answer, `${name}, by the reader`).toEqual({ ok: false, code });
        expect(await log(), `${name}, by the reader`).toEqual([...before, row, row]);
        expectOnlyTheLog(own.statements, token, `${name}, by the reader`);
      }

      const path = (await during(() => reader.getSelf(UNKNOWN_TOKEN))).statements;
      for (const bad of ["", UNKNOWN_TOKEN, ...MALFORMED_TOKENS]) {
        for (const call of [() => reader.findFacts(bad, {}), () => reader.refused(bad, "find_facts")]) {
          const { answer, statements } = await during(call);
          expect(answer).toEqual(UNAUTHORIZED);
          expect(statements).toEqual(path);
        }
      }
      expect(await log()).toHaveLength(clients.length * 2);
    } finally {
      await store.close();
    }
  });
});
