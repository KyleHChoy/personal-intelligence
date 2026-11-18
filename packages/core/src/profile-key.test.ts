import { EvidenceId, type IdentityResolver, LocalEntityId, Timestamp } from "@intelligence/contracts";
import { ContactMapping, SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { importItem, readContacts } from "./items/contact-import.ts";
import { contactKept } from "./items/contacts.ts";
import { deriveItem } from "./items/derive.ts";
import type { ItemContext } from "./items/types.ts";
import { PERSONAL_LIMITS } from "./limits.ts";
import {
  contactPhoneKey,
  e164Of,
  isMintedKey,
  isNamedKey,
  isPhoneKey,
  isProfileKey,
  isProposalKey,
  meetingKey,
  namedKey,
  phoneKey,
  phoneRegionOf,
  profileKey,
  proposalKey,
} from "./profile-key.ts";
import { csvOf } from "./test-support/contact-files.ts";

// Contact import: a LinkedIn profile URL is the identity key of an imported row with no address,
// and nothing else. Made-up profiles and reserved domains.

const PROFILE = "profile:linkedin.com/in/lena-ortiz-example";

describe("profileKey", () => {
  it("folds a LinkedIn profile URL to one key: host, country subdomain, case, query, fragment, trailing slash and sub-pages", () => {
    for (const url of [
      "https://www.linkedin.com/in/lena-ortiz-example",
      "http://linkedin.com/in/Lena-Ortiz-Example/",
      "https://uk.linkedin.com/in/lena-ortiz-example?trk=public#about",
      "www.linkedin.com/in/lena-ortiz-example/details/experience/",
    ])
      expect(profileKey(url), url).toBe(PROFILE);
  });

  // A scheme in any case, so an import row whose link folds gets
  // its identity key too.
  it("reads a scheme in any case", () => {
    for (const written of ["HTTPS://www.linkedin.com/in/Jane-Example", "Http://linkedin.com/in/jane-example/"])
      expect(profileKey(written), written).toBe("profile:linkedin.com/in/jane-example");
  });

  it("gives one key for a slug written composed or decomposed", () => {
    expect(profileKey("linkedin.com/in/josé-example")).toBe(profileKey("linkedin.com/in/josé-example"));
  });

  it("is no key for another site, a company page, or no slug", () => {
    expect([
      profileKey("https://example.com/in/lena"),
      profileKey("https://www.linkedin.com/company/fern-bank"),
      profileKey("https://www.linkedin.com/in/"),
      profileKey("not a url at all"),
    ]).toEqual([null, null, null, null]);
  });

  it("is checked for its exact shape wherever the prefix would be trusted", () => {
    expect(isProfileKey(PROFILE)).toBe(true);
    for (const forged of [
      "profile:evil.example/in/x",
      "profile:linkedin.com/in/a@b.example",
      "profile:linkedin.com/in/x/y",
      "profile:linkedin.com/in/",
      "profile:linkedin.com/in/a b",
    ])
      expect(isProfileKey(forged), forged).toBe(false);
  });
});

// A meeting participant's key, made by the writer and never a way to reach anyone.
describe("a meeting participant's key", () => {
  it("is exactly profile:meeting/ and 64 hex, a profile key, and minted like a proposal's; a LinkedIn key is not minted", () => {
    const key = meetingKey("ab".repeat(32));
    expect(key).toBe(`profile:meeting/${"ab".repeat(32)}`);
    expect(isProfileKey(key as string)).toBe(true);
    expect(isMintedKey(key as string)).toBe(true);
    expect(isProposalKey(key as string)).toBe(false);
    expect(isMintedKey(proposalKey("cd".repeat(32)) as string)).toBe(true);
    expect(isMintedKey(PROFILE)).toBe(false);
    for (const forged of ["AB".repeat(32), "ab".repeat(31), `${"ab".repeat(32)}0`, "x@y.example"]) {
      expect(meetingKey(forged), forged).toBeNull();
      expect(isProfileKey(`profile:meeting/${forged}`), forged).toBe(false);
    }
  });
});

describe("a named person's key", () => {
  it("namedKey refuses any other shape", () => {
    const key = namedKey("ab".repeat(32));
    expect(key).toBe(`profile:named/${"ab".repeat(32)}`);
    expect([isNamedKey(key as string), isProfileKey(key as string), isMintedKey(key as string)]).toEqual([
      true,
      true,
      true,
    ]);
    expect([
      isProposalKey(key as string),
      isNamedKey(meetingKey("ab".repeat(32)) as string),
      isNamedKey(PROFILE),
    ]).toEqual([false, false, false]);
    for (const forged of [
      "AB".repeat(32),
      "ab".repeat(31),
      `${"ab".repeat(32)}0`,
      "x@y.example",
      "",
      `../${"ab".repeat(31)}`,
    ]) {
      expect(namedKey(forged), forged).toBeNull();
      expect(isNamedKey(`profile:named/${forged}`), forged).toBe(false);
      expect(isProfileKey(`profile:named/${forged}`), forged).toBe(false);
    }
  });
});

const at = {
  sourceAccount: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  now: Timestamp.parse("2026-10-09T12:00:00.000Z"),
  id: "import:row",
};
const item = (row: Record<string, string>) => {
  const [record] = readContacts("mapped-csv", csvOf(["Name", "Email", "LinkedIn"], [row]), {
    mapping: ContactMapping.parse({ name: ["Name"], emails: ["Email"], profiles: ["LinkedIn"] }),
    now: new Date("2026-10-09T12:00:00.000Z"),
  }).records;
  if (record === undefined) throw new Error("no record");
  return importItem(record, at);
};
const resolver: IdentityResolver = {
  resolve: async (mention) => ({
    outcome: "created",
    entity: LocalEntityId.parse(`ent:${mention.key.value}`),
    epoch: 0,
  }),
};
const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("ev-import-1"),
  revision: 0,
  compartment: "own",
  ownerAddresses: ["owner@quinn.test"],
  ownerEntity: LocalEntityId.parse("ent-owner"),
  identity: resolver,
};

describe("an imported row's profile", () => {
  it("is the one identifier of a row with no address, so the row is a contact that names its person", async () => {
    const raw = item({ Name: "Lena Ortiz", LinkedIn: "https://www.linkedin.com/in/Lena-Ortiz-Example/" });
    expect(raw.permissions).toEqual({ scope: "listed", identifiers: [PROFILE] });
    expect(contactKept(raw, [])).toBe("keep");
    const facts = await deriveItem(raw, ctx, PERSONAL_LIMITS);
    expect(facts.kind === "contact" ? [facts.people, facts.names] : null).toEqual([
      [{ entity: `ent:${PROFILE}`, address: PROFILE }],
      [{ entity: `ent:${PROFILE}`, name: "Lena Ortiz" }],
    ]);
  });

  it("is no identifier of a row with an address: the address alone resolves, and the profile stays data", () => {
    const raw = item({
      Name: "Lena Ortiz",
      Email: "lena@profile-import.test",
      LinkedIn: "linkedin.com/in/lena-ortiz-example",
    });
    expect(raw.permissions).toEqual({ scope: "listed", identifiers: ["lena@profile-import.test"] });
    const payload = JSON.parse(Buffer.from(raw.payload, "base64").toString("utf8")) as {
      addresses: string[];
      imported: { profiles: string[] };
    };
    expect(payload.addresses).toEqual(["lena@profile-import.test"]);
    expect(payload.imported.profiles).toEqual(["linkedin.com/in/lena-ortiz-example"]);
  });

  it("is no identifier when it is not LinkedIn's, so such a row is no contact", () => {
    expect(contactKept(item({ Name: "Lena Ortiz", LinkedIn: "https://example.com/lena" }), [])).toBe("no_address");
  });
});

describe("the phone key", () => {
  it("is tel: and an E.164 number, resolved and suppressed as a profile key is and served by no reader as an address", () => {
    expect(phoneKey("+15555550101")).toBe("tel:+15555550101");
    for (const bad of ["5555550101", "+05555550101", "+1555", "+1555555010199999", "tel:+15555550101"])
      expect(phoneKey(bad), bad).toBeNull();
    expect(isPhoneKey("tel:+15555550101")).toBe(true);
    expect(isPhoneKey("tel:5555550101")).toBe(false);
    expect([isProfileKey("tel:+15555550101"), isMintedKey("tel:+15555550101")]).toEqual([true, true]);
  });

  it("reads a phone's canonical form, else its value without spaces, dashes, dots and brackets, and guesses no country code", () => {
    expect(e164Of({ value: "(555) 555-0101", canonical: "+15555550101" })).toBe("+15555550101");
    expect(e164Of({ value: "+1 (555) 555.01-01" })).toBe("+15555550101");
    expect(e164Of({ value: "(555) 555-0101" })).toBeNull();
    expect(e164Of({ value: "555 0101", canonical: null })).toBeNull();
  });

  // The owner's region reads a national number of the plan's shape, and nothing else.
  it("in a time zone of the North American plan, reads a ten-digit number of its shape, or 1 and one, as +1; nothing else, and nothing in any other zone", () => {
    expect(
      [
        "America/Chicago",
        "US/Central",
        "America/Indianapolis",
        "America/Toronto",
        "Pacific/Honolulu",
        "America/Puerto_Rico",
      ].map(phoneRegionOf),
    ).toEqual(["1", "1", "1", "1", "1", "1"]);
    expect(
      [
        "America/Mexico_City",
        "America/Bogota",
        "America/Sao_Paulo",
        "Europe/London",
        "Asia/Shanghai",
        "UTC",
        "Not/AZone",
      ].map(phoneRegionOf),
    ).toEqual([null, null, null, null, null, null, null]);
    expect(phoneRegionOf(null)).toBeNull();
    for (const value of ["(555) 555-0101", "555.555.0101", "1-555-555-0101", "1 (555) 555 0101", "5555550101"])
      expect(e164Of({ value }, "1"), value).toBe("+15555550101");
    // The canonical form and a written E.164 number come first, whatever the region.
    expect(e164Of({ value: "(555) 555-0101", canonical: "+445555550101" }, "1")).toBe("+445555550101");
    expect(e164Of({ value: "+44 20 5555 0101" }, "1")).toBe("+442055550101");
    // Not the plan's shape: seven digits, an area code or exchange from 0 or 1, eleven digits not
    // from 1, an extension, a letter.
    for (const value of [
      "555-0101",
      "(155) 555-0101",
      "(555) 155-0101",
      "25555550101",
      "(555) 555-0101 x12",
      "555-555-01O1",
    ])
      expect(e164Of({ value }, "1"), value).toBeNull();
    // With no region.
    expect(e164Of({ value: "(555) 555-0101" }, null)).toBeNull();
  });

  it("keys a contact by its phones only when they give exactly one number", () => {
    expect(contactPhoneKey([{ value: "+15555550101" }, { value: "+1 555 555 0101" }, { value: "555-0199" }])).toBe(
      "tel:+15555550101",
    );
    expect(contactPhoneKey([{ value: "+15555550101" }, { value: "+15555550102" }])).toBeNull();
    expect(contactPhoneKey([])).toBeNull();
  });

  it("is the one identifier of an imported row with no address and no LinkedIn profile", () => {
    const [record] = readContacts(
      "mapped-csv",
      csvOf(["Name", "Phone"], [{ Name: "Sol Brandt", Phone: "+15555550111" }]),
      {
        mapping: ContactMapping.parse({ name: ["Name"], phones: ["Phone"] }),
        now: new Date("2026-10-09T12:00:00.000Z"),
      },
    ).records;
    if (record === undefined) throw new Error("no record");
    const raw = importItem(record, at);
    expect(raw.permissions).toEqual({ scope: "listed", identifiers: ["tel:+15555550111"] });
    expect(contactKept(raw, [])).toBe("keep");
  });
});
