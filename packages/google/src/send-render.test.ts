import { messageBodyHash } from "@intelligence/contracts/body-hash";
import { SendPayload } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS, type PipelineItem, parse } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { renderMessage } from "./send-render.ts";

// The message's bytes for a payload and its sender. Made-up addresses and text.

const ACCOUNT = "acc_01J9Z3Q4R5S6T7V8W9XYZ0ABCD";
const FROM = "owner@quinn.test";

function payload(change: Record<string, unknown> = {}): SendPayload {
  return SendPayload.parse({
    v: 1,
    account: ACCOUNT,
    to: ["ana@example.test"],
    cc: ["ben@example.test"],
    subject: "Spring visit",
    body: "Hello,\nSee you at noon. café",
    thread: { id: "thread-01", inReplyTo: "<m1@example.test>", references: ["<m0@example.test>", "<m1@example.test>"] },
    ...change,
  });
}

const ascii = (bytes: Uint8Array): string => new TextDecoder("ascii").decode(bytes);
// The header block's lines, unfolded into fields, and the decoded body.
function split(bytes: Uint8Array): {
  raw: string;
  head: string;
  lines: string[];
  fields: [string, string][];
  body: string;
} {
  const raw = ascii(bytes);
  const at = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, at);
  const lines = raw.split("\r\n");
  const fields: [string, string][] = [];
  for (const line of head.split("\r\n")) {
    if (line.startsWith(" ")) {
      const last = fields[fields.length - 1];
      if (last !== undefined) last[1] += line;
    } else {
      const colon = line.indexOf(":");
      fields.push([line.slice(0, colon), line.slice(colon + 2)]);
    }
  }
  const body = Buffer.from(raw.slice(at + 4).replaceAll("\r\n", ""), "base64").toString("utf8");
  return { raw, head, lines, fields, body };
}

// RFC 2047 encoded words, UTF-8 and base64, joined by a fold.
const decodeWords = (value: string): string =>
  Buffer.concat(
    value.split(" ").map((word) => Buffer.from(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(word)?.[1] ?? "!", "base64")),
  ).toString("utf8");

const item = {
  id: "evi_01J9Z3Q4R5S6T7V8W9XYZ0ABCD",
  revision: 1,
  sourceKind: "email",
  mediaType: "message/rfc822",
  observedAt: "2026-10-04T12:00:00.000Z",
} as unknown as PipelineItem;

describe("renderMessage", () => {
  it("the same payload and sender give the same bytes", () => {
    const one = renderMessage(payload(), FROM);
    expect(one).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(renderMessage(payload(), FROM)).equals(Buffer.from(one))).toBe(true);
    expect(Buffer.from(renderMessage(payload(), "other@quinn.test")).equals(Buffer.from(one))).toBe(false);
  });

  it("the headers are the expected ones and no other, Cc only when there is one", () => {
    const { fields } = split(renderMessage(payload(), FROM));
    expect(fields).toEqual([
      ["From", FROM],
      ["To", "ana@example.test"],
      ["Cc", "ben@example.test"],
      ["Subject", "Spring visit"],
      ["In-Reply-To", "<m1@example.test>"],
      ["References", "<m0@example.test> <m1@example.test>"],
      ["MIME-Version", "1.0"],
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Transfer-Encoding", "base64"],
    ]);
    const alone = split(renderMessage(payload({ cc: [], to: ["ana@example.test", "ben@example.test"] }), FROM));
    expect(alone.fields.map(([name]) => name)).not.toContain("Cc");
    expect(alone.fields.find(([name]) => name === "To")?.[1]).toBe("ana@example.test, ben@example.test");
  });

  it("a reply carries In-Reply-To and References, and a new thread neither", () => {
    const names = (change: Record<string, unknown>) =>
      split(renderMessage(payload(change), FROM)).fields.map(([name]) => name);
    expect(names({})).toEqual(expect.arrayContaining(["In-Reply-To", "References"]));
    for (const name of ["In-Reply-To", "References"]) expect(names({ thread: null })).not.toContain(name);
    // A reply to the first message of a thread has no earlier references.
    const first = names({ thread: { id: "thread-01", inReplyTo: "<m1@example.test>", references: [] } });
    expect(first).toContain("In-Reply-To");
    expect(first).not.toContain("References");
  });

  it("a subject that is not ASCII is an encoded word", () => {
    const { fields } = split(renderMessage(payload({ subject: "Café à midi" }), FROM));
    const subject = fields.find(([name]) => name === "Subject")?.[1] ?? "";
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeWords(subject)).toBe("Café à midi");
    // An ASCII subject that would read as an encoded word is encoded too, so it says what it says.
    const lookalike =
      split(renderMessage(payload({ subject: "=?UTF-8?B?SGk=?=" }), FROM)).fields.find(
        ([name]) => name === "Subject",
      )?.[1] ?? "";
    expect(decodeWords(lookalike)).toBe("=?UTF-8?B?SGk=?=");
  });

  it("a subject of 200 code points that is not ASCII gives encoded words of at most 75 characters, none split inside a code point, that decode to it", () => {
    // One, two, three and four bytes in UTF-8, in turn.
    const subject = [..."aé€😀"].join("").repeat(50);
    expect([...subject]).toHaveLength(200);
    const { head } = split(renderMessage(payload({ subject }), FROM));
    const lines = head.split("\r\n");
    const at = lines.findIndex((line) => line.startsWith("Subject: "));
    let end = at + 1;
    while (lines[end]?.startsWith(" ") === true) end += 1;
    const own = lines.slice(at, end);
    const words = own.map((line, index) => (index === 0 ? line.slice("Subject: ".length) : line.slice(1)));
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      // Each word decodes on its own to whole code points.
      const bytes = Buffer.from(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(word)?.[1] ?? "", "base64");
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
    }
    for (const line of own) expect(line.length).toBeLessThanOrEqual(78);
    expect(decodeWords(words.join(" "))).toBe(subject);
  });

  it("ten addresses of 254 characters give no line over 998, and parse back to the ten", async () => {
    // 64 + 1 + 189: a local part of 64, and labels of 63, 63, 61.
    const address = (n: number): string =>
      `${String(n).padStart(2, "0")}${"a".repeat(62)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const all = Array.from({ length: 10 }, (_unused, n) => address(n));
    expect(all.every((one) => one.length === 254)).toBe(true);
    const bytes = renderMessage(payload({ to: all.slice(0, 6), cc: all.slice(6) }), FROM);
    const { lines } = split(bytes);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(998);
    // A fold is possible after each separator, so no address line holds two of them.
    for (const line of lines.filter((one) => one.includes("@b"))) expect(line.length).toBeLessThanOrEqual(260);
    const parsed = await parse(item, bytes, PERSONAL_LIMITS);
    expect(parsed.headers.to).toEqual(all.slice(0, 6));
    expect(parsed.headers.cc).toEqual(all.slice(6));
  });

  it("To, Cc and References fold after a separator at 78 characters", () => {
    const to = Array.from({ length: 8 }, (_unused, n) => `person${n}@example.test`);
    const references = Array.from({ length: 12 }, (_unused, n) => `<reference-${n}@example.test>`);
    const { head, fields } = split(
      renderMessage(
        payload({ to, cc: [], thread: { id: "thread-01", inReplyTo: "<m1@example.test>", references } }),
        FROM,
      ),
    );
    for (const line of head.split("\r\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    expect(fields.find(([name]) => name === "To")?.[1]).toBe(to.join(", "));
    expect(fields.find(([name]) => name === "References")?.[1]).toBe(references.join(" "));
    expect(head.split("\r\n").filter((line) => line.startsWith(" ")).length).toBeGreaterThan(2);
  });

  it("a payload with a line break in its subject, or in an address, is refused", () => {
    const bad = [
      { subject: "Spring\r\nBcc: eve@example.test" },
      { subject: "Spring\nvisit" },
      { to: ["ana@example.test\r\nBcc: eve@example.test"] },
      { cc: ["ben@example.test\n"] },
      { thread: { id: "thread-01", inReplyTo: "<m1@example.test>\r\nBcc: eve@example.test", references: [] } },
    ];
    const good = payload();
    for (const change of bad)
      expect(() => renderMessage({ ...good, ...change } as SendPayload, FROM), JSON.stringify(change)).toThrow();
    // The sender is held to the same rule.
    for (const from of ["owner@quinn.test\r\nBcc: eve@example.test", "Owner <owner@quinn.test>", ""])
      expect(() => renderMessage(good, from)).toThrow();
  });

  it("a line feed in the body is sent as a carriage return and a line feed, and the body holds no other carriage return", () => {
    const { raw, body } = split(renderMessage(payload({ body: "one\ntwo\n\nthree\n" }), FROM));
    expect(body).toBe("one\r\ntwo\r\n\r\nthree\r\n");
    expect(body.replaceAll("\r\n", "")).not.toContain("\r");
    // The body is base64 in lines of 76, and the message ends with a line break.
    const lines = raw.slice(raw.indexOf("\r\n\r\n") + 4).split("\r\n");
    expect(lines.pop()).toBe("");
    for (const line of lines.slice(0, -1)) expect(line).toHaveLength(76);
    const long = split(renderMessage(payload({ body: "x".repeat(1000) }), FROM));
    expect(long.body).toBe("x".repeat(1000));
  });

  it("the rendered message parses with the shared parse to the same recipients, subject and text", async () => {
    for (const one of [
      payload(),
      payload({ subject: "Café à midi 😀", body: "Ligne une\nLigne deux, café\n\n— fin", thread: null }),
      payload({ cc: [] }),
    ]) {
      const parsed = await parse(item, renderMessage(one, FROM), PERSONAL_LIMITS);
      expect(parsed.headers.from).toEqual([FROM]);
      expect(parsed.headers.to).toEqual(one.to);
      expect(parsed.headers.cc).toEqual(one.cc.length === 0 ? undefined : one.cc);
      expect(parsed.texts["subject:"]).toBe(one.subject);
      expect(parsed.body).toBe(one.body);
    }
  });

  it("the body's hash by messageBodyHash is that of the payload's body", async () => {
    const one = payload({ body: "Hello,\nSee you at noon.\n\n> quoted\nThanks   \n" });
    const parsed = await parse(item, renderMessage(one, FROM), PERSONAL_LIMITS);
    expect(await messageBodyHash(parsed.body ?? "")).toBe(await messageBodyHash(one.body));
  });
});
