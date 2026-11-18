import type { ContactMappingInput } from "@intelligence/contracts/personal";

// Synthetic contact files for the contact import's tests: LinkedIn's Connections export, Google
// Contacts' CSV in both its forms, and an owner's research sheet with the mapping that reads it.
// Every name is made up and every address is on a reserved domain.

// A CSV with every cell quoted that needs it, rows by CRLF as spreadsheet exports write them.
export function csvOf(headers: readonly string[], rows: readonly Record<string, string>[]): string {
  const cell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return `${[
    headers.map(cell).join(","),
    ...rows.map((row) => headers.map((header) => cell(row[header] ?? "")).join(",")),
  ].join("\r\n")}\r\n`;
}

// LinkedIn's export: lines of notes before the header, a company with a comma in it, and a
// connection who does not share an address.
export const LINKEDIN_CONNECTIONS = [
  "Notes:",
  '"Some addresses are missing, because a connection chose not to share theirs. (Synthetic notice, for tests.)"',
  "",
  csvOf(
    ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"],
    [
      {
        "First Name": "Ivo",
        "Last Name": "Brandt",
        URL: "https://www.linkedin.com/in/ivo-brandt-example",
        "Email Address": "ivo.brandt@linkedin-import.test",
        Company: "Brandt, Kell & Co",
        Position: "Partner",
        "Connected On": "14 Mar 2024",
      },
      {
        "First Name": "Lena",
        "Last Name": "Ortiz",
        URL: "https://www.linkedin.com/in/lena-ortiz-example",
        "Email Address": "",
        Company: "Cedar Works Example",
        Position: "Head of Design",
        "Connected On": "02 Jan 2023",
      },
    ],
  ),
].join("\r\n");

// Google Contacts' current export: several values in one cell, joined by " ::: ".
export const GOOGLE_CONTACTS = csvOf(
  [
    "First Name",
    "Middle Name",
    "Last Name",
    "Nickname",
    "E-mail 1 - Label",
    "E-mail 1 - Value",
    "Phone 1 - Label",
    "Phone 1 - Value",
    "Organization Name",
    "Organization Title",
    "Website 1 - Label",
    "Website 1 - Value",
    "Notes",
    "Labels",
  ],
  [
    {
      "First Name": "Maren",
      "Last Name": "Holt",
      "E-mail 1 - Label": "* Home",
      "E-mail 1 - Value": "maren@google-import.test ::: m.holt@google-import.example",
      "Phone 1 - Label": "Mobile",
      "Phone 1 - Value": "555-0101",
      "Organization Name": "Holt Works Example",
      "Organization Title": "Engineer",
      "Website 1 - Value": "https://www.linkedin.com/in/maren-holt-example",
      Notes: "Met at a synthetic conference.",
      Labels: "* myContacts ::: Friends",
    },
  ],
);

// Google Contacts' export before it, with `Name` and numbered organizations.
export const GOOGLE_CONTACTS_OLD = csvOf(
  [
    "Name",
    "Given Name",
    "Additional Name",
    "Family Name",
    "Notes",
    "Group Membership",
    "E-mail 1 - Type",
    "E-mail 1 - Value",
    "Phone 1 - Value",
    "Organization 1 - Name",
    "Organization 1 - Title",
    "Website 1 - Value",
  ],
  [
    {
      Name: "Sam Orrin",
      "Given Name": "Sam",
      "Family Name": "Orrin",
      "Group Membership": "* myContacts",
      "E-mail 1 - Type": "* Work",
      "E-mail 1 - Value": "sam@google-import.test",
      "Organization 1 - Name": "Orrin Labs Example",
      "Organization 1 - Title": "Founder",
    },
  ],
);

// An owner's research sheet: people, households of two parents, and venues, with the owner's own workflow
// columns beside the facts. Its shape is what `mapped-csv` must express; its columns are named
// only here and in its mapping.
export const RESEARCH_SHEET_HEADERS = [
  "Name",
  "Type",
  "Spheres",
  "Signal",
  "Status",
  "Act",
  "Rank",
  "Title",
  "Organization",
  "LinkedIn",
  "Email",
  "Phone",
  "Channel",
  "Focus / Context",
  "Household ID",
  "Parents",
  "Tier",
  "Confidence",
  "Record Status",
  "Title P1",
  "Employer P1",
  "Title P2",
  "Employer P2",
  "Industry P1",
  "Industry P2",
  "Investment/Founder",
  "Public Executive",
  "Nonprofit Boards",
  "Board/Leadership Roles",
  "Warm Intro Path",
  "Mutual Connections",
  "Blocking Issue",
  "Identifier Needed",
  "Next Method",
  "Queue Priority",
  "Why Name-Only Search Not Recommended",
  "Queue Last Reviewed",
  "Group",
  "Venue Phone",
  "Known Managers",
  "Group Buyer",
  "Live Listings",
  "Last Swept",
  "Indeed Jobs",
  "LinkedIn Jobs",
] as const;

export const RESEARCH_SHEET_ROWS: Record<string, string>[] = [
  // 1. A verified person with an address, a profile, boards and the owner's tags.
  {
    Name: "Nia Rao",
    Type: "Person",
    Spheres: "Arts; Climate",
    Signal: "High",
    Status: "Verified — enriched from public sources",
    Rank: "1",
    Title: "Partner, Growth",
    Organization: "Lumen Capital Example",
    LinkedIn: "https://www.linkedin.com/in/nia-rao-example",
    Email: "nia.rao@sheet-import.test",
    Channel: "Email",
    "Focus / Context": "Climate fund; met once at a synthetic dinner.",
    "Household ID": "H-1",
    Confidence: "0.9",
    "Nonprofit Boards": "Harbor Arts Example; River School Example",
    "Board/Leadership Roles": "Trustee at Harbor Arts Example",
    "Queue Last Reviewed": "2026-09-30",
  },
  // 2. A probable person with no address: kept out, counted as name only.
  {
    Name: "Oskar Vell",
    Type: "Person",
    Status: "Probable — matched by name",
    Title: "Chef",
    Organization: "Blue Door Example",
    Confidence: "45%",
  },
  // 3. A household of two parents.
  {
    Name: "Rao Household",
    Type: "Household",
    "Household ID": "H-1",
    Parents: "Asha Rao; Dev Rao",
    Spheres: "Arts",
    "Title P1": "Surgeon",
    "Employer P1": "Harbor Health Example",
    "Industry P1": "Health",
    "Title P2": "Architect",
    "Employer P2": "Rao Studio Example",
    "Industry P2": "Design",
  },
  // 4. A venue, run by its group and two managers, one of whom is a row of the sheet.
  {
    Name: "Blue Door Example",
    Type: "Venue",
    Group: "Bright Group Example",
    "Known Managers": "Kai Lund; Someone Unlisted",
    "Venue Phone": "555-0199",
    "Group Buyer": "x",
  },
  { Name: "Bright Group Example", Type: "Venue" },
  // 5. A probable person with an address, a confidence as a percentage, who works at the group.
  {
    Name: "Kai Lund",
    Type: "Person",
    Status: "Probable — one source",
    Email: "kai.lund@sheet-import.test",
    Confidence: "60%",
    Title: "General Manager",
    Organization: "Bright Group Example",
  },
  // 6. Rows refused: an unknown kind, no name, an address an earlier row has, and a cell past the header.
  { Name: "Zed Quill", Type: "Spaceship" },
  { Name: "", Type: "Person", Email: "noname@sheet-import.test" },
  { Name: "Nia R.", Type: "Person", Email: "nia.rao@sheet-import.test" },
];

// A row with one cell more than the header has.
export const RESEARCH_SHEET = `${csvOf(RESEARCH_SHEET_HEADERS, RESEARCH_SHEET_ROWS)}Ula Penn,Person${",".repeat(RESEARCH_SHEET_HEADERS.length - 1)}extra\r\n`;

// The mapping that reads it: the owner's configuration, on the owner's box in real use.
export const RESEARCH_SHEET_MAPPING: ContactMappingInput = {
  name: ["Name"],
  kind: {
    column: "Type",
    values: { Person: "person", Household: "household", Venue: "organization" },
    default: "person",
  },
  id: { column: "Household ID", kinds: ["household"] },
  emails: ["Email"],
  phones: ["Phone", "Venue Phone"],
  profiles: ["LinkedIn"],
  title: "Title",
  organization: "Organization",
  boards: ["Nonprofit Boards"],
  relations: [
    { kind: "household_member", column: "Household ID", by: "id" },
    { kind: "managed_by", column: "Group", by: "name" },
    { kind: "managed_by", column: "Known Managers", by: "name" },
  ],
  household: {
    members: "Parents",
    persons: [
      { title: "Title P1", organization: "Employer P1", industries: ["Industry P1"] },
      { title: "Title P2", organization: "Employer P2", industries: ["Industry P2"] },
    ],
  },
  tags: [
    "Spheres",
    "Signal",
    "Status",
    "Act",
    "Rank",
    "Channel",
    "Tier",
    "Record Status",
    "Queue Priority",
    "Next Method",
    "Identifier Needed",
    "Blocking Issue",
    "Board/Leadership Roles",
  ],
  notes: ["Focus / Context", "Warm Intro Path", "Mutual Connections"],
  confidence: "Confidence",
  standing: { column: "Status", verified: ["Verified"], probable: ["Probable"] },
  asOf: "Queue Last Reviewed",
  separators: { Spheres: ";", Parents: ";", "Nonprofit Boards": ";", "Known Managers": ";" },
  ignore: [
    "Investment/Founder",
    "Public Executive",
    "Why Name-Only Search Not Recommended",
    "Last Swept",
    "Indeed Jobs",
    "LinkedIn Jobs",
    "Live Listings",
    "Group Buyer",
  ],
};
