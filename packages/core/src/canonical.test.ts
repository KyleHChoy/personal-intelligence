// The spec says what the encoding must do, not how it looks. These tests fix the simplest form
// that does it, and the implementation conforms to them:

import { describe, expect, it } from "vitest";
import { canonicalBytes } from "./canonical.ts";
import { randomValue, rewritten, SET_KEYS, seeded, tamperings } from "./test-support/canonical-values.ts";
import { vectors } from "./test-support/canonical-vectors.ts";

const text = (value: unknown): string => new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes(value));

// Fails unless every value has bytes of its own.
function expectAllDifferent(values: unknown[]): void {
  const seen = new Map<string, number>();
  for (const [i, value] of values.entries()) {
    const encoded = text(value);
    expect(seen.get(encoded), `values ${seen.get(encoded)} and ${i} share the bytes ${encoded}`).toBeUndefined();
    seen.set(encoded, i);
  }
}

describe("canonicalBytes: the vectors", () => {
  it.each(vectors)("the encoding is pinned: %s", (_name, value, expected) => {
    const bytes = canonicalBytes(value);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).equals(Buffer.from(expected, "utf8"))).toBe(true);
    expect(text(value)).toBe(expected);
  });

  it("the vectors cover every set field, and each spells JSON that encodes to itself", () => {
    const all = vectors.map(([, , expected]) => expected).join("\n");
    for (const key of SET_KEYS) expect(all).toContain(`"${key}":[`);
    for (const [name, , expected] of vectors) expect(text(JSON.parse(expected)), name).toBe(expected);
  });
});

describe("canonicalBytes: the same value gives the same bytes", () => {
  it("the order of object keys does not change the bytes", () => {
    const one = { id: "t-1", member: "m-ben", nested: { x: 1, y: [{ p: 1, q: 2 }] } };
    const other = { nested: { y: [{ q: 2, p: 1 }], x: 1 }, member: "m-ben", id: "t-1" };
    expect(text(one)).toBe(text(other));
  });

  it.each(SET_KEYS)("the order and repetition of %s do not change the bytes", (key) => {
    const one = { [key]: ["a", "b", "c"] };
    expect(text({ [key]: ["c", "a", "b"] })).toBe(text(one));
    expect(text({ [key]: ["b", "c", "b", "a", "a"] })).toBe(text(one));
  });

  it("a set is a set at any depth", () => {
    const one = {
      token: { matchingGrant: { compartments: ["a", "b"] } },
      list: [{ label: { readers: ["m-a", "m-b"] } }],
    };
    const other = {
      token: { matchingGrant: { compartments: ["b", "a", "b"] } },
      list: [{ label: { readers: ["m-b", "m-a"] } }],
    };
    expect(text(other)).toBe(text(one));
  });

  it("a set of objects ignores their order, their repetition and their key order", () => {
    const one = {
      compartments: [
        { id: "org", kind: "base" },
        { id: "people", kind: "base" },
      ],
    };
    const other = {
      compartments: [
        { kind: "base", id: "people" },
        { id: "org", kind: "base" },
        { kind: "base", id: "org" },
      ],
    };
    expect(text(other)).toBe(text(one));
  });

  it("a field that is undefined is the same as a field that is absent", () => {
    expect(text({ id: "sc-1", vault: undefined })).toBe(text({ id: "sc-1" }));
  });

  it("encoding twice gives the same bytes, and the value given is not changed", () => {
    const value = Object.freeze({
      readers: Object.freeze(["m-b", "m-a", "m-b"]),
      b: 1,
      a: Object.freeze({ d: 1, c: 2 }),
    });
    const first = text(value);
    expect(text(value)).toBe(first);
    expect(value.readers).toEqual(["m-b", "m-a", "m-b"]);
    expect(Object.keys(value)).toEqual(["readers", "b", "a"]);
  });

  it("property: rewriting key order and set order never changes the bytes", () => {
    const next = seeded(20261001);
    for (let i = 0; i < 300; i++) {
      const value = randomValue(next, true);
      const again = rewritten(next, value);
      expect(text(again), JSON.stringify(value)).toBe(text(value));
    }
  });
});

describe("canonicalBytes: different values give different bytes", () => {
  it("values of different types never share bytes", () => {
    expectAllDifferent([
      null,
      "null",
      0,
      "0",
      1,
      "1",
      true,
      "true",
      false,
      "false",
      "",
      [],
      "[]",
      {},
      "{}",
      [null],
      [[]],
      [{}],
      [""],
      { a: null },
      { a: [] },
      { a: {} },
      { a: "" },
      { "": "a" },
    ]);
  });

  it("text cannot be split or joined to look like another value", () => {
    expectAllDifferent([["a", "b"], ["a,b"], ['a","b'], ["ab"], ["a", "b", ""], [["a"], "b"], [["a", "b"]]]);
    expectAllDifferent([
      { a: "x", b: "y" },
      { a: 'x","b":"y' },
      { a: { b: "y" } },
      { "a.b": "y" },
      { a: "x", b: ["y"] },
      { 'a":"x","b': "y" },
    ]);
    expectAllDifferent([
      { readers: ["m-a", "m-b"] },
      { readers: ['m-a","m-b'] },
      { readers: ["m-a,m-b"] },
      { readers: ["m-a"], compartments: ["m-b"] },
      { readers: [["m-a", "m-b"]] },
    ]);
  });

  it("text is compared exactly: no normalizing, trimming or case folding", () => {
    expectAllDifferent(["\u00e9", "e\u0301", "e", "E", " e", "e ", "e\n", "e\u0000", "e\u200b"]);
    expectAllDifferent(["\ud800", "\ud801", "\udc00", "\ufffd", "?"]);
    expectAllDifferent([
      { readers: ["m-ben"] },
      { readers: ["M-BEN"] },
      { readers: ["m-ben "] },
      { Readers: ["m-ben"] },
    ]);
  });

  it("numbers that differ give different bytes, and a number is not its text", () => {
    expectAllDifferent([
      0,
      1,
      -1,
      1.5,
      0.1 + 0.2,
      0.3,
      1e21,
      1e22,
      9007199254740991,
      9007199254740990,
      "1.5",
      [1],
      [1, 0],
    ]);
  });

  it("a null field is not an absent field", () => {
    expectAllDifferent([{}, { a: null }, { a: 0 }, { a: false }, { a: "" }]);
  });

  it("a list that is not a set keeps its order and its repeats", () => {
    expectAllDifferent([
      { releasedTo: ["m-a", "m-b"] },
      { releasedTo: ["m-b", "m-a"] },
      { releasedTo: ["m-a", "m-b", "m-b"] },
      { releasedTo: ["m-a"] },
    ]);
    expectAllDifferent([
      ["a", "b"],
      ["b", "a"],
      ["a", "b", "b"],
    ]);
    // A set key makes a set only of the list directly under it.
    expectAllDifferent([{ readers: [["a", "b"]] }, { readers: [["b", "a"]] }]);
  });

  it("a set with another member is another value", () => {
    expectAllDifferent([
      { readers: [] },
      { readers: ["m-a"] },
      { readers: ["m-a", "m-b"] },
      { readers: ["m-b"] },
      { readers: ["all_members"] },
    ]);
  });

  it("property: the bytes are JSON that reads back as the value", () => {
    const next = seeded(42);
    for (let i = 0; i < 300; i++) {
      const value = randomValue(next, false);
      expect(JSON.parse(text(value)), JSON.stringify(value)).toEqual(value);
    }
  });

  it("property: the bytes hold no white space outside text and re-encode to themselves", () => {
    const next = seeded(43);
    for (let i = 0; i < 300; i++) {
      const encoded = text(randomValue(next, true));
      expect(text(JSON.parse(encoded))).toBe(encoded);
      expect(JSON.stringify(JSON.parse(encoded))).toHaveLength(encoded.length);
    }
  });

  it("property: any single change to a value changes the bytes", () => {
    const next = seeded(44);
    for (let i = 0; i < 150; i++) {
      const value = randomValue(next, true);
      const before = text(value);
      for (const [what, changed] of tamperings(value))
        expect(text(changed), `${what} in ${JSON.stringify(value)}`).not.toBe(before);
    }
  });

  it.each<[string, () => unknown]>([
    ["undefined", () => undefined],
    ["undefined in a list", () => ["a", undefined]],
    ["a hole in a list", () => new Array(2)],
    ["NaN", () => Number.NaN],
    ["an infinite number", () => ({ version: Number.POSITIVE_INFINITY })],
    ["a bigint", () => 1n],
    ["a function", () => ({ a: () => 1 })],
    ["a symbol", () => Symbol("a")],
    ["a Date", () => ({ at: new Date("2026-09-03T00:00:00Z") })],
    ["a Map", () => new Map([["a", 1]])],
    ["a Set", () => ({ readers: new Set(["m-a"]) })],
    ["a typed array", () => new Uint8Array([1, 2])],
  ])("R2: refuses %s, which JSON would change silently", (_name, make) => {
    let thrown: unknown;
    try {
      canonicalBytes(make());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("malformed");
  });
});
