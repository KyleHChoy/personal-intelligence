import { RawItem, SourceAccountId, type Timestamp } from "@intelligence/contracts";
import type { MacContactItem } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { contactKept } from "./contacts.ts";
import { macContactItem, macContactItemId } from "./mac-contacts.ts";

// A Mac contact as a saved contact's source item. Synthetic values: reserved domains, 555 numbers.

const sourceAccount = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const now = "2026-10-23T10:00:00.000Z" as Timestamp;
const at = { sourceAccount, now };
const ULID = "01JB0000000000000000000000";
const lena = (over: Partial<MacContactItem> = {}): MacContactItem => ({
  kind: "contact",
  key: `contact:${ULID}`,
  revision: 0,
  name: "Lena Ortiz",
  phones: ["+15555550100"],
  emails: [],
  ...over,
});
const payloadOf = (raw: RawItem) =>
  JSON.parse(Buffer.from(raw.payload, "base64").toString("utf8")) as Record<string, unknown>;
const identifiers = (raw: RawItem): string[] => (raw.permissions.scope === "listed" ? raw.permissions.identifiers : []);

describe("macContactItem", () => {
  it("a phone-only Mac contact lists its phone key as its one identifier, and contactKept keeps it", () => {
    const raw = macContactItem(lena(), at);
    expect(RawItem.safeParse(raw).success).toBe(true);
    expect(identifiers(raw)).toEqual(["tel:+15555550100"]);
    expect(contactKept(raw, ["owner@example.com"])).toBe("keep");
    expect(raw).toMatchObject({
      sourceKind: "crm",
      sourceAccount,
      sourceItemId: `contact:lens:${ULID}`,
      observedAt: now,
      changeKind: "live",
      markers: ["contact"],
    });
    expect(payloadOf(raw)).toEqual({
      resourceName: `lens:${ULID}`,
      names: ["Lena Ortiz"],
      nicknames: [],
      addresses: ["tel:+15555550100"],
      phones: [{ value: "+15555550100", canonical: "+15555550100" }],
      organizations: [],
    });
  });

  it("one with two phones and no email lists none and is no_address", () => {
    const raw = macContactItem(lena({ phones: ["+15555550100", "+15555550101"] }), at);
    expect(identifiers(raw)).toEqual([]);
    expect(contactKept(raw, [])).toBe("no_address");
  });

  it("one with emails lists them, and not its phone key; its nickname is kept; the owner's address is own_contact", () => {
    const raw = macContactItem(lena({ nickname: "Lee", emails: ["lena@example.com", "lena.ortiz@example.org"] }), at);
    expect(identifiers(raw)).toEqual(["lena@example.com", "lena.ortiz@example.org"]);
    expect(payloadOf(raw)).toMatchObject({
      names: ["Lena Ortiz"],
      nicknames: ["Lee"],
      addresses: ["lena@example.com", "lena.ortiz@example.org"],
    });
    expect(contactKept(raw, ["Lena@Example.com"])).toBe("own_contact");
  });

  it("the revision tag is unchanged for an unchanged entry, whatever Lens's revision, and changes with a name, a phone or an email", () => {
    const tag = macContactItem(lena(), at).revisionTag;
    expect(
      macContactItem(lena({ revision: 7 }), { ...at, now: "2026-10-30T10:00:00.000Z" as Timestamp }).revisionTag,
    ).toBe(tag);
    for (const changed of [
      lena({ name: "Lena M. Ortiz" }),
      lena({ phones: ["+15555550102"] }),
      lena({ emails: ["lena@example.com"] }),
      lena({ nickname: "Lee" }),
    ]) {
      expect(macContactItem(changed, at).revisionTag).not.toBe(tag);
    }
  });

  it("macContactItemId is the source item id of a key: its ULID after `contact:lens:`", () => {
    expect(macContactItemId(`contact:${ULID}`)).toBe(`contact:lens:${ULID}`);
  });
});
