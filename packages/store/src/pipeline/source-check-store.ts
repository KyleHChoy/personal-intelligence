import type { CheckPassage, SourceCase, SourceCheckRow, SourceHot } from "@intelligence/contracts/personal";
import { BELIEF_TYPES, type ClaimRecord, type ClaimRelationKind } from "@intelligence/contracts/personal";
import { beliefsFor } from "@intelligence/personal-beliefs";
import { byText } from "../core/db.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { within } from "../core/labels.ts";
import { type NightOptions, type NightStore, nightStore } from "../core/night-store.ts";
import { open, type Sealed } from "../core/seal.ts";
import { factsSubject } from "../core/stored-forms.ts";
import { claimRecordOf } from "../core/tx.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";
import { claimPassage } from "./claim-passage.ts";
import { restricted } from "./code-relations.ts";
import { phraseOf } from "./relation-store.ts";

// The source check's store, run as pi_pipeline by `pi dream` under the extract lock. It samples,
// under a clearance (the owner's), the beliefs that clearance holds, computed at read as the read
// tools serve them, and the model relations within it, stratified by belief kind and by relation
// kind, never one already checked under the judge; it opens each sampled target's claims (only
// those the clearance holds: a target any of whose claims it cannot see is passed over, invariant
// 6) and their passages; and it writes one append-only check row each, labelled with the union of
// what it read. Shapes are the extract package's (structurally): this package does not import it.
// Ids, keys, counts and codes in its log lines only.
//
// Beside the sample, a small hot slice, chosen by code and never counted in a kind's precision, so
// the sample stays the unbiased estimate the switches read: the beliefs agents were served most
// over 7 days that no check under the judge read in 30 (`served`), and the beliefs checked before
// whose subject gained a claim since their last check (`new_evidence`). A hot check takes no target
// out of the sample: the sample passes over only what its own checks read.

type ClaimRow = { id: string; evidence_id: string; fact_key_fp: string; compartments: string[]; content_enc: Sealed };
type Opened = { row: ClaimRow; record: ClaimRecord };

type CheckPassageRow = CheckPassage;
type SourceCaseRow = SourceCase;
type SourceCheckRowIn = SourceCheckRow;
// A target as sampled, before its claims are opened: its stratum and what builds its case.
type Target = { stratum: string; build(): Promise<SourceCaseRow | null> };
// A belief as computed, for the hot slice: its target, the fact keys it answers (its own and a
// joined set's members), its subject and its supporting claims' row ids.
type Computed = {
  targetKey: string;
  factKeys: string[];
  subject: string;
  claims: string[];
  build(): Promise<SourceCaseRow | null>;
};

// The hot slice's windows: reads over the last 7 days; a belief checked within 30 is not served
// again.
const SERVED_DAYS = 7;
const RECHECK_DAYS = 30;
const DAY_MS = 86_400_000;

export type SourceCheckStore = NightStore & {
  // The night's cases, at most `size`, in the order `sample` (extract's `stratifiedSample`) gives
  // over the strata: `belief:<kind>` and `relation:<kind>`. With `hot`, the hot slice too, at most
  // `hot.size`, none of them a case of the sample: up to half served, then those with new evidence,
  // then served again to fill; `candidates` counts each list before the cut.
  cases(
    clearance: readonly string[],
    judge: string,
    now: string,
    size: number,
    sample: <T>(strata: ReadonlyMap<string, readonly T[]>, total: number) => T[],
    hot?: { size: number },
  ): Promise<{
    cases: SourceCaseRow[];
    strata: number;
    passedOver: number;
    hot: SourceCaseRow[];
    hotPassedOver: number;
    candidates: { served: number; newEvidence: number };
  }>;
  // `live`: whether the owner trusts the checking model now; a check made while not decides nothing.
  save(rows: readonly SourceCheckRowIn[], judge: string, live: boolean): Promise<number>;
};

const CLOSED: ReadonlySet<string> = new Set(["closed", "expired"]);
// The newest claims of a belief shown, and the passages a case reads at most; the fact keys a read
// of the belief inputs asks at once (policy.belief_inputs_under takes 1 000, joined keys among them).
const PASSAGES = 8;
const KEYS_A_READ = 200;

export function createSourceCheckStore(options: NightOptions): SourceCheckStore {
  const { keys } = options;
  const { db, shared } = nightStore(options);

  const openClaim = (row: ClaimRow): Opened | null => {
    const record = claimRecordOf(open(keys, row, "knowledge.claims.content_enc", "null"));
    return record === null ? null : { row, record };
  };
  const claimsById = async (ids: readonly string[]): Promise<ClaimRow[]> =>
    ids.length === 0
      ? []
      : db.query<ClaimRow>(
          'select id, evidence_id, fact_key_fp, compartments, content_enc from knowledge.claims where id = any ($1::text[]) and not released order by id collate "C"',
          [[...new Set(ids)]],
        );
  const keyOf = (row: Pick<ClaimRow, "evidence_id" | "fact_key_fp">): string =>
    claimKey(keys, row.evidence_id, row.fact_key_fp);
  const passageOf = async (one: Opened): Promise<CheckPassageRow> => ({
    claimKey: keyOf(one.row),
    evidenceId: one.row.evidence_id,
    text: await claimPassage(db.query, keys, one.record, one.row.evidence_id),
    at: one.record.claim.validFrom,
  });
  // The keyed replay's subject: the target and its passages' claims and items, two keyed
  // fingerprints in order, as a `facts:` subject takes them.
  const subjectOf = (targetKey: string, passages: readonly CheckPassageRow[]): string => {
    const read = fingerprint(
      keys,
      "check_target",
      passages.map((one) => `${one.claimKey}\n${one.evidenceId}`).join("\n"),
    );
    const [a, b] = [targetKey, read].sort(byText) as [string, string];
    return factsSubject(a, b);
  };

  // The hot slice's two lists over the beliefs computed tonight, less those the sample took
  // (`sampled`), and the cases built from them. A subject's newest claim is read over every belief
  // computed. Code alone chooses: reads and times from the ledger, never a model.
  const hotSlice = async (
    beliefs: readonly Computed[],
    sampled: ReadonlySet<string>,
    audience: readonly string[],
    judge: string,
    now: string,
    size: number,
  ): Promise<{
    hot: SourceCaseRow[];
    hotPassedOver: number;
    candidates: { served: number; newEvidence: number };
  }> => {
    const at = Date.parse(now);
    // Each supporting claim of a computed belief, within the clearance: its keyed claim key and when
    // it was written.
    const claims = new Map(
      (
        await db.query<{ id: string; evidence_id: string; fact_key_fp: string; created_at: Date }>(
          "select id, evidence_id, fact_key_fp, created_at from knowledge.claims where id = any ($1::text[]) and compartments <@ $2::text[] and not released",
          [[...new Set(beliefs.flatMap((one) => one.claims))], audience],
        )
      ).map((row) => [row.id, { key: keyOf(row), at: row.created_at.getTime() }]),
    );
    // A claim's latest check under the judge, sample or hot: a belief was checked when a check read
    // one of its claims.
    const checked = new Map<string, number>();
    for (const row of await db.query<{ claim_keys: string[]; created_at: Date }>(
      "select claim_keys, created_at from ledger.source_checks where judge = $1 and target = 'belief'",
      [judge],
    ))
      for (const key of row.claim_keys) checked.set(key, Math.max(checked.get(key) ?? 0, row.created_at.getTime()));
    // The reads over the window under a label the clearance holds, by fact key.
    const reads = new Map(
      (
        await db.query<{ fact_key_fp: string; reads: number }>(
          `select k.fact_key_fp, count(*)::int as reads from ledger.read_log r cross join lateral unnest(r.fact_key_fps) as k(fact_key_fp)
           where r.read_at > $2::timestamptz - make_interval(days => $3) and r.compartments <@ $1::text[] group by k.fact_key_fp`,
          [audience, now, SERVED_DAYS],
        )
      ).map((row) => [row.fact_key_fp, row.reads]),
    );
    const facts = beliefs.map((one) => {
      const own = one.claims.flatMap((id) => {
        const claim = claims.get(id);
        return claim === undefined ? [] : [claim];
      });
      const last = Math.max(0, ...own.map((claim) => checked.get(claim.key) ?? 0));
      return {
        one,
        lastChecked: last === 0 ? null : last,
        newest: Math.max(0, ...own.map((claim) => claim.at)),
        reads: one.factKeys.reduce((sum, key) => sum + (reads.get(key) ?? 0), 0),
      };
    });
    const subjectNewest = new Map<string, number>();
    for (const fact of facts)
      subjectNewest.set(fact.one.subject, Math.max(subjectNewest.get(fact.one.subject) ?? 0, fact.newest));
    const unsampled = facts.filter((fact) => !sampled.has(fact.one.targetKey));
    const served = unsampled
      .filter((fact) => fact.reads > 0 && (fact.lastChecked === null || fact.lastChecked <= at - RECHECK_DAYS * DAY_MS))
      .sort((a, b) => b.reads - a.reads || byText(a.one.targetKey, b.one.targetKey))
      .map((fact) => fact.one);
    const newEvidence = unsampled
      .filter((fact) => fact.lastChecked !== null && (subjectNewest.get(fact.one.subject) ?? 0) > fact.lastChecked)
      .sort((a, b) => (a.lastChecked ?? 0) - (b.lastChecked ?? 0) || byText(a.one.targetKey, b.one.targetKey))
      .map((fact) => fact.one);

    const hot: SourceCaseRow[] = [];
    const taken = new Set<string>();
    let hotPassedOver = 0;
    const fill = async (list: readonly Computed[], why: SourceHot, upTo: number): Promise<void> => {
      for (const one of list) {
        if (hot.length >= upTo) return;
        if (taken.has(one.targetKey)) continue;
        taken.add(one.targetKey);
        const built = await one.build();
        if (built === null || restricted(built.compartments) || !within(built.compartments, audience))
          hotPassedOver += 1;
        else hot.push({ ...built, hot: why });
      }
    };
    await fill(served, "served", Math.ceil(size / 2));
    await fill(newEvidence, "new_evidence", size);
    await fill(served, "served", size);
    return { hot, hotPassedOver, candidates: { served: served.length, newEvidence: newEvidence.length } };
  };

  return {
    ...shared,
    async cases(clearance, judge, now, size, sample, hot) {
      const audience = [...new Set(clearance)].sort(byText);
      // What the sample's own checks read: a hot check never takes a target out of the sample.
      const done = new Set(
        (
          await db.query<{ target_key: string }>(
            "select distinct target_key from ledger.source_checks where judge = $1 and hot is null",
            [judge],
          )
        ).map((row) => row.target_key),
      );
      const computed: Computed[] = [];
      const strata = new Map<string, Target[]>();
      const add = (stratum: string, target: Target): void => {
        strata.set(stratum, [...(strata.get(stratum) ?? []), target]);
      };

      // The beliefs the clearance holds now, computed at read as the read tools serve them
      // (beliefsFor over every fact key of a belief-type claim within it), by key in pages.
      const factKeys = (
        await db.query<{ fact_key_fp: string }>(
          "select distinct fact_key_fp from knowledge.claims where type = any ($1::text[]) and compartments <@ $2::text[] and not released order by 1",
          [[...BELIEF_TYPES], audience],
        )
      ).map((row) => row.fact_key_fp);
      const seen = new Set<string>();
      for (let at = 0; at < factKeys.length; at += KEYS_A_READ) {
        const page = factKeys.slice(at, at + KEYS_A_READ);
        const inputs = await readBeliefInputsUnder(db.query, keys, audience, page, now);
        for (const row of beliefsFor(inputs, audience, now, page).rows) {
          const { belief } = row;
          if (CLOSED.has(belief.status) || seen.has(belief.factKey)) continue;
          seen.add(belief.factKey);
          const support = [...belief.support].sort(byText);
          const targetKey = fingerprint(
            keys,
            "check_target",
            `belief\n${audience.join(",")}\n${belief.factKey}\n${support.join(",")}`,
          );
          const claimIds = support.map((id) => fingerprint(keys, "claim", id));
          const target: Target = {
            stratum: `belief:${belief.kind}`,
            build: async () => {
              const rows = await claimsById(claimIds);
              // Every supporting claim must be within the clearance and open, or the belief is passed over.
              if (rows.length !== support.length || !rows.every((one) => within(one.compartments, audience)))
                return null;
              const opened = rows.map(openClaim);
              if (opened.some((one) => one === null)) return null;
              const claims = (opened as Opened[])
                .sort(
                  (a, b) =>
                    Date.parse(b.record.claim.validFrom) - Date.parse(a.record.claim.validFrom) ||
                    byText(a.row.id, b.row.id),
                )
                .slice(0, PASSAGES);
              const newest = claims[0];
              if (newest === undefined) return null;
              const passages = await Promise.all(claims.map(passageOf));
              return {
                target: "belief",
                kind: belief.kind,
                targetKey,
                relationId: null,
                relationJudge: null,
                statement: { kind: "fact", type: belief.type, phrase: phraseOf(newest.record) },
                passages,
                onCited: passages.every((one) => one.text !== null),
                subject: subjectOf(targetKey, passages),
                compartments: [...new Set(claims.flatMap((one) => one.row.compartments))].sort(byText),
              };
            },
          };
          computed.push({
            targetKey,
            factKeys: [row.factKeyFp, ...(row.members ?? [])],
            subject: belief.subject,
            claims: claimIds,
            build: target.build,
          });
          if (!done.has(targetKey)) add(target.stratum, target);
        }
      }

      const relations = await db.query<{
        id: string;
        from_claim_key: string;
        to_claim_key: string;
        kind: ClaimRelationKind;
        judged_by: string;
        compartments: string[];
      }>(
        "select id::text as id, from_claim_key, to_claim_key, kind, judged_by, compartments from knowledge.claim_relations where starts_with(judged_by, 'model:') and compartments <@ $1::text[] order by id",
        [audience],
      );
      let byKey: Map<string, ClaimRow> | null = null;
      const claimByKey = async (key: string): Promise<ClaimRow | undefined> => {
        if (byKey === null) {
          // The pipeline reads no value row: a relation's claims are found by each claim's key. Of
          // the claims on one key, the newest said, then the first by id: the one the relation's
          // audit card reads (card-kinds-relations.ts).
          const rows = await db.query<ClaimRow>(
            "select id, evidence_id, fact_key_fp, compartments, null as content_enc from knowledge.claims where type = any ($1::text[]) and compartments <@ $2::text[] and not released order by valid_from desc, id",
            [[...BELIEF_TYPES], audience],
          );
          byKey = new Map();
          for (const row of rows) if (!byKey.has(keyOf(row))) byKey.set(keyOf(row), row);
        }
        return byKey.get(key);
      };
      for (const row of relations) {
        if (restricted(row.compartments)) continue;
        const targetKey = fingerprint(keys, "check_target", `relation\n${row.id}`);
        if (done.has(targetKey)) continue;
        add(`relation:${row.kind}`, {
          stratum: `relation:${row.kind}`,
          build: async () => {
            const [fromRow, toRow] = [await claimByKey(row.from_claim_key), await claimByKey(row.to_claim_key)];
            if (fromRow === undefined || toRow === undefined) return null;
            const rows = await claimsById([fromRow.id, toRow.id]);
            const found = (id: string): Opened | null => {
              const one = rows.find((candidate) => candidate.id === id);
              return one === undefined ? null : openClaim(one);
            };
            const [from, to] = [found(fromRow.id), found(toRow.id)];
            if (
              from === null ||
              to === null ||
              !within(from.row.compartments, audience) ||
              !within(to.row.compartments, audience)
            )
              return null;
            const passages = [await passageOf(from), await passageOf(to)];
            return {
              target: "relation",
              kind: row.kind,
              targetKey,
              relationId: row.id,
              relationJudge: row.judged_by,
              statement: {
                kind: "relation",
                relation: row.kind,
                from: { type: from.record.claim.content.type, phrase: phraseOf(from.record) },
                to: { type: to.record.claim.content.type, phrase: phraseOf(to.record) },
              },
              passages,
              // Item 9: scored only when it reads the two passages the relation's claims cite.
              onCited: passages.every((one) => one.text !== null),
              subject: subjectOf(targetKey, passages),
              compartments: [...new Set([...row.compartments, ...from.row.compartments, ...to.row.compartments])].sort(
                byText,
              ),
            };
          },
        });
      }

      const cases: SourceCaseRow[] = [];
      let passedOver = 0;
      for (const target of sample(strata, Number.MAX_SAFE_INTEGER)) {
        if (cases.length >= size) break;
        const built = await target.build();
        if (built === null || restricted(built.compartments) || !within(built.compartments, audience)) passedOver += 1;
        else cases.push(built);
      }
      const slice =
        hot === undefined || hot.size <= 0
          ? { hot: [], hotPassedOver: 0, candidates: { served: 0, newEvidence: 0 } }
          : await hotSlice(computed, new Set(cases.map((one) => one.targetKey)), audience, judge, now, hot.size);
      return { cases, strata: strata.size, passedOver, ...slice };
    },

    // Each row as it is: a check is never updated. A restricted label is never written here.
    async save(rows, judge, live) {
      let saved = 0;
      for (const row of rows) {
        if (restricted(row.compartments)) continue;
        await db.query(
          `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, code, cited, on_cited, claim_keys, evidence_ids, compartments, hot, live)
           values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11::text[], $12::text[], $13::text[], $14, $15)`,
          [
            row.target,
            row.kind,
            row.targetKey,
            row.relationId,
            row.relationJudge,
            judge,
            row.verdict,
            row.code,
            row.cited,
            row.onCited,
            row.claimKeys,
            row.evidenceIds,
            [...row.compartments].sort(byText),
            row.hot ?? null,
            live,
          ],
        );
        saved += 1;
      }
      return saved;
    },
  };
}
