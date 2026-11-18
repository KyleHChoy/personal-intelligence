import { ClientView, PersonalTool, type TurnReply, type TurnRequest } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fakeProvider, fakeTurnModel } from "../testing.ts";

// Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const client = (tools: string[], views: string[]): ClientView =>
  ClientView.parse({ id: `cli_${ULID}`, name: "hermes", compartments: ["own"], views, tools });
const SELF = {
  addresses: [{ untrusted: "owner@example.org" }],
  timeZone: null,
  upcoming: [],
  contacts: [],
  changes: [],
};
const ack = { recordId: `rec_${ULID}` };
const note = { kind: "note", body: "Next: reply.", requestId: "req-0001" } as const;

describe("fakeProvider", () => {
  const clients = {
    all: client(["get_self", "record", "build_context_pack", "claim_opportunity", "draft_message"], ["self", "work"]),
    bare: client(["get_self"], []),
  };

  it("answers unauthorized for a token it does not know, and client() answers null for it", async () => {
    const provider = fakeProvider({ clients, answers: { get_self: () => ({ ok: true, value: SELF }) } });
    expect(await provider.getSelf("nobody")).toEqual({ ok: false, code: "unauthorized" });
    expect(await provider.client("nobody")).toBeNull();
    expect(await provider.client("all")).toEqual(clients.all);
  });

  it("answers not_permitted for a tool or a view the client lacks, record needing no view", async () => {
    const provider = fakeProvider({
      clients,
      answers: { get_self: () => ({ ok: true, value: SELF }), record: () => ({ ok: true, value: ack }) },
    });
    expect(await provider.getSelf("bare")).toEqual({ ok: false, code: "not_permitted" });
    expect(await provider.record("bare", note)).toEqual({ ok: false, code: "not_permitted" });
    // The positive controls: the same calls for a client that holds them.
    expect(await provider.getSelf("all")).toEqual({ ok: true, value: SELF });
    expect(await provider.record("all", note)).toEqual({ ok: true, value: ack });
    const noViews = fakeProvider({
      clients: { t: client(["record"], []) },
      answers: { record: () => ({ ok: true, value: ack }) },
    });
    expect(await noViews.record("t", note)).toEqual({ ok: true, value: ack });
  });

  it("checks a pack's purpose view after its arguments", async () => {
    const pack = {
      purpose: "meeting_prep",
      template: "meeting_prep@1",
      asOf: "2026-03-04T10:00:00Z",
      items: [],
      truncated: false,
      hash: "0".repeat(64),
    };
    const provider = fakeProvider({ clients, answers: { build_context_pack: () => ({ ok: true, value: pack }) } });
    expect(await provider.buildContextPack("all", { purpose: "meeting_prep", event: `evt_${ULID}` } as never)).toEqual({
      ok: false,
      code: "not_permitted",
    });
    const withPeople = fakeProvider({
      clients: { p: client(["build_context_pack"], ["self", "people"]) },
      answers: { build_context_pack: () => ({ ok: true, value: pack }) },
    });
    expect(await withPeople.buildContextPack("p", { purpose: "meeting_prep", event: `evt_${ULID}` } as never)).toEqual({
      ok: true,
      value: pack,
    });
  });

  it("answers invalid_request for arguments the tool's schema refuses, and unavailable for a tool it has no answer for", async () => {
    const provider = fakeProvider({ clients });
    expect(await provider.record("all", { ...note, label: "own" } as never)).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await provider.record("all", note)).toEqual({ ok: false, code: "unavailable" });
    expect(await provider.claimOpportunity("all", { id: `opp_${ULID}` } as never)).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await provider.draftMessage("all", { body: "x", requestId: "req-0001" } as never)).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  it("passes a scripted failure through, and throws on a scripted value that is not the tool's result", async () => {
    const provider = fakeProvider({
      clients,
      answers: {
        record: () => ({ ok: false, code: "rate_limited" }),
        draft_message: () => ({ ok: true, value: { draft: `drf_${ULID}`, held: true } }),
      },
    });
    expect(await provider.record("all", note)).toEqual({ ok: false, code: "rate_limited" });
    const draft = { to: ["alex@example.com"], subject: "Notes", body: "Hello.", requestId: "req-0001" };
    await expect(provider.draftMessage("all", draft)).rejects.toThrow("not its result");
  });

  it("refused and refusedWork decide the code from the registration", async () => {
    const provider = fakeProvider({ clients });
    expect(await provider.refused("all", "get_self")).toEqual({ ok: false, code: "invalid_request" });
    expect(await provider.refused("all", "search")).toEqual({ ok: false, code: "not_permitted" });
    expect(await provider.refused("bare", "get_self")).toEqual({ ok: false, code: "not_permitted" });
    expect(await provider.refused("nobody", "get_self")).toEqual({ ok: false, code: "unauthorized" });
    expect(await provider.refusedWork("all", "claim_opportunity")).toEqual({ ok: false, code: "invalid_request" });
    expect(await provider.refusedWork("all", "next_run")).toEqual({ ok: false, code: "not_permitted" });
    expect(await provider.refusedWork("all", "draft_message")).toEqual({ ok: false, code: "invalid_request" });
  });

  it("records every call in order, with whether it was refused", async () => {
    const provider = fakeProvider({ clients, answers: { get_self: () => ({ ok: true, value: SELF }) } });
    await provider.getSelf("all");
    await provider.refused("all", "search");
    await provider.nextRun("all", { requestId: "req-0001" });
    expect(provider.calls).toEqual([
      { tool: "get_self", token: "all", args: {}, refused: false },
      { tool: "search", token: "all", args: undefined, refused: true },
      { tool: "next_run", token: "all", args: { requestId: "req-0001" }, refused: false },
    ]);
  });

  it("serves every tool there is", async () => {
    const everything = fakeProvider({ clients: { t: client(PersonalTool.options, ["self", "people", "work"]) } });
    const methods = Object.keys(everything).filter(
      (key) => !["calls", "client", "refused", "refusedWork"].includes(key),
    );
    expect(methods).toHaveLength(PersonalTool.options.length);
  });
});

describe("fakeTurnModel", () => {
  const reply: TurnReply = {
    text: null,
    toolCalls: [{ id: "c1", name: "get_self", arguments: {} }],
    inputTokens: 10,
    outputTokens: 2,
    costMicroUsd: 30,
    modelId: "model-a",
  };
  const request: TurnRequest = {
    system: "s",
    messages: [{ role: "user", text: "u" }],
    tools: [],
    maxOutputTokens: 100,
  };

  it("answers each turn with the next reply, records each request, and is unavailable past the last", async () => {
    const model = fakeTurnModel([reply, new Error("timed_out")]);
    expect(await model.turn(request)).toEqual(reply);
    await expect(model.turn(request)).rejects.toThrow("timed_out");
    await expect(model.turn(request)).rejects.toThrow("unavailable");
    expect(model.requests).toHaveLength(3);
  });

  it("refuses a request that is not a TurnRequest, and a reply that is not a TurnReply", async () => {
    await expect(fakeTurnModel([reply]).turn({ ...request, temperature: 0 } as never)).rejects.toThrow();
    await expect(fakeTurnModel([{ ...reply, raw: "{}" } as never]).turn(request)).rejects.toThrow();
  });
});
