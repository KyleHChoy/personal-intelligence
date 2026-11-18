import { MemoryProjection, PersonalToolError, SyncMemoryArgs } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Call, Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  handleAtOnce as handle,
  NO_WORK,
  request,
  rpcError,
  TOKEN,
  toolError,
  toolResult,
  ulid,
} from "./test-support/fakes.ts";

// The sync_memory tool.

const HOLDER = clientView({ tools: ["get_self", "sync_memory"], views: ["self", "work"] });
const SENTINEL_ID = `mpr_${"5e471e1".padEnd(40, "0")}`;
const projection = (n: number): string => `mpr_${n.toString(16).padStart(40, "0")}`;
const stamp = { projection: projection(1), fact: "b".repeat(64), state: "c".repeat(64) };
const ENTRY = {
  kind: "commitment",
  section: "commitments",
  stamp,
  status: "active",
  direction: "owed_by_owner",
  counterparty: `ent_${ulid(3)}`,
  due: "2026-10-09",
};
const PROJECTION = MemoryProjection.parse({
  template: "active_memory@1",
  asOf: "2026-10-04T10:00:00Z",
  entries: [ENTRY],
  corrections: [
    { projection: projection(2), endedAt: "2026-10-03T10:00:00Z", reason: "changed", current: projection(1) },
  ],
  remove: [SENTINEL_ID],
  truncated: false,
  inStep: false,
  hash: "e".repeat(64),
});
const served: Partial<Provider> = { syncMemory: async () => ({ ok: true, value: PROJECTION }) };
const ARGS = { have: [SENTINEL_ID], canDelete: true };
const beyondClient = (calls: Call[]): Call[] => calls.filter((made) => made.method !== "client");
const listed = async (provider: Provider): Promise<{ name: string; description: string; inputSchema: unknown }[]> => {
  const reply = await handle({ provider, work: NO_WORK }, fakeLog().log, TOKEN, request("tools/list"));
  return (reply as { result: { tools: { name: string; description: string; inputSchema: unknown }[] } }).result.tools;
};
const ask = (provider: Provider, args: unknown, log = fakeLog().log) =>
  handle({ provider, work: NO_WORK }, log, TOKEN, call("sync_memory", args));
const wrong = (over: Record<string, unknown>) => ({ ...PROJECTION, ...over }) as unknown as MemoryProjection;

describe("the sync_memory tool", () => {
  it("a client without sync_memory is not offered it and a call answers not_permitted", async () => {
    expect((await listed(fakeProvider(HOLDER).provider)).map((tool) => tool.name)).toEqual(["get_self", "sync_memory"]);
    const without = fakeProvider(clientView({ tools: ["get_self"], views: ["self", "work"] }), served);
    expect((await listed(without.provider)).map((tool) => tool.name)).toEqual(["get_self"]);
    expect(await ask(without.provider, ARGS)).toEqual(toolError(1, "not_permitted"));
    expect(beyondClient(without.calls).map((made) => made.method)).toEqual(["refused"]);
    // The tool held, the self view not: not offered either.
    const noSelf = fakeProvider(clientView({ tools: ["sync_memory"], views: ["people"] }), served);
    expect(await listed(noSelf.provider)).toEqual([]);
    expect(await ask(noSelf.provider, ARGS)).toEqual(toolError(1, "not_permitted"));
    // The control: held, with self, it is run. A client without the work view is the
    // provider's to answer with an empty projection, so it is offered too.
    expect(await ask(fakeProvider(HOLDER, served).provider, ARGS)).toEqual(toolResult(1, PROJECTION));
    expect(
      (await listed(fakeProvider(clientView({ tools: ["sync_memory"], views: ["self"] })).provider)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["sync_memory"]);
  });

  it("sync_memory with an extra field answers invalid_request without a read", async () => {
    const { provider, calls } = fakeProvider(HOLDER, served);
    for (const bad of [
      { ...ARGS, client: "other-client" },
      { have: [SENTINEL_ID] },
      { have: [SENTINEL_ID, SENTINEL_ID], canDelete: true },
      { have: ["mpr_short"], canDelete: true },
    ]) {
      expect(await ask(provider, bad)).toEqual(toolError(1, "invalid_request"));
    }
    expect(beyondClient(calls).map((made) => made.method)).toEqual(["refused", "refused", "refused", "refused"]);
  });

  it("a projection that fails its strict schema answers unavailable", async () => {
    const free = { ...ENTRY, what: { untrusted: "send the deck" } };
    const versioned = { ...ENTRY, stamp: { ...stamp, version: 3 } };
    for (const value of [
      wrong({ entries: [free] }),
      wrong({ entries: [versioned] }),
      wrong({ hash: "E".repeat(64) }),
    ]) {
      const { provider } = fakeProvider(HOLDER, { syncMemory: async () => ({ ok: true, value }) });
      expect(await ask(provider, ARGS)).toEqual(rpcError(1, -32603, "unavailable"));
    }
  });

  it("the description is a fixed string", async () => {
    const other = clientView({ tools: ["get_self", "sync_memory"], views: ["self", "work"], name: "other-client" });
    const first = await handle(
      { provider: fakeProvider(HOLDER, served).provider, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      request("tools/list"),
    );
    const busy = fakeProvider(other, {
      syncMemory: async () => ({ ok: true, value: wrong({ hash: "f".repeat(64) }) }),
    });
    const second = await handle(
      { provider: busy.provider, work: NO_WORK },
      fakeLog().log,
      "another-token",
      request("tools/list"),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(busy.calls.map((made) => made.method)).toEqual(["client"]);
    const tool = (await listed(fakeProvider(HOLDER).provider)).find((listedTool) => listedTool.name === "sync_memory");
    expect(tool?.inputSchema).toEqual(SyncMemoryArgs.toJSONSchema({ io: "input", reused: "ref" }));
    expect(tool?.description).toContain("memory adapter");
    expect(tool?.description).toContain("an agent has no use for it");
    for (const evidence of ["example.com", "test-client", TOKEN]) expect(tool?.description).not.toContain(evidence);
  });

  it("only client and syncMemory are called, with the parsed arguments", async () => {
    const { provider, calls } = fakeProvider(HOLDER, served);
    expect(await ask(provider, ARGS)).toEqual(toolResult(1, PROJECTION));
    expect(calls).toEqual([
      { method: "client", args: [TOKEN] },
      { method: "syncMemory", args: [TOKEN, ARGS] },
    ]);
  });

  it("no log event holds an argument or a result value", async () => {
    const outcomes: Partial<Provider>[] = [
      served,
      { syncMemory: async () => ({ ok: false, code: "not_found" }) },
      { syncMemory: async () => ({ ok: true, value: wrong({ hash: "x" }) }) },
      { syncMemory: () => Promise.reject(new Error(SENTINEL_ID)) },
    ];
    for (const over of outcomes) {
      const { log, events } = fakeLog();
      await ask(fakeProvider(HOLDER, over).provider, ARGS, log);
      await ask(fakeProvider(HOLDER, over).provider, { ...ARGS, extra: SENTINEL_ID }, log);
      const text = JSON.stringify(events);
      expect(events.length).toBe(2);
      for (const value of [SENTINEL_ID, stamp.fact, stamp.state, ENTRY.counterparty, "2026-10-09", "e".repeat(64)])
        expect(text).not.toContain(value);
    }
  });

  it("no tool name in tools/list reads an exposure or the queue", async () => {
    const everything = clientView({
      tools: [
        "get_self",
        "search",
        "get_entity",
        "get_timeline",
        "find_messages",
        "read_message",
        "find_facts",
        "build_context_pack",
        "sync_memory",
        "record",
      ],
      views: ["self", "people", "work"],
    });
    const names = (await listed(fakeProvider(everything).provider)).map((tool) => tool.name);
    expect(names).toContain("sync_memory");
    for (const name of names) expect(name).not.toMatch(/exposure|queue|card|memory_status/);
  });

  it("each ReadOutcome code of the call maps to the error table", async () => {
    const both = clientView({ tools: ["sync_memory", "build_context_pack"], views: ["self", "work"] });
    for (const code of PersonalToolError.options) {
      const memory = fakeProvider(both, { syncMemory: async () => ({ ok: false, code }) });
      const pack = fakeProvider(both, { buildContextPack: async () => ({ ok: false, code }) });
      const fromMemory = await ask(memory.provider, ARGS);
      const fromPack = await handle(
        { provider: pack.provider, work: NO_WORK },
        fakeLog().log,
        TOKEN,
        call("build_context_pack", { purpose: "agent_bootstrap" }),
      );
      // The same answer, but for build_context_pack's own hint.
      const first = (reply: unknown) => ({
        ...(reply as object),
        result: {
          ...(reply as { result?: object }).result,
          content: (reply as { result?: { content?: unknown[] } }).result?.content?.slice(0, 1),
        },
      });
      expect("result" in (fromMemory as object) ? first(fromMemory) : fromMemory, code).toEqual(
        "result" in (fromPack as object) ? first(fromPack) : fromPack,
      );
    }
  });
});
