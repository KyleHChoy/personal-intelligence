import { describe, expect, it } from "vitest";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { headerBlock, messageBlock } from "./builders.ts";
import { attachmentsOf, headersOnly } from "./message.ts";
import type { GmailMessage } from "./types.ts";

// Made-up values on reserved domains.
const message: GmailMessage = {
  id: "18c0ffee40",
  threadId: "18c0ffee40",
  internalDate: Date.UTC(2026, 2, 4, 10, 5, 0),
  labelIds: ["INBOX"],
  headers: [
    { name: "From", value: "Alex Example <alex@example.com>" },
    { name: "To", value: "owner@example.org" },
    { name: "Subject", value: "Notes" },
  ],
};
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const line = (value: unknown): string =>
  `X-Pi-Attachment: ${Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")}\r\n`;

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("headersOnly", () => {
  it("the headers alone are the payload up to and including its first empty line", () => {
    const head =
      "From: Alex Example <alex@example.com>\r\nTo: owner@example.org\r\nSubject: Notes\r\nMIME-Version: 1.0\r\n";
    // A block with no body is its own headers.
    expect(text(headersOnly(messageBlock(message)))).toBe(`${head}\r\n`);
    // A body, with empty lines of its own, is left out, and so are the parts of a block with two.
    const plain = messageBlock({ ...message, text: "one\n\ntwo\r\n\r\nthree" });
    expect(text(headersOnly(plain))).toBe(
      `${head}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
    );
    const both = messageBlock({
      ...message,
      text: "one",
      html: "<p>one</p>",
      attachments: [{ name: "a.pdf", type: "application/pdf", size: 1 }],
    });
    expect(text(headersOnly(both))).toMatch(
      /^From: .*\r\nX-Pi-Attachment: [A-Za-z0-9_-]+\r\nMIME-Version: 1\.0\r\nContent-Type: multipart\/alternative; boundary="=_pi_part"\r\n\r\n$/s,
    );
    expect(text(headersOnly(both))).not.toContain("--=_pi_part");
    // A payload that starts with its empty line has no headers, and one with none is itself.
    expect(text(headersOnly(headerBlock([])))).toBe("\r\n");
    expect(text(headersOnly(bytes("\r\nFrom: ghost@example.org\r\n\r\n")))).toBe("\r\n");
    expect(text(headersOnly(bytes("From: alex@example.com\r\n")))).toBe("From: alex@example.com\r\n");
    expect(headersOnly(new Uint8Array())).toEqual(new Uint8Array());
    // The payload is left as it was.
    const before = plain.slice();
    headersOnly(plain);
    expect(plain).toEqual(before);
  });
});

describe("attachmentsOf", () => {
  it("an attachment line that does not decode to the shape is parse_failed", async () => {
    const good = { i: 0, name: "a.pdf", type: "application/pdf", size: 1 };
    const block = (...lines: string[]): Uint8Array =>
      bytes(`From: alex@example.com\r\n${lines.join("")}MIME-Version: 1.0\r\n\r\n`);
    // The control: the shape the builder writes is read.
    expect(await attachmentsOf(block(line(good)))).toEqual([{ name: "a.pdf", type: "application/pdf", size: 1 }]);
    for (const [what, bad] of [
      ["no JSON", "not json"],
      ["no object", [good]],
      ["null", null],
      ["a missing key", { i: 0, name: "a.pdf", type: "application/pdf" }],
      ["a key too many", { ...good, bytes: "AAAA" }],
      ["keys in another order", { name: "a.pdf", i: 0, type: "application/pdf", size: 1 }],
      ["an index that is no integer", { ...good, i: 0.5 }],
      ["a negative index", { ...good, i: -1 }],
      ["an index as text", { ...good, i: "0" }],
      ["a name that is no string", { ...good, name: 5 }],
      ["a type that is no string", { ...good, type: null }],
      ["a negative size", { ...good, size: -1 }],
      ["a size that is no integer", { ...good, size: 1.5 }],
      ["a size as text", { ...good, size: "1" }],
    ] as const) {
      const refused = await failure(() => attachmentsOf(block(line(good), line(bad))));
      expect(refused, what).toBeInstanceOf(PipelineError);
      expect((refused as PipelineError).code, what).toBe("parse_failed");
    }
    // A value that is no base64url at all.
    const refused = await failure(() => attachmentsOf(block("X-Pi-Attachment: {not base64url}\r\n")));
    expect((refused as PipelineError).code).toBe("parse_failed");
  });

  it("only the header lines are read, in any case of the name, sorted by their index", async () => {
    const [first, second] = [
      { i: 0, name: "a.pdf", type: "application/pdf", size: 1 },
      { i: 1, name: "b.png", type: "image/png", size: 2 },
    ];
    const { i: _first, ...a } = first;
    const { i: _second, ...b } = second;
    expect(
      await attachmentsOf(bytes(`${line(second)}x-pi-attachment${line(first).slice("X-Pi-Attachment".length)}\r\n`)),
    ).toEqual([a, b]);
    // A line in the body is text, not a header.
    expect(await attachmentsOf(bytes(`From: alex@example.com\r\n\r\n${line(first)}`))).toEqual([]);
    expect(await attachmentsOf(headersOnly(bytes(`${line(first)}\r\n${line(second)}`)))).toEqual([a]);
  });
});
