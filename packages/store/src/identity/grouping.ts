import {
  type BeliefRecord,
  CARD_OPTIONS,
  type CardId,
  ClaimRecord,
  type FactGrouping,
  GroupingMode,
  KEY_FIELDS,
  type PersonalLogger,
  SAME_FACT_CARDS_PER_DAY,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { laterClaim } from "../core/claim-order.ts";
import { byText, type Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Db } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import { authorWord } from "../core/locks.ts";
import { type NightOptions, type NightStore, nightStore } from "../core/night-store.ts";
import { EXTRACT_AUTHOR, lockRows, raiseCard } from "../core/queue.ts";
import { open, type Sealed } from "../core/seal.ts";
import { claimPassage } from "../pipeline/claim-passage.ts";
import { groupingRelation } from "../pipeline/grouping-relation.ts";

// One belief as the extract package's sweep reads it (its SameFactBelief): its label is its newest
// claim's, the claim the sweep reads.
type GroupingBelief = {
  fp: string;
  subject: string;
  type: string;
  compartments: string[];
  at: string;
  fields: Readonly<Record<string, unknown>>;
  passage: string | null;
  evidence: string;
  claim?: string;
};

// The beliefs the sweep reads under one clearance, computed by the Pipeline.
export type AudienceBeliefs = { audience: string[]; records: BeliefRecord[] };

// A row the sweep answers: the contract's row, its label, whether the owner is asked, the later of
// its two keys' times, and the two claims it read, key a's first.
export type GroupingRow = FactGrouping & {
  compartments: string[];
  card: boolean;
  at: string;
  claims?: [string, string];
};

export type GroupingStore = NightStore & {
  mode(): Promise<GroupingMode>;
  audiences(computed: readonly AudienceBeliefs[]): Promise<{ audience: string[]; beliefs: GroupingBelief[] }[]>;
  // `<audience joined by commas>|facts:<a>:<b>` of every judgment an audience holds the label of.
  asked(audiences: readonly (readonly string[])[]): Promise<Set<string>>;
  save(rows: readonly GroupingRow[]): Promise<{ saved: number; gone: number }>;
  raiseCards(): Promise<{ raised: number; capped: number; held: number }>;
};

const OWNER_SIDE = new Set(Object.keys(KEY_FIELDS));
const CARD_DAYS = 14;

// The same_fact card's request id for a pair under one label: one card a pair and label, so a pair
// is asked once for each label and no label's row links another label's card. A hash of two keyed
// fingerprints and compartment names, so it names nothing.
export const sameFactRequestId = (a: string, b: string, label: readonly string[]): string =>
  `same-fact-${sha256(`${a}:${b}:${[...label].sort(byText).join(",")}`).slice(0, 40)}`;

type ClaimRow = { id: string; evidence_id: string; compartments: string[]; content_enc: Sealed };

// What the store's functions share: the pipeline's pool, the keys and the logger.
type Grouping = Readonly<{ db: Db; keys: Keys; log: PersonalLogger }>;
type SupportClaim = { row: ClaimRow; record: ClaimRecord };

async function modeOf(db: Db): Promise<GroupingMode> {
  const [row] = await db.query<{ grouping: string }>("select grouping from policy.owner_settings");
  return GroupingMode.parse(row?.grouping ?? "shadow");
}

// The newest of a belief's supporting claims, or null when none is left.
const newestOf = (support: readonly SupportClaim[]): SupportClaim | null =>
  support.reduce<SupportClaim | null>(
    (found, one) => (found === null || laterClaim(found.record, one.record) === one.record ? one : found),
    null,
  );

// The claims the beliefs rest on, opened, by claim id.
async function supportClaims(
  { db, keys }: Grouping,
  beliefs: readonly { support: readonly string[] }[],
): Promise<Map<string, SupportClaim>> {
  const ids = [
    ...new Set(beliefs.flatMap((belief) => belief.support.map((claim) => fingerprint(keys, "claim", claim)))),
  ];
  const claims = new Map<string, SupportClaim>();
  for (const row of ids.length === 0
    ? []
    : await db.query<ClaimRow>(
        "select id, evidence_id, compartments, content_enc from knowledge.claims where id = any ($1::text[])",
        [ids],
      )) {
    const record = ClaimRecord.parse(JSON.parse(open(keys, row, "knowledge.claims.content_enc", "throw")));
    claims.set(row.id, { row, record });
  }
  return claims;
}

// The owner-side beliefs computed under each active clearance and the owner's (the Pipeline's
// sweepBeliefs), each with the newest of its supporting claims that clearance sees: no stored answer
// is read. A belief whose newest claim is gone is left out; one that does not open fails the read.
async function audiencesOf(
  grouping: Grouping,
  computed: readonly AudienceBeliefs[],
): Promise<{ audience: string[]; beliefs: GroupingBelief[] }[]> {
  const { db, keys } = grouping;
  const owned = computed.map(({ audience, records }) => ({
    audience,
    records: records.filter((record) => OWNER_SIDE.has(record.belief.type)),
  }));
  const claims = await supportClaims(
    grouping,
    owned.flatMap((one) => one.records.map((record) => record.belief)),
  );
  const passages = new Map<string, string | null>();
  const out: { audience: string[]; beliefs: GroupingBelief[] }[] = [];
  for (const { audience, records } of owned) {
    const beliefs: GroupingBelief[] = [];
    for (const { factKeyFp, belief } of records) {
      const newest = newestOf(belief.support.flatMap((claim) => claims.get(fingerprint(keys, "claim", claim)) ?? []));
      if (newest === null) continue;
      if (!passages.has(newest.row.id))
        passages.set(newest.row.id, await claimPassage(db.query, keys, newest.record, newest.row.evidence_id));
      beliefs.push({
        fp: factKeyFp,
        subject: belief.subject,
        type: belief.type,
        compartments: [...newest.row.compartments].sort(byText),
        at: newest.record.claim.validFrom,
        fields: newest.record.claim.content.fields,
        passage: passages.get(newest.row.id) ?? null,
        evidence: newest.row.evidence_id,
        claim: newest.row.id,
      });
    }
    out.push({ audience: [...audience], beliefs });
  }
  return out;
}

// Every pair a clearance has a judgment of: one whose label it holds, under each audience's name.
async function askedPairs(db: Db, audiences: readonly (readonly string[])[]): Promise<Set<string>> {
  const rows = await db.query<{ a_fp: string; b_fp: string; compartments: string[] }>(
    "select a_fp, b_fp, compartments from knowledge.same_fact_judgments",
  );
  return new Set(
    audiences.flatMap((audience) =>
      rows
        .filter((row) => row.compartments.every((one) => audience.includes(one)))
        .map((row) => `${[...audience].sort(byText).join(",")}|facts:${row.a_fp}:${row.b_fp}`),
    ),
  );
}

// Each judgment in its own statement, naming the two claims the sweep read, written only while
// both are still claims of their keys (the label trigger checks the same, and refuses otherwise);
// a pair already judged is kept as it is: a pair is asked once. A pair said to be one fact is a
// `same_fact` relation too.
async function saveRows(
  { db, keys }: Grouping,
  rows: readonly GroupingRow[],
): Promise<{ saved: number; gone: number }> {
  let saved = 0;
  let gone = 0;
  for (const row of rows) {
    const [a, b] = row.keys;
    const audience = [...row.audience].sort(byText);
    const [aClaim, bClaim] = row.claims ?? [];
    const written =
      aClaim === undefined || bClaim === undefined
        ? []
        : await db.query<{ a_fp: string }>(
            `insert into knowledge.same_fact_judgments (a_fp, b_fp, a_claim, b_claim, band, rung, state, calls, pair_at, compartments)
             select $1, $2, $3, $4, $5, $6, $7, $8::text[], $9::timestamptz, $10::text[]
             where (select count(*) from knowledge.claims where (id = $3 and fact_key_fp = $1) or (id = $4 and fact_key_fp = $2)) = 2
             on conflict (a_claim, b_claim) do nothing
             returning a_fp`,
            [
              a,
              b,
              aClaim,
              bClaim,
              row.band,
              row.rung,
              row.state,
              row.calls,
              row.at,
              [...row.compartments].sort(byText),
            ],
          );
    if (written.length === 0) {
      gone += 1;
      continue;
    }
    saved += 1;
    const { band, rung, state, calls } = row;
    await groupingRelation(db.query, keys, { audience, a_fp: a, b_fp: b, band, rung, state, calls });
  }
  return { saved, gone };
}

type WaitingRow = { a_fp: string; b_fp: string; compartments: string[] };

// One waiting row's card, under the author's lock, in the caller's transaction: linked to the pair
// and label's card when there is one, else raised, unless the label's cards for the day are spent
// (`capped`), no claim of key a is within the label, or key b's undecided card replays it (`held`).
async function cardFor(
  query: Query,
  row: WaitingRow,
  label: string[],
  log: PersonalLogger,
): Promise<"raised" | "linked" | "capped" | "held"> {
  await lockRows(query, [authorWord(EXTRACT_AUTHOR)]);
  const requestId = sameFactRequestId(row.a_fp, row.b_fp, label);
  const [existing] = await query<{ id: CardId }>(
    "select id from ledger.cards where created_by = $1 and request_id = $2",
    [EXTRACT_AUTHOR, requestId],
  );
  let card = existing?.id;
  if (card === undefined) {
    const [today] = await query<{ n: number }>(
      "select count(*)::int as n from ledger.cards where kind = 'same_fact' and created_by = $1 and compartments = $2::text[] and created_at > now() - interval '1 day'",
      [EXTRACT_AUTHOR, label],
    );
    if ((today?.n ?? 0) >= SAME_FACT_CARDS_PER_DAY) return "capped";
    const [claim] = await query<{ id: string }>(
      'select id from knowledge.claims where fact_key_fp = $1 and compartments <@ $2::text[] order by valid_from desc, id collate "C" desc limit 1',
      [row.a_fp, label],
    );
    if (claim === undefined) return "held";
    const [clock] = await query<{ now: Date }>("select now() as now");
    const got = await raiseCard(
      query,
      {
        id: newId("crd") as CardId,
        requestId,
        kind: "same_fact",
        author: EXTRACT_AUTHOR,
        options: [...CARD_OPTIONS.same_fact],
        target: { kind: "claim", id: claim.id },
        refs: [],
        compartments: label,
        expiresAt: null,
        expiresAfterDays: CARD_DAYS,
        caseKey: row.b_fp,
        run: null,
        body: null,
        bodyFrom: null,
      },
      { now: clock?.now ?? new Date(), log },
    );
    // Replayed by its case key: another pair's undecided card on key b. Link nothing.
    if (got.replayed) return "held";
    card = got.id;
  }
  await query(
    "update knowledge.same_fact_judgments set card_id = $1, updated_at = now() where a_fp = $2 and b_fp = $3 and compartments = $4::text[] and card_id is null",
    [card, row.a_fp, row.b_fp, label],
  );
  return existing === undefined ? "raised" : "linked";
}

// The rows waiting for a card, newest first, one card a pair and label, at most
// SAME_FACT_CARDS_PER_DAY in a day for each label. Each card in its own
// transaction, under the author's lock, so two sweeps at once count the same cards. A judgment whose
// pair and label already have a card links it. The card is the fact-group shape
// (card-kinds-facts.ts): its target the newest claim of key a within the label, its case key key b's
// fingerprint, so the answer from the owner joins or splits the pair, and it shows both phrases. A pair the
// owner has ruled on needs no card; a row whose key b already has an undecided card (its case) waits
// for that card, and is counted as waiting.
async function raiseWaitingCards({ db, log }: Grouping): Promise<{ raised: number; capped: number; held: number }> {
  const waiting = await db.query<WaitingRow>(
    `select g.a_fp, g.b_fp, g.compartments from knowledge.same_fact_judgments g
         where g.state = 'proposed' and g.card_id is null
           and not exists (select 1 from policy.fact_rulings() r where r.a_fp = g.a_fp and r.b_fp = g.b_fp)
         order by g.pair_at desc, g.a_fp, g.b_fp`,
  );
  const counts = { raised: 0, capped: 0, held: 0 };
  for (const row of waiting) {
    const label = [...row.compartments].sort(byText);
    const made = await db.transaction((query) => cardFor(query, row, label, log));
    if (made !== "linked") counts[made] += 1;
  }
  if (counts.raised > 0 || counts.capped > 0 || counts.held > 0) log.info({ event: "same_fact_cards", counts });
  return counts;
}

export function createGroupingStore(options: NightOptions): GroupingStore {
  const { db, shared } = nightStore(options);
  const grouping: Grouping = { db, keys: options.keys, log: options.log };
  return {
    ...shared,
    mode: () => modeOf(grouping.db),
    audiences: (computed) => audiencesOf(grouping, computed),
    asked: (audiences) => askedPairs(grouping.db, audiences),
    save: (rows) => saveRows(grouping, rows),
    raiseCards: () => raiseWaitingCards(grouping),
  };
}
