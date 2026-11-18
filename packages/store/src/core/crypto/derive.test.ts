// A claim is sealed under a key derived from the keys of every item its extraction read.
//
// Pinned: one key gives that key itself. Two or more give HKDF-SHA-256 with the
// input keying material the 32-byte keys joined in ascending byte order, an empty salt, the info
// the UTF-8 bytes of "intelligence/content-key/v1" and a 32-byte output, returned as a DataKey.
// The order the keys are given in does not change the result. known-answers.test.ts pins the
// bytes.
//
// Readings, where the spec leaves a detail open. The implementation conforms to these.
// 1. A key given twice counts twice: [a, a] is not [a].
// 2. An empty list, and any key that is not the canonical base64 of 32 bytes, is refused with a
//    throw. That holds for a single key too, which is otherwise handed back as it came.
// 3. The list passed in is not changed.

import type { Envelope } from "@intelligence/contracts";
import { DataKey } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { deriveContentKey, open, seal } from "./envelope.ts";
import {
  bound,
  flipBit,
  formsOf,
  freshKey,
  otherSpelling,
  rawOf,
  shownBy,
  textOf,
  thrownBy,
  utf8,
} from "./test-support/samples.ts";

const derive = (keys: DataKey[]): DataKey => deriveContentKey(keys);

const orderings = <T>(list: T[]): T[][] =>
  list.length <= 1
    ? [list]
    : list.flatMap((first, index) =>
        orderings([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [first, ...rest]),
      );

describe("deriveContentKey", () => {
  it("one key gives that key", () => {
    const key = freshKey();
    expect(derive([key])).toBe(key);
  });

  it("the same keys in the same order give the same key, each time", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const first = derive(keys);
    expect(derive([...keys])).toBe(first);
    expect(derive(keys)).toBe(first);
  });

  it("the derived key is a data key, and is none of the keys it came from", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const derived = derive(keys);
    expect(DataKey.safeParse(derived).success).toBe(true);
    expect(rawOf(derived)).toHaveLength(32);
    expect(keys).not.toContain(derived);
  });

  it("the same keys give the same key whatever order they are given in", () => {
    const keys = [freshKey(), freshKey(), freshKey(), freshKey()];
    const derived = orderings(keys).map(derive);
    expect(derived).toHaveLength(24);
    expect(new Set(derived).size).toBe(1);
  });

  it("leaving out any one key gives a different key", () => {
    const keys = [freshKey(), freshKey(), freshKey(), freshKey()];
    const whole = derive(keys);
    const partial = keys.map((_, index) => derive(keys.filter((_key, other) => other !== index)));
    expect(partial).not.toContain(whole);
    expect(new Set(partial).size).toBe(4);
  });

  it("adding a key gives a different key", () => {
    const keys = [freshKey(), freshKey()];
    expect(derive([...keys, freshKey()])).not.toBe(derive(keys));
  });

  it("adding a key that is already there gives a different key", () => {
    const [a, b] = [freshKey(), freshKey()];
    expect(derive([a, b, b])).not.toBe(derive([a, b]));
    expect(derive([a, a])).not.toBe(derive([a]));
  });

  it("changing one bit of any one key gives a different key", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const whole = derive(keys);
    for (const [index, key] of keys.entries()) {
      for (const byte of [0, 15, 31]) {
        const changed = keys.with(index, DataKey.parse(flipBit(key, byte)));
        expect(derive(changed)).not.toBe(whole);
      }
    }
  });

  it("replacing one key gives a different key", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const whole = derive(keys);
    for (const index of keys.keys()) expect(derive(keys.with(index, freshKey()))).not.toBe(whole);
  });

  it("different sets of keys do not give the same key", () => {
    const derived = new Set<DataKey>();
    for (let round = 0; round < 500; round += 1)
      derived.add(derive(Array.from({ length: 2 + (round % 4) }, () => freshKey())));
    expect(derived.size).toBe(500);
  });

  it("the list passed in is left as it was", () => {
    const keys = [freshKey(), freshKey(), freshKey()].sort().reverse();
    const before = [...keys];
    derive(Object.freeze(keys) as DataKey[]);
    expect(keys).toEqual(before);
  });
});

describe("content sealed under a derived key", () => {
  const here = bound("ev-c", "claim");
  const claim = utf8("need.hiring: a finance lead");

  it("it opens with the key derived from every key, in any order", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const envelope: Envelope = seal(derive(keys), claim, here);
    for (const order of orderings(keys)) expect(textOf(open(derive(order), envelope, here))).toBe(textOf(claim));
  });

  it("once any one key is gone, it opens nowhere", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const envelope: Envelope = seal(derive(keys), claim, here);
    for (const index of keys.keys()) {
      const remaining = keys.filter((_key, other) => other !== index);
      expect(() => open(derive(remaining), envelope, here)).toThrow();
      for (const key of remaining) expect(() => open(key, envelope, here)).toThrow();
    }
  });

  it("it does not open with any single key it was derived from", () => {
    const keys = [freshKey(), freshKey()];
    const envelope: Envelope = seal(derive(keys), claim, here);
    for (const key of keys) expect(() => open(key, envelope, here)).toThrow();
  });

  it("it does not open when one key is swapped for another item's key", () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    const envelope: Envelope = seal(derive(keys), claim, here);
    expect(() => open(derive(keys.with(1, freshKey())), envelope, here)).toThrow();
  });
});

describe("fail closed", () => {
  // Each refusal is shown beside a derivation that works, so it is the input that is refused.
  const works = (): void => {
    expect(DataKey.safeParse(derive([freshKey(), freshKey()])).success).toBe(true);
  };

  it("no keys give no key", () => {
    works();
    expect(() => derive([])).toThrow();
    expect(() => derive(undefined as unknown as DataKey[])).toThrow();
  });

  it.each([
    ["a 16-byte key", Buffer.alloc(16, 7).toString("base64")],
    ["a 31-byte key", Buffer.alloc(31, 7).toString("base64")],
    ["a 33-byte key", Buffer.alloc(33, 7).toString("base64")],
    ["an empty key", ""],
    ["a key that is not base64", "!".repeat(44)],
    ["another spelling of a 32-byte key", otherSpelling(Buffer.alloc(32, 7).toString("base64"))],
  ])("R4: %s among the keys is refused", (_name, bad) => {
    works();
    expect(() => derive([freshKey(), bad as DataKey])).toThrow();
    expect(() => derive([bad as DataKey, freshKey()])).toThrow();
    expect(() => derive([bad as DataKey])).toThrow();
  });

  it("a missing key among the keys is refused", () => {
    works();
    expect(() => derive([freshKey(), undefined as unknown as DataKey])).toThrow();
  });

  it("a refusal shows none of the keys", () => {
    works();
    const good = freshKey();
    const short = Buffer.alloc(31, 0x5a);
    const shown = shownBy(thrownBy(() => derive([good, short.toString("base64") as DataKey])));
    for (const secret of [...formsOf(rawOf(good)), ...formsOf(short)]) expect(shown).not.toContain(secret);
  });
});
