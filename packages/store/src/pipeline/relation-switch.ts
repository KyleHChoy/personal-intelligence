import type { ClaimRelationKind, DreamLines, PersonalLogger, SwitchKind } from "@intelligence/contracts/personal";
import { CLAIM_RELATION_KINDS, SWITCH_KINDS } from "@intelligence/contracts/personal";
import { checkerTrusted, decideSwitch, quietDay, type SwitchMeasures } from "@intelligence/personal-beliefs";
import { minimumCloses } from "@intelligence/personal-core/planner";
import { relationRules } from "@intelligence/personal-core/views";
import type { Query } from "../core/db.ts";

// The system's switching job, moved out of
// relation-store.ts so the identity sweep shares it: per kind and judge, the owner's line (none ever
// set: a relation kind is on by each finding's own check; unset by the owner: off), only a checker other than the judge counting, and the checker's own trust read from the
// owner's marks. A kind takes effect by itself at its line and stops by itself below it; the owner's
// row outranks it either way. Counts and codes only.

export type SwitchPassSummary = { kinds: number; switched: number; held: number; owner: number; sourceCheck: number };

// The owner's lines in force: each kind's latest row, and the checker's gate. A kind or the gate the
// owner never set is absent; one the owner unset (a row with no line) is null: the owner's own word that
// it has none, which keeps a kind off and the checker untrusted (invariant 11).
export async function dreamLines(query: Query): Promise<DreamLines> {
  const rows = await query<{ kind: string; line: number | null; marks: number | null }>(
    "select distinct on (kind) kind, line, marks from policy.dream_lines order by kind, decided_at desc, id desc",
  );
  const kinds: DreamLines["kinds"] = {};
  let checker: DreamLines["checker"];
  for (const row of rows) {
    if (row.kind === "checker")
      checker = row.line === null || row.marks === null ? null : { rate: row.line, marks: row.marks };
    else if ((SWITCH_KINDS as readonly string[]).includes(row.kind)) kinds[row.kind as SwitchKind] = row.line;
  }
  return checker === undefined ? { kinds } : { kinds, checker };
}

// How the checker's verdicts agree with the owner's own marks from the page: over the owner's latest marks (as
// many as the owner's gate reads), each against the model check of the same target before it.
export async function checkerAgreement(
  query: Query,
  marks: number,
  checker: string,
): Promise<{ agreed: number; marked: number }> {
  const [row] = await query<{ agreed: number; marked: number }>(
    `with mine as (
       select o.target_key, o.verdict, o.created_at from ledger.source_checks o
       where starts_with(o.judge, 'owner:mrk_') and o.verdict in ('supported', 'wrong')
       order by o.created_at desc, o.id desc limit $1),
     paired as (
       select m.verdict as owner, (select s.verdict from ledger.source_checks s
                                   where s.target_key = m.target_key and split_part(s.judge, '@', 1) = 'model:' || $2
                                     and s.created_at <= m.created_at
                                   order by s.created_at desc, s.id desc limit 1) as model
       from mine m)
     select count(*) filter (where (owner = 'supported') = (model = 'supported'))::int as agreed, count(*)::int as marked
     from paired where model is not null`,
    [Math.max(1, marks), checker],
  );
  return { agreed: row?.agreed ?? 0, marked: row?.marked ?? 0 };
}

// Whether every line is live now: a second model is set, and where the owner set a gate on it, it
// agrees with the owner's marks at that gate, read over its own checks alone. With no gate ever set it
// is live; with the gate unset by the owner it is not.
export async function linesLive(query: Query, lines: DreamLines): Promise<boolean> {
  const [model] = await query<{ model: string | null }>(
    "select model from policy.dream_models where role = 'check' order by decided_at desc, id desc limit 1",
  );
  if (model?.model == null) return false;
  if (lines.checker === undefined) return true;
  if (lines.checker === null) return false;
  // Stored as the owner typed it: a bare Anthropic id is read as the pass reads it.
  const checker = /^claude-/.test(model.model) ? `anthropic/${model.model}` : model.model;
  return checkerTrusted(await checkerAgreement(query, lines.checker.marks, checker), lines.checker);
}

type Latest = { switched_on: boolean; decided_by: string; code: string | null; decided_at: Date };
const latestOf = async (query: Query, kind: string, judge: string): Promise<Latest | undefined> =>
  (
    await query<Latest>(
      "select switched_on, decided_by, measures ->> 'code' as code, decided_at from policy.relation_switches where kind = $1 and judge = $2 order by decided_at desc, id desc limit 1",
      [kind, judge],
    )
  )[0];

// One kind's decision and, when its state changes, its row. `measuresFor` reads the kind's measures.
async function switchOne(
  query: Query,
  kind: SwitchKind,
  judge: string,
  lines: DreamLines,
  live: boolean,
  measuresFor: (offByBound: boolean) => Promise<SwitchMeasures>,
  log: PersonalLogger,
): Promise<{ changed: boolean; on: boolean; code: string; owner: boolean; was?: Latest }> {
  const rules = relationRules().switch;
  const latest = await latestOf(query, kind, judge);
  if (latest?.decided_by === "owner") return { changed: false, on: latest.switched_on, code: "owner", owner: true };
  const current = {
    on: latest?.switched_on === true,
    offByBound:
      latest !== undefined &&
      !latest.switched_on &&
      (latest.code === "overturn_bound" || latest.code === "contradiction_bound" || latest.code === "below_line"),
  };
  // With the owner's line, the line and the checker's trust decide; unset by the owner, the kind is
  // off. With none ever set, a kind the rules name (`checkedEachKinds`) is on while a trusted second
  // model checks each finding before it takes effect (policy.relation_effective); any other kind,
  // and a merge of two people, which no read takes back, waits for the owner's line.
  const line = lines.kinds[kind];
  const measures: SwitchMeasures = {
    ...(await measuresFor(current.offByBound)),
    ...(line === undefined && (rules.checkedEachKinds as readonly string[]).includes(kind)
      ? { checkedEach: live }
      : { line: line ?? null, checkerTrusted: live }),
  };
  const decision = decideSwitch(current, measures, rules);
  if (decision.on === current.on)
    return { changed: false, on: current.on, code: decision.code, owner: false, ...(latest ? { was: latest } : {}) };
  await query(
    "insert into policy.relation_switches (kind, judge, switched_on, decided_by, measures) values ($1, $2, $3, 'system', $4::jsonb)",
    [
      kind,
      judge,
      decision.on,
      JSON.stringify({
        code: decision.code,
        line: measures.line ?? null,
        agreed: measures.agreement.agreed,
        checked: measures.agreement.checked,
        overturned: measures.overturns.overturned,
        contradicted: measures.laterContradictions.contradicted,
        applied: measures.overturns.applied,
        supported: measures.sourceCheck?.supported ?? 0,
        scored: measures.sourceCheck?.scored ?? 0,
        audit_wrong: measures.audits?.wrong ?? 0,
        audit_answered: measures.audits?.answered ?? 0,
      }),
    ],
  );
  log.info({ event: "relation_switch", code: decision.code, counts: { on: decision.on ? 1 : 0 } });
  return { changed: true, on: decision.on, code: decision.code, owner: false, ...(latest ? { was: latest } : {}) };
}

// The relation kinds of one judge. A row is written only when the state changes.
export async function runSwitchPass(query: Query, judge: string, log: PersonalLogger): Promise<SwitchPassSummary> {
  const rules = relationRules().switch;
  const summary: SwitchPassSummary = { kinds: 0, switched: 0, held: 0, owner: 0, sourceCheck: 0 };
  const lines = await dreamLines(query);
  const live = await linesLive(query, lines);
  for (const kind of CLAIM_RELATION_KINDS) {
    summary.kinds += 1;
    const one = await switchOne(
      query,
      kind,
      judge,
      lines,
      live,
      (offByBound) => measuresOf(query, kind, judge, rules, offByBound),
      log,
    );
    if (one.owner) summary.owner += 1;
    if (one.code === "held_r11") summary.held += 1;
    if (!one.changed) continue;
    summary.switched += 1;
    if (one.code === "source_check") summary.sourceCheck += 1;
  }
  return summary;
}

// The identity merges' kind for one judge, as the sweep runs it as pi_admin. When the
// kind falls below its line, every `dream` merge made since the switch row that last turned it on is
// lifted in bulk. A pause for the checker's drift lifts nothing. The merges lifted.
export async function runIdentitySwitch(
  query: Query,
  judge: string,
  log: PersonalLogger,
): Promise<{ on: boolean; code: string; lifted: number }> {
  const lines = await dreamLines(query);
  const live = await linesLive(query, lines);
  const one = await switchOne(query, "same_person", judge, lines, live, () => identityMeasures(query, judge), log);
  if (!(one.changed && !one.on && one.code === "below_line") || one.was === undefined)
    return { on: one.on, code: one.code, lifted: 0 };
  const [row] = await query<{ n: number }>("select ledger.dream_lift_merges($1, $2::timestamptz) as n", [
    judge,
    one.was.decided_at,
  ]);
  log.info({ event: "dream_merges_lifted", counts: { lifted: row?.n ?? 0 } });
  return { on: false, code: one.code, lifted: row?.n ?? 0 };
}

// The identity kind's measures: its candidates' sample checks, and the owner's overturns, the owner's lifts of
// a `dream` merge over the merges in the rate window. No order agreement applies to a pair.
async function identityMeasures(query: Query, judge: string): Promise<SwitchMeasures> {
  const rules = relationRules().switch;
  const checks = await relationCheckScore(query, "same_person", judge);
  const [rates] = await query<{ applied: number; overturned: number }>(
    `select count(*)::int as applied, count(*) filter (where r.lifted_at is not null and not r.lifted_by_deletion)::int as overturned
     from ledger.dream_identity_candidates c join knowledge.identity_rulings r on r.ruling_id = c.ruling_id
     where c.judge = $1 and r.created_at > now() - make_interval(days => $2)`,
    [judge, rules.rateWindowDays],
  );
  return {
    evaluation: null,
    sourceCheck: checks.scored === 0 ? null : checks,
    agreement: { agreed: 1, checked: 1, days: rules.orderAgreementDays },
    overturns: { overturned: rates?.overturned ?? 0, applied: rates?.applied ?? 0 },
    laterContradictions: { contradicted: 0, applied: 0 },
    quietDays: rules.reenableDays,
  };
}

// The source-check score for one kind under the judge that wrote its findings, the one rule the switch and
// `pia work report` both read: the sample's model checks on the passages each finding cites, after the
// owner's latest `wrong` on the kind (their kept verdict's included), and how many found it supported; an
// `uncited` or `rejected` check is scored, as not supported. Only a checker other than the judge counts (a
// model never scores its own work), and a census check, which decides one finding alone, is never part of a
// precision, nor is a check of the hot slice, nor a check made while the checker was not trusted (`live`
// false), which measures and decides nothing. An identity merge's kind reads its candidates' checks.
export async function relationCheckScore(
  query: Query,
  kind: string,
  judge: string,
): Promise<{ supported: number; scored: number }> {
  const target = kind === "same_person" ? "identity" : "relation";
  const [row] = await query<{ supported: number; scored: number }>(
    `with last_wrong as (
       select max(created_at) as at from ledger.source_checks
       where target = $3 and kind = $1 and relation_judge = $2 and starts_with(judge, 'owner:') and verdict = 'wrong')
     select count(*) filter (where s.verdict = 'supported')::int as supported,
       count(*) filter (where s.verdict is not null or s.code in ('uncited', 'rejected'))::int as scored
     from ledger.source_checks s cross join last_wrong w
     where s.target = $3 and s.kind = $1 and s.relation_judge = $2 and starts_with(s.judge, 'model:') and s.on_cited
       and split_part(s.judge, '@', 1) <> split_part($2, '@', 1)
       and s.hot is null and not s.census and s.live and (w.at is null or s.created_at > w.at)`,
    [kind, judge, target],
  );
  return { supported: row?.supported ?? 0, scored: row?.scored ?? 0 };
}

// A relation the agents found wrong: two reports of it that agree, from two clients in two sessions
// under one label, or one report and a later check of it by a model other than its judge, live and
// not on the hot slice, that did not hold as policy.census_held reads one. One agent alone never
// counts. The owner's latest answer on its audit card, when it is `right`, cancels the agents' count
// (invariant 11). `m` is a relation's row.
const AGENTS_OVERTURNED = (m: string): string => `(
  (exists (select 1 from ledger.relation_reports a join ledger.relation_reports b
             on b.relation_id = a.relation_id and b.client_id <> a.client_id and b.session_id <> a.session_id
            and b.compartments = a.compartments
           where a.relation_id = ${m}.id)
   or exists (select 1 from ledger.relation_reports a join ledger.source_checks s
                on s.target = 'relation' and s.relation_id = a.relation_id and s.created_at > a.created_at
               and starts_with(s.judge, 'model:') and split_part(s.judge, '@', 1) <> split_part(${m}.judged_by, '@', 1)
               and s.hot is null and s.live and not (s.verdict is not distinct from 'supported' and s.on_cited)
              where a.relation_id = ${m}.id))
  and coalesce((select o.verdict from ledger.source_checks o
                where o.target = 'relation' and o.relation_id = ${m}.id and starts_with(o.judge, 'owner:')
                  and o.verdict in ('supported', 'wrong')
                order by o.created_at desc, o.id desc limit 1), 'none') <> 'supported')`;

// The live measures that switch one kind and judge, counts only. No evaluation is recorded on the
// box yet (the evaluation runs on the synthetic set, beside the code), so an off kind meets the
// precision criterion only by its source checks: the model checks of this
// judge's relations of the kind whose passages are the ones each relation cites, and how many
// found them supported; an `uncited` or `rejected` check is scored, as not supported, so a check
// the model could not ground never drops out of the count. Only checks written after the owner's
// latest `wrong` on the kind count: after the owner's `wrong`, the bound is earned again. The owner's audit
// answers over the rate window are their own overturn rate (the owner's `wrong`s over their answers), which
// each quiet day reads over its own window as it reads the relations' overturns.
async function measuresOf(
  query: Query,
  kind: ClaimRelationKind,
  judge: string,
  rules: ReturnType<typeof relationRules>["switch"],
  offByBound: boolean,
): Promise<SwitchMeasures> {
  const [agreement] = await query<{ agreed: number; checked: number; days: number }>(
    `select count(*) filter (where c.agreed and c.judged_at > now() - make_interval(days => $3))::int as agreed,
       count(*) filter (where c.judged_at > now() - make_interval(days => $3))::int as checked,
       coalesce(floor(extract(epoch from now() - min(c.judged_at)) / 86400), 0)::int as days
     from ledger.relation_checks c
     where c.judge = $1 and c.other_key is not null and c.agreed is not null
       and (split_part(c.first_answer, ':', 1) = $2 or split_part(c.second_answer, ':', 1) = $2)`,
    [judge, kind, rules.orderAgreementDays],
  );
  // Over the window ending `daysAgo` days ago: the relations of this kind and judge in effect then
  // (their own check held, or the owner's on), how many the owner's later relation on the same pair
  // overturned (another kind) or the agents found wrong (AGENTS_OVERTURNED), and how many whose
  // winning claim a later code or owner relation stood against; and the owner's answers on the
  // kind's audit cards, and the owner's `wrong`s among them. A relation no check of its own ever
  // held applies nowhere, so it is no part of the kind's rate; one that took effect and a later
  // check then refused did apply, and stays in it, so that refusal can count against the kind
  // (AGENTS_OVERTURNED).
  type Rates = { applied: number; overturned: number; contradicted: number; answered: number; wrong: number };
  const rates = async (daysAgo: number): Promise<Rates> => {
    const [row] = await query<Rates & { agents: number }>(
      `with mine as (
         select r.id, r.judged_by, r.from_claim_key, r.to_claim_key, r.judged_at from knowledge.claim_relations r
         where r.kind = $1 and r.judged_by = $2
           and r.judged_at <= now() - make_interval(days => $3) and r.judged_at > now() - make_interval(days => $3 + $4)
           and (policy.relation_effective(r.id, r.judged_by, r.kind, r.judged_at, now() - make_interval(days => $3))
                or exists (select 1 from ledger.source_checks h
                           where h.target = 'relation' and h.relation_id = r.id and starts_with(h.judge, 'model:')
                             and split_part(h.judge, '@', 1) <> split_part(r.judged_by, '@', 1) and h.hot is null
                             and h.verdict = 'supported' and h.on_cited and h.live
                             and h.created_at <= now() - make_interval(days => $3)))),
       audits as (
         select count(*)::int as answered, count(*) filter (where s.verdict = 'wrong')::int as wrong from ledger.source_checks s
         where s.target = 'relation' and s.kind = $1 and s.relation_judge = $2 and starts_with(s.judge, 'owner:') and s.verdict in ('supported', 'wrong')
           and s.created_at <= now() - make_interval(days => $3) and s.created_at > now() - make_interval(days => $3 + $4)),
       marked as (
         select m.*, exists (
           select 1 from knowledge.claim_relations o where starts_with(o.judged_by, 'owner:') and o.kind <> $1 and o.judged_at > m.judged_at
             and ((o.from_claim_key = m.from_claim_key and o.to_claim_key = m.to_claim_key) or (o.from_claim_key = m.to_claim_key and o.to_claim_key = m.from_claim_key))) as by_owner,
           ${AGENTS_OVERTURNED("m")} as by_agents
         from mine m)
       select count(m.*)::int as applied,
         count(m.*) filter (where m.by_owner)::int as overturned,
         count(m.*) filter (where m.by_agents and not m.by_owner)::int as agents,
         count(m.*) filter (where exists (
           select 1 from knowledge.claim_relations o where (starts_with(o.judged_by, 'owner:') or starts_with(o.judged_by, 'rule:'))
             and o.kind in ('supersedes', 'prevails', 'contradicts') and o.judged_at > m.judged_at and o.to_claim_key = m.from_claim_key))::int as contradicted,
         a.answered, a.wrong
       from audits a left join marked m on true group by a.answered, a.wrong`,
      [kind, judge, daysAgo, rules.rateWindowDays],
    );
    if (row === undefined) return { applied: 0, overturned: 0, contradicted: 0, answered: 0, wrong: 0 };
    // The owner's overturns always count; the agents' only from the sample at which one overturn
    // alone no longer passes the bound, so a handful of reports never turns a kind off by itself.
    const { agents, ...rest } = row;
    const agentsCount = row.applied >= minimumCloses(rules.overturnRateMax) ? agents : 0;
    return { ...rest, overturned: row.overturned + agentsCount };
  };
  const checks = await relationCheckScore(query, kind, judge);
  const now = await rates(0);
  let quietDays = 0;
  if (offByBound) {
    for (let day = 0; day < rules.reenableDays; day += 1) {
      const one = day === 0 ? now : await rates(day);
      const ratio = (n: number, of: number): number => (of === 0 ? 0 : n / of);
      if (
        !quietDay(
          Math.max(ratio(one.overturned, one.applied), ratio(one.wrong, one.answered)),
          ratio(one.contradicted, one.applied),
          rules,
        )
      )
        break;
      quietDays += 1;
    }
  }
  return {
    evaluation: null,
    sourceCheck: checks.scored === 0 ? null : checks,
    audits: { wrong: now.wrong, answered: now.answered },
    agreement: { agreed: agreement?.agreed ?? 0, checked: agreement?.checked ?? 0, days: agreement?.days ?? 0 },
    overturns: { overturned: now.overturned, applied: now.applied },
    laterContradictions: { contradicted: now.contradicted, applied: now.applied },
    quietDays,
  };
}
