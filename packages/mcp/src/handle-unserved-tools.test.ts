import { PersonalToolArgs } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { handle } from "./handle.ts";
import type { Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  NO_WORK,
  request,
  rpcError,
  TOKEN,
  toolError,
  ulid,
} from "./test-support/fakes.ts";

// Two read tools wired straight to one port method each. get_decision_history is the agent API's
// one placeholder: it has an entry in the tool table and a stub port on the store's side, and the
// admin registers no client with it (admin-clients.ts, UNBUILT_READ_TOOLS), so it counts as
// designed, not served. get_suggestions is served; its port wiring is the same, so it is tested
// here beside the placeholder. The other served tools are tested in the handle-*.test.ts files.

const ENTITY = `ent_${ulid(1)}`;
const TOOLS: { name: string; method: keyof Provider; args: unknown }[] = [
  { name: "get_decision_history", method: "getDecisionHistory", args: {} },
  { name: "get_suggestions", method: "getSuggestions", args: {} },
];
const HOLDER = clientView({ tools: TOOLS.map((tool) => tool.name), views: ["self", "people", "work"] });

describe("the placeholder read and get_suggestions at the agent API", () => {
  it("each calls its one port method, and the stub's unavailable is sent as unavailable", async () => {
    for (const tool of TOOLS) {
      const { provider, calls } = fakeProvider(HOLDER, {
        [tool.method]: async () => ({ ok: false, code: "unavailable" }),
      });
      expect(
        await handle({ provider, work: NO_WORK }, fakeLog().log, TOKEN, call(tool.name, tool.args)),
        tool.name,
      ).toEqual(rpcError(1, -32603, "unavailable"));
      expect(
        calls.map((made) => made.method),
        tool.name,
      ).toEqual(["client", tool.method]);
    }
  });

  it("tools/list offers them to a client that holds them, with their schemas", async () => {
    const { provider } = fakeProvider(HOLDER);
    const answer = (await handle({ provider, work: NO_WORK }, fakeLog().log, TOKEN, request("tools/list"))) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    const listed = new Map(answer.result.tools.map((tool) => [tool.name, tool.inputSchema]));
    expect([...listed.keys()].sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(listed.get("get_suggestions")).toEqual(
      PersonalToolArgs.get_suggestions.toJSONSchema({ io: "input", reused: "ref" }),
    );
  });

  it("arguments a stub's schema refuses are recorded as refused, and no read is made", async () => {
    const { provider, calls } = fakeProvider(HOLDER);
    expect(
      await handle(
        { provider, work: NO_WORK },
        fakeLog().log,
        TOKEN,
        call("get_decision_history", { project: ENTITY }),
      ),
    ).toEqual(toolError(1, "invalid_request"));
    expect(calls.map((made) => made.method)).toEqual(["client", "refused"]);
  });
});
