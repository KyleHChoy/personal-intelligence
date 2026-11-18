import type { PipelineCode, PipelineStatus, ReaskRecord } from "@intelligence/contracts/personal";
import { REASK_WINDOW, vendorRetry } from "@intelligence/personal-core/planner";

// The in-memory store's automatic retries and re-ask counts, as the store keeps them in clear
// columns of a status row.

// The automatic retries a vendor failure has had, and when the next is due, by the clock's
// milliseconds.
export type RetryMarks = { vendorRetries?: number; retryAt?: number };
type Status = { attempts: number; status: PipelineStatus; code?: PipelineCode } & RetryMarks;

const MAX_ATTEMPTS = 5;

// As the store's countAttempts: the fifth attempt fails the item, and one the vendor failed is
// owed its next retry until its tries are spent. `limits`: the two retry levers' values.
export function attempted<Row extends Status>(
  row: Row,
  now: number,
  limits: { max: number; baseMinutes: number },
): Row {
  const attempts = row.attempts + 1;
  if (attempts < MAX_ATTEMPTS) return { ...row, attempts };
  const { retryAt: _retryAt, ...rest } = row;
  const next = vendorRetry(row.code, row.vendorRetries ?? 0, limits);
  return {
    ...rest,
    attempts,
    status: "failed",
    vendorRetries: next.retries,
    ...(next.afterMinutes === null ? {} : { retryAt: now + next.afterMinutes * 60_000 }),
  } as Row;
}

// As the store's requeueRetries: each failed item whose retry has come due waits again.
export function requeue(holders: Iterable<{ status?: Status }>, now: number): { requeued: number } {
  let requeued = 0;
  for (const one of holders) {
    const status = one.status;
    if (status?.retryAt === undefined || status.retryAt > now || status.status !== "failed") continue;
    const { retryAt: _retryAt, ...rest } = status;
    one.status = { ...rest, status: "waiting" };
    requeued += 1;
  }
  return { requeued };
}

// The re-ask each item's latest commit followed, in commit order, and what the stop rule reads of
// them: each code's latest window under one wording.
export function memoryReasks() {
  const reasks = new Map<string, ReaskRecord>();
  return {
    // Re-asks as earlier commits would have left them, the latest last.
    note(list: ReaskRecord[]): void {
      for (const one of list) reasks.set(`noted:${reasks.size}`, one);
    },
    // An item's commit says what its re-ask gave, or that it followed none.
    commit(evidenceId: string, reask: ReaskRecord | undefined): void {
      reasks.delete(evidenceId);
      if (reask !== undefined) reasks.set(evidenceId, reask);
    },
    rates(wording: string): { code: string; asked: number; rescued: number }[] {
      const under = [...reasks.values()].filter((one) => one.wording === wording);
      return [...new Set(under.flatMap((one) => one.codes))].sort().map((code) => {
        const latest = under.filter((one) => one.codes.includes(code)).slice(-REASK_WINDOW);
        return { code, asked: latest.length, rescued: latest.filter((one) => one.rescued).length };
      });
    },
  };
}
