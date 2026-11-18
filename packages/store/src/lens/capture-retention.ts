import type { RetentionClass, RetentionPlanView, SourceAccountId } from "@intelligence/contracts/personal";
import { byText, type Query } from "../core/db.ts";
import { CAPTURE_RETENTION_CLASS, type CaptureClass, isBuiltClass } from "../core/lanes.ts";
import { eachInOwnTransaction, type Tx } from "../core/tx.ts";
import { expireSourceItem } from "../write/writer-item-removal.ts";
import type { DrainContext } from "./capture-drain.ts";

// Capture retention: the expiry of Lens's capture items by the owner's retention rules. Ageing, not
// erasure: an expired item keeps its evidence row (its record and hash) and its key, writes no
// removed-evidence row and no erasure, and nothing is sent back to the Mac. The rest of the
// retention classes wait for their own expiry, so only these three are built (core/lanes.ts,
// CAPTURE_LANES).

// Transcripts kept.
export const RETENTION_DEFAULTS: readonly { class: CaptureClass; days: number | null }[] = Object.freeze([
  { class: "capture_transcript", days: null },
  { class: "capture_moment", days: 90 },
  { class: "capture_block", days: 400 },
]);

export const EXPIRE_LIMIT = 500;

export type RuleInForce = { class: RetentionClass; account: SourceAccountId | null; days: number | null };

export async function rulesInForce(query: Query): Promise<(RuleInForce & { id: string; at: Date })[]> {
  const rows = await query<{
    id: string;
    class: RetentionClass;
    account_id: SourceAccountId | null;
    days: number | null;
    created_at: Date;
  }>(
    `select distinct on (class, coalesce(account_id, '')) id, class, account_id, days, created_at
     from policy.retention_rules order by class, coalesce(account_id, ''), journal_seq desc`,
  );
  return rows.map((row) => ({
    id: row.id,
    class: row.class,
    account: row.account_id,
    days: row.days,
    at: row.created_at,
  }));
}

// The capture items due under `rules` at `now`, oldest first, at most `limit`: an item's rule is
// its class's for its own account, else its class's for every account; none, or a rule of no
// days, keeps it. Its age is counted from its own time (the evidence row's observed_at), never
// from when it was stored. Only items with their blob: an expired one is not due again. Only items
// whose every compartment the key file holds (`compartments`): expiry seals the kept row again, so
// one it cannot seal would fail every run at the head of the queue and hold back the rest.
const DUE = `
  with rules as (select * from unnest($1::text[], $2::text[], $3::int[]) as r (class, account_id, days)),
  items as (
    select e.id, e.source_account_id, e.source_item_fp, e.observed_at, e.compartments,
      ${CAPTURE_RETENTION_CLASS} as class
    from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
    where e.blob_ref is not null),
  chosen as (
    select i.*, (select r.days from rules r where r.class = i.class and (r.account_id = i.source_account_id or r.account_id is null)
                 order by r.account_id is null limit 1) as days
    from items i)
  select id, source_account_id, source_item_fp, class from chosen
  where days is not null and observed_at < $4::timestamptz - make_interval(days => days)
    and compartments <@ $6::text[]
  order by observed_at, id collate "C"
  limit $5`;

type DueExpiry = { id: string; account: SourceAccountId; fp: string; class: CaptureClass };

export async function dueExpiries(
  query: Query,
  rules: readonly RuleInForce[],
  now: Date,
  limit: number,
  compartments: readonly string[],
): Promise<DueExpiry[]> {
  const built = rules.filter((rule) => isBuiltClass(rule.class));
  const rows = await query<{
    id: string;
    source_account_id: SourceAccountId;
    source_item_fp: string;
    class: CaptureClass;
  }>(DUE, [
    built.map((rule) => rule.class),
    built.map((rule) => rule.account),
    built.map((rule) => rule.days),
    now.toISOString(),
    limit,
    compartments,
  ]);
  return rows.map((row) => ({ id: row.id, account: row.source_account_id, fp: row.source_item_fp, class: row.class }));
}

export async function expireOne(tx: Tx, due: DueExpiry, now: Date): Promise<boolean> {
  return (await expireSourceItem(tx, { id: due.account, compartment: "own" }, due.fp, now)).removed;
}

// The counts by class and account, as `pi retain plan` and `run` print them.
export function countsOf(items: readonly DueExpiry[]): RetentionPlanView["counts"] {
  const counts = new Map<string, { class: CaptureClass; account: SourceAccountId; due: number }>();
  for (const item of items) {
    const key = `${item.class}\n${item.account}`;
    const one = counts.get(key) ?? { class: item.class, account: item.account, due: 0 };
    one.due += 1;
    counts.set(key, one);
  }
  return [...counts.values()].sort((a, b) => byText(a.class, b.class) || byText(a.account, b.account));
}

// An item whose transaction fails is rolled back, counted and left for the next run. Nothing
// expires before the owner writes a rule.
export function expireCaptures(
  writer: DrainContext,
  now: Date,
  limit = EXPIRE_LIMIT,
): Promise<{ expired: Record<string, number>; failed: number }> {
  return writer.write(async () => {
    const rules = await rulesInForce(writer.direct.query);
    const due =
      rules.length === 0
        ? []
        : await dueExpiries(writer.direct.query, rules, now, limit, [...writer.direct.keys.compartments.keys()]);
    const expired: Record<string, number> = {};
    const failed = await eachInOwnTransaction(due, async (item) => {
      if (await writer.write(() => writer.transaction((tx) => expireOne(tx, item, now))))
        expired[item.class] = (expired[item.class] ?? 0) + 1;
    });
    return { expired, failed };
  });
}
