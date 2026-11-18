import {
  MAC_CONTACT_DROPS,
  MAC_CONTACT_LIMITS,
  MacContactItem,
  MacContactKey,
  MacContactPushItem,
  MacContactsKey,
  MacContactsListed,
  MacContactsView,
  removalNeedsConfirm,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Mac contacts. Synthetic values: reserved domains, 555 numbers.

const ULID = "01JB0000000000000000000000";
const OTHER = "01JB0000000000000000000001";
const item = (over: Record<string, unknown> = {}) => ({
  kind: "contact",
  key: `contact:${ULID}`,
  revision: 0,
  name: "Lena Ortiz",
  phones: ["+15555550100"],
  emails: ["lena@example.com"],
  ...over,
});

describe("MacContactKey and MacContactsKey", () => {
  it("are contact: and contacts: with a ULID, and nothing else", () => {
    expect(MacContactKey.safeParse(`contact:${ULID}`).success).toBe(true);
    expect(MacContactsKey.safeParse(`contacts:${ULID}`).success).toBe(true);
    expect(MacContactKey.safeParse(`contacts:${ULID}`).success).toBe(false);
    expect(MacContactKey.safeParse(`moment:${ULID}`).success).toBe(false);
    expect(MacContactKey.safeParse("contact:lena@example.com").success).toBe(false);
  });
});

describe("MacContactItem", () => {
  it("parses a contact with a phone, an email, a nickname, or either alone", () => {
    expect(MacContactItem.safeParse(item()).success).toBe(true);
    expect(MacContactItem.safeParse(item({ nickname: "Lee" })).success).toBe(true);
    expect(MacContactItem.safeParse(item({ emails: [] })).success).toBe(true);
    expect(MacContactItem.safeParse(item({ phones: [] })).success).toBe(true);
  });

  it("refuses a contact with neither a phone nor an email", () => {
    expect(MacContactItem.safeParse(item({ phones: [], emails: [] })).success).toBe(false);
  });

  it("takes phones in E.164 form alone", () => {
    for (const phone of ["5555550100", "(555) 555-0100", "+1 555 555 0100", "+05555550100", "12345"])
      expect(MacContactItem.safeParse(item({ phones: [phone] })).success).toBe(false);
  });

  it("takes emails in lower case alone", () => {
    for (const email of ["Lena@example.com", "Lena Ortiz <lena@example.com>", "lena", "lena@example"])
      expect(MacContactItem.safeParse(item({ emails: [email] })).success).toBe(false);
  });

  it("takes each list in strictly increasing order, each value once", () => {
    expect(MacContactItem.safeParse(item({ phones: ["+15555550100", "+15555550101"] })).success).toBe(true);
    expect(MacContactItem.safeParse(item({ phones: ["+15555550101", "+15555550100"] })).success).toBe(false);
    expect(MacContactItem.safeParse(item({ phones: ["+15555550100", "+15555550100"] })).success).toBe(false);
    expect(MacContactItem.safeParse(item({ emails: ["b@example.com", "a@example.com"] })).success).toBe(false);
  });

  it("bounds the name and the lists", () => {
    expect(MacContactItem.safeParse(item({ name: "x".repeat(MAC_CONTACT_LIMITS.name) })).success).toBe(true);
    expect(MacContactItem.safeParse(item({ name: "x".repeat(MAC_CONTACT_LIMITS.name + 1) })).success).toBe(false);
    const phones = Array.from(
      { length: MAC_CONTACT_LIMITS.phones + 1 },
      (_, n) => `+1555555${String(n).padStart(4, "0")}`,
    );
    expect(MacContactItem.safeParse(item({ phones })).success).toBe(false);
  });

  it("refuses an empty name, white space at either end and a control character", () => {
    for (const name of ["", " Lena", "Lena ", "Le\u0000na", "Le\u0007na", "Lena\nOrtiz", "Lena\tOrtiz"])
      expect(MacContactItem.safeParse(item({ name })).success).toBe(false);
  });

  it("is strict: no organization, note, birthday, address or the address book's id", () => {
    for (const extra of [
      { organization: "Example Co" },
      { note: "x" },
      { birthday: "1990-01-01" },
      { postal: "x" },
      { recordId: "x" },
      { compartment: "own" },
    ]) {
      expect(MacContactItem.safeParse(item(extra)).success).toBe(false);
    }
  });
});

describe("MacContactsListed", () => {
  const listing = (over: Record<string, unknown> = {}) => ({
    kind: "contacts",
    key: `contacts:${ULID}`,
    revision: 0,
    keys: [`contact:${ULID}`, `contact:${OTHER}`],
    ...over,
  });

  it("parses a listing and an empty one", () => {
    expect(MacContactsListed.safeParse(listing()).success).toBe(true);
    expect(MacContactsListed.safeParse(listing({ keys: [] })).success).toBe(true);
  });

  it("refuses a key twice, another kind's key, a revision but 0 and any other field", () => {
    expect(MacContactsListed.safeParse(listing({ keys: [`contact:${ULID}`, `contact:${ULID}`] })).success).toBe(false);
    expect(MacContactsListed.safeParse(listing({ keys: [`moment:${ULID}`] })).success).toBe(false);
    expect(MacContactsListed.safeParse(listing({ revision: 1 })).success).toBe(false);
    expect(MacContactsListed.safeParse(listing({ confirmed: true })).success).toBe(false);
  });

  it("holds at most the listing bound", () => {
    const keys = Array.from(
      { length: MAC_CONTACT_LIMITS.listed + 1 },
      (_, n) => `contact:01JB${String(n).padStart(22, "0")}`,
    );
    expect(MacContactsListed.safeParse(listing({ keys })).success).toBe(false);
  });

  it("is one of the two push items, told apart by kind", () => {
    expect(MacContactPushItem.parse(listing()).kind).toBe("contacts");
    expect(MacContactPushItem.parse(item()).kind).toBe("contact");
  });
});

describe("removalNeedsConfirm", () => {
  it("asks before a listing keeps none of a non-empty set", () => {
    expect(removalNeedsConfirm(1, 0)).toBe(true);
    expect(removalNeedsConfirm(3, 0)).toBe(true);
    expect(removalNeedsConfirm(0, 0)).toBe(false);
  });

  it("asks before more than 5 and more than half go, and not otherwise", () => {
    expect(removalNeedsConfirm(20, 9)).toBe(true);
    expect(removalNeedsConfirm(20, 10)).toBe(false);
    expect(removalNeedsConfirm(20, 14)).toBe(false);
    expect(removalNeedsConfirm(11, 5)).toBe(true);
    expect(removalNeedsConfirm(12, 6)).toBe(false);
    expect(removalNeedsConfirm(8, 3)).toBe(false);
    expect(removalNeedsConfirm(10, 10)).toBe(false);
    expect(removalNeedsConfirm(10, 12)).toBe(false);
  });
});

describe("MacContactsView", () => {
  it("is counts only, its drops by code", () => {
    expect(MAC_CONTACT_DROPS).toContain("outranked");
    expect(MacContactsView.safeParse({ device: "mac", on: true, stored: 3, dropped: { outranked: 1 } }).success).toBe(
      true,
    );
    expect(MacContactsView.safeParse({ device: "mac", on: true, stored: 3, dropped: { lena: 1 } }).success).toBe(false);
  });
});
