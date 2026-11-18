import { describe, expect, it } from "vitest";
import { RECOVERY_MARKERS, recoveryHold } from "./hold.ts";

// Made-up values on reserved domains. Every code is made up.
const TERMS = [
  "one-time code",
  "verification code",
  "security code",
  "reset your password",
  "sign-in link",
  "magic link",
  "confirm your email",
];
const SENDERS = ["no-reply", "noreply", "accounts", "security", "verify"];
const LEAD = 2000;

// A character outside the basic plane that is no letter and no digit: one code point, two
// UTF-16 units, and a word break.
const ASTRAL = "😀";
const codePoints = (text: string): number => [...text].length;

const held = (subject: string | null, text: string | null, sender?: string): boolean =>
  recoveryHold({ subject, text, ...(sender === undefined ? {} : { sender }) });

describe("the recovery hold", () => {
  it("each recovery term in a subject holds the message", () => {
    for (const term of TERMS) {
      const capitalized = term.replaceAll(
        /(^|[ -])([a-z])/g,
        (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`,
      );
      // As written, in another case, with its hyphen as a space, and with its spaces doubled.
      for (const subject of [
        term,
        term.toUpperCase(),
        capitalized,
        term.replaceAll("-", " "),
        term.replaceAll(" ", "  "),
        term.replaceAll("-", " ").replaceAll(" ", " \t "),
      ]) {
        expect(held(subject, null), subject).toBe(true);
        // Among other words, and next to punctuation.
        expect(held(`Re: Your ${subject}: 000000`, null), subject).toBe(true);
        expect(held(`[Example] ${subject}.`, "The rest is in the app."), subject).toBe(true);
      }
      // NFKC: the same term in full-width letters.
      const wide = [...term]
        .map((character) =>
          character >= "a" && character <= "z" ? String.fromCodePoint(character.codePointAt(0)! + 0xfee0) : character,
        )
        .join("");
      expect(wide).not.toBe(term);
      expect(held(wide, null), wide).toBe(true);
    }
    // The worked examples.
    for (const subject of ["One-Time Code", "one time code:", "ONE-TIME  CODE"])
      expect(held(subject, null), subject).toBe(true);
    // The control: a subject with no term.
    expect(held("Notes from Tuesday", null)).toBe(false);
  });

  it("a term in the first 2,000 code points of the text holds the message, and one only after them does not", () => {
    for (const term of TERMS) {
      // The term ends at code point 2,000, after characters outside the basic plane.
      const inside = `${ASTRAL.repeat(LEAD - term.length)}${term}`;
      expect(codePoints(inside)).toBe(LEAD);
      expect(inside.length).toBeGreaterThan(LEAD);
      expect(held("Notes", inside), term).toBe(true);
      expect(held(null, `${inside} and more after it`), term).toBe(true);
      // The term starts at code point 2,001.
      const after = `${ASTRAL.repeat(LEAD)}${term}`;
      expect(codePoints(after)).toBe(LEAD + term.length);
      expect(held("Notes", after), term).toBe(false);
      // One code point later than the first case, so its last letter is past the lead.
      expect(held("Notes", `${ASTRAL.repeat(LEAD - term.length + 1)}${term}`), term).toBe(false);
      // At the text's start, and alone.
      expect(held("Notes", `${term}\n\n${"The rest of the message. ".repeat(200)}`), term).toBe(true);
      expect(held("Notes", term.toUpperCase()), term).toBe(true);
    }
    // In characters of the basic plane the lead is the same 2,000.
    expect(held(null, `${". ".repeat(LEAD / 2 - 5)}magic link`)).toBe(true);
    expect(held(null, `${". ".repeat(LEAD / 2)}magic link`)).toBe(false);
  });

  it("a sender on the list and a term anywhere in the text hold the message", () => {
    // The term is after the first 2,000 code points, so only the sender's rule can hold it.
    const text = `${ASTRAL.repeat(LEAD)}\nYour verification code is 000000.`;
    for (const local of SENDERS) {
      for (const sender of [
        `${local}@example.com`,
        `${local.toUpperCase()}@EXAMPLE.COM`,
        `${local}+signup@example.com`,
        `${local.toUpperCase()}+A+B@example.org`,
      ]) {
        expect(held("Notes", text, sender), sender).toBe(true);
        expect(held(null, text, sender), sender).toBe(true);
      }
    }
    for (const term of TERMS)
      expect(held("Notes", `${ASTRAL.repeat(LEAD)} ${term}`, "no-reply@example.com"), term).toBe(true);
    // The control: the same text from any other sender, or from none, is not held. A local part
    // is matched whole, before its tag.
    for (const sender of [
      undefined,
      "alex@example.com",
      "no-reply.team@example.com",
      "my-noreply@example.com",
      "security-team@example.com",
      "alex+security@example.com",
      "verified@example.com",
      "account@example.com",
      "no_reply@example.com",
    ]) {
      expect(held("Notes", text, sender), String(sender)).toBe(false);
    }
  });

  it("a sender on the list with no term is not held", () => {
    for (const local of SENDERS) {
      for (const sender of [`${local}@example.com`, `${local.toUpperCase()}+tag@example.com`]) {
        expect(held("Your order has shipped", "It arrives on Tuesday. Order 000000.", sender), sender).toBe(false);
        expect(held(null, null, sender), sender).toBe(false);
        expect(held("Security update", "We changed our terms.", sender), sender).toBe(false);
      }
    }
    // The control: with a term, the same sender's message is held.
    expect(held("Your order has shipped", "Use this magic link to track it.", "no-reply@example.com")).toBe(true);
  });

  it("a term inside other words is no match", () => {
    for (const value of [
      "someone time coded",
      "insecurity codes",
      "verification codes",
      "magic linked",
      "unconfirm your emails",
      "preset your password",
      "design-in link",
      "one-timecode",
      "onetime code",
      "magiclink",
    ]) {
      expect(held(value, null), value).toBe(false);
      expect(held(null, value), value).toBe(false);
      expect(held(value, `${ASTRAL.repeat(LEAD)} ${value}`, "security@example.com"), value).toBe(false);
    }
    // A digit is part of a word too.
    expect(held("magic link2", null)).toBe(false);
    expect(held("2one-time code", null)).toBe(false);
    // The control: the same words as words.
    for (const value of ["someone's one-time code", "in security code terms", "a magic link, linked"])
      expect(held(value, null), value).toBe(true);
  });

  it("a message with no subject and no text is not held", () => {
    expect(held(null, null)).toBe(false);
    expect(held(null, null, "alex@example.com")).toBe(false);
    expect(held(null, null, "noreply@example.com")).toBe(false);
    expect(held("", "")).toBe(false);
    expect(held(" \n\t", "   ", "noreply@example.com")).toBe(false);
    // Each alone is enough.
    expect(held("Magic link", null)).toBe(true);
    expect(held(null, "Magic link")).toBe(true);
  });

  it("recoveryHold reads nothing but the three values", () => {
    expect(RECOVERY_MARKERS).toEqual({ version: 1, terms: TERMS, senders: SENDERS, leadChars: LEAD });
    expect(RECOVERY_MARKERS.version).toBe(1);
    // The same values give the same answer, whatever else the object holds, and nothing else of
    // it is read.
    const cases: { subject: string | null; sender?: string; text: string | null }[] = [
      { subject: "Your one-time code", sender: "noreply@example.com", text: "000000" },
      { subject: "Notes", sender: "alex@example.com", text: "See you on Tuesday." },
      { subject: null, text: null },
      { subject: "Notes", sender: "verify@example.com", text: `${ASTRAL.repeat(LEAD)} confirm your email` },
    ];
    for (const about of cases) {
      const read: string[] = [];
      const watched = new Proxy(
        { ...about, owner: "owner@example.org", held: true, labelIds: ["SENT"], now: "2026-03-10T12:00:00.000Z" },
        {
          get: (target, key, receiver) => {
            read.push(String(key));
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const first = recoveryHold(about);
      expect(recoveryHold(watched)).toBe(first);
      expect(recoveryHold(structuredClone(about))).toBe(first);
      expect(recoveryHold(Object.freeze({ ...about }))).toBe(first);
      expect([...new Set(read)].sort()).toEqual(["sender", "subject", "text"]);
    }
    expect(cases.map((about) => recoveryHold(about))).toEqual([true, false, false, true]);
  });

  it("the marker list cannot be changed at run time", () => {
    for (const frozen of [RECOVERY_MARKERS, RECOVERY_MARKERS.terms, RECOVERY_MARKERS.senders])
      expect(Object.isFrozen(frozen)).toBe(true);
    // The types refuse each of these, so they go through a writable view of the same object.
    const open = RECOVERY_MARKERS as {
      version: number;
      terms: string[];
      senders: string[];
      leadChars: number;
      extra?: boolean;
    };
    const attempts: (() => unknown)[] = [
      () => open.terms.push("notes from tuesday"),
      () => (open.terms[0] = "notes from tuesday"),
      () => open.terms.splice(0),
      () => open.senders.push("alex"),
      () => open.senders.pop(),
      () => (open.terms = ["notes from tuesday"]),
      () => (open.senders = ["alex"]),
      () => (open.leadChars = 0),
      () => (open.version = 2),
      () => (open.extra = true),
      () => delete (open as { terms?: string[] }).terms,
      () => Object.defineProperty(open, "terms", { value: [] }),
    ];
    for (const attempt of attempts) expect(attempt, String(attempt)).toThrow(TypeError);
    // The list is as written, and the answers are its answers: none of the attempts took.
    expect(RECOVERY_MARKERS).toEqual({ version: 1, terms: TERMS, senders: SENDERS, leadChars: LEAD });
    const late = `${ASTRAL.repeat(LEAD)} magic link`;
    expect(held("Notes from Tuesday", null)).toBe(false);
    expect(held("Notes", late, "alex@example.com")).toBe(false);
    expect(held("Magic link", null)).toBe(true);
    expect(held("Notes", late, "verify@example.com")).toBe(true);
  });
});
