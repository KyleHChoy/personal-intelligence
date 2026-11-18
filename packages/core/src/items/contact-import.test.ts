import { SourceAccountId, Timestamp } from "@intelligence/contracts";
import { ContactMapping, type ContactMappingInput, type ImportedContact } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  csvOf,
  GOOGLE_CONTACTS,
  GOOGLE_CONTACTS_OLD,
  LINKEDIN_CONNECTIONS,
  RESEARCH_SHEET,
  RESEARCH_SHEET_MAPPING,
} from "../test-support/contact-files.ts";
import { dateOf, importItem, readContacts } from "./contact-import.ts";
import { contactKept } from "./contacts.ts";

// Contact import: the adapters, the mapping and the item builder, on the synthetic files of
// personal-core's testing entry.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
};
const byKey = (records: ImportedContact[], key: string): ImportedContact => {
  const found = records.find((one) => one.key === key);
  if (found === undefined) throw new Error(`no record ${key}`);
  return found;
};
const mapped = (mapping: ContactMappingInput, text: string) =>
  readContacts("mapped-csv", text, { mapping: ContactMapping.parse(mapping), now: NOW });
// A keyed id, as the pi command makes one: any function of the key that does not repeat it.
const id = (key: string): string => `import:${Buffer.from(key).toString("base64url")}`;
const at = {
  sourceAccount: SourceAccountId.parse("acc_import_test"),
  now: Timestamp.parse("2026-10-09T12:00:00.000Z"),
};

describe("linkedin-connections", () => {
  const read = readContacts("linkedin-connections", LINKEDIN_CONNECTIONS, { now: NOW });

  it("passes over the notes before the header and reads each connection", () => {
    expect(read.refused).toEqual([]);
    expect(read.columns).toEqual({ unmapped: 0, missing: 0 });
    expect(read.rows).toBe(2);
    expect(read.records.map((one) => one.key)).toEqual([
      "email:ivo.brandt@linkedin-import.test",
      "profile:linkedin.com/in/lena-ortiz-example",
    ]);
  });

  it("joins the name, keeps the profile URL as an identifier, a quoted company whole, and the date connected as a tag", () => {
    const ivo = byKey(read.records, "email:ivo.brandt@linkedin-import.test");
    expect(ivo.names).toEqual(["Ivo Brandt"]);
    expect(ivo.role).toEqual({ title: "Partner", organization: "Brandt, Kell & Co" });
    expect(ivo.extras.profiles).toEqual(["https://www.linkedin.com/in/ivo-brandt-example"]);
    expect(ivo.extras.tags).toEqual([{ key: "Connected On", value: "14 Mar 2024" }]);
    expect(ivo.extras.provenance).toEqual({ adapter: "linkedin-connections" });
  });

  it("keys a connection with no address by its profile URL, and leaves its empty address out", () => {
    expect(byKey(read.records, "profile:linkedin.com/in/lena-ortiz-example").emails).toEqual([]);
  });

  it("is refused with missing_column when the address column is not in the header (a wrong export)", () => {
    const text = csvOf(
      ["First Name", "Last Name", "URL", "E-mail", "Company", "Position"],
      [{ "First Name": "Ivo", "Last Name": "Brandt", "E-mail": "ivo@linkedin-import.test" }],
    );
    expect(codeOf(() => readContacts("linkedin-connections", text, { now: NOW }))).toBe("missing_column");
  });
});

describe("google-contacts-csv", () => {
  it("reads the current export, splitting the values that share a cell", () => {
    const { records, refused } = readContacts("google-contacts-csv", GOOGLE_CONTACTS, { now: NOW });
    expect(refused).toEqual([]);
    expect(records).toEqual([
      {
        key: "email:maren@google-import.test",
        names: ["Maren Holt"],
        emails: ["maren@google-import.test", "m.holt@google-import.example"],
        phones: ["555-0101"],
        // Its website, a profile, is a link too.
        links: [{ url: "https://linkedin.com/in/maren-holt-example", kind: "linkedin" }],
        role: { title: "Engineer", organization: "Holt Works Example" },
        extras: {
          kind: "person",
          profiles: ["https://www.linkedin.com/in/maren-holt-example"],
          pastRoles: [],
          industries: [],
          education: [],
          boards: [],
          relations: [],
          tags: [
            { key: "Labels", value: "* myContacts" },
            { key: "Labels", value: "Friends" },
          ],
          notes: [{ key: "Notes", value: "Met at a synthetic conference." }],
          provenance: { adapter: "google-contacts-csv" },
        },
      },
    ]);
  });

  it("reads the export before it, by its own headers, with only its first address column", () => {
    const [sam] = readContacts("google-contacts-csv", GOOGLE_CONTACTS_OLD, { now: NOW }).records;
    expect(sam?.names).toEqual(["Sam Orrin"]);
    expect(sam?.emails).toEqual(["sam@google-import.test"]);
    expect(sam?.role).toEqual({ title: "Founder", organization: "Orrin Labs Example" });
  });
});

describe("mapped-csv, on a research sheet's shape", () => {
  const read = mapped(RESEARCH_SHEET_MAPPING, RESEARCH_SHEET);

  it("reads or ignores every column of the sheet, and counts its data rows once each", () => {
    expect(read.columns).toEqual({ unmapped: 0, missing: 0 });
    expect(read.rows).toBe(10);
  });

  it("refuses each bad row with its code and reads the rest", () => {
    expect(read.refused).toEqual([
      { row: 7, code: "bad_kind" },
      { row: 8, code: "no_name" },
      { row: 9, code: "duplicate_key" },
      { row: 10, code: "bad_row" },
    ]);
    const kinds = read.records.map((one) => one.extras.kind);
    expect(kinds.filter((one) => one === "person").length).toBe(5);
    expect(kinds.filter((one) => one === "household").length).toBe(1);
    expect(kinds.filter((one) => one === "organization").length).toBe(2);
  });

  it("reads a verified person: a quoted title, split boards, tags under their columns, notes, confidence and the date reviewed", () => {
    const nia = byKey(read.records, "email:nia.rao@sheet-import.test");
    expect(nia.role).toEqual({ title: "Partner, Growth", organization: "Lumen Capital Example" });
    expect(nia.extras.boards).toEqual([
      { organization: "Harbor Arts Example" },
      { organization: "River School Example" },
    ]);
    expect(nia.extras.tags).toContainEqual({ key: "Spheres", value: "Arts" });
    expect(nia.extras.tags).toContainEqual({ key: "Spheres", value: "Climate" });
    expect(nia.extras.tags).toContainEqual({ key: "Status", value: "Verified — enriched from public sources" });
    expect(nia.extras.notes).toEqual([
      { key: "Focus / Context", value: "Climate fund; met once at a synthetic dinner." },
    ]);
    expect(nia.extras.provenance).toEqual({
      adapter: "mapped-csv",
      confidence: 0.9,
      standing: "verified",
      asOf: "2026-09-30",
    });
  });

  it("reads a probable person with no address and a percentage, with every empty cell left out", () => {
    const oskar = byKey(read.records, "row:2");
    expect(oskar.emails).toEqual([]);
    expect(oskar.extras.profiles).toEqual([]);
    expect(oskar.extras.provenance).toEqual({ adapter: "mapped-csv", confidence: 0.45, standing: "probable" });
  });

  it("expands a household into its two parents, each with their own title, employer and industry", () => {
    expect(byKey(read.records, "row:id:H-1").extras.kind).toBe("household");
    const [asha, dev] = [byKey(read.records, "row:id:H-1/1"), byKey(read.records, "row:id:H-1/2")];
    expect([asha.names, asha.role, asha.extras.industries, asha.extras.kind]).toEqual([
      ["Asha Rao"],
      { title: "Surgeon", organization: "Harbor Health Example" },
      ["Health"],
      "person",
    ]);
    expect([dev.names, dev.role, dev.extras.industries]).toEqual([
      ["Dev Rao"],
      { title: "Architect", organization: "Rao Studio Example" },
      ["Design"],
    ]);
  });

  it("keeps a relation to another row as its kind alone: no other row's key or name (invariant 10)", () => {
    for (const key of ["email:nia.rao@sheet-import.test", "row:id:H-1/1", "row:id:H-1/2"])
      expect(byKey(read.records, key).extras.relations).toEqual([{ kind: "household_member" }]);
    const venue = byKey(read.records, "row:4");
    expect(venue.extras.relations).toEqual([{ kind: "managed_by" }]);
    expect(JSON.stringify(read.records.map((one) => one.extras))).not.toMatch(/kai\.lund|Kai Lund|Rao Household|row:/);
    expect(read.relations).toEqual({ unresolved: 1, refused: 0 });
  });

  it("refuses a file whose quote never closes, one with no header, and one past the row bound", () => {
    expect(codeOf(() => mapped(RESEARCH_SHEET_MAPPING, 'Name\r\n"open'))).toBe("bad_csv");
    expect(codeOf(() => mapped(RESEARCH_SHEET_MAPPING, "Full Name\r\nx\r\n"))).toBe("no_header");
    expect(codeOf(() => mapped({ name: ["Name"] }, `Name\r\n${"x\r\n".repeat(20_001)}`))).toBe("too_large");
    expect(codeOf(() => readContacts("mapped-csv", "Name\r\nx\r\n", { now: NOW }))).toBe("usage");
  });
});

describe("mapped-csv's header, keys and relations", () => {
  it("takes as the header the first row with every name and address column, not a note that names one", () => {
    const text = [
      "Name",
      "a note above the header",
      csvOf(["Name", "Email"], [{ Name: "Tove Lind", Email: "tove@mapped-import.test" }]),
    ].join("\r\n");
    const { records } = mapped({ name: ["Name"], emails: ["Email"] }, text);
    expect(records.map((one) => one.key)).toEqual(["email:tove@mapped-import.test"]);
  });

  it("is refused with missing_column for a misspelt address column, and bad_header for a mapped column the header repeats", () => {
    const text = csvOf(["Name", "E-mail"], [{ Name: "Tove Lind", "E-mail": "tove@mapped-import.test" }]);
    expect(codeOf(() => mapped({ name: ["Name"], emails: ["Email"] }, text))).toBe("missing_column");
    expect(
      codeOf(() =>
        mapped(
          { name: ["Name"], emails: ["Email"] },
          "Name,Email,Email\r\nTove Lind,a@mapped-import.test,b@mapped-import.test\r\n",
        ),
      ),
    ).toBe("bad_header");
  });

  it("keys a row by the address the item builder reads, so a written name around it is no new key", () => {
    const text = csvOf(
      ["Name", "Email"],
      [
        { Name: "Ana Ruiz", Email: "Ana Ruiz <ana@mapped-import.test>" },
        { Name: "Ana R.", Email: "ana@mapped-import.test" },
      ],
    );
    const { records, refused } = mapped({ name: ["Name"], emails: ["Email"] }, text);
    expect(records.map((one) => one.key)).toEqual(["email:ana@mapped-import.test"]);
    expect(refused).toEqual([{ row: 2, code: "duplicate_key" }]);
  });

  it("keeps works_at only to an organization row, naming it, and refuses one to a person or a household", () => {
    const mapping: ContactMappingInput = {
      name: ["Name"],
      kind: { column: "Type", values: { Person: "person", Org: "organization", Home: "household" } },
      emails: ["Email"],
      relations: [{ kind: "works_at", column: "Works At", by: "name" }],
    };
    const text = csvOf(
      ["Name", "Type", "Email", "Works At"],
      [
        { Name: "Fern Bank Example", Type: "Org" },
        { Name: "Ida Moss", Type: "Person", Email: "ida@mapped-import.test", "Works At": "Fern Bank Example" },
        { Name: "Oli Park", Type: "Person", Email: "oli@mapped-import.test", "Works At": "Ida Moss" },
        { Name: "Park Home", Type: "Home" },
        { Name: "Uma Park", Type: "Person", Email: "uma@mapped-import.test", "Works At": "Park Home" },
      ],
    );
    const read = mapped(mapping, text);
    expect(read.records.map((one) => one.extras.relations)).toEqual([
      [],
      [{ kind: "works_at", name: "Fern Bank Example" }],
      [],
      [],
      [],
    ]);
    expect(read.relations).toEqual({ unresolved: 0, refused: 2 });
  });

  it("leaves out an asOf more than a day ahead or before 1900, keeping the row, and counts it", () => {
    const text = csvOf(
      ["Name", "Email", "As Of"],
      [
        { Name: "Ida Moss", Email: "ida@mapped-import.test", "As Of": "2026-10-10" },
        { Name: "Oli Park", Email: "oli@mapped-import.test", "As Of": "2026-10-12" },
        { Name: "Uma Park", Email: "uma@mapped-import.test", "As Of": "1899-12-31" },
      ],
    );
    const read = mapped({ name: ["Name"], emails: ["Email"], asOf: "As Of" }, text);
    expect(read.records.map((one) => one.extras.provenance.asOf)).toEqual(["2026-10-10", undefined, undefined]);
    expect(read.asOfDropped).toBe(2);
  });

  it("refuses a household person with data and no name, counting the household's row once", () => {
    const mapping: ContactMappingInput = {
      name: ["Name"],
      kind: { column: "Type", values: { Home: "household" } },
      household: { members: "Parents", persons: [{ title: "Title P1" }, { title: "Title P2" }] },
    };
    const read = mapped(
      mapping,
      csvOf(
        ["Name", "Type", "Parents", "Title P1", "Title P2"],
        [{ Name: "Lind Home", Type: "Home", Parents: "Tove Lind", "Title P1": "Pilot", "Title P2": "Nurse" }],
      ),
    );
    expect(read.records.map((one) => one.names[0])).toEqual(["Lind Home", "Tove Lind"]);
    expect(read.refused).toEqual([{ row: 1, code: "no_name" }]);
    expect(read.rows).toBe(1);
  });
});

// A row's links, from its link columns and its profiles, normalized, each URL once, a link cell
// that is no link dropped and counted; and its notes keyed by their columns.
describe("links", () => {
  it("reads link columns with their kind and label, then every profile, each URL once, and counts a cell that is no link", () => {
    const text = csvOf(
      ["Name", "Email", "LinkedIn", "Site", "Code", "Notes"],
      [
        {
          Name: "Ada Voss",
          Email: "ada@links-import.test",
          LinkedIn: "https://www.linkedin.com/in/Ada-Voss-Example/",
          Site: "adavoss.example/ ; javascript:alert(1)",
          Code: "https://github.com/ada-example",
          Notes: "Met at a synthetic dinner.",
        },
        { Name: "Bo Kerr", Email: "bo@links-import.test", Site: "https://user:pw@bo.example/" },
      ],
    );
    const read = mapped(
      {
        name: ["Name"],
        emails: ["Email"],
        profiles: ["LinkedIn"],
        links: [{ column: "Site", kind: "personal_site", label: "Site" }, { column: "Code" }, { column: "LinkedIn" }],
        notes: ["Notes"],
        separators: { Site: ";" },
      },
      text,
    );
    expect(read.columns).toEqual({ unmapped: 0, missing: 0 });
    expect(read.linksDropped).toBe(2);
    const ada = byKey(read.records, "email:ada@links-import.test");
    expect(ada.links).toEqual([
      { url: "https://adavoss.example", kind: "personal_site", label: "Site" },
      { url: "https://github.com/ada-example", kind: "github" },
      { url: "https://linkedin.com/in/ada-voss-example", kind: "linkedin" },
    ]);
    expect(ada.extras.notes).toEqual([{ key: "Notes", value: "Met at a synthetic dinner." }]);
    expect(byKey(read.records, "email:bo@links-import.test").links).toEqual([]);
  });

  it("puts the links in the item's payload and its tag, so a row whose link changes is a new revision", () => {
    const row = (site: string) =>
      csvOf(["Name", "Email", "Site"], [{ Name: "Ada Voss", Email: "ada@links-import.test", Site: site }]);
    const item = (site: string) => {
      const [record] = mapped({ name: ["Name"], emails: ["Email"], links: [{ column: "Site" }] }, row(site)).records;
      return importItem(record!, { ...at, id: id(record!.key) });
    };
    const payload = JSON.parse(Buffer.from(item("adavoss.example").payload, "base64").toString("utf8")) as {
      links?: unknown;
    };
    expect(payload.links).toEqual([{ url: "https://adavoss.example", kind: "other" }]);
    expect(item("https://adavoss.example/?ref=1").revisionTag).toBe(item("adavoss.example").revisionTag);
    expect(item("https://adavoss.example/next").revisionTag).not.toBe(item("adavoss.example").revisionTag);
  });

  it("the mapping takes link columns with a kind of its list and a short label, and refuses any other kind", () => {
    expect(ContactMapping.parse({ name: ["Name"] }).links).toEqual([]);
    expect(
      ContactMapping.safeParse({ name: ["Name"], links: [{ column: "Site", kind: "personal_site", label: "Site" }] })
        .success,
    ).toBe(true);
    expect(ContactMapping.safeParse({ name: ["Name"], links: [{ column: "Site", kind: "homepage" }] }).success).toBe(
      false,
    );
    expect(ContactMapping.safeParse({ name: ["Name"], links: [{ column: "Site", url: "x" }] }).success).toBe(false);
  });
});

describe("the contact mapping", () => {
  it("takes the sheet's mapping and fills its defaults", () => {
    expect(ContactMapping.parse({ name: ["Name"] })).toMatchObject({
      emails: [],
      tags: [],
      relations: [],
      separators: {},
      ignore: [],
    });
  });

  it("refuses a key it does not know, a kind it does not have, a relation of no kind and a mapping with no name column", () => {
    expect(ContactMapping.safeParse({ name: ["Name"], nickname: "Nick" }).success).toBe(false);
    expect(
      ContactMapping.safeParse({ name: ["Name"], kind: { column: "Type", values: { Ship: "spaceship" } } }).success,
    ).toBe(false);
    expect(
      ContactMapping.safeParse({ name: ["Name"], relations: [{ kind: "cousin_of", column: "C", by: "name" }] }).success,
    ).toBe(false);
    expect(ContactMapping.safeParse({ name: [] }).success).toBe(false);
  });

  it("keys a row by the longest profile URL it keeps, and leaves out a value, an id or a profile past its bound", () => {
    const url = `https://www.linkedin.com/in/${"x".repeat(500 - 28)}`;
    const text = csvOf(
      ["Name", "Profile", "Id", "Title"],
      [
        { Name: "Ada Voss", Profile: url, Id: "i".repeat(201), Title: "t".repeat(201) },
        { Name: "Bo Kerr", Profile: `${url}y`, Id: "b-2" },
      ],
    );
    const { records, refused } = mapped(
      { name: ["Name"], profiles: ["Profile"], id: { column: "Id" }, title: "Title" },
      text,
    );
    expect(refused).toEqual([]);
    expect(records.map((one) => [one.key, one.role])).toEqual([
      [`profile:${url}`, undefined],
      ["row:id:b-2", undefined],
    ]);
  });

  it("reads past roles with their dates, schools and a location, and a kind cell in any case", () => {
    const mapping: ContactMappingInput = {
      name: ["Name"],
      kind: { column: "Kind", values: { Person: "person" } },
      emails: ["Email"],
      pastRoles: [{ title: "Old Title", organization: "Old Org", from: "From", to: "To" }],
      education: ["School"],
      location: "City",
    };
    const text = csvOf(
      ["Name", "Kind", "Email", "Old Title", "Old Org", "From", "To", "School", "City"],
      [
        {
          Name: "Tove Lind",
          Kind: "PERSON",
          Email: "tove@mapped-import.test",
          "Old Title": "Analyst",
          "Old Org": "Fern Bank Example",
          From: "2015",
          To: "2019-06",
          School: "North College Example",
          City: "Portland",
        },
      ],
    );
    const [tove] = mapped(mapping, text).records;
    expect(tove?.extras.pastRoles).toEqual([
      { title: "Analyst", organization: "Fern Bank Example", from: "2015-01-01", to: "2019-06-30" },
    ]);
    expect(tove?.extras.education).toEqual(["North College Example"]);
    expect(tove?.extras.location).toBe("Portland");
  });
});

describe("dateOf", () => {
  it("reads a year, a month or a day, numbered or named, as its first day or with `end` its last", () => {
    expect([
      dateOf("2019"),
      dateOf("2019", true),
      dateOf("2024-02", true),
      dateOf("2024-2-9"),
      dateOf("14 Mar 2024"),
      dateOf("Sept 2020", true),
    ]).toEqual(["2019-01-01", "2019-12-31", "2024-02-29", "2024-02-09", "2024-03-14", "2020-09-30"]);
  });

  it("is no date for anything else", () => {
    expect([dateOf(""), dateOf("soon"), dateOf("2019-13"), dateOf("31 Feb 2024"), dateOf("3/14/2024")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("importItem", () => {
  const read = mapped(RESEARCH_SHEET_MAPPING, RESEARCH_SHEET);
  const nia = byKey(read.records, "email:nia.rao@sheet-import.test");
  const oskar = byKey(read.records, "row:2");
  const one = (record: ImportedContact) => importItem(record, { ...at, id: id(record.key) });

  it("makes a saved contact's item, keyed by the id it is given, its further fields in its payload, its time the row's date", () => {
    const raw = one(nia);
    expect(raw.sourceKind).toBe("crm");
    expect(raw.sourceItemId).toBe(`contact:${id(nia.key)}`);
    expect(raw.sourceItemId).not.toContain("@");
    expect(raw.observedAt).toBe("2026-09-30T00:00:00.000Z");
    expect(raw.permissions).toEqual({ scope: "listed", identifiers: ["nia.rao@sheet-import.test"] });
    const payload = JSON.parse(Buffer.from(raw.payload, "base64").toString("utf8")) as Record<string, unknown>;
    expect(payload.resourceName).toBe(id(nia.key));
    expect(payload.organizations).toEqual([{ name: "Lumen Capital Example", title: "Partner, Growth" }]);
    expect(payload.imported).toEqual(nia.extras);
  });

  it("gives the same row the same tag on every run and in any order, and a changed row another", () => {
    expect(
      importItem(nia, { ...at, now: Timestamp.parse("2027-01-01T00:00:00.000Z"), id: id(nia.key) }).revisionTag,
    ).toBe(one(nia).revisionTag);
    const rows = [
      {
        "First Name": "Ivo",
        "Last Name": "Brandt",
        "Email Address": "ivo@linkedin-import.test",
        URL: "",
        Company: "",
        Position: "",
        "Connected On": "",
      },
      {
        "First Name": "Lena",
        "Last Name": "Ortiz",
        "Email Address": "lena@linkedin-import.test",
        URL: "",
        Company: "",
        Position: "",
        "Connected On": "",
      },
    ];
    const headers = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
    const tags = (text: string) =>
      Object.fromEntries(
        readContacts("linkedin-connections", text, { now: NOW }).records.map((record) => [
          record.key,
          one(record).revisionTag,
        ]),
      );
    expect(tags(csvOf(headers, [...rows].reverse()))).toEqual(tags(csvOf(headers, rows)));
    const changed = { ...nia, extras: { ...nia.extras, tags: [...nia.extras.tags, { key: "Signal", value: "Low" }] } };
    expect(one(changed).revisionTag).not.toBe(one(nia).revisionTag);
  });

  it("refuses an address the strict reading refuses, as a saved contact's, and a row with none is no contact", () => {
    const bad = one({ ...nia, emails: ["not an address", "nia.rao@sheet-import.test"] });
    expect(bad.markers).toContain("bad_address");
    expect(contactKept(one(oskar), [])).toBe("no_address");
    expect(contactKept(one(nia), ["nia.rao@sheet-import.test"])).toBe("own_contact");
    expect(contactKept(one(nia), [])).toBe("keep");
  });
});
