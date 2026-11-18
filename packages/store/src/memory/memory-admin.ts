import type {
  ClientId,
  ClientName,
  MemoryExposureView,
  MemoryProjectionId,
  MemoryStatusView,
  VendorRetention,
} from "@intelligence/contracts/personal";
import { AdminError } from "../core/admin-error.ts";
import { type Query, stamp, stampOrNull } from "../core/db.ts";

// The owner's two memory reads, as pi_admin, which reads both memory tables and nothing of them but
// ids, times, counts and states. Each runs in the admin's one transaction. A client name that is no
// client is `not_found`; the caller throws it.

// Every client, or the one named, by name: its last ok sync, its rows counted by state and its
// exposures by removal. A row is unconfirmed while the adapter has not reported it since it was
// last served; an ended row is not yet absent while its last report says it is in the file.
const STATUS = `
  select c.id, c.name, c.status, c.vendor_retention,
    (select max(k.at) from policy.calls k where k.client_id = c.id and k.tool = 'sync_memory' and k.outcome = 'ok') as last_sync_at,
    (select count(*)::int from ledger.memory_projections p where p.client_id = c.id and p.ended_at is null) as live,
    (select count(*)::int from ledger.memory_projections p
     where p.client_id = c.id and p.ended_at is null and (p.reported_present_at is null or p.reported_present_at < p.last_served_at)) as unconfirmed,
    (select count(*)::int from ledger.memory_projections p
     where p.client_id = c.id and p.ended_at is not null and p.reported_present_at is not null
       and (p.reported_absent_at is null or p.reported_absent_at < p.reported_present_at)) as ended_not_absent,
    (select count(*)::int from ledger.memory_exposures x where x.client_id = c.id and x.removal = 'pending') as pending,
    (select count(*)::int from ledger.memory_exposures x where x.client_id = c.id and x.removal = 'reported') as reported,
    (select count(*)::int from ledger.memory_exposures x where x.client_id = c.id and x.removal = 'not_possible') as not_possible
  from policy.clients c
  where $1::text is null or c.name = $1
  order by c.name collate "C"`;

// Newest first, then by id; one more row than asked says there are more.
const EXPOSURES = `
  select x.id::text as id, x.client_id, c.name, x.projection_id, x.first_served_at, x.recorded_at, x.retention, x.removal, x.removal_at, x.first_removal, x.first_removal_at
  from ledger.memory_exposures x join policy.clients c on c.id = x.client_id
  where $1::text is null or c.name = $1
  order by x.recorded_at desc, x.id desc
  limit $2`;

const KNOWN = "select 1 from policy.clients where name = $1";

type StatusRow = {
  id: string;
  name: string;
  status: "active" | "revoked";
  vendor_retention: VendorRetention;
  last_sync_at: Date | null;
  live: number;
  unconfirmed: number;
  ended_not_absent: number;
  pending: number;
  reported: number;
  not_possible: number;
};
type ExposureRow = {
  id: string;
  client_id: string;
  name: string;
  projection_id: string;
  first_served_at: Date;
  recorded_at: Date;
  retention: VendorRetention;
  removal: "pending" | "reported" | "not_possible";
  removal_at: Date | null;
  first_removal: "reported" | "not_possible" | null;
  first_removal_at: Date | null;
};

// Null when a client was named and no client has that name.
export async function memoryStatus(query: Query, client?: ClientName): Promise<MemoryStatusView> {
  const view = await statusOf(query, client);
  if (view === null) throw new AdminError("not_found");
  return view;
}

async function statusOf(query: Query, client: ClientName | undefined): Promise<MemoryStatusView | null> {
  const rows = await query<StatusRow>(STATUS, [client ?? null]);
  if (client !== undefined && rows.length === 0) return null;
  return {
    clients: rows.map((row) => ({
      client: row.id as ClientId,
      name: row.name,
      status: row.status,
      retention: row.vendor_retention,
      lastSyncAt: stampOrNull(row.last_sync_at),
      live: row.live,
      unconfirmed: row.unconfirmed,
      endedNotAbsent: row.ended_not_absent,
      exposures: { pending: row.pending, reported: row.reported, notPossible: row.not_possible },
    })),
  };
}

// Null when a client was named and no client has that name. `limit` is already checked.
export async function memoryExposures(
  query: Query,
  options: { client?: ClientName; limit?: number } = {},
): Promise<MemoryExposureView> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AdminError("invalid_argument");
  const view = await exposuresOf(query, options.client, limit);
  if (view === null) throw new AdminError("not_found");
  return view;
}

async function exposuresOf(
  query: Query,
  client: ClientName | undefined,
  limit: number,
): Promise<MemoryExposureView | null> {
  if (client !== undefined && (await query(KNOWN, [client])).length === 0) return null;
  const rows = await query<ExposureRow>(EXPOSURES, [client ?? null, limit + 1]);
  return {
    exposures: rows.slice(0, limit).map((row) => ({
      id: Number(row.id),
      client: row.client_id as ClientId,
      name: row.name,
      projection: row.projection_id as MemoryProjectionId,
      firstServedAt: stamp(row.first_served_at),
      recordedAt: stamp(row.recorded_at),
      retention: row.retention,
      removal: row.removal,
      removalAt: stampOrNull(row.removal_at),
      firstRemoval: row.first_removal,
      firstRemovalAt: stampOrNull(row.first_removal_at),
    })),
    more: rows.length > limit,
  };
}
