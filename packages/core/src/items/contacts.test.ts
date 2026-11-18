import { createHash } from "node:crypto";
import { RawItem, SourceAccountId, type Timestamp } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { CONTACT_LIMITS, contactDeletion, contactItem, contactKept, whitelistedContact } from "./contacts.ts";

// n1.1 and n1.2: a saved contact before it reaches the store. Hand-written People answers on
// reserved domains.

const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const now = "2026-03-04T10:00:00Z" as Timestamp;
const at = { sourceAccount: account, changeKind: "backfill" as const, now };
const own = { metadata: { source: { type: "CONTACT", id: "c1" } } };
const profile = { metadata: { source: { type: "PROFILE", id: "p1" } } };
const email = (value: string, from = own) => ({ ...from, value, type: "home" });

const person = (over: Record<string, unknown> = {}) => ({
  resourceName: "people/c1",
  etag: "%Eg",
  metadata: { sources: [{ type: "CONTACT", id: "c1", updateTime: "2026-02-01T09:00:00Z" }] },
  names: [{ ...own, displayName: "Maren Holt", givenName: "Maren" }],
  nicknames: [{ ...own, value: "Mare" }],
  emailAddresses: [email("maren@example.org")],
  phoneNumbers: [{ ...own, value: "(555) 555-0101", canonicalForm: "+15555550101", type: "mobile" }],
  organizations: [{ ...own, name: "Example Works", title: "Engineer", department: "R&D" }],
  birthdays: [{ ...own, date: { year: 1990, month: 3, day: 4 }, text: "March 4" }],
  photos: [{ ...own, url: "https://example.org/p.jpg" }],
  biographies: [{ ...own, value: "a note" }],
  addresses: [{ ...own, formattedValue: "1 Example Street" }],
  relations: [{ ...own, person: "Sam" }],
  ...over,
});

const read = (value: unknown) => {
  const result = whitelistedContact(value);
  if (result === null) throw new Error("refused");
  return result;
};
const payloadOf = (item: RawItem) =>
  JSON.parse(Buffer.from(item.payload, "base64").toString("utf8")) as Record<string, unknown>;
const item = (value: unknown, when = at) => {
  const made = contactItem(read(value), when);
  return RawItem.parse(made);
};

describe("whitelistedContact", () => {
  it("the output equals the whitelist", () => {
    expect(read(person())).toEqual({
      contact: {
        resourceName: "people/c1",
        updated: "2026-02-01T09:00:00Z",
        names: ["Maren Holt"],
        nicknames: ["Mare"],
        addresses: ["maren@example.org"],
        phones: [{ value: "(555) 555-0101", canonical: "+15555550101", type: "mobile" }],
        organizations: [{ name: "Example Works", title: "Engineer" }],
        birthday: { month: 3, day: 4 },
      },
      allAddresses: ["maren@example.org"],
      badAddresses: 0,
      refused: [],
    });
  });

  it("a value from a profile source is dropped", () => {
    const got = read(
      person({
        names: [
          { ...profile, displayName: "Profile Name" },
          { ...own, displayName: "Maren Holt" },
        ],
        emailAddresses: [email("profile@example.org", profile), email("maren@example.org")],
        phoneNumbers: [{ ...profile, value: "555-0199" }],
        birthdays: [{ ...profile, date: { month: 1, day: 1 } }],
        organizations: [{ value: "no metadata", name: "No Source" }],
      }),
    );
    expect(got.contact.names).toEqual(["Maren Holt"]);
    expect(got.allAddresses).toEqual(["maren@example.org"]);
    expect(got.contact.phones).toEqual([]);
    expect(got.contact.organizations).toEqual([]);
    expect(got.contact.birthday).toBeUndefined();
  });

  it("a list is cut at its bound and a long value is dropped", () => {
    const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
    const got = read(
      person({
        names: [
          { ...own, displayName: "x".repeat(CONTACT_LIMITS.textChars + 1) },
          ...many(7, (i) => ({ ...own, displayName: `Name ${i}` })),
        ],
        nicknames: many(7, (i) => ({ ...own, value: `Nick ${i}` })),
        phoneNumbers: many(25, (i) => ({ ...own, value: `555-01${String(i).padStart(2, "0")}` })),
        organizations: many(7, (i) => ({ ...own, name: `Org ${i}` })),
      }),
    );
    expect(got.contact.names).toEqual(["Name 0", "Name 1", "Name 2", "Name 3", "Name 4"]);
    expect(got.contact.nicknames).toHaveLength(CONTACT_LIMITS.nicknames);
    expect(got.contact.phones).toHaveLength(CONTACT_LIMITS.phones);
    expect(got.contact.organizations).toHaveLength(CONTACT_LIMITS.organizations);
    // A name of exactly the bound is kept.
    expect(
      read(person({ names: [{ ...own, displayName: "é".repeat(CONTACT_LIMITS.textChars) }] })).contact.names,
    ).toHaveLength(1);
  });

  it("a kept field of the wrong type refuses the contact", () => {
    expect(whitelistedContact(person({ names: "Maren" }))).toBeNull();
    expect(whitelistedContact(person({ emailAddresses: [{ ...own, value: 7 }] }))).toBeNull();
    expect(whitelistedContact(person({ birthdays: [{ ...own, date: { month: "3", day: 4 } }] }))).toBeNull();
    expect(whitelistedContact({ ...person(), resourceName: undefined })).toBeNull();
    expect(whitelistedContact("people/c1")).toBeNull();
    // A field that is not kept is never read, whatever its type.
    expect(whitelistedContact(person({ photos: "not a list" }))).not.toBeNull();
  });

  it("a 25-address contact keeps 20 in its payload and every one in allAddresses", () => {
    const addresses = Array.from({ length: 25 }, (_, i) => email(`a${i}@example.org`));
    const got = read(person({ emailAddresses: addresses }));
    expect(got.contact.addresses).toHaveLength(CONTACT_LIMITS.addresses);
    expect(got.allAddresses).toHaveLength(25);
    expect(item(person({ emailAddresses: addresses })).permissions).toEqual({
      scope: "listed",
      identifiers: got.allAddresses,
    });
  });

  it("display-form address: `Name <a@example.com>` gives `a@example.com`; a value with CR LF, a comma, a display name without an addr-spec, or a letter outside ASCII is dropped and counted in badAddresses, and the item carries the marker bad_address", () => {
    const got = read(
      person({
        emailAddresses: [
          email("Maren Holt <Maren@Example.org>"),
          email("a@example.org\r\nBcc: b@example.org"),
          email("a@example.org, b@example.org"),
          email("Maren Holt"),
          email("jürgen@example.org"),
          email("MAREN@example.org"),
        ],
      }),
    );
    expect(got.allAddresses).toEqual(["maren@example.org"]);
    expect(got.badAddresses).toBe(4);
    expect(item(person({ emailAddresses: [email("Maren Holt")] })).markers.slice(0, 2)).toEqual([
      "contact",
      "bad_address",
    ]);
    expect(item(person()).markers).toEqual(["contact"]);
  });

  it("a value with a leading space is trimmed and read", () => {
    expect(read(person({ emailAddresses: [email(" maren@example.org\t")] })).allAddresses).toEqual([
      "maren@example.org",
    ]);
    expect(read(person({ emailAddresses: [email("  Maren <maren@example.org> ")] })).allAddresses).toEqual([
      "maren@example.org",
    ]);
  });

  it("a refused value's normalizeAddress form is a refused: marker, and the tag does not change with it", () => {
    const got = read(
      person({
        emailAddresses: [email("maren@example.org"), email("Jürgen <Jürgen@Example.org>"), email("Maren Holt")],
      }),
    );
    expect(got.badAddresses).toBe(2);
    expect(got.refused).toEqual(["jürgen@example.org"]);
    const made = item(
      person({
        emailAddresses: [email("maren@example.org"), email("Jürgen <Jürgen@Example.org>"), email("Maren Holt")],
      }),
    );
    expect(made.markers).toEqual(["contact", "bad_address", "refused:jürgen@example.org"]);
    expect(made.revisionTag).toBe(item(person()).revisionTag);
  });

  it("a birthday keeps its month and day and no year", () => {
    const got = read(person());
    expect(got.contact.birthday).toEqual({ month: 3, day: 4 });
    expect(JSON.stringify(payloadOf(item(person())))).not.toContain("1990");
    // A birthday with a text and no date is none.
    expect(read(person({ birthdays: [{ ...own, text: "spring" }] })).contact.birthday).toBeUndefined();
  });
});

describe("contactItem", () => {
  it("a contact is a crm item whose tag is the hash of its kept content", () => {
    const made = item(person());
    const payload = payloadOf(made);
    const { updated: _updated, ...kept } = payload;
    expect(made).toMatchObject({
      sourceKind: "crm",
      sourceAccount: account,
      sourceItemId: "contact:people/c1",
      observedAt: "2026-02-01T09:00:00Z",
      depth: "full",
      changeKind: "backfill",
      mediaType: "application/json",
      markers: ["contact"],
    });
    expect(made.sender).toBeUndefined();
    expect(made.addressees).toBeUndefined();
    expect(Object.keys(payload)).toEqual([
      "resourceName",
      "updated",
      "names",
      "nicknames",
      "addresses",
      "phones",
      "organizations",
      "birthday",
    ]);
    const hash = createHash("sha256")
      .update(`${JSON.stringify(kept)}\nmaren@example.org`)
      .digest("hex");
    expect(made.revisionTag).toBe(`c:${hash}`);
  });

  it("two answers differing only in updateTime and a photo make the same tag, and observedAt follows updateTime", () => {
    const later = person({
      metadata: { sources: [{ type: "CONTACT", id: "c1", updateTime: "2026-02-09T09:00:00Z" }] },
      photos: [],
    });
    expect(item(later).revisionTag).toBe(item(person()).revisionTag);
    expect(item(later).observedAt).toBe("2026-02-09T09:00:00Z");
    expect(
      item(person({ metadata: { sources: [{ type: "CONTACT", id: "c1", updateTime: "yesterday" }] } })).observedAt,
    ).toBe(now);
  });

  it("a contact that gains a 21st address is a new revision, and one that only reorders its addresses past the twentieth is not", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => email(`a${i}@example.org`));
    const tag = (list: unknown[]) => item(person({ emailAddresses: list })).revisionTag;
    expect(tag([...twenty, email("x@example.org")])).not.toBe(tag(twenty));
    expect(tag([...twenty, email("x@example.org"), email("y@example.org")])).toBe(
      tag([...twenty, email("y@example.org"), email("x@example.org")]),
    );
  });

  it("two orders of the same fields make the same payload", () => {
    const reordered = Object.fromEntries(Object.entries(person()).reverse());
    expect(item(reordered).payload).toBe(item(person()).payload);
    expect(
      item(
        person({ phoneNumbers: [{ type: "mobile", canonicalForm: "+15555550101", value: "(555) 555-0101", ...own }] }),
      ).payload,
    ).toBe(item(person()).payload);
  });

  it("the item parses as RawItem, with its addresses as its listed identifiers", () => {
    const made = contactItem(
      read(person({ emailAddresses: [email("b@example.org"), email("a@example.org"), email("b@example.org")] })),
      at,
    );
    expect(RawItem.safeParse(made).success).toBe(true);
    expect(made.permissions).toEqual({ scope: "listed", identifiers: ["b@example.org", "a@example.org"] });
  });

  it("contactDeletion names the item by its resource name", () => {
    expect(contactDeletion("people/c1", { sourceAccount: account, now })).toEqual({
      sourceAccount: account,
      sourceItemId: "contact:people/c1",
      deletedAt: now,
    });
  });
});

describe("contactKept", () => {
  const owner = ["avery@example.org"];

  it("a contact with no address and no phone in E.164 form is no_address, and the owner's own is own_contact", () => {
    expect(contactKept(item(person({ emailAddresses: [], phoneNumbers: [] })), owner)).toBe("no_address");
    expect(
      contactKept(item(person({ emailAddresses: [], phoneNumbers: [{ ...own, value: "555 0101" }] })), owner),
    ).toBe("no_address");
    expect(
      contactKept(item(person({ emailAddresses: [email("avery@example.org"), email("quinn@example.net")] })), owner),
    ).toBe("own_contact");
    expect(contactKept(item(person()), owner)).toBe("keep");
  });

  it("an address that R3's strict reading refuses is no address", () => {
    expect(
      contactKept(item(person({ emailAddresses: [email("Maren Holt"), email("a@b, c@d")], phoneNumbers: [] })), owner),
    ).toBe("no_address");
  });

  it("a phone-only contact is keyed tel: by its one E.164 number; an address wins; a national form or two numbers key nothing", () => {
    const phone = (value: string, canonicalForm?: string) => ({
      ...own,
      value,
      ...(canonicalForm === undefined ? {} : { canonicalForm }),
      type: "mobile",
    });
    const keyed = item(person({ emailAddresses: [] }));
    expect(contactKept(keyed, owner)).toBe("keep");
    expect(keyed.permissions).toEqual({ scope: "listed", identifiers: ["tel:+15555550101"] });
    expect(payloadOf(keyed).addresses).toEqual(["tel:+15555550101"]);
    // Its value once spaces, dashes, dots and brackets go; the same number twice is one.
    expect(
      item(person({ emailAddresses: [], phoneNumbers: [phone("+1 (555) 555.01-02"), phone("+15555550102")] }))
        .permissions,
    ).toEqual({ scope: "listed", identifiers: ["tel:+15555550102"] });
    // An address keeps its address as its one identifier.
    expect(item(person()).permissions).toEqual({ scope: "listed", identifiers: ["maren@example.org"] });
    // No country code is guessed; two numbers would be two identifiers.
    for (const phones of [[phone("(555) 555-0101")], [phone("+15555550101"), phone("+15555550199")]]) {
      expect(
        contactKept(item(person({ emailAddresses: [], phoneNumbers: phones })), owner),
        JSON.stringify(phones),
      ).toBe("no_address");
    }
  });

  it("an owner address in another case is still the owner's", () => {
    expect(contactKept(item(person({ emailAddresses: [email("Avery@Example.ORG")] })), ["AVERY@example.org"])).toBe(
      "own_contact",
    );
  });

  it("a 25-address contact whose 22nd address is the owner's is own_contact", () => {
    const addresses = Array.from({ length: 25 }, (_, i) => email(i === 21 ? "avery@example.org" : `a${i}@example.org`));
    expect(contactKept(item(person({ emailAddresses: addresses })), owner)).toBe("own_contact");
  });
});
