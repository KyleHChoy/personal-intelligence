import type { Belief } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type BeliefsAsOf,
  type BeliefsAsOfArgs,
  EntityId,
  type FactSource,
  type FactView,
  HISTORY_SUPPORT_MOST,
  type HistoryBelief,
  type LearnedItem,
  type LearnedSince,
  type LearnedSinceArgs,
  type Who,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { stamp } from "../../core/db.ts";
import { OWNER_ENTITY_FIRST } from "../../core/statements.ts";
import { audienceGroups } from "../../identity/warmth-build.ts";
import { stateOf as said } from "../../pipeline/pipeline-beliefs.ts";
import { ADMIN_FACT_SOURCE } from "../../read/fact-source.ts";
import {
  claimRecordUnder,
  type OwnerBelief,
  type OwnerPlace,
  ownerBeliefs,
  ownerPage,
  ownerWho,
  ownerWithheld,
  pageOf,
} from "../admin-owner.ts";
import { WAITING } from "../cards/admin-queue.ts";
import { type ClaimRow, renderFact } from "../rulings/admin-rulings.ts";

// Belief history: what the store believed about someone at a time, and what it has learned since one,
// for the owner as pi_admin. Both compute beliefs from claims by their first-known time through
// `ownerBeliefs` with `asOf`, the one owner belief source, inside the owner's one audience; neither
// is what was true then. A store whose audience has no built belief (never built, or a re-derive or
// removal emptied it) answers `rebuilding`. Nothing here writes or logs.
//
// The reader's filters kept, stated: claims, accounts and rulings within the owner's audience;
// releases, answers, reopens and confirmations as policy.belief_inputs_under decides them for the
// build. `learnedSince` leaves out a belief naming a withheld person or organization
// (ownerWithheld), as the owner's lists do; `beliefsAsOf` answers for the subject the owner named,
// withheld or not, as their entity page does. A held message's claims count as the stored build
// counts them.

const SUBJECT =
  "select e.id, e.kind from knowledge.entities e where e.id = $1 and e.kind in ('owner', 'person', 'organization')";

// The fact keys of the owner's audience's belief-type claims naming one of the subject's members
// ($1), first known by $2.
const SUBJECT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any ($1::text[]))
    and c.type = any ($4::text[]) and c.compartments <@ $3::text[] and c.first_known_at <= $2::timestamptz
  order by 1`;

// The owner's audience's belief-type claims first known after $2 and by $3: what was learned. A
// claim made again by a re-extraction keeps its first-known time, so it is not here. Times to the
// millisecond, as an item's `at` is served, so an item's `at` given back as `since` leaves it out.
const FRESH = `
  select c.id, c.fact_key_fp, date_trunc('milliseconds', c.first_known_at) as at from knowledge.claims c
  where c.type = any ($4::text[]) and c.compartments <@ $1::text[]
    and date_trunc('milliseconds', c.first_known_at) > $2::timestamptz and c.first_known_at <= $3::timestamptz
  order by c.id`;

// The fact keys asked ($2) on whose claims a card waits, within the owner's audience ($3).
const WAITING_KEYS = `
  select distinct o.fact_key_fp from knowledge.claims o
  where o.fact_key_fp = any ($2::text[]) and o.compartments <@ $3::text[]
    and o.id in (select c.target_id ${WAITING("$1")} and c.target_kind = 'claim')
  order by 1`;

// The claims the page's beliefs rest on ($1, their stored ids), newest first, as factShow reads one.
const LATEST = `
  select c.id, c.type, c.valid_from, c.fact_key_fp, c.content_enc, c.compartments, e.source_account_id, e.source_item_fp,
    m.id as message_id, d.id as document_id, k.agent_app, ${ADMIN_FACT_SOURCE} as source
  from knowledge.claims c
  join vault.evidence_items e on e.id = c.evidence_id
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id
  where c.id = any ($1::text[])
  order by c.valid_from desc, c.id collate "C"`;
// A value of a claim's that names someone.
const isWho = (value: unknown): value is Who =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  "id" in value &&
  typeof (value as { id: unknown }).id === "string";

const instant = (text: string): string => new Date(text).toISOString();

// The time asked, never after the admin's clock.
function asked(admin: AdminContext, at: string): string {
  const time = instant(at);
  if (Date.parse(time) > admin.now().getTime()) throw new AdminError("invalid_argument");
  return time;
}

const historyPlace = (row: HistoryBelief): OwnerPlace => [row.kind, row.fact];
const isHistoryPlace = (place: OwnerPlace): boolean =>
  place.length === 2 && typeof place[0] === "string" && typeof place[1] === "string" && /^[0-9a-f]{64}$/.test(place[1]);

// Each claim's kind of source, newest first: a belief says the first of its support here.
const SOURCES = `
  select c.id, ${ADMIN_FACT_SOURCE} as source
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id
  where c.id = any ($1::text[])
  order by c.valid_from desc, c.id collate "C"`;

const historyOf = (row: OwnerBelief): HistoryBelief => ({
  fact: row.factKey,
  kind: row.belief.kind,
  type: row.belief.type,
  status: row.belief.status,
  disputed: row.belief.disputed,
  provenance: row.provenance as HistoryBelief["provenance"],
  tier: row.tier as HistoryBelief["tier"],
  values: row.belief.values,
  confirmedAt: row.belief.lastConfirmedAt,
  support: row.support.slice(0, HISTORY_SUPPORT_MOST),
  supportCount: row.support.length,
});

// Each fact key's belief about a person (their group), an organization or the owner, as the store
// knew it at `at`: its subject is a member, or it is the owner's commitment to a member. Null for
// an id that is no one's.
export async function beliefsAsOf(admin: AdminContext, args: BeliefsAsOfArgs): Promise<BeliefsAsOf | null> {
  const at = asked(admin, args.at);
  const page = ownerPage(args, isHistoryPlace);
  return admin.transaction(async (query) => {
    const tx = { query, keys: admin.keys };
    const audience = await ownerAudience(query);
    if (audience.length === 0) throw new AdminError("rebuilding");
    const [entity] = await query<{ id: string; kind: "owner" | "person" | "organization" }>(SUBJECT, [args.subject]);
    if (entity === undefined) return null;
    // Today's groups by the owner's rulings within their audience, as the warmth build makes them.
    const members =
      entity.kind === "person" ? (await audienceGroups(query, audience)).membersOf(entity.id) : [entity.id];
    const [owner] = await query<{ id: string }>(OWNER_ENTITY_FIRST);
    // A claim about the owner names them only in its sealed subject, never in claim_entities: the
    // owner's are every key of their audience, kept below by subject.
    const keys =
      entity.kind === "owner"
        ? "all"
        : (await query<{ fact_key_fp: string }>(SUBJECT_KEYS, [members, at, audience, [...BELIEF_TYPES]])).map(
            (row) => row.fact_key_fp,
          );
    const isMember = (value: unknown): boolean => typeof value === "string" && members.includes(value);
    const about = (await ownerBeliefs(tx, keys, { asOf: at })).filter(
      ({ belief }) =>
        isMember(belief.subject) ||
        (belief.kind === "commitment" && belief.subject === owner?.id && isMember(belief.values.counterparty)),
    );
    const rows = about
      .map(historyOf)
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0));
    const { rows: shown, next } = pageOf(rows, historyPlace, page);
    const supportOf = new Map(about.map((row) => [row.factKey, new Set(row.support)]));
    const sources = await query<{ id: string; source: FactSource }>(SOURCES, [
      [...new Set(shown.flatMap((row) => [...(supportOf.get(row.fact) ?? [])]))],
    ]);
    const beliefs = shown.map((row) => {
      const source = sources.find((one) => supportOf.get(row.fact)?.has(one.id) === true)?.source;
      return source === undefined ? row : { ...row, source };
    });
    const subject = entity.kind === "owner" ? null : ((await ownerWho(tx, [entity.id])).get(entity.id) ?? null);
    return { subject, at, beliefs, next };
  });
}

const learnedPlace = (item: LearnedItem): OwnerPlace => [-Date.parse(item.at), item.fact];
const isLearnedPlace = (place: OwnerPlace): boolean =>
  place.length === 2 && typeof place[0] === "number" && typeof place[1] === "string" && /^[0-9a-f]{64}$/.test(place[1]);

// The fact keys whose belief is new or says something else now than at `at`, from claims first
// known since then, newest first. One item a fact key, or a joined set's: an agent's report and
// the owner's confirmation of it build one belief. A belief none of whose supporting claims is new
// changed by a ruling of the owner's own, which is not something learned, and is left out.
export async function learnedSince(admin: AdminContext, args: LearnedSinceArgs): Promise<LearnedSince> {
  const since = asked(admin, args.at);
  const now = stamp(admin.now());
  const page = ownerPage(args, isLearnedPlace);
  return admin.transaction(async (query) => {
    const tx = { query, keys: admin.keys };
    const audience = await ownerAudience(query);
    if (audience.length === 0) throw new AdminError("rebuilding");
    const fresh = await query<{ id: string; fact_key_fp: string; at: Date }>(FRESH, [
      audience,
      since,
      now,
      [...BELIEF_TYPES],
    ]);
    // A fresh claim counts for its own key's belief, and for the belief it supports (a joined set's,
    // built under another key).
    const freshClaim = new Map(fresh.map((row) => [row.id, { key: row.fact_key_fp, at: row.at.getTime() }]));
    const freshKey = new Map<string, number>();
    for (const row of fresh)
      freshKey.set(row.fact_key_fp, Math.max(freshKey.get(row.fact_key_fp) ?? -Infinity, row.at.getTime()));
    const keys = [...freshKey.keys()];
    const beforeRows = await ownerBeliefs(tx, keys, { asOf: since });
    const before = new Map(beforeRows.map((row) => [row.factKey, said(row.belief)]));
    const beforeGroup = new Map(
      beforeRows.flatMap((row) => (row.group === null ? [] : [[row.group, said(row.belief)] as const])),
    );
    const after = await ownerBeliefs(tx, keys, { asOf: now });
    const withheld = await ownerWithheld(query);
    const [owner] = await query<{ id: string }>(OWNER_ENTITY_FIRST);
    const named = (belief: Belief): string[] => [
      belief.subject,
      ...Object.values(belief.values).filter((value): value is string => EntityId.safeParse(value).success),
    ];

    // One per fact key or joined set, the newest kept, with every key its fresh claims stand under.
    const kept = new Map<string, { row: OwnerBelief; at: number; change: LearnedItem["change"]; keys: Set<string> }>();
    for (const row of after) {
      const supported = row.support.flatMap((id) => {
        const one = freshClaim.get(id);
        return one === undefined ? [] : [one];
      });
      const at = Math.max(freshKey.get(row.factKey) ?? -Infinity, ...supported.map((one) => one.at));
      if (at === -Infinity) continue;
      const was = before.get(row.factKey) ?? (row.group === null ? undefined : beforeGroup.get(row.group));
      if (was === said(row.belief)) continue;
      if (named(row.belief).some((id) => withheld.has(id))) continue;
      const one = row.group ?? row.factKey;
      const itemKeys = new Set([row.factKey, ...supported.map((claim) => claim.key), ...(kept.get(one)?.keys ?? [])]);
      const held = kept.get(one);
      if (held === undefined || at > held.at || (at === held.at && row.factKey < held.row.factKey))
        kept.set(one, { row, at, change: was === undefined ? "new" : "changed", keys: itemKeys });
      else held.keys = itemKeys;
    }
    const waitingKeys = new Set(
      (
        await query<{ fact_key_fp: string }>(WAITING_KEYS, [
          now,
          [...new Set([...kept.values()].flatMap((one) => [...one.keys]))],
          audience,
        ])
      ).map((row) => row.fact_key_fp),
    );
    const who = await ownerWho(tx, [...new Set([...kept.values()].map(({ row }) => row.belief.subject))]);
    const items: LearnedItem[] = [...kept.values()].map(({ row, at, change, keys: itemKeys }) => ({
      fact: row.factKey,
      kind: row.belief.kind,
      type: row.belief.type,
      self: row.belief.subject === owner?.id,
      subject: who.get(row.belief.subject) ?? null,
      status: row.belief.status,
      provenance: row.provenance as LearnedItem["provenance"],
      change,
      at: new Date(at).toISOString(),
      waiting: [...itemKeys].some((key) => waitingKeys.has(key)),
      claim: null,
    }));
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0));
    const { rows, next } = pageOf(items, learnedPlace, page);
    // Each item on the page in words: its belief's latest claim, names within the owner's audience.
    const support = new Map([...kept.values()].map(({ row }) => [row.factKey, row.support]));
    const claims = await query<ClaimRow>(LATEST, [rows.flatMap((item) => support.get(item.fact) ?? [])]);
    const rendered = new Map<string, FactView>();
    for (const item of rows) {
      const ids = new Set(support.get(item.fact) ?? []);
      const newest = claims
        .filter((claim) => ids.has(claim.id) && claim.compartments.every((one) => admin.keys.compartments.has(one)))
        .sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime() || (a.id < b.id ? -1 : 1))[0];
      if (newest === undefined) continue;
      const record = claimRecordUnder(admin.keys, newest);
      rendered.set(item.fact, await renderFact(admin, query, newest, record, audience));
    }
    // Everyone they name as the owner's lists name them, in one read: a withheld person leaves the
    // claim unshown, and a person or organization is named and addressed within the owner's audience
    // only.
    const namedIn = (view: FactView): Who[] =>
      [view.subject, view.statedBy, ...Object.values(view.fields)].filter(isWho);
    const seen = await ownerWho(tx, [
      ...new Set(
        [...rendered.values()].flatMap((view) =>
          namedIn(view)
            .filter((one) => one.kind === "person" || one.kind === "organization")
            .map((one) => one.id),
        ),
      ),
    ]);
    const within = (one: Who): Who =>
      one.kind === "person" || one.kind === "organization"
        ? (seen.get(one.id) ?? { ...one, name: null, address: null })
        : one;
    const latest = new Map<string, FactView>();
    for (const [fact, view] of rendered) {
      if (namedIn(view).some((one) => withheld.has(one.id))) continue;
      latest.set(fact, {
        ...view,
        subject: within(view.subject),
        statedBy: view.statedBy === null ? null : within(view.statedBy),
        fields: Object.fromEntries(
          Object.entries(view.fields).map(([field, value]) => [field, isWho(value) ? within(value) : value]),
        ) as FactView["fields"],
      } as FactView);
    }
    return { since, items: rows.map((item) => ({ ...item, claim: latest.get(item.fact) ?? null })), next };
  });
}
