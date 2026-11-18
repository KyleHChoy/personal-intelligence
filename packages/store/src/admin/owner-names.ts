import {
  type FactId,
  type FactView,
  ID_TOKEN,
  type NamedOpen,
  neutralWords,
  type Who,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import type { AdminContext } from "../core/admin-context.ts";
import { ownerAudience } from "../core/audience.ts";
import type { Query } from "../core/db.ts";
import type { Sealed } from "../core/seal.ts";
import { openedUnder, type Tx } from "../core/tx.ts";
import { ownerWho, ownerWithheld } from "./admin-owner.ts";
import { factViews } from "./rulings/admin-fact-views.ts";
import { namedMessages } from "./search/admin-sources.ts";

// Names, not ids: the owner's words for each id an agent wrote into text they read, every id of one read
// in one batch. A person or organization by name (an organization with none by its domain), a message by
// its subject (masked as subjects are), a meeting by its title, a document by its title, a goal by its
// statement, work by its words, an agent record by its first line, a fact by its claim's words. One the
// owner cannot see, or that has no name, is its kind's neutral words (contracts' NEUTRAL_WORDS) with
// nothing to open, the same words for both (invariant 6). Every kind's statement runs whenever an id of
// it was asked, whatever it finds. Nothing here writes or logs. A fact's words come from the caller,
// which reads them through the owner's fact read, for the claims `visibleClaims` finds in the owner's
// audience.

export type OwnerNamed = { words: string; open: NamedOpen | null };

// The most characters of a name, a title or a first line in place of an id.
const NAMED_CHARS = 80;

const firstLine = (text: string, most = NAMED_CHARS): string => {
  const line =
    text
      .split("\n")
      .find((one) => one.trim() !== "")
      ?.trim() ?? "";
  return line.length <= most ? line : `${line.slice(0, most - 1).trimEnd()}…`;
};
// An id inside a name or a title is itself said in neutral words: one batch, never a second.
const plain = (text: string): string => firstLine(text.replace(ID_TOKEN, (token) => neutralWords(token)));

type ValueRow = { id: string; compartments: string[]; value_enc: Sealed };
// An agent record's kind in the owner's words, never its code.
const RECORD_WORDS: Readonly<Record<string, string>> = {
  note: "note",
  finding: "finding",
  handoff: "handoff",
  proposal: "proposal",
  memory_change: "memory change",
  answer: "answer",
  close: "closing note",
  fill: "finding",
};

// Whether the owner can see a name for a person or organization: a person by a name, an
// organization by a name or its domain; never one the owner's Remove withheld. The one rule for the
// words (`ownerNames`) and for a question held until there is one (admin-queue.ts `heldForNames`).
export const nameOf = (one: Who | undefined, withheld: ReadonlySet<string>): string | null =>
  one === undefined || withheld.has(one.id)
    ? null
    : (one.name?.untrusted ?? (one.kind === "organization" ? (one.address?.untrusted ?? null) : null));

// The claims a fact's 64 hex characters stand for, in the owner's audience: the claim of that id,
// or the latest claim of that key. One statement.
export async function visibleClaims(query: Query, tokens: readonly string[]): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map();
  const rows = await query<{ token: string; id: string }>(
    `select distinct on (t.token) t.token, c.id from unnest($1::text[]) as t (token)
     join knowledge.claims c on c.id = t.token or c.fact_key_fp = t.token
     where c.compartments <@ $2::text[]
     order by t.token, (c.id = t.token) desc, c.valid_from desc, c.id`,
    [[...new Set(tokens)], await ownerAudience(query)],
  );
  return new Map(rows.map((row) => [row.token, row.id]));
}

// `facts`: each fact token's words, read before this transaction (`Admin.names.words`) from the
// claims `visibleClaims` found.
export async function ownerNames(
  tx: Tx,
  tokens: readonly string[],
  facts: ReadonlyMap<string, OwnerNamed>,
): Promise<Map<string, OwnerNamed>> {
  const asked = [...new Set(tokens)];
  const of = (prefix: string): string[] => asked.filter((token) => token.startsWith(`${prefix}_`));
  const named = new Map<string, OwnerNamed>();
  const set = (id: string, words: string | null | undefined, open: NamedOpen | null = null): void => {
    const said = words == null ? "" : plain(words);
    if (said !== "") named.set(id, { words: said, open });
  };
  const opens = (compartments: string[]): boolean =>
    compartments.length > 0 && compartments.every((one) => tx.keys.compartments.has(one));
  const open = (table: string, column: string, row: ValueRow): string | null =>
    row.value_enc === null || !opens(row.compartments)
      ? null
      : openedUnder(tx.keys, row.compartments, { table, id: row.id, column }, row.value_enc);
  const audience = asked.length === 0 ? [] : await ownerAudience(tx.query);

  // People and organizations, as every owner read names them; one withheld (the owner's Remove) is
  // no one.
  const entities = of("ent");
  if (entities.length > 0) {
    const withheld = await ownerWithheld(tx.query);
    const who = await ownerWho(
      tx,
      entities.filter((id) => !withheld.has(id)),
    );
    for (const [id, one] of who) set(id, nameOf(one, withheld), one.kind === "person" ? { kind: "person", id } : null);
  }
  // Messages by subject: held ones, ones outside the owner's audience and unopened ones have none.
  const messages = of("msg");
  if (messages.length > 0)
    for (const one of await namedMessages(tx, messages))
      set(one.id, one.subject?.untrusted, { kind: "message", id: one.id });
  // Meetings by their calendar title, within the owner's audience.
  const events = of("evt");
  if (events.length > 0) {
    const rows = await tx.query<ValueRow>(
      "select event_id as id, compartments, title_enc as value_enc from knowledge.event_details where event_id = any ($1::text[]) and compartments <@ $2::text[]",
      [events, audience],
    );
    for (const row of rows)
      set(row.id, open("knowledge.event_details", "title_enc", row), { kind: "meeting", id: row.id });
  }
  const documents = of("doc");
  if (documents.length > 0) {
    const rows = await tx.query<ValueRow>(
      "select id, compartments, title_enc as value_enc from knowledge.documents where id = any ($1::text[]) and not held and compartments <@ $2::text[]",
      [documents, audience],
    );
    for (const row of rows) {
      const title = open("knowledge.documents", "title_enc", row);
      set(row.id, title === null ? null : maskCredentials(title).text);
    }
  }
  const goals = of("gol");
  if (goals.length > 0) {
    const rows = await tx.query<ValueRow>(
      "select goal_id as id, compartments, statement_enc as value_enc from projections.goal_state where goal_id = any ($1::text[]) and compartments <@ $2::text[]",
      [goals, audience],
    );
    for (const row of rows) set(row.id, open("projections.goal_state", "statement_enc", row));
  }
  // Work, and a move by its work's words: untainted, opened with the owner's key file, as the Ledger's.
  const work = [...of("opp"), ...of("mov")];
  if (work.length > 0) {
    const rows = await tx.query<ValueRow & { asked: string }>(
      `select o.id, o.compartments, o.body_enc as value_enc, o.id as asked from ledger.opportunities o where o.id = any ($1::text[]) and o.tainted_at is null and o.compartments <@ $2::text[]
       union all
       select o.id, o.compartments, o.body_enc, m.id from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
       where m.id = any ($1::text[]) and m.tainted_at is null and o.tainted_at is null and o.compartments <@ $2::text[]`,
      [work, audience],
    );
    for (const row of rows) set(row.asked, open("ledger.opportunities", "body_enc", row));
  }
  // An agent's record by its first line; one whose body is a structure (a fill) by its kind.
  const records = of("rec");
  if (records.length > 0) {
    const rows = await tx.query<ValueRow & { kind: string }>(
      "select id, kind, compartments, body_enc as value_enc from ledger.agent_writes where id = any ($1::text[]) and body_enc is not null and tainted_at is null and flagged_at is null and compartments <@ $2::text[]",
      [records, audience],
    );
    for (const row of rows) {
      const text = open("ledger.agent_writes", "body_enc", row);
      if (text === null) continue;
      // Short enough that the quoted title is never cut by `set`'s limit.
      const title = /^\s*[[{]/.test(text) ? "" : firstLine(plain(text), NAMED_CHARS - 20);
      const kind = RECORD_WORDS[row.kind] ?? RECORD_WORDS.note ?? "";
      set(row.id, title === "" ? `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}` : `the ${kind} "${title}"`);
    }
  }
  for (const [id, one] of facts) if (asked.includes(id)) set(id, one.words, one.open);

  // Every other id the owner asked about: its kind's neutral words, nothing to open.
  for (const token of asked) if (!named.has(token)) named.set(token, { words: neutralWords(token), open: null });
  return named;
}

// A fact's words, from the fields its claim holds: its phrase, a role's title at its organization,
// else the first of its other words. Null for one that holds none.
const PHRASE_FIELDS = ["what", "objective", "object", "rule", "state", "title", "name", "label", "merchant"] as const;
const textOf = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value !== "object" || value === null) return null;
  const one = value as { untrusted?: unknown; name?: unknown; address?: unknown };
  if (typeof one.untrusted === "string") return textOf(one.untrusted);
  return textOf(one.name) ?? textOf(one.address);
};
export function factViewWords(view: FactView): string | null {
  const fields = view.fields as Record<string, unknown>;
  const phrase = PHRASE_FIELDS.map((field) => textOf(fields[field])).find((one) => one !== null) ?? null;
  const organization = textOf(fields.organization) ?? textOf(fields.organization_name);
  return view.type === "role" && phrase !== null && organization !== null ? `${phrase} at ${organization}` : phrase;
}

// The owner's words for every id an agent wrote into the text of one read, in one batch. A fact's
// 64 hex characters are its claim's id, or its key, whose latest claim names it, as factShow would
// show it: only claims in the owner's audience, each read in a transaction of its own, never inside
// another.
export async function ownerWordsFor(admin: AdminContext, tokens: readonly string[]): Promise<Map<string, OwnerNamed>> {
  const asked = tokens.filter((one) => one.length === 64);
  const claims =
    asked.length === 0 ? new Map<string, string>() : await admin.transaction((query) => visibleClaims(query, asked));
  const views =
    claims.size === 0 ? new Map<FactId, FactView>() : await factViews(admin, [...claims.values()] as FactId[]);
  const facts = new Map<string, OwnerNamed>();
  for (const [token, claim] of claims) {
    const view = views.get(claim as FactId);
    const words = view === undefined ? null : factViewWords(view);
    if (words !== null) facts.set(token, { words, open: { kind: "fact", id: claim } });
  }
  return admin.transaction((query) => ownerNames({ query, keys: admin.keys }, tokens, facts));
}
