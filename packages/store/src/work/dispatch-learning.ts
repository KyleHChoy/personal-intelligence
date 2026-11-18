import { type Query, stamp } from "../core/db.ts";

// The tick's two outcome calls: one function call each, ledger.match_outcomes and
// ledger.assess_outcomes, which write the links and the assessments and answer how many rows they
// wrote. Nothing here names a learning table.

const call = async (
  query: Query,
  fn: "ledger.match_outcomes" | "ledger.assess_outcomes",
  now: Date,
): Promise<number> => {
  const [row] = await query<{ written: number }>(`select ${fn}($1) as written`, [stamp(now)]);
  return row?.written ?? 0;
};

export const matchOutcomes = (query: Query, now: Date): Promise<number> => call(query, "ledger.match_outcomes", now);

// Every send of a draft that names an opportunity is
// watched on its thread (the send's, else its draft's, as ledger.match_outcomes reads it), once a
// send, labelled with the send's, the draft's and the opportunity's labels together. A work row,
// not a learning row. pi_work inserts and never reads the table, so the statement returns nothing.
export const WATCH_SENDS = `
  insert into ledger.work_watches (opportunity_id, created_by, kind, watch_key, account_id, send_id, compartments)
  select d.opportunity_id, 'system:tick', 'thread', coalesce(s.thread_fp, d.thread_fp), s.source_account_id, s.id, ledger.label(s.compartments || d.compartments || o.compartments)
  from ledger.sent_messages s
  join ledger.drafts d on d.id = s.draft_id
  join ledger.opportunities o on o.id = d.opportunity_id
  where coalesce(s.thread_fp, d.thread_fp) is not null and s.tainted_at is null and d.tainted_at is null and o.tainted_at is null
    and exists (select 1 from ledger.record_events r where r.row_kind = 'send' and r.row_id = s.id and r.event = 'sent')
  on conflict do nothing`;
export const watchSends = async (query: Query): Promise<void> => {
  await query(WATCH_SENDS);
};

// The learning item's first step, each send's thread watched first in the same transaction, so a
// reply on it can match.
export async function matchSentOutcomes(query: Query, now: Date): Promise<number> {
  await watchSends(query);
  return matchOutcomes(query, now);
}

export const assessOutcomes = (query: Query, now: Date): Promise<number> => call(query, "ledger.assess_outcomes", now);
