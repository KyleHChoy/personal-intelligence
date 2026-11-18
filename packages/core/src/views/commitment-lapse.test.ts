import { describe, expect, it } from "vitest";
import {
  dueLapsed,
  lapseDayOf,
  lastOpenDay,
  lastStood,
  REMARK_OWED_TO_OWNER_DAYS,
  remarkDays,
  thirdPartyLapsed,
} from "./commitment-lapse.ts";

const NOW = new Date("2026-06-20T12:00:00.000Z");
const MADE = "2026-05-01T09:00:00.000Z";

describe("a commitment past its date", () => {
  it("stays open through the last day and lapses the day after", () => {
    expect(lastOpenDay("2026-06-06", MADE, null)).toBe("2026-06-20");
    expect(dueLapsed("2026-06-06", MADE, NOW, null)).toBe(false);
    expect(dueLapsed("2026-06-05", MADE, NOW, null)).toBe(true);
    expect(dueLapsed("2026-06-30", MADE, NOW, null)).toBe(false);
  });

  it("takes an instant's day in the owner's zone", () => {
    // Early on the 6th in UTC is still the 5th in Chicago, a day further past.
    const due = "2026-06-06T02:00:00.000Z";
    expect(lastOpenDay(due, MADE, null)).toBe("2026-06-20");
    expect(lastOpenDay(due, MADE, "America/Chicago")).toBe("2026-06-19");
    expect(dueLapsed(due, MADE, NOW, null)).toBe(false);
    expect(dueLapsed(due, MADE, NOW, "America/Chicago")).toBe(true);
  });

  it("counts from when it was last confirmed, if later: a promise restated still stands", () => {
    expect(dueLapsed("2026-05-10", "2026-06-15T09:00:00.000Z", NOW, null)).toBe(false);
    expect(lastOpenDay("2026-05-10", "2026-06-15T09:00:00.000Z", null)).toBe("2026-06-29");
  });

  it("a reopen stands in for the last confirming when it is later", () => {
    expect(lastStood(MADE, undefined)).toBe(MADE);
    expect(lastStood(MADE, "2026-06-15T09:00:00.000Z")).toBe("2026-06-15T09:00:00.000Z");
    expect(lastStood("2026-06-15T09:00:00.000Z", MADE)).toBe("2026-06-15T09:00:00.000Z");
  });

  it("names the first day it is no longer open, dated or a courtesy", () => {
    expect(lapseDayOf("2026-06-06", MADE, null)).toBe("2026-06-21");
    expect(lapseDayOf("2026-05-10", "2026-06-15T09:00:00.000Z", null)).toBe("2026-06-30");
    expect(lapseDayOf(null, "2026-06-01T09:00:00.000Z", null)).toBe("2026-07-02");
    expect(lapseDayOf("soon", MADE, null)).toBeNull();
  });

  it("never lapses by date with none, or with a value that is no date", () => {
    expect(dueLapsed(null, MADE, NOW, null)).toBe(false);
    expect(lastOpenDay("soon", MADE, null)).toBeNull();
    expect(dueLapsed("soon", MADE, NOW, null)).toBe(false);
  });
});

describe("a commitment with the owner on neither side", () => {
  const AT = new Date("2026-11-04T12:00:00.000Z");
  const isOwner = (id: string): boolean => id === "me";
  const said = (over: object) => ({
    kind: "commitment",
    subject: "pat",
    values: { counterparty: "sam" },
    lastConfirmedAt: "2026-09-30T00:00:00.000Z",
    ...over,
  });

  it("undated, lapses a courtesy's days after it stood", () => {
    expect(thirdPartyLapsed(said({}), isOwner, AT)).toBe(true);
    expect(thirdPartyLapsed(said({ lastConfirmedAt: "2026-10-20T00:00:00.000Z" }), isOwner, AT)).toBe(false);
  });

  it("dated, lapses past its date's window", () => {
    expect(thirdPartyLapsed(said({ values: { counterparty: "sam", due: "2026-10-10" } }), isOwner, AT)).toBe(true);
    expect(thirdPartyLapsed(said({ values: { counterparty: "sam", due: "2026-11-01" } }), isOwner, AT)).toBe(false);
  });

  it("the owner on a side is not one, and any other kind is not", () => {
    expect(thirdPartyLapsed(said({ subject: "me" }), isOwner, AT)).toBe(false);
    expect(thirdPartyLapsed(said({ values: { counterparty: "me" } }), isOwner, AT)).toBe(false);
    expect(thirdPartyLapsed(said({ kind: "goal" }), isOwner, AT)).toBe(false);
  });
});

describe("an undated chat remark", () => {
  it("has the provisional ages the live commitments gave", () => {
    expect(remarkDays("owed_to_owner")).toBe(14);
    expect(remarkDays("owed_by_owner")).toBe(30);
  });

  it("lapses the day after its age, a courtesy's by default", () => {
    expect(lapseDayOf(null, MADE, null, REMARK_OWED_TO_OWNER_DAYS)).toBe("2026-05-16");
    expect(lapseDayOf(null, MADE, null)).toBe("2026-06-01");
  });
});
