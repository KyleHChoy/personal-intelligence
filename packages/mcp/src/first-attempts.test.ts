import { TOOL_NAMES } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
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

// The calls an agent makes from a tool's description alone, or from its name before it has read the
// schema, as agent harnesses that load a schema on demand do. Each either reaches the tool's one port
// call, or is refused naming the field and what to send, and never with a value it sent.

const VIEWS = ["self", "people", "work"];
const MSG = `msg_${ulid(1)}`;
const MSG2 = `msg_${ulid(2)}`;
const ENT = `ent_${ulid(3)}`;
const ENT2 = `ent_${ulid(4)}`;
const OPP = `opp_${ulid(5)}`;
const MOV = `mov_${ulid(6)}`;
const HYP = `hyp_${ulid(7)}`;
const REC = `rec_${ulid(8)}`;
const DOC = `doc_${ulid(9)}`;
const FACT = "a".repeat(64);
const RID = "first-attempt-0001";
const SUMMARY = "Find the clinic director and her start date";
const FINDING = { kind: "agent_record", id: REC };

// The port method each tool's one call reaches.
const METHOD: Readonly<Record<string, string>> = {
  propose_opportunity: "proposeOpportunity",
  propose_person: "proposePerson",
  propose_hypothesis: "proposeHypothesis",
  propose_task: "proposeTask",
  get_evidence_span: "getEvidenceSpan",
  report_move: "reportMove",
  propose_about_you: "proposeAboutYou",
  close_commitment: "closeCommitment",
  read_item: "readItem",
  find_facts: "findFacts",
  hand_off: "handOff",
  record_test: "recordTest",
  set_intention: "setIntention",
  answer_owner_question: "answerOwnerQuestion",
  fetch_template: "fetchTemplate",
  claim_opportunity: "claimOpportunity",
  release_opportunity: "releaseOpportunity",
  plan_move: "planMove",
  record: "record",
  get_entity: "getEntity",
  get_timeline: "getTimeline",
  find_paths: "findPaths",
};

type Reply = { result: { isError?: boolean; content: { text: string }[]; tools?: Listed[] } };
type Listed = { name: string; description: string; inputSchema: unknown };
type Details = { field?: string; refusal?: string; arguments?: { name: string; rule: string }[]; hint?: string };

// One call, the port answering not_found: what matters here is whether it got that far.
async function attempt(
  tool: string,
  args: unknown,
  answer: { ok: false; code: string } = { ok: false, code: "not_found" },
): Promise<{ reply: Reply; details: Details; sent: unknown[] | undefined; reached: boolean }> {
  const client = clientView({ tools: [tool], views: VIEWS });
  const method = METHOD[tool] ?? "";
  const over = { [method]: async () => answer };
  const provider = fakeProvider(client, over);
  const work = fakeWork(client, over);
  const reply = (await handle(
    { provider: provider.provider, work: work.work },
    fakeLog().log,
    TOKEN,
    call(tool, args),
  )) as Reply;
  const found = [...provider.calls, ...work.calls].find((one) => one.method === method);
  const details = JSON.parse(reply.result.content[1]?.text ?? "{}") as Details;
  return { reply, details, sent: found?.args, reached: found !== undefined };
}

// [tool, what the call is, its arguments]
const PASS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  [
    "propose_opportunity",
    "refs as bare ids",
    { kind: "introduction", about: ENT, summary: SUMMARY, basis: [MSG, ENT2], requestId: RID },
  ],
  [
    "propose_opportunity",
    "about the owner in a word, the owner's request",
    {
      kind: "life_admin",
      about: "owner",
      summary: SUMMARY,
      basis: [{ kind: "owner_request", quote: "can you sort this out" }],
      requestId: RID,
    },
  ],
  [
    "propose_opportunity",
    "a person's ref of kind person",
    {
      kind: "introduction",
      about: { kind: "person", id: ENT },
      summary: SUMMARY,
      basis: [{ kind: "person", id: ENT }],
      requestId: RID,
    },
  ],
  [
    "propose_task",
    "refs as bare ids",
    { kind: "investigate", about: ENT, summary: SUMMARY, basis: [MSG], requestId: RID },
  ],
  [
    "propose_task",
    "about the owner in a word",
    { kind: "investigate", about: "owner", summary: SUMMARY, basis: [MSG], requestId: RID },
  ],
  [
    "propose_hypothesis",
    "refs as bare ids",
    { kind: "preference", about: "owner", summary: SUMMARY, basis: [MSG], requestId: RID },
  ],
  ["record_test", "id for hypothesis, bare refs", { id: HYP, result: "supports", basis: [MSG], requestId: RID }],
  [
    "propose_person",
    "the fields at the top level, kind left out",
    { name: "Dana Reyes", known_how: "met at the clinic fundraiser", basis: "The owner named her", requestId: RID },
  ],
  [
    "propose_person",
    "a relationship's fields at the top level",
    {
      person: ENT,
      relation: "mentor",
      closeness: "active",
      basis: "She wrote that she advises the owner",
      requestId: RID,
    },
  ],
  [
    "propose_person",
    "a link's fields at the top level, its kind the link's",
    { from: ENT, kind: "works_with", to: ENT2, inferred: false, basis: "The staff page lists both", requestId: RID },
  ],
  [
    "propose_person",
    "a basis of a few sentences",
    {
      kind: "person",
      fields: { name: "Dana Reyes", known_how: "met at the clinic fundraiser" },
      basis: "The owner named her in a long note. ".repeat(14),
      requestId: RID,
    },
  ],
  [
    "propose_about_you",
    "a statement with the older fields beside it",
    { statement: "The owner prefers meetings before 10am", kind: "preference", fields: { x: 1 }, requestId: RID },
  ],
  [
    "propose_about_you",
    "cites as refs",
    { statement: "The owner prefers meetings before 10am", cites: [{ kind: "message", id: MSG }], requestId: RID },
  ],
  [
    "record",
    "cites as refs",
    {
      kind: "note",
      body: "Ana Silva opens the clinic in May 2027.",
      cites: [{ kind: "message", id: MSG }],
      requestId: RID,
    },
  ],
  [
    "report_move",
    "the report's fields at the top level",
    {
      move: MOV,
      outcome: "done",
      deliverable: "Ana Silva directs it",
      next: "The owner decides",
      sources: [FINDING],
      requestId: RID,
    },
  ],
  [
    "report_move",
    "id for move",
    { id: MOV, outcome: "failed", report: { reason: "Nothing new was found" }, requestId: RID },
  ],
  [
    "report_move",
    "move_id for move",
    { move_id: MOV, outcome: "blocked", reason: "The clinic's site is down", requestId: RID },
  ],
  [
    "report_move",
    "completed for done",
    {
      move: MOV,
      outcome: "completed",
      report: { deliverable: "Ana Silva directs it", next: "The owner decides", sources: [FINDING] },
      requestId: RID,
    },
  ],
  [
    "report_move",
    "a finding as a bare id",
    {
      move: MOV,
      outcome: "done",
      report: { deliverable: "Ana Silva directs it", next: "The owner decides", sources: [REC] },
      requestId: RID,
    },
  ],
  [
    "report_move",
    "a finding's ref of kind finding",
    {
      move: MOV,
      outcome: "done",
      report: {
        deliverable: "Ana Silva directs it",
        next: "The owner decides",
        sources: [{ kind: "finding", id: REC }],
      },
      requestId: RID,
    },
  ],
  [
    "report_move",
    "a page as a source stays a text",
    {
      move: MOV,
      outcome: "done",
      report: { deliverable: "Ana Silva directs it", next: "The owner decides", sources: ["https://example.com/team"] },
      requestId: RID,
    },
  ],
  ["claim_opportunity", "opportunity for id", { opportunity: OPP, requestId: RID }],
  ["release_opportunity", "opportunity for id", { opportunity: OPP, reason: "blocked", requestId: RID }],
  ["plan_move", "id for opportunity", { id: OPP, stage: "investigate", requestId: RID }],
  ["hand_off", "opportunity for id", { opportunity: OPP, reason: "other_role", requestId: RID }],
  ["set_intention", "kind left out, id for opportunity", { id: OPP, dueAt: "2030-01-01T00:00:00Z", requestId: RID }],
  [
    "answer_owner_question",
    "quote at the top level",
    { opportunity: OPP, quote: "Yes, keep the Tuesday slot", requestId: RID },
  ],
  [
    "answer_owner_question",
    "answer as the owner's words",
    { opportunity: OPP, answer: "Yes, keep the Tuesday slot", requestId: RID },
  ],
  [
    "close_commitment",
    "fact for commitment, evidence as refs",
    { fact: FACT, ending: "done", evidence: [{ kind: "message", id: MSG }, MSG2], requestId: RID },
  ],
  ["read_item", "id for message", { id: MSG }],
  ["read_item", "message_id for message", { message_id: MSG }],
  ["get_evidence_span", "id for fact", { id: FACT }],
  ["find_facts", "fact for belief", { fact: FACT }],
  ["fetch_template", "id for document", { id: DOC }],
  ["get_entity", "entity for id", { entity: ENT }],
  ["get_timeline", "entity for id", { entity: ENT }],
  ["find_paths", "entity for target", { entity: ENT }],
];

describe("a first honest attempt reaches its tool", () => {
  it.each(PASS)("%s: %s", async (tool, _what, args) => {
    const { reached, details, reply } = await attempt(tool, args);
    expect(reached, `${JSON.stringify(details)} ${reply.result.content[0]?.text}`).toBe(true);
  });

  it("each plain form arrives as the tool's own arguments", async () => {
    const report = await attempt("report_move", {
      id: MOV,
      outcome: "completed",
      deliverable: "Ana Silva directs it",
      next: "The owner decides",
      sources: [REC],
      requestId: RID,
    });
    expect(report.sent?.[1]).toEqual({
      move: MOV,
      outcome: "done",
      report: { deliverable: "Ana Silva directs it", next: "The owner decides", sources: [FINDING] },
      requestId: RID,
    });
    const person = await attempt("propose_person", {
      from: ENT,
      kind: "works_with",
      to: ENT2,
      inferred: true,
      basis: "Inferred",
      requestId: RID,
    });
    expect(person.sent?.[1]).toEqual({
      kind: "link",
      fields: { from: ENT, kind: "works_with", to: ENT2, inferred: true },
      basis: "Inferred",
      requestId: RID,
    });
    const answered = await attempt("answer_owner_question", {
      id: OPP,
      quote: "Yes",
      about: "supports",
      requestId: RID,
    });
    expect(((answered.sent ?? [])[1] as { opportunity: string }).opportunity).toBe(OPP);
    expect(((answered.sent ?? [])[1] as { answer: unknown }).answer).toEqual({ quote: "Yes", about: "supports" });
  });

  it("a form never gets a call past a rule that guards something", async () => {
    // A ref keeps its id, for the store to check; a kind nothing maps stays refused; two ids for one field are not chosen between.
    expect(
      (
        await attempt("propose_task", {
          kind: "investigate",
          about: "the clinic",
          summary: SUMMARY,
          basis: [MSG],
          requestId: RID,
        })
      ).reached,
    ).toBe(false);
    expect(
      (await attempt("plan_move", { id: OPP, opportunity: `opp_${ulid(55)}`, stage: "investigate", requestId: RID }))
        .reached,
    ).toBe(false);
    expect(
      (
        await attempt("report_move", {
          move: MOV,
          outcome: "done",
          deliverable: "One",
          report: { deliverable: "Two" },
          requestId: RID,
        })
      ).reached,
    ).toBe(false);
    expect(
      (
        await attempt("propose_about_you", {
          statement: "The owner prefers tea",
          scope: "this_client",
          fields: { x: 1 },
          kind: "preference",
          requestId: RID,
        })
      ).reached,
    ).toBe(false);
    // A ref carrying anything more than its id and kind is not rebuilt, so nothing it held is dropped.
    expect(
      (
        await attempt("propose_task", {
          kind: "investigate",
          about: ENT,
          summary: SUMMARY,
          basis: [{ id: MSG, note: "x" }],
          requestId: RID,
        })
      ).reached,
    ).toBe(false);
    // An id in prose is refused after a form as before it, and named where it stands after the form.
    const prose = await attempt("report_move", {
      move: MOV,
      outcome: "done",
      deliverable: `See ${ENT}`,
      next: "The owner decides",
      sources: [FINDING],
      requestId: RID,
    });
    expect(prose.reached).toBe(false);
    expect(prose.details.refusal).toBe("ids_in_prose");
    expect(prose.details.field).toContain("deliverable");
  });
});

// [tool, the call, the field named, words the rule or hint must hold]
const REFUSED: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
  ["claim_opportunity", { id: OPP }, "requestId", "8 to 64"],
  ["plan_move", { opportunity: OPP, requestId: RID }, "stage", "investigate"],
  ["plan_move", { opportunity: "sentinel-value-1", stage: "investigate", requestId: RID }, "opportunity", "opp_"],
  ["report_move", { move: MOV, outcome: "sentinel-value-1", requestId: RID }, "outcome", "done, failed, blocked"],
  ["report_move", { outcome: "done", requestId: RID }, "move", "mov_"],
  [
    "propose_person",
    { kind: "person", fields: { name: "Dana Reyes", known_how: "met" }, basis: "x".repeat(601), requestId: RID },
    "basis",
    "600",
  ],
  [
    "propose_person",
    {
      kind: "relationship",
      fields: { person: ENT, relation: "sentinel-value-1", closeness: "active" },
      basis: "How",
      requestId: RID,
    },
    "fields.relation",
    "mentor",
  ],
  ["propose_about_you", { quote: "I like tea", requestId: RID }, "statement", "statement"],
  [
    "propose_about_you",
    { statement: "The owner prefers tea", cites: ["sentinel-value-1"], requestId: RID },
    "cites.0",
    "msg_",
  ],
  [
    "propose_opportunity",
    { kind: "sentinel-value-1", about: "owner", summary: SUMMARY, basis: [MSG], requestId: RID },
    "kind",
    "introduction",
  ],
  [
    "propose_task",
    { kind: "investigate", about: "sentinel-value-1", summary: SUMMARY, basis: [MSG], requestId: RID },
    "about",
    "owner",
  ],
  ["record_test", { hypothesis: HYP, result: "sentinel-value-1", basis: [MSG], requestId: RID }, "result", "supports"],
  ["hand_off", { id: OPP, requestId: RID }, "reason", "other_role"],
  ["set_intention", { opportunity: OPP, dueAt: "sentinel-value-1", requestId: RID }, "dueAt", "2026-09-01T00:00:00Z"],
  ["answer_owner_question", { opportunity: OPP, requestId: RID }, "answer", "quote"],
  [
    "close_commitment",
    { commitment: FACT, ending: "sentinel-value-1", evidence: [MSG], requestId: RID },
    "ending",
    "done",
  ],
  ["read_item", { message: "sentinel-value-1" }, "message", "msg_"],
  ["get_evidence_span", { fact: MSG }, "fact", "find_facts"],
  ["find_facts", { entity: "sentinel-value-1" }, "entity", "leave entity out"],
  ["find_facts", { type: "sentinel-value-1" }, "type", "commitment"],
  ["fetch_template", { document: "sentinel-value-1" }, "document", "doc_"],
];

describe("a refusal says what to send", () => {
  it.each(REFUSED)("%s: %j names the field and its form, and echoes nothing", async (tool, args, field, says) => {
    const { reached, details, reply } = await attempt(tool, args);
    expect(reached).toBe(false);
    expect(reply.result.content[0]?.text).toBe("invalid_request");
    expect(details.arguments?.map((one) => one.name)).toContain(field);
    expect(`${JSON.stringify(details.arguments)} ${details.hint}`).toContain(says);
    expect(JSON.stringify(reply)).not.toContain("sentinel-value-1");
  });

  it("a store's refusal of a tool that had no hint of its own says what it wants", async () => {
    const template = await attempt("fetch_template", { document: DOC }, { ok: false, code: "invalid_request" });
    expect(template.details.hint).toContain("reference true");
    const item = await attempt("read_item", { message: MSG }, { ok: false, code: "not_found" });
    expect(item.details.hint).toContain("find_messages");
  });

  it("report_move's not_found says what it can mean, and that a report sent twice is not one of them", async () => {
    const { details } = await attempt("report_move", {
      move: MOV,
      outcome: "done",
      report: { deliverable: "D", next: "N" },
      requestId: RID,
    });
    expect(details.hint).toContain("was not kept");
    expect(details.hint).toContain("plan_move");
    expect(details.hint).not.toContain("have not reported yet");
  });

  it("report_move's lease refusals name the move and the way back, and a finding stays", async () => {
    for (const refusal of ["work_not_held", "work_closed"] as const) {
      const client = clientView({ tools: ["report_move"], views: VIEWS });
      const reply = (await handle(
        {
          provider: fakeProvider(client).provider,
          work: fakeWork(client, { reportMove: async () => ({ ok: false, code: "not_found", refusal }) }).work,
        },
        fakeLog().log,
        TOKEN,
        call("report_move", { move: MOV, outcome: "done", report: { deliverable: "D", next: "N" }, requestId: RID }),
      )) as Reply;
      const details = JSON.parse(reply.result.content[1]?.text ?? "{}") as Details;
      expect(details.refusal).toBe(refusal);
      expect(details.field).toBe("move");
      expect(details.hint).toContain("finding");
    }
  });
});

describe("what tools/list says", () => {
  const listed = async (tool: string): Promise<Listed> => {
    const client = clientView({ tools: [tool], views: VIEWS });
    const reply = (await handle(
      { provider: fakeProvider(client).provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      request("tools/list", { programs: true }),
    )) as Reply;
    const [one] = reply.result.tools ?? [];
    if (one === undefined) throw new Error(tool);
    return one;
  };

  it.each([
    ["read_item", "message"],
    ["fetch_template", "document"],
    ["get_evidence_span", "fact"],
  ])("%s's description names the field %s", async (tool, field) => {
    expect((await listed(tool)).description).toMatch(new RegExp(`\\b${field}\\b`));
  });

  it("a tool's requestId is said to be required, and propose_person's basis limit is published", async () => {
    for (const tool of [
      "claim_opportunity",
      "plan_move",
      "propose_task",
      "propose_opportunity",
      "propose_hypothesis",
      "hand_off",
      "set_intention",
    ])
      expect((await listed(tool)).description, tool).toContain("requestId (required)");
    expect(JSON.stringify((await listed("propose_person")).inputSchema)).toContain("at most 600");
  });

  it("no description passes 600 characters before its examples", async () => {
    for (const tool of TOOL_NAMES)
      expect(proseOf((await listed(tool)).description).length, tool).toBeLessThanOrEqual(600);
  });
});
