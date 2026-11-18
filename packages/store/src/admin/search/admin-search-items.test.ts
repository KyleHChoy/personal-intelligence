import { describe, expect, it } from "vitest";
import { normalized } from "../../read/read-search.ts";
import { type FactEntry, factMatches, type MailEntry, mailMatches, wordMatch } from "./admin-search-items.ts";

// Synthetic words only.

let serial = 0;
const fact = (words: string, at: number, extra: Partial<FactEntry> = {}): FactEntry => {
  serial += 1;
  return {
    fact: String(serial).padStart(64, "0"),
    factKey: `key-${serial}`,
    type: "role",
    subject: null,
    self: false,
    entities: [],
    words,
    text: normalized(words),
    at,
    ...extra,
  };
};
const mail = (subject: string | null, from: string | null, at: number): MailEntry => {
  serial += 1;
  return {
    message: `msg_${serial}`,
    at,
    subject,
    from,
    subjectText: normalized(subject ?? ""),
    senderText: normalized(from ?? ""),
  };
};

describe("search beyond names (R-P5a)", () => {
  it("matches a word's start before the term inside a word, and a run of words", () => {
    expect(wordMatch("hand", "the cohort handbook")).toBe(0);
    expect(wordMatch("book", "the cohort handbook")).toBe(1);
    expect(wordMatch("cohort hand", "the cohort handbook")).toBe(0);
    expect(wordMatch("zzz", "the cohort handbook")).toBeNull();
  });

  it("orders facts by match then the latest, one fact key once, and leaves out a fact naming a withheld person anywhere", () => {
    const inside = fact("Shorthand editor at the studio", 30);
    const older = fact("Handbook lead", 10);
    const newer = fact("Handbook lead, second draft", 20, { factKey: older.factKey });
    const withheld = fact("Handbook keeper", 40, { subject: "ent_withheld" });
    const naming = fact("Handbook partner", 50, { subject: "ent_other", entities: ["ent_other", "ent_withheld"] });
    const found = factMatches("hand", [inside, older, newer, withheld, naming], new Set(["ent_withheld"]));
    expect(found.map((one) => one.fact)).toEqual([newer.fact, inside.fact]);
  });

  it("a fact is its latest claim: words it no longer has do not match it", () => {
    const stale = fact("Handbook lead", 10);
    const now = fact("Studio editor", 20, { factKey: stale.factKey });
    expect(factMatches("hand", [stale, now], new Set())).toEqual([]);
    expect(factMatches("studio", [stale, now], new Set()).map((one) => one.fact)).toEqual([now.fact]);
  });

  it("orders mail by a subject word, a sender word, then inside the subject, then inside the sender, the newest first", () => {
    const subjectWord = mail("Handbook check-in", "Dana Example", 1);
    const senderWord = mail("Lunch", "Handel Park", 5);
    const subjectInside = mail("Shorthand notes", null, 9);
    const senderInside = mail("Lunch", "Shorthand Co", 8);
    const newerSubjectWord = mail("Re: the handbook, final", null, 3);
    const found = mailMatches("hand", [
      senderInside,
      senderWord,
      subjectInside,
      subjectWord,
      newerSubjectWord,
      mail("Other", "Dana", 99),
    ]);
    expect(found.map((one) => one.entry.message)).toEqual([
      newerSubjectWord.message,
      subjectWord.message,
      senderWord.message,
      subjectInside.message,
      senderInside.message,
    ]);
    expect(found.map((one) => one.match)).toEqual(["subject", "subject", "sender", "subject", "sender"]);
  });
});
