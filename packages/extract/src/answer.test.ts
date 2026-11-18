import type { EvidenceId } from "@intelligence/contracts";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { ANSWER_PIPELINE, answerText, PROPOSAL_PIPELINE, STATEMENT_OWNER } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import {
  recordBody as canonical,
  claimsOf,
  processRecord as process,
  recording,
  type Setup,
  setup,
} from "./test-support/support.ts";

// The owner's reply to a question the system asked, in the agent lane. Code builds one claim for
// each fact it lists, as a proposal's, with the quote as its passage and the basis explicit_self.
// No model is ever asked, and no restatement is checked.

const ANSWER = {
  opportunity: "opp_01JABCDEFGHJKMNPQRSTVWXYZ0",
  question: "What do you know about Rowan Vale?",
  quote:
    "Rowan runs the robotics lab in Leeds. I want to visit the lab this spring, and I prefer to meet people in person.",
  facts: [
    { kind: "goal", fields: { what: "visit the lab this spring" } },
    { kind: "preference", fields: { what: "meet people in person", polarity: "prefers" } },
  ],
  about: "supports",
};

function answer(s: Setup, body: unknown): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  return s.store.putRecord({
    client: "alpha",
    kind: "answer",
    body: typeof body === "string" ? body : canonical(body),
    recordedAt: at as never,
  });
}

describe("what the owner answered in the agent lane", () => {
  it("builds one claim for each fact, about the owner, explicit_self, of the proposal pipeline, with no model request", async () => {
    const s = await setup();
    const id = answer(s, ANSWER);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 2, live: false });
    expect(s.calls).toEqual([]);
    expect(s.requests).toEqual([]);
    const [goal, preference] = claimsOf(s, id);
    expect(goal?.claim.content).toEqual({
      type: "goal",
      subject: OWNER_ENTITY,
      fields: { what: "visit the lab this spring" },
    });
    expect(preference?.claim.content).toEqual({
      type: "preference",
      subject: OWNER_ENTITY,
      fields: { what: "meet people in person", polarity: "prefers" },
    });
    for (const record of [goal, preference]) {
      expect(record).toMatchObject({
        origin: "agent_record",
        lane: "agent",
        subjectKind: "owner",
        disclosure: [],
        entities: [],
      });
      expect(record?.claim.basis).toBe("explicit_self");
      expect(record?.claim.pipelineVersion).toBe(PROPOSAL_PIPELINE);
      expect(record?.claim.label.compartments).toEqual(["agent:alpha", "own"]);
    }
    expect(goal?.claim.id).not.toBe(preference?.claim.id);
    expect(goal?.factKey).not.toBe(preference?.factKey);
    expect(s.store.record(id)?.restatements).toEqual([]);
  });

  it("an answer stored with no facts, or an empty list, is done with no claim and asks no model", async () => {
    const s = await setup();
    for (const body of [
      { ...ANSWER, facts: undefined, about: "neither" },
      { ...ANSWER, facts: [], about: "neither" },
    ]) {
      const id = answer(s, body);
      expect(await process(s, id)).toMatchObject({ status: "done", claims: 0 });
    }
    expect(s.requests).toEqual([]);
  });

  it("a fact that is not a slice of the quote, or a body that is not an answer's, is bad_proposal and builds nothing", async () => {
    const s = await setup();
    for (const body of [
      { ...ANSWER, facts: [{ kind: "goal", fields: { what: "move to Leeds" } }] },
      { ...ANSWER, facts: [...ANSWER.facts, { kind: "capability", fields: { what: "speaks Welsh" } }] },
      { ...ANSWER, opportunity: undefined },
      { ...ANSWER, label: ["own"] },
      "not json",
    ]) {
      const id = answer(s, body);
      expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
      expect(claimsOf(s, id)).toEqual([]);
    }
  });
});

// An answer stored `typed` is typed by the agent lane's model as a statement proposal is: the agent
// does not choose its kinds and fields. Code builds each claim of an owner's kind (a goal among
// them: they are the owner's words) with the owner as subject, the owner's quote as the passage and every
// text field an unbroken, unnegated run of the owner's words, explicit_self, of the answer pipeline, whose tier
// is owner_relayed.
describe("an answer the classifier types", () => {
  const QUOTED = {
    opportunity: ANSWER.opportunity,
    question: ANSWER.question,
    quote: ANSWER.quote,
    about: "supports",
    typed: true,
  };
  const candidate = (type: string, fields: Record<string, unknown>) => ({
    type,
    subject: { key: { kind: "address", value: "someone@example.org" }, observedAt: "2026-10-01T00:00:00Z" },
    fields,
    statementKind: "stated_fact",
    basis: "third_party",
    span: "chars:0-10",
  });
  const GOAL = candidate("goal", { domain: "relationships", objective: "visit the lab" });
  const PREFERS = candidate("preference", {
    domain: "relationships",
    object: "meet people in person",
    polarity: "prefers",
  });
  const typed = (s: Setup, body: unknown, claims: unknown[], narrowing = "none"): EvidenceId => {
    const id = answer(s, body);
    s.store.outputs[id] = { claims, narrowing };
    s.deps.model = recording(fakeModelClient(s.store.outputs, s.calls), s.requests);
    return id;
  };

  it("gives the fact-kind classifier the program's owner alias for a typed answer", async () => {
    const s = await setup({ factKinds: ["agent"] });
    const id = typed(s, QUOTED, [PREFERS]);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.requests[0]?.promptVersion).toBe("9");
    expect(JSON.parse(s.requests[0]?.data.message ?? "{}").owner).toEqual({ names: [], addresses: [STATEMENT_OWNER] });
    expect(claimsOf(s, id)[0]?.claim.content.subject).toBe(OWNER_ENTITY);
  });

  it("asks the model once, with the question and the owner's words, and builds the owner's claims from the kinds and fields it gave", async () => {
    const s = await setup();
    const id = typed(s, QUOTED, [GOAL, PREFERS]);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 2 });
    expect(s.requests).toHaveLength(1);
    const asked = JSON.stringify(s.requests[0]);
    expect(asked).toContain(ANSWER.quote);
    expect(asked).toContain(ANSWER.question);
    expect(asked).toContain(STATEMENT_OWNER);
    const [goal, preference] = claimsOf(s, id);
    expect(goal?.claim.content).toEqual({
      type: "goal",
      subject: OWNER_ENTITY,
      fields: { domain: "relationships", objective: "visit the lab" },
    });
    expect(preference?.claim.content).toMatchObject({
      type: "preference",
      subject: OWNER_ENTITY,
      fields: { object: "meet people in person", polarity: "prefers" },
    });
    for (const record of [goal, preference]) {
      expect(record).toMatchObject({ origin: "agent_record", lane: "agent", subjectKind: "owner" });
      expect(record?.claim.basis).toBe("explicit_self");
      expect(record?.claim.pipelineVersion).toBe(ANSWER_PIPELINE);
    }
    expect(s.log.lines.map((one) => one.event).filter((one) => one.event === "answer_classified")).toEqual([
      {
        event: "answer_classified",
        ids: { client: "agent", record: expect.stringMatching(/^rec_/), evidence: id },
        counts: { candidates: 2, typed: 2, refused: 0, dropped: 0 },
        code: "typed",
      },
    ]);
  });

  it("a field in words only the question holds, or of a kind not the owner's, builds nothing; with none left it is bad_proposal", async () => {
    const s = await setup();
    const id = typed(s, QUOTED, [
      candidate("situation", { domain: "relationships", state: "know Rowan Vale" }),
      candidate("commitment", { counterparty: "x", what: "visit the lab" }),
    ]);
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    expect(claimsOf(s, id)).toEqual([]);
  });

  it("a phrase that is the owner's words with a gap, or out of order, is no slice of the quote and builds nothing", async () => {
    const s = await setup();
    for (const objective of ["visit the lab spring", "the lab visit"]) {
      const id = typed(s, QUOTED, [candidate("goal", { domain: "relationships", objective })]);
      expect(await process(s, id), objective).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    }
  });

  it("an answer the model withholds is withheld, and builds nothing", async () => {
    const s = await setup();
    const id = typed(s, QUOTED, [GOAL], "quarantine");
    expect(await process(s, id)).toMatchObject({ status: "withheld", code: "quarantine", claims: 0 });
  });

  it("the text the model is shown asks nothing of the agent's: the question, then the owner's exact words", () => {
    expect(answerText({ question: ANSWER.question, quote: ANSWER.quote }).split("\n")).toEqual([
      `A question the owner (${STATEMENT_OWNER}) was asked: ${ANSWER.question}`,
      `The owner's (${STATEMENT_OWNER}) answer, their exact words: ${ANSWER.quote}`,
    ]);
    expect(answerText({ question: null, quote: ANSWER.quote })).toBe(
      `The owner's (${STATEMENT_OWNER}) answer, their exact words: ${ANSWER.quote}`,
    );
  });
});
