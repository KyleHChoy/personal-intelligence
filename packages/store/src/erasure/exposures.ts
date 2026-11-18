import { type ErasureId, ExposureListView, ExposureStatusView } from "@intelligence/contracts/personal";
import type { AdminContext } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import type { Query } from "../core/db.ts";

// The vendor exposure record. The table, the definer
// function and the read log's trigger are in the exposure migration; the erasure's links are the
// hook `vendor_exposures` in erasure-hooks.ts. Ids, days and counts only.

// Answers the rows written.
export async function noteModelExposure(
  query: Query,
  modelId: string,
  promptId: string,
  evidenceIds: string[],
): Promise<number> {
  const [row] = await query<{ n: number }>("select ledger.note_model_exposure($1, $2, $3::text[]) as n", [
    modelId,
    promptId,
    evidenceIds,
  ]);
  return row?.n ?? 0;
}

// Each recipient of the erasure's links, by route, retention and, for a memory exposure (the memory
// adapter's record, under the route `sync_memory`), its removal state; and each Lens mirror client
// the erasure reached, under `sync_mirror`: its first and last UTC day and the number of distinct
// ids. An id that is no erasure is not_found.
const LISTED = `
  select kind, id, route, min(first_day)::text as first_day, max(last_day)::text as last_day, count(distinct ref)::int as ids, retention, removal
  from (
    select x.recipient_kind as kind, x.recipient as id, x.route, x.day as first_day, x.day as last_day, x.ref_kind || ' ' || x.ref as ref, x.retention, null::text as removal
    from ledger.erasure_exposures l join ledger.exposures x on x.id = l.exposure_id
    where l.erasure_id = $1
    union all
    select 'client', m.client_id, 'sync_memory', (m.first_served_at at time zone 'utc')::date, (m.recorded_at at time zone 'utc')::date, m.projection_id, m.retention, m.removal
    from ledger.erasure_exposures l join ledger.memory_exposures m on m.id = l.memory_exposure_id
    where l.erasure_id = $1
    union all
    select 'client', e.client_id, 'sync_mirror', (e.first_served_at at time zone 'utc')::date, (e.last_sent_at at time zone 'utc')::date, e.id, c.vendor_retention, null::text
    from ledger.erasure_exposures l join ledger.mirror_entries e on e.id = l.mirror_entry_id join policy.clients c on c.id = e.client_id
    where l.erasure_id = $1
  ) r
  group by kind, id, route, retention, removal
  order by kind collate "C", id collate "C", route collate "C", retention collate "C", removal collate "C"`;

type Listed = {
  kind: "model" | "client";
  id: string;
  route: string;
  first_day: string;
  last_day: string;
  ids: number;
  retention: string;
  removal: string | null;
};

export async function listExposures(admin: AdminContext, erasure: ErasureId): Promise<ExposureListView> {
  const rows = await admin.transaction(async (query) => {
    if ((await query("select 1 from knowledge.erasures where id = $1", [erasure])).length === 0)
      throw new AdminError("not_found");
    return query<Listed>(LISTED, [erasure]);
  });
  return ExposureListView.parse({
    erasure,
    recipients: rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      route: row.route,
      firstDay: row.first_day,
      lastDay: row.last_day,
      ids: row.ids,
      retention: row.retention,
      removal: row.removal,
    })),
  });
}

const DAYS = 30;

export async function exposureStatus(admin: AdminContext): Promise<ExposureStatusView> {
  const { since, rows } = await admin.transaction(async (query) => {
    const [day] = await query<{ since: string }>(
      `select ((now() at time zone 'utc')::date - ${DAYS - 1})::text as since`,
    );
    const since = day?.since ?? "";
    const rows = await query<{ kind: "model" | "client"; id: string; ids: number }>(
      `select recipient_kind as kind, recipient as id, count(distinct (ref_kind, ref))::int as ids from ledger.exposures
       where day >= $1::date group by recipient_kind, recipient order by recipient_kind collate "C", recipient collate "C"`,
      [since],
    );
    return { since, rows };
  });
  return ExposureStatusView.parse({
    since,
    recipients: rows.map((row) => ({ kind: row.kind, id: row.id, ids: row.ids })),
  });
}
