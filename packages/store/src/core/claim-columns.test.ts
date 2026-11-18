import { randomBytes } from "node:crypto";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { carryKey, claimDates, claimKeysOf, earliest, instantOf, valueFpOf } from "./claim-columns.ts";
import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// The dates and the value fingerprint every claim writer stores, from the claim alone.

const keys: Keys = { compartments: new Map(), fingerprintKey: randomBytes(32) };
type Shape = { type: string; fields: Record<string, unknown>; validTo?: string };
const record = ({ type, fields, validTo }: Shape): Pick<ClaimRecord, "claim"> =>
  ({
    claim: { content: { type, subject: "ent_x", fields }, ...(validTo === undefined ? {} : { validTo }) },
  }) as unknown as Pick<ClaimRecord, "claim">;

describe("claimDates", () => {
  it("a commitment's due, a goal's and a need's by", () => {
    expect(claimDates(record({ type: "commitment", fields: { what: "send the deck", due: "2026-11-02" } }))).toEqual({
      validTo: null,
      dueAt: "2026-11-02T00:00:00.000Z",
      reviewAt: null,
    });
    expect(claimDates(record({ type: "goal", fields: { what: "raise", by: "2027-01-01T09:30:00Z" } })).dueAt).toBe(
      "2027-01-01T09:30:00.000Z",
    );
    expect(claimDates(record({ type: "need", fields: { what: "an intro", by: "2026-12-01" } })).dueAt).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  it("an end from validTo, else from until; a review from review", () => {
    expect(claimDates(record({ type: "situation", fields: { what: "travelling", until: "2026-11-10" } })).validTo).toBe(
      "2026-11-10T00:00:00.000Z",
    );
    expect(
      claimDates(
        record({
          type: "situation",
          fields: { what: "travelling", until: "2026-11-10" },
          validTo: "2026-11-09T00:00:00Z",
        }),
      ).validTo,
    ).toBe("2026-11-09T00:00:00.000Z");
    expect(claimDates(record({ type: "goal", fields: { what: "raise", review: "2026-12-15" } })).reviewAt).toBe(
      "2026-12-15T00:00:00.000Z",
    );
  });

  it("a type with no such field, or a value that is no date, gives none", () => {
    expect(claimDates(record({ type: "role", fields: { title: "partner", due: "2026-11-02" } }))).toEqual({
      validTo: null,
      dueAt: null,
      reviewAt: null,
    });
    expect(claimDates(record({ type: "commitment", fields: { what: "x", due: "next week" } })).dueAt).toBeNull();
    expect(instantOf(42)).toBeNull();
  });
});

describe("valueFpOf", () => {
  it("is the same for the same values in other case, spacing or key order", () => {
    const a = valueFpOf(
      keys,
      record({ type: "role", fields: { title: "General  Partner", organization_name: "Northstar" } }),
    );
    const b = valueFpOf(
      keys,
      record({ type: "role", fields: { organization_name: "northstar", title: " general partner" } }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for another value, another type or another end", () => {
    const base = valueFpOf(keys, record({ type: "situation", fields: { what: "travelling", until: "2026-11-10" } }));
    expect(
      valueFpOf(keys, record({ type: "situation", fields: { what: "travelling", until: "2026-11-11" } })),
    ).not.toBe(base);
    expect(
      valueFpOf(keys, record({ type: "constraint", fields: { what: "travelling", until: "2026-11-10" } })),
    ).not.toBe(base);
    expect(
      valueFpOf(
        keys,
        record({
          type: "situation",
          fields: { what: "travelling", until: "2026-11-10" },
          validTo: "2026-11-09T00:00:00Z",
        }),
      ),
    ).not.toBe(base);
  });
});

describe("claimKeysOf", () => {
  it("each distinct fact key's claim key over the evidence id, none for a null", () => {
    const fp = "a".repeat(64);
    const legacy = "b".repeat(64);
    // pipeline-read.ts's claimKeyOf, the agent_claim fingerprint of the evidence id and the key.
    const claimKeyOf = (evidenceId: string, factKeyFp: string): string =>
      fingerprint(keys, "agent_claim", `${evidenceId}\n${factKeyFp}`);
    expect(claimKeysOf({ keys }, "evd_1", [fp, null, legacy, fp])).toEqual([
      claimKeyOf("evd_1", fp),
      claimKeyOf("evd_1", legacy),
    ]);
  });
});

// Two carries of first-known times as one.
describe("earliest", () => {
  it("keeps every key of either and the earlier time of a key both hold, to the microsecond", () => {
    const a = new Map([
      ["v1", "2026-10-20T10:00:00.123456Z"],
      ["v2", "2026-10-21T10:00:00.123900Z"],
    ]);
    const b = new Map([
      ["v2", "2026-10-21T10:00:00.123100Z"],
      ["v3", "2026-10-22T10:00:00.000000Z"],
    ]);
    const both = new Map([
      ["v1", "2026-10-20T10:00:00.123456Z"],
      ["v2", "2026-10-21T10:00:00.123100Z"],
      ["v3", "2026-10-22T10:00:00.000000Z"],
    ]);
    expect(earliest(a, b)).toEqual(both);
    expect(earliest(b, a)).toEqual(both);
  });

  it("keys a value by its label too, whatever the order of its compartments", () => {
    expect(carryKey("fp", ["own", "agent:alpha", "own"])).toBe(carryKey("fp", ["agent:alpha", "own"]));
    expect(carryKey("fp", ["own"])).not.toBe(carryKey("fp", ["agent:alpha", "own"]));
  });
});
