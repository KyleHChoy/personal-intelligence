import {
  BELIEF_TYPES,
  type ClaimRecord,
  FactId,
  MessageId,
  type OwnerSearchItems,
  SEARCH_GROUP_MOST,
} from "@intelligence/contracts/personal";
import { maskCredentials } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { RELEASE_IN_FORCE } from "../../core/visibility.ts";
import { normalized } from "../../read/read-search.ts";
import { claimRecordUnder, ownerWho, ownerWithheld } from "../admin-owner.ts";

// The owner's search beyond names: their facts, by the words of their claims, and their mail, by
// subject and sender, as they type. Each from an index `pi web` holds in memory with the name index
// (admin-search.ts), so a keystroke opens nothing it opened before: a claim never changes (invariant
// 3) and a message's subject and sender do not, so an index only adds the rows that are new and drops
// the rows that are gone. A row that does not open, or a claim with no words, is kept as an entry
// that matches nothing, so it is not opened again.
//
// Within the owner's audience only: a row is indexed only while its label is within it and the key
// file opens it, so nothing outside the owner's audience is matched, ranked or counted (invariant 6).
// The reader's filters each keeps: no held message, and no claim from a held item, from a flagged
// agent record, whose release is not in force or that names an entity that is gone, as the timeline's
// facts (admin-people.ts); a fact naming a withheld person or organization anywhere is left out at
// each search, as the name search leaves them out. Words and subjects are masked as read_message
// masks them, before they are indexed.
//
// Each search first reads one stamp over the rows the index is built from (a count and an
// order-free sum of hashes of their ids, nothing opened); when it differs, the ids are read and the
// index brought to them: the gone dropped (an erasure, a hold), the new opened. Searches take
// turns, one transaction at a time, so keystrokes that meet one change open each row once and hold
// one connection. The Admin's erasures drop both indexes at once and move `generation` on, so an
// update begun before an erasure never stores what it read (invariant 10). The term is never
// logged, and nothing here logs.

export type FactEntry = {
  fact: string;
  factKey: string;
  type: string;
  subject: string | null;
  self: boolean;
  entities: readonly string[];
  words: string;
  text: string;
  at: number;
};
export type MailEntry = {
  message: string;
  at: number;
  subject: string | null;
  from: string | null;
  subjectText: string;
  senderText: string;
};
type ItemIndex<T> = { stamp: string; entries: Map<string, T> };
// Held by the Admin for its lifetime. `turn` is the search under way; `generation` moves on at each
// erasure that drops the indexes.
export type ItemsHolder = {
  facts: ItemIndex<FactEntry> | null;
  mail: ItemIndex<MailEntry> | null;
  generation: number;
  turn?: Promise<unknown>;
};

export function dropItemIndexes(holder: ItemsHolder): void {
  holder.facts = null;
  holder.mail = null;
  holder.generation += 1;
}

// The claims the facts index reads, as the timeline's facts keeps them, of the types beliefs are
// built from (no activity, capture or observation rows), within the owner's audience ($1).
const FACT_SCOPE = `
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  where c.type = any ($2::text[]) and c.compartments <@ $1::text[] and ${RELEASE_IN_FORCE}
    and (m.id is null or not m.held) and (d.id is null or not d.held)
    and not exists (select 1 from ledger.agent_writes w where w.evidence_id = c.evidence_id and w.flagged_at is not null)
    and not exists (
      select 1 from knowledge.claim_entities n
      where n.claim_id = c.id and not exists (select 1 from knowledge.entities e where e.id = n.entity_id))`;
const MAIL_SCOPE = "from knowledge.messages m where not m.held and m.compartments <@ $1::text[]";

const stampOf = (scope: string, id: string) =>
  `select count(*)::text || ':' || coalesce(sum(hashtextextended(${id}, 0)::numeric), 0)::text as stamp ${scope}`;
const FACT_STAMP = stampOf(FACT_SCOPE, "c.id");
const FACT_IDS = `select c.id ${FACT_SCOPE} order by c.id`;
const FACT_ROWS = `
  select c.id, c.type, c.fact_key_fp, c.valid_from, c.compartments, c.content_enc,
    array(select n.entity_id from knowledge.claim_entities n where n.claim_id = c.id order by n.entity_id) as entities
  from knowledge.claims c where c.id = any ($1::text[]) order by c.id`;
const MAIL_STAMP = stampOf(MAIL_SCOPE, "m.id");
const MAIL_IDS = `select m.id ${MAIL_SCOPE} order by m.id`;
const MAIL_ROWS =
  "select m.id, m.sent_at, m.compartments, m.subject_enc, m.sender_enc, m.sender_name_enc from knowledge.messages m where m.id = any ($1::text[]) order by m.id";

// Rows opened a batch at a time.
const BATCH = 500;

// A claim's words as the owner reads them: its `what`, else its text fields' values, in order. No
// field name, id or code.
export function claimWords(record: ClaimRecord): string {
  const fields = record.claim.content.fields;
  if (typeof fields.what === "string") return fields.what;
  return Object.entries(fields)
    .filter(([name, value]) => record.fieldKinds[name] === "text" && typeof value === "string" && value !== "")
    .map(([, value]) => String(value))
    .join(", ");
}

// The match tiers, best first: 0, a word of `text` starts with the term (a term of several words,
// a run of its words); 1, `text` holds it anywhere. Both normalized.
export function wordMatch(term: string, text: string): 0 | 1 | null {
  if (text === "" || !text.includes(term)) return null;
  const words = text.split(" ");
  return words.some((_, at) => words.slice(at).join(" ").startsWith(term)) ? 0 : 1;
}

const later = (a: FactEntry, b: FactEntry): boolean => a.at > b.at || (a.at === b.at && byText(a.fact, b.fact) > 0);

// The facts the term matches, best first: by match, then the latest first, then id. A fact is its
// latest claim, so a fact key is matched by that claim's words alone, never by words it no longer
// has. A fact naming a withheld person or organization is left out.
export function factMatches(term: string, entries: Iterable<FactEntry>, withheld: ReadonlySet<string>): FactEntry[] {
  const latest = new Map<string, FactEntry>();
  for (const entry of entries) {
    const was = latest.get(entry.factKey);
    if (was === undefined || later(entry, was)) latest.set(entry.factKey, entry);
  }
  const found: { entry: FactEntry; rank: number }[] = [];
  for (const entry of latest.values()) {
    if (entry.entities.some((one) => withheld.has(one)) || (entry.subject !== null && withheld.has(entry.subject)))
      continue;
    const rank = wordMatch(term, entry.text);
    if (rank !== null) found.push({ entry, rank });
  }
  return found
    .sort((a, b) => a.rank - b.rank || b.entry.at - a.entry.at || byText(a.entry.fact, b.entry.fact))
    .map((one) => one.entry);
}

// The messages the term matches, best first: 0, a word of the subject starts with it; 1, a word of
// the sender's name or address does; 2, the subject holds it; 3, the sender does. Then newest
// first, then id.
export function mailMatches(
  term: string,
  entries: Iterable<MailEntry>,
): { entry: MailEntry; match: "subject" | "sender" }[] {
  const found: { entry: MailEntry; rank: number; match: "subject" | "sender" }[] = [];
  for (const entry of entries) {
    const subject = wordMatch(term, entry.subjectText);
    const sender = wordMatch(term, entry.senderText);
    const rank = Math.min(subject === null ? 9 : subject * 2, sender === null ? 9 : sender * 2 + 1);
    if (rank === 9) continue;
    found.push({ entry, rank, match: rank % 2 === 0 ? "subject" : "sender" });
  }
  return found
    .sort((a, b) => a.rank - b.rank || b.entry.at - a.entry.at || byText(a.entry.message, b.entry.message))
    .map(({ entry, match }) => ({ entry, match }));
}

// A value that does not open is null: its row is indexed as matching nothing.
const unless = <T>(open: () => T): T | null => {
  try {
    return open();
  } catch {
    return null;
  }
};

type Opener<T> = (rows: readonly string[]) => Promise<T[]>;

// The index brought to the stamp: the gone dropped, the new opened.
async function current<T>(
  query: Query,
  was: ItemIndex<T> | null,
  stampSql: string,
  idsSql: string,
  args: unknown[],
  keyOf: (entry: T) => string,
  open: Opener<T>,
): Promise<ItemIndex<T>> {
  const [{ stamp: now } = { stamp: "" }] = await query<{ stamp: string }>(stampSql, args);
  if (was?.stamp === now) return was;
  const ids = new Set((await query<{ id: string }>(idsSql, args)).map((row) => row.id));
  const entries = new Map<string, T>();
  for (const [id, entry] of was?.entries ?? []) if (ids.has(id)) entries.set(id, entry);
  const fresh = [...ids].filter((id) => !entries.has(id));
  for (let at = 0; at < fresh.length; at += BATCH)
    for (const entry of await open(fresh.slice(at, at + BATCH))) entries.set(keyOf(entry), entry);
  return { stamp: now, entries };
}

type FactRow = {
  id: string;
  type: string;
  fact_key_fp: string;
  valid_from: Date;
  compartments: string[];
  content_enc: Sealed;
  entities: string[];
};
type MailRow = {
  id: string;
  sent_at: Date;
  compartments: string[];
  subject_enc: Sealed;
  sender_enc: Sealed;
  sender_name_enc: Sealed;
};

const masked = (text: string | null): string | null => (text === null ? null : maskCredentials(text).text);

function search(context: AdminContext, holder: ItemsHolder, wanted: string): Promise<OwnerSearchItems> {
  const generation = holder.generation;
  return context.transaction(async (query) => {
    const audience = await ownerAudience(query);
    const opens = (compartments: string[]): boolean =>
      compartments.length > 0 && compartments.every((one) => context.keys.compartments.has(one));
    const facts = await current<FactEntry>(
      query,
      holder.facts,
      FACT_STAMP,
      FACT_IDS,
      [audience, [...BELIEF_TYPES]],
      (entry) => entry.fact,
      async (ids) =>
        (await query<FactRow>(FACT_ROWS, [ids])).map((row): FactEntry => {
          const record = opens(row.compartments) ? unless(() => claimRecordUnder(context.keys, row)) : null;
          const words = record === null ? "" : (masked(claimWords(record)) ?? "");
          const self = record?.subjectKind === "owner";
          const subject =
            record === null || self || typeof record.claim.content.subject !== "string"
              ? null
              : record.claim.content.subject;
          return {
            fact: row.id,
            factKey: row.fact_key_fp,
            type: row.type,
            subject,
            self,
            entities: row.entities,
            words,
            text: normalized(words),
            at: row.valid_from.getTime(),
          };
        }),
    );
    const mail = await current<MailEntry>(
      query,
      holder.mail,
      MAIL_STAMP,
      MAIL_IDS,
      [audience],
      (entry) => entry.message,
      async (ids) =>
        (await query<MailRow>(MAIL_ROWS, [ids])).map((row): MailEntry => {
          const words = (column: "subject_enc" | "sender_enc" | "sender_name_enc"): string | null =>
            row[column] === null ? null : open(context.keys, row, `knowledge.messages.${column}`, "throw");
          const opened = opens(row.compartments)
            ? unless(() => ({
                subject: words("subject_enc"),
                address: words("sender_enc"),
                name: words("sender_name_enc"),
              }))
            : null;
          const subject = masked(opened?.subject ?? null);
          const sender = [opened?.name ?? null, opened?.address ?? null].filter((one) => one !== null);
          return {
            message: row.id,
            at: row.sent_at.getTime(),
            subject,
            from: sender[0] ?? null,
            subjectText: normalized(subject ?? ""),
            senderText: normalized(sender.join(" ")),
          };
        }),
    );
    // An erasure while this read ran drops what it read: kept, it could hold the erased.
    if (holder.generation === generation) [holder.facts, holder.mail] = [facts, mail];

    const withheld = await ownerWithheld(query);
    const factsFound = factMatches(wanted, facts.entries.values(), withheld).slice(0, SEARCH_GROUP_MOST);
    const who = await ownerWho(
      { query, keys: context.keys },
      factsFound.flatMap((one) => (one.subject === null ? [] : [one.subject])),
    );
    return {
      facts: factsFound.map((one) => ({
        fact: FactId.parse(one.fact),
        type: one.type,
        self: one.self,
        subject: one.subject === null ? null : (who.get(one.subject) ?? null),
        words: { untrusted: one.words },
        at: stamp(new Date(one.at)),
      })),
      mail: mailMatches(wanted, mail.entries.values())
        .slice(0, SEARCH_GROUP_MOST)
        .map(({ entry, match }) => ({
          message: MessageId.parse(entry.message),
          at: stamp(new Date(entry.at)),
          subject: entry.subject === null ? null : { untrusted: entry.subject },
          from: entry.from === null ? null : { untrusted: entry.from },
          match,
        })),
    };
  });
}

// Searches take turns: each begins its transaction when the one before it has ended.
export function ownerSearchItems(context: AdminContext, holder: ItemsHolder, term: string): Promise<OwnerSearchItems> {
  const wanted = normalized(term);
  if (wanted === "") return Promise.resolve({ facts: [], mail: [] });
  const run = (holder.turn ?? Promise.resolve()).then(() => search(context, holder, wanted));
  holder.turn = run.catch(() => undefined);
  return run;
}
