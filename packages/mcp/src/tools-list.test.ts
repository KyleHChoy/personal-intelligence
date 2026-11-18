import {
  AGENT_GUIDE,
  AGENT_HOW_TO_WORK,
  CLAIM_REFUSAL_HINTS,
  idsInProse,
  NOT_PERMITTED_OFFERED_HINT,
  PersonalWorkArgs,
  PROSE_FIELDS,
  ProposeAboutYouArgs,
  REFUSAL_CODE_HINTS,
  TASK_KINDS,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  request,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";

// What tools/list publishes, ids in prose fields, the guide and propose_task's kinds, at the
// agent API.

type Listed = { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } };
const OPPORTUNITY = `opp_${ulid(40)}`;
const ENTITY = `ent_${ulid(41)}`;

async function list(tools: string[]): Promise<Listed[]> {
  const client = clientView({ tools, views: ["self", "people", "work"] });
  const reply = (await handle(
    { provider: fakeProvider(client).provider, work: fakeWork(client).work },
    fakeLog().log,
    TOKEN,
    request("tools/list"),
  )) as { result: { tools: Listed[] } };
  return reply.result.tools;
}
const keysOf = (schema: unknown): string[] => {
  if (Array.isArray(schema)) return schema.flatMap(keysOf);
  if (schema === null || typeof schema !== "object") return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(key === "properties" && value !== null && typeof value === "object" ? Object.keys(value) : []),
    ...keysOf(value),
  ]);
};

describe("what tools/list publishes", () => {
  it("propose_about_you publishes the statement call alone; its deprecated keys still parse", async () => {
    const tool = (await list(["propose_about_you", "record"])).find((one) => one.name === "propose_about_you");
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "cites",
      "quote",
      "requestId",
      "statement",
    ]);
    for (const key of ["kind", "fields", "scope", "interpretation", "quotes"])
      expect(keysOf(tool?.inputSchema), key).not.toContain(key);
    expect(tool?.description).not.toContain("kind is a hint");
    const old = {
      kind: "preference",
      fields: { domain: "career", object: "morning meetings", polarity: "prefers" },
      scope: "all",
      requestId: "about-0195-0001",
    };
    expect(ProposeAboutYouArgs.safeParse(old).success).toBe(true);
  });

  it("answer_owner_question publishes the owner's quote and its effect, never kinds or fields, and names no goal", async () => {
    const tool = (await list(["answer_owner_question", "record", "report_move"])).find(
      (one) => one.name === "answer_owner_question",
    );
    expect(keysOf(tool?.inputSchema)).not.toContain("facts");
    expect(keysOf(tool?.inputSchema)).toEqual(
      expect.arrayContaining(["opportunity", "answer", "quote", "about", "requestId"]),
    );
    expect(tool?.description).not.toMatch(/\bgoal\b/);
    expect(tool?.description).not.toContain("facts");
  });

  it("an answer that still sends facts reaches the store without them: the system types the owner's words", async () => {
    const client = clientView({ tools: ["answer_owner_question", "record", "report_move"], views: ["self", "work"] });
    const { provider, calls } = fakeProvider(client, {
      answerOwnerQuestion: async () => ({ ok: true, value: { recordId: `rec_${ulid(9)}` as never } }),
    });
    const quote = "I want to visit the lab in April.";
    const facts = [{ kind: "goal", fields: { domain: "career", objective: "visit the lab in April" } }];
    await handle(
      { provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      call("answer_owner_question", {
        opportunity: OPPORTUNITY,
        answer: { quote, facts, about: "supports" },
        requestId: "answer-0195-0001",
      }),
    );
    expect(calls.find((one) => one.method === "answerOwnerQuestion")?.args[1]).toEqual({
      opportunity: OPPORTUNITY,
      answer: { quote, about: "supports" },
      requestId: "answer-0195-0001",
    });
  });
});

describe("ids in every prose field a person reads", () => {
  it("covers a proposal's details, a report's reason and draft, propose_person's basis and an answer's quote", () => {
    for (const field of ["whyNow", "plan", "decisionNeeded", "risks", "reason", "draft", "basis", "quote"]) {
      expect(PROSE_FIELDS, field).toContain(field);
      expect(idsInProse({ outer: { [field]: `Met ${ENTITY} last week` } }), field).toBe(true);
    }
    // A basis of refs is not prose: an id in a ref is taken.
    expect(idsInProse({ basis: [{ kind: "entity", id: ENTITY }], summary: "Meet the clinic director" })).toBe(false);
    for (const field of ["whyNow", "plan", "decisionNeeded", "risks", "reason", "draft", "basis", "quote"])
      expect(CLAIM_REFUSAL_HINTS.ids_in_prose, field).toContain(field);
  });

  it("a proposal whose details hold an id is refused ids_in_prose, and nothing is proposed", async () => {
    const client = clientView({ tools: ["propose_task"], views: ["self", "work"] });
    const { work, calls } = fakeWork(client);
    const args = {
      kind: "investigate",
      about: { kind: "entity", id: ENTITY },
      summary: "Find the clinic director and her start date",
      basis: [{ kind: "entity", id: ENTITY }],
      details: { whyNow: `${ENTITY} wrote on Monday` },
      requestId: "task-0195-0001",
    };
    const reply = (await handle(
      { provider: fakeProvider(client).provider, work },
      fakeLog().log,
      TOKEN,
      call("propose_task", args),
    )) as { result: { content: { text: string }[] } };
    expect(JSON.parse(reply.result.content[1]?.text ?? "{}")).toMatchObject({ refusal: "ids_in_prose" });
    expect(calls.map((one) => one.method)).toEqual(["refusedWork"]);
  });
});

describe("the guide", () => {
  it("stays within its 2 500 code points", () => {
    expect([...AGENT_GUIDE].length).toBeLessThanOrEqual(2500);
  });

  it("asks for plan_move before an owner question's answer", () => {
    const line = AGENT_HOW_TO_WORK.split("\n").find((one) => one.includes("owner_question")) ?? "";
    expect(line.indexOf("plan_move")).toBeGreaterThan(-1);
    expect(line.indexOf("plan_move")).toBeLessThan(line.indexOf("answer_owner_question"));
  });

  it("not_permitted: a listed tool's refusal is not repeated, one not listed means listing the tools again, as the hints say", () => {
    expect(AGENT_GUIDE).toContain(
      "not_permitted from a tool you were listed: go on; from one not listed: list the tools again.",
    );
    expect(NOT_PERMITTED_OFFERED_HINT).toContain("Do not repeat it");
    expect(REFUSAL_CODE_HINTS.not_permitted).toContain("Call tools/list again");
  });
});

describe("propose_task's kinds", () => {
  it("publishes and takes only the kinds a task may be, never introduction or owner_question", async () => {
    const tool = (await list(["propose_task"])).find((one) => one.name === "propose_task");
    const kind = (tool?.inputSchema.properties?.kind ?? {}) as { enum?: string[] };
    expect(kind.enum).toEqual(TASK_KINDS.filter((one) => one !== "research"));
    for (const one of ["introduction", "owner_question"]) {
      expect(kind.enum, one).not.toContain(one);
      expect(PersonalWorkArgs.propose_task.shape.kind.safeParse(one).success, one).toBe(false);
    }
  });
});
