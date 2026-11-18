import { type Query, stamp } from "../../core/db.ts";

// Ground truth from work already done, for `pia work report`, as pi_admin. Four sources label an
// outcome of a work that expects one:
//
// - an agent's done report whose basis cites an item first stored after the work began (`met`);
// - the owner's decision on an outcome card about the work or its move (`acknowledge` is `met`,
//   `dismiss` is `not_met`);
// - a commitment an agent closed for the work, citing an item (`met`);
// - every rule-judged link, which is its own label.
//
// A label the system had linked (an untainted outcome link of the work, not a copy, naming the
// cited item, or for the owner's decision of the same kind) is a hit; one it had not is a miss,
// counted by path and kind: the path the link took, or for a miss `watched` when the work watches
// the item's thread (any watch, for a label with no item) and `open` otherwise. The window is the
// label's time. Ids never leave this file: counts and codes only.

const OUTCOME_LABEL_SOURCES = ["agent_report", "owner_card", "commitment_close", "rule"] as const;
type OutcomeLabelSource = (typeof OUTCOME_LABEL_SOURCES)[number];
export type OutcomeTruth = {
  labels: Record<OutcomeLabelSource, { labelled: number; linked: number }>;
  misses: Record<string, number>;
  // The links written in the window, by `<path>_<kind>_<judge>_<applied|recorded>`, the judge as
  // its class (`rule`, `model`, `agent`, `owner`).
  links: Record<string, number>;
};

type Label = { path: string; kind: string; linked: boolean };

// A link that counts for a label: untainted, not a copy, of the same work.
const LINK = "l.opportunity_id = w.work and l.move_result_link_id is null and l.tainted_at is null";
// The path of a label on an item: the link's, else watched when the work watches the item's thread.
const ITEM_PATH = `coalesce(
  (select l.path from ledger.outcome_links l where ${LINK} and l.evidence_id = w.evidence_id order by l.id desc limit 1),
  case when exists (select 1 from ledger.work_watches x join vault.evidence_items e on e.id = w.evidence_id
                    where x.opportunity_id = w.work and x.kind = 'thread' and x.account_id = e.source_account_id and x.watch_key = e.thread_fp)
       then 'watched' else 'open' end)`;
const EXPECTS = "exists (select 1 from ledger.expected_outcomes x where x.opportunity_id = w.work)";

const AGENT_REPORTS = `
  select ${ITEM_PATH} as path, 'met' as kind,
    exists (select 1 from ledger.outcome_links l where ${LINK} and l.evidence_id = w.evidence_id) as linked
  from (
    select distinct v.opportunity_id as work, b.evidence_id
    from ledger.record_events r
    join ledger.moves v on v.id = r.row_id
    join ledger.opportunities o on o.id = v.opportunity_id and o.tainted_at is null
    join ledger.basis b on b.row_kind = 'move' and b.row_id = v.id and b.evidence_id is not null and b.tainted_at is null
    join vault.evidence_items e on e.id = b.evidence_id
    where r.row_kind = 'move' and r.event = 'done' and r.by like 'client:%' and r.at >= $1 and e.observed_at > o.created_at
  ) w
  where ${EXPECTS}`;

const OWNER_CARDS = `
  select coalesce(
      (select l.path from ledger.outcome_links l where ${LINK} and l.kind = w.kind order by l.id desc limit 1),
      case when exists (select 1 from ledger.work_watches x where x.opportunity_id = w.work) then 'watched' else 'open' end) as path,
    w.kind,
    exists (select 1 from ledger.outcome_links l where ${LINK} and l.kind = w.kind) as linked
  from (
    select distinct on (c.id) coalesce(v.opportunity_id, o.id) as work, case d.answer when 'acknowledge' then 'met' else 'not_met' end as kind
    from knowledge.owner_decisions d
    join ledger.cards c on c.id = d.card_id and c.kind = 'outcome' and c.tainted_at is null
    left join ledger.opportunities o on c.target_kind = 'opportunity' and o.id = c.target_id
    left join ledger.moves v on c.target_kind = 'move' and v.id = c.target_id
    where d.kind = 'answer' and d.answer in ('acknowledge', 'dismiss') and d.tainted_at is null and d.decided_at >= $1
    order by c.id, d.decided_at desc, d.id desc
  ) w
  join ledger.opportunities o on o.id = w.work and o.tainted_at is null
  where ${EXPECTS}`;

const COMMITMENT_CLOSES = `
  select ${ITEM_PATH} as path, 'met' as kind,
    exists (select 1 from ledger.outcome_links l where ${LINK} and l.evidence_id = w.evidence_id) as linked
  from (
    select distinct a.opportunity_id as work, a.evidence_id
    from ledger.agent_writes a join ledger.opportunities o on o.id = a.opportunity_id and o.tainted_at is null
    where a.kind = 'close' and a.evidence_id is not null and a.body_enc is not null and a.created_at >= $1
  ) w
  where ${EXPECTS}`;

const RULES = `
  select l.path, l.kind, true as linked from ledger.outcome_links l
  where l.judge = 'rule' and l.move_result_link_id is null and l.tainted_at is null and l.opportunity_id is not null and l.judged_at >= $1`;

const LINKS = `
  select l.path, l.kind, split_part(l.judge, ':', 1) as judge, l.applied, count(*)::int as n from ledger.outcome_links l
  where l.move_result_link_id is null and l.judged_at >= $1
  group by 1, 2, 3, 4 order by 1, 2, 3, 4`;

export async function outcomeTruth(query: Query, since: Date): Promise<OutcomeTruth> {
  const at = [stamp(since)];
  const sources: Record<OutcomeLabelSource, string> = {
    agent_report: AGENT_REPORTS,
    owner_card: OWNER_CARDS,
    commitment_close: COMMITMENT_CLOSES,
    rule: RULES,
  };
  const truth: OutcomeTruth = {
    labels: {
      agent_report: { labelled: 0, linked: 0 },
      owner_card: { labelled: 0, linked: 0 },
      commitment_close: { labelled: 0, linked: 0 },
      rule: { labelled: 0, linked: 0 },
    },
    misses: {},
    links: {},
  };
  for (const source of OUTCOME_LABEL_SOURCES) {
    for (const label of await query<Label>(sources[source], at)) {
      truth.labels[source].labelled += 1;
      if (label.linked) truth.labels[source].linked += 1;
      else truth.misses[`${label.path}_${label.kind}`] = (truth.misses[`${label.path}_${label.kind}`] ?? 0) + 1;
    }
  }
  for (const row of await query<{ path: string; kind: string; judge: string; applied: boolean; n: number }>(
    LINKS,
    at,
  )) {
    truth.links[`${row.path}_${row.kind}_${row.judge}_${row.applied ? "applied" : "recorded"}`] = row.n;
  }
  return truth;
}
