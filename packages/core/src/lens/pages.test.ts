import { describe, expect, it } from "vitest";
import { addressesIn } from "../addresses.ts";
import { credentialShaped, pathText, TOPIC_STOP_WORDS, wordRuns, words } from "./pages.ts";

// The words of a history page. Made-up values on reserved domains only.

describe("words and word runs", () => {
  it("folds case and NFKC, drops edge punctuation and a possessive", () => {
    expect(words("Ada Example's talk — notes (draft)")).toEqual(["ada", "example", "talk", "notes", "draft"]);
    expect(words("ＡＤＡ  Example")).toEqual(["ada", "example"]);
    expect(words("-- | --")).toEqual([]);
  });

  it("gives every run of one to four words, in a name fingerprint's form", () => {
    const runs = wordRuns("Interview with Ada Example today");
    for (const run of ["ada", "ada example", "with ada example", "interview with ada example"])
      expect(runs, run).toContain(run);
    expect(runs).not.toContain("interview with ada example today");
  });

  it("splits a word again at - _ . / +, so a path's slug names someone", () => {
    const runs = wordRuns(pathText("https://profiles.example.org/in/ada-example/posts"));
    expect(runs).toContain("ada example");
    expect(runs).toContain("ada-example");
    expect(wordRuns("Mary-Jane Doe")).toContain("mary-jane doe");
    expect(wordRuns("Mary-Jane Doe")).toContain("mary jane doe");
  });

  it("keeps the words as written too, so a name an alias holds with its punctuation meets it", () => {
    expect(wordRuns("Notes by Dr. Ada Lovelace")).toContain("dr. ada lovelace");
    expect(wordRuns("Notes by Dr. Ada Lovelace")).toContain("ada lovelace");
    expect(wordRuns("Ada Lovelace's notes")).toContain("ada lovelace");
  });

  it("reads at most 40 words of a text", () => {
    const long = Array.from({ length: 60 }, (_, n) => `w${n}`).join(" ");
    expect(words(long)).toHaveLength(40);
    expect(wordRuns(long)).not.toContain("w45");
  });

  it("reads as many words as asked, so a title is read whole", () => {
    const long = `${Array.from({ length: 60 }, (_, n) => `w${n}`).join(" ")} Ada Example`;
    expect(words(long, Infinity)).toHaveLength(62);
    expect(wordRuns(long, 4, Infinity)).toContain("ada example");
  });

  it("reads a path that does not decode as written", () => {
    expect(pathText("https://wiki.example.org/a%E0%A4%A/b")).toBe(" a%E0%A4%A b");
  });

  it("finds the addresses a text holds", () => {
    expect(addressesIn("mail ada@example.com and lee.example@mail.example.org")).toEqual([
      "ada@example.com",
      "lee.example@mail.example.org",
    ]);
    expect(addressesIn("no address here, @handle")).toEqual([]);
  });
});

describe("credentialShaped", () => {
  const positive = [
    "-----BEGIN RSA PRIVATE" + " KEY-----",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    `ghp_${"a1B2".repeat(9)}`,
    `github_pat_${"A1b2".repeat(6)}`,
    "xoxb" + "-1234567890-abcdefghij",
    `sk-${"Ab3".repeat(8)}`,
    `AIza${"B".repeat(35)}`,
    "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    "Q7xLm2Rt9VbN4kPz8WcY3hJs",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "code 482913",
    "482913 is your verification code",
    "Your login code: 7731",
    "code: 48291377",
  ];
  const negative = [
    "ada@example.com",
    "docs.example.com",
    "version 1.2.3",
    "ABC-12345-XY",
    "9fceb02d0ae598e95dc970b74767f19372d61af8",
    "4111 1111 1111 1112",
    "2026 budget plan",
    "rust async runtime",
    "zip 78701",
    "VS Code 2024 release notes",
    "ZIP code 94103",
    "Pin 1234 Main St",
    "PIN code 560001",
    "Area code 512",
  ];
  it("matches each positive vector", () => {
    for (const one of positive) expect(credentialShaped(one), one).toBe(true);
  });
  it("matches no negative vector", () => {
    for (const one of negative) expect(credentialShaped(one), one).toBe(false);
  });
});

describe("TOPIC_STOP_WORDS", () => {
  it("holds the common words and the generic page words", () => {
    for (const one of ["the", "and", "of", "home", "untitled", "search"])
      expect(TOPIC_STOP_WORDS.has(one), one).toBe(true);
    expect(TOPIC_STOP_WORDS.has("budget")).toBe(false);
  });
});
