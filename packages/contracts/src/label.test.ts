import { describe, expect, it } from "vitest";
import { Label, NarrowRequest, SignedLabel } from "./index.ts";
import { label, signedLabel } from "./test-samples.ts";

describe("labels", () => {
  it("rejects a label with no compartments", () => {
    expect(Label.safeParse({ compartments: [], readers: [] }).success).toBe(false);
  });

  it("rejects a label with no compartments or null readers", () => {
    expect(Label.safeParse({ compartments: ["people"], readers: null }).success).toBe(false);
    expect(Label.safeParse({ compartments: ["people"] }).success).toBe(false);
    expect(Label.safeParse({ compartments: ["people"], readers: [""] }).success).toBe(false);
  });

  it("accepts a label with no readers, which only a viewing grant on a compartment opens", () => {
    expect(Label.safeParse({ compartments: ["people"], readers: [] }).success).toBe(true);
  });

  it("a narrow request may keep only some readers", () => {
    expect(NarrowRequest.safeParse({ keepReaders: ["m-ben", "m-ada"] }).success).toBe(true);
    expect(NarrowRequest.safeParse({ keepReaders: [] }).success).toBe(true);
    expect(NarrowRequest.safeParse({ keepReaders: [""] }).success).toBe(false);
    expect(Object.keys(NarrowRequest.shape).sort()).toEqual(["addCompartments", "keepReaders", "removeReaders"]);
  });

  it("rejects an unknown key on a label", () => {
    expect(Label.safeParse({ ...label, audience: "everyone" }).success).toBe(false);
  });

  it("rejects a narrow request that adds a reader", () => {
    expect(NarrowRequest.safeParse({ removeReaders: ["m-dev"] }).success).toBe(true);
    expect(NarrowRequest.safeParse({ addReaders: ["m-dev"] }).success).toBe(false);
    expect(NarrowRequest.safeParse({ removeCompartments: ["people"] }).success).toBe(false);
  });

  it("a signed label is bound to its evidence id", () => {
    const { evidenceId: _dropped, ...unbound } = signedLabel("ev-1");
    expect(SignedLabel.safeParse(signedLabel("ev-1")).success).toBe(true);
    expect(SignedLabel.safeParse(unbound).success).toBe(false);
    expect(SignedLabel.safeParse({ ...signedLabel("ev-1"), extra: 1 }).success).toBe(false);
  });
});
