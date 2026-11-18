import {
  BeliefItem,
  CommitmentItem,
  CommitmentList,
  GetCommitmentsArgs,
  PackItem,
  PackSection,
  PersonalReadTool,
  PersonalToolArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// get_commitments and the commitment shapes. Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const who = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const belief = {
  fact: "a".repeat(64),
  state: "b".repeat(64),
  kind: "commitment",
  type: "commitment",
  status: "active",
  disputed: false,
  provenance: "source",
  confirmedAt: at,
  reviewAfter: null,
};
const item = {
  belief,
  direction: "owed_to_owner",
  counterparty: who,
  due: "2026-03-20",
  what: { untrusted: "Send the deck." },
  message: `msg_${ULID}`,
  capture: null,
  segment: null,
};

describe("get_commitments", () => {
  it("is a read tool of the work view, and its arguments are GetCommitmentsArgs", () => {
    expect(PersonalReadTool.options).toContain("get_commitments");
    expect(TOOL_VIEW.get_commitments).toBe("work");
    expect(PersonalToolArgs.get_commitments).toBe(GetCommitmentsArgs);
  });

  it("get_commitments refuses a limit of 51, an unknown direction, an unknown state and an unknown field", () => {
    expect(accepts(GetCommitmentsArgs, {})).toBe(true);
    expect(
      accepts(GetCommitmentsArgs, { direction: "owed_by_owner", with: `ent_${ULID}`, state: "any", limit: 50 }),
    ).toBe(true);
    expect(accepts(GetCommitmentsArgs, { limit: 1 })).toBe(true);
    expect(accepts(GetCommitmentsArgs, { limit: 51 })).toBe(false);
    expect(accepts(GetCommitmentsArgs, { limit: 0 })).toBe(false);
    expect(accepts(GetCommitmentsArgs, { direction: "owed_between" })).toBe(false);
    expect(accepts(GetCommitmentsArgs, { state: "overdue" })).toBe(false);
    expect(accepts(GetCommitmentsArgs, { audience: ["own"] })).toBe(false);
    expect(accepts(GetCommitmentsArgs, { with: "alex@example.com" })).toBe(false);
  });

  it("its input schema has type object and additionalProperties false", () => {
    const schema = z.toJSONSchema(GetCommitmentsArgs, { io: "input" }) as {
      type?: string;
      additionalProperties?: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("a commitment item refuses a what outside untrusted, and takes a null what and a null message", () => {
    expect(accepts(CommitmentItem, item)).toBe(true);
    expect(accepts(CommitmentItem, { ...item, what: "Send the deck." })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, what: null, message: null })).toBe(true);
    expect(accepts(CommitmentItem, { ...item, counterparty: null, due: null })).toBe(true);
    expect(accepts(CommitmentItem, { ...item, due: "2026-03-20T17:00:00Z" })).toBe(true);
    expect(accepts(CommitmentItem, { ...item, due: "next week" })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, direction: "owed_between" })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, counterparty: { ...who, name: "Alex Example" } })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, extra: 1 })).toBe(false);
    expect(accepts(CommitmentList, { commitments: [item], more: false })).toBe(true);
    expect(accepts(CommitmentList, { commitments: [item] })).toBe(false);
  });

  it("a belief item's fact and its state are each 64 lower-case hex characters, and a version field is refused", () => {
    expect(accepts(BeliefItem, belief)).toBe(true);
    for (const key of ["fact", "state"]) {
      for (const value of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])
        expect(accepts(BeliefItem, { ...belief, [key]: value }), `${key} ${value}`).toBe(false);
    }
    expect(accepts(BeliefItem, { ...belief, version: 1 })).toBe(false);
    expect(accepts(BeliefItem, { ...belief, status: "kept" })).toBe(false);
    expect(accepts(BeliefItem, { ...belief, type: "meeting" })).toBe(false);
    expect(accepts(BeliefItem, { ...belief, provenance: "agent" })).toBe(false);
  });

  it("every belief item carries reviewAfter: a timestamp or null, never absent (FE5, R31)", () => {
    expect(accepts(BeliefItem, { ...belief, reviewAfter: "2026-09-01T10:00:00Z" })).toBe(true);
    const { reviewAfter: _left, ...without } = belief;
    expect(accepts(BeliefItem, without)).toBe(false);
    expect(accepts(BeliefItem, { ...belief, reviewAfter: "next month" })).toBe(false);
  });

  it("a pack holds a commitment item in its commitments section", () => {
    expect(PackSection.options).toContain("commitments");
    const packed = {
      id: belief.fact,
      section: "commitments",
      required: true,
      provenance: "source",
      asOf: at,
      kind: "commitment",
      commitment: item,
    };
    expect(accepts(PackItem, packed)).toBe(true);
    expect(accepts(PackItem, { ...packed, commitment: { ...item, what: "Send the deck." } })).toBe(false);
  });
});
