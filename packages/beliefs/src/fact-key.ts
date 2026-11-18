import { createHash } from "node:crypto";
import type { ClaimContent } from "@intelligence/contracts";
import {
  CONNECTION_TYPE,
  KEY_FIELDS,
  OWNER_TIE_TYPE,
  type OwnerSideKind,
  PERSON_PROPOSAL_TYPES,
} from "@intelligence/contracts/personal";
import { keyPhrase, normalizeAddress, polarPhrase } from "@intelligence/personal-core";
import { factKey } from "./base-fact-key.ts";
import { normal } from "./grounding.ts";
import { PERSON_LINK, PERSONAL_ONTOLOGY, personalType, v4FieldsOf } from "./ontology.ts";

const valueFields = (id: string): string[] =>
  (personalType(id)?.fields ?? [])
    .filter(
      (field) =>
        (id === "project.status" && field.name === "status") ||
        (field.kind === "date" && (field.name === "until" || field.name === "by")),
    )
    .map((field) => field.name);

export const namesOrganizationEntity = (fields: Readonly<Record<string, unknown>>): boolean =>
  fields.organization !== undefined;

const extend = (key: string, part: string): string =>
  createHash("sha256").update(`${key}\n${part}`, "utf8").digest("hex");

// Which fact key a claim of a generation takes. Version 2 from generation 5, the generation of
// prompt version 4; version 1 before.
export type KeyVersion = 1 | 2;
export const KEY_V2_GENERATION = 5;
export const keyVersionOf = (generation: number): KeyVersion => (generation >= KEY_V2_GENERATION ? 2 : 1);

const ownerSide = (type: string): OwnerSideKind | undefined =>
  Object.hasOwn(KEY_FIELDS, type) ? (type as OwnerSideKind) : undefined;

// Version 2 of an owner-side kind that carries its key phrase: a claim of version 4's shape. A
// claim of the legacy shape, with `what` and no key phrase, keeps its version 1 key at every
// version, so no two legacy goals of a subject ever join for want of a phrase.
const atomic = (content: ClaimContent): OwnerSideKind | undefined => {
  const kind = ownerSide(content.type);
  return kind !== undefined && typeof content.fields[KEY_FIELDS[kind].phrase] === "string" ? kind : undefined;
};

// Version 3's `likes` and `dislikes` are `prefers` and `avoids`. A leading negation of the object,
// standing as its own word, moves out only of a `prefers`, which becomes `avoids`; with `avoids` it
// stays in the phrase, a double negative the check refuses and the key keeps apart.
const polarOf = (fields: Readonly<Record<string, unknown>>): { polarity: unknown; phrase: string } => {
  const object = fields[KEY_FIELDS.preference.phrase] as string;
  const given = fields.polarity;
  const polarity = given === "likes" ? "prefers" : given === "dislikes" ? "avoids" : given;
  const moved = polarPhrase(object);
  return moved.negated && polarity === "prefers"
    ? { polarity: "avoids", phrase: moved.phrase }
    : { polarity, phrase: keyPhrase(object) };
};

// The scope a claim's key takes. Version 2 drops the thread scope of an owner-side kind with its
// key phrase: the same goal stated in two threads is one fact, and its compartments stay a part, so
// two mailboxes never mix.
export function keyScope(content: ClaimContent, keyVersion: KeyVersion = 1): "thread" | "global" | undefined {
  const scope = personalType(content.type)?.scope;
  return keyVersion === 2 && atomic(content) !== undefined ? "global" : scope;
}

// A `role` or `affiliation` with no organization entity takes `name:` and the normal form of its
// organization_name, which is the passage's own slice by then. A type of scope `global` takes
// `compartment:` and the item's compartments, sorted and joined by commas (one for a message, an agent
// record's whole label), so one person's role in two mailboxes is two facts and no audience sees them
// mixed. A finding's global type takes `agent:` and its record's evidence id in place of the
// compartments, so its fact key is never a message's; a thread-scoped one already takes the record's
// evidence id as its thread.
//
// `momentary` is a value field. Every other claim's key is its version 1 key.
export function personalFactKey(
  content: ClaimContent,
  thread: string,
  compartments: readonly string[],
  finding?: string,
  keyVersion: KeyVersion = 1,
): string {
  // A link keys by its URL alone, at every version, global: its kind and label are
  // values (personal-core's linkFactKey gives the same key).
  if (content.type === PERSON_LINK.id) {
    const key = extend(
      factKey({ ...content, fields: {} }, { ontology: PERSONAL_ONTOLOGY }),
      `url:${String(content.fields.url)}`,
    );
    return extend(
      key,
      finding === undefined ? `compartment:${[...compartments].sort().join(",")}` : `agent:${finding}`,
    );
  }
  // A tie keys by its person alone (its relation and closeness are values), a
  // connection by its person, kind and other, and a known person by its record alone, at every
  // version, global.
  if (PERSON_PROPOSAL_TYPES.includes(content.type)) {
    const bare = factKey({ ...content, fields: {} }, { ontology: PERSONAL_ONTOLOGY });
    const key =
      content.type === CONNECTION_TYPE
        ? extend(bare, `connection:${String(content.fields.kind)}:${String(content.fields.other)}`)
        : bare;
    return extend(
      key,
      finding === undefined ? `compartment:${[...compartments].sort().join(",")}` : `agent:${finding}`,
    );
  }
  const type = personalType(content.type);
  const kind = keyVersion === 2 ? atomic(content) : undefined;
  // A commitment keeps `due` in its key.
  const values =
    type === undefined || type.id === "commitment" || type.id === "plan" || type.id === "transaction.receipt"
      ? []
      : [...valueFields(type.id), ...(kind === undefined ? [] : ["momentary"])];
  let fields: Record<string, unknown> =
    values.length === 0
      ? content.fields
      : Object.fromEntries(Object.entries(content.fields).filter(([name]) => !values.includes(name)));
  // A version 2 owner-side kind keys by its KEY_FIELDS `key` alone, so a status's or a visit's
  // domain, a status's state and a visit's day are values. For the six original owner-side kinds
  // this is the same key: their typed fields outside the key are the values above. A view with no
  // topic, as an earlier version let one be written, keeps its domain and the view as its key, so a
  // view stored before topics keys as it did.
  const keyed: readonly string[] =
    kind === undefined
      ? []
      : kind === "view" && typeof content.fields.topic !== "string"
        ? ["domain", "view"]
        : KEY_FIELDS[kind].key;
  if (kind !== undefined) fields = Object.fromEntries(Object.entries(fields).filter(([name]) => keyed.includes(name)));
  const polar = kind === "preference" ? polarOf(content.fields) : undefined;
  if (polar !== undefined) fields = { ...fields, polarity: polar.polarity };
  const name = content.fields.organization_name;
  // At version 2 a role or an affiliation with its organization's name keys by that name, entity
  // or not, so a mail claim that resolved the organization and a proposal that names it are one
  // fact. With no name, the entity keys it, as at version 1.
  const byName =
    (type?.id === "role" || type?.id === "affiliation") &&
    typeof name === "string" &&
    (keyVersion === 2 || !namesOrganizationEntity(content.fields));
  if (byName && keyVersion === 2)
    fields = Object.fromEntries(Object.entries(fields).filter(([field]) => field !== "organization"));
  let key = factKey({ ...content, fields }, { ontology: PERSONAL_ONTOLOGY });
  if (byName) {
    key = extend(key, `name:${normal(name as string).text.trim()}`);
  }
  const title = content.fields.title;
  if (keyVersion === 2 && type?.id === "role" && typeof title === "string")
    key = extend(key, `title:${keyPhrase(title)}`);
  if (kind !== undefined) {
    // The phrase, when it is in the key (a view's is not, its topic is).
    const field = KEY_FIELDS[kind].phrase;
    const phrase = content.fields[field] as string;
    if (keyed.includes(field)) key = extend(key, `${field}:${polar?.phrase ?? keyPhrase(phrase)}`);
    for (const name of keyed) {
      const value = content.fields[name];
      if (
        name !== field &&
        personalType(content.type)?.fields.find((spec) => spec.name === name)?.kind === "text" &&
        typeof value === "string"
      )
        key = extend(key, `${name}:${keyPhrase(value)}`);
    }
  }
  const scope = keyScope(content, keyVersion);
  if (scope === "thread") return extend(key, thread);
  if (scope !== "global") return key;
  return extend(key, finding === undefined ? `compartment:${[...compartments].sort().join(",")}` : `agent:${finding}`);
}

// A claim's match key, the fact key its content takes as a global-scope claim under `own` with no
// finding part: the subject, type, domain and key fields, and no writer. For a releasable proposal
// it is the key its released claim would take. A thread-scoped claim has none: its key leans on
// its thread to tell facts apart.
export function matchKey(content: ClaimContent, keyVersion: KeyVersion): string | undefined {
  return keyScope(content, keyVersion) === "global"
    ? personalFactKey(content, "", ["own"], undefined, keyVersion)
    : undefined;
}

// A system notice's situation keys by its source, at every key version, never by its words: the
// normalized address of the notice's sender and its normalized subject line (noticeSubject). So a
// later notice of one sender and subject takes the earlier one's belief ("documents mailed" after
// "in process"), while one sender's notices of two subjects (a card shipped, a mortgage in review),
// or two senders', are two beliefs, and none shares a key with the owner's own situation, whose key
// never holds `notice:`. Its compartment part is the message's, as any global type's. A notice with
// no parseable sender has no source (`undefined`) and is no notice (check.ts), so no two share one.
// A subject that normalizes to nothing keys by its message instead, so no two share one either. The
// life domain the model chose is no part of it, so a later notice read as admin still supersedes
// one read as travel.
export const noticeSource = (from: string | undefined): string | undefined => normalizeAddress(from ?? "") ?? undefined;
// "May" is no month here, since it is a modal verb too ("Your claim 12 may be delayed"); it is
// one only beside a year (MAY_DATE).
const MONTH =
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const DAY_OF = "\\d{1,2}(?:st|nd|rd|th)?";
const MONTH_WORD = `(?:${MONTH})\\b\\.?`;
const MAY_DATE = `${DAY_OF}\\s+may\\b\\.?,?\\s+\\d{4}\\b|may\\b\\.?\\s+(?:${DAY_OF},?\\s+)?\\d{4}\\b`;
const DATED = [
  // A time: 10:30, 10:30:00, 9am, 9 pm.
  /\b\d{1,2}(?::\d{2}){1,2}\s*(?:am|pm)?(?![\p{L}\p{N}])|\b\d{1,2}\s*(?:am|pm)\b/gu,
  // A numeric date in a full date's shape only, one separator throughout and a 4-digit year:
  // yyyy-mm-dd, mm/dd/yyyy, dd.mm.yyyy. "3-1" or "10/21" is an identifier as likely as a date, and
  // stays; so is a version's "17.1.12".
  /\b(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{1,2}([-/.])\d{1,2}\2\d{4})(?![\p{L}\p{N}])/gu,
  // A month name next to a day or a year only: 21 Oct 2026, October 21st, Oct 2026, May 2026.
  // A month's word alone stays ("You may now book", "March madness").
  new RegExp(
    `\\b(?:${MAY_DATE}|${DAY_OF}\\s+${MONTH_WORD}(?:,?\\s+\\d{4}\\b)?|${MONTH_WORD}\\s+(?:${DAY_OF}\\b(?:,?\\s+\\d{4}\\b)?|\\d{4}\\b))`,
    "gu",
  ),
  // A reference number's label: ref, reference, nr, no., #.
  /\b(?:ref|reference|nr)\b\.?|\bno\.|#/gu,
];
// A subject line as a notice's key reads it: lowercased, with every date and time and a
// reference number's label (ref, reference, nr, no., #) left out, punctuation as space, and its
// whitespace collapsed. An identifier with a digit stays (an order's A12, an
// application's 111), so one sender's notices of two orders are two keys. "Passport Application
// Status" and "Passport application status, 21 Oct 2026 10:30" are one subject.
export const noticeSubject = (subject: string | undefined): string =>
  DATED.reduce((text, pattern) => text.replace(pattern, " "), (subject ?? "").normalize("NFKC").toLowerCase())
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "")
    .join(" ");
export function noticeFactKey(
  content: ClaimContent,
  compartments: readonly string[],
  source: string,
  subject: string,
  message: string,
): string {
  const key = factKey({ ...content, fields: {} }, { ontology: PERSONAL_ONTOLOGY });
  const read = noticeSubject(subject);
  return extend(
    extend(extend(key, `notice:${source}`), read === "" ? `message:${message}` : `subject:${read}`),
    `compartment:${[...compartments].sort().join(",")}`,
  );
}

// A released claim's fact key. At version 2, an owner-side claim with its key phrase drops the
// record's finding part and takes the released label's compartment part, so it is the same key as
// the same fact said in the owner's own mail, and joins its belief. Any other claim keeps its
// finding part (a legacy situation's key would otherwise be one for every situation in `own`), and
// so stays its own fact. A role with its title, or an affiliation, with its organization's name
// joins too, keyed by that name as mail's is at version 2.
const joinsByName = (content: ClaimContent): boolean =>
  (content.type === "role" && typeof content.fields.title === "string") || content.type === "affiliation"
    ? typeof content.fields.organization_name === "string"
    : false;
export function releasedFactKey(
  content: ClaimContent,
  evidenceId: string,
  compartments: readonly string[],
  keyVersion: KeyVersion,
): string {
  // A released tie or connection joins at every version: one fact for each person,
  // or each pair and kind, under `own`, whichever agent proposed it.
  const joins =
    (keyVersion === 2 && (atomic(content) !== undefined || joinsByName(content))) ||
    content.type === OWNER_TIE_TYPE ||
    content.type === CONNECTION_TYPE;
  return personalFactKey(content, evidenceId, compartments, joins ? undefined : evidenceId, keyVersion);
}

// A claim's fact key at version 1, its version 4 fields left out, so a ruling made before fact key
// version 2 went live still finds the claim made after it.
export function legacyFactKey(
  content: ClaimContent,
  thread: string,
  compartments: readonly string[],
  finding?: string,
): string {
  return legacyFactKeys(content, thread, compartments, finding)[0] as string;
}

// Version 1's preference polarity took four words, `likes`, `dislikes`, `prefers` and `avoids`,
// each its own key; version 4's takes two. So a version 4 preference's fact had one of two version
// 1 keys: its own word's and its synonym's.
const V1_SYNONYM: ReadonlyMap<unknown, string> = new Map([
  ["prefers", "likes"],
  ["avoids", "dislikes"],
]);

// Every version 1 key a claim's fact may have had, its own word's first, the one
// `legacyFactKey` gives. Two for a version 4 preference, one for every other claim.
export function legacyFactKeys(
  content: ClaimContent,
  thread: string,
  compartments: readonly string[],
  finding?: string,
): string[] {
  const dropped = v4FieldsOf(content.type);
  const fields = Object.fromEntries(Object.entries(content.fields).filter(([name]) => !dropped.includes(name)));
  const keyOf = (one: Record<string, unknown>) =>
    personalFactKey({ ...content, fields: one }, thread, compartments, finding, 1);
  const synonym =
    content.type === "preference" && atomic(content) !== undefined ? V1_SYNONYM.get(fields.polarity) : undefined;
  if (synonym !== undefined) return [keyOf(fields), keyOf({ ...fields, polarity: synonym })];
  // A view with a topic also had the older key, by its domain and the view, so a ruling the owner made on
  // a view stored before topics still finds it.
  if (content.type === "view" && typeof content.fields.topic === "string") {
    const { topic: _topic, ...untopical } = content.fields;
    return [keyOf(fields), personalFactKey({ ...content, fields: untopical }, thread, compartments, finding, 2)];
  }
  return [keyOf(fields)];
}
