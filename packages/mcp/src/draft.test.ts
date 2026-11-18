import type { ClientView, PersonalWork } from "@intelligence/contracts/personal";
import { PersonalRunTool, PersonalWorkTool } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  request,
  rpcError,
  TOKEN,
  toolError,
  toolResult,
  ulid,
} from "./test-support/fakes.ts";

// The propose tool draft_message, against fake ports.
// Hand-written fixtures: reserved domains, and ids that are valid but mean nothing.

const DRAFT = `drf_${ulid(1)}`;
const ARGS = {
  to: ["rowan@example.test"],
  subject: "A question",
  body: "Shall we meet on Tuesday?",
  requestId: "request-0001",
};
const REPLY = { replyTo: `msg_${ulid(1)}`, body: "Tuesday works.", requestId: "request-0002" };

const drafter = (over: { tools?: string[]; views?: string[]; name?: string } = {}): ClientView =>
  clientView({ tools: ["get_self", "draft_message"], views: ["self", "people", "work"], ...over });

const answering = (value: unknown) => (async () => ({ ok: true as const, value })) as never;

async function ask(client: ClientView, message: string, over: Partial<PersonalWork> = {}) {
  const reads = fakeProvider(client);
  const work = fakeWork(client, { draftMessage: answering({ draft: DRAFT }), ...over });
  const reply = await handle({ provider: reads.provider, work: work.work }, fakeLog().log, TOKEN, message);
  return { reply, reads: reads.calls.map((c) => c.method), work: work.calls };
}

const listed = async (client: ClientView): Promise<{ name: string; description: string }[]> =>
  (
    (await ask(client, request("tools/list"))).reply as unknown as {
      result: { tools: { name: string; description: string }[] };
    }
  ).result.tools;

describe("draft_message", () => {
  it("draft_message outside the registration is not listed and not run", async () => {
    const without = drafter({ tools: ["get_self"] });
    expect((await listed(without)).map((tool) => tool.name)).toEqual(["get_self"]);
    const refused = await ask(without, call("draft_message", ARGS));
    expect(refused.reply).toEqual(toolError(1, "not_permitted"));
    expect(refused.work.map((c) => c.method)).toEqual(["refusedWork"]);
    expect(refused.work[0]?.args).toEqual([TOKEN, "draft_message"]);
    expect(refused.reads).toEqual(["client"]);
    // Without the view `work` it is neither listed nor run.
    const blind = drafter({ views: ["self", "people"] });
    expect((await listed(blind)).map((tool) => tool.name)).toEqual(["get_self"]);
    expect((await ask(blind, call("draft_message", ARGS))).reply).toEqual(toolError(1, "not_permitted"));
    // Held, it is listed after the work tools.
    expect((await listed(drafter())).map((tool) => tool.name)).toEqual(["get_self", "draft_message"]);
  });

  it("an extra field answers invalid_request and calls the port's refusal method only", async () => {
    for (const extra of [
      { label: ["own"] },
      { from: "owner@example.test" },
      { thread: "t-1" },
      { inReplyTo: "<a@example.test>" },
    ]) {
      const { reply, reads, work } = await ask(drafter(), call("draft_message", { ...ARGS, ...extra }));
      expect(reply).toEqual(toolError(1, "invalid_request"));
      expect(work.map((c) => c.method)).toEqual(["refusedWork"]);
      expect(reads).toEqual(["client"]);
    }
    // A subject beside replyTo, and an address with a display name, are refused the same way.
    for (const args of [
      { ...REPLY, subject: "Re: hi" },
      { ...ARGS, to: ["Rowan <rowan@example.test>"] },
    ]) {
      expect((await ask(drafter(), call("draft_message", args))).work.map((c) => c.method)).toEqual(["refusedWork"]);
    }
  });

  it("a call reaches draftMessage and no other port method", async () => {
    for (const args of [ARGS, REPLY]) {
      const { reply, reads, work } = await ask(drafter(), call("draft_message", args));
      expect(reply).toEqual(toolResult(1, { draft: DRAFT }));
      expect(work.map((c) => c.method)).toEqual(["draftMessage"]);
      expect(work[0]?.args).toEqual([TOKEN, args]);
      expect(reads).toEqual(["client"]);
    }
  });

  it("the result is one key, the draft's id", async () => {
    for (const value of [
      { draft: DRAFT, status: "held" },
      { draft: DRAFT, held: true },
      { draft: "not-a-draft-id" },
      {},
    ]) {
      expect((await ask(drafter(), call("draft_message", ARGS), { draftMessage: answering(value) })).reply).toEqual(
        rpcError(1, -32603, "unavailable"),
      );
    }
  });

  it("rate_limited from the port is the tool's rate_limited", async () => {
    const { reply } = await ask(drafter(), call("draft_message", ARGS), {
      draftMessage: async () => ({ ok: false, code: "rate_limited" }),
    });
    expect(reply).toEqual(toolError(1, "rate_limited"));
    for (const code of ["not_found", "invalid_request"] as const) {
      expect(
        (await ask(drafter(), call("draft_message", ARGS), { draftMessage: async () => ({ ok: false, code }) })).reply,
      ).toEqual(toolError(1, code));
    }
    // A work tool's rate_limited is still a failure.
    const client = clientView({ tools: ["claim_opportunity"], views: ["work"] });
    const claimed = await ask(client, call("claim_opportunity", { id: `opp_${ulid(1)}`, requestId: "request-0003" }), {
      claimOpportunity: async () => ({ ok: false, code: "rate_limited" }),
    });
    expect(claimed.reply).toEqual(rpcError(1, -32603, "unavailable"));
  });

  it("the description is a fixed string", async () => {
    const [first] = (await listed(drafter())).filter((tool) => tool.name === "draft_message");
    const [again] = (await listed(drafter({ name: "another-client" }))).filter((tool) => tool.name === "draft_message");
    expect(first?.description).toBeDefined();
    expect(again?.description).toBe(first?.description);
    expect(first?.description.length).toBeGreaterThan(40);
    for (const evidence of ["test-client", "another-client", "rowan", DRAFT])
      expect(first?.description).not.toContain(evidence);
    expect(first?.description).toContain("requestId");
  });

  it("no tool's name or description offers to send", async () => {
    const all = clientView({
      tools: [
        "get_self",
        "search",
        "get_entity",
        "get_timeline",
        "find_messages",
        "read_message",
        "find_facts",
        "build_context_pack",
        "record",
        ...PersonalWorkTool.options,
        ...PersonalRunTool.options,
        "draft_message",
      ],
      views: ["self", "people", "work"],
    });
    const tools = await listed(all);
    expect(tools.map((tool) => tool.name)).toContain("draft_message");
    for (const tool of tools) {
      expect(tool.name, tool.name).not.toMatch(/send/i);
      expect(tool.description, tool.name).not.toMatch(/\bsends?\b/i);
    }
  });
});
