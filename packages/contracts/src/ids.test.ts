import { describe, expect, it } from "vitest";
import { ALL_MEMBERS, DateOnly, GroupId, MemberId, MintedId, ReaderId, Sha256, Timestamp } from "./index.ts";

describe("ids", () => {
  it("a member id cannot be the all-members group", () => {
    expect(MemberId.safeParse("all_members").success).toBe(false);
    expect(MemberId.safeParse("m-ada").success).toBe(true);
  });

  it("a group id is the all-members group and nothing else", () => {
    expect(GroupId.safeParse(ALL_MEMBERS).success).toBe(true);
    expect(GroupId.safeParse("team_alpha").success).toBe(false);
  });

  it("a reader is a member or the all-members group", () => {
    expect(ReaderId.safeParse("all_members").success).toBe(true);
    expect(ReaderId.safeParse("m-ada").success).toBe(true);
    expect(ReaderId.safeParse("").success).toBe(false);
    expect(ReaderId.safeParse(null).success).toBe(false);
  });

  it("an id is never empty", () => {
    expect(MemberId.safeParse("").success).toBe(false);
  });

  it("a hash is 64 lower-case hex characters", () => {
    expect(Sha256.safeParse("a".repeat(64)).success).toBe(true);
    expect(Sha256.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256.safeParse("a".repeat(63)).success).toBe(false);
  });

  it("a minted id is any prefix the repository mints, a UUID or a hex digest; a name is not one", () => {
    const hex = "3f9a2b7c".repeat(8);
    const uuid = "0f3a9b6c-2d1e-4f5a-8b7c-8d9e0f1a2b3c";
    // Every form production code mints, then the synthetic world's.
    const minted = [
      `qr-${hex}`,
      "h-FwWzv2E0UXSU2eMMKCG5d7Xo",
      "h-FwWzvaEbUXSUceMMKCGsdkXo",
      "h-FwWz-aEbUXSUce_MKCGsdkXo",
      `evt-${hex}`,
      `il-${hex}`,
      `al-${hex}`,
      `rv-${hex}`,
      `finding-${hex}`,
      `research-${hex}`,
      `rc-${uuid}`,
      `q-${hex.slice(0, 32)}`,
      `rl-${uuid}`,
      "erasure-12",
      `el-${uuid}`,
      "m-ben",
      "m-never-existed",
      "e-0f3a9b6c",
      "claim-3f9a2b",
      "card-abc123",
      "sess-abcdef",
      "thread-7",
      uuid,
      "0f3a9b6c2d1e4f5a",
      "a".repeat(64),
    ];
    for (const value of minted) expect(MintedId.safeParse(value).success, value).toBe(true);
    const names = [
      "Mary-Jane",
      "Mary-Jane Okoro",
      "Ana Ruiz",
      "Tessel",
      "M-Ben",
      "m-",
      "-ben",
      "claim 3f9a2b",
      "0f3a9b6c",
      // Real names that start with a minted prefix.
      "al-Ahram",
      "al-Rashid",
      "el-Sayed",
      "in-q-tel",
      "t-mobile",
      "run-dmc",
      "post-it",
      "e-trade",
      "d-wave",
      "tag-heuer",
      "doc-martens",
      "fact-x",
    ];
    for (const value of names) expect(MintedId.safeParse(value).success, value).toBe(false);
  });

  it("a date is a calendar day", () => {
    expect(DateOnly.safeParse("2026-09-03").success).toBe(true);
    expect(DateOnly.safeParse("2026-13-03").success).toBe(false);
    expect(DateOnly.safeParse("2026-02-30").success).toBe(false);
    expect(DateOnly.safeParse("2026-09-03T00:00:00Z").success).toBe(false);
  });

  it("a timestamp is ISO 8601 with an explicit zone", () => {
    for (const ok of [
      "2026-09-03T00:00:00Z",
      "2026-09-03T23:59:59.123Z",
      "2026-09-03T08:30:00+02:00",
      "2026-09-03T08:30:00-05:30",
    ]) {
      expect(Timestamp.safeParse(ok).success, ok).toBe(true);
    }
    const refused = [
      "soon",
      "1",
      "2026-09-03",
      "2026-09-03T00:00:00",
      "2026-09-03 00:00:00Z",
      "2026-09-03T00:00Z",
      "2026-09-03T24:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-09-03T00:00:00+0200",
      "Thu, 03 Sep 2026 00:00:00 GMT",
      "September 3, 2026",
    ];
    for (const bad of refused) expect(Timestamp.safeParse(bad).success, bad).toBe(false);
  });
});
