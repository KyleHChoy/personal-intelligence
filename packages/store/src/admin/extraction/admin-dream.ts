import { createHash } from "node:crypto";
import {
  ClaimRelationKind,
  DREAM_FINDINGS_LIMIT,
  DREAM_SAMPLE_PER_KIND,
  type DreamFindingsView,
  DreamLineKind,
  type DreamSampleCheck,
  type DreamSampleView,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { isoWeek } from "@intelligence/personal-core/planner";
import { weekStartOf } from "../../cards/asked-less.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { stamp } from "../../core/db.ts";
import { ownerMarkId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { claimRecordOrNull } from "../../core/tx.ts";
import { phraseOf } from "../../pipeline/relation-store.ts";

// The owner's side of dreaming (as pi_admin): the owner's line for each kind and the owner's gate on
// the checker; the owner's weekly sample of each kind's checks, marked right, wrong and new to the owner on the page
// as the owner's own `owner:` check row, never relayed through an agent; the owner's lift of an agent's
// settlement; and the trial nights' rows. Ids, codes, counts and times only.

// `pia dream line KIND (VALUE | --unset) [--marks N]`: one row, append-only; the latest wins.
export async function setDreamLine(
  query: Query,
  kind: string,
  line: number | null,
  marks: number | null,
): Promise<{ kind: DreamLineKind; line: number | null; marks: number | null }> {
  const parsed = DreamLineKind.safeParse(kind);
  if (!parsed.success) throw new AdminError("invalid_argument");
  if (line !== null && !(line > 0 && line <= 1)) throw new AdminError("invalid_argument");
  if (parsed.data === "checker" && line !== null && (marks === null || !Number.isSafeInteger(marks) || marks < 1))
    throw new AdminError("invalid_argument");
  if (parsed.data !== "checker" && marks !== null) throw new AdminError("invalid_argument");
  await query("insert into policy.dream_lines (kind, line, marks) values ($1, $2, $3)", [
    parsed.data,
    line,
    line === null ? null : marks,
  ]);
  return { kind: parsed.data, line, marks: line === null ? null : marks };
}

// `pia dream model (check | screen) (ID | --unset)`: the second model or the screen, append-only.
export async function setDreamModel(
  query: Query,
  role: string,
  model: string | null,
): Promise<{ role: "check" | "screen"; model: string | null }> {
  if (role !== "check" && role !== "screen") throw new AdminError("invalid_argument");
  if (model !== null && !/^[A-Za-z0-9_./:-]{1,100}$/.test(model)) throw new AdminError("invalid_argument");
  await query("insert into policy.dream_models (role, model) values ($1, $2)", [role, model]);
  return { role, model };
}

// The lines in force, by kind, and when each was set.
export async function dreamLinesView(
  query: Query,
): Promise<{ kind: string; line: number | null; marks: number | null; at: string }[]> {
  const rows = await query<{ kind: string; line: number | null; marks: number | null; decided_at: Date }>(
    "select distinct on (kind) kind, line, marks, decided_at from policy.dream_lines order by kind, decided_at desc, id desc",
  );
  return rows.map((row) => ({ kind: row.kind, line: row.line, marks: row.marks, at: stamp(row.decided_at) }));
}

// Each claim a check or finding reads, opened with the owner's keys: its fact id, type and words, the
// `from` claim first; a restricted claim, one the key file cannot open, or one gone, is left out.
async function claimsRead(
  query: Query,
  keys: Keys,
  claimKeys: string[],
  fromKey: string | null,
): Promise<DreamSampleCheck["claims"]> {
  const rows = await query<{
    claim_key: string;
    id: string;
    evidence_id: string;
    fact_key_fp: string;
    compartments: string[];
    content_enc: Sealed;
  }>(
    `select distinct on (v.claim_key) v.claim_key, c.id, c.evidence_id, c.fact_key_fp, c.compartments, c.content_enc
     from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id
     where v.claim_key = any ($1::text[]) and not policy.is_restricted(c.compartments) order by v.claim_key, c.valid_from desc, c.id`,
    [claimKeys],
  );
  const ordered = [...rows].sort((a, b) => Number(b.claim_key === fromKey) - Number(a.claim_key === fromKey));
  return ordered.flatMap((one) => {
    const record = claimRecordOrNull(keys, one);
    return record === null
      ? []
      : [{ fact: one.id, type: record.claim.content.type, phrase: { untrusted: phraseOf(record) } }];
  });
}

type SampleRow = {
  id: string;
  target: string;
  kind: string;
  claim_keys: string[];
  from_key: string | null;
  relation_id: string | null;
  relation_judge: string | null;
  judge: string;
  verdict: string | null;
  created_at: Date;
  mark: string | null;
  new_to_me: boolean | null;
};

// The last whole ISO week's sample of each kind: the second model's sample checks (never a census or
// hot check) of the findings, at most DREAM_SAMPLE_PER_KIND a kind, chosen by a hash of the check and
// the week so the same ones show all week and no agent steers them; each with the owner's mark when
// the owner made one. Restricted labels are left out.
export async function dreamSample(query: Query, now: Date, keys: Keys): Promise<DreamSampleView> {
  const end = weekStartOf(now);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  const week = isoWeek(start, "-W");
  const rows = await query<SampleRow>(
    `select s.id::text as id, s.target, s.kind, s.claim_keys,
       (select r.from_claim_key from knowledge.claim_relations r where s.target = 'relation' and r.id = s.relation_id) as from_key, s.relation_id::text as relation_id, s.relation_judge, s.judge, s.verdict, s.created_at,
       (select case when o.verdict = 'supported' then 'right' else 'wrong' end from ledger.source_checks o
        where starts_with(o.judge, 'owner:mrk_') and o.target_key = s.target_key order by o.created_at desc, o.id desc limit 1) as mark,
       (select o.owner_new from ledger.source_checks o
        where starts_with(o.judge, 'owner:mrk_') and o.target_key = s.target_key order by o.created_at desc, o.id desc limit 1) as new_to_me
     from ledger.source_checks s
     where s.target in ('relation', 'identity') and starts_with(s.judge, 'model:') and not s.census and s.hot is null and s.verdict is not null
       and s.created_at >= $1 and s.created_at < $2 and not policy.is_restricted(s.compartments)
     order by s.id`,
    [start, end],
  );
  const order = (row: SampleRow): string => createHash("sha256").update(`${week}\n${row.id}`).digest("hex");
  const byKind = new Map<string, SampleRow[]>();
  for (const row of rows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  const claimsOf = (row: SampleRow) => claimsRead(query, keys, row.claim_keys, row.from_key);
  const checks: DreamSampleCheck[] = [];
  for (const [, kind] of [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    for (const row of kind.sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, DREAM_SAMPLE_PER_KIND))
      checks.push({
        check: row.id,
        target: row.target === "identity" ? "identity" : "relation",
        kind: row.kind,
        finding: row.relation_id,
        judge: row.relation_judge,
        checker: row.judge,
        verdict: row.verdict,
        at: stamp(row.created_at),
        mark: row.mark === "right" || row.mark === "wrong" ? row.mark : null,
        newToMe: row.new_to_me,
        claims: await claimsOf(row),
      });
  return { week, checks };
}

// The owner's mark on one sampled check: the owner's own check row of the same target, `owner:mrk_...`, right
// as `supported`, wrong as `wrong`, with whether it was new to the owner. Marking again adds a row; the
// newest is the owner's mark. Only a sample check of a finding takes one.
export async function markDreamCheck(
  query: Query,
  check: string,
  mark: "right" | "wrong",
  newToMe: boolean,
): Promise<{ check: string; mark: "right" | "wrong"; newToMe: boolean }> {
  if (!/^[1-9][0-9]{0,18}$/.test(check)) throw new AdminError("invalid_argument");
  const rows = await query<{ id: string }>(
    `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, claim_keys, evidence_ids, compartments, owner_new, live)
     select s.target, s.kind, s.target_key, s.relation_id, s.relation_judge, $2, $3, s.claim_keys, s.evidence_ids, s.compartments, $4, true
     from ledger.source_checks s
     where s.id = $1::bigint and s.target in ('relation', 'identity') and starts_with(s.judge, 'model:') and not s.census and s.hot is null
     returning id::text`,
    [check, `owner:${ownerMarkId()}`, mark === "right" ? "supported" : "wrong", newToMe],
  );
  if (rows.length === 0) throw new AdminError("not_found");
  return { check, mark, newToMe };
}

// `pia dream settlements lift ID`: the owner's lift of an agent's settlement (invariant 11). Its finding
// opens again, and a task with it.
export async function liftSettlement(query: Query, id: string): Promise<{ id: string; lifted: boolean }> {
  if (!/^bst_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new AdminError("invalid_argument");
  const rows = await query<{ id: string }>(
    "update ledger.belief_settlements set lifted_at = now() where id = $1 and lifted_at is null returning id",
    [id],
  );
  if (rows.length === 0) {
    const [seen] = await query<{ id: string }>("select id from ledger.belief_settlements where id = $1", [id]);
    if (seen === undefined) throw new AdminError("not_found");
  }
  return { id, lifted: rows.length > 0 };
}

// The trial nights, newest first: what each did per stage and kind, and what it cost.
export async function dreamNights(
  query: Query,
  limit = 20,
): Promise<{ pass: string; stopped: string; startedAt: string; endedAt: string; microUsd: number; counts: unknown }[]> {
  const rows = await query<{
    pass: string;
    stopped: string;
    started_at: Date;
    ended_at: Date;
    micro_usd: string;
    counts: unknown;
  }>(
    "select pass, stopped, started_at, ended_at, micro_usd::text, counts from ledger.dream_nights order by started_at desc, id desc limit $1",
    [Math.max(1, Math.min(200, limit))],
  );
  return rows.map((row) => ({
    pass: row.pass,
    stopped: row.stopped,
    startedAt: stamp(row.started_at),
    endedAt: stamp(row.ended_at),
    microUsd: Number(row.micro_usd),
    counts: row.counts,
  }));
}

// `pia dream trial`: what the trials measured, per kind, for the owner to set
// each kind's line and the caps from: findings by kind and judge, how many held on the second model
// and on the owner's own marks; the pairs each model asked; the screen's misses (the judge's findings on pairs
// the screen passed over, of the miss sample it asked); identity candidates by verdict and what came of
// them; and what the nights cost. Counts and micro-dollars only.
export async function dreamTrial(query: Query): Promise<{
  kinds: { kind: string; judge: string; findings: number; held: number; ownerRight: number; ownerWrong: number }[];
  asked: { judge: string; pairs: number }[];
  misses: { judge: string; sampled: number; found: number; held: number }[];
  identity: { verdict: string; state: string; n: number }[];
  nights: { n: number; microUsd: number };
}> {
  const kinds = await query<{
    kind: string;
    judge: string;
    findings: number;
    held: number;
    owner_right: number;
    owner_wrong: number;
  }>(
    `with marks as (
       select s.relation_id, (select o.verdict from ledger.source_checks o
                              where starts_with(o.judge, 'owner:mrk_') and o.target_key = s.target_key
                              order by o.created_at desc, o.id desc limit 1) as owner
       from ledger.source_checks s where s.target = 'relation' and starts_with(s.judge, 'model:') and not s.census and s.hot is null)
     select r.kind, r.judged_by as judge, count(distinct r.id)::int as findings,
       count(distinct r.id) filter (where policy.census_held(r.id, r.judged_by))::int as held,
       count(distinct r.id) filter (where exists (select 1 from marks m where m.relation_id = r.id and m.owner = 'supported'))::int as owner_right,
       count(distinct r.id) filter (where exists (select 1 from marks m where m.relation_id = r.id and m.owner = 'wrong'))::int as owner_wrong
     from knowledge.claim_relations r where starts_with(r.judged_by, 'model:') and not policy.is_restricted(r.compartments)
     group by r.kind, r.judged_by order by r.kind, r.judged_by`,
  );
  const asked = await query<{ judge: string; pairs: number }>(
    "select judge, count(*)::int as pairs from ledger.relation_checks where dream and other_key is not null group by judge order by judge",
  );
  const misses = await query<{ judge: string; sampled: number; found: number; held: number }>(
    `select j.judge, count(*)::int as sampled, count(*) filter (where j.written is not null)::int as found,
       count(*) filter (where j.written is not null and exists (
         select 1 from knowledge.claim_relations r where r.judged_by = j.judge and r.kind = j.written
           and ((r.from_claim_key = j.claim_key and r.to_claim_key = j.other_key) or (r.from_claim_key = j.other_key and r.to_claim_key = j.claim_key))
           and policy.census_held(r.id, r.judged_by)))::int as held
     from ledger.relation_checks j
     where j.dream and j.other_key is not null and exists (
       select 1 from ledger.relation_checks s
       where s.dream and s.claim_key = j.claim_key and s.other_key = j.other_key and s.judge <> j.judge
         and split_part(s.judge, '@', 2) = split_part(j.judge, '@', 2)
         and s.first_answer = 'unrelated' and s.second_answer = 'unrelated' and s.created_at < j.created_at)
     group by j.judge order by j.judge`,
  );
  const identity = await query<{ verdict: string; state: string; n: number }>(
    "select verdict, state, count(*)::int as n from ledger.dream_identity_candidates group by verdict, state order by verdict, state",
  );
  const [nights] = await query<{ n: number; micro_usd: string }>(
    "select count(*)::int as n, coalesce(sum(micro_usd), 0)::text as micro_usd from ledger.dream_nights",
  );
  return {
    kinds: kinds.map((row) => ({
      kind: row.kind,
      judge: row.judge,
      findings: row.findings,
      held: row.held,
      ownerRight: row.owner_right,
      ownerWrong: row.owner_wrong,
    })),
    asked,
    misses,
    identity,
    nights: { n: nights?.n ?? 0, microUsd: Number(nights?.micro_usd ?? 0) },
  };
}

// A claim key's fact key, by the claim the sample would open for it; null when restricted or gone.
const factKeyOf = (key: string): string =>
  `(select c.fact_key_fp from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id
    where v.claim_key = ${key} and not policy.is_restricted(c.compartments) order by c.valid_from desc, c.id limit 1)`;
// Every model relation not restricted, with whether it takes effect now and its two fact keys.
// Whether a relation's kind is on for its judge now: the kind's latest switch row, the owner's first.
export const KIND_ON = (r: string): string =>
  `coalesce((select w.switched_on from policy.relation_switches w where w.kind = ${r}.kind and w.judge = ${r}.judged_by
             order by (w.decided_by = 'owner') desc, w.decided_at desc, w.id desc limit 1), false)`;
// `effective`: what a read applies now, the relation's own check held (or the owner's on) and its kind on.
const MODEL_RELATIONS = `
  select r.id, r.kind, r.judged_by, r.judged_at, r.from_claim_key, r.to_claim_key,
    (policy.relation_effective(r.id, r.judged_by, r.kind, r.judged_at, now()) and ${KIND_ON("r")}) as effective,
    ${KIND_ON("r")} as switch_on,
    ${factKeyOf("r.from_claim_key")} as from_fp, ${factKeyOf("r.to_claim_key")} as to_fp
  from knowledge.claim_relations r where starts_with(r.judged_by, 'model:') and not policy.is_restricted(r.compartments)`;

// `pia dream findings [--kind KIND] [--limit N] [--effective]`: the findings themselves (contracts'
// DreamFindingsView). The switch is the kind's latest row for the judge, the owner's first; the
// check is the newest by a model other than the judge's, as policy.census_held reads it.
export async function dreamFindings(
  query: Query,
  keys: Keys,
  options: { kind: string | null; limit: number; effective: boolean },
): Promise<DreamFindingsView> {
  if (options.kind !== null && !ClaimRelationKind.safeParse(options.kind).success)
    throw new AdminError("invalid_argument");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > DREAM_FINDINGS_LIMIT.most)
    throw new AdminError("invalid_argument");
  const kinds = await query<{ kind: string; n: number; effective: number; across: number }>(
    `select m.kind, count(*)::int as n, count(*) filter (where m.effective)::int as effective,
       count(*) filter (where m.from_fp <> m.to_fp)::int as across
     from (${MODEL_RELATIONS}) m group by m.kind order by m.kind`,
  );
  const rows = await query<{
    id: string;
    kind: string;
    judged_by: string;
    judged_at: Date;
    from_claim_key: string;
    to_claim_key: string;
    effective: boolean;
    from_fp: string | null;
    to_fp: string | null;
    switch_on: boolean | null;
    checker: string | null;
    verdict: string | null;
    code: string | null;
  }>(
    `select m.id::text as id, m.kind, m.judged_by, m.judged_at, m.from_claim_key, m.to_claim_key, m.effective, m.from_fp, m.to_fp, m.switch_on,
       s.judge as checker, s.verdict, s.code
     from (${MODEL_RELATIONS}) m
     left join lateral (select s.judge, s.verdict, s.code from ledger.source_checks s
       where s.target = 'relation' and s.relation_id = m.id and starts_with(s.judge, 'model:') and s.hot is null
         and split_part(s.judge, '@', 1) <> split_part(m.judged_by, '@', 1)
       order by s.created_at desc, s.id desc limit 1) s on true
     where ($1::text is null or m.kind = $1) and (not $2::boolean or m.effective)
     order by m.judged_at desc, m.id desc limit $3`,
    [options.kind, options.effective, options.limit],
  );
  const findings: DreamFindingsView["findings"] = [];
  for (const row of rows)
    findings.push({
      id: row.id,
      kind: row.kind,
      judge: row.judged_by,
      judgedAt: stamp(row.judged_at),
      effective: row.effective,
      switchOn: row.switch_on === true,
      check: row.checker === null ? null : { checker: row.checker, verdict: row.verdict, code: row.code },
      sameFactKey: row.from_fp === null || row.to_fp === null ? null : row.from_fp === row.to_fp,
      claims: await claimsRead(query, keys, [row.from_claim_key, row.to_claim_key], row.from_claim_key),
    });
  const sum = (field: "n" | "effective" | "across"): number => kinds.reduce((total, row) => total + row[field], 0);
  return {
    summary: {
      total: sum("n"),
      effective: sum("effective"),
      byKind: Object.fromEntries(kinds.map((row) => [row.kind, row.n])),
      acrossFactKeys: sum("across"),
    },
    findings,
  };
}
