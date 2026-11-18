import { describe, expect, it } from "vitest";
import {
  FREE_TEXT_ARGS,
  FRESH_LABEL,
  isTaintPrivate,
  isTaintRestricted,
  joinLabels,
  RAW_TEXT_TOOLS,
  SessionLabel,
  sendsFreeText,
} from "./session-taint.ts";
import { PersonalTool } from "./tools.ts";

// Session taint's shapes and its tables.

describe("session taint", () => {
  it("the raw-text tools include the four the owner's ruling names, and read_meeting", () => {
    expect(RAW_TEXT_TOOLS).toEqual(
      expect.arrayContaining(["read_message", "read_meeting", "get_document", "get_evidence_span"]),
    );
  });

  it("the tools that carry free text to other agents name only arguments of their own", () => {
    expect(Object.keys(FREE_TEXT_ARGS)).toEqual(["post_agent_message", "propose_task", "write_back"]);
    for (const tool of Object.keys(FREE_TEXT_ARGS)) expect(PersonalTool.safeParse(tool).success).toBe(true);
    expect(sendsFreeText("write_back", { state: "handled" })).toBe(false);
    expect(sendsFreeText("write_back", { state: "handled", note: "Answered it." })).toBe(true);
    expect(sendsFreeText("post_agent_message", { body: "a body" })).toBe(true);
    expect(sendsFreeText("find_facts", { query: "a query" })).toBe(false);
  });

  it("a label joins as compartments do: the union, sorted, and untrusted once either is", () => {
    const joined = joinLabels(
      { compartments: ["own"], untrusted: false },
      { compartments: ["agent:scout", "own"], untrusted: true },
    );
    expect(joined).toEqual({ compartments: ["agent:scout", "own"], untrusted: true });
    expect(joinLabels(FRESH_LABEL, FRESH_LABEL)).toEqual(FRESH_LABEL);
    expect(SessionLabel.safeParse(joined).success).toBe(true);
    expect(SessionLabel.safeParse({ compartments: ["nowhere"], untrusted: false }).success).toBe(false);
  });

  it("restricted is the restricted compartments' names, and private is all but what every client may see", () => {
    expect(["restricted:health", "restricted:money", "restricted:legal"].every(isTaintRestricted)).toBe(true);
    expect(isTaintRestricted("own")).toBe(false);
    expect(["own", "agent:scout", "employer:example", "restricted:health"].every(isTaintPrivate)).toBe(true);
    expect(isTaintPrivate("public")).toBe(false);
    expect(isTaintPrivate("declassified")).toBe(false);
  });
});
