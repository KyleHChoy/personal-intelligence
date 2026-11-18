import { BUDGETED_TOOLS, type ClientKind, type ClientName, ClientQuota } from "@intelligence/contracts/personal";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";

// The owner's side of read quotas, run as pi_admin: a client's budgets set, and each client's use
// against them. Counts only: no id read, no text. The windows and the rules are
// policy.read_allowance's own.

export type ClientUsage = {
  client: ClientName;
  kind: ClientKind;
  status: "active" | "revoked";
  quota: ClientQuota;
  used: { itemsDay: number; charsDay: number; rowsDay: number; callsMinute: number };
  rateLimitedDay: number;
};

// policy.read_allowance's text tools, whose bound ids are the items a client was served: those
// READ_BUDGET calls text and the text tools added after it. A test holds this list equal to the
// function's, so the owner's counts are the ones enforced.
export const TEXT_TOOLS: readonly string[] = [
  "read_message",
  "read_item",
  "get_evidence_span",
  "get_document",
  "fetch_template",
];

// The budget columns of policy.clients, in ClientQuota's order.
export const quotaValues = (quota: ClientQuota): number[] => [
  quota.maxItemsDay,
  quota.maxCharsDay,
  quota.maxRowsDay,
  quota.maxCallsMinute,
];

type StoredQuota = { max_items_day: number; max_chars_day: string; max_rows_day: number; max_calls_minute: number };
const quotaOf = (row: StoredQuota): ClientQuota => ({
  maxItemsDay: row.max_items_day,
  maxCharsDay: Number(row.max_chars_day),
  maxRowsDay: row.max_rows_day,
  maxCallsMinute: row.max_calls_minute,
});

// The active client's budgets with the changes given, checked against the contract's bounds:
// "not_found" for an unknown or revoked name, "device_fixed" for a Lens device client, "invalid"
// for a value out of bounds.
export async function setQuota(query: Query, name: string, changes: Partial<ClientQuota>): Promise<void> {
  const [row] = await query<StoredQuota & { kind: ClientKind }>(
    "select kind, max_items_day, max_chars_day, max_rows_day, max_calls_minute from policy.clients where name = $1 and status = 'active' for update",
    [name],
  );
  if (row === undefined) throw new AdminError("not_found");
  if (row.kind === "device") throw new AdminError("device_fixed");
  const quota = ClientQuota.safeParse({ ...quotaOf(row), ...changes });
  if (!quota.success) throw new AdminError("invalid_argument");
  await query(
    "update policy.clients set max_items_day = $2, max_chars_day = $3, max_rows_day = $4, max_calls_minute = $5 where name = $1",
    [name, ...quotaValues(quota.data)],
  );
}

// The counts of policy.read_allowance, taken as it takes them, and the client's rate_limited
// read calls (record's own quota and the work tools are not read budgets, but for the work tools
// that read, WORK_READ_BUDGET).
const USAGE = `
  select c.name, c.kind, c.status, c.max_items_day, c.max_chars_day, c.max_rows_day, c.max_calls_minute,
    (select count(distinct b.id) from ledger.read_log r cross join lateral unnest(r.bound) as b(id)
     where r.client_id = c.id and r.read_at > now() - interval '24 hours' and r.tool = any($2))::int as items_day,
    u.chars_day::text as chars_day, u.rows_day::text as rows_day, u.calls_minute::int as calls_minute, u.rate_limited_day::int as rate_limited_day
  from policy.clients c
  cross join lateral (
    select
      count(*) filter (where k.at > now() - interval '60 seconds' and k.tool = any($3)) as calls_minute,
      coalesce(sum(k.chars) filter (where k.tool = any($3)), 0) as chars_day,
      coalesce(sum(k.rows) filter (where k.outcome = 'ok' and k.tool = any($3)), 0) as rows_day,
      count(*) filter (where k.outcome = 'rate_limited' and k.tool = any($3)) as rate_limited_day
    from policy.calls k where k.client_id = c.id and k.at > now() - interval '24 hours'
  ) u
  where $1::text is null or c.name = $1
  order by c.name collate "C"`;

type UsageRow = StoredQuota & {
  name: ClientName;
  kind: ClientKind;
  status: "active" | "revoked";
  items_day: number;
  chars_day: string;
  rows_day: string;
  calls_minute: number;
  rate_limited_day: number;
};

// Every client's use, by name, or one client's; an unknown name has no row.
export async function usage(query: Query, name?: string): Promise<ClientUsage[]> {
  const rows = await query<UsageRow>(USAGE, [name ?? null, TEXT_TOOLS, BUDGETED_TOOLS]);
  return rows.map((row) => ({
    client: row.name,
    kind: row.kind,
    status: row.status,
    quota: quotaOf(row),
    used: {
      itemsDay: row.items_day,
      charsDay: Number(row.chars_day),
      rowsDay: Number(row.rows_day),
      callsMinute: row.calls_minute,
    },
    rateLimitedDay: row.rate_limited_day,
  }));
}
