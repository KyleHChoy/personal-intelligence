import { SendPayload } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { canonicalPayload } from "./payload.ts";

// A draft's payload in its canonical form, written before its code. Made-up addresses and text.

const ACCOUNT = "acc_01J9Z3Q4R5S6T7V8W9XYZ0ABCD";

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

const text = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe("canonicalPayload", () => {
  it("is UTF-8 JSON with keys sorted at every level and no white space", () => {
    const expected =
      '{"account":"acc_01J9Z3Q4R5S6T7V8W9XYZ0ABCD","body":"Hello,\\nSee you at noon. café","cc":["ben@example.test"],"subject":"Spring visit",' +
      '"thread":{"id":"thread-01","inReplyTo":"<m1@example.test>","references":["<m0@example.test>","<m1@example.test>"]},"to":["ana@example.test"],"v":1}';
    const bytes = canonicalPayload(payload());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(text(bytes)).toBe(expected);
    expect(same(bytes, new TextEncoder().encode(expected))).toBe(true);
    // é is the two bytes of UTF-8, not an escape.
    expect(Buffer.from(bytes).includes(Buffer.from([0xc3, 0xa9]))).toBe(true);
  });

  it("a new thread is null", () => {
    expect(text(canonicalPayload(payload({ cc: [], thread: null, body: "Hi" })))).toBe(
      '{"account":"acc_01J9Z3Q4R5S6T7V8W9XYZ0ABCD","body":"Hi","cc":[],"subject":"Spring visit","thread":null,"to":["ana@example.test"],"v":1}',
    );
  });

  it("the same payload gives the same bytes whatever its key order", () => {
    const base = payload();
    const thread = base.thread;
    if (thread === null) throw new Error("the base payload is a reply");
    const reordered = {
      v: base.v,
      thread: { references: [...thread.references], inReplyTo: thread.inReplyTo, id: thread.id },
      to: [...base.to],
      subject: base.subject,
      cc: [...base.cc],
      body: base.body,
      account: base.account,
    } as SendPayload;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(base));
    expect(same(canonicalPayload(reordered), canonicalPayload(base))).toBe(true);
    expect(same(canonicalPayload(payload()), canonicalPayload(payload()))).toBe(true);
  });

  it("arrays keep their order", () => {
    const one = canonicalPayload(payload({ to: ["ana@example.test", "cal@example.test"] }));
    const other = canonicalPayload(payload({ to: ["cal@example.test", "ana@example.test"] }));
    expect(same(one, other)).toBe(false);
    expect(text(one)).toContain('"to":["ana@example.test","cal@example.test"]');
    expect(text(other)).toContain('"to":["cal@example.test","ana@example.test"]');
  });

  it("a changed recipient, subject, body or thread changes the bytes", () => {
    const base = canonicalPayload(payload());
    const changes: Record<string, unknown>[] = [
      { to: ["dee@example.test"] },
      { cc: ["eve@example.test"] },
      { cc: [] },
      { to: ["ana@example.test", "fay@example.test"] },
      { subject: "Spring visit!" },
      { body: "Hello,\nSee you at one. café" },
      { body: "Hello, See you at noon. café" },
      { thread: null },
      {
        thread: {
          id: "thread-02",
          inReplyTo: "<m1@example.test>",
          references: ["<m0@example.test>", "<m1@example.test>"],
        },
      },
      {
        thread: {
          id: "thread-01",
          inReplyTo: "<m2@example.test>",
          references: ["<m0@example.test>", "<m1@example.test>"],
        },
      },
      { thread: { id: "thread-01", inReplyTo: "<m1@example.test>", references: ["<m1@example.test>"] } },
    ];
    for (const change of changes)
      expect(same(canonicalPayload(payload(change)), base), JSON.stringify(change)).toBe(false);
  });

  it("a payload that does not parse throws", () => {
    expect(() => canonicalPayload(payload())).not.toThrow();
    const good = {
      v: 1,
      account: ACCOUNT,
      to: ["ana@example.test"],
      cc: [],
      subject: "Spring visit",
      body: "Hi",
      thread: null,
    };
    const bad: unknown[] = [
      { ...good, v: 2 },
      { ...good, to: ["Ana@example.test"] },
      { ...good, to: [] },
      { ...good, cc: ["ana@example.test"] },
      { ...good, subject: "" },
      { ...good, body: "Hi\rthere" },
      { ...good, bcc: ["ben@example.test"] },
      { ...good, account: "not-an-account" },
      { ...good, thread: { id: "thread 01", inReplyTo: "<m1@example.test>", references: [] } },
      null,
    ];
    for (const one of bad) expect(() => canonicalPayload(one as SendPayload), JSON.stringify(one)).toThrow();
  });
});
