import { REASK_WINDOW, reaskStopped } from "@intelligence/personal-core/planner";
import type { Query } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { openStatus } from "../../core/status-facts.ts";

// `pi outcomes`'s refusals: what extraction proposed and its checks refused, by type, field and
// reason, and by the week its item came in. Codes and counts only: a row holds nothing else, and the
// status row is opened for its two counts. Only rows within the key file's compartments but the
// restricted ones are counted, as every outcome is. A row filed before fields were kept has none: it
// reads `field: null`, `issue: null`, until it is replayed.

type RefusalKey = { source: string; type: string; reason: string; field: string | null; issue: string | null };
type RefusalCount = RefusalKey & { count: number };
export type RefusalsView = {
  // Every refused candidate that stands, by what was refused.
  total: number;
  all: RefusalCount[];
  // Within `--days`, by the Monday of the week the item came in; `claims` are what models' claims
  // stood from the same items, so the two say a share.
  weeks: { week: string; claims: number; refused: number; rows: RefusalCount[] }[];
  // Of the items committed within `--days`: the claims kept by repair, the items re-asked and, of
  // those, the ones that hold a claim (a re-ask is only asked of an item with none, so each was
  // rescued by it); and the re-asks' calls and spend, from their usage rows.
  repaired: number;
  reasked: number;
  rescued: number;
  reask: {
    calls: number;
    microUsd: number;
    // By the refusal code a re-ask named, of the items committed within `--days`: how many were
    // asked and how many left their item a claim. Counted from the commits made since the measure
    // was kept; an item committed before it shows only in `reasked` and `rescued` above.
    reasons: { reason: string; asked: number; rescued: number }[];
    // The codes no longer re-asked, each under the newest wording of its prompt: its last full
    // window of re-asks rescued nothing. It lifts when the wording changes.
    stopped: { reason: string; wording: string; code: "no_rescue"; window: number }[];
  };
};

// A claim a model proposed: from an item through the pipeline with a saved call, and no type code
// makes at every commit. A contact import's, an owner's word and a goal's are no sign a candidate
// passed the checks.
const MODEL_CLAIM = `c.type !~ '^(capture|activity)\\.'
    and exists (select 1 from vault.pipeline_items p where p.evidence_id = c.evidence_id)
    and (exists (select 1 from vault.model_calls m where m.evidence_id = c.evidence_id)
      or exists (select 1 from vault.model_call_members m where m.evidence_id = c.evidence_id))`;
const WEEK = "to_char(date_trunc('week', e.ingested_at at time zone 'UTC'), 'YYYY-MM-DD')";

const REFUSED = `
  select u.id, u.compartments, u.facts_enc, e.source_kind, e.ingested_at >= $2 as recent, ${WEEK} as week
  from vault.unmapped_claims u join vault.evidence_items e on e.id = u.evidence_id
  where u.compartments <@ $1::text[]`;
const CLAIMS = `
  select ${WEEK} as week, count(*)::int as n
  from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  where c.compartments <@ $1::text[] and e.ingested_at >= $2 and ${MODEL_CLAIM}
  group by 1`;
const COMMITTED = `
  select evidence_id, compartments, facts_enc from vault.pipeline_items
  where compartments <@ $1::text[] and updated_at >= $2`;
const REASK_USAGE = `
  select count(*)::int as calls, coalesce(sum(cost_microusd), 0)::bigint::text as spent from vault.model_usage
  where prompt_id like '%\\_reask' and outcome <> 'check' and day >= $1::date and compartments <@ $2::text[]`;

const REASK_REASONS = `
  select c.code as reason, count(*)::int as asked, (count(*) filter (where p.reask_rescued))::int as rescued
  from vault.pipeline_items p cross join lateral unnest(p.reask_codes) as c (code)
  where p.compartments <@ $1::text[] and p.updated_at >= $2
  group by c.code order by asked desc, c.code`;
// Each wording's latest window of re-asks by code, as the run's stop rule reads it, and when the
// wording was last used.
const REASK_WINDOWS = `
  select wording, code, count(*)::int as asked, (count(*) filter (where rescued))::int as rescued, max(last) as last from (
    select p.reask_wording as wording, c.code, p.reask_rescued as rescued,
      max(p.updated_at) over (partition by p.reask_wording) as last,
      row_number() over (partition by p.reask_wording, c.code order by p.updated_at desc, p.evidence_id collate "C") as n
    from vault.pipeline_items p cross join lateral unnest(p.reask_codes) as c (code)
    where p.compartments <@ $1::text[]) w
  where n <= $2 group by wording, code order by wording, code`;

type ReaskWindow = { wording: string; code: string; asked: number; rescued: number; last: Date };

// The stops in force: of each prompt's wordings only the one used last counts, since an older
// wording's window is no longer read.
export function reaskStops(windows: readonly ReaskWindow[]): RefusalsView["reask"]["stopped"] {
  const promptOf = (wording: string): string => wording.slice(0, wording.indexOf("@"));
  const newest = new Map<string, ReaskWindow>();
  for (const one of windows) {
    const seen = newest.get(promptOf(one.wording));
    if (seen === undefined || one.last.getTime() > seen.last.getTime()) newest.set(promptOf(one.wording), one);
  }
  return windows
    .filter((one) => newest.get(promptOf(one.wording))?.wording === one.wording && reaskStopped(one))
    .map((one) => ({ reason: one.code, wording: one.wording, code: "no_rescue" as const, window: REASK_WINDOW }));
}

const counted = (keys: readonly RefusalKey[]): RefusalCount[] => {
  const counts = new Map<string, RefusalCount>();
  for (const key of keys) {
    const at = JSON.stringify([key.source, key.type, key.reason, key.field, key.issue]);
    const seen = counts.get(at);
    counts.set(at, { ...key, count: (seen?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
};

export async function refusals(
  query: Query,
  keys: Keys,
  { within, since }: { within: string[]; since: string },
): Promise<RefusalsView> {
  const rows = await query<{
    id: string;
    compartments: string[];
    facts_enc: Sealed;
    source_kind: string;
    recent: boolean;
    week: string;
  }>(REFUSED, [within, since]);
  const read = rows.map((row) => {
    const facts = JSON.parse(open(keys, row, "vault.unmapped_claims.facts_enc", "throw")) as {
      proposedType: string;
      reason: string;
      field?: string;
      issue?: string;
    };
    const key: RefusalKey = {
      source: row.source_kind,
      type: facts.proposedType,
      reason: facts.reason,
      field: facts.field ?? null,
      issue: facts.issue ?? null,
    };
    return { key, recent: row.recent, week: row.week };
  });
  const claimsOf = new Map(
    (await query<{ week: string; n: number }>(CLAIMS, [within, since])).map((row) => [row.week, row.n]),
  );
  const recent = read.filter((one) => one.recent);
  const weeks = [...new Set([...claimsOf.keys(), ...recent.map((one) => one.week)])].sort().map((week) => {
    const of = recent.filter((one) => one.week === week);
    return { week, claims: claimsOf.get(week) ?? 0, refused: of.length, rows: counted(of.map((one) => one.key)) };
  });
  let repaired = 0;
  let reasked = 0;
  let rescued = 0;
  const committed = await query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed }>(COMMITTED, [
    within,
    since,
  ]);
  for (const row of committed) {
    const status = openStatus({ query, keys }, row.compartments, row.evidence_id, row.facts_enc);
    repaired += status.repaired ?? 0;
    reasked += status.reasked === true ? 1 : 0;
    rescued += status.reasked === true && status.claims > 0 ? 1 : 0;
  }
  const reasons = await query<{ reason: string; asked: number; rescued: number }>(REASK_REASONS, [within, since]);
  const windows = await query<ReaskWindow>(REASK_WINDOWS, [within, REASK_WINDOW]);
  const [usage] = await query<{ calls: number; spent: string }>(REASK_USAGE, [since.slice(0, 10), within]);
  return {
    total: read.length,
    all: counted(read.map((one) => one.key)),
    weeks,
    repaired,
    reasked,
    rescued,
    reask: { calls: usage?.calls ?? 0, microUsd: Number(usage?.spent ?? 0), reasons, stopped: reaskStops(windows) },
  };
}
