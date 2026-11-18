import type { EvidenceId } from "@intelligence/contracts";
import type { MessageTriageRow } from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { fitScreenSlot, MARKER, STATE_BYTES } from "./fit.ts";

// Fitting the screen slot to the decide model's context, on hand-built parsed messages on reserved domains.

const ROW: MessageTriageRow = { direction: "inbound", bulk: false, category: "primary", unreadable: false, chars: 10 };

function parsed(
  options: {
    text?: string;
    subject?: string;
    to?: string[];
    fromName?: string;
    unread?: number;
    attachments?: number;
  } = {},
): Parsed {
  const text = options.text ?? "I will send the plans by Friday.";
  const subject = options.subject ?? "Plans";
  const to = options.to ?? ["owner@birch.example"];
  const texts: Record<string, string> = { "": text, "subject:": subject };
  for (let n = 0; n < (options.attachments ?? 0); n += 1) texts[`attachment:${n}:`] = "a page";
  return {
    evidenceId: "e".repeat(64) as EvidenceId,
    revision: 0,
    sourceKind: "email",
    automated: false,
    segments: [],
    headers: { from: ["rhea@alder.example"], to, date: ["2026-03-02T09:00:00.000Z"] },
    replyChainEvidenceIds: [],
    unreadAttachments: options.unread ?? 0,
    texts,
    body: text,
    parties: [
      { name: options.fromName ?? "Rhea Alder", address: "rhea@alder.example" },
      ...to.map((address) => ({ name: "", address })),
    ],
  } as Parsed;
}

const bytesOf = (slot: unknown): number => Buffer.byteLength(JSON.stringify({ message: slot }), "utf8");
const points = (text: string): number => Array.from(text).length;

describe("fitScreenSlot", () => {
  it("a short message is sent whole, with cut false, in the fixed key order", () => {
    const slot = fitScreenSlot(parsed(), ROW);
    expect(Object.keys(slot)).toEqual([
      "from",
      "to",
      "cc",
      "more_addressees",
      "subject",
      "date",
      "category",
      "bulk",
      "direction",
      "attachments",
      "text",
      "cut",
    ]);
    expect(slot).toMatchObject({
      from: { name: "Rhea Alder", address: "rhea@alder.example" },
      to: [{ name: "", address: "owner@birch.example" }],
      cc: [],
      more_addressees: 0,
      subject: "Plans",
      date: "2026-03-02T09:00:00.000Z",
      category: "primary",
      bulk: false,
      direction: "inbound",
      attachments: { read: 0, unread: 0 },
      text: "I will send the plans by Friday.",
      cut: false,
    });
    expect(slot).not.toHaveProperty("omitted");
  });

  it("a 30 000-byte ASCII body is cut to its first and last parts with the marker, within 24 000 bytes", () => {
    const text = `${"a".repeat(15_000)}${"z".repeat(15_000)}`;
    const slot = fitScreenSlot(parsed({ text }), ROW);
    expect(slot.cut).toBe(true);
    expect(bytesOf(slot)).toBeLessThanOrEqual(STATE_BYTES);
    expect(bytesOf(slot)).toBeGreaterThan(STATE_BYTES - 100);
    const [head, tail] = slot.text.split(MARKER);
    expect(text.startsWith(head ?? "x")).toBe(true);
    expect(text.endsWith(tail ?? "x")).toBe(true);
    // The first 80 percent and the last 20 percent of what is kept.
    expect((head ?? "").length / ((head ?? "").length + (tail ?? "").length)).toBeCloseTo(0.8, 2);
    expect(slot.omitted).toBe(points(text) - points(head ?? "") - points(tail ?? ""));
  });

  it("a body of 10 000 emoji is cut within 24 000 bytes, never inside a surrogate pair", () => {
    const text = "\u{1F600}".repeat(10_000);
    const slot = fitScreenSlot(parsed({ text }), ROW);
    expect(bytesOf(slot)).toBeLessThanOrEqual(STATE_BYTES);
    const [head, tail] = slot.text.split(MARKER);
    for (const part of [head ?? "", tail ?? ""]) {
      expect(part.length % 2).toBe(0);
      expect(Array.from(part).every((one) => one === "\u{1F600}")).toBe(true);
    }
    expect(slot.omitted).toBe(10_000 - points(head ?? "") - points(tail ?? ""));
  });

  it("a body of quotes and newlines, which JSON escapes to two bytes each, stays within the bound", () => {
    const slot = fitScreenSlot(parsed({ text: '"\n'.repeat(15_000) }), ROW);
    expect(slot.cut).toBe(true);
    expect(bytesOf(slot)).toBeLessThanOrEqual(STATE_BYTES);
  });

  it("a 10 000-code-point name is cut to 200, and a subject to 500", () => {
    const slot = fitScreenSlot(parsed({ fromName: "\u{1F600}".repeat(10_000), subject: "s".repeat(600) }), ROW);
    expect(points(slot.from?.name ?? "")).toBe(200);
    expect(points(slot.subject)).toBe(500);
    expect(slot.cut).toBe(true);
    expect(slot.omitted).toBe(9_800 + 100);
  });

  it("26 addressees become 25 and a count", () => {
    const to = Array.from({ length: 26 }, (_, n) => `person${n}@alder.example`);
    const slot = fitScreenSlot(parsed({ to }), ROW);
    expect(slot.to).toHaveLength(25);
    expect(slot.more_addressees).toBe(1);
  });

  it("read and unread attachments are counted", () => {
    expect(fitScreenSlot(parsed({ attachments: 2, unread: 1 }), ROW).attachments).toEqual({ read: 2, unread: 1 });
  });

  it("the row gives category, bulk and direction", () => {
    expect(fitScreenSlot(parsed(), { ...ROW, direction: "outbound", bulk: true, category: "updates" })).toMatchObject({
      direction: "outbound",
      bulk: true,
      category: "updates",
    });
  });

  it("the same input gives byte-identical output twice", () => {
    const input = parsed({ text: "\u{1F600}x\n".repeat(20_000) });
    expect(JSON.stringify(fitScreenSlot(input, ROW))).toBe(JSON.stringify(fitScreenSlot(input, ROW)));
  });
});
