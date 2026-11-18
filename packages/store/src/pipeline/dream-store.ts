import type { CheckPassage, DreamPass, SourceCase, SourceCheckRow } from "@intelligence/contracts/personal";
import {
  BELIEF_TYPES,
  type ClaimRecord,
  type KeyedCallStore,
  type PersonalLogger,
} from "@intelligence/contracts/personal";
import { beliefsFor } from "@intelligence/personal-beliefs";
import { byText } from "../core/db.ts";
import { trackedCalls } from "../core/decision-calls.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { dreamFindingId } from "../core/ids.ts";
import { createDb } from "../core/job-db.ts";
import type { Keys } from "../core/keys.ts";
import { within } from "../core/labels.ts";
import { factsSubject } from "../core/stored-forms.ts";
import { claimRecordOrNull } from "../core/tx.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";
import { claimPassage } from "./claim-passage.ts";
import { restricted } from "./code-relations.ts";
import { phraseOf } from "./relation-store.ts";
import { dreamLines, linesLive } from "./relation-switch.ts";

// Store for the dream pass, as pi_pipeline under the extract lock: the night's
// order of subjects and when each was last reviewed; the census of every model finding by a
// second model, a stratified share of it flagged as the sample a line reads; the
// conflicts code could not settle, filed for the work tick; the identity pairs it judges and
// the candidates it files for the sweep, never a merge; and each trial night's row.
// Every row it writes is labelled with the union of what it read. Shapes are structural: this package
// does not import the extract package. Ids, keys, counts and codes in its log lines only.

type ClaimRow = { id: string; evidence_id: string; fact_key_fp: string; compartments: string[]; content_enc: unknown };
type Opened = { row: ClaimRow; record: ClaimRecord };

// A case the checker reads, and whether it is the census alone (never part of a line) or the sample.
export type CensusCase = SourceCase & { census: boolean };
// One passage of an identity pair's side, with its claim's phrase.
export type PairPassageRow = CheckPassage & { phrase: string };
export type IdentityPairRow = {
  question: string;
  aEntity: string;
  bEntity: string;
  a: PairPassageRow[];
  b: PairPassageRow[];
  compartments: string[];
  // The keyed replay's subject: the two people, by keyed fingerprint.
  subject: string;
  candidate?: string;
  // Whether either side's person has no belief-type claim at all, under any label: such a pair has
  // nothing to show the judge however its label is read.
  bare?: boolean;
};
export type DreamNightRow = {
  pass: DreamPass;
  judge: string;
  stopped: string;
  startedAt: string;
  endedAt: string;
  counts: Record<string, unknown>;
  microUsd: number;
};

export type DreamStore = {
  // The subjects to review in order: nightly, by the four tiers code reads; weekly, every subject with
  // a belief-type claim under the clearance, oldest review first.
  subjects(judge: string, pass: DreamPass, clearance: readonly string[], now: string): Promise<string[][]>;
  markDreamed(subjects: readonly string[], judge: string): Promise<void>;
  // The model relations `judge` wrote that the checker has not read, as cases, at most `limit`;
  // `sampleShare` of each kind, by a keyed selector, are the sample and the rest the census.
  // `live`: whether the owner trusts the checker now; a finding checked only while it was not is
  // checked again once it is, since such a check decides nothing.
  censusCases(
    judge: string,
    checker: string,
    clearance: readonly string[],
    limit: number,
    sampleShare: number,
    live: boolean,
  ): Promise<CensusCase[]>;
  saveChecks(rows: readonly (SourceCheckRow & { census: boolean })[], checker: string, live: boolean): Promise<number>;
  // Conflicts among the subject's claims that code could not settle: a `contradicts` of `judge` whose
  // census held and that no rule's or owner's relation settles, each filed once about `subject`.
  fileFindings(judge: string, subject: string): Promise<number>;
  // The oldest open questions with no candidate under `judge`, past those in `skip` (the pass's tried ones).
  identityPairs(judge: string, limit: number, skip?: ReadonlySet<string>): Promise<IdentityPairRow[]>;
  saveCandidate(
    pair: IdentityPairRow,
    judge: string,
    verdict: "same" | "different" | "cant_tell",
  ): Promise<string | null>;
  identityCensusCases(
    judge: string,
    checker: string,
    limit: number,
    sampleShare: number,
    live: boolean,
  ): Promise<(IdentityPairRow & { census: boolean })[]>;
  saveIdentityCheck(
    pair: IdentityPairRow & { census: boolean },
    judge: string,
    checker: string,
    answer: { verdict: "supported" | "unsupported" | "wrong" | null; code: string | null },
    live: boolean,
  ): Promise<number>;
  // Whether the owner's lines are live: the owner's second model agrees with the owner's marks.
  linesLive(): Promise<boolean>;
  // One pass at a time, nightly or weekly, by hand or by the timer: `work` under a session lock of its
  // own, held for the whole pass while its chunks take and let go of the extract lock.
  // `lost()` says the lock's connection has gone, and the lock with it: the pass stops between chunks.
  withPassLock<T>(work: (lost: () => boolean) => Promise<T>): Promise<T | "already_running">;
  // What the cheap screen already said of these claims' pairs, under its judge.
  screenAnswers(
    screen: string,
    claimKeys: readonly string[],
  ): Promise<{ claimKey: string; otherKey: string; firstAnswer: string | null; secondAnswer: string | null }[]>;
  saveNight(row: DreamNightRow): Promise<void>;
  // The owner's second model and screen (policy.dream_models), each null while unset.
  models(): Promise<{ check: string | null; screen: string | null }>;
  calls(): { store: KeyedCallStore; lastId(): Promise<string | null> };
  close(): Promise<void>;
};

// The pass's own session lock: one pass at a time, whatever starts it.
const PASS_LOCK = {
  try: "select pg_try_advisory_lock(hashtext('intelligence personal dream pass')) as held",
  give: "select pg_advisory_unlock(hashtext('intelligence personal dream pass'))",
} as const;

// The passages each side of an identity pair shows, newest first.
const SIDE_PASSAGES = 6;
const SERVED_DAYS = 7;
const DUE_DAYS = 7;
const KEYS_A_READ = 200;

export function createDreamStore({ url, keys, log }: { url: string; keys: Keys; log: PersonalLogger }): DreamStore {
  const db = createDb(url, log);
  const open = (row: ClaimRow): Opened | null => {
    const record = claimRecordOrNull(keys, row);
    return record === null ? null : { row, record };
  };
  const keyOf = (row: Pick<ClaimRow, "evidence_id" | "fact_key_fp">): string =>
    claimKey(keys, row.evidence_id, row.fact_key_fp);
  const passageOf = async (one: Opened): Promise<CheckPassage> => ({
    claimKey: keyOf(one.row),
    evidenceId: one.row.evidence_id,
    text: await claimPassage(db.query, keys, one.record, one.row.evidence_id),
    at: one.record.claim.validFrom,
  });
  // A keyed number in [0, 1) for a target, so the same targets are the sample every night.
  const selector = (target: string): number =>
    Number.parseInt(fingerprint(keys, "check_target", `sample\n${target}`).slice(0, 8), 16) / 2 ** 32;
  const subjectOf = (targetKey: string, passages: readonly CheckPassage[]): string => {
    const read = fingerprint(
      keys,
      "check_target",
      passages.map((one) => `${one.claimKey}\n${one.evidenceId}`).join("\n"),
    );
    const [a, b] = [targetKey, read].sort(byText) as [string, string];
    return factsSubject(a, b);
  };
  const ids = (rows: readonly { entity_id: string }[]): string[] => rows.map((row) => row.entity_id);
  const pairSubject = (a: string, b: string): string => {
    const [x, y] = [a, b].sort(byText).map((one) => fingerprint(keys, "check_target", `person\n${one}`)) as [
      string,
      string,
    ];
    return factsSubject(x, y);
  };

  // Open commitments due within the week, under the clearance: their subjects and counterparties.
  async function dueSubjects(clearance: readonly string[], now: string): Promise<string[]> {
    const factKeys = (
      await db.query<{ fact_key_fp: string }>(
        "select distinct fact_key_fp from knowledge.claims where type = 'commitment' and compartments <@ $1::text[] and not released order by 1",
        [clearance],
      )
    ).map((row) => row.fact_key_fp);
    const until = Date.parse(now) + DUE_DAYS * 86_400_000;
    const out: string[] = [];
    for (let at = 0; at < factKeys.length; at += KEYS_A_READ) {
      const page = factKeys.slice(at, at + KEYS_A_READ);
      const inputs = await readBeliefInputsUnder(db.query, keys, clearance, page, now);
      for (const { belief } of beliefsFor(inputs, clearance, now, page).rows) {
        const due = belief.values.due;
        if (belief.kind !== "commitment" || belief.status === "closed" || belief.status === "expired") continue;
        if (typeof due !== "string" || Number.isNaN(Date.parse(due)) || Date.parse(due) > until) continue;
        out.push(belief.subject);
        if (typeof belief.values.counterparty === "string") out.push(belief.values.counterparty);
      }
    }
    return out;
  }

  // An identity pair side: the newest belief-type claims about the person within the pair's label.
  async function sideOf(
    entity: string,
    label: readonly string[],
    only?: ReadonlySet<string>,
  ): Promise<{ passages: PairPassageRow[]; compartments: string[] }> {
    const rows = await db.query<ClaimRow>(
      `select c.id, c.evidence_id, c.fact_key_fp, c.compartments, c.content_enc from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id
       where x.entity_id = $1 and c.type = any ($2::text[]) and c.compartments <@ $3::text[] and not c.released and not c.closes
       order by c.valid_from desc, c.id collate "C" limit $4`,
      [entity, [...BELIEF_TYPES], label, only === undefined ? SIDE_PASSAGES : 200],
    );
    const passages: PairPassageRow[] = [];
    const compartments = new Set<string>();
    for (const row of rows) {
      if (only !== undefined && !only.has(keyOf(row))) continue;
      const one = open(row);
      if (one === null) continue;
      passages.push({ ...(await passageOf(one)), phrase: phraseOf(one.record) });
      for (const c of row.compartments) compartments.add(c);
      if (passages.length >= SIDE_PASSAGES) break;
    }
    return { passages, compartments: [...compartments] };
  }

  // The relation id below which the census found nothing it can read, for this store's pass.
  let censusFloor = "0";
  return {
    async subjects(judge, pass, clearance, now) {
      const BELIEF = [...BELIEF_TYPES];
      if (pass === "weekly")
        return [
          ids(
            await db.query<{ entity_id: string }>(
              `select e.id as entity_id from knowledge.entities e left join ledger.dream_subjects d on d.entity_id = e.id and d.judge = $1
               where e.kind in ('owner', 'person', 'organization')
                 and (exists (select 1 from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id
                              where x.entity_id = e.id and c.type = any ($2::text[]) and c.compartments <@ $3::text[] and not c.released)
                      -- The owner's own claims link to no entity (extraction leaves the owner out).
                      or (e.kind = 'owner' and exists (select 1 from knowledge.claims c where c.type = any ($2::text[]) and c.compartments <@ $3::text[]
                              and not c.released and not exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id))))
               order by d.dreamed_at nulls first, e.id collate "C"`,
              [judge, BELIEF, clearance],
            ),
          ),
        ];
      const served = await db.query<{ entity_id: string }>(
        `select x.entity_id from ledger.read_log r cross join lateral unnest(r.fact_key_fps) as k (fp)
         join knowledge.claims c on c.fact_key_fp = k.fp join knowledge.claim_entities x on x.claim_id = c.id
         where r.read_at > $1::timestamptz - make_interval(days => $2) and r.compartments <@ $3::text[] and c.compartments <@ $3::text[]
         group by x.entity_id order by count(*) desc, x.entity_id collate "C"`,
        [now, SERVED_DAYS, clearance],
      );
      const fresh = await db.query<{ entity_id: string }>(
        `select x.entity_id from knowledge.claims c join knowledge.claim_entities x on x.claim_id = c.id
         left join ledger.dream_subjects d on d.entity_id = x.entity_id and d.judge = $1
         where c.type = any ($2::text[]) and c.compartments <@ $3::text[] and not c.released
           and c.first_known_at > coalesce(d.dreamed_at, '-infinity'::timestamptz)
         group by x.entity_id order by max(c.first_known_at) desc, x.entity_id collate "C"`,
        [judge, BELIEF, clearance],
      );
      // The owner, while a claim of the owner's own (linked to no entity) is new since the owner's last
      // review or not yet judged, so the owner's backlog drains night by night.
      const mine = await db.query<{ entity_id: string }>(
        `select e.id as entity_id from knowledge.entities e left join ledger.dream_subjects d on d.entity_id = e.id and d.judge = $1
         where e.kind = 'owner' and exists (select 1 from knowledge.claims c where c.type = any ($2::text[]) and c.compartments <@ $3::text[]
           and not c.released and not c.closes and not exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id)
           and (c.first_known_at > coalesce(d.dreamed_at, '-infinity'::timestamptz)
                or coalesce((select m.state from ledger.relation_checks m where m.claim_id = c.id and m.judge = $1 and m.other_key is null order by m.id desc limit 1), '') <> 'judged'))`,
        [judge, BELIEF, clearance],
      );
      const goals = await db.query<{ entity_id: string }>(
        'select entity_id from ledger.dream_goal_subjects() order by entity_id collate "C"',
      );
      return [ids(served), [...ids(mine), ...ids(fresh)], ids(goals), await dueSubjects(clearance, now)];
    },

    async markDreamed(subjects, judge) {
      if (subjects.length === 0) return;
      await db.query(
        `insert into ledger.dream_subjects (entity_id, judge, dreamed_at)
         select e.id, $2, now() from knowledge.entities e where e.id = any ($1::text[])
         on conflict (entity_id, judge) do update set dreamed_at = excluded.dreamed_at`,
        [[...subjects], judge],
      );
    },

    async censusCases(judge, checker, clearance, limit, sampleShare, live) {
      type Unread = { id: string; from_claim_key: string; to_claim_key: string; kind: string; compartments: string[] };
      // A page of the judge's relations with no check yet, past `after`.
      const page = (after: string): Promise<Unread[]> =>
        db.query<Unread>(
          `select r.id::text as id, r.from_claim_key, r.to_claim_key, r.kind, r.compartments from knowledge.claim_relations r
           where r.judged_by = $1 and r.compartments <@ $3::text[] and r.id > $6::bigint
             and not exists (select 1 from ledger.source_checks s where s.relation_id = r.id and s.target = 'relation' and s.judge = $2
                             and (s.live or not $5))
           order by r.id limit $4`,
          [judge, checker, clearance, limit, live, after],
        );
      let relations = await page(censusFloor);
      if (relations.length === 0) return [];
      // The pipeline reads no value row: a relation's claims are found by each claim's key, the newest
      // on a key, as the source check and the audit card read it.
      const rows = await db.query<ClaimRow>(
        "select id, evidence_id, fact_key_fp, compartments, content_enc from knowledge.claims where type = any ($1::text[]) and compartments <@ $2::text[] and not released order by valid_from desc, id",
        [[...BELIEF_TYPES], clearance],
      );
      const byKey = new Map<string, ClaimRow>();
      for (const row of rows) if (!byKey.has(keyOf(row))) byKey.set(keyOf(row), row);
      const out: CensusCase[] = [];
      // A relation that cannot be read (a claim released or gone, a restricted label) gets no check
      // and is unread for good: the pages go on past such ones, so they never hide the rest.
      while (out.length === 0 && relations.length > 0) {
        for (const row of relations) {
          if (restricted(row.compartments)) continue;
          const [fromRow, toRow] = [byKey.get(row.from_claim_key), byKey.get(row.to_claim_key)];
          const [from, to] = [fromRow === undefined ? null : open(fromRow), toRow === undefined ? null : open(toRow)];
          if (from === null || to === null) continue;
          const targetKey = fingerprint(keys, "check_target", `relation\n${row.id}`);
          const passages = [await passageOf(from), await passageOf(to)];
          const compartments = [
            ...new Set([...row.compartments, ...from.row.compartments, ...to.row.compartments]),
          ].sort(byText);
          // The union of the relation's label and its claims' is the check's label: a check under a
          // restricted one is never saved, so it is never asked.
          if (!within(compartments, clearance) || restricted(compartments)) continue;
          out.push({
            target: "relation",
            kind: row.kind,
            targetKey,
            relationId: row.id,
            relationJudge: judge,
            statement: {
              kind: "relation",
              relation: row.kind as never,
              from: { type: from.record.claim.content.type, phrase: phraseOf(from.record) },
              to: { type: to.record.claim.content.type, phrase: phraseOf(to.record) },
            },
            passages,
            onCited: passages.every((one) => one.text !== null),
            subject: subjectOf(targetKey, passages),
            compartments,
            census: selector(targetKey) >= sampleShare,
          });
        }
        if (out.length === 0) {
          // Every relation up to here cannot be read: later calls of this pass start past them.
          censusFloor = relations.at(-1)?.id ?? censusFloor;
          relations = await page(censusFloor);
        }
      }
      return out;
    },

    async saveChecks(rows, checker, live) {
      let saved = 0;
      for (const row of rows) {
        if (restricted(row.compartments)) continue;
        await db.query(
          `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, code, cited, on_cited, claim_keys, evidence_ids, compartments, census, live)
           values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11::text[], $12::text[], $13::text[], $14, $15)`,
          [
            row.target,
            row.kind,
            row.targetKey,
            row.relationId,
            row.relationJudge,
            checker,
            row.verdict,
            row.code,
            row.cited,
            row.onCited,
            row.claimKeys,
            row.evidenceIds,
            [...row.compartments].sort(byText),
            row.census,
            live,
          ],
        );
        saved += 1;
      }
      return saved;
    },

    async fileFindings(judge, subject) {
      // The subject's belief-type claims, by key: the pipeline reads no value row.
      const claimKeys = (
        await db.query<{ evidence_id: string; fact_key_fp: string }>(
          `select c.evidence_id, c.fact_key_fp from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id
           where x.entity_id = $1 and c.type = any ($2::text[]) and not c.released`,
          [subject, [...BELIEF_TYPES]],
        )
      ).map(keyOf);
      if (claimKeys.length === 0) return 0;
      const rows = await db.query<{ id: string; a: string; b: string; compartments: string[] }>(
        `select r.id::text as id, least(r.from_claim_key collate "C", r.to_claim_key collate "C") as a,
           greatest(r.from_claim_key collate "C", r.to_claim_key collate "C") as b, r.compartments
         from knowledge.claim_relations r
         where r.judged_by = $1 and r.kind = 'contradicts' and r.from_claim_key = any ($2::text[]) and r.to_claim_key = any ($2::text[])
           and policy.census_held(r.id, r.judged_by)
           and not exists (select 1 from knowledge.claim_relations o
                           where (starts_with(o.judged_by, 'rule:') or starts_with(o.judged_by, 'owner:')) and o.kind in ('prevails', 'supersedes')
                             and ((o.from_claim_key = r.from_claim_key and o.to_claim_key = r.to_claim_key)
                               or (o.from_claim_key = r.to_claim_key and o.to_claim_key = r.from_claim_key)))
         order by r.id`,
        [judge, [...claimKeys]],
      );
      let filed = 0;
      for (const row of rows) {
        if (restricted(row.compartments)) continue;
        const made = await db.query<{ id: string }>(
          `insert into ledger.dream_findings (id, kind, relation_id, a_key, b_key, subject, judge, compartments)
           select $1, 'conflict', $2::bigint, $3, $4, $5, $6, $7::text[] where exists (select 1 from knowledge.entities e where e.id = $5)
           on conflict (a_key, b_key, judge) do nothing returning id`,
          [dreamFindingId(), row.id, row.a, row.b, subject, judge, [...row.compartments].sort(byText)],
        );
        filed += made.length;
      }
      return filed;
    },

    async identityPairs(judge, limit, skip = new Set<string>()) {
      const rows = await db.query<{ question: string; a_entity: string; b_entity: string; compartments: string[] }>(
        "select question, a_entity, b_entity, compartments from ledger.dream_identity_pairs($1, $2)",
        [judge, skip.size + limit],
      );
      const pairs = rows.filter((one) => !skip.has(one.question)).slice(0, limit);
      const out: IdentityPairRow[] = [];
      for (const pair of pairs) {
        const [a, b] = [await sideOf(pair.a_entity, pair.compartments), await sideOf(pair.b_entity, pair.compartments)];
        const [held] = await db.query<{ bare: boolean }>(
          `select not (exists (select 1 from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id
                              where x.entity_id = $1 and c.type = any ($3::text[]) and not c.released)
                  and exists (select 1 from knowledge.claim_entities x join knowledge.claims c on c.id = x.claim_id
                              where x.entity_id = $2 and c.type = any ($3::text[]) and not c.released)) as bare`,
          [pair.a_entity, pair.b_entity, [...BELIEF_TYPES]],
        );
        out.push({
          bare: held?.bare ?? false,
          question: pair.question,
          aEntity: pair.a_entity,
          bEntity: pair.b_entity,
          subject: pairSubject(pair.a_entity, pair.b_entity),
          a: a.passages,
          b: b.passages,
          compartments: [...new Set([...pair.compartments, ...a.compartments, ...b.compartments])].sort(byText),
        });
      }
      return out;
    },

    async saveCandidate(pair, judge, verdict) {
      const read = [...pair.a, ...pair.b];
      if (read.length === 0 || restricted(pair.compartments)) return null;
      const [row] = await db.query<{ id: string }>(
        `insert into ledger.dream_identity_candidates (question_id, a_entity, b_entity, judge, verdict, claim_keys, evidence_ids, compartments)
         values ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8::text[]) on conflict (question_id, judge) do nothing returning id::text`,
        [
          pair.question,
          pair.aEntity,
          pair.bEntity,
          judge,
          verdict,
          [...new Set(read.map((one) => one.claimKey))],
          [...new Set(read.map((one) => one.evidenceId))],
          pair.compartments,
        ],
      );
      return row?.id ?? null;
    },

    async identityCensusCases(judge, checker, limit, sampleShare, live) {
      const rows = await db.query<{
        id: string;
        question_id: string;
        a_entity: string;
        b_entity: string;
        claim_keys: string[];
        compartments: string[];
      }>(
        `select c.id::text as id, c.question_id, c.a_entity, c.b_entity, c.claim_keys, c.compartments from ledger.dream_identity_candidates c
         where c.judge = $1 and c.verdict = 'same' and c.state = 'filed'
           and not exists (select 1 from ledger.source_checks s where s.target = 'identity' and s.relation_id = c.id and s.judge = $2
                           and (s.live or not $4))
         order by c.id limit $3`,
        [judge, checker, limit, live],
      );
      const out: (IdentityPairRow & { census: boolean })[] = [];
      for (const row of rows) {
        const only = new Set(row.claim_keys);
        const [a, b] = [
          await sideOf(row.a_entity, row.compartments, only),
          await sideOf(row.b_entity, row.compartments, only),
        ];
        out.push({
          question: row.question_id,
          aEntity: row.a_entity,
          bEntity: row.b_entity,
          subject: pairSubject(row.a_entity, row.b_entity),
          a: a.passages,
          b: b.passages,
          compartments: row.compartments,
          candidate: row.id,
          census: selector(`identity\n${row.id}`) >= sampleShare,
        });
      }
      return out;
    },

    async saveIdentityCheck(pair, judge, checker, answer, live) {
      const read = [...pair.a, ...pair.b];
      if (pair.candidate === undefined || read.length === 0 || restricted(pair.compartments)) return 0;
      await db.query(
        `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, code, cited, on_cited, claim_keys, evidence_ids, compartments, census, live)
         values ('identity', 'same_person', $1, $2::bigint, $3, $4, $5, $6, null, $7, $8::text[], $9::text[], $10::text[], $11, $12)`,
        [
          fingerprint(keys, "check_target", `identity\n${pair.candidate}`),
          pair.candidate,
          judge,
          checker,
          answer.verdict,
          answer.code,
          read.every((one) => one.text !== null),
          [...new Set(read.map((one) => one.claimKey))].slice(0, 20),
          [...new Set(read.map((one) => one.evidenceId))].slice(0, 20),
          pair.compartments,
          pair.census,
          live,
        ],
      );
      return 1;
    },

    async screenAnswers(screen, claimKeys) {
      if (claimKeys.length === 0) return [];
      const rows = await db.query<{
        claim_key: string;
        other_key: string;
        first_answer: string | null;
        second_answer: string | null;
      }>(
        "select claim_key, other_key, first_answer, second_answer from ledger.relation_checks where judge = $1 and other_key is not null and (claim_key = any ($2::text[]) or other_key = any ($2::text[]))",
        [screen, [...claimKeys]],
      );
      return rows.map((row) => ({
        claimKey: row.claim_key,
        otherKey: row.other_key,
        firstAnswer: row.first_answer,
        secondAnswer: row.second_answer,
      }));
    },

    async saveNight(row) {
      await db.query(
        "insert into ledger.dream_nights (pass, judge, stopped, started_at, ended_at, counts, micro_usd) values ($1, $2, $3, $4, $5, $6::jsonb, $7)",
        [
          row.pass,
          row.judge,
          row.stopped,
          row.startedAt,
          row.endedAt,
          JSON.stringify(row.counts),
          Math.max(0, Math.round(row.microUsd)),
        ],
      );
    },

    linesLive: async () => linesLive(db.query, await dreamLines(db.query)),

    withPassLock: (work) =>
      db.session(async (query, lost) => {
        const [lock] = await query<{ held: boolean }>(PASS_LOCK.try);
        if (lock?.held !== true) return "already_running";
        try {
          return await work(lost);
        } finally {
          // A connection gone took the lock with it: nothing to give back, and the pass's result stands.
          await query(PASS_LOCK.give).catch(() => undefined);
        }
      }),

    async models() {
      const rows = await db.query<{ role: string; model: string | null }>(
        "select distinct on (role) role, model from policy.dream_models order by role, decided_at desc, id desc",
      );
      const of = (role: string): string | null => rows.find((row) => row.role === role)?.model ?? null;
      return { check: of("check"), screen: of("screen") };
    },

    calls: () => trackedCalls(db.query, keys),
    close: () => db.close(),
  };
}
