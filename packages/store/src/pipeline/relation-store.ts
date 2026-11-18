import type { CardId, RelationJob, RelationSide } from "@intelligence/contracts/personal";
import {
  BELIEF_TYPES,
  CARD_OPTIONS,
  type ClaimRecord,
  type ClaimRelationKind,
  type KeyedCallStore,
  keyPhraseOf,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import { beliefsFor, compareEvidence, type KeyedClaim, mayPrevail } from "@intelligence/personal-beliefs";
import { relationRules } from "@intelligence/personal-core/views";
import type { Query } from "../core/db.ts";
import { byText } from "../core/db.ts";
import { trackedCalls } from "../core/decision-calls.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { createDb } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import { authorWord } from "../core/locks.ts";
import { EXTRACT_AUTHOR, lockRows, raiseCard } from "../core/queue.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import { claimRecordOrNull, openedUnder } from "../core/tx.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";
import { claimPassage } from "./claim-passage.ts";
import {
  claimsOnKeys,
  ensureValueRows,
  insertRelation,
  itemFacts,
  keyedClaim,
  labelOf,
  restricted,
} from "./code-relations.ts";
import { ASKED_OUTCOME_CHECKS } from "./outcome-store.ts";
import { type Held, ownerSupport, UNLINKED } from "./owner-support.ts";
import { ownerAudienceOf } from "./pipeline-read.ts";
import { runSwitchPass, type SwitchPassSummary } from "./relation-switch.ts";

export { relationCheckScore } from "./relation-switch.ts";
export type { SwitchPassSummary };

// The relation step's store, run as pi_pipeline after each extraction run (`pi extract`), before
// the after-commit diff consumes its rechecks. It finds the claims to judge (those its rechecks
// name, committed in a run or outside one, and those an earlier run left unjudged), each claim's
// candidates (the claims supporting its subject's current beliefs and open commitments, computed
// with beliefsFor under the owner's clearance), and whether a model may settle each pair with
// `prevails`; it holds the keyed replay of the step's calls; it writes the relations, the checks
// and the marks the extract package's step answers; and it runs the system's switching job.
// Shapes are the contracts': this package does not import the extract package. Ids, keys,
// counts and codes in its log lines only.

type ClaimRow = Parameters<typeof keyedClaim>[1];

type RelationSideRow = RelationSide;
type RelationJobRow = RelationJob;
type RelationRunRow = {
  relations: { from: string; to: string; kind: ClaimRelationKind; compartments: string[] }[];
  checks: {
    claimKey: string;
    claimId: string;
    otherKey: string;
    firstAnswer: string | null;
    secondAnswer: string | null;
    agreed: boolean | null;
    written: ClaimRelationKind | null;
    code: string | null;
    compartments: string[];
  }[];
  marks: { claimKey: string; claimId: string; state: "judged" | "unjudged"; compartments: string[] }[];
};
// What the audit did, for one judge: the relations of its switched-on
// kinds in the share, the cards raised, those held (a card already open on the case, or no claim
// to target), those the day's cap left, and those refused because the card grant is not given.
export type AuditSummary = {
  kinds: number;
  picked: number;
  raised: number;
  held: number;
  capped: number;
};
// The audit's rules: ontology/relations.json `dream.auditShare` and `dream.auditsPerDay`, and the
// pure choice (extract's `pickAudits`), handed in, since this package cannot import extract.
type AuditRules = {
  share: number;
  perDay: number;
  pick(
    relations: readonly { id: string; selector: number; audited: boolean }[],
    rules: { share: number; perDay: number; raisedToday: number },
  ): string[];
};

// Where a paged sweep left off: the last claim it read, in the sweep's order.
export type SweepCursor = { at: string; id: string };

export type RelationStore = {
  // The claims to judge under `judge` and their candidates, and the pairs already asked.
  // `budget`: the run's calls, the day's calls and the candidates a claim. Candidates are built only
  // for the claims the run's calls can reach; the rest come back as `deferred`, to be marked
  // unjudged without the cost of finding their candidates.
  jobs(
    judge: string,
    now: string,
    budget: { calls: number; callsPerDay: number; candidates: number },
  ): Promise<{ jobs: RelationJobRow[]; checked: Set<string>; deferred: RelationRunRow["marks"]; calls: number }>;
  // The dream pass's relations sweep. Belief-type claims no relation run has
  // judged under `judge`, oldest first (at most `limit`), one subject at a time (`order`, extract's
  // `sweepOrder`), with the existing candidate rule, built only while the pass's calls reach.
  sweep(
    judge: string,
    now: string,
    // `after`: read only past this claim in the sweep's order, so a caller paging a subject moves past
    // claims it cannot mark (restricted, or that fail to open).
    budget: { calls: number; candidates: number; limit: number; subjects?: readonly string[]; after?: SweepCursor },
    order: <T extends { key: string; subject: string; at: string }>(claims: readonly T[]) => T[],
  ): Promise<{ jobs: RelationJobRow[]; checked: Set<string>; claims: number; last: SweepCursor | null }>;
  // The sweep's backlog (imp_01M6ST6JZ4PW9BWNWVN61DHHMR): how many claims `sweep` would still read
  // under `judge`, with no limit, so the night's row says whether the sweep keeps up.
  // The claims the sweep has still to read, and of them those no weekly subject reaches: linked to no
  // entity, or only to entities of another kind (a project).
  sweepBacklog(judge: string): Promise<{ total: number; unlinked: number; otherKinds: number }>;
  // The fulfilled-commitments sweep. Each open commitment (a commitment belief
  // under the owner's clearance that is not closed or expired), by its newest supporting claim,
  // against the belief-type claims of later items with its counterparty (mail or a meeting in the
  // interaction log after it was said) or naming the counterparty and said after it: the newest of
  // them not yet asked against it under `judge`, so a commitment's older pairs, once asked, never
  // keep its newer evidence from being offered.
  fulfilJobs(
    judge: string,
    now: string,
    budget: { calls: number; candidates: number },
  ): Promise<{ jobs: RelationJobRow[]; checked: Set<string>; commitments: number }>;
  calls(): { store: KeyedCallStore; lastId(): Promise<string | null> };
  // `dream`: the rows are the dream pass's, marked so new arrivals' day cap leaves them out.
  save(
    run: RelationRunRow,
    judge: string,
    options?: { dream?: boolean },
  ): Promise<{ relations: number; checks: number; marks: number }>;
  switchPass(judge: string): Promise<SwitchPassSummary>;
  // The owner's clearance: every compartment a belief-type claim this role sees holds.
  ownerClearance(): Promise<string[]>;
  // The owner's audit cards for the relations of `judge`'s switched-on kinds.
  audit(judge: string, rules: AuditRules): Promise<AuditSummary>;
  close(): Promise<void>;
};

// The fact keys a read of the belief inputs asks at once (the definer takes 1 000, joined keys
// among them).
const KEYS_A_READ = 200;
// The claims the relations sweep reads ($1 the belief types, $2 the owner's clearance, $3 the
// judge): belief-type claims whose latest mark under the judge is not `judged`, within the owner's
// clearance (every compartment a belief-type claim holds that this role sees).
const SWEPT = `c.type = any ($1::text[]) and not c.released and not c.closes and c.compartments <@ $2::text[]
  and coalesce((select m.state from ledger.relation_checks m where m.claim_id = c.id and m.judge = $3 and m.other_key is null order by m.id desc limit 1), '') <> 'judged'`;

// The later claims the fulfilled-commitments sweep reads at once, newest first, while it looks for
// a commitment's pairs not yet asked.
const LATER_A_READ = 200;
type LaterRow = { id: string; evidence_id: string; fact_key_fp: string; at: string };
const STATING: ReadonlySet<string> = new Set(["stated_fact", "decision"]);
const SHOWN_STATUS: ReadonlySet<string> = new Set(["closed", "expired"]);
// A claim's key words, from typed fields code read: its key phrase, or its typed text fields. The
// source check shows a statement by the same words.
export const phraseOf = (record: ClaimRecord): string => {
  const { type, fields } = record.claim.content;
  const phrase = keyPhraseOf(type, fields);
  if (phrase !== undefined) return phrase;
  return Object.entries(fields)
    .filter(([, value]) => typeof value === "string" && !/^ent_[0-9A-Z]{26}$/.test(value))
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("; ");
};

export function createRelationStore({
  url,
  keys,
  log,
}: {
  url: string;
  keys: Keys;
  log: PersonalLogger;
}): RelationStore {
  const db = createDb(url, log);
  // The claims the last `jobs` read, by claim key, for `save`'s value rows.
  let held = new Map<string, Held>();

  // A claim that fails to open is not judged (as code-relations.ts' claimsOnKeys).
  const open = (row: ClaimRow): ClaimRecord | null => claimRecordOrNull(keys, row);
  // Claims of a type that builds a belief: the only ones the step judges, and the only candidates.
  const claimsById = async (ids: readonly string[]): Promise<Held[]> => {
    if (ids.length === 0) return [];
    const rows = await db.query<ClaimRow>(
      `select id, evidence_id, fact_key_fp, legacy_fact_key_fp, legacy_alt_fact_key_fp, compartments, content_enc
       from knowledge.claims where id = any ($1::text[]) and type = any ($2::text[]) and not released and not closes order by id collate "C"`,
      [[...new Set(ids)], [...BELIEF_TYPES]],
    );
    return rows.flatMap((row) => {
      const record = open(row);
      return record === null ? [] : [{ row, record }];
    });
  };
  const keyOf = (one: Held): string => claimKey(keys, one.row.evidence_id, one.row.fact_key_fp);
  const ownSupport = ownerSupport({ query: db.query, keys, claimsById });

  // Each claim's side, its passage read once a sweep: a subject's candidates are the same few hundred
  // claims job after job.
  const sideCache = new Map<string, RelationSideRow>();
  async function sideOf(one: Held): Promise<RelationSideRow> {
    const known = sideCache.get(one.row.id);
    if (known !== undefined) return known;
    const side = await readSide(one);
    sideCache.set(one.row.id, side);
    return side;
  }
  async function readSide(one: Held): Promise<RelationSideRow> {
    return {
      key: keyOf(one),
      id: one.row.id,
      type: one.record.claim.content.type,
      phrase: phraseOf(one.record),
      passage: await claimPassage(db.query, keys, one.record, one.row.evidence_id),
      evidenceId: one.row.evidence_id,
      at: one.record.claim.validFrom,
      compartments: [...one.row.compartments].sort(byText),
    };
  }

  // The evidence rule for a pair: a model may settle it with `prevails` only when both claims state
  // different values of one fact key, the kind admits it, the two sides are of one tier and every
  // evidence comparison is equal.
  const sidesCache = new Map<string, KeyedClaim[]>();
  async function onKey(factKeyFp: string): Promise<KeyedClaim[]> {
    const cached = sidesCache.get(factKeyFp);
    if (cached !== undefined) return cached;
    const claims = await claimsOnKeys(db.query, keys, [factKeyFp]);
    const items = await itemFacts(
      db.query,
      claims.map((one) => one.row.evidence_id),
    );
    const [owner] = await db.query<{ id: string }>(OWNER_ENTITY);
    const keyed = claims.map((one) => keyedClaim(keys, one.row, one.record, items.get(one.row.evidence_id), owner?.id));
    sidesCache.set(factKeyFp, keyed);
    return keyed;
  }
  async function mayPrevailFor(a: Held, b: Held): Promise<boolean> {
    if (
      a.row.fact_key_fp !== b.row.fact_key_fp ||
      !STATING.has(a.record.claim.statementKind) ||
      !STATING.has(b.record.claim.statementKind)
    )
      return false;
    if (!mayPrevail(a.record.subjectKind, a.record.claim) || !mayPrevail(b.record.subjectKind, b.record.claim))
      return false;
    const keyed = (await onKey(a.row.fact_key_fp)).filter((one) => STATING.has(one.claim.statementKind));
    const [x, y] = [keyed.find((one) => one.id === a.row.id), keyed.find((one) => one.id === b.row.id)];
    if (x === undefined || y === undefined || x.valueFp === y.valueFp || x.tier !== y.tier) return false;
    const sideA = keyed.filter((one) => one.valueFp === x.valueFp);
    const sideB = keyed.filter((one) => one.valueFp === y.valueFp);
    return (
      compareEvidence(
        sideA.map((one) => one.evidence),
        sideB.map((one) => one.evidence),
        relationRules(),
      ).by === "equal"
    );
  }

  // The claims supporting a subject's current beliefs and open commitments, under the owner's
  // clearance, as of now, by claim row id; once a subject a pass.
  const supportOf = new Map<string, string[]>();
  async function supportFor(subject: string, owner: readonly string[], now: string): Promise<string[]> {
    const known = supportOf.get(subject);
    if (known !== undefined) return known;
    const keyRows = await db.query<{ fact_key_fp: string }>(
      `select distinct c.fact_key_fp from knowledge.claim_entities e join knowledge.claims c on c.id = e.claim_id
       where e.entity_id = $1 order by 1 limit 1000`,
      [subject],
    );
    const factKeys = keyRows.map((row) => row.fact_key_fp);
    const inputs = factKeys.length === 0 ? null : await readBeliefInputsUnder(db.query, keys, owner, factKeys, now);
    const rows = inputs === null ? [] : beliefsFor(inputs, owner, now, factKeys).rows;
    // A belief cites its claims by the claim's own id; the row's id is its keyed fingerprint.
    const support = [
      ...new Set(
        rows
          .filter((one) => !SHOWN_STATUS.has(one.belief.status))
          .flatMap((one) => one.belief.support.map((id) => fingerprint(keys, "claim", id))),
      ),
    ].sort(byText);
    supportOf.set(subject, support);
    return support;
  }

  // The claims `claim` is weighed against: its subject's current beliefs' claims of other items. For the
  // owner's own claims, only those of its group, the newest `cap`, and none when the claim is in no
  // current belief (it has nothing to settle).
  async function othersFor(
    claim: Held,
    subject: string,
    owner: readonly string[],
    now: string,
    cap: number,
  ): Promise<Held[]> {
    const other = (one: Held): boolean => one.row.id !== claim.row.id && one.row.evidence_id !== claim.row.evidence_id;
    // The owner's candidates are capped: the linked ones are left out before the cap, so a claim
    // restated many times is still weighed against an older one that differs.
    if (subject === (await ownSupport.ownerId()))
      return ownSupport.candidates(claim, owner, now, cap, await linkedTo(claim));
    const support = await supportFor(subject, owner, now);
    const others = (await claimsById(support.filter((id) => id !== claim.row.id))).filter(other);
    if (!others.some((one) => one.row.fact_key_fp === claim.row.fact_key_fp)) return others;
    const linked = await linkedTo(claim);
    return others.filter((one) => !linked.has(one.row.id));
  }
  // The claims stating the claim's own value on its own fact key: one belief with it already, by the
  // value they share, so a model's answer on such a pair could change nothing a read gives.
  async function linkedTo(claim: Held): Promise<ReadonlySet<string>> {
    const stating = (await onKey(claim.row.fact_key_fp)).filter((one) => STATING.has(one.claim.statementKind));
    const mine = stating.find((one) => one.id === claim.row.id)?.valueFp;
    return new Set(mine === undefined ? [] : stating.filter((one) => one.valueFp === mine).map((one) => one.id));
  }

  // One claim's job: its candidates, built from `others`, each shown with its passage. The pairs
  // it may ask are those not yet asked under the judge.
  async function jobOf(
    claim: Held,
    others: readonly Held[],
    checked: ReadonlySet<string>,
    unjudged: boolean,
    prevail: boolean,
  ): Promise<{ job: RelationJobRow; pairs: number }> {
    const claimKey = keyOf(claim);
    held.set(claimKey, claim);
    const candidates: RelationJobRow["candidates"] = [];
    for (const other of others) {
      held.set(keyOf(other), other);
      candidates.push({ other: await sideOf(other), mayPrevail: prevail ? await mayPrevailFor(claim, other) : false });
    }
    return {
      job: { claim: await sideOf(claim), candidates, unjudged },
      pairs: candidates.filter(({ other }) => !checked.has(`${claimKey}\n${other.key}`)).length,
    };
  }

  // The pairs asked under the judge, each in both orders: a pair is asked both ways at once, so one
  // asked from either side is not asked again from the other.
  const askedOf = async (judge: string, claimKeys: readonly string[]): Promise<Set<string>> =>
    new Set(
      (
        await db.query<{ claim_key: string; other_key: string; code: string | null }>(
          "select claim_key, other_key, code from ledger.relation_checks where other_key is not null and judge = $1 and (claim_key = any ($2::text[]) or other_key = any ($2::text[]))",
          [judge, claimKeys],
        )
      ).flatMap((row) =>
        // A pair asked for one kind alone (the fulfilled-commitments sweep's `not_offered`) is still the
        // full question's from the other side.
        row.code === "not_offered"
          ? [`${row.claim_key}\n${row.other_key}`]
          : [`${row.claim_key}\n${row.other_key}`, `${row.other_key}\n${row.claim_key}`],
      ),
    );

  return {
    async jobs(judge, now, budget) {
      sidesCache.clear();
      sideCache.clear();
      supportOf.clear();
      // The day's calls so far under this judge, two a pair asked (a replayed pair counts too).
      // The outcome judge's checks under the same model count too: the two share the day's cap.
      // The dream pass's checks are left out; it spends from its own budget.
      const [today] = await db.query<{ pairs: number }>(
        `select ((select count(*) from ledger.relation_checks where judge = $1 and other_key is not null and not dream and created_at >= date_trunc('day', $2::timestamptz))
           + (select count(*) from ledger.outcome_checks where split_part(judge, '@', 1) = split_part($1, '@', 1) and ${ASKED_OUTCOME_CHECKS} and created_at >= date_trunc('day', $2::timestamptz)))::int as pairs`,
        [judge, now],
      );
      const calls = Math.max(0, Math.min(budget.calls, budget.callsPerDay - 2 * (today?.pairs ?? 0)));
      let pairsLeft = Math.floor(calls / 2);
      const named = await db.query<{ id: string }>(
        `select distinct x.id from (
           select unnest(r.added_claims) as id from ledger.trigger_rechecks r where r.cause in ('claim', 'backfill')
           union select c.claim_id from ledger.relation_checks c where c.other_key is null and c.state = 'unjudged' and c.judge = $1) x
         order by 1`,
        [judge],
      );
      const claims = await claimsById(named.map((row) => row.id));
      const keysOfClaims = claims.map(keyOf);
      const marks = new Map(
        // A claim's mark is its latest row: marks are appended, never updated.
        (
          await db.query<{ claim_key: string; state: string }>(
            "select distinct on (claim_key) claim_key, state from ledger.relation_checks where other_key is null and judge = $1 and claim_key = any ($2::text[]) order by claim_key, id desc",
            [judge, keysOfClaims],
          )
        ).map((row) => [row.claim_key, row.state]),
      );
      const checked = await askedOf(judge, keysOfClaims);
      const owner = await ownerAudienceOf(db.query);
      held = new Map();
      const jobs: RelationJobRow[] = [];
      const deferred: RelationRunRow["marks"] = [];
      const ordered = claims
        .map((claim) => ({ claim, claimKey: keyOf(claim) }))
        .sort(
          (a, b) =>
            Number(marks.get(b.claimKey) === "unjudged") - Number(marks.get(a.claimKey) === "unjudged") ||
            byText(a.claimKey, b.claimKey),
        );
      for (const { claim, claimKey } of ordered) {
        if (marks.get(claimKey) === "judged") continue;
        if (!claim.row.compartments.every((one) => owner.includes(one))) continue;
        if (pairsLeft <= 0) {
          deferred.push({
            claimKey,
            claimId: claim.row.id,
            state: "unjudged",
            compartments: [...claim.row.compartments].sort(byText),
          });
          continue;
        }
        const subject = claim.record.claim.content.subject;
        if (typeof subject !== "string") {
          held.set(claimKey, claim);
          continue;
        }
        const others = await othersFor(claim, subject, owner, now, budget.candidates);
        const { job, pairs } = await jobOf(claim, others, checked, marks.get(claimKey) === "unjudged", true);
        jobs.push(job);
        pairsLeft -= Math.min(budget.candidates, pairs);
      }
      return { jobs, checked, deferred, calls };
    },

    async sweep(judge, now, budget, order) {
      // A subject's next batch reads what its first one read: its beliefs' claims and their sides.
      if (budget.after === undefined) {
        sidesCache.clear();
        sideCache.clear();
        supportOf.clear();
      }
      held = new Map();
      const owner = await ownerAudienceOf(db.query);
      // The oldest claims the sweep reads (`SWEPT`).
      // The night's subjects, when given, a chunk at a time.
      const me = await ownSupport.ownerId();
      const named = await db.query<{ id: string; at: string }>(
        `select c.id, to_char(c.valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from knowledge.claims c where ${SWEPT}
           and ($5::text[] is null or exists (select 1 from knowledge.claim_entities e where e.claim_id = c.id and e.entity_id = any ($5::text[]))
                or ($6::text = any ($5::text[]) and ${UNLINKED}))
           and ($7::timestamptz is null or (c.valid_from, c.id collate "C") > ($7::timestamptz, $8::text collate "C"))
         order by c.valid_from, c.id collate "C" limit $4`,
        [
          [...BELIEF_TYPES],
          owner,
          judge,
          budget.limit,
          budget.subjects === undefined ? null : [...budget.subjects],
          me,
          budget.after?.at ?? null,
          budget.after?.id ?? null,
        ],
      );
      const claims = await claimsById(named.map((row) => row.id));
      const checked = await askedOf(judge, claims.map(keyOf));
      const ordered = order(
        claims.flatMap((claim) => {
          const subject = claim.record.claim.content.subject;
          return typeof subject === "string"
            ? [{ key: keyOf(claim), subject, at: claim.record.claim.validFrom, claim }]
            : [];
        }),
      );
      let pairsLeft = Math.floor(budget.calls / 2);
      const jobs: RelationJobRow[] = [];
      for (const { claim, subject } of ordered) {
        if (pairsLeft <= 0) break;
        const others = await othersFor(claim, subject, owner, now, budget.candidates);
        const { job, pairs } = await jobOf(claim, others, checked, false, true);
        jobs.push(job);
        pairsLeft -= Math.min(budget.candidates, pairs);
      }
      const end = named.at(-1);
      return { jobs, checked, claims: named.length, last: end === undefined ? null : { at: end.at, id: end.id } };
    },

    async sweepBacklog(judge) {
      const [row] = await db.query<{ total: number; unlinked: number; other_kinds: number }>(
        `select count(*)::integer as total,
           count(*) filter (where not exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id))::integer as unlinked,
           count(*) filter (where exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id)
             and not exists (select 1 from knowledge.claim_entities x join knowledge.entities e on e.id = x.entity_id
                             where x.claim_id = c.id and e.kind in ('owner', 'person', 'organization')))::integer as other_kinds
         from knowledge.claims c where ${SWEPT}`,
        [[...BELIEF_TYPES], await ownerAudienceOf(db.query), judge],
      );
      return { total: row?.total ?? 0, unlinked: row?.unlinked ?? 0, otherKinds: row?.other_kinds ?? 0 };
    },

    async fulfilJobs(judge, now, budget) {
      sidesCache.clear();
      sideCache.clear();
      held = new Map();
      const owner = await ownerAudienceOf(db.query);
      // The open commitments under the owner's clearance, computed at read (beliefsFor over the
      // fact keys of every commitment claim within it), each by its newest supporting claim.
      const factKeys = (
        await db.query<{ fact_key_fp: string }>(
          "select distinct fact_key_fp from knowledge.claims where type = 'commitment' and compartments <@ $1::text[] and not released order by 1",
          [owner],
        )
      ).map((row) => row.fact_key_fp);
      const commitments: Held[] = [];
      for (let at = 0; at < factKeys.length; at += KEYS_A_READ) {
        const page = factKeys.slice(at, at + KEYS_A_READ);
        const inputs = await readBeliefInputsUnder(db.query, keys, owner, page, now);
        for (const { belief } of beliefsFor(inputs, owner, now, page).rows) {
          if (belief.kind !== "commitment" || SHOWN_STATUS.has(belief.status)) continue;
          const support = await claimsById(belief.support.map((id) => fingerprint(keys, "claim", id)));
          const newest = support.sort(
            (a, b) =>
              Date.parse(b.record.claim.validFrom) - Date.parse(a.record.claim.validFrom) || byText(a.row.id, b.row.id),
          )[0];
          if (
            newest !== undefined &&
            newest.record.claim.content.type === "commitment" &&
            !commitments.some((one) => one.row.id === newest.row.id)
          )
            commitments.push(newest);
        }
      }
      const checked = await askedOf(judge, commitments.map(keyOf));
      let pairsLeft = Math.floor(budget.calls / 2);
      const jobs: RelationJobRow[] = [];
      for (const commitment of commitments) {
        if (pairsLeft <= 0) break;
        const counterparty = commitment.record.claim.content.fields.counterparty;
        if (typeof counterparty !== "string") continue;
        const said = commitment.record.claim.validFrom;
        // The newest later claims not yet asked against this commitment under the judge, so a night
        // moves on to newer evidence once the older pairs are asked. A pair's key is keyed, so the
        // asked pairs are left out here, a page of rows at a time, newest first.
        const commitmentKey = keyOf(commitment);
        const others: Held[] = [];
        let before: { at: string; id: string } | null = null;
        while (others.length < budget.candidates) {
          const page: LaterRow[] = await db.query<LaterRow>(
            `select c.id, c.evidence_id, c.fact_key_fp, to_char(c.valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as at
             from knowledge.claims c
             where c.type = any ($1::text[]) and not c.released and not c.closes and c.compartments <@ $2::text[] and c.evidence_id <> $3 and c.valid_from > $5::timestamptz
               and (c.evidence_id in (select l.evidence_id from knowledge.interaction_log l where l.entity_id = $4 and l.occurred_at > $5::timestamptz and l.compartments <@ $2::text[])
                 or exists (select 1 from knowledge.claim_entities e where e.claim_id = c.id and e.entity_id = $4))
               and ($6::text is null or (c.valid_from, c.id collate "C") < ($6::timestamp at time zone 'UTC', $7::text collate "C"))
             order by c.valid_from desc, c.id collate "C" desc limit $8`,
            [
              [...BELIEF_TYPES],
              owner,
              commitment.row.evidence_id,
              counterparty,
              said,
              before?.at ?? null,
              before?.id ?? null,
              LATER_A_READ,
            ],
          );
          const last = page.at(-1);
          if (last === undefined) break;
          before = { at: last.at, id: last.id };
          const unasked = page.filter(
            (row) => !checked.has(`${commitmentKey}\n${claimKey(keys, row.evidence_id, row.fact_key_fp)}`),
          );
          const read = new Map((await claimsById(unasked.map((row) => row.id))).map((one) => [one.row.id, one]));
          for (const row of unasked) {
            const one = read.get(row.id);
            if (one !== undefined && others.length < budget.candidates) others.push(one);
          }
          if (page.length < LATER_A_READ) break;
        }
        if (others.length === 0) continue;
        const { job, pairs } = await jobOf(commitment, others, checked, false, false);
        if (pairs === 0) continue;
        jobs.push(job);
        pairsLeft -= Math.min(budget.candidates, pairs);
      }
      return { jobs, checked, commitments: commitments.length };
    },

    calls: () => trackedCalls(db.query, keys),

    // One transaction: each relation (both claims' value rows first), each check, each mark. A
    // check already there is kept; a mark is appended only when it changes the claim's state, since
    // ledger rows are never updated, so a claim holds two mark rows at most.
    async save(run, judge, options = {}) {
      const dream = options.dream === true;
      return db.transaction(async (query) => {
        let relations = 0;
        let checks = 0;
        let marks = 0;
        const version = Number(/@(\d+)$/.exec(judge)?.[1] ?? "1");
        for (const relation of run.relations) {
          const [from, to] = [held.get(relation.from), held.get(relation.to)];
          if (from === undefined || to === undefined || restricted(relation.compartments)) continue;
          await ensureValueRows(query, keys, [from, to]);
          if (
            await insertRelation(query, {
              ...relation,
              judge,
              version,
              compartments: labelOf(from.row.compartments, to.row.compartments),
            })
          )
            relations += 1;
        }
        for (const check of run.checks) {
          if (restricted(check.compartments)) continue;
          const rows = await query<{ id: string }>(
            `insert into ledger.relation_checks (claim_key, claim_id, other_key, judge, state, first_answer, second_answer, agreed, written, code, compartments, judged_at, dream)
             values ($1, $2, $3, $4, 'judged', $5, $6, $7, $8, $9, $10::text[], now(), $11)
             on conflict (claim_key, other_key, judge) where other_key is not null do nothing returning id::text`,
            [
              check.claimKey,
              check.claimId,
              check.otherKey,
              judge,
              check.firstAnswer,
              check.secondAnswer,
              check.agreed,
              check.written,
              check.code,
              [...check.compartments].sort(byText),
              dream,
            ],
          );
          checks += rows.length;
        }
        for (const mark of run.marks) {
          if (restricted(mark.compartments)) continue;
          const rows = await query<{ id: string }>(
            `insert into ledger.relation_checks (claim_key, claim_id, judge, state, compartments, judged_at, dream)
             select $1, $2, $3, $4, $5::text[], case when $4 = 'judged' then now() end, $6
             where coalesce((select c.state from ledger.relation_checks c where c.claim_key = $1 and c.judge = $3 and c.other_key is null order by c.id desc limit 1), '') <> $4
             returning id::text`,
            [mark.claimKey, mark.claimId, judge, mark.state, [...mark.compartments].sort(byText), dream],
          );
          marks += rows.length;
        }
        return { relations, checks, marks };
      });
    },

    // The system's switching job (relation-switch.ts).
    switchPass: (judge) => runSwitchPass(db.query, judge, log),

    ownerClearance: () => ownerAudienceOf(db.query),

    // For each kind of this judge that applies, whoever switched it on (the owner's latest
    // row when they have one, else the system's: personal-beliefs' `appliedAt`), its model relations
    // not yet audited, whenever they were written (an owner's `on` over a backlog of shadow
    // relations audits the backlog too), not restricted, oldest first; each in the share by a
    // selector from its keyed fingerprint, so the same relations are picked every night; at most
    // the day's cap of cards over the last 24 hours. A card targets the relation's `from` claim
    // and names the relation by its case key. Each in its own transaction under the author's lock.
    async audit(judge, rules) {
      const summary: AuditSummary = { kinds: 0, picked: 0, raised: 0, held: 0, capped: 0 };
      const latest = await db.query<{ kind: string; switched_on: boolean }>(
        "select distinct on (kind) kind, switched_on from policy.relation_switches where judge = $1 order by kind, (decided_by = 'owner') desc, decided_at desc, id desc",
        [judge],
      );
      const on = latest.filter((row) => row.switched_on);
      if (on.length === 0) return summary;
      summary.kinds = on.length;
      const [today] = await db.query<{ n: number }>(
        "select count(*)::int as n from ledger.cards where kind = 'relation_audit' and created_by = $1 and created_at > now() - interval '1 day'",
        [EXTRACT_AUTHOR],
      );
      const candidates: { id: string; selector: number; audited: boolean; from: string; compartments: string[] }[] = [];
      for (const row of on) {
        const relations = await db.query<{
          id: string;
          from_claim_key: string;
          compartments: string[];
          audited: boolean;
        }>(
          `select r.id::text as id, r.from_claim_key, r.compartments,
             exists (select 1 from ledger.cards c where c.created_by = $3 and c.request_id = 'relation-audit-' || r.id::text) as audited
           from knowledge.claim_relations r where r.kind = $1 and r.judged_by = $2
             and policy.relation_effective(r.id, r.judged_by, r.kind, r.judged_at, now()) order by r.judged_at, r.id`,
          [row.kind, judge, EXTRACT_AUTHOR],
        );
        for (const one of relations) {
          if (restricted(one.compartments)) continue;
          const selector =
            Number.parseInt(fingerprint(keys, "check_target", `audit\n${one.id}`).slice(0, 8), 16) / 2 ** 32;
          candidates.push({
            id: one.id,
            selector,
            audited: one.audited,
            from: one.from_claim_key,
            compartments: [...one.compartments].sort(byText),
          });
        }
      }
      const inShare = candidates.filter((one) => !one.audited && one.selector < rules.share);
      const picked = new Set(
        rules.pick(candidates, { share: rules.share, perDay: rules.perDay, raisedToday: today?.n ?? 0 }),
      );
      summary.picked = inShare.length;
      summary.capped = inShare.length - picked.size;
      if (picked.size === 0) return summary;
      const claimOf = await claimIdsByKey();
      for (const one of candidates.filter((candidate) => picked.has(candidate.id))) {
        const claimId = claimOf.get(one.from);
        if (claimId === undefined) {
          summary.held += 1;
          continue;
        }
        const got = await db.transaction(async (query) => {
          await lockRows(query, [authorWord(EXTRACT_AUTHOR)]);
          const [clock] = await query<{ now: Date }>("select now() as now");
          return raiseCard(
            query,
            {
              id: newId("crd") as CardId,
              requestId: `relation-audit-${one.id}`,
              kind: "relation_audit",
              author: EXTRACT_AUTHOR,
              options: [...CARD_OPTIONS.relation_audit],
              target: { kind: "claim", id: claimId },
              refs: [],
              compartments: one.compartments,
              expiresAt: null,
              expiresAfterDays: AUDIT_CARD_DAYS,
              caseKey: `relation_audit:${one.id}`,
              run: null,
              body: null,
              bodyFrom: null,
            },
            { now: clock?.now ?? new Date(), log },
          );
        });
        if (got.replayed) summary.held += 1;
        else summary.raised += 1;
      }
      log.info({
        event: "relation_audit",
        counts: {
          kinds: summary.kinds,
          picked: summary.picked,
          raised: summary.raised,
          held: summary.held,
          capped: summary.capped,
        },
      });
      return summary;
    },

    close: () => db.close(),
  };

  // The belief-type claims within the owner's clearance and not released, by claim key: the
  // pipeline reads no value row, so a relation's claim is found by computing each claim's key. Of
  // the claims on one key, the newest said, then the first by id, as the source check's
  // `claimByKey` and the card's text read it, so the card's target is the claim its text names.
  async function claimIdsByKey(): Promise<Map<string, string>> {
    const rows = await db.query<{ id: string; evidence_id: string; fact_key_fp: string }>(
      "select id, evidence_id, fact_key_fp from knowledge.claims where type = any ($1::text[]) and compartments <@ $2::text[] and not released order by valid_from desc, id",
      [[...BELIEF_TYPES], await ownerAudienceOf(db.query)],
    );
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const key = claimKey(keys, row.evidence_id, row.fact_key_fp);
      if (!byKey.has(key)) byKey.set(key, row.id);
    }
    return byKey;
  }
}

// The audit cards: raised by the pass as system:extract, as the same-fact sweep's are, and
// expiring after 14 days unanswered.
const AUDIT_CARD_DAYS = 14;
