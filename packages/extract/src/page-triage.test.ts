import { describe, expect, it } from "vitest";
import { triageMoment } from "./triage.ts";

// A page moment's triage. The lane's commit of one is moments.test.ts's.

describe("a page moment's triage", () => {
  const page = (over: Partial<{ text: string }> = {}) => ({
    entity: "page" as const,
    agentApp: false,
    storedDocument: false,
    text: "x".repeat(250),
    turns: false,
    ...over,
  });
  it("is skip, reading, whatever its length and whatever the owner's lane", () => {
    expect(triageMoment(page(), undefined)).toEqual({ lane: "skip", code: "reading" });
    expect(triageMoment(page({ text: "short" }), undefined)).toEqual({ lane: "skip", code: "reading" });
    expect(triageMoment(page(), "moment")).toEqual({ lane: "skip", code: "reading" });
    // The control: a chat with turns of the same text is in the lane.
    expect(triageMoment({ ...page(), entity: "chat", turns: true }, undefined)).toEqual({ lane: "moment" });
  });
});
