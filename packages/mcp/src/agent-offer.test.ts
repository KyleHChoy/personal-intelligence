import {
  AGENT_GUIDE,
  AGENT_GUIDE_MOST,
  CLAIM_REFUSAL_HINTS,
  FACT_ROUTES,
  PROGRAM_TOOLS,
  REPORT_CHECK_HINTS,
  TOOL_NAMES,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { exampleFor } from "./examples.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  proseOf,
  request,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";

// What agents are offered and told at the agent API: tool lists, the guide, propose_about_you's
// shape and ids in prose.

type Listed = { name: string; description: string; inputSchema: unknown };
const AGENT_TOOLS = TOOL_NAMES.filter((name) => !PROGRAM_TOOLS.includes(name));
const MOVE = `mov_${ulid(70)}`;
const ENTITY = `ent_${ulid(71)}`;

async function list(tools: string[], params?: unknown): Promise<Listed[]> {
  const client = clientView({ tools, views: ["self", "people", "work"] });
  const reply = (await handle(
    { provider: fakeProvider(client).provider, work: fakeWork(client).work },
    fakeLog().log,
    TOKEN,
    request("tools/list", params),
  )) as { result: { tools: Listed[] } };
  return reply.result.tools;
}

describe("what an agent is offered", () => {
  it("every description of every tool says what it does in at most 600 characters, its examples after them", async () => {
    for (const tool of await list([...TOOL_NAMES], { programs: true })) {
      expect(proseOf(tool.description).length, tool.name).toBeLessThanOrEqual(600);
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(1500);
    }
  });

  it("an agent that works the board is not listed a program's tools, unless it asks; it can still call one it holds", async () => {
    const names = (await list([...TOOL_NAMES])).map((tool) => tool.name);
    for (const program of PROGRAM_TOOLS) expect(names, program).not.toContain(program);
    expect(names).toEqual(AGENT_TOOLS);
    expect((await list([...TOOL_NAMES], { programs: true })).map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const client = clientView({ tools: ["list_opportunities", "sync_memory"], views: ["self", "work"] });
    const { provider, calls } = fakeProvider(client, { syncMemory: async () => ({ ok: false, code: "unavailable" }) });
    await handle(
      { provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      call("sync_memory", { have: [], canDelete: true }),
    );
    expect(calls.map((one) => one.method)).toContain("syncMemory");
  });

  it("a client that holds no work tool, such as a mirror, is listed its program tool as before", async () => {
    expect((await list(["sync_mirror"])).map((tool) => tool.name)).toEqual(["sync_mirror"]);
  });

  it("shared shapes are $defs references within a schema: report_move's is under a tenth of what it was", async () => {
    const [report] = await list(["report_move"]);
    expect(JSON.stringify(report?.inputSchema)).toContain('"$defs"');
    // With a progress report's three fields.
    expect(JSON.stringify(report).length).toBeLessThan(11_000);
  });
});

describe("the guide", () => {
  it("is within its most code points, with the lifecycle, where each fact goes, the rule on ids and the refusal codes", () => {
    expect([...AGENT_GUIDE].length).toBeLessThanOrEqual(AGENT_GUIDE_MOST);
    for (const part of [
      "How to work:",
      "Where each fact goes:",
      "ids only in refs and cites",
      "not_found",
      "not_permitted",
      "unavailable",
      "rate_limited",
      "closes failed when your lease ends",
    ])
      expect(AGENT_GUIDE).toContain(part);
    // Each route names tools that exist.
    for (const route of FACT_ROUTES)
      for (const [word] of route.tool.matchAll(/[a-z]+_[a-z_]+|\brecord\b/g)) expect(TOOL_NAMES, word).toContain(word);
    // The owner's lessons are guidance on how to work, never a request to act.
    expect(AGENT_GUIDE).toContain("never a request to contact anyone, send or change an account");
    // Nothing to write is failed, never a proposal to close a task.
    expect(AGENT_GUIDE).not.toMatch(/write-back[^.]*propose_about_you/);
    expect(REPORT_CHECK_HINTS.needs_writeback).not.toContain("propose_about_you");
    expect(REPORT_CHECK_HINTS.needs_writeback).not.toContain("propose_person");
    expect(REPORT_CHECK_HINTS.needs_writeback).toContain("report failed");
  });
});

describe("propose_about_you at the agent API", () => {
  const client = clientView({ tools: ["propose_about_you"], views: ["self"] });

  it("a call in the old shape reaches the store as a statement call: its kind a hint, its fields never passed on", async () => {
    const { provider, calls } = fakeProvider(client, {
      proposeAboutYou: async () => ({ ok: true, value: { recordId: `rec_${ulid(8)}` as never } }),
    });
    const args = {
      kind: "preference",
      fields: { domain: "career", object: "morning meetings", polarity: "prefers" },
      scope: "all",
      requestId: "about-old-0001",
    };
    await handle({ provider, work: fakeWork(client).work }, fakeLog().log, TOKEN, call("propose_about_you", args));
    const sent = calls.find((one) => one.method === "proposeAboutYou")?.args[1];
    expect(sent).toEqual({
      statement: "The owner prefers morning meetings (career)",
      kind: "preference",
      requestId: "about-old-0001",
    });
  });

  it("a goal of the owner's is refused goal_proposed_elsewhere, and nothing is written", async () => {
    const { provider, calls } = fakeProvider(client);
    const reply = (await handle(
      { provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      call("propose_about_you", {
        statement: "The owner wants to run a marathon",
        kind: "goal",
        requestId: "about-goal-0001",
      }),
    )) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(reply.result.content[1]?.text ?? "{}")).toEqual({
      refusal: "goal_proposed_elsewhere",
      field: "statement",
      hint: `${CLAIM_REFUSAL_HINTS.goal_proposed_elsewhere} ${exampleFor("propose_about_you", {})}`,
    });
    expect(calls.map((one) => one.method)).not.toContain("proposeAboutYou");
  });
});

describe("ids in prose a person reads", () => {
  const agent = clientView({ tools: ["report_move", "record", "post_agent_message"], views: ["self", "work"] });

  it("a report whose deliverable holds an id is refused ids_in_prose with the field, its hint and an example, and nothing is reported", async () => {
    const { work, calls } = fakeWork(agent);
    const reply = (await handle(
      { provider: fakeProvider(agent).provider, work },
      fakeLog().log,
      TOKEN,
      call("report_move", {
        move: MOVE,
        outcome: "done",
        report: { deliverable: `Spoke with ${ENTITY} about the lease.`, next: "Wait." },
        requestId: "report-ids-0001",
      }),
    )) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(reply.result.content[0]?.text).toBe("invalid_request");
    expect(JSON.parse(reply.result.content[1]?.text ?? "{}")).toEqual({
      refusal: "ids_in_prose",
      field: "report.deliverable",
      hint: expect.stringContaining(CLAIM_REFUSAL_HINTS.ids_in_prose),
    });
    expect(JSON.stringify(reply)).not.toContain(ENTITY);
    expect(calls.map((one) => one.method)).toEqual(["refusedWork"]);
  });

  it("an id in a ref is taken, and a handoff note and agent mail may carry ids", async () => {
    const { provider, calls } = fakeProvider(agent, {
      record: async () => ({ ok: true, value: { recordId: `rec_${ulid(5)}` as never } }),
    });
    await handle(
      { provider, work: fakeWork(agent).work },
      fakeLog().log,
      TOKEN,
      call("record", { kind: "handoff", body: `Continue the task on ${ENTITY}.`, requestId: "handoff-ids-0001" }),
    );
    expect(calls.map((one) => one.method)).toContain("record");
    const finding = (await handle(
      { provider, work: fakeWork(agent).work },
      fakeLog().log,
      TOKEN,
      call("record", {
        kind: "finding",
        body: `The owner met ${ENTITY} on 2026-10-20.`,
        requestId: "finding-ids-0001",
      }),
    )) as { result: { content: { text: string }[] } };
    expect(JSON.parse(finding.result.content[1]?.text ?? "{}")).toMatchObject({ refusal: "ids_in_prose" });
  });

  // An agent learns the rule from the description, before a refusal teaches it by trial.
  it("record, report_move and propose_about_you say in their descriptions that prose takes names, never ids", async () => {
    const tools = await list(["record", "report_move", "propose_about_you"]);
    const described = (name: string): string => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(described("record")).toContain("no pronouns, no ids");
    expect(described("report_move")).toContain("Names, never ids.");
    expect(described("propose_about_you")).toContain("Names, never ids: ids go in cites.");
  });

  it("a propose tool's refusal carries its example call", async () => {
    const client = clientView({ tools: ["propose_about_you"], views: ["self"] });
    const reply = (await handle(
      { provider: fakeProvider(client).provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      call("propose_about_you", { statement: `The owner works with ${ENTITY}`, requestId: "about-ids-0001" }),
    )) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(reply.result.content[1]?.text ?? "{}")).toEqual({
      refusal: "ids_in_prose",
      field: "statement",
      hint: `${CLAIM_REFUSAL_HINTS.ids_in_prose} ${exampleFor("propose_about_you", {})}`,
    });
  });
});

it("does not offer the outcome-test program tools on the agent board", async () => {
  const names = (await list(["start_outcome_test", "record_held_out_question", "record_outcome_task"])).map(
    (tool) => tool.name,
  );
  for (const tool of ["start_outcome_test", "record_held_out_question", "record_outcome_task"])
    expect(names).not.toContain(tool);
});

it("describes the accepted fact kinds, path bound and compact forms", async () => {
  const tools = await list(["find_paths", "find_facts", "get_changes", "get_evidence_span", "get_suggestions"]);
  expect(tools.find((tool) => tool.name === "find_paths")?.description).toContain("maxHops 1 to 4");
  expect(tools.find((tool) => tool.name === "find_facts")?.description).toContain("capture or activity");
  for (const name of ["get_changes", "get_evidence_span", "get_suggestions"]) {
    const description = tools.find((tool) => tool.name === name)?.description;
    expect(description, name).toContain("Null, false and empty fields are left out");
    expect(description?.length, name).toBeLessThanOrEqual(600);
  }
});
