import { z } from "zod";
import { DateOnly } from "../ids.ts";

// Contact import. A contact file (LinkedIn's Connections export, Google Contacts' CSV, or any CSV
// with the owner's mapping) read by an adapter into these records, each of which becomes one
// contact of an import's own source account. Shapes only: the adapters are personal-core's and run
// with no I/O.

const IMPORT_ADAPTERS = Object.freeze(["linkedin-connections", "google-contacts-csv", "mapped-csv"] as const);
export const ImportAdapter = z.enum(IMPORT_ADAPTERS);
export type ImportAdapter = z.infer<typeof ImportAdapter>;

// An import's name, which names its source account `import:<name>`: the form of a client's name.
export const ImportName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export type ImportName = z.infer<typeof ImportName>;
export const IMPORT_LABEL_PREFIX = "import:";

export const ImportRowKind = z.enum(["person", "organization", "household"]);
export type ImportRowKind = z.infer<typeof ImportRowKind>;

// A link the file states between two of its own rows. Only the kind is kept, and for `works_at` to
// an organization row that row's name: no other person's address or
// name is ever in a row's payload, so an erasure of that person leaves nothing of them here.
export const ImportRelationKind = z.enum(["household_member", "parent_of", "spouse_of", "works_at", "managed_by"]);
export type ImportRelationKind = z.infer<typeof ImportRelationKind>;

// Why one row became no record: no name; a kind cell the mapping does not map; more cells than
// the header has; the row key of an earlier row.
const IMPORT_REFUSALS = Object.freeze(["no_name", "bad_kind", "bad_row", "duplicate_key"] as const);
export const ImportRefusal = z.enum(IMPORT_REFUSALS);
export type ImportRefusal = z.infer<typeof ImportRefusal>;

// The bounds of one record: a value longer than `text` code points is left out, as a saved
// contact's is.
export const IMPORT_LIMITS = Object.freeze({
  text: 200,
  note: 5_000,
  url: 500,
  key: 600,
  list: 20,
  relations: 50,
  tags: 50,
  rows: 20_000,
});

const text = z.string().min(1).max(IMPORT_LIMITS.text);

// A link on a person, its kind derived from its host by code (personal-core's
// personLink) unless a mapping names one. `personal_site` is never derived from a host: only a
// mapping or a contact's own type says so.
export const LINK_KINDS = Object.freeze(["linkedin", "personal_site", "x", "github", "other"] as const);
export const LinkKind = z.enum(LINK_KINDS);
export type LinkKind = z.infer<typeof LinkKind>;

// One link as code normalized it: an http(s) URL of at most IMPORT_LIMITS.url code points, its
// kind, and a short label. Never fetched or followed.
export const PersonLink = z.strictObject({
  url: z.string().min(1).max(IMPORT_LIMITS.url),
  kind: LinkKind,
  label: text.optional(),
});
export type PersonLink = z.infer<typeof PersonLink>;
const list = <T extends z.ZodType>(item: T) => z.array(item).max(IMPORT_LIMITS.list);
const titled = (fields: { title?: string | undefined; organization?: string | undefined }): boolean =>
  fields.title !== undefined || fields.organization !== undefined;

const ImportedRole = z
  .strictObject({ title: text.optional(), organization: text.optional() })
  .refine(titled, { message: "a role has a title or an organization" });

// A role the person held before, with its dates when the file gives them.
const ImportedPastRole = z
  .strictObject({
    title: text.optional(),
    organization: text.optional(),
    from: DateOnly.optional(),
    to: DateOnly.optional(),
  })
  .refine(titled, { message: "a role has a title or an organization" });

const ImportStanding = z.enum(["verified", "probable"]);

// Where a record came from: the adapter, and what the file says of how sure it is. `asOf` is the
// date the row's data was true, when the file gives one. The row's place in the file is not kept, so
// a reordered file revises nothing.
const ImportProvenance = z.strictObject({
  adapter: ImportAdapter,
  confidence: z.number().min(0).max(1).optional(),
  standing: ImportStanding.optional(),
  asOf: DateOnly.optional(),
});

// What an imported contact holds beyond a saved contact's fields, kept in its payload and sealed in
// its contact row. Profile URLs are identifiers, never facts. Tags are the owner's own words about
// the person (sphere, status, channel), never a fact about them.
export const ImportedExtras = z.strictObject({
  kind: ImportRowKind,
  profiles: list(z.string().min(1).max(IMPORT_LIMITS.url)),
  pastRoles: list(ImportedPastRole),
  industries: list(text),
  education: list(text),
  location: text.optional(),
  boards: list(z.strictObject({ organization: text, title: text.optional() })),
  relations: z
    .array(
      z
        .strictObject({ kind: ImportRelationKind, name: text.optional() })
        .refine((one) => one.name === undefined || one.kind === "works_at", {
          message: "only works_at names its organization",
        }),
    )
    .max(IMPORT_LIMITS.relations),
  tags: z.array(z.strictObject({ key: text, value: text })).max(IMPORT_LIMITS.tags),
  // A note, keyed by its column; a bare string is a note stored before notes were keyed.
  notes: list(
    z.union([
      z.string().min(1).max(IMPORT_LIMITS.note),
      z.strictObject({ key: text, value: z.string().min(1).max(IMPORT_LIMITS.note) }),
    ]),
  ),
  provenance: ImportProvenance,
});
export type ImportedExtras = z.infer<typeof ImportedExtras>;

// One record an adapter read. `key` is its row key, in memory only: `email:` and its first address,
// else `profile:` and its first profile URL, else the adapter's own key for the row. It is never
// stored: the item is keyed by a keyed fingerprint of it. `emails`
// are as the file wrote them; the item builder reads them strictly.
export const ImportedContact = z.strictObject({
  key: z.string().min(1).max(IMPORT_LIMITS.key),
  names: z.array(text).min(1).max(5),
  emails: list(z.string().min(1).max(IMPORT_LIMITS.url)),
  phones: list(text),
  // The row's links, normalized, each URL once: its link columns' and its profiles'.
  links: list(PersonLink),
  role: ImportedRole.optional(),
  extras: ImportedExtras,
});
export type ImportedContact = z.infer<typeof ImportedContact>;

// ---------------------------------------------------------------------------------------------
// The mapping of `mapped-csv`: the owner's configuration, kept on the owner's box and never in the
// repository. Every value names a column by its header. A list of name columns is joined with a
// space; a list of any other field is read column by column, each cell split by its separator.
// ---------------------------------------------------------------------------------------------

const column = z.string().min(1).max(200);
const columns = z.array(column).max(20);

// The fields one person of a household row takes, each from a column of its own.
export const MemberColumns = z.strictObject({
  name: column.optional(),
  emails: columns.default([]),
  phones: columns.default([]),
  profiles: columns.default([]),
  title: column.optional(),
  organization: column.optional(),
  industries: columns.default([]),
});
export type MemberColumns = z.infer<typeof MemberColumns>;

export const ContactMapping = z.strictObject({
  name: columns.min(1),
  // The column that holds a row's kind, each value mapped to a kind; an empty cell takes `default`.
  // Without it every row is a person.
  kind: z
    .strictObject({
      column,
      values: z.record(z.string().min(1).max(200), ImportRowKind),
      default: ImportRowKind.optional(),
    })
    .optional(),
  // The column that holds a row's own id, as a relation `by: "id"` names it, for rows of `kinds`.
  id: z
    .strictObject({ column, kinds: z.array(ImportRowKind).min(1).default(["person", "organization", "household"]) })
    .optional(),
  emails: columns.default([]),
  phones: columns.default([]),
  profiles: columns.default([]),
  title: column.optional(),
  organization: column.optional(),
  pastRoles: z
    .array(
      z.strictObject({
        title: column.optional(),
        organization: column.optional(),
        from: column.optional(),
        to: column.optional(),
      }),
    )
    .max(10)
    .default([]),
  industries: columns.default([]),
  education: columns.default([]),
  location: column.optional(),
  boards: columns.default([]),
  // Columns of links, each with the kind its links take (derived from the host
  // when absent) and a short label of the owner's. Every `profiles` column's URLs are links too.
  links: z
    .array(z.strictObject({ column, kind: LinkKind.optional(), label: text.optional() }))
    .max(20)
    .default([]),
  // A relation to another row of the file, found by its id or by its first name, exactly once.
  relations: z
    .array(z.strictObject({ kind: ImportRelationKind, column, by: z.enum(["id", "name"]) }))
    .max(10)
    .default([]),
  // A household row's people: their names from `members`, split, the i-th name the i-th person's
  // unless its own `name` column is given.
  household: z.strictObject({ members: column.optional(), persons: z.array(MemberColumns).min(1).max(4) }).optional(),
  tags: z.array(column).max(60).default([]),
  notes: columns.default([]),
  confidence: column.optional(),
  // A row is verified or probable when its cell starts with one of these words, case aside.
  standing: z
    .strictObject({ column, verified: z.array(text).max(20).default([]), probable: z.array(text).max(20).default([]) })
    .optional(),
  asOf: column.optional(),
  separators: z.record(column, z.string().min(1).max(5)).default({}),
  // Columns read by nothing, so they are not counted as unmapped.
  ignore: z.array(column).max(200).default([]),
});
export type ContactMapping = z.infer<typeof ContactMapping>;
export type ContactMappingInput = z.input<typeof ContactMapping>;

// The schema of `ontology/contact-quality.json`, the rules by which a contact's
// organization names, titles and addresses make claims (personal-core's contact-quality.ts): the
// most words an organization name has, the characters a headline has and a name does not, the
// legal suffixes a comma may stand before, the words a first-person headline starts with and a cut
// one ends with; the characters a headline has and a title does not, and the words a title may not
// leave with nothing after them ("at and", "at,"); the domains of messaging and texting providers,
// beside personal-core's mail providers, that never name an organization; and the
// local parts of a function's mailbox. Every word in lower case. Data, not code.
const ruleWord = z
  .string()
  .min(1)
  .max(40)
  .refine((one) => one === one.toLowerCase() && one.trim() === one, {
    message: "a rule word is lower case, with no white space at either end",
  });
export const ContactQualityRules = z.strictObject({
  version: z.number().int().positive(),
  organizationMostWords: z.number().int().min(1).max(50),
  refusedCharacters: z.array(z.string().length(1)).min(1).max(20),
  legalSuffixes: z.array(ruleWord).max(50),
  firstPersonStarts: z.array(ruleWord).min(1).max(50),
  danglingEnds: z.array(ruleWord).min(1).max(50),
  titleRefusedCharacters: z.array(z.string().length(1)).min(1).max(20),
  titleOrphanWords: z.array(ruleWord).max(20),
  providerDomains: z.array(ruleWord).max(200),
  roleLocalParts: z.array(ruleWord).min(1).max(500),
});
export type ContactQualityRules = z.infer<typeof ContactQualityRules>;
