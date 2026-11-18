import { SAME_PERSON_RECENT_MOST, type SamePersonBriefPair } from "@intelligence/contracts/personal";
import { isMintedKey, normalizeAddress, phoneDigits } from "@intelligence/personal-core";
import { againstSame, type RecordValue, recordsRefusal, type SameFacts } from "@intelligence/personal-core/planner";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { within } from "../core/labels.ts";
import { openedOrNull } from "../core/tx.ts";
import { DETAIL_CONTACTS } from "../read/read-tools-entity.ts";
import { type ContactFacts, contactLinks } from "./contact-candidates.ts";

// What a same-person check weighs: every record of the two people, what each holds under the pair's
// label, and what stands against a same. The reader's check (agent-work/same-person-report.ts)
// opens values under the caller's token; the identity sweep's dry runs here open them with the
// admin's keys and write nothing.

type CardFacts = {
  names?: string[];
  phones?: { value?: string }[];
  organizations?: { name?: string | null; title?: string | null }[];
};
type Records = NonNullable<SamePersonBriefPair["records"]>["a"];
// One value a person's records hold, and the row it stands on.
export type Held = RecordValue & { row: string };
// `held` is everything under the label, which code weighs; `records` what the agent is shown of it.
export type Person = { records: Records; held: Held[]; shown: string[]; bound: string[]; nameFps: Map<string, string> };

const ALIASES =
  "select entity_id, id, compartments, value_enc, value_fp, evidence_id from knowledge.aliases where entity_id = any($1::text[])";
const ACCOUNTS =
  "select entity_id, id, compartments, value_enc from knowledge.accounts where entity_id = any($1::text[])";
const CARDS = `
  select a.entity_id, c.id, c.compartments, c.facts_enc as value_enc, c.evidence_id from knowledge.contacts c
  join knowledge.contact_addresses a on a.contact_id = c.id
  where c.compartments = array['own']::text[] and a.entity_id = any($1::text[])
  order by c.updated_at desc, c.id`;
const MAIL = `
  select i.entity_id, m.compartments, count(*) filter (where i.direction = 'inbound')::int as inbound, count(*) filter (where i.direction = 'outbound')::int as outbound
  from knowledge.interaction_log i join knowledge.messages m on m.evidence_id = i.evidence_id
  where i.entity_id = any($1::text[]) and not m.held group by i.entity_id, m.compartments`;
// Each person's latest messages, newest first: more than a brief lists, since a pair's label may
// leave some out. Ids, times and the sealed subject; a brief opens the subject under the caller's keys.
const RECENT_READ = SAME_PERSON_RECENT_MOST * 4;
const RECENT = `
  select x.entity_id, x.id, x.compartments, x.sent_at, x.value_enc, x.evidence_id from (
    select i.entity_id, m.id, m.compartments, m.sent_at, m.subject_enc as value_enc, m.evidence_id,
      row_number() over (partition by i.entity_id order by m.sent_at desc, m.id) as nth
    from knowledge.interaction_log i join knowledge.messages m on m.evidence_id = i.evidence_id
    where i.entity_id = any($1::text[]) and not m.held) x
  where x.nth <= ${RECENT_READ}
  order by x.sent_at desc, x.id`;
const wrap = (value: string): { untrusted: string } => ({ untrusted: value });

type Row = { entity_id: string; id: string; compartments: string[]; value_enc: unknown };
export type Loaded = {
  aliases: (Row & { value_fp: string; evidence_id: string })[];
  accounts: Row[];
  cards: (Row & { evidence_id: string })[];
  mail: { entity_id: string; compartments: string[]; inbound: number; outbound: number }[];
  recent: (Row & { sent_at: Date; evidence_id: string })[];
  opened: Map<string, string | null>;
};

export type Open = (table: string, column: string, row: Row) => string | null;
// A record's sealed value opened with these keys, or null when it will not open.
export const openerOf =
  (keys: Keys): Open =>
  (table, column, row) =>
    openedOrNull(keys, row.compartments, { table, id: row.id, column }, row.value_enc);
export type Reads = <T>(text: string, values: unknown[]) => Promise<T[]>;

// Every record of these people in one read a statement, so a batch costs what one person does; each sealed
// value opens once, however many pairs hold it. Labels are applied per pair, in personOf.
export async function recordsOf(run: Reads, entities: readonly string[]): Promise<Loaded> {
  const ids = [...new Set(entities)];
  return {
    aliases: await run(ALIASES, [ids]),
    accounts: await run(ACCOUNTS, [ids]),
    cards: await run(CARDS, [ids]),
    mail: await run(MAIL, [ids]),
    recent: await run(RECENT, [ids]),
    opened: new Map(),
  };
}

// What one person's records hold, the whole person as every read tool answers for them, within the pair's
// label. Only an `own` card is read, as get_entity serves no other, and at most DETAIL_CONTACTS are shown, marked
// use-only; every `own` card under the label counts against a same, shown or not. Every value goes to the agent as
// untrusted, and what is shown is on the read log, so a deletion reaches what was written after it.
export function personOf(sealed: Open, loaded: Loaded, members: readonly string[], label: readonly string[]): Person {
  const open = (table: string, column: string, row: Row): string | null => {
    const key = `${table}:${row.id}`;
    const known = loaded.opened.get(key);
    if (known !== undefined) return known;
    const value = sealed(table, column, row);
    loaded.opened.set(key, value);
    return value;
  };
  const mine = new Set(members);
  const held: Held[] = [];
  const nameFps = new Map<string, string>();
  const names: string[] = [];
  const shown: string[] = [];
  for (const row of loaded.aliases) {
    if (!mine.has(row.entity_id) || !within(row.compartments, label)) continue;
    const value = open("knowledge.aliases", "value_enc", row);
    if (value === null) continue;
    names.push(value);
    nameFps.set(asValue({ field: "name", value }), row.value_fp);
    held.push({ field: "name", value, row: row.id });
    shown.push(row.evidence_id);
  }
  const addresses: string[] = [];
  for (const row of loaded.accounts) {
    if (!mine.has(row.entity_id) || !within(row.compartments, label)) continue;
    const value = open("knowledge.accounts", "value_enc", row);
    if (value === null || isMintedKey(value)) continue;
    addresses.push(value);
    held.push({ field: "address", value, row: row.id });
  }
  const bound: string[] = [];
  const cards: Records["cards"] = [];
  const seen = new Set<string>();
  for (const row of loaded.cards) {
    if (!mine.has(row.entity_id) || seen.has(row.id) || !within(row.compartments, label)) continue;
    seen.add(row.id);
    const text = open("knowledge.contacts", "facts_enc", row);
    if (text === null) continue;
    let facts: CardFacts;
    try {
      facts = JSON.parse(text) as CardFacts;
    } catch {
      continue;
    }
    const phones = (facts.phones ?? []).flatMap((one) => (one.value === undefined ? [] : [String(one.value)]));
    const companies = facts.organizations ?? [];
    const links = contactLinks(facts as ContactFacts);
    for (const value of facts.names ?? []) held.push({ field: "name", value, row: row.id });
    for (const value of phones) held.push({ field: "phone", value, row: row.id });
    for (const one of companies) if (one.name) held.push({ field: "company", value: one.name, row: row.id });
    for (const value of links) held.push({ field: "link", value, row: row.id });
    if (cards.length >= DETAIL_CONTACTS) continue;
    shown.push(row.evidence_id);
    if (links.length > 0) bound.push(row.evidence_id);
    cards.push({
      disclosure: "use_only",
      names: (facts.names ?? []).map(wrap),
      phones: phones.map(wrap),
      companies: companies.map((one) => ({
        name: one.name ? wrap(one.name) : null,
        title: one.title ? wrap(one.title) : null,
      })),
      links: links.map(wrap),
    });
  }
  const mail = { inbound: 0, outbound: 0 };
  for (const row of loaded.mail) {
    if (!mine.has(row.entity_id) || !within(row.compartments, label)) continue;
    mail.inbound += row.inbound;
    mail.outbound += row.outbound;
  }
  // The person's latest messages under the pair's label, each once however many of the person's
  // records its log names: what an agent reads to answer, so the brief gives the ids. A subject
  // that does not open is served as none.
  const recent: NonNullable<Records["recent"]> = [];
  const listed = new Set<string>();
  for (const row of loaded.recent) {
    if (recent.length >= SAME_PERSON_RECENT_MOST) break;
    if (!mine.has(row.entity_id) || listed.has(row.id) || !within(row.compartments, label)) continue;
    listed.add(row.id);
    const subject = row.value_enc === null ? null : open("knowledge.messages", "subject_enc", row);
    recent.push({
      message: row.id,
      at: new Date(row.sent_at).toISOString(),
      subject: subject === null ? null : wrap(subject),
    });
    shown.push(row.evidence_id);
  }
  return {
    records: {
      names: [...new Set(names)].map(wrap),
      addresses: [...new Set(addresses)].map(wrap),
      mail,
      recent,
      cards,
    },
    held,
    shown,
    bound,
    nameFps,
  };
}

export function asValue(one: { field: RecordValue["field"]; value: string }): string {
  return one.field === "address"
    ? (normalizeAddress(one.value) ?? "")
    : one.value.trim().toLowerCase().replace(/\s+/gu, " ");
}

// What every same is weighed against, from all each person's records hold and the phones its quotes hold.
// Who else carries a name is read by its fingerprint on either side; a shared name neither side has one for can't
// be counted. Only people the pair's label shows count, and a person is counted once, as every read tool answers.
export async function factsOf(
  run: Reads,
  idOf: (entity: string) => string,
  pair: { a_entity: string; b_entity: string; compartments: string[] },
  a: Person,
  b: Person,
  quoted: { a: string[]; b: string[] },
): Promise<SameFacts> {
  const of = (person: Person, field: RecordValue["field"]): string[] =>
    person.held.filter((one) => one.field === field).map((one) => one.value);
  const theirs = new Set(of(b, "name").map((value) => asValue({ field: "name", value })));
  const shared = [...new Set(of(a, "name").map((value) => asValue({ field: "name", value })))].filter((name) =>
    theirs.has(name),
  );
  const fpsOf = (name: string): string[] => [a.nameFps.get(name) ?? [], b.nameFps.get(name) ?? []].flat();
  const fps = [...new Set(shared.flatMap(fpsOf))];
  const holders =
    fps.length === 0
      ? []
      : await run<{ entity_id: string }>(
          "select distinct entity_id from knowledge.aliases where value_fp = any($1::text[]) and compartments <@ $2::text[]",
          [fps, pair.compartments],
        );
  const people = new Set(holders.map((one) => idOf(one.entity_id)));
  people.delete(idOf(pair.a_entity));
  people.delete(idOf(pair.b_entity));
  const phones = (person: Person, more: string[]): Set<string> =>
    new Set([...of(person, "phone").map(phoneDigits), ...more].filter((one) => one !== ""));
  const lines = phones(b, quoted.b);
  return {
    sharedName: shared.length > 0,
    otherHolders: people.size,
    nameUncounted: shared.some((name) => fpsOf(name).length === 0),
    companies: { a: of(a, "company"), b: of(b, "company") },
    sharedPhone: [...phones(a, quoted.a)].some((one) => lines.has(one)),
  };
}

const PROVABLE = ["shared_address", "same_link", "same_company", "address_matches_company"] as const;
export type Provable = { pairs: number; by: Record<(typeof PROVABLE)[number], number> };

// Of these pairs, how many hold a value from each side that agrees and that nothing stands against, by what agrees:
// what agents could settle from records alone, as code would check it. A dry run's read, with the admin's keys.
export async function provablePairs(
  admin: { keys: Keys },
  query: Query,
  membersOf: (entity: string) => readonly string[],
  pairs: readonly { a: string; b: string; label: readonly string[] }[],
): Promise<Provable> {
  const out: Provable = {
    pairs: 0,
    by: { shared_address: 0, same_link: 0, same_company: 0, address_matches_company: 0 },
  };
  const loaded = await recordsOf(
    query,
    pairs.flatMap((one) => [...membersOf(one.a), ...membersOf(one.b)]),
  );
  for (const pair of pairs) {
    const { a, b, facts } = await adminPairFacts(admin, query, membersOf, loaded, pair);
    const kinds = PROVABLE.filter((kind) => recordsRefusal(kind, a.held, b.held, facts) === null);
    for (const kind of kinds) out.by[kind] += 1;
    if (kinds.length > 0) out.pairs += 1;
  }
  return out;
}

// What stands against a `same` the dream pass's judge said of one pair, read as
// for an agent's same from all each person's records hold, or null. A dry run's read
// shape, with the admin's keys: nothing is written.
export async function againstOf(
  admin: { keys: Keys },
  query: Query,
  membersOf: (entity: string) => readonly string[],
  pair: { a: string; b: string; label: readonly string[] },
): Promise<string | null> {
  const loaded = await recordsOf(query, [...membersOf(pair.a), ...membersOf(pair.b)]);
  return againstSame((await adminPairFacts(admin, query, membersOf, loaded, pair)).facts);
}

// One pair's two people and the facts between them, from records already loaded, opened with the
// admin's keys: a record that will not open is left out.
async function adminPairFacts(
  admin: { keys: Keys },
  query: Query,
  membersOf: (entity: string) => readonly string[],
  loaded: Loaded,
  pair: { a: string; b: string; label: readonly string[] },
) {
  const opened = openerOf(admin.keys);
  const idOf = (entity: string): string => [...membersOf(entity)].sort()[0] ?? entity;
  const label = [...pair.label];
  const a = personOf(opened, loaded, membersOf(pair.a), label);
  const b = personOf(opened, loaded, membersOf(pair.b), label);
  const facts = await factsOf(query, idOf, { a_entity: pair.a, b_entity: pair.b, compartments: label }, a, b, {
    a: [],
    b: [],
  });
  return { a, b, facts };
}
