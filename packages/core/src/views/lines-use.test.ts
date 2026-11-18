import type { BeliefLine } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { FRAGMENT_WORDS, isAgentInstruction, isFragment, isLowUse, noticeLapsed } from "./line-checks.ts";
import { rankLines } from "./lines.ts";

// Every line here is made up.

const fp = (n: number): string => n.toString(16).padStart(64, "0");
let serial = 0;
const line = (words: string, over: Partial<BeliefLine> = {}): BeliefLine => ({
  fact: fp((serial += 1)),
  kind: "situation",
  domain: "career",
  line: { untrusted: words },
  tier: "owner",
  status: "active",
  since: "2026-09-01T00:00:00.000Z",
  at: "2026-09-01T00:00:00.000Z",
  cites: 1,
  ...over,
});

describe("rankLines by use", () => {
  it("leads with the owner's central question, not newer notices, agent rules or fragments", () => {
    const question = line("Situation: deciding whether to join full time or to start a company", {
      at: "2026-06-01T00:00:00.000Z",
    });
    const rule = line("Avoids: em dashes in drafts", { kind: "preference", at: "2026-10-30T00:00:00.000Z" });
    const fragment = line("Goal: the Monday", { kind: "goal", at: "2026-10-30T00:00:00.000Z" });
    const notice = line("Situation: statement is ready", {
      tier: "system_notice",
      at: "2026-10-31T00:00:00.000Z",
      notice: { from: null, subject: null, sentAt: "2026-10-31T00:00:00.000Z" },
    });
    const taste = line("Prefers: short calls before noon on weekdays", {
      kind: "preference",
      at: "2026-10-29T00:00:00.000Z",
    });
    const source = line("Situation: the lease on the office renews in spring", {
      tier: "source",
      at: "2026-10-29T00:00:00.000Z",
    });
    const ended = line("Situation: waiting on the visa decision from the office", {
      status: "closed",
      at: "2026-10-30T00:00:00.000Z",
    });
    expect(rankLines([notice, ended, fragment, rule, source, taste, question])).toEqual([
      question,
      taste,
      source,
      // Both too thin to lead: then by the newest, then by fact.
      rule,
      fragment,
      ended,
      notice,
    ]);
  });

  it("keeps tier and then the newest cite within a band, so it stays a total order", () => {
    const older = line("Goal: ship the prototype before spring", { at: "2026-09-01T00:00:00.000Z" });
    const newer = line("Goal: finish the hardware review this term", { at: "2026-09-02T00:00:00.000Z" });
    const confirmed = line("Goal: raise the seed round by the summer", {
      tier: "owner_confirmed",
      at: "2026-09-03T00:00:00.000Z",
    });
    expect(rankLines([older, confirmed, newer])).toEqual([newer, older, confirmed]);
  });

  it("depends on each line alone: taking one away leaves the others' order", () => {
    const all = Array.from({ length: 8 }, (_, n) =>
      line(n % 2 === 0 ? `Goal: long enough aim number ${n}` : `Goal: aim${n}`, {
        at: `2026-09-0${n + 1}T00:00:00.000Z`,
      }),
    );
    const whole = rankLines(all);
    for (const gone of all)
      expect(rankLines(all.filter((one) => one !== gone))).toEqual(whole.filter((one) => one !== gone));
  });
});

describe("isFragment", () => {
  it(`counts the phrase's words, at most ${FRAGMENT_WORDS} being a fragment`, () => {
    expect(isFragment(line("Situation: traveling"))).toBe(true);
    expect(isFragment(line("Goal: the Monday", { kind: "goal" }))).toBe(true);
    expect(isFragment(line("Goal: three whole words", { kind: "goal" }))).toBe(false);
  });
  it("does not count what the template adds after a phrase", () => {
    expect(isFragment(line("Goal: the Monday, by 2026-12-01", { kind: "goal", by: "2026-12-01" }))).toBe(true);
    expect(isFragment(line("Commitment: the deck, with Sam Example, due 2026-12-01", { kind: "commitment" }))).toBe(
      true,
    );
  });
  it("calls a held phrase one, and never a line a kind types", () => {
    expect(isFragment(line("Situation: (held)"))).toBe(true);
    expect(isFragment(line("Founder at Example Labs, since 2026-01-01", { kind: "affiliation" }))).toBe(false);
    expect(isFragment(line("Colleague: Sam", { kind: "relationship" }))).toBe(false);
    expect(isFragment(line("Visited: Lisbon", { kind: "visited" }))).toBe(false);
  });
});

describe("isAgentInstruction", () => {
  it("is a preference naming how an agent works, in whole words", () => {
    expect(isAgentInstruction(line("Avoids: Em  Dashes in email", { kind: "preference" }))).toBe(true);
    expect(isAgentInstruction(line("Prefers: agents to ask before acting", { kind: "preference" }))).toBe(true);
    expect(isAgentInstruction(line("Prefers: said over stated", { kind: "preference" }))).toBe(false);
    expect(isAgentInstruction(line("Prefers: aisle seats on long flights", { kind: "preference" }))).toBe(false);
  });
  it("is no other kind's", () => {
    expect(isAgentInstruction(line("Goal: build an agent for the team"))).toBe(false);
  });
});

describe("isLowUse", () => {
  it("is what stays out of a page's head", () => {
    expect(isLowUse(line("Goal: aim", { kind: "goal" }))).toBe(true);
    expect(isLowUse(line("Goal: finish the hardware review", { status: "closed", kind: "goal" }))).toBe(true);
    expect(isLowUse(line("Goal: finish the hardware review", { kind: "goal" }))).toBe(false);
    expect(isLowUse(line("Goal: finish the hardware review", { kind: "goal", tier: "source" }))).toBe(false);
  });
});

describe("noticeLapsed", () => {
  const sentAt = "2026-10-01T00:00:00.000Z";
  const notice = line("Situation: statement is ready", {
    tier: "system_notice",
    notice: { from: null, subject: null, sentAt },
  });
  it("holds past its days, by the notice's sent time", () => {
    expect(noticeLapsed(notice, new Date("2026-10-15T00:00:00.000Z"))).toBe(false);
    expect(noticeLapsed(notice, new Date("2026-10-15T00:00:00.001Z"))).toBe(true);
  });
  it("never holds for a line that is no notice", () => {
    expect(noticeLapsed(line("Situation: old but no notice at all"), new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
