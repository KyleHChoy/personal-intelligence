import { Readable, Writable } from "node:stream";
import type { CallOptions, PersonalWork } from "@intelligence/contracts/personal";
import { AgentRecordAck, SearchResult, TOOL_NAMES } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { DEADLINE_MS, MAX_MULTIPLES } from "./deadlines.ts";
import { handle } from "./handle.ts";
import { serveStdio } from "./stdio.ts";
import type { Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  request,
  rpcError,
  TOKEN,
  toolError,
  toolResult,
  ulid,
} from "./test-support/fakes.ts";
import { isTool } from "./tools.ts";

// The clock and the sleep are fakes: time moves only when nothing else can run, to the next timer anyone
// is waiting on.

function fakeTime() {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const clock = (): number => now;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => timers.push({ at: now + Math.max(0, ms), resolve }));
  // Settles `promise`, moving the clock to the earliest timer each time everything else waits.
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (;;) {
      // A few turns of the event loop, so a stream's own deferred work runs before time moves.
      for (let turn = 0; turn < 5 && !done; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      if (done) return promise;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next === undefined) throw new Error("nothing to wait for, and the promise has not settled");
      // Work that held the event loop may have moved the clock past the timer: it never goes back.
      now = Math.max(now, next.at);
      next.resolve();
    }
  }
  // Work that holds the event loop: the clock moves, and no timer can fire meanwhile.
  const block = (ms: number): void => {
    now += ms;
  };
  return { clock, sleep, drive, block, now: () => now };
}

const SEARCH_MS = DEADLINE_MS.search;
const ENTITY_MS = DEADLINE_MS.get_entity;
const EMPTY = SearchResult.parse({ results: [] });
const ACK = AgentRecordAck.parse({ recordId: `rec_${ulid(1)}` });
const CLIENT = clientView({
  tools: ["search", "get_entity", "record", "list_opportunities"],
  views: ["self", "people", "work"],
});

// A provider whose search takes `ms` of the fake clock, then answers `answer`.
function slow(time: ReturnType<typeof fakeTime>, ms: number, over: Partial<Provider> = {}) {
  return fakeProvider(CLIENT, {
    search: async () => {
      await time.sleep(ms);
      return { ok: true, value: EMPTY };
    },
    ...over,
  });
}

// One message through handle on the fake clock: its reply and the time it was given.
async function answered(
  time: ReturnType<typeof fakeTime>,
  provider: Provider,
  message: string,
  work: PersonalWork = fakeWork(CLIENT).work,
  token: string | undefined = TOKEN,
) {
  const { log, events } = fakeLog();
  const reply = await time.drive(
    handle({ provider, work }, log, token, message, { clock: time.clock, sleep: time.sleep }),
  );
  return { reply, at: time.now(), events };
}

describe("tool_work", () => {
  const tally = async <T>(fn: () => Promise<T>) => ({
    value: await fn(),
    tally: { statements: 7, sqlMs: 120.4, waitMs: 3.2 },
  });
  const line = (time: ReturnType<typeof fakeTime>, provider: Provider, options: object) => {
    const { log, events } = fakeLog();
    const reply = handle({ provider, work: fakeWork(CLIENT).work }, log, TOKEN, call("search", { query: "x" }), {
      clock: time.clock,
      sleep: time.sleep,
      ...options,
    });
    return time.drive(reply).then(() => events.filter((one) => one.event === "tool_work"));
  };

  it("says the work's real time, its statements and its bucket, in ids and numbers alone", async () => {
    const time = fakeTime();
    const events = await line(time, slow(time, SEARCH_MS + 40).provider, { tally });
    expect(events).toEqual([
      {
        event: "tool_work",
        code: "ok",
        tool: "search",
        counts: {
          work_ms: SEARCH_MS + 40,
          deadline_ms: SEARCH_MS,
          multiples: 2,
          statements: 7,
          sql_ms: 120,
          wait_ms: 3,
        },
      },
    ]);
    expect(time.now()).toBe(2 * SEARCH_MS);
  });

  it("the reply's time does not move for it", async () => {
    const time = fakeTime();
    await line(time, slow(time, 5).provider, { tally });
    expect(time.now()).toBe(SEARCH_MS);
  });

  it("a call still working at the fourth multiple is logged cancelled, with no count", async () => {
    const time = fakeTime();
    const events = await line(time, slow(time, 100 * SEARCH_MS).provider, { tally });
    expect(events[0]?.counts).toEqual({
      work_ms: MAX_MULTIPLES * SEARCH_MS,
      deadline_ms: SEARCH_MS,
      multiples: MAX_MULTIPLES,
      cancelled: 1,
    });
  });

  it("a tally that itself fails is answered unavailable at the next multiple, never left unhandled", async () => {
    const time = fakeTime();
    const { log } = fakeLog();
    const reply = await time.drive(
      handle(
        { provider: slow(time, 5).provider, work: fakeWork(CLIENT).work },
        log,
        TOKEN,
        call("search", { query: "x" }),
        {
          clock: time.clock,
          sleep: time.sleep,
          tally: () => Promise.reject(new Error("tally failed")),
        },
      ),
    );
    expect(reply).toMatchObject({ error: { message: "unavailable" } });
    expect(time.now()).toBe(SEARCH_MS);
  });

  it("without a tally, as `pi mcp`, whose client reads its stderr, there is no such line", async () => {
    const time = fakeTime();
    expect(await line(time, slow(time, 5).provider, {})).toEqual([]);
  });
});

describe("next_run's deadline", () => {
  // Its reply reads what get_self reads and more, in the transaction a cancel rolls back: the take
  // too, so a run too slow to answer would stop the queue.
  it("is above get_self's, which it reads", () => {
    expect(DEADLINE_MS.next_run).toBeGreaterThan(DEADLINE_MS.get_self);
  });
});

describe("DEADLINE_MS", () => {
  it("every tool the agent API serves has a DEADLINE_MS row", () => {
    expect(TOOL_NAMES.length).toBeGreaterThan(20);
    for (const name of TOOL_NAMES) {
      const deadline = DEADLINE_MS[name];
      expect(Number.isInteger(deadline) && deadline > 0 && deadline % 100 === 0, name).toBe(true);
    }
  });

  it("no row names a tool the agent API does not serve", () => {
    expect(Object.keys(DEADLINE_MS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of Object.keys(DEADLINE_MS)) expect(isTool(name), name).toBe(true);
    expect(isTool("no_such_tool")).toBe(false);
  });

  it("is frozen, gives every tool a positive deadline, and next_run twice get_self's", () => {
    expect(Object.isFrozen(DEADLINE_MS)).toBe(true);
    for (const [name, ms] of Object.entries(DEADLINE_MS)) expect(ms, name).toBeGreaterThan(0);
    expect(DEADLINE_MS.next_run).toBe(2 * DEADLINE_MS.get_self);
    expect(MAX_MULTIPLES).toBe(4);
  });
});

describe("the reply deadline", () => {
  it("a fast call and a slow call both reply at the deadline", async () => {
    for (const ms of [1, 0.9 * SEARCH_MS]) {
      const time = fakeTime();
      const { reply, at, events } = await answered(time, slow(time, ms).provider, call("search", { query: "ada" }));
      expect(reply).toEqual(toolResult(1, EMPTY));
      expect(at).toBe(SEARCH_MS);
      // The duration logged is the reply's, never the work's.
      expect(events).toEqual([
        { event: "mcp_call", ids: { client: "test-client" }, code: "ok", durationMs: SEARCH_MS, tool: "search" },
      ]);
    }
  });

  it("a refusal replies at the same deadline as an ok", async () => {
    // get_entity: ok, not_found, invalid arguments, and a tool the client is not offered.
    const entityAt = async (provider: Provider, message: string) => (await answered(fakeTime(), provider, message)).at;
    const notFound = fakeProvider(CLIENT, { getEntity: async () => ({ ok: false, code: "not_found" }) }).provider;
    expect(await entityAt(notFound, call("get_entity", { id: `ent_${ulid(1)}` }))).toBe(ENTITY_MS);
    expect(await entityAt(notFound, call("get_entity", { id: "not-an-id" }))).toBe(ENTITY_MS);
    expect(await entityAt(fakeProvider(clientView()).provider, call("get_entity", { id: `ent_${ulid(1)}` }))).toBe(
      ENTITY_MS,
    );
    // A refusal logs its tool and its code, at the same padded duration.
    const refused = await answered(fakeTime(), notFound, call("get_entity", { id: `ent_${ulid(1)}` }));
    expect(refused.events).toEqual([
      {
        event: "mcp_call",
        ids: { client: "test-client" },
        code: "not_found",
        durationMs: ENTITY_MS,
        tool: "get_entity",
      },
    ]);
    // An unknown or revoked token, and a client lookup that fails, wait the tool's deadline too.
    expect(
      await entityAt(
        fakeProvider(CLIENT, { client: async () => null }).provider,
        call("get_entity", { id: `ent_${ulid(1)}` }),
      ),
    ).toBe(ENTITY_MS);
    const failing = fakeProvider(CLIENT, {
      client: async () => {
        throw new Error("down");
      },
    }).provider;
    expect(await entityAt(failing, call("get_entity", { id: `ent_${ulid(1)}` }))).toBe(ENTITY_MS);

    // record: ok, and rate_limited, at record's deadline.
    for (const answer of [
      { ok: true as const, value: ACK },
      { ok: false as const, code: "rate_limited" as const },
    ]) {
      const time = fakeTime();
      const { reply, at } = await answered(
        time,
        fakeProvider(CLIENT, { record: async () => answer }).provider,
        call("record", { kind: "note", body: "x", requestId: `req_${ulid(1)}` }),
      );
      expect(reply).toEqual(answer.ok ? toolResult(1, ACK) : toolError(1, "rate_limited"));
      expect(at).toBe(DEADLINE_MS.record);
    }

    // A work tool's refusal, at its deadline.
    const time = fakeTime();
    const refusing = fakeWork(CLIENT, { listOpportunities: async () => ({ ok: false, code: "not_permitted" }) }).work;
    const { reply, at } = await answered(time, fakeProvider(CLIENT).provider, call("list_opportunities", {}), refusing);
    expect(reply).toEqual(toolError(1, "not_permitted"));
    expect(at).toBe(DEADLINE_MS.list_opportunities);
  });

  it("work at 1.5 deadlines replies at 2 and logs reply_over_deadline with count 2", async () => {
    const time = fakeTime();
    const { reply, at, events } = await answered(
      time,
      slow(time, 1.5 * SEARCH_MS).provider,
      call("search", { query: "ada" }),
    );
    expect(reply).toEqual(toolResult(1, EMPTY));
    expect(at).toBe(2 * SEARCH_MS);
    // The tool's name as the code and the count: nothing else.
    expect(events).toEqual([
      { event: "reply_over_deadline", code: "search", counts: { multiples: 2 }, tool: "search" },
      { event: "mcp_call", ids: { client: "test-client" }, code: "ok", durationMs: 2 * SEARCH_MS, tool: "search" },
    ]);
    // At 3.5, the fourth: still answered, with count 4.
    const later = fakeTime();
    const fourth = await answered(later, slow(later, 3.5 * SEARCH_MS).provider, call("search", { query: "ada" }));
    expect([fourth.reply, fourth.at, fourth.events[0]]).toEqual([
      toolResult(1, EMPTY),
      4 * SEARCH_MS,
      { event: "reply_over_deadline", code: "search", counts: { multiples: 4 }, tool: "search" },
    ]);
  });

  it("ping, initialize, tools/list, the protocol errors and a call with no token reply at once", async () => {
    const provider = fakeProvider(CLIENT).provider;
    const messages: [string, string, unknown][] = [
      [TOKEN, request("ping"), { jsonrpc: "2.0", id: 1, result: {} }],
      [TOKEN, "{not json", rpcError(null, -32700, "parse_error")],
      [TOKEN, "[]", rpcError(null, -32600, "invalid_request")],
      [TOKEN, request("resources/list"), rpcError(1, -32601, "method_not_found")],
      [TOKEN, request("tools/call", { arguments: {} }), rpcError(1, -32602, "invalid_params")],
      ["", call("search", { query: "ada" }), rpcError(1, -32001, "unauthorized")],
      // A name that is no tool has no deadline: it reads nothing, and the tools are no secret.
      [TOKEN, call("no_such_tool"), toolError(1, "not_permitted")],
    ];
    for (const [token, message, expected] of messages) {
      const time = fakeTime();
      const { reply, at } = await answered(time, provider, message, fakeWork(CLIENT).work, token);
      expect(reply, message).toEqual(expected);
      expect(at, message).toBe(0);
    }
    // A name that is no tool is still answered at once, and logged as unknown with its class,
    // never as sent.
    const { at, events } = await answered(fakeTime(), provider, call("no_such_tool"));
    expect(at).toBe(0);
    expect(events).toEqual([
      {
        event: "mcp_call",
        ids: { client: "test-client" },
        code: "not_permitted",
        durationMs: 0,
        tool: "unknown",
        reason: "tool_unknown",
      },
    ]);
    for (const method of ["initialize", "tools/list"]) {
      const time = fakeTime();
      const { reply, at } = await answered(time, provider, request(method));
      expect(reply).toMatchObject({ id: 1, result: {} });
      expect(at).toBe(0);
    }
  });

  it("two calls sent together are answered at the first deadline and at that plus the second", async () => {
    const time = fakeTime();
    const { provider } = fakeProvider(CLIENT, {
      search: async () => ({ ok: true, value: EMPTY }),
      getEntity: async () => ({ ok: false, code: "not_found" }),
    });
    const written: { at: number; id: unknown }[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        written.push({ at: time.now(), id: (JSON.parse(chunk.toString()) as { id: unknown }).id });
        done();
      },
    });
    const input = Readable.from([
      `${call("search", { query: "ada" }, 1)}\n${call("get_entity", { id: `ent_${ulid(1)}` }, 2)}\n`,
    ]);
    await time.drive(
      serveStdio({ provider, work: fakeWork(CLIENT).work }, fakeLog().log, TOKEN, input, output, {
        clock: time.clock,
        sleep: time.sleep,
      }),
    );
    expect(written).toEqual([
      { at: SEARCH_MS, id: 1 },
      { at: SEARCH_MS + ENTITY_MS, id: 2 },
    ]);
  });

  it("work past four deadlines is answered unavailable at the fourth, its signal aborted", async () => {
    const time = fakeTime();
    const seen: CallOptions[] = [];
    // Work that never ends unless cancelled; cancelled, it rolls back and answers unavailable,
    // as the store does.
    const { provider } = fakeProvider(CLIENT, {
      search: (_token, _args, options = {}) => {
        seen.push(options);
        return new Promise((resolve) =>
          options.signal?.addEventListener("abort", () => resolve({ ok: false, code: "unavailable" })),
        );
      },
    });
    const { reply, at, events } = await answered(time, provider, call("search", { query: "ada" }));
    expect(reply).toEqual(rpcError(1, -32603, "unavailable"));
    expect(at).toBe(MAX_MULTIPLES * SEARCH_MS);
    expect(seen.map((options) => options.signal?.aborted)).toEqual([true]);
    expect(events).toEqual([
      { event: "reply_over_deadline", code: "search", counts: { multiples: 4 }, tool: "search" },
      {
        event: "mcp_call",
        ids: { client: "test-client" },
        code: "unavailable",
        durationMs: 4 * SEARCH_MS,
        tool: "search",
      },
    ]);
    // A port that never settles, even once aborted, is answered at the fourth all the same: the
    // reply does not wait for the rollback.
    const stuck = fakeTime();
    const hanging = fakeProvider(CLIENT, { search: () => new Promise(() => {}) }).provider;
    const never = await answered(stuck, hanging, call("search", { query: "ada" }));
    expect([never.reply, never.at]).toEqual([rpcError(1, -32603, "unavailable"), MAX_MULTIPLES * SEARCH_MS]);
  });

  it("a wake held up past its multiple, by work holding the event loop, waits for the next whole one", async () => {
    const time = fakeTime();
    // Done between the second and third multiples by work that never yields: the first timer can
    // only fire then.
    const { provider } = fakeProvider(CLIENT, {
      getEntity: async () => {
        time.block(2.375 * ENTITY_MS);
        return { ok: false, code: "not_found" };
      },
    });
    const { reply, at, events } = await answered(time, provider, call("get_entity", { id: `ent_${ulid(1)}` }));
    expect(reply).toEqual(toolError(1, "not_found"));
    expect(at).toBe(3 * ENTITY_MS);
    expect(events[0]).toEqual({
      event: "reply_over_deadline",
      code: "get_entity",
      counts: { multiples: 3 },
      tool: "get_entity",
    });
    // Held past the fourth multiple, it is answered unavailable at once.
    const later = fakeTime();
    const blocking = fakeProvider(CLIENT, {
      getEntity: async () => {
        later.block(5 * ENTITY_MS);
        return { ok: false, code: "not_found" };
      },
    }).provider;
    const past = await answered(later, blocking, call("get_entity", { id: `ent_${ulid(1)}` }));
    expect([past.reply, past.at, past.events[0]]).toEqual([
      rpcError(1, -32603, "unavailable"),
      5 * ENTITY_MS,
      { event: "reply_over_deadline", code: "get_entity", counts: { multiples: 4 }, tool: "get_entity" },
    ]);
  });

  it("the signal reaches every port a call makes, and is not aborted for a call in time", async () => {
    const time = fakeTime();
    const seen: (AbortSignal | undefined)[] = [];
    const { provider } = fakeProvider(CLIENT, {
      client: async (_token, options = {}) => {
        seen.push(options.signal);
        return CLIENT;
      },
      refused: async (_token, _tool, options = {}) => {
        seen.push(options.signal);
        return { ok: false, code: "invalid_request" };
      },
    });
    await answered(time, provider, call("search", { unknown: true }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("the document tools hand the call's signal to their port, and reply at their deadline", async () => {
    const documents = clientView({ tools: ["find_documents", "get_document"], views: ["work"] });
    const cases = [
      { tool: "find_documents", args: {}, port: "findDocuments" },
      { tool: "get_document", args: { id: `doc_${ulid(1)}` }, port: "getDocument" },
    ] as const;
    for (const { tool, args, port } of cases) {
      const time = fakeTime();
      const seen: (AbortSignal | undefined)[] = [];
      const { provider } = fakeProvider(documents, {
        client: async (_token, options = {}) => {
          seen.push(options.signal);
          return documents;
        },
        [port]: async (_token: string, _args: unknown, options: CallOptions = {}) => {
          seen.push(options.signal);
          return { ok: false, code: "not_found" };
        },
      });
      const { reply, at } = await answered(time, provider, call(tool, args));
      expect(reply, tool).toEqual(toolError(1, "not_found"));
      expect(at, tool).toBe(DEADLINE_MS[tool]);
      expect(seen, tool).toHaveLength(2);
      expect(seen[0], tool).toBeInstanceOf(AbortSignal);
      expect(seen[1], tool).toBe(seen[0]);
    }
  });

  it("a throw inside a call answers unavailable at the deadline and the process keeps serving", async () => {
    const time = fakeTime();
    const { provider } = fakeProvider(CLIENT, {
      search: async () => {
        await time.sleep(5);
        throw new Error("a fault, with words that must go nowhere");
      },
      getEntity: async () => ({ ok: false, code: "not_found" }),
    });
    const lines: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(`${time.now()} ${chunk.toString().trim()}`);
        done();
      },
    });
    const input = Readable.from([
      `${call("search", { query: "ada" }, 1)}\n${call("get_entity", { id: `ent_${ulid(1)}` }, 2)}\n`,
    ]);
    await time.drive(
      serveStdio({ provider, work: fakeWork(CLIENT).work }, fakeLog().log, TOKEN, input, output, {
        clock: time.clock,
        sleep: time.sleep,
      }),
    );
    expect(lines.map((line) => line.split(" ")[0])).toEqual([`${SEARCH_MS}`, `${SEARCH_MS + ENTITY_MS}`]);
    expect(JSON.parse(lines[0]?.slice(lines[0].indexOf(" ") + 1) ?? "")).toEqual(rpcError(1, -32603, "unavailable"));
    expect(JSON.parse(lines[1]?.slice(lines[1].indexOf(" ") + 1) ?? "")).toEqual(toolError(2, "not_found"));
  });

  it("a call's log lines are written after its reply: logs are held from each line until its reply is written", async () => {
    const time = fakeTime();
    const order: string[] = [];
    const { provider } = fakeProvider(CLIENT, { search: async () => ({ ok: true, value: EMPTY }) });
    // A write that completes a turn later, so a hook that did not wait for it would come first.
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        setImmediate(() => {
          order.push(`reply ${(JSON.parse(chunk.toString()) as { id: unknown }).id}`);
          done();
        });
      },
    });
    const input = Readable.from([
      `${call("search", { query: "ada" }, 1)}\n${request("ping", undefined, 2)}\n{not json\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    ]);
    const logs = { hold: () => order.push("hold"), flush: () => order.push("flush") };
    await time.drive(
      serveStdio({ provider, work: fakeWork(CLIENT).work }, fakeLog().log, TOKEN, input, output, {
        clock: time.clock,
        sleep: time.sleep,
        logs,
      }),
    );
    expect(order).toEqual([
      "hold",
      "reply 1",
      "flush",
      "hold",
      "reply 2",
      "flush",
      "hold",
      "reply null",
      "flush",
      "hold",
      "flush",
    ]);
  });
});
