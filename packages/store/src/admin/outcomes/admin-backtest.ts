import { dayIn, type NextMove, type OpenItem, OWNER_OPEN_ITEMS_MOST } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { type OutcomeMetric, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { restricted } from "../../pipeline/code-relations.ts";
import type { Ctx } from "../../read/read-ctx.ts";
import { nextMovesOf } from "../../read/read-next.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { ownerCtx } from "../owner-ctx.ts";
import { ownerCommitments } from "../work/admin-commitments.ts";
import { ownerRead } from "../work/admin-open-items.ts";

// The meter of whether the system helps, needing nothing from the owner. The box records what `next` and the
// open items showed, by id, and code scores it a week later against what the owner did: of the replies sent,
// meetings held and deadlines met, the share surfaced beforehand; of what was surfaced, the share that went
// untouched. Ids, counts and codes only. It records what the read served, not that anyone looked at it, and
// it sees mail and the calendar alone.

const REPLY_LOOK_BACK_DAYS = 14;
// A week after: what is scored is at least this old, so what was surfaced has had its week.
export const SCORED_AFTER_DAYS = 7;
const WEEK = `interval '${SCORED_AFTER_DAYS} days'`;
const UNDERCOUNTS = ["chat", "phone", "in_person", "other_mail_accounts"] as const;

type Row = {
  surface: "next" | "open";
  sourceKind: string;
  key: string;
  refs: { message?: string; capture?: string; document?: string; record?: string; event?: string };
  bound: readonly string[];
};
type RecordSummary = { day: string; next: number; open: number; written: number; unreached: number };

// Where each id's item is, and its thread: an item that reaches no evidence is not written, since an
// erasure could never find it.
const WHERE = `
  select 'message' as kind, m.id, m.evidence_id, m.thread_fp from knowledge.messages m where m.id = any ($1::text[])
  union all select 'capture', c.id, c.evidence_id, null from knowledge.captures c where c.id = any ($2::text[])
  union all select 'document', d.id, d.evidence_id, null from knowledge.documents d where d.id = any ($3::text[])
  union all select 'record', w.id, w.evidence_id, null from ledger.agent_writes w where w.id = any ($4::text[])
  union all select 'event', v.id, v.evidence_id, null from knowledge.events v where v.id = any ($5::text[])`;

const rowOfItem = (surface: Row["surface"], item: OpenItem, bound: readonly string[]): Row => ({
  surface,
  sourceKind: item.source.kind,
  key: item.source.id as string,
  refs: {
    ...(item.source.message === undefined ? {} : { message: item.source.message as string }),
    ...(item.source.capture === undefined ? {} : { capture: item.source.capture as string }),
    ...(item.source.document === undefined ? {} : { document: item.source.document as string }),
    ...(item.source.record === undefined ? {} : { record: item.source.record as string }),
    ...(item.source.kind === "calendar" ? { event: item.source.id as string } : {}),
  },
  bound,
});

const rowOfMove = (move: NextMove, items: readonly OpenItem[], boundOf: (key: string) => readonly string[]): Row[] => {
  const key = move.source.id as string;
  if (move.source.kind === "goal") return [];
  if (move.source.kind === "message")
    return [{ surface: "next", sourceKind: "message", key, refs: { message: key }, bound: [] }];
  if (move.source.kind === "event")
    return [{ surface: "next", sourceKind: "event", key, refs: { event: key }, bound: [] }];
  const item = items.find((one) => (one.source.id as string) === key);
  return item === undefined ? [] : [rowOfItem("next", item, boundOf(key))];
};

// One pass: the owner's own read as it stands now, one row per surface and item for the owner's day. Already seen
// today keeps the first time it was. A restricted item is never written.
export async function recordSurfaced(admin: AdminContext): Promise<RecordSummary> {
  const now = admin.now();
  const open = await ownerRead(admin);
  return admin.transaction(async (query) => {
    // The reply and meeting statements leave the caller's token to choose their rows, and pi_admin's returns
    // everything: a row with a label the report may not count is dropped here. A scan's limit is taken
    // before this, so on a box with restricted mail its 12 newest could be fewer.
    const within = unrestrictedOf(admin.keys);
    const ctx: Ctx = {
      ...ownerCtx(query, admin.keys, admin.log),
      run: async <Row>(text: string, values?: unknown[]) =>
        (await query<Row>(text, values)).filter((row) => {
          const { compartments } = row as { compartments?: string[] };
          return compartments === undefined || compartments.every((one) => within.includes(one));
        }),
    };
    const zone = await ownerZoneOf(query);
    const next = await nextMovesOf(ctx, now, {
      mail: true,
      bodies: true,
      tasks: true,
      open,
      findings: [],
      zone,
      marks: false,
    });
    const boundOf = (key: string): readonly string[] => open.rests.get(key)?.bound ?? [];
    const rows = [
      ...next.value.moves.flatMap((move) => rowOfMove(move, open.items, boundOf)),
      ...open.items.slice(0, OWNER_OPEN_ITEMS_MOST).map((item) => rowOfItem("open", item, boundOf(item.source.id))),
    ];
    const ids = (field: keyof Row["refs"]): string[] => [
      ...new Set(rows.flatMap((row) => (row.refs[field] === undefined ? [] : [row.refs[field] as string]))),
    ];
    const found = await query<{ kind: string; id: string; evidence_id: string | null; thread_fp: string | null }>(
      WHERE,
      [ids("message"), ids("capture"), ids("document"), ids("record"), ids("event")],
    );
    const at = new Map(found.map((row) => [`${row.kind}\n${row.id}`, row]));
    const day = dayIn(now, zone);
    const bound = rows.flatMap((row) => row.bound);
    const labels = new Map(
      (
        await query<{ id: string; compartments: string[] }>(
          "select id, compartments from vault.evidence_items where id = any ($1::text[])",
          [[...new Set([...found.flatMap((one) => one.evidence_id ?? []), ...bound])]],
        )
      ).map((row) => [row.id, row.compartments]),
    );
    let written = 0;
    let unreached = 0;
    for (const row of rows) {
      const places = Object.entries(row.refs).flatMap(([kind, id]) => at.get(`${kind}\n${id}`) ?? []);
      const evidence = [...new Set([...places.flatMap((one) => one.evidence_id ?? []), ...row.bound])].sort();
      const compartments = [...new Set(evidence.flatMap((id) => labels.get(id) ?? []))].sort();
      if (compartments.length === 0) {
        unreached += 1;
        continue;
      }
      if (restricted(compartments)) continue;
      const done = await query<{ day: string }>(
        `insert into ledger.surfaced_items (day, surface, source_kind, item_key, thread_fp, evidence_ids, first_at, compartments)
         values ($1, $2, $3, $4, $5, $6::text[], $7, $8::text[])
         on conflict (day, surface, item_key) do nothing returning day::text`,
        [
          day,
          row.surface,
          row.sourceKind,
          row.key,
          places.find((one) => one.thread_fp !== null)?.thread_fp ?? null,
          evidence.slice(0, 20),
          stamp(now),
          compartments,
        ],
      );
      written += done.length;
    }
    return {
      day,
      next: rows.filter((row) => row.surface === "next").length,
      open: rows.filter((row) => row.surface === "open").length,
      written,
      unreached,
    };
  });
}

// A reply: an outbound message on a thread a person wrote in before it. Surfaced: the thread was shown
// in the fortnight before.
const REPLIES = `
  select count(*)::int as sample, count(*) filter (where exists (
      select 1 from ledger.surfaced_items s
      where s.thread_fp = o.thread_fp and s.first_at < o.sent_at and s.first_at >= o.sent_at - interval '${REPLY_LOOK_BACK_DAYS} days'
        and s.compartments <@ $3::text[]))::int as hits
  from knowledge.messages o
  where o.direction = 'outbound' and not o.held and o.thread_fp is not null and o.compartments <@ $3::text[]
    and o.sent_at >= $1 and o.sent_at < $2
    and exists (select 1 from knowledge.messages i where i.thread_fp = o.thread_fp and i.direction = 'inbound' and not i.bulk and not i.held
                and i.sent_at < o.sent_at and i.compartments <@ $3::text[])`;

// A meeting held, as far as the calendar says: timed, a person on it, not cancelled or declined.
const MEETINGS = `
  select coalesce(d.recurring, false) as recurring, count(*)::int as sample, count(*) filter (where exists (
      select 1 from ledger.surfaced_items s where s.item_key = v.id and s.first_at < d.starts_at and s.compartments <@ $3::text[]))::int as hits
  from knowledge.events v join knowledge.event_details d on d.event_id = v.id
  where not d.cancelled and not d.all_day and coalesce(d.owner_response, 'accepted') <> 'declined'
    and d.starts_at >= $1 and d.starts_at < $2 and d.compartments <@ $3::text[]
    and exists (select 1 from knowledge.event_participants p join knowledge.entities e on e.id = p.entity_id and e.kind = 'person' where p.event_id = v.id and p.compartments <@ $3::text[])
  group by 1`;

// A close the owner took back is no close.
const STANDS = (close: string, key: string): string => `not exists (select 1 from knowledge.owner_decisions r
    where r.kind in ('commitment_reopen', 'open_item_reopen') and r.tainted_at is null and (r.decided_at, r.id) > (${close}.decided_at, ${close}.id)
      and coalesce(r.details ->> 'key', r.details ->> 'factKey') = ${key})`;
const OPEN_ITEM_DONE = `
  select d.details ->> 'key' as key, d.decided_at as at, d.details ->> 'due' as due from knowledge.owner_decisions d
  where d.kind = 'open_item_close' and d.answer = 'done' and d.tainted_at is null
    and d.decided_at >= $1 and d.decided_at < $2 and d.compartments <@ $3::text[]
    and ${STANDS("d", "(d.details ->> 'key')")}`;

const FIRST_SEEN = `
  select s.item_key, min(s.first_at) as first_at from ledger.surfaced_items s
  where s.item_key = any ($1::text[]) and s.compartments <@ $2::text[] group by 1`;

// What was first surfaced in the window, each once, and whether the owner did anything of it within a
// week: mailed on its thread, closed it, or, for a meeting, it came and was not declined.
const SURFACED = `
  with first as (
    select s.item_key, min(s.source_kind) as source_kind, max(s.thread_fp) as thread_fp, min(s.first_at) as first_at
    from ledger.surfaced_items s where s.compartments <@ $3::text[] and s.source_kind <> 'goal' group by 1
  )
  select f.item_key, f.source_kind, f.first_at, (
      exists (select 1 from knowledge.messages o where o.thread_fp = f.thread_fp and o.direction = 'outbound' and not o.held and o.compartments <@ $3::text[]
              and o.sent_at > f.first_at and o.sent_at <= f.first_at + ${WEEK})
      or exists (select 1 from knowledge.owner_decisions d
                 where d.kind in ('commitment_close', 'open_item_close') and d.tainted_at is null and d.compartments <@ $3::text[]
                   and coalesce(d.details ->> 'key', d.details ->> 'factKey') = f.item_key and ${STANDS("d", "f.item_key")}
                   and d.decided_at > f.first_at and d.decided_at <= f.first_at + ${WEEK})
      or exists (select 1 from knowledge.event_details e where e.event_id = f.item_key and not e.cancelled and e.compartments <@ $3::text[]
                 and e.starts_at <= f.first_at + ${WEEK})
    ) as touched
  from first f where f.first_at >= $1 and f.first_at < $2
    -- A meeting the owner declined was never theirs to act on, as MEETINGS has it.
    and not exists (select 1 from knowledge.event_details e where e.event_id = f.item_key and e.owner_response = 'declined')`;

export type BacktestMeter = {
  surfaced: OutcomeMetric;
  untouched: OutcomeMetric;
  // What the meter cannot see, so a low share is read for what it is.
  undercounts: readonly string[];
};

type ClosedCommitment = { key: string; at: number; done: boolean; late: boolean; dated: boolean };

async function closedCommitments(
  admin: AdminContext,
  zone: string | null,
  within: readonly string[],
): Promise<ClosedCommitment[] | null> {
  try {
    const { commitments } = await ownerCommitments(admin, { state: "closed" }, { whole: true, within: [...within] });
    return commitments.flatMap(({ item }) => {
      const stamped = item.closedAt ?? item.doneAt ?? null;
      if (stamped === null || stamped === undefined) return [];
      const at = Date.parse(stamped);
      const done = item.ending === "done" || ((item.ending ?? null) === null && (item.doneAt ?? null) !== null);
      const due = item.due ?? null;
      return [
        {
          key: item.belief.fact as string,
          at,
          done,
          dated: due !== null,
          late: due !== null && dayIn(new Date(at), zone) > (due.length === 10 ? due : dayIn(new Date(due), zone)),
        },
      ];
    });
  } catch (error) {
    if (error instanceof AdminError && error.code === "rebuilding") return null;
    throw error;
  }
}

const seenBefore = async (query: Query, acts: readonly { key: string; at: number }[], within: readonly string[]) => {
  const rows = await query<{ item_key: string; first_at: Date }>(FIRST_SEEN, [
    [...new Set(acts.map((one) => one.key))],
    within,
  ]);
  const first = new Map(rows.map((row) => [row.item_key, row.first_at.getTime()]));
  return acts.filter((one) => (first.get(one.key) ?? Number.POSITIVE_INFINITY) < one.at).length;
};

export async function backtestMeter(
  admin: AdminContext,
  days: number,
  within: readonly string[],
): Promise<BacktestMeter> {
  const now = admin.now().getTime();
  const window = { fromDaysAgo: days + SCORED_AFTER_DAYS, toDaysAgo: SCORED_AFTER_DAYS };
  const to = stamp(new Date(now - SCORED_AFTER_DAYS * DAY_MS));
  const windowFrom = now - (days + SCORED_AFTER_DAYS) * DAY_MS;
  const none = (code: string): BacktestMeter => ({
    surfaced: outcomeMetric("backtest_surfaced_share", { value: null, sample: 0, window, code }),
    untouched: outcomeMetric("backtest_untouched_share", { value: null, sample: 0, window, code }),
    undercounts: UNDERCOUNTS,
  });
  const [start] = await admin.transaction((query) =>
    query<{ at: Date | null }>(
      "select min(first_at) as at from ledger.surfaced_items where compartments <@ $1::text[]",
      [within],
    ),
  );
  if (start?.at === null || start?.at === undefined) return none("not_recorded_yet");
  // An act before the first record could not have been surfaced by any record: it says nothing.
  const from = stamp(new Date(Math.max(windowFrom, start.at.getTime())));
  const zone = await admin.transaction(ownerZoneOf);
  // A rebuild costs the commitments alone, and says so in `parts`.
  const read = await closedCommitments(admin, zone, within);
  const closed = read ?? [];
  return admin.transaction(async (query) => {
    const [replies] = await query<{ sample: number; hits: number }>(REPLIES, [from, to, within]);
    const meetings = await query<{ recurring: boolean; sample: number; hits: number }>(MEETINGS, [from, to, within]);
    const items = await query<{ key: string; at: Date; due: string | null }>(OPEN_ITEM_DONE, [from, to, within]);
    const met = [
      ...closed.filter((one) => one.done && one.at >= Date.parse(from) && one.at < Date.parse(to)),
      ...items.map((row) => ({
        key: row.key,
        at: row.at.getTime(),
        dated: row.due !== null,
        late:
          row.due !== null && dayIn(row.at, zone) > (row.due.length === 10 ? row.due : dayIn(new Date(row.due), zone)),
      })),
    ];
    const metSurfaced = await seenBefore(query, met, within);
    const count = (recurring: boolean, field: "sample" | "hits"): number =>
      meetings.find((one) => one.recurring === recurring)?.[field] ?? 0;
    const sample = (replies?.sample ?? 0) + count(true, "sample") + count(false, "sample") + met.length;
    const hits = (replies?.hits ?? 0) + count(true, "hits") + count(false, "hits") + metSurfaced;

    const surfaced = await query<{ item_key: string; source_kind: string; first_at: Date; touched: boolean }>(
      SURFACED,
      [from, to, within],
    );
    const closedAt = new Map(closed.map((one) => [one.key, one.at]));
    const parts: Record<string, number> = {};
    let untouched = 0;
    for (const row of surfaced) {
      const end = closedAt.get(row.item_key);
      const first = row.first_at.getTime();
      const gone = row.touched || (end !== undefined && end > first && end <= first + SCORED_AFTER_DAYS * DAY_MS);
      parts[row.source_kind] = (parts[row.source_kind] ?? 0) + 1;
      if (!gone) {
        untouched += 1;
        parts[`${row.source_kind}_untouched`] = (parts[`${row.source_kind}_untouched`] ?? 0) + 1;
      }
    }
    return {
      surfaced: outcomeMetric("backtest_surfaced_share", {
        value: shareOf(hits, sample),
        sample,
        window,
        parts: {
          replies_sent: replies?.sample ?? 0,
          replies_surfaced: replies?.hits ?? 0,
          meetings_held: count(false, "sample"),
          meetings_surfaced: count(false, "hits"),
          slots_held: count(true, "sample"),
          slots_surfaced: count(true, "hits"),
          deadlines_met: met.length,
          deadlines_surfaced: metSurfaced,
          deadlines_dated: met.filter((one) => one.dated).length,
          deadlines_late: met.filter((one) => one.late).length,
          ...(read === null ? { commitments_unread: 1 } : {}),
        },
      }),
      untouched: outcomeMetric("backtest_untouched_share", {
        value: shareOf(untouched, surfaced.length),
        sample: surfaced.length,
        window,
        parts,
      }),
      undercounts: UNDERCOUNTS,
    };
  });
}

// What the recall audit found, by filter: of the rows the model answered, the share it found the filter
// lost, with its Wilson bounds, and how many lines the filter had dropped at the last check. A row with
// no verdict is counted, not scored: a model that could not ground its answer found nothing.
export type RecallLine = {
  filter: string;
  checks: number;
  scored: number;
  missed: number;
  noVerdict: number;
  missRate: number | null;
  low: number | null;
  high: number | null;
  population: number;
  lastAt: string;
};
const RECALL = `
  select r.filter, count(*)::int as checks, count(*) filter (where r.verdict is not null)::int as scored,
    count(*) filter (where r.verdict = 'missed')::int as missed,
    (array_agg(r.population order by r.id desc))[1] as population, max(r.created_at) as last_at
  from ledger.recall_checks r where r.compartments <@ $1::text[] group by 1 order by 1`;

const wilson = (hits: number, n: number): { low: number; high: number } => {
  const z = 1.96;
  const p = hits / n;
  const middle = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const under = 1 + (z * z) / n;
  return { low: (middle - spread) / under, high: (middle + spread) / under };
};
const round = (value: number): number => Math.round(value * 1000) / 1000;

export async function recallReport(query: Query, within: readonly string[]): Promise<RecallLine[]> {
  const rows = await query<{
    filter: string;
    checks: number;
    scored: number;
    missed: number;
    population: number;
    last_at: Date;
  }>(RECALL, [within]);
  return rows.map((row) => {
    const bounds = row.scored === 0 ? null : wilson(row.missed, row.scored);
    return {
      filter: row.filter,
      checks: row.checks,
      scored: row.scored,
      missed: row.missed,
      noVerdict: row.checks - row.scored,
      missRate: row.scored === 0 ? null : round(row.missed / row.scored),
      low: bounds === null ? null : round(bounds.low),
      high: bounds === null ? null : round(bounds.high),
      population: row.population,
      lastAt: stamp(row.last_at),
    };
  });
}
