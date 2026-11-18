import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { laterClaim } from "./claim-order.ts";

// The latest of two claims by valid_from is by time, never by the string. A source moment's claim
// may hold a message's time with the Mac's offset, and every other claim a time in UTC; a string
// comparison of the two orders them wrong.
const claim = (id: string, validFrom: string): ClaimRecord => ({ claim: { id, validFrom } }) as unknown as ClaimRecord;

describe("laterClaim", () => {
  it("orders by time whatever the offset, then by id", () => {
    const local = claim("a", "2026-10-22T20:00:00-05:00");
    const utc = claim("b", "2026-10-23T00:30:00.000Z");
    // 20:00 at -05:00 is 01:00 UTC, after 00:30 UTC; as strings it would be the other way.
    expect(laterClaim(local, utc)).toBe(local);
    expect(laterClaim(utc, local)).toBe(local);
    // The same time written two ways is a tie, broken by id.
    const same = claim("c", "2026-10-23T01:00:00.000Z");
    expect(laterClaim(local, same)).toBe(same);
    expect(laterClaim(same, local)).toBe(same);
  });
});
