import { CARD_OPTIONS, type CardId, type PersonalRef, RuledTier, sortedLabel } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { StoredCard } from "../../cards/card-kind-row.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import { authorWord, TIER_LOCK } from "../../core/locks.ts";
import { lockRows, raiseCard } from "../../core/queue.ts";
import { OWNER_ENTITY_FIRST } from "../../core/statements.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerBeliefs, ownerWithheld } from "../admin-owner.ts";

// The tier proposer, by code, no model.
// When the owner has set one warmth tier, by rulings in force made in the last 30 days, for at
// least 3 people who share a trait their beliefs state (one organization by affiliation, with the
// affiliation's relation when it states one; one role title; or one relation to the owner), one
// `tier_proposal` card proposes that tier for the others with the trait whom the owner has never
// ruled on, at most 12 named. Everything is read as pi_admin inside the owner's one audience:
// beliefs through `ownerBeliefs`, people through the owner's audience's accounts, names through
// `ownerWho`, and no
// withheld person; the card's label is the union of the labels of what it read and of the rows
// its names are read from (invariant 4). One card per (trait, tier) at a time, by its case key; a
// `reject` by the owner stops the pair until an owner's ruling of that tier on one of its people is
// newer than the reject. A `confirm` writes, for each proposed person who still holds the trait, is
// not withheld and has no ruling of the owner's, that tier's ruling through the tier write, one decision
// each. The pass runs after each `Admin.setTier`, under the tier lock, at most MOST_CARDS cards.
//
// The card has no body, which a card's view would show as it is: its refs are the people it
// names, the proposed first; its case key is `<tier>:<trait kind>:<the trait's fingerprint, 40
// characters>`. Its lines are read again from the owner's audience when it is shown, so an erased or
// changed belief names nothing; a ref ruled on before the card was raised is one the owner moved.

const TIER_AUTHOR = "system:tier";
const KIND = "tier_proposal";
const WINDOW_MS = 30 * DAY_MS;
const LEAST_MOVED = 3;
const MOST_PROPOSED = 12;
// A card's refs hold at most 20: the proposed, then as many moved as fit.
const MOST_REFS = 20;
const MOST_CARDS = 3;
const TRAIT_TEXT_MOST = 200;
const FP_CHARS = 40;
// A relation that says only that there is one is no trait.
const NO_TRAIT = "other";

const TraitKinds = ["organization", "role", "relation"] as const;
type TraitKind = (typeof TraitKinds)[number];
// `value` is the organization's id, the title or the relation; `relation` an affiliation's own.
type Trait = { kind: TraitKind; fp: string; value: string; relation: string | null; people: Map<string, string[]> };

const TYPES: Record<TraitKind, string> = { organization: "affiliation", role: "role", relation: "relationship" };

// The fact keys of the given types' claims within the owner's audience, of the people given or of all.
const TRAIT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type = any ($1::text[]) and c.compartments <@ $2::text[]
    and ($3::text[] is null or exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = any ($3::text[])))
  order by 1`;

const KINDS = "select e.id, e.kind from knowledge.entities e where e.id = any ($1::text[]) order by e.id";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, TRAIT_TEXT_MOST) : null;
const relationOf = (value: unknown): string | null => {
  const relation = text(value);
  return relation === null || relation.toLowerCase() === NO_TRAIT ? null : relation;
};

// Each trait of the given kinds the owner's beliefs state of a person, keyed by its fingerprint, with each
// person's labels of the beliefs that state it. Only beliefs in force and undisputed; an
// affiliation's organization only when it is an organization; a relationship only one whose
// subject is the person and whose counterparty is the owner, so a relation is read one way.
async function traitsOf(
  tx: Tx,
  people: readonly string[] | null,
  kinds: readonly TraitKind[] = TraitKinds,
): Promise<Map<string, Trait>> {
  const audience = await ownerAudience(tx.query);
  const traits = new Map<string, Trait>();
  if (audience.length === 0 || kinds.length === 0 || (people !== null && people.length === 0)) return traits;
  const keys = (
    await tx.query<{ fact_key_fp: string }>(TRAIT_KEYS, [kinds.map((kind) => TYPES[kind]), audience, people])
  ).map((row) => row.fact_key_fp);
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY_FIRST);
  type Found = Omit<Trait, "fp" | "people"> & { person: string; compartments: string[] };
  const found: Found[] = [];
  const add = (one: Found): void => void found.push(one);
  for (const { belief, compartments } of await ownerBeliefs(tx, keys)) {
    if ((belief.status !== "active" && belief.status !== "stale") || belief.disputed) continue;
    const person = belief.subject as string;
    if (belief.kind === "affiliation") {
      const organization = text(belief.values.organization);
      if (organization !== null)
        add({
          person,
          kind: "organization",
          value: organization,
          relation: relationOf(belief.values.relation),
          compartments,
        });
    } else if (belief.kind === "role") {
      const title = text(belief.values.title);
      if (title !== null) add({ person, kind: "role", value: title, relation: null, compartments });
    } else if (belief.kind === "relationship" && owner !== undefined && belief.values.counterparty === owner.id) {
      const relation = relationOf(belief.values.relation);
      if (relation !== null) add({ person, kind: "relation", value: relation, relation: null, compartments });
    }
  }
  // Only people, and only organizations as an affiliation's other end.
  const ids = [
    ...new Set(found.flatMap((one) => (one.kind === "organization" ? [one.person, one.value] : [one.person]))),
  ];
  const entityKinds = new Map(
    (await tx.query<{ id: string; kind: string }>(KINDS, [ids])).map((row) => [row.id, row.kind]),
  );
  for (const one of found) {
    if (
      entityKinds.get(one.person) !== "person" ||
      (one.kind === "organization" && entityKinds.get(one.value) !== "organization")
    )
      continue;
    if (people !== null && !people.includes(one.person)) continue;
    const fp = fingerprint(tx.keys, "tier_trait", `${one.kind}:${one.value}:${one.relation ?? ""}`);
    const trait = traits.get(fp) ?? {
      kind: one.kind,
      fp,
      value: one.value,
      relation: one.relation,
      people: new Map<string, string[]>(),
    };
    trait.people.set(one.person, [...(trait.people.get(one.person) ?? []), ...one.compartments]);
    traits.set(fp, trait);
  }
  return traits;
}

// The owner's rulings in force made since `$1`, each with the people its fingerprints name in their audience.
const MOVES = `
  select r.tier, r.created_at, r.compartments,
    array(select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
          where a.value_fp = any (r.value_fps) and a.compartments <@ $2::text[] order by 1) as people
  from knowledge.tier_rulings r where r.lifted_at is null and r.created_at >= $1
  order by r.created_at, r.ruling_id collate "C"`;

// Every person any ruling of the owner's, in force or lifted, named by `$1` (null: any time), of the
// people `$2` (null: all).
const RULED = `
  select distinct a.entity_id from knowledge.tier_rulings r join knowledge.accounts a on a.value_fp = any (r.value_fps)
  where ($1::timestamptz is null or r.created_at <= $1) and ($2::text[] is null or a.entity_id = any ($2::text[]))
  order by 1`;

// The compartments of every row the card's names are read from within the owner's audience (ownerWho's
// rows): the people's aliases and accounts, and the organization's domains, names and the role and
// affiliation claims naming it; with the people's accounts, which a confirmed ruling is labelled by.
const NAME_LABELS = `
  select coalesce(array_agg(distinct x order by x), '{}') as compartments from (
    select s.compartments from knowledge.aliases s where s.entity_id = any ($1::text[]) and s.compartments <@ $2::text[]
    union all
    select a.compartments from knowledge.accounts a where a.entity_id = any ($1::text[]) and a.compartments <@ $2::text[]
    union all
    select d.compartments from knowledge.domains d where d.entity_id = any ($3::text[]) and d.compartments <@ $2::text[]
    union all
    select n.compartments from knowledge.organization_names n join knowledge.domains d on d.domain_fp = n.domain_fp
    where d.entity_id = any ($3::text[]) and n.lifted_at is null and n.compartments <@ $2::text[]
    union all
    select c.compartments from knowledge.claim_entities e join knowledge.claims c on c.id = e.claim_id
    where e.entity_id = any ($3::text[]) and c.type in ('role', 'affiliation') and c.compartments <@ $2::text[]
  ) t cross join unnest(t.compartments) as x`;

// When the owner last rejected the pair's card, or null.
const REJECTED = `
  select max(d.decided_at) as at from knowledge.owner_decisions d join ledger.cards c on c.id = d.card_id
  where c.kind = '${KIND}' and c.case_key = $1 and d.kind = 'answer' and d.answer = 'reject'`;

const caseKeyOf = (trait: Trait, tier: RuledTier): string => `${tier}:${trait.kind}:${trait.fp.slice(0, FP_CHARS)}`;

export function peopleOf(card: StoredCard): string[] {
  return card.refs.filter((ref) => ref.kind === "entity").map((ref) => ref.id);
}

export function caseOf(card: StoredCard): { tier: RuledTier; kind: TraitKind; fp: string } | null {
  const [tier, kind, fp] = (card.caseKey ?? "").split(":");
  const parsed = RuledTier.safeParse(tier);
  if (!parsed.success || !TraitKinds.includes(kind as TraitKind) || fp === undefined || !/^[0-9a-f]{40}$/.test(fp))
    return null;
  return { tier: parsed.data, kind: kind as TraitKind, fp };
}

export const ruledIn = async (
  query: Query,
  people: readonly string[],
  until: Date | string | null,
): Promise<Set<string>> =>
  new Set((await query<{ entity_id: string }>(RULED, [until, people])).map((row) => row.entity_id));

// The card's trait, read again for its people, or undefined when no belief states it now.
export const traitOfCard = async (
  tx: Tx,
  card: StoredCard,
  pair: { kind: TraitKind; fp: string },
): Promise<Trait | undefined> =>
  [...(await traitsOf(tx, peopleOf(card), [pair.kind])).values()].find((one) => one.fp.startsWith(pair.fp));

// One pass, in one transaction under the tier lock, so a decision on a card waits for it: the
// cards it raised that were not already open. The author's word is taken in the same call, in
// the order decide takes both, before raiseCard takes it again.
async function proposeTiers(admin: AdminContext): Promise<number> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [authorWord(TIER_AUTHOR), TIER_LOCK]);
    const audience = await ownerAudience(query);
    if (audience.length === 0) return 0;
    // Each person's tiers by the owner's rulings in force in the window, a person with several addresses
    // under each tier one of them holds.
    const moves = new Map<string, Map<RuledTier, { at: Date; compartments: string[] }>>();
    for (const row of await query<{ tier: RuledTier; created_at: Date; compartments: string[]; people: string[] }>(
      MOVES,
      [new Date(now.getTime() - WINDOW_MS), audience],
    )) {
      for (const person of row.people)
        moves.set(
          person,
          (moves.get(person) ?? new Map()).set(row.tier, { at: row.created_at, compartments: row.compartments }),
        );
    }
    if (moves.size < LEAST_MOVED) return 0;
    const tx: Tx = { query, keys: admin.keys };
    // The traits of the people the owner moved first; every holder only of a trait three of them share.
    const shared = [...(await traitsOf(tx, [...moves.keys()])).values()].filter((trait) =>
      RuledTier.options.some(
        (tier) => [...trait.people.keys()].filter((person) => moves.get(person)?.has(tier)).length >= LEAST_MOVED,
      ),
    );
    if (shared.length === 0) return 0;
    const all = await traitsOf(tx, null, [...new Set(shared.map((trait) => trait.kind))]);
    const traits = shared.flatMap((trait) => all.get(trait.fp) ?? []).sort((a, b) => byText(a.fp, b.fp));
    const ruled = await ruledIn(query, [...new Set(traits.flatMap((trait) => [...trait.people.keys()]))], null);
    const withheld = await ownerWithheld(query);
    let raised = 0;
    for (const trait of traits) {
      const named = [...trait.people.keys()].filter((person) => !withheld.has(person)).sort(byText);
      const proposed = named.filter((person) => !ruled.has(person)).slice(0, MOST_PROPOSED);
      if (proposed.length === 0) continue;
      for (const tier of RuledTier.options) {
        const moved = named.filter((person) => moves.get(person)?.has(tier));
        if (moved.length < LEAST_MOVED) continue;
        const caseKey = caseKeyOf(trait, tier);
        const [rejected] = await query<{ at: Date | null }>(REJECTED, [caseKey]);
        const since = rejected?.at ?? null;
        if (
          since !== null &&
          !moved.some((person) => (moves.get(person)?.get(tier)?.at.getTime() ?? 0) > since.getTime())
        )
          continue;
        const shown = moved.slice(0, MOST_REFS - proposed.length);
        const [names] = await query<{ compartments: string[] }>(NAME_LABELS, [
          [...shown, ...proposed],
          audience,
          trait.kind === "organization" ? [trait.value] : [],
        ]);
        const label = new Set([
          ...[...shown, ...proposed].flatMap((person) => trait.people.get(person) ?? []),
          ...shown.flatMap((person) => moves.get(person)?.get(tier)?.compartments ?? []),
          ...(names?.compartments ?? []),
        ]);
        const card = {
          id: newId("crd") as CardId,
          requestId: requestIdOf(`${caseKey}\n${now.toISOString()}`),
          kind: KIND,
          author: TIER_AUTHOR,
          options: [...CARD_OPTIONS.tier_proposal],
          target: null,
          refs: [...proposed, ...shown].map((id) => ({ kind: "entity", id }) as PersonalRef),
          compartments: sortedLabel(label),
          expiresAt: null,
          expiresAfterDays: null,
          caseKey,
          run: null,
          body: null,
          bodyFrom: null,
        };
        if (!(await raiseCard(query, card, { now, log: admin.log })).replayed) raised += 1;
        if (raised >= MOST_CARDS) return raised;
      }
    }
    return raised;
  });
}

// The pass after one of the owner's tier rulings: a failure is logged and never fails their ruling.
export async function proposeTiersAfterRuling(admin: AdminContext): Promise<void> {
  try {
    const raised = await proposeTiers(admin);
    if (raised > 0) admin.log.info({ event: "tier_proposals", counts: { raised } });
  } catch (error) {
    admin.log.error({ event: "tier_proposer_failed", code: error instanceof AdminError ? error.code : "failed" });
  }
}
