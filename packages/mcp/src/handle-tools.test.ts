// The tools: registration, refusals, schemas and descriptions.
import type { PersonalReads } from "@intelligence/contracts/personal";
import {
  ClientView,
  LIFE_DOMAINS,
  PersonalReadTool,
  PersonalToolArgs,
  PersonalToolError,
  SearchResult,
  SelfView,
  TOOL_NAMES,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { handleAtOnce as handle, NO_WORK, toolError } from "./test-support/fakes.ts";
import {
  beyondClient,
  CLIENT,
  call,
  clientWith,
  ENTITY,
  EVERY_REQUEST,
  fakeLog,
  fakeReads,
  listed,
  meeting,
  PERSON,
  READ_METHODS,
  refusedCall,
  request,
  rpcError,
  SEARCH,
  SELF,
  SENT,
  sentOf,
  TIMELINE,
  TOKEN,
  TOOL_CALLS,
  toolResult,
  ulid,
  who,
} from "./test-support/handle-fixtures.ts";

describe("the tools", () => {
  it("a tool outside the registration is not listed and not run", async () => {
    const { reads, calls } = fakeReads(clientWith({ tools: ["get_self", "search"] }));
    expect((await listed(reads)).map((tool) => tool.name)).toEqual(["get_self", "search"]);
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_entity", { id: PERSON })),
    ).toEqual(toolError(1, "not_permitted"));
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_timeline", { id: PERSON })),
    ).toEqual(toolError(1, "not_permitted"));
    // Nothing is read: each refusal is recorded, and that is all.
    expect(beyondClient(calls)).toEqual([refusedCall("get_entity"), refusedCall("get_timeline")]);

    // The control: a tool in the registration is run.
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("search", { query: "ada" })),
    ).toEqual(toolResult("search", 1, SEARCH));
    expect(calls.at(-1)).toEqual({ method: "search", args: [TOKEN, { query: "ada" }] });

    // And a client registered for every read tool is offered each.
    expect((await listed(fakeReads().reads)).map((tool) => tool.name)).toEqual(CLIENT.tools);
  });

  it("no agent API tool decides, vetoes, erases or releases: each name answers not_permitted and calls no port method", async () => {
    const owner = [
      "decide",
      "pi_decide",
      "review",
      "show",
      "veto",
      "veto_add",
      "veto_lift",
      "veto_list",
      "erase",
      "erase_item",
      "erase_person",
      "erase_lift",
      "erase_replay",
      "release",
      "messages_release",
      "extract_retry",
      "raise_card",
    ];
    const { reads, calls } = fakeReads();
    for (const name of owner)
      expect(
        await handle(
          { provider: reads, work: NO_WORK },
          fakeLog().log,
          TOKEN,
          call(name, { cards: ["crd_x"], answer: "acknowledge" }),
        ),
        name,
      ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(calls)).toEqual([]);
    expect((await listed(reads)).map((tool) => tool.name).filter((name) => owner.includes(name))).toEqual([]);
    // The control: a read tool is run.
    expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self"))).toEqual(
      toolResult("get_self", 1, SELF),
    );
  });

  it("no agent API tool rules, lifts, marks, sweeps, removes or lists: each name answers not_permitted and calls no port method", async () => {
    const owner = [
      "identity_link",
      "identity_differ",
      "identity_share",
      "identity_list",
      "identity_lift",
      "identity_sweep",
      "link_people",
      "mark_shared",
      "propose_identity",
      "contacts_remove",
    ];
    const { reads, calls } = fakeReads();
    for (const name of owner)
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, { a: PERSON, b: PERSON })),
        name,
      ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(calls)).toEqual([]);
    expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self"))).toEqual(
      toolResult("get_self", 1, SELF),
    );
  });

  it("a result with details passes the schema, and one with an unwrapped phone number is answered unavailable", async () => {
    const details = [
      {
        disclosure: "use_only" as const,
        names: [{ untrusted: "Maren Holt" }],
        phones: [{ value: { untrusted: "555-0101" }, type: null }],
        organizations: [],
        birthday: { month: 3, day: 4 },
      },
    ];
    const wrapped = { ...ENTITY, details };
    const good = fakeReads({ getEntity: async () => ({ ok: true, value: wrapped }) });
    expect(
      await handle({ provider: good.reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_entity", { id: PERSON })),
    ).toEqual(toolResult("get_entity", 1, wrapped));
    const bare = { ...ENTITY, details: [{ ...details[0], phones: [{ value: "555-0101", type: null }] }] };
    const bad = fakeReads({ getEntity: async () => ({ ok: true, value: bare as never }) });
    expect(
      await handle({ provider: bad.reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_entity", { id: PERSON })),
    ).toEqual(rpcError(1, -32603, "unavailable"));
  });

  it("no tool result holds a ruling, a card or a time of one", async () => {
    const { reads } = fakeReads();
    for (const tool of TOOL_CALLS) {
      const text = JSON.stringify(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
      );
      for (const word of ["rul_", "crd_", "identity_rulings", "same_person", "shared_address"])
        expect(text, `${tool.name} ${word}`).not.toContain(word);
    }
  });

  it("no agent API tool declassifies or revokes", async () => {
    const owner = [
      "declassify",
      "declassify_add",
      "declassify_list",
      "declassify_revoke",
      "pi_declassify",
      "revoke",
      "revoke_declassified",
      "list_declassified",
    ];
    const { reads, calls } = fakeReads();
    for (const name of owner)
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, { id: "0".repeat(64) })),
        name,
      ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(calls)).toEqual([]);
    expect((await listed(reads)).map((tool) => tool.name).filter((name) => owner.includes(name))).toEqual([]);
    // The control: find_facts, the one tool a declassified fact reaches, is run.
    expect(
      (
        (await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("find_facts", {}))) as {
          result?: unknown;
        }
      ).result,
    ).toBeDefined();
  });

  it("no agent API tool corrects, vetoes a fact key or shows a fact: each name answers not_permitted and calls no port method", async () => {
    const owner = [
      "correct",
      "correct_reject",
      "correct_veto",
      "correct_list",
      "correct_lift",
      "reject_claim",
      "veto_fact",
      "fact_veto",
      "lift_ruling",
      "list_rulings",
      "facts_show",
      "fact_show",
      "show_fact",
    ];
    const { reads, calls } = fakeReads();
    for (const name of owner)
      expect(
        await handle(
          { provider: reads, work: NO_WORK },
          fakeLog().log,
          TOKEN,
          call(name, { id: "c".repeat(64), requestId: "request-mcp-r1-0001" }),
        ),
        name,
      ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(calls)).toEqual([]);
    expect((await listed(reads)).map((tool) => tool.name).filter((name) => owner.includes(name))).toEqual([]);
    // The control: a read tool is run.
    expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self"))).toEqual(
      toolResult("get_self", 1, SELF),
    );
  });

  it("a tool whose view the client lacks is not listed", async () => {
    const self = fakeReads(clientWith({ views: ["self"] }));
    // sync_memory's view is self as well (its section's own view is the provider's to apply), and
    // context's (its other parts' views are the provider's to apply), and record_reads' (the
    // notes section's view).
    expect((await listed(self.reads)).map((tool) => tool.name)).toEqual(
      CLIENT.tools.filter((name) => TOOL_VIEW[name as PersonalReadTool] === "self"),
    );
    const beyondSelf = TOOL_CALLS.filter((tool) => TOOL_VIEW[tool.name] !== "self");
    for (const tool of beyondSelf)
      expect(
        await handle({ provider: self.reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
      ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(self.calls)).toEqual(beyondSelf.map((tool) => refusedCall(tool.name)));
    // The control: the tool whose view it holds is run.
    expect(await handle({ provider: self.reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self"))).toEqual(
      toolResult("get_self", 1, SELF),
    );

    const people = fakeReads(clientWith({ views: ["people"] }));
    expect((await listed(people.reads)).map((tool) => tool.name)).toEqual(
      CLIENT.tools.filter((name) => TOOL_VIEW[name as PersonalReadTool] === "people"),
    );
    expect(await handle({ provider: people.reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self"))).toEqual(
      toolError(1, "not_permitted"),
    );
    expect(beyondClient(people.calls)).toEqual([refusedCall("get_self")]);

    const work = fakeReads(clientWith({ views: ["work"] }));
    expect((await listed(work.reads)).map((tool) => tool.name)).toEqual(
      CLIENT.tools.filter((name) => TOOL_VIEW[name as PersonalReadTool] === "work"),
    );
  });

  it("a name that is no tool answers not_permitted", async () => {
    const { reads, calls } = fakeReads();
    for (const name of [
      "no_such_tool",
      "",
      "getSelf",
      "GET_SELF",
      "get_self ",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, {}))).toEqual(
        toolError(1, "not_permitted"),
      );
    }
    expect(calls.every((made) => made.method === "client")).toBe(true);

    // The same bytes as a tool that exists and is not the client's.
    const narrow = fakeReads(clientWith({ tools: ["get_self"] }));
    const real = await handle(
      { provider: narrow.reads, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      call("get_entity", { id: PERSON }),
    );
    const none = await handle(
      { provider: narrow.reads, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      call("no_such_tool", { id: PERSON }),
    );
    expect(JSON.stringify(none)).toBe(JSON.stringify(real));
  });

  it("an extra field answers invalid_request without a read", async () => {
    const { reads, calls } = fakeReads();
    const refused: [string, unknown][] = [
      ["search", { query: "ada", extra: true }],
      ["search", { query: "" }],
      ["search", { query: "a".repeat(201) }],
      ["search", { query: "ada", limit: 26 }],
      ["search", { query: "ada", limit: 0 }],
      ["search", { query: "ada", limit: 1.5 }],
      ["search", { query: 5 }],
      ["search", {}],
      ["search", undefined],
      ["get_entity", { id: PERSON, extra: 1 }],
      ["get_entity", { id: "ent_1" }],
      ["get_entity", { id: `evt_${ulid(1)}` }],
      ["get_entity", {}],
      ["get_timeline", { id: PERSON, direction: "inbound" }],
      ["get_timeline", { id: PERSON, limit: 101 }],
      ["get_timeline", { id: PERSON, from: "2026-01-32" }],
      ["get_timeline", { id: PERSON, to: "2026-02-30T00:00:00Z" }],
      ["get_timeline", "x"],
      ["get_timeline", [PERSON]],
      ["get_timeline", null],
      ["get_timeline", 5],
    ];
    for (const [name, args] of refused)
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, args)),
        JSON.stringify([name, args]),
      ).toEqual(toolError(1, "invalid_request"));
    expect(
      await handle(
        { provider: reads, work: NO_WORK },
        fakeLog().log,
        TOKEN,
        request("tools/call", { name: "search", arguments: null }),
      ),
    ).toEqual(toolError(1, "invalid_request"));
    // No read: each refusal is recorded under its tool, and no argument goes with it.
    expect(beyondClient(calls)).toEqual([...refused.map(([name]) => refusedCall(name)), refusedCall("search")]);
    const recorded = calls.length;

    // The control: the same tools with arguments that fit are run.
    for (const tool of TOOL_CALLS)
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
      ).toEqual(sentOf(tool.name, tool.value));
    expect(beyondClient(calls.slice(recorded)).map((made) => made.method)).toEqual(READ_METHODS);
  });

  it("get_self with an extra field answers invalid_request", async () => {
    const { reads, calls } = fakeReads();
    for (const args of [{ extra: true }, { id: PERSON }, "x", [], null]) {
      expect(
        await handle(
          { provider: reads, work: NO_WORK },
          fakeLog().log,
          TOKEN,
          request("tools/call", { name: "get_self", arguments: args }),
        ),
      ).toEqual(toolError(1, "invalid_request"));
    }
    expect(beyondClient(calls)).toEqual(Array.from({ length: 5 }, () => refusedCall("get_self")));
    // The control: with no field it is run.
    expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_self", {}))).toEqual(
      toolResult("get_self", 1, SELF),
    );
  });

  it("a name that is no tool writes no row", async () => {
    // The provider's call log takes the six tool names only, so nothing is asked of it.
    for (const over of [{}, clientWith({ tools: ["get_self"] }), clientWith({ views: ["work"] })]) {
      const { reads, calls } = fakeReads(over);
      for (const name of [
        "no_such_tool",
        "",
        "getSelf",
        "GET_SELF",
        "get_self ",
        "refused",
        "constructor",
        "__proto__",
        "toString",
      ]) {
        for (const args of [{}, { id: PERSON }, "x"])
          expect(
            await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, args)),
            name,
          ).toEqual(toolError(1, "not_permitted"));
      }
      expect(beyondClient(calls)).toEqual([]);
    }
    // The control: one of the six, not this client's, is recorded.
    const { reads, calls } = fakeReads(clientWith({ tools: ["get_self"] }));
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("search", { query: "ada" })),
    ).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(calls)).toEqual([refusedCall("search")]);
  });

  it("a refused call calls refused and no other reads method", async () => {
    // Every tool, refused each way: once as not this client's, once for its arguments.
    for (const tool of TOOL_CALLS) {
      const others = TOOL_CALLS.filter((other) => other.name !== tool.name).map((other) => other.name);
      const narrow = fakeReads(clientWith({ tools: others }));
      // Not the client's: its arguments are not looked at, good or bad.
      for (const args of [tool.args, { extra: true }, "x"]) {
        expect(
          await handle({ provider: narrow.reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, args)),
          tool.name,
        ).toEqual(toolError(1, "not_permitted"));
      }
      expect(narrow.calls, tool.name).toEqual(
        Array.from({ length: 3 }, () => [{ method: "client", args: [TOKEN] }, refusedCall(tool.name)]).flat(),
      );

      const wide = fakeReads();
      expect(
        await handle({ provider: wide.reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, { extra: true })),
        tool.name,
      ).toEqual(toolError(1, "invalid_request"));
      expect(wide.calls, tool.name).toEqual([{ method: "client", args: [TOKEN] }, refusedCall(tool.name)]);
    }
  });

  it("a refused call is answered with the code the provider gives", async () => {
    // What this package expected each refusal to be. The provider decides, and its answer is sent.
    const refusals = [
      {
        over: clientWith({ tools: ["get_self"] }),
        message: call("search", { query: "ada" }),
        expected: "not_permitted",
      },
      { over: {}, message: call("search", { query: "" }), expected: "invalid_request" },
    ] as const;
    for (const { over, message, expected } of refusals) {
      // The fake decides from the registration, as the reader does.
      expect(await handle({ provider: fakeReads(over).reads, work: NO_WORK }, fakeLog().log, TOKEN, message)).toEqual(
        toolError(1, expected),
      );
      // A provider that reads the registration otherwise is the one believed.
      for (const code of ["not_permitted", "invalid_request"] as const) {
        const { reads, calls } = fakeReads({ ...over, refused: async () => ({ ok: false, code }) });
        expect(await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, message), code).toEqual(
          toolError(1, code),
        );
        expect(calls).toEqual([{ method: "client", args: [TOKEN] }, refusedCall("search")]);
      }
    }
  });

  it("refused that fails is answered as any failed read", async () => {
    const refusals = [
      { over: clientWith({ tools: ["get_self"] }), message: call("search", { query: "ada" }), code: "not_permitted" },
      { over: {}, message: call("search", { query: "" }), code: "invalid_request" },
    ] as const;
    for (const { over, message, code } of refusals) {
      const answering = (refused?: PersonalReads["refused"]) =>
        handle(
          { provider: fakeReads({ ...over, ...(refused === undefined ? {} : { refused }) }).reads, work: NO_WORK },
          fakeLog().log,
          TOKEN,
          message,
        );
      // A client revoked since it was looked up, and a database that could not take the row.
      expect(await answering(async () => ({ ok: false, code: "unauthorized" }))).toEqual(
        rpcError(1, -32001, "unauthorized"),
      );
      expect(await answering(async () => ({ ok: false, code: "unavailable" }))).toEqual(
        rpcError(1, -32603, "unavailable"),
      );
      const thrown = await answering(async () => {
        throw new Error("relation calls is missing, at ada@example.com");
      });
      expect(thrown).toEqual(rpcError(1, -32603, "unavailable"));
      // What the provider must never hand over: a value, or nothing. Neither is sent.
      expect(
        await answering((async () => ({
          ok: true,
          value: { untrusted: "Hello" },
        })) as unknown as PersonalReads["refused"]),
      ).toEqual(rpcError(1, -32603, "unavailable"));
      expect(await answering((async () => undefined) as unknown as PersonalReads["refused"])).toEqual(
        rpcError(1, -32603, "unavailable"),
      );
      // The control: once recorded, the refusal is what the agent is answered.
      expect(await answering()).toEqual(toolError(1, code));
    }
  });

  it("every inputSchema has type object and additionalProperties false", async () => {
    const tools = await listed(fakeReads().reads);
    expect(tools.map((tool) => tool.name)).toEqual(CLIENT.tools);
    for (const tool of tools) {
      expect(Object.keys(tool)).toEqual(["name", "description", "inputSchema"]);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.inputSchema).toEqual(
        PersonalToolArgs[tool.name as PersonalReadTool].toJSONSchema({ io: "input", reused: "ref" }),
      );
    }
    // get_self's three arguments, all optional.
    expect(tools[0]?.inputSchema.properties).toEqual({
      history: { type: "boolean", description: expect.stringContaining("no longer open") },
      domain: { type: "string", enum: [...LIFE_DOMAINS], description: expect.stringContaining("One life domain") },
      moves: { type: "boolean", description: expect.stringContaining("next alone") },
      work: { type: "boolean", description: expect.stringContaining("work alone") },
    });
    expect(tools[0]?.inputSchema.required).toBeUndefined();
    expect(tools[1]?.inputSchema.required).toEqual(["query"]);
  });

  it("no tool of the agent API takes an anchor: no input schema names one", async () => {
    const { reads } = fakeReads(clientWith({ tools: [...TOOL_NAMES], views: ["self", "people", "work"] }));
    // A program's tools are listed to a board agent only when asked.
    const tools = await listed(reads, { programs: true });
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const names = (schema: unknown): string[] => {
      if (Array.isArray(schema)) return schema.flatMap(names);
      if (schema === null || typeof schema !== "object") return [];
      return Object.entries(schema).flatMap(([key, value]) => [
        ...(key === "properties" && value !== null && typeof value === "object" ? Object.keys(value) : []),
        ...names(value),
      ]);
    };
    const enums = (schema: unknown): unknown[] =>
      Array.isArray(schema)
        ? schema.flatMap(enums)
        : schema === null || typeof schema !== "object"
          ? []
          : Object.entries(schema).flatMap(([key, value]) =>
              key === "enum" && Array.isArray(value) ? value : enums(value),
            );
    // push_capture's `series`: the first part's key of a meeting sent in parts, no anchor.
    // lift_anchor's `anchor`: an agent's own anchor's id, never an owner's anchor.
    const kept: Record<string, string[]> = { push_capture: ["series"], lift_anchor: ["anchor"] };
    for (const tool of tools) {
      expect(
        names(tool.inputSchema).filter((name) => /anchor|series/i.test(name) && !kept[tool.name]?.includes(name)),
        tool.name,
      ).toEqual([]);
      expect(
        enums(tool.inputSchema).filter((value) => value === "url_prefix" || value === "meeting_series"),
        tool.name,
      ).toEqual([]);
    }
    // The control: the helpers see a property and an enum where there is one.
    expect(names(PersonalToolArgs.search.toJSONSchema({ io: "input", reused: "ref" }))).toContain("query");
    expect(enums(PersonalToolArgs.search.toJSONSchema({ io: "input", reused: "ref" }))).toContain("names");
  });

  it("not_found answers the same bytes for a hidden id and an absent id", async () => {
    // The provider holds two entities and shows the client one of them.
    const HIDDEN = `ent_${ulid(8)}`;
    const ABSENT = `ent_${ulid(9)}`;
    const held = new Map([
      [PERSON, true],
      [HIDDEN, false],
    ]);
    const visible = (id: string): boolean => held.get(id) === true;
    const { reads } = fakeReads({
      getEntity: async (_token, args) =>
        visible(args.id) ? { ok: true, value: ENTITY } : { ok: false, code: "not_found" },
      getTimeline: async (_token, args) =>
        visible(args.id) ? { ok: true, value: TIMELINE } : { ok: false, code: "not_found" },
    });
    for (const name of ["get_entity", "get_timeline"]) {
      const hidden = await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, { id: HIDDEN }));
      const absent = await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(name, { id: ABSENT }));
      expect(hidden).toEqual(toolError(1, "not_found"));
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
      expect(JSON.stringify(hidden)).not.toContain("ent_");
    }
    // The control: the id the client can see is answered.
    expect(
      await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call("get_entity", { id: PERSON })),
    ).toEqual(toolResult("get_entity", 1, ENTITY));
  });

  it("every description is a fixed string", async () => {
    const other = fakeReads({
      client: async () =>
        ClientView.parse({
          ...CLIENT,
          id: `cli_${ulid(2)}`,
          name: "other-client",
          compartments: ["own", "employer:example"],
        }),
      getSelf: async () => ({
        ok: true,
        value: SelfView.parse({
          addresses: [{ untrusted: "someone@example.org" }],
          timeZone: null,
          upcoming: [],
          contacts: [],
          changes: [],
        }),
      }),
      search: async () => ({ ok: true, value: SearchResult.parse({ results: [] }) }),
    });
    const first = await handle(
      { provider: fakeReads().reads, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      request("tools/list"),
    );
    const second = await handle(
      { provider: other.reads, work: NO_WORK },
      fakeLog().log,
      "another-token",
      request("tools/list"),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(other.calls.map((made) => made.method)).toEqual(["client"]);

    const tools = await listed(fakeReads().reads);
    expect(new Set(tools.map((tool) => tool.description)).size).toBe(tools.length);
    expect(tools.map((tool) => tool.name)).toContain("record_reads");
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      for (const evidence of [
        "Ada",
        "example.com",
        "Hello",
        "Planning",
        "Example Org",
        "4417",
        "Billing",
        "Total",
        "thread-1",
        "mail.google.com",
      ])
        expect(tool.description).not.toContain(evidence);
    }
  });

  it("a subject is wrapped as untrusted", async () => {
    const reply = await handle(
      { provider: fakeReads().reads, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      call("get_timeline", { id: PERSON }),
    );
    const { content, structuredContent } = (
      reply as {
        result: { content: { type: string; text: string }[]; structuredContent: { entries: { subject?: unknown }[] } };
      }
    ).result;
    expect(structuredContent.entries[0]?.subject).toEqual({ untrusted: "Hello" });
    expect(content).toEqual([{ type: "text", text: JSON.stringify(structuredContent) }]);
    expect(JSON.parse(content[0]?.text ?? "").entries[0].subject).toEqual({ untrusted: "Hello" });
  });

  it("a fake returning a bare subject answers -32603", async () => {
    // Each value is one the provider must never hand over: evidence text not wrapped, or a field no schema has.
    const bare: Partial<Record<keyof PersonalReads, unknown>>[] = [
      { getTimeline: { entries: [{ ...TIMELINE.entries[0], subject: "Hello" }] } },
      { getTimeline: { entries: [{ ...TIMELINE.entries[0], thread: "thread-1" }] } },
      { getTimeline: { entries: [{ ...TIMELINE.entries[0], body: { untrusted: "the text" } }] } },
      { getTimeline: { ...TIMELINE, next: "cursor" } },
      { getSelf: { ...SELF, addresses: ["owner@example.com"] } },
      { getSelf: { ...SELF, upcoming: [{ ...meeting, title: "Planning" }] } },
      { search: { results: [{ ...who, name: "Ada Example", lastInteractionAt: null }] } },
      { getEntity: { ...ENTITY, names: ["Ada Example"] } },
      { getEntity: { ...ENTITY, notes: "anything" } },
      { getEntity: undefined },
    ];
    for (const over of bare) {
      const [method, value] = Object.entries(over)[0] as [string, unknown];
      const { reads, calls } = fakeReads({ [method]: async () => ({ ok: true, value }) });
      const tool = TOOL_CALLS.find((known) => known.method === method);
      const reply = await handle(
        { provider: reads, work: NO_WORK },
        fakeLog().log,
        TOKEN,
        call(tool?.name ?? "", tool?.args),
      );
      expect(reply, JSON.stringify(over)).toEqual(rpcError(1, -32603, "unavailable"));
      expect(calls.map((made) => made.method)).toEqual(["client", method]);
    }
    // The control: the same values, wrapped, are sent.
    for (const tool of TOOL_CALLS)
      expect(
        await handle({ provider: fakeReads().reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
      ).toEqual(sentOf(tool.name, tool.value));
  });

  it("only read methods are called", async () => {
    const { reads, calls } = fakeReads();
    const { log } = fakeLog();
    const messages = [
      ...EVERY_REQUEST,
      request("ping"),
      call("no_such_tool"),
      call("search", { query: "ada", extra: true }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "{",
    ];
    for (const message of messages) await handle({ provider: reads, work: NO_WORK }, log, TOKEN, message);
    // `refused` writes the provider's call log and nothing else.
    expect([...new Set(calls.map((made) => made.method))].sort()).toEqual(
      ["client", ...READ_METHODS, "refused"].sort(),
    );
    // Exactly one read for each tool call that ran, one record for the bad arguments, and none
    // for anything else.
    expect(beyondClient(calls).map((made) => made.method)).toEqual([...READ_METHODS, "refused"]);
  });

  it("each tool maps every ReadOutcome code to the error table", async () => {
    // One call for each tool the contract names, so a tool added there is proved here or this fails.
    // The tools in `later` are proved elsewhere: build_context_pack in pack.test.ts, the two
    // document tools and fetch_template in handle-documents.test.ts, get_decision_history and get_suggestions in
    // handle-unserved-tools.test.ts; sync_mirror's port is a stub here.
    const later: readonly string[] = [
      "build_context_pack",
      "find_documents",
      "get_document",
      "get_decision_history",
      "fetch_template",
      "get_suggestions",
      "sync_mirror",
    ];
    expect(TOOL_CALLS.map((tool) => tool.name)).toEqual(
      PersonalReadTool.options.filter((name) => !later.includes(name)),
    );
    for (const tool of TOOL_CALLS) {
      // Whatever the read answers, it is the one thing asked of the provider for the call.
      const asked = [
        { method: "client", args: [TOKEN] },
        { method: tool.method, args: [TOKEN, tool.args] },
      ];
      for (const code of PersonalToolError.options) {
        const { reads, calls } = fakeReads({ [tool.method]: async () => ({ ok: false, code }) });
        expect(
          await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
          `${tool.name} ${code}`,
        ).toEqual(SENT[code]);
        expect(calls, `${tool.name} ${code}`).toEqual(asked);
      }
      const thrown = fakeReads({ [tool.method]: () => Promise.reject(new Error("no")) });
      expect(
        await handle({ provider: thrown.reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
        tool.name,
      ).toEqual(SENT.unavailable);
      expect(thrown.calls, tool.name).toEqual(asked);
      // The control: an ok value is sent, after the same one read.
      const { reads, calls } = fakeReads();
      expect(
        await handle({ provider: reads, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
        tool.name,
      ).toEqual(sentOf(tool.name, tool.value));
      expect(calls, tool.name).toEqual(asked);
    }
  });
});
