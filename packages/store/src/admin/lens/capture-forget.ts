import { type CaptureInboxId, ForgetItem } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { CAPTURE_LANES, isCaptureKind, LENS_CONNECTORS } from "../../core/lanes.ts";
import type { Sealed } from "../../core/seal.ts";
import { readInbox } from "../../lens/inbox-body.ts";
import { syncLock } from "../admin-base.ts";
import { applyDeviceForget } from "../erasure/admin-erase-targets.ts";
import { ensureTasksAccount } from "./lens-admin.ts";

// `pi erase settle`: forgets from a Mac, oldest first, each in a
// transaction of its own behind the sync lock, applied through the owner surface's apply as an
// erasure of kind device_forget. Every pair is computed under the pushing device's own source
// accounts, so no forget reaches another source's item. Ids and counts only.

// A page of the forgets, oldest first, after the last row the run read ($2, $3: its time as
// text, which keeps the microseconds, and its id).
const SELECTABLE = `
  select id, received_at::text as at from ledger.capture_inbox
  where kind = 'forget' and body_enc is not null and taken_at is null
    and ($2::timestamptz is null or (received_at, id) > ($2::timestamptz, $3::text))
  order by received_at, id limit $1`;

// What stops the whole run rather than one forget: the sync holds its lock, or the journal is ahead.
const STOPS = new Set(["sync_running", "erasure_replay_needed", "journal_refused"]);

// A forget settled, with its pairs already removed; one refused for good; one waiting on a
// source account the device lacks; or one another run took.
type Settled =
  | { settled: boolean; alreadyRemoved: number }
  | { refused: "content_mismatch" | "invalid_item" }
  | "waiting"
  | "skipped";

async function settleOne(admin: AdminContext, query: Query, id: string): Promise<Settled> {
  await syncLock(query);
  const [row] = await query<{ client_id: string; content_fp: string; body_enc: Sealed | null; taken_at: Date | null }>(
    "select client_id, content_fp, body_enc, taken_at from ledger.capture_inbox where id = $1 and kind = 'forget' for update",
    [id],
  );
  if (row === undefined || row.body_enc === null || row.taken_at !== null) return "skipped";
  // 1. The body under `own`, against its content fingerprint. One that will not open throws, and
  // is left for the next run. One whose content does not match, or that is no forget, never will
  // be one: it leaves the queue with its body dropped. pi_admin may update `body_enc` and
  // `taken_at` alone, so its `refused_code` stays null.
  const refuse = async (code: "content_mismatch" | "invalid_item"): Promise<Settled> => {
    await query("update ledger.capture_inbox set taken_at = now(), body_enc = null where id = $1", [id]);
    return { refused: code };
  };
  const read = readInbox(admin.keys, { id, body_enc: row.body_enc, content_fp: row.content_fp });
  if (typeof read === "string") return refuse(read);
  const parsed = ForgetItem.safeParse(read.raw);
  if (!parsed.success) return refuse("invalid_item");
  const forget = parsed.data;

  if (forget.keys.some((key) => key.startsWith("task:"))) {
    const [device] = await query<{ name: string }>(
      "select name from policy.lens_devices where capture_client_id = $1",
      [row.client_id],
    );
    if (device !== undefined) await ensureTasksAccount(query, device.name);
  }
  const accounts = await query<{ id: string; connector: string }>(
    `select a.id, a.connector from policy.lens_devices d join vault.source_accounts a on a.label = 'device:' || d.name
     where d.capture_client_id = $1 and a.connector = any($2::text[])`,
    [row.client_id, LENS_CONNECTORS],
  );
  const accountOf = (kind: string): string | undefined =>
    isCaptureKind(kind) ? accounts.find((one) => one.connector === CAPTURE_LANES[kind].connector)?.id : undefined;
  const pairs = new Map<string, { accountId: string; fp: string }>();
  const add = (accountId: string, fp: string): void => void pairs.set(`${accountId} ${fp}`, { accountId, fp });
  for (const key of forget.keys) {
    const kind = key.slice(0, key.indexOf(":"));
    const accountId = accountOf(kind);
    if (accountId === undefined) return "waiting";
    add(accountId, fingerprint(admin.keys, "source_id", key));
    if (kind === "block") {
      const splits = await query<{ fp: string }>(
        `select distinct e.source_item_fp as fp from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
         where c.source_account_id = $1 and c.capture_key = $2 order by 1`,
        [accountId, key],
      );
      for (const split of splits) add(accountId, split.fp);
    }
  }

  // 3. The pairs already removed are left out, and counted; 4. the rest as one erasure.
  const all = [...pairs.values()];
  const removed = await query<{ account: string; fp: string }>(
    `select source_account_id as account, source_item_fp as fp from knowledge.removed_evidence
     where (source_account_id, source_item_fp) in (select * from unnest($1::text[], $2::text[]))`,
    [all.map((one) => one.accountId), all.map((one) => one.fp)],
  );
  const gone = new Set(removed.map((one) => `${one.account} ${one.fp}`));
  const rest = all.filter((one) => !gone.has(`${one.accountId} ${one.fp}`));
  if (rest.length > 0) await applyDeviceForget(admin, query, rest);

  // 5. Taken, its body gone.
  await query("update ledger.capture_inbox set taken_at = now(), body_enc = null where id = $1", [id]);
  return { settled: rest.length > 0, alreadyRemoved: all.length - rest.length };
}

// A forget whose transaction fails is rolled back, counted and left for the next run; it holds back
// no other. One refused for good is counted failed and logged by its row id. One that waits or
// fails is paged past, so `limit` counts the forgets that leave the queue. The sync lock is taken
// before the first page, so a run beside a sync answers `sync_running` even with no forget waiting.
// `alreadyRemoved` counts pairs, `settled` forgets.
export async function settleForgets(
  admin: AdminContext,
  limit = 50,
): Promise<{ settled: number; alreadyRemoved: number; failed: number }> {
  const counts = { settled: 0, alreadyRemoved: 0, failed: 0 };
  let after: { id: string; at: string } | null = null;
  let moved = 0;
  try {
    while (moved < limit) {
      const from: { id: string; at: string } | null = after;
      const page: { id: string; at: string }[] = await admin.transaction(async (query) => {
        await syncLock(query);
        return query<{ id: string; at: string }>(SELECTABLE, [limit - moved, from?.at ?? null, from?.id ?? null]);
      });
      if (page.length === 0) break;
      for (const row of page) {
        after = row;
        let outcome: Settled;
        try {
          outcome = await admin.transaction((query) => settleOne(admin, query, row.id));
        } catch (error) {
          if (error instanceof AdminError && STOPS.has(error.code)) throw error;
          counts.failed += 1;
          continue;
        }
        if (outcome === "skipped" || outcome === "waiting") continue;
        moved += 1;
        if ("refused" in outcome) {
          counts.failed += 1;
          admin.log.warn({ event: "forget_refused", ids: { inbox: row.id as CaptureInboxId }, code: outcome.refused });
          continue;
        }
        if (outcome.settled) counts.settled += 1;
        counts.alreadyRemoved += outcome.alreadyRemoved;
      }
    }
  } finally {
    if (counts.settled + counts.alreadyRemoved + counts.failed > 0)
      admin.log.info({
        event: "forgets_settled",
        counts: { settled: counts.settled, already_removed: counts.alreadyRemoved, failed: counts.failed },
      });
  }
  return counts;
}
