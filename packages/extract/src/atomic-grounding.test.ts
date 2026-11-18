import { InterpreterOutput } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { atomicPhrase } from "./check.ts";
import { checkCorrespondence, type EvalMessage } from "./eval/eval-correspondence.ts";
import { EVAL_OWNER } from "./eval/eval-set.ts";
import { PROMPT_VERSIONS } from "./message-prompts.ts";

// A commitment's or a plan's `what` is often part of a line, which a whole-statement check refuses:
// version 4 asks one fact per claim, so it splits a sentence that holds two; a commitment's and a
// plan's `what` is then grounded as a phrase of the passage under version 4, as the owner-side
// kinds already are, and still as a whole statement under version 3.

const SENTENCE = "I will send you the deck on Friday and we can meet on Tuesday.";
const message: EvalMessage = {
  id: "atomic-what",
  from: EVAL_OWNER,
  to: "lena.park@north.example",
  paragraphs: [SENTENCE],
  expected: [],
};
const span = `chars:0-${SENTENCE.length}`;
const subject = { key: { kind: "address", value: EVAL_OWNER }, observedAt: "2026-03-02T09:00:00.000Z" };
const counterparty = {
  key: { kind: "address", value: "lena.park@north.example" },
  observedAt: "2026-03-02T09:00:00.000Z",
};
const output = InterpreterOutput.parse({
  narrowing: "none",
  claims: [
    {
      type: "commitment",
      subject,
      fields: { counterparty, what: "send you the deck on Friday" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span,
    },
    {
      type: "plan",
      subject,
      fields: { counterparty, what: "meet on Tuesday", when: "2026-03-10" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span,
    },
  ],
});

describe("a commitment's and a plan's `what` under the atomic versions", () => {
  it("version 4 keeps a phrase that is part of a line; version 3 still refuses it as part_of_line", async () => {
    const v4 = await checkCorrespondence(message, output, "4");
    expect(v4.claims.map((one) => one.claim.content.type).sort()).toEqual(["commitment", "plan"]);
    expect(v4.unmapped).toEqual([]);
    const v3 = await checkCorrespondence(message, output, "3");
    expect(v3.claims).toEqual([]);
    expect(v3.unmapped.map((one) => one.reason)).toEqual(["bad_fields", "bad_fields"]);
  });

  it("a phrase that is not in the passage is still refused under version 4", async () => {
    const made = InterpreterOutput.parse({
      ...output,
      claims: [{ ...output.claims[0], fields: { counterparty, what: "send the slides" } }],
    });
    const v4 = await checkCorrespondence(message, made, "4");
    expect(v4.claims).toEqual([]);
    expect(v4.unmapped.map((one) => one.reason)).toEqual(["bad_fields"]);
  });

  it("the agent record's atomic version, 3, which the go asks, grounds them as a phrase too; version 2 and other lanes do not", () => {
    expect(PROMPT_VERSIONS.agent).toBe("3");
    expect(atomicPhrase({ lane: "agent", promptVersion: PROMPT_VERSIONS.agent }, "commitment", "what")).toBe(true);
    expect(atomicPhrase({ lane: "agent", promptVersion: "3" }, "plan", "what")).toBe(true);
    expect(atomicPhrase({ lane: "agent", promptVersion: "2" }, "commitment", "what")).toBe(false);
    expect(
      atomicPhrase({ lane: "correspondence", promptVersion: PROMPT_VERSIONS.correspondence }, "commitment", "what"),
    ).toBe(true);
    expect(atomicPhrase({ lane: "transaction", promptVersion: "4" }, "plan", "what")).toBe(false);
    expect(atomicPhrase({ lane: "correspondence", promptVersion: "4" }, "role", "title")).toBe(false);
  });
});
