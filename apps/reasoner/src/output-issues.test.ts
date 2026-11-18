import { describe, expect, it } from "vitest";
import { outputIssues } from "./output-issues.ts";

// The words the model is told of a refused ref, literal: they are sent.
const BASIS =
  'must be a ref {"kind", "id"}: a message (msg_), an event (evt_), a person or organization (entity, ent_) or an agent record (agent_record, rec_), each by the id a tool gave or a hdl_ handle; or a goal (gol_), a hypothesis (hyp_) or an opportunity (opp_). Never a document, a fact or a name: cite the message a fact came from, or its record when it has no message';
const ABOUT =
  'must be the owner {"kind": "owner"}, or a ref {"kind", "id"} to a message (msg_), an event (evt_), a person or organization (entity, ent_) or a goal (gol_)';

describe("what the model is told of a refused ref", () => {
  it("names the kinds of a basis and of an about, by the id each takes", () => {
    const basis = outputIssues("ideas", JSON.stringify({ ideas: [{ basis: [{ kind: "nope", id: "x" }] }] }));
    expect(basis.find((one) => one.path === "ideas.0.basis.0.kind")?.rule).toBe(BASIS);
    const about = outputIssues(
      "translate",
      JSON.stringify({ actions: [{ do: "remind", about: { kind: "nope", id: "x" } }] }),
    );
    expect(about.find((one) => one.path === "actions.0.about.kind")?.rule).toBe(ABOUT);
  });
});
