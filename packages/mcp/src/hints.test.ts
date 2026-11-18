import {
  CLAIM_REFUSAL_FIELDS,
  CLAIM_REFUSAL_HINTS,
  ClaimRefusal,
  NOT_PERMITTED_OFFERED_HINT,
  PersonalToolError,
  PersonalWorkTool,
  PROGRAM_TOOLS,
  PROSE_FIELDS,
  REFUSAL_HINTS,
  REPORT_CHECK_HINTS,
  ReportCheckCode,
  TOOL_NAMES,
  ToolRefusalCode,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { hintFor } from "./handle.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";
import { offered } from "./tools.ts";

// Every code an agent's tool call can be refused with names its fix, so an agent is never left
// guessing how to proceed. A code added to PersonalToolError, ReportCheckCode or ClaimRefusal
// without a hint fails here.

// The tools a program calls, never an agent: their refusals carry no hint.
const AGENT_TOOLS = TOOL_NAMES.filter((name) => !PROGRAM_TOOLS.includes(name));

type Reply = {
  result?: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
};
const details = (reply: unknown): Record<string, unknown> =>
  JSON.parse((reply as Reply).result?.content[1]?.text ?? "{}") as Record<string, unknown>;

describe("every refusal names its fix", () => {
  it("every code but the two protocol errors is a tool refusal, and each has a hint for every agent tool", () => {
    expect(ToolRefusalCode.options).toEqual(
      PersonalToolError.options.filter((code) => code !== "unauthorized" && code !== "unavailable"),
    );
    expect(AGENT_TOOLS).toEqual(
      expect.arrayContaining([
        "list_opportunities",
        "claim_opportunity",
        "plan_move",
        "report_move",
        "record",
        "close_commitment",
        "find_facts",
      ]),
    );
    for (const tool of AGENT_TOOLS) {
      for (const code of ToolRefusalCode.options) {
        const hint = hintFor(tool, code);
        expect(typeof hint === "string" && hint.length > 20, `${tool} ${code}`).toBe(true);
      }
    }
    // A name that is no tool at all, as a stale tool list sends, is told to list the tools again;
    // an offered tool's refused call is not, since listing would not help.
    expect(hintFor("a_tool_since_removed", "not_permitted")).toContain("tools/list");
    expect(hintFor("plan_move", "not_permitted", false)).toContain("tools/list");
    expect(hintFor("plan_move", "not_permitted")).not.toContain("tools/list");
    expect(hintFor("build_context_pack", "not_permitted")).toBe(NOT_PERMITTED_OFFERED_HINT);
    // The protocol errors carry no hint: they are not tool results.
    for (const code of ["unauthorized", "unavailable"] as const) expect(hintFor("record", code)).toBeUndefined();
  });

  it("each work tool an agent calls has its own hints: what it takes, and where an id it takes comes from", () => {
    const own = (tool: PersonalWorkTool, code: "invalid_request" | "not_found"): string | undefined =>
      REFUSAL_HINTS[tool]?.[code];
    for (const tool of PersonalWorkTool.options) expect(own(tool, "invalid_request"), tool).toBeDefined();
    // Every one that takes an id or a ref.
    for (const tool of PersonalWorkTool.options.filter(
      (name) =>
        ![
          "list_opportunities",
          "start_outcome_test",
          "record_held_out_question",
          "get_health",
          "list_levers",
          "list_projects",
          "list_ideas",
          "get_work_time",
        ].includes(name),
    ))
      expect(own(tool, "not_found"), tool).toBeDefined();
    expect(REFUSAL_HINTS.plan_move?.not_permitted).toContain("investigate or prepare");
  });

  it("each report_move check code and each claim refusal has its own fixed hint", () => {
    for (const code of ReportCheckCode.options) expect(REPORT_CHECK_HINTS[code].length, code).toBeGreaterThan(20);
    for (const code of ClaimRefusal.options) expect(CLAIM_REFUSAL_HINTS[code].length, code).toBeGreaterThan(20);
    expect(REPORT_CHECK_HINTS.needs_writeback).toContain('{"kind":"agent_record","id":"rec_..."}');
    expect(REPORT_CHECK_HINTS.needs_writeback).toContain("record");
  });

  it("the agent API sends the hint with each code: a tool not offered, a port's not_found and unknown_role", async () => {
    const client = clientView({ tools: ["list_opportunities", "claim_opportunity", "hand_off"], views: ["work"] });
    const { provider } = fakeProvider(client);
    const { work } = fakeWork(client, {
      claimOpportunity: async () => ({ ok: false, code: "not_found" }),
      handOff: async () => ({ ok: false, code: "unknown_role" }),
    });
    const stale = await handle(
      { provider, work },
      fakeLog().log,
      TOKEN,
      call("plan_move", { opportunity: `opp_${ulid(1)}`, stage: "investigate", requestId: "request-0001" }),
    );
    expect((stale as Reply).result?.content[0]?.text).toBe("not_permitted");
    expect(details(stale).hint).toContain("tools/list");
    const claimed = await handle(
      { provider, work },
      fakeLog().log,
      TOKEN,
      call("claim_opportunity", { id: `opp_${ulid(1)}`, requestId: "request-0001" }),
    );
    expect(details(claimed).hint).toContain("list_opportunities with scope open");
    const handed = await handle(
      { provider, work },
      fakeLog().log,
      TOKEN,
      call("hand_off", { id: `opp_${ulid(1)}`, role: "research", reason: "other_role", requestId: "request-0001" }),
    );
    expect((handed as Reply).result?.content[0]?.text).toBe("unknown_role");
    expect(details(handed).hint).toContain("roles.all");
  });

  it("a refused report carries each code's hint beside it", async () => {
    const client = clientView({ tools: ["report_move"], views: ["work"] });
    const move = `mov_${ulid(1)}`;
    const { work } = fakeWork(client, {
      reportMove: async () => ({ ok: true, value: { move, refused: ["needs_sources", "needs_writeback"] } }) as never,
    });
    const reply = (await handle(
      { provider: fakeProvider(client).provider, work },
      fakeLog().log,
      TOKEN,
      call("report_move", { move, outcome: "done", requestId: "request-0001" }),
    )) as Reply;
    expect(reply.result?.structuredContent).toEqual({
      move,
      refused: ["needs_sources", "needs_writeback"],
      hints: { needs_sources: REPORT_CHECK_HINTS.needs_sources, needs_writeback: REPORT_CHECK_HINTS.needs_writeback },
    });
  });
});

// What the fixed text says of a schema, held to the schema: nothing else connects them.
describe("the hints and descriptions agree with the schemas they name", () => {
  const client = clientView({ tools: [...TOOL_NAMES], views: ["self", "people", "work"] });
  type Field = { maximum?: number; maxLength?: number };
  const served = offered(client).map((tool) => ({
    name: tool.name,
    description: tool.description,
    properties: ((tool.inputSchema as { properties?: Record<string, Field> }).properties ?? {}) as Record<
      string,
      Field
    >,
  }));
  // "limit (1 to 50)", "limit, 1 to 50", "limit 1 to 50", "text (1 to 200 characters)".
  const LIMIT = /\b([a-zA-Z]+)(?: \(|, | )1 to (\d[\d ]*\d|\d)\b/g;
  const named = (text: string | undefined): [string, number][] =>
    [...(text ?? "").matchAll(LIMIT)].map((match) => [match[1] ?? "", Number((match[2] ?? "").replaceAll(" ", ""))]);
  // find_paths' description says 1 to 3 while its schema takes 4: its words are the owner's to rule on.
  const KNOWN: readonly string[] = ["find_paths maxHops"];

  it("a limit a hint or a description names is the schema's", () => {
    let checked = 0;
    for (const { name, description, properties } of served) {
      for (const [field, most] of [...named(REFUSAL_HINTS[name]?.invalid_request), ...named(description)]) {
        const property = properties[field];
        if (property === undefined || KNOWN.includes(`${name} ${field}`)) continue;
        const schemaMost = property.maximum ?? property.maxLength;
        if (schemaMost === undefined) continue;
        checked += 1;
        expect(most, `${name} ${field}`).toBe(schemaMost);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("a field a claim refusal names is the tool's", () => {
    for (const [tool, codes] of Object.entries(CLAIM_REFUSAL_FIELDS)) {
      const properties = served.find((one) => one.name === tool)?.properties ?? {};
      for (const [code, { field }] of Object.entries(codes ?? {})) {
        for (const path of field.split(", ")) {
          expect(Object.keys(properties), `${tool} ${code} ${path}`).toContain(path.split(".")[0]);
        }
      }
    }
  });

  it("the hint on ids in prose names every prose field", () => {
    for (const field of PROSE_FIELDS) expect(CLAIM_REFUSAL_HINTS.ids_in_prose, field).toContain(field);
  });
});
