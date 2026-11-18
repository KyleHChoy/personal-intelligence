import type { DraftView } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { escapeForTerminal } from "../terminal-text.ts";
import { renderShow } from "./send.ts";

// What `pi send show` writes: nothing a terminal obeys, every held claim before the reveal code,
// and the text's counts after it.

const CLEAR = {
  authority: true,
  vetoes: true,
  conflict_lists: true,
  contact_policy: true,
  disclosure: true,
  freshness: true,
  consent: true,
  channel_cap: true,
  payload_hash: true,
};

const view = (over: Partial<DraftView> = {}): DraftView => ({
  draft: `drf_${"0".repeat(25)}1`,
  label: "personal",
  from: "owner@send-home.test",
  fp: "0123abcd".padEnd(64, "e"),
  payload: {
    v: 1,
    account: `acc_${"0".repeat(25)}3` as never,
    to: ["solo@one-message.test"],
    cc: ["rhea@lighthouse.test"],
    subject: "Thursday",
    body: "Line one\n\n\n\nLine five",
    thread: null,
  },
  firstContacts: ["solo@one-message.test"],
  newThread: true,
  flags: ["--first-contact", "--new-thread"],
  basis: [{ kind: "message", id: `msg_${"0".repeat(25)}4` }],
  counts: { missing: 0, tainted: 0, flagged: 1, unscreened: 2 },
  outcome: { cleared: true, checks: CLEAR, causes: [] },
  held: [],
  heldFields: [],
  leftOut: 0,
  revealCode: null,
  code: "0123abcd",
  ...over,
});

const bytesUnder0x20 = (text: string): number[] =>
  [...Buffer.from(text, "utf8")].filter((byte) => byte < 0x20 && byte !== 0x0a && byte !== 0x09);

describe("pi send show", () => {
  it("show writes no byte under 0x20 but line feed and tab, prints a code point of category Cc, Cf, Zl, Zp or Co as <U+XXXX>, and prints the counts of lines and code points", () => {
    expect(escapeForTerminal("a\u001b[31mb\u0007c\td\ne")).toBe("a<U+001B>[31mb<U+0007>c\td\ne");
    expect(escapeForTerminal("​‮  \u0085\u007f")).toBe("<U+200B><U+202E><U+2028><U+2029><U+E000><U+0085><U+007F>");
    // An unpaired surrogate, and a paired one, which prints.
    expect(escapeForTerminal("x\ud800y😀")).toBe("x<U+D800>y😀");
    const hostile = view({
      payload: { ...view().payload, subject: "Hi\u001b]0;owned\u0007", body: "fine\u001b[2J\r\nhidden\u0000" },
      held: [{ id: "claim-1", tie: "text_value", value: "value\u001b[8m" }],
    });
    const printed = `${renderShow(hostile).join("\n")}\n`;
    expect(bytesUnder0x20(printed)).toEqual([]);
    expect(printed).toContain("agent| fine<U+001B>[2J<U+000D>");
    expect(renderShow(view())).toContain("text: 5 lines, 21 code points");
  });

  it("show marks each line of the text as an agent's, a first contact, a new thread, the flags, the basis and its counts, and the code", () => {
    const lines = renderShow(view());
    expect(lines).toEqual(
      expect.arrayContaining([
        "to solo@one-message.test (first contact)",
        "cc rhea@lighthouse.test",
        "agent| Line one",
        "agent| ",
        "agent| Line five",
        "thread new",
        "flags --first-contact --new-thread",
        `basis message msg_${"0".repeat(25)}4`,
        "basis missing 0, tainted 0, flagged 1, unscreened 2",
        "check authority: ok",
        "code 0123abcd",
      ]),
    );
    expect(lines.at(-1)).toBe("code 0123abcd");
  });

  it("show names each failing check with its causes, and for disclosure each claim's id, its tie and the matched value", () => {
    const lines = renderShow(
      view({
        outcome: {
          cleared: false,
          checks: { ...CLEAR, disclosure: false, authority: false },
          causes: ["held_at_draft", "use_only_revealed"],
        },
        held: [
          { id: "claim-1", tie: "text_value", value: "moving the heron ledger" },
          { id: "claim-2", tie: "cited_item", value: null },
        ],
        leftOut: 2,
        revealCode: "89abcdef",
      }),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "check authority: failed held_at_draft",
        "check disclosure: failed use_only_revealed",
        "held claim claim-1 tie text_value value moving the heron ledger",
        "held claim claim-2 tie cited_item",
        "candidates left out, keys not held: 2",
      ]),
    );
  });

  it("show prints the reveal code after every held claim", () => {
    const lines = renderShow(
      view({
        held: [
          { id: "a", tie: "cited_item", value: null },
          { id: "b", tie: "cited_item", value: null },
        ],
        revealCode: "89abcdef",
      }),
    );
    const code = lines.indexOf("reveal code 89abcdef");
    expect(code).toBeGreaterThan(lines.indexOf("held claim b tie cited_item"));
    expect(code).toBeGreaterThan(lines.indexOf("held claim a tie cited_item"));
    expect(renderShow(view()).some((line) => line.startsWith("reveal code"))).toBe(false);
  });

  it("show names each held contact field by contact, field and index, after the held claims and before the reveal code, with no value", () => {
    const contact = `con_${"0".repeat(25)}5`;
    const lines = renderShow(
      view({
        held: [{ id: "a", tie: "cited_item", value: null }],
        heldFields: [
          { id: contact, field: "phone", index: 0 },
          { id: contact, field: "birthday", index: null },
        ],
        revealCode: "89abcdef",
      }),
    );
    const phone = lines.indexOf(`contact ${contact} phone 0`);
    const birthday = lines.indexOf(`contact ${contact} birthday`);
    expect(phone).toBeGreaterThan(lines.indexOf("held claim a tie cited_item"));
    expect(birthday).toBeGreaterThan(phone);
    expect(lines.indexOf("reveal code 89abcdef")).toBeGreaterThan(birthday);
  });
});
