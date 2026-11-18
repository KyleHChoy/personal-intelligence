import {
  CANARY_CLIENT_PREFIX,
  CANARY_COMPARTMENT,
  type ClientName,
  type HypothesisId,
  OWNER_IDEAS_LISTED,
  type OwnerIdeas,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { stamp } from "../../core/db.ts";
import { openWith } from "../../core/row-opener.ts";
import { notCanaryClient } from "../../core/statements.ts";
import { evidenceOf, type IdeaRow } from "../../core/work-views.ts";
import { unrestrictedOf } from "../admin-time-base.ts";

// The owner's idea ledger, as pi_admin, over the key file's compartments but the restricted ones, as the
// owner's other reads are: the ideas the planner and the owner's agents filed, newest evidence first, at most
// OWNER_IDEAS_LISTED, each with its text opened under the admin's keys, who filed it by name (the planner as
// null), its state and its distinct cited items by kind and when first added; and how many ideas were filed
// since Monday (UTC). The standing check's rows are no part of it: neither an idea a canary client filed nor
// evidence under a canary compartment counts or moves an idea. Never an id in text.

// A label that holds none of the standing check's compartments, on a column of compartments.
const notCanaryLabel = (column: string): string =>
  `not exists (select 1 from unnest(${column}) as c (one) where c.one = '${CANARY_COMPARTMENT}' or starts_with(c.one, 'agent:${CANARY_CLIENT_PREFIX}'))`;

const SEEN = `
  seen as (
    select h.id, h.created_by, h.created_at, h.compartments, h.body_enc from ledger.hypotheses h
    where h.kind = 'idea' and h.tainted_at is null and h.compartments <@ $1::text[] and ${notCanaryLabel("h.compartments")}
      and coalesce((select ${notCanaryClient("k.name")} from policy.clients k where 'client:' || k.id = h.created_by), true)
  )`;
// Each cited item once, by its ref, when it was first added: two joins of one item under two labels
// are one item.
const EVIDENCE = `
  evidence as (
    select distinct on (b.row_id, b.ref_kind, b.ref_id) b.id, b.row_id, b.ref_kind, b.added_at from ledger.basis b
    where b.row_kind = 'hypothesis' and b.row_id in (select s.id from seen s) and b.tainted_at is null
      and b.compartments <@ $1::text[] and ${notCanaryLabel("b.compartments")}
    order by b.row_id, b.ref_kind, b.ref_id, b.added_at nulls last, b.id
  )`;
// The newest ideas first, cut before any body is read.
const IDEAS = `
  with ${SEEN}, ${EVIDENCE},
  listed as (
    select s.*, greatest(s.created_at, (select max(e.added_at) from evidence e where e.row_id = s.id)) as latest_at
    from seen s order by latest_at desc, s.id collate "C" desc limit ${OWNER_IDEAS_LISTED}
  )
  select l.id, l.created_at, l.latest_at, l.compartments, l.body_enc,
    (select k.name from policy.clients k where 'client:' || k.id = l.created_by) as by,
    coalesce((select r.event from ledger.record_events r where r.row_kind = 'hypothesis' and r.row_id = l.id order by r.id desc limit 1), 'open') as status,
    (select count(*)::int from evidence e where e.row_id = l.id) as cited,
    array(select e.ref_kind from evidence e where e.row_id = l.id order by e.added_at desc nulls last, e.id desc limit 20) as evidence_kinds,
    array(select e.added_at from evidence e where e.row_id = l.id order by e.added_at desc nulls last, e.id desc limit 20) as evidence_at
  from listed l
  order by l.latest_at desc, l.id collate "C" desc`;
const FILED_THIS_WEEK = `
  with ${SEEN}
  select count(*)::int as n from seen s where s.created_at >= date_trunc('week', $2::timestamptz at time zone 'UTC') at time zone 'UTC'`;

type Row = Omit<IdeaRow, "filed_by"> & { by: ClientName | null };

export function ideas(admin: AdminContext): Promise<OwnerIdeas> {
  const now = admin.now();
  const open = openWith(admin.keys);
  return admin.transaction(async (query) => {
    const within = unrestrictedOf(admin.keys);
    const rows = await query<Row>(IDEAS, [within]);
    const [week] = await query<{ n: number }>(FILED_THIS_WEEK, [within, stamp(now)]);
    return {
      at: stamp(now),
      filedThisWeek: week?.n ?? 0,
      ideas: rows.map((row) => ({
        id: row.id as HypothesisId,
        summary: open({ table: "ledger.hypotheses", id: row.id, column: "body_enc" }, row.compartments, row.body_enc),
        by: row.by,
        filedAt: stamp(row.created_at),
        latestAt: stamp(row.latest_at),
        status: row.status,
        evidence: evidenceOf(row),
        cited: row.cited,
      })),
    } as OwnerIdeas;
  });
}
