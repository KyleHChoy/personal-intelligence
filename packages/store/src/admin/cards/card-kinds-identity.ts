import type { CardLine, IdentityVerdict, RulingId } from "@intelligence/contracts/personal";
import { CARD_OPTIONS, partsAt } from "@intelligence/contracts/personal";
import { isMintedKey } from "@intelligence/personal-core";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { codeLine, part } from "../../cards/card-line.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { cardRulingRequest } from "../../core/queue.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { bandOf, writeVerdict } from "../../core/verdicts.ts";
import { IDENTITY_POINTS, pairSubject } from "../../identity/identity-points.ts";
import { personOf, writeRuling } from "../rulings/admin-identity.ts";
import { RULING_LOCKS } from "../rulings/owner-ruling.ts";

// The two identity card kinds. Each card's
// lines are built by `render` from current rows, read in the card's transaction and opened under
// the admin's keys: what a person or a contact wrote is a `source` line, and what code counted is
// a `code` line.

const entityRefs = (card: StoredCard): string[] =>
  card.refs.filter((ref) => ref.kind === "entity").map((ref) => ref.id);

type Known = { contacts: number; sent: number; received: number; meetings: number };

export async function personLines(
  query: Query,
  keys: Keys,
  entity: string,
  index: number,
): Promise<{ lines: CardLine[]; known: Known }> {
  const names = await query<{ id: string; value_enc: Sealed; compartments: string[] }>(
    "select id, value_enc, compartments from knowledge.aliases where entity_id = $1 order by id",
    [entity],
  );
  const addresses = await query<{ id: string; value_enc: Sealed; compartments: string[] }>(
    "select id, value_enc, compartments from knowledge.accounts where entity_id = $1 order by id",
    [entity],
  );
  const [counts] = await query<Known>(
    `select (select count(distinct contact_id)::int from knowledge.contact_addresses where entity_id = $1) as contacts,
       (select count(distinct evidence_id)::int from knowledge.interaction_log where entity_id = $1 and direction = 'outbound') as sent,
       (select count(distinct evidence_id)::int from knowledge.interaction_log where entity_id = $1 and direction = 'inbound') as received,
       (select count(distinct event_id)::int from knowledge.event_participants where entity_id = $1) as meetings`,
    [entity],
  );
  const known = counts ?? { contacts: 0, sent: 0, received: 0, meetings: 0 };
  const seen = (rows: typeof names, column: "knowledge.aliases.value_enc" | "knowledge.accounts.value_enc") =>
    [...new Set(rows.flatMap((row) => open(keys, row, column, "null") ?? []))].sort();
  return {
    lines: [
      codeLine("person", [part.count(index), part.id("entity", entity)], [{ kind: "entity", id: entity }]),
      ...seen(names, "knowledge.aliases.value_enc").map((text) => ({ text, from: "source" as const })),
      // A key the system made is an id, never shown as an address.
      ...seen(addresses, "knowledge.accounts.value_enc")
        .filter((text) => !isMintedKey(text))
        .map((text) => ({ text, from: "source" as const })),
      codeLine(
        "known_by",
        partsAt("known_by", {
          person: part.count(index),
          contacts: part.count(known.contacts),
          sent: part.count(known.sent),
          received: part.count(known.received),
          meetings: part.count(known.meetings),
        }),
      ),
    ],
    known,
  };
}

// The names of each stored contact that lists every one of these people.
async function contactNames(query: Query, keys: Keys, entities: string[]): Promise<string[]> {
  const rows = await query<{ id: string; facts_enc: Sealed; compartments: string[] }>(
    `select c.id, c.facts_enc, c.compartments from knowledge.contacts c
     where (select count(distinct a.entity_id) from knowledge.contact_addresses a where a.contact_id = c.id and a.entity_id = any($1)) = cardinality($1::text[])
     order by c.id`,
    [entities],
  );
  const names = rows.flatMap((row) => {
    const facts = open(keys, row, "knowledge.contacts.facts_enc", "null");
    return facts === null ? [] : ((JSON.parse(facts) as { names?: string[] }).names ?? []);
  });
  return [...new Set(names)].sort();
}

// The card's fingerprints, read in decide's transaction after its lock call.
const fpsOf = async (query: Query, card: StoredCard): Promise<string[]> => {
  const fps: string[] = [];
  for (const entity of entityRefs(card)) fps.push((await personOf(query, entity)).fp);
  return fps;
};

async function rule(query: Query, ruling: RulingId, verdict: IdentityVerdict, fps: string[], now: Date): Promise<void> {
  const [a, b] = fps;
  if (a === undefined) throw new AdminError("not_found");
  try {
    await writeRuling(query, ruling, verdict, a, b ?? null, now);
  } catch (error) {
    if (error instanceof AdminError && error.code === "already_settled") return;
    throw error;
  }
}

// A verdict counts as deliberate when the owner answered it alone with at most this many cards
// pending: a long queue answered fast is hurried.
const DELIBERATE_QUEUE_DEPTH = 10;

// Deliberate unless the decision was a batch or the queue held more than its cap. Written in the
// decision's own transaction, after its lock call; with no saved answer, or a rejection, none is
// written.
const RANK = IDENTITY_POINTS[0];

async function rankVerdict(
  query: Query,
  keys: Keys,
  ruling: RulingId,
  answer: string,
  fps: string[],
  now: Date,
): Promise<void> {
  const [a, b] = fps;
  if (a === undefined || b === undefined || RANK === undefined) return;
  const [call] = await query<{ id: string; compartments: string[]; output_enc: Sealed }>(
    "select id, compartments, output_enc from vault.decision_calls where point = $1 and version = $2 and subject = $3 order by created_at desc, id desc limit 1",
    [RANK.id, RANK.version, pairSubject(a, b)],
  );
  if (call === undefined) return;
  let p: unknown;
  try {
    const { rawOutput } = JSON.parse(open(keys, call, "vault.decision_calls.output_enc", "throw")) as {
      rawOutput: string;
    };
    p = (JSON.parse(rawOutput) as { same_person?: unknown }).same_person;
  } catch {
    return;
  }
  if (typeof p !== "number" || !(p >= 0 && p <= 1)) return;
  const [decision] = await query<{ batch: boolean; queue_depth: number }>(
    "select batch, queue_depth from knowledge.owner_decisions where id = $1",
    [ruling],
  );
  await writeVerdict(
    query,
    keys,
    {
      point: RANK.id,
      version: RANK.version,
      callId: call.id,
      evidenceId: null,
      source: "card",
      verdict: answer === "same" ? "yes" : "no",
      p,
      band: bandOf(p),
      weight: 1,
      hurried: false,
      deliberate: decision?.batch === false && decision.queue_depth <= DELIBERATE_QUEUE_DEPTH,
      compartments: call.compartments,
      requestId: cardRulingRequest(ruling),
    },
    now,
  );
}

export const samePerson: CardKindRow = {
  options: CARD_OPTIONS.same_person,
  lockIds: async () => [RULING_LOCKS.identity],
  async render(card, _open, { query, keys }) {
    const entities = entityRefs(card);
    const people = [];
    for (const [i, entity] of entities.entries()) people.push(await personLines(query, keys, entity, i + 1));
    const both = await contactNames(query, keys, entities);
    return [
      ...people.flatMap((one) => one.lines),
      ...both.map((text) => ({ text, from: "source" as const })),
      codeLine("identity_basis", [part.code(both.length > 0 ? "contact" : "name")]),
      ...(people.some((one) => one.known.sent === 0) ? [codeLine("never_written")] : []),
    ];
  },
  effect: async ({ query, card, answer, ruling, now, keys }) => {
    const fps = await fpsOf(query, card);
    await rankVerdict(query, keys, ruling, answer, fps, now);
    await rule(query, ruling, answer === "same" ? "same" : "different", fps, now);
  },
};

export const sharedAddress: CardKindRow = {
  options: CARD_OPTIONS.shared_address,
  lockIds: async () => [RULING_LOCKS.identity],
  async render(card, _open, { query, keys }) {
    const [entity] = entityRefs(card);
    if (entity === undefined) return [];
    const person = await personLines(query, keys, entity, 1);
    const named = await contactNames(query, keys, [entity]);
    return [
      ...person.lines,
      ...named.map((text) => ({ text, from: "source" as const })),
      codeLine("identity_basis", [part.code("shared_address")]),
    ];
  },
  effect: async ({ query, card, answer, ruling, now }) =>
    rule(query, ruling, answer === "shared" ? "shared" : "single", (await fpsOf(query, card)).slice(0, 1), now),
};
