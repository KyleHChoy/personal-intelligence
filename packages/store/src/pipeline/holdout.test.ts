import { HOLDOUT_SHARE } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { heldOut } from "./pipeline-cards.ts";

// The holdout under a standing release: about HOLDOUT_SHARE of records, each always the same way,
// by its id under the store's fingerprint key, so another key holds out other records and an agent,
// which holds no key, cannot tell which.
describe("the holdout", () => {
  const keys: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32) };
  const other: Keys = { compartments: new Map(), fingerprintKey: Buffer.alloc(32, 1) };
  const ids = Array.from({ length: 10_000 }, (_, n) => `rec_01J${String(n).padStart(23, "0")}`);
  const held = (key: Keys) => ids.slice(0, 40).flatMap((id, n) => (heldOut(key, id) ? [n] : []));

  it("holds out about 15% of records", () => {
    const share = ids.filter((id) => heldOut(keys, id)).length / ids.length;
    expect(Math.abs(share - HOLDOUT_SHARE)).toBeLessThan(0.015);
  });

  it("holds a record out or not by its id and the key, every time", () => {
    for (const id of ids.slice(0, 200)) expect(heldOut(keys, id)).toBe(heldOut(keys, id));
    expect(held(keys).length).toBeGreaterThan(0);
    expect(held(keys)).not.toEqual(held(other));
  });
});
