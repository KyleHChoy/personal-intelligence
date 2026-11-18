import { ReviewExport, ReviewImport } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The extraction review's two documents: what `pi extract review-export` prints and what `pi
// extract review-import` reads.

const evidence = "a".repeat(64);
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

const exported = {
  sample_id: "rs1.e30.00",
  generation: 1,
  type: null,
  items: [
    {
      item_id: evidence,
      message_id: `msg_${ULID}`,
      lane: "correspondence",
      date: "2026-03-04T10:00:00Z",
      subject: "Lunch",
      sender: "Alex Example <alex@example.com>",
      text: "See you Friday.",
      claims: [{ claim_id: "c1", type: "plan", fields: { statement: "See you Friday." }, passage: "See you Friday." }],
    },
  ],
};

const imported = {
  sample_id: "rs1.e30.00",
  verdicts: [{ item_id: evidence, claims: [{ claim_id: "c1", verdict: "wrong_date" }], missed: false }],
};

describe("ReviewExport", () => {
  it("parses an export, and refuses a lane or a type the system does not know", () => {
    expect(ReviewExport.parse(exported)).toEqual(exported);
    expect(ReviewExport.safeParse({ ...exported, type: "plan" }).success).toBe(true);
    expect(ReviewExport.safeParse({ ...exported, type: "other" }).success).toBe(false);
    expect(ReviewExport.safeParse({ ...exported, items: [{ ...exported.items[0], lane: "other" }] }).success).toBe(
      false,
    );
  });
});

describe("ReviewImport", () => {
  it("takes the review's claim verdicts and its missed answer, and nothing else", () => {
    expect(ReviewImport.parse(imported)).toEqual(imported);
    for (const verdict of ["right", "wrong", "wrong_date"]) {
      expect(
        ReviewImport.safeParse({
          ...imported,
          verdicts: [{ ...imported.verdicts[0], claims: [{ claim_id: "c1", verdict }] }],
        }).success,
        verdict,
      ).toBe(true);
    }
    // `missed` and `nothing` are the item's answers, never a claim's.
    for (const verdict of ["missed", "nothing", "maybe"]) {
      expect(
        ReviewImport.safeParse({
          ...imported,
          verdicts: [{ ...imported.verdicts[0], claims: [{ claim_id: "c1", verdict }] }],
        }).success,
        verdict,
      ).toBe(false);
    }
    expect(
      ReviewImport.safeParse({ ...imported, verdicts: [{ ...imported.verdicts[0], missed: "yes" }] }).success,
    ).toBe(false);
    expect(ReviewImport.safeParse({ ...imported, extra: 1 }).success).toBe(false);
    expect(ReviewImport.safeParse({ ...imported, verdicts: [{ ...imported.verdicts[0], label: "x" }] }).success).toBe(
      false,
    );
  });

  it("accepts nothing: true only on its own, as the item's answer", () => {
    const nothing = {
      sample_id: "rs1.e30.00",
      verdicts: [{ item_id: evidence, claims: [], missed: false, nothing: true }],
    };
    expect(ReviewImport.safeParse(nothing).success).toBe(true);
    expect(ReviewImport.safeParse({ ...nothing, verdicts: [{ ...nothing.verdicts[0], nothing: false }] }).success).toBe(
      false,
    );
  });
});
