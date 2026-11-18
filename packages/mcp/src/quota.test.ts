import { CLAIM_REFUSAL_HINTS, methodOf, PersonalReadTool } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { handle } from "./handle.ts";
import type { Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  NO_WORK,
  rpcError,
  TOKEN,
  toolError,
  ulid,
} from "./test-support/fakes.ts";

// A read past one of the client's budgets. The answer is the agent's to act on: a tool result with
// isError, carrying the code and no number.

const ALL = clientView({ tools: [...PersonalReadTool.options], views: ["self", "people", "work"] });
const ENTITY = `ent_${ulid(1)}`;
const MESSAGE = `msg_${ulid(1)}`;
const DOCUMENT = `doc_${ulid(1)}`;

// One valid call of each read tool the reader serves: its arguments, when it needs any.
const ARGS: { readonly [T in PersonalReadTool]?: unknown } = {
  search: { query: "ada" },
  get_entity: { id: ENTITY },
  get_timeline: { id: ENTITY },
  read_message: { id: MESSAGE },
  build_context_pack: { purpose: "agent_bootstrap" },
  sync_memory: { have: [], canDelete: false },
  get_document: { id: DOCUMENT },
  get_evidence_span: { fact: "a".repeat(64) },
  read_item: { message: MESSAGE },
  find_paths: { target: ENTITY },
  fetch_template: { document: DOCUMENT },
  sync_mirror: { templates: ["lens_mirror@1"], cursor: null },
  context: { task: "prepare the review" },
  about: { subject: { name: "Ada Example" } },
  read_record: { record: `rec_${"1".repeat(26)}` },
};
const READS = PersonalReadTool.options.map((name) => ({
  name,
  method: methodOf(name) as keyof Provider,
  args: ARGS[name] ?? {},
}));

// The reply deadline on a clock that a sleep moves, so no test waits in real time.
const instant = () => {
  let now = 0;
  // A few turns of the event loop first, so the fake port's answer settles before time moves.
  const sleep = async (ms: number): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    now += ms;
  };
  return { clock: () => now, sleep };
};

describe("read quotas at the agent API", () => {
  it("rate_limited from any read is a tool result with isError", async () => {
    for (const read of READS) {
      const { provider, calls } = fakeProvider(ALL, {
        [read.method]: async () => ({ ok: false, code: "rate_limited" }),
      });
      const { log, events } = fakeLog();
      expect(
        await handle({ provider, work: NO_WORK }, log, TOKEN, call(read.name, read.args), instant()),
        read.name,
      ).toEqual(toolError(1, "rate_limited"));
      // One read asked, and the call logged with its code and nothing of the budget.
      expect(
        calls.map((made) => made.method),
        read.name,
      ).toEqual(["client", read.method]);
      expect(
        events.map((event) => event.code),
        read.name,
      ).toEqual(["rate_limited"]);
    }
  });

  it("a read's rate_limited names the window spent and that window's fixed hint, and no number", async () => {
    const hints = {
      rate_limited_minute: "wait a minute and retry the same call",
      // A rolling window: it says when the budget comes back, never "tomorrow".
      rate_limited_day:
        "your read budget for the last 24 hours is spent, and it comes back as your reads pass 24 hours old: stop reading and go on with other work, or ask the owner to raise it",
    } as const;
    for (const refusal of ["rate_limited_minute", "rate_limited_day"] as const) {
      const read = READS[0];
      if (read === undefined) throw new Error("no read");
      const { provider } = fakeProvider(ALL, {
        [read.method]: async () => ({ ok: false, code: "rate_limited", refusal }),
      });
      const { log, events } = fakeLog();
      const reply = await handle({ provider, work: NO_WORK }, log, TOKEN, call(read.name, read.args), instant());
      expect(CLAIM_REFUSAL_HINTS[refusal]).toBe(hints[refusal]);
      const sent = JSON.parse(JSON.stringify(reply)) as { result: { isError: boolean; content: { text: string }[] } };
      expect(sent.result.isError).toBe(true);
      expect(sent.result.content[0]?.text).toBe("rate_limited");
      expect(JSON.parse(sent.result.content[1]?.text ?? "{}")).toEqual({ refusal, hint: hints[refusal] });
      expect(sent.result.content).toHaveLength(2);
      expect(events.map((event) => event.code)).toEqual(["rate_limited"]);
    }
  });

  it("list_projects' and get_project's rate_limited names its window, as a read's does", async () => {
    const projects = clientView({ tools: ["list_projects", "get_project", "claim_opportunity"], views: ["work"] });
    const asked = [
      { name: "list_projects", method: "listProjects", args: {} },
      { name: "get_project", method: "getProject", args: { project: `ent_${ulid(2)}` } },
    ] as const;
    for (const one of asked)
      for (const refusal of ["rate_limited_minute", "rate_limited_day"] as const) {
        const { work } = fakeWork(projects, {
          [one.method]: async () => ({ ok: false, code: "rate_limited", refusal }),
        });
        const { provider } = fakeProvider(projects);
        const reply = await handle({ provider, work }, fakeLog().log, TOKEN, call(one.name, one.args), instant());
        const sent = JSON.parse(JSON.stringify(reply)) as { result: { isError: boolean; content: { text: string }[] } };
        expect(sent.result?.isError, one.name).toBe(true);
        expect(sent.result.content[0]?.text).toBe("rate_limited");
        expect(JSON.parse(sent.result.content[1]?.text ?? "{}")).toEqual({
          refusal,
          hint: CLAIM_REFUSAL_HINTS[refusal],
        });
      }
    const { work } = fakeWork(projects, { claimOpportunity: async () => ({ ok: false, code: "rate_limited" }) });
    const claimed = await handle(
      { provider: fakeProvider(projects).provider, work },
      fakeLog().log,
      TOKEN,
      call("claim_opportunity", { id: `opp_${ulid(1)}`, requestId: "request-0003" }),
      instant(),
    );
    expect(claimed).toEqual(rpcError(1, -32603, "unavailable"));
  });

  it("a refusal answered rate_limited is still not believed", async () => {
    // The tool is not the client's: the provider records the refusal, and its answer must be a
    // refusal's own code.
    const narrow = clientView({ tools: ["get_self"], views: ["self"] });
    const { provider } = fakeProvider(narrow, { refused: async () => ({ ok: false, code: "rate_limited" }) });
    expect(
      await handle({ provider, work: NO_WORK }, fakeLog().log, TOKEN, call("read_message", { id: MESSAGE }), instant()),
    ).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "unavailable" } });
    // The control: a refusal answered not_permitted is sent.
    const control = fakeProvider(narrow);
    expect(
      await handle(
        { provider: control.provider, work: NO_WORK },
        fakeLog().log,
        TOKEN,
        call("read_message", { id: MESSAGE }),
        instant(),
      ),
    ).toEqual(toolError(1, "not_permitted"));
  });
});
