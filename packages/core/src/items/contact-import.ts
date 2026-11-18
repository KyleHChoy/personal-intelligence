import { DateOnly, type RawItem, type SourceAccountId, type Timestamp } from "@intelligence/contracts";
import {
  CodedError,
  ContactMapping,
  IMPORT_LIMITS,
  type ImportAdapter,
  ImportedContact,
  type ImportedExtras,
  type ImportRefusal,
  type ImportRelationKind,
  type ImportRowKind,
  type MemberColumns,
  type PersonLink,
} from "@intelligence/contracts/personal";
import { addressOf } from "../addresses.ts";
import { DAY_MS, MONTHS } from "../days.ts";
import { contactPhoneKey, profileKey } from "../profile-key.ts";
import { foldName } from "../text.ts";
import { unique } from "../values.ts";
import { CONTACT_LIMITS, contactItem } from "./contacts.ts";
import { parseCsv } from "./csv.ts";
import { personLink, uniqueLinks } from "./person-links.ts";

// Contact import: a contact file read into records by an adapter, and a record made into a saved
// contact's source item, so it takes the contacts' path through the writer. Code only: no network,
// no file, no model, and nothing a cell says is followed. Each built-in adapter is a fixed mapping
// read by the same engine as `mapped-csv`.

const coded = (code: string): Error => new CodedError(code);

export type ImportRead = {
  // The file's data rows after its header, empty rows aside.
  rows: number;
  records: ImportedContact[];
  // `row` counts the file's rows after its header, from 1.
  refused: { row: number; code: ImportRefusal }[];
  // Header columns the mapping neither reads nor ignores, and columns it reads that the header lacks.
  columns: { unmapped: number; missing: number };
  // Relations whose target the file does not name exactly once, and `works_at` relations whose
  // target is not an organization row.
  relations: { unresolved: number; refused: number };
  // Rows whose `asOf` was left out: more than a day ahead of the run, or before 1900.
  asOfDropped: number;
  // Cells of a link column that were no link (not http or https, a user or a password, an IP, a
  // look-alike host, too long), left out.
  linksDropped: number;
};

// A built-in adapter: its mapping, and the identifier columns an export may leave out.
type Adapter = { mapping: ContactMapping; optional: ReadonlySet<string> };

// LinkedIn's Connections.csv: a few lines of notes, then this header.
const LINKEDIN: Adapter = {
  mapping: ContactMapping.parse({
    name: ["First Name", "Last Name"],
    emails: ["Email Address"],
    profiles: ["URL"],
    title: "Position",
    organization: "Company",
    tags: ["Connected On"],
  }),
  optional: new Set(),
};

// Google Contacts' CSV, in its current form and in the form before it. Several values of one
// field share a cell, joined by " ::: ". An export has as many numbered columns as its fullest
// contact needs, so the second and third addresses may be absent.
const numbered = (label: string): string[] => [1, 2, 3].map((n) => `${label} ${n} - Value`);
const googleAdapter = (name: string[], organization: string, title: string, labels: string): Adapter => {
  const many = [...numbered("E-mail"), ...numbered("Phone"), ...numbered("Website"), labels];
  const mapping = ContactMapping.parse({
    name,
    emails: numbered("E-mail"),
    phones: numbered("Phone"),
    profiles: numbered("Website"),
    organization,
    title,
    notes: ["Notes"],
    tags: [labels],
    separators: Object.fromEntries(many.map((column) => [column, ":::"])),
  });
  return { mapping, optional: new Set(numbered("E-mail").slice(1)) };
};
const GOOGLE = googleAdapter(
  ["First Name", "Middle Name", "Last Name"],
  "Organization Name",
  "Organization Title",
  "Labels",
);
const GOOGLE_OLD = googleAdapter(["Name"], "Organization 1 - Name", "Organization 1 - Title", "Group Membership");

const holds = (row: string[], columns: readonly string[]): boolean =>
  columns.every((column) => row.some((cell) => cell.trim() === column));

// A file read by an adapter, or refused whole: `bad_csv`, `no_header`, `missing_column`,
// `bad_header` or `too_large`. `now` bounds a row's `asOf`.
export function readContacts(
  adapter: ImportAdapter,
  text: string,
  options: { mapping?: ContactMapping; now: Date },
): ImportRead {
  const rows = parseCsv(text);
  if (rows === null) throw coded("bad_csv");
  if (adapter === "linkedin-connections") return readMapped(rows, LINKEDIN, adapter, options.now);
  if (adapter === "google-contacts-csv")
    return readMapped(rows, rows.some((row) => holds(row, ["First Name"])) ? GOOGLE : GOOGLE_OLD, adapter, options.now);
  if (options.mapping === undefined) throw coded("usage");
  return readMapped(rows, { mapping: options.mapping, optional: new Set() }, adapter, options.now);
}

const pad = (n: number): string => String(n).padStart(2, "0");

// A date as a file writes it: 2019, 2019-05, a full ISO date, May 2019 or 15 May 2019. A year or a
// month stands for its first day, or with `end` its last. Anything else is no date.
export function dateOf(value: string, end = false): string | undefined {
  const text = value.trim();
  let year: number;
  let month: number | undefined;
  let day: number | undefined;
  const numeric = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text);
  if (numeric !== null) {
    year = Number(numeric[1]);
    month = numeric[2] === undefined ? undefined : Number(numeric[2]);
    day = numeric[3] === undefined ? undefined : Number(numeric[3]);
  } else {
    const named = /^(?:(\d{1,2})\s+)?([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/.exec(text);
    if (named === null) return undefined;
    day = named[1] === undefined ? undefined : Number(named[1]);
    month = MONTHS.indexOf((named[2] ?? "").toLowerCase()) + 1;
    if (month === 0) return undefined;
    year = Number(named[3]);
  }
  const m = month ?? (end ? 12 : 1);
  const d = day ?? (end ? new Date(Date.UTC(year, m, 0)).getUTCDate() : 1);
  const date = `${year}-${pad(m)}-${pad(d)}`;
  return DateOnly.safeParse(date).success ? date : undefined;
}

// A number from 0 to 1, or a percentage.
function confidenceOf(value: string): number | undefined {
  const text = value.trim();
  const percent = text.endsWith("%");
  const number = Number(percent ? text.slice(0, -1) : text);
  const scaled = percent ? number / 100 : number;
  return text !== "" && Number.isFinite(scaled) && scaled >= 0 && scaled <= 1 ? scaled : undefined;
}

const EARLIEST_AS_OF = "1900-01-01";

const short = (value: string): string | undefined =>
  value !== "" && [...value].length <= IMPORT_LIMITS.text ? value : undefined;
const cut = <T>(values: T[]): T[] => values.slice(0, IMPORT_LIMITS.list);

type Pending = { kind: ImportRelationKind; by: "id" | "name"; value: string };
type Draft = { record: ImportedContact; id?: string; pending: Pending[] };
type PersonColumns = Pick<MemberColumns, "emails" | "phones" | "profiles" | "title" | "organization" | "industries">;
type Fields = {
  emails: string[];
  phones: string[];
  profiles: string[];
  links: PersonLink[];
  title: string | undefined;
  organization: string | undefined;
  industries: string[];
};
type LinkColumns = ContactMapping["links"];

function readMapped(rows: string[][], adapter: Adapter, adapterName: ImportAdapter, now: Date): ImportRead {
  const { mapping } = adapter;
  const { at, header, index, columns } = headerOf(rows, adapter);
  const latest = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);

  let dataRows = 0;
  let asOfDropped = 0;
  let linksDropped = 0;
  const refused: ImportRead["refused"] = [];
  const drafts: Draft[] = [];
  const keys = new Set<string>();
  const add = (draft: Draft, row: number): void => {
    if (keys.has(draft.record.key)) refused.push({ row, code: "duplicate_key" });
    else {
      keys.add(draft.record.key);
      drafts.push(draft);
    }
  };

  rows.slice(at + 1).forEach((cells, offset) => {
    const row = offset + 1;
    if (cells.every((one) => one.trim() === "")) return;
    dataRows += 1;
    if (cells.slice(header.length).some((one) => one.trim() !== "")) {
      refused.push({ row, code: "bad_row" });
      return;
    }
    const cell = (column: string | undefined): string => {
      const i = column === undefined ? undefined : index.get(column);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const values = (list: readonly string[]): string[] =>
      unique(
        list
          .flatMap((column) => {
            const separator = mapping.separators[column];
            const value = cell(column);
            return separator === undefined ? [value] : value.split(separator);
          })
          .map((one) => one.trim())
          .filter((one) => one !== ""),
      );
    // The link columns' URLs with their kind and label, then every profile URL, each normalized and
    // each URL once. A link cell that is no link is dropped and counted.
    const linksOf = (columns: LinkColumns, profiles: string[]): PersonLink[] => {
      const mapped = columns.flatMap(({ column, kind, label }) =>
        values([column]).map((value) => {
          const link = personLink(value, {
            ...(kind === undefined ? {} : { kind }),
            ...(label === undefined ? {} : { label }),
          });
          if (link === null) linksDropped += 1;
          return link;
        }),
      );
      return uniqueLinks([...mapped, ...profiles.map((one) => personLink(one))], IMPORT_LIMITS.list);
    };
    const fields = (from: PersonColumns, linkColumns: LinkColumns = []): Fields => {
      const profiles = values(from.profiles).filter((one) => [...one].length <= IMPORT_LIMITS.url);
      return {
        emails: values(from.emails).filter((one) => [...one].length <= IMPORT_LIMITS.url),
        phones: values(from.phones).flatMap((one) => short(one) ?? []),
        profiles,
        links: linksOf(linkColumns, profiles),
        title: short(cell(from.title)),
        organization: short(cell(from.organization)),
        industries: values(from.industries).flatMap((one) => short(one) ?? []),
      };
    };

    const kind = kindOf(mapping, mapping.kind === undefined ? "" : cell(mapping.kind.column));
    if (kind === undefined) {
      refused.push({ row, code: "bad_kind" });
      return;
    }
    const name = short(
      mapping.name
        .map((column) => cell(column))
        .filter((one) => one !== "")
        .join(" "),
    );
    if (name === undefined) {
      refused.push({ row, code: "no_name" });
      return;
    }

    const confidence = mapping.confidence === undefined ? undefined : confidenceOf(cell(mapping.confidence));
    const standing = standingOf(mapping, cell(mapping.standing?.column));
    let asOf = mapping.asOf === undefined ? undefined : dateOf(cell(mapping.asOf));
    if (asOf !== undefined && (asOf > latest || asOf < EARLIEST_AS_OF)) {
      asOf = undefined;
      asOfDropped += 1;
    }
    const idCell = mapping.id?.kinds.includes(kind) ? (short(cell(mapping.id.column)) ?? "") : "";
    const provenance = {
      adapter: adapterName,
      ...(confidence === undefined ? {} : { confidence }),
      ...(standing === undefined ? {} : { standing }),
      ...(asOf === undefined ? {} : { asOf }),
    };
    const tags = mapping.tags
      .flatMap((column) =>
        values([column]).flatMap((value) => (short(value) === undefined ? [] : [{ key: column, value }])),
      )
      .slice(0, IMPORT_LIMITS.tags);
    const location = short(cell(mapping.location));
    const own = fields(mapping, mapping.links);
    const key = keyOf(own, `row:${idCell === "" ? row : `id:${idCell}`}`);
    const record = recordOf(key, name, own, {
      kind,
      pastRoles: mapping.pastRoles.flatMap((past) => {
        const [title, organization] = [short(cell(past.title)), short(cell(past.organization))];
        if (title === undefined && organization === undefined) return [];
        const [from, to] = [
          past.from === undefined ? undefined : dateOf(cell(past.from)),
          past.to === undefined ? undefined : dateOf(cell(past.to), true),
        ];
        return [
          {
            ...(title === undefined ? {} : { title }),
            ...(organization === undefined ? {} : { organization }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          },
        ];
      }),
      education: values(mapping.education).flatMap((one) => short(one) ?? []),
      boards: values(mapping.boards).flatMap((one) => (short(one) === undefined ? [] : [{ organization: one }])),
      ...(location === undefined ? {} : { location }),
      relations: [],
      tags,
      // Each note keyed by its column, so a reader can say which of the owner's columns it came
      // from.
      notes: mapping.notes.flatMap((column) => {
        const value = cell(column);
        return value !== "" && [...value].length <= IMPORT_LIMITS.note ? [{ key: column, value }] : [];
      }),
      provenance,
    });
    const pending = mapping.relations.flatMap(({ kind: relation, column, by }) =>
      values([column]).map((value) => ({ kind: relation, by, value })),
    );
    add({ record, ...(idCell === "" ? {} : { id: idCell }), pending }, row);

    // A household's people, each a person of their own, a member of the household's row.
    if (kind !== "household" || mapping.household === undefined) return;
    const members = mapping.household.members === undefined ? [] : values([mapping.household.members]);
    mapping.household.persons.forEach((person, i) => {
      const memberFields = fields(person);
      const memberName = short(person.name === undefined ? (members[i] ?? "") : cell(person.name));
      if (memberName === undefined) {
        // A person with data and no name is refused; the household's row is counted once in `rows`.
        const hasData =
          memberFields.emails.length + memberFields.phones.length + memberFields.profiles.length > 0 ||
          memberFields.title !== undefined ||
          memberFields.organization !== undefined;
        if (hasData) refused.push({ row, code: "no_name" });
        return;
      }
      const extras = {
        kind: "person" as const,
        pastRoles: [],
        education: [],
        boards: [],
        relations: [{ kind: "household_member" as const }],
        tags,
        notes: [],
        provenance,
      };
      add(
        { record: recordOf(keyOf(memberFields, `${key}/${i + 1}`), memberName, memberFields, extras), pending: [] },
        row,
      );
    });
  });

  const { records, relations } = resolveRelations(drafts);
  return { rows: dataRows, records, refused, columns, relations, asOfDropped, linksDropped };
}

// One that holds the names but not an identifier column is a misspelt mapping. With it, each
// column's first place by name, and how many columns the mapping does not read and how many it
// reads that the file lacks.
function headerOf(
  rows: string[][],
  { mapping, optional }: Adapter,
): { at: number; header: string[]; index: Map<string, number>; columns: ImportRead["columns"] } {
  const required = [...mapping.name, ...mapping.emails.filter((column) => !optional.has(column))];
  const at = rows.findIndex((row) => holds(row, required));
  if (at === -1) throw coded(rows.some((row) => holds(row, mapping.name)) ? "missing_column" : "no_header");
  if (rows.length - at - 1 > IMPORT_LIMITS.rows) throw coded("too_large");
  const header = (rows[at] ?? []).map((cell) => cell.trim());
  const read = readColumns(mapping);
  if ([...read].some((column) => header.filter((name) => name === column).length > 1)) throw coded("bad_header");
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (name !== "" && !index.has(name)) index.set(name, i);
  });
  const columns = {
    unmapped: [...index.keys()].filter((name) => !read.has(name) && !mapping.ignore.includes(name)).length,
    missing: [...read].filter((name) => !index.has(name)).length,
  };
  return { at, header, index, columns };
}

// The relations, each to the one row the file names by its id or its first name. Only the kind is
// kept, and for `works_at` the organization's name: no other person's name or key.
function resolveRelations(drafts: readonly Draft[]): {
  records: ImportedContact[];
  relations: ImportRead["relations"];
} {
  const byId = new Map<string, Draft>();
  const byName = new Map<string, Draft[]>();
  for (const draft of drafts) {
    if (draft.id !== undefined) byId.set(draft.id, draft);
    const primary = foldName(draft.record.names[0] ?? "");
    byName.set(primary, [...(byName.get(primary) ?? []), draft]);
  }
  const relations = { unresolved: 0, refused: 0 };
  const records = drafts.map((draft) => {
    const made = draft.pending.flatMap((one): ImportedExtras["relations"] => {
      const found =
        one.by === "id"
          ? [byId.get(one.value)].flatMap((target) => target ?? [])
          : (byName.get(foldName(one.value)) ?? []);
      const [target] = found;
      if (found.length !== 1 || target === undefined) {
        relations.unresolved += 1;
        return [];
      }
      if (target === draft) return [];
      if (one.kind !== "works_at") return [{ kind: one.kind }];
      if (target.record.extras.kind !== "organization") {
        relations.refused += 1;
        return [];
      }
      const name = target.record.names[0];
      return [{ kind: "works_at", ...(name === undefined ? {} : { name }) }];
    });
    const all = [
      ...new Map([...draft.record.extras.relations, ...made].map((one) => [JSON.stringify(one), one])).values(),
    ].slice(0, IMPORT_LIMITS.relations);
    return ImportedContact.parse({ ...draft.record, extras: { ...draft.record.extras, relations: all } });
  });
  return { records, relations };
}

// Every column a mapping reads.
function readColumns(mapping: ContactMapping): Set<string> {
  const people: PersonColumns[] = [mapping, ...(mapping.household?.persons ?? [])];
  const one = (column: string | undefined): string[] => (column === undefined ? [] : [column]);
  return new Set([
    ...mapping.name,
    ...one(mapping.kind?.column),
    ...one(mapping.id?.column),
    ...people.flatMap((person) => [
      ...person.emails,
      ...person.phones,
      ...person.profiles,
      ...person.industries,
      ...one(person.title),
      ...one(person.organization),
    ]),
    ...(mapping.household?.persons ?? []).flatMap((person) => one(person.name)),
    ...one(mapping.household?.members),
    ...mapping.pastRoles.flatMap((past) => [
      ...one(past.title),
      ...one(past.organization),
      ...one(past.from),
      ...one(past.to),
    ]),
    ...mapping.education,
    ...one(mapping.location),
    ...mapping.boards,
    ...mapping.links.map((link) => link.column),
    ...mapping.relations.map((relation) => relation.column),
    ...mapping.tags,
    ...mapping.notes,
    ...one(mapping.confidence),
    ...one(mapping.standing?.column),
    ...one(mapping.asOf),
  ]);
}

function kindOf(mapping: ContactMapping, value: string): ImportRowKind | undefined {
  if (mapping.kind === undefined) return "person";
  if (value === "") return mapping.kind.default;
  const exact = mapping.kind.values[value];
  if (exact !== undefined) return exact;
  const caseless = Object.entries(mapping.kind.values).find(([one]) => one.toLowerCase() === value.toLowerCase());
  return caseless?.[1];
}

function standingOf(mapping: ContactMapping, value: string): "verified" | "probable" | undefined {
  const standing = mapping.standing;
  if (standing === undefined || value === "") return undefined;
  const starts = (words: string[]) => words.some((word) => value.toLowerCase().startsWith(word.toLowerCase()));
  return starts(standing.verified) ? "verified" : starts(standing.probable) ? "probable" : undefined;
}

// The row key: its first address as the item builder reads it, else its first LinkedIn profile's
// key, else its first profile URL, else the adapter's own key for the row.
function keyOf(fields: Fields, fallback: string): string {
  for (const email of fields.emails) {
    const one = addressOf(email);
    if ("address" in one) return `email:${one.address}`;
  }
  const linked = fields.profiles.map(profileKey).find((one) => one !== null);
  if (linked !== undefined && linked !== null) return linked;
  const [profile] = fields.profiles;
  return profile === undefined ? fallback : `profile:${profile}`;
}

function recordOf(
  key: string,
  name: string,
  fields: Fields,
  extras: Omit<ImportedExtras, "profiles" | "industries">,
): ImportedContact {
  const { title, organization } = fields;
  const role =
    title === undefined && organization === undefined
      ? undefined
      : { ...(title === undefined ? {} : { title }), ...(organization === undefined ? {} : { organization }) };
  return {
    key,
    names: [name],
    emails: cut(fields.emails),
    phones: cut(fields.phones),
    links: fields.links,
    ...(role === undefined ? {} : { role }),
    extras: {
      ...extras,
      profiles: cut(fields.profiles),
      industries: cut(fields.industries),
      pastRoles: cut(extras.pastRoles),
      education: cut(extras.education),
      boards: cut(extras.boards),
      notes: cut(extras.notes),
    },
  };
}

// One record as a saved contact's source item, its further fields its payload's `imported`. Its
// resource name is `id`, which the caller makes from the record's key with a keyed fingerprint, so
// no address is in the item's id or its evidence id. Its addresses are read as a saved contact's
// are. Its time is the row's `asOf` when it has one, else `now`.
export function importItem(
  record: ImportedContact,
  at: { sourceAccount: SourceAccountId; now: Timestamp; id: string },
): RawItem {
  const allAddresses: string[] = [];
  const refused: string[] = [];
  let badAddresses = 0;
  for (const email of record.emails) {
    const one = addressOf(email);
    if ("address" in one) {
      if (!allAddresses.includes(one.address)) allAddresses.push(one.address);
    } else {
      badAddresses += 1;
      if (one.refused !== null && !refused.includes(one.refused)) refused.push(one.refused);
    }
  }
  // A row with no address is identified by its first LinkedIn profile's key, which the writer
  // resolves, suppresses and erases as it does an address. A row with an address resolves by its
  // addresses alone; its profiles stay sealed data. So an import joins no two identifiers.
  const linked = record.extras.profiles.map(profileKey).find((key) => key !== null);
  if (allAddresses.length === 0 && linked !== undefined && linked !== null) allAddresses.push(linked);
  const phoned =
    allAddresses.length === 0
      ? contactPhoneKey(record.phones.slice(0, CONTACT_LIMITS.phones).map((value) => ({ value })))
      : null;
  if (phoned !== null) allAddresses.push(phoned);
  const role = record.role;
  const contact = {
    resourceName: at.id,
    names: record.names.slice(0, CONTACT_LIMITS.names),
    nicknames: [],
    addresses: allAddresses.slice(0, CONTACT_LIMITS.addresses),
    phones: record.phones.slice(0, CONTACT_LIMITS.phones).map((value) => ({ value })),
    organizations:
      role === undefined
        ? []
        : [
            {
              ...(role.organization === undefined ? {} : { name: role.organization }),
              ...(role.title === undefined ? {} : { title: role.title }),
            },
          ],
    // The row's links, as a saved contact's websites are carried.
    links: record.links,
  };
  const asOf = record.extras.provenance.asOf;
  const now = asOf === undefined ? at.now : (`${asOf}T00:00:00.000Z` as Timestamp);
  return contactItem(
    { contact, allAddresses, badAddresses, refused },
    { sourceAccount: at.sourceAccount, changeKind: "backfill", now },
    record.extras,
  );
}
