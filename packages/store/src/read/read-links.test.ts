import { OWNER_WORDS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  OWNER_WORD_CODE_POINTS,
  OWNER_WORD_KEY_CODE_POINTS,
  OWNER_WORDS_CODE_POINTS,
  ownerWordsOf,
} from "./read-links.ts";

// The owner's words about a person, from the owner's imported contacts' tags and notes.
// Synthetic values only.

describe("ownerWordsOf", () => {
  it("serves tags then notes of each contact in order, each once, marked as the owner's; a note stored before 0111 has no column", () => {
    const words = ownerWordsOf([
      {
        imported: {
          tags: [{ key: "Spheres", value: "Arts" }],
          notes: [{ key: "Focus", value: "Met at a synthetic dinner." }],
        },
      },
      { imported: { tags: [{ key: "Spheres", value: "Arts" }], notes: ["An older note."] } },
      {},
    ]);
    expect(words).toEqual([
      { by: "owner", kind: "tag", key: { untrusted: "Spheres" }, value: { untrusted: "Arts" } },
      { by: "owner", kind: "note", key: { untrusted: "Focus" }, value: { untrusted: "Met at a synthetic dinner." } },
      { by: "owner", kind: "note", key: null, value: { untrusted: "An older note." } },
    ]);
  });

  it("cuts a long value and stops at the bounds, so every view of a person stays bounded", () => {
    const long = "é".repeat(OWNER_WORD_CODE_POINTS + 5);
    const [one] = ownerWordsOf([{ imported: { notes: [{ key: "Focus", value: long }] } }]);
    expect([Array.from(one?.value.untrusted ?? "").length, one?.cut]).toEqual([OWNER_WORD_CODE_POINTS, true]);
    const many = ownerWordsOf([
      {
        imported: {
          notes: Array.from({ length: 20 }, (_, n) => ({
            key: `N${n}`,
            value: `${n}${"x".repeat(OWNER_WORD_CODE_POINTS)}`,
          })),
        },
      },
    ]);
    expect(
      many.reduce(
        (sum, word) => sum + Array.from(word.value.untrusted).length + Array.from(word.key?.untrusted ?? "").length,
        0,
      ),
    ).toBe(OWNER_WORDS_CODE_POINTS);
    const [keyed] = ownerWordsOf([{ imported: { notes: [{ key: "H".repeat(200), value: "A note." }] } }]);
    expect(Array.from(keyed?.key?.untrusted ?? "").length).toBe(OWNER_WORD_KEY_CODE_POINTS);
    const tags = ownerWordsOf([
      { imported: { tags: Array.from({ length: OWNER_WORDS + 10 }, (_, n) => ({ key: "Tag", value: `t${n}` })) } },
    ]);
    expect(tags).toHaveLength(OWNER_WORDS);
  });
});
