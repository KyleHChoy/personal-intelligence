// Pure.
import { SESSION_GAP_MS } from "@intelligence/contracts/personal";
import type { WorkRow } from "./work-time-row.ts";
import { within } from "./work-time-units.ts";

// For each moment step 4 may read under `label`, the instant its thread stops holding: at most SESSION_GAP_MS
// after its end, cut at the first start of a same-app moment that ends after it, and not held at all if that
// moment is on screen when it ends, since the newer thread then holds. Moments that end together both hold, so
// two threads at one instant give none; one of no length holds nothing. `moments` are rows the caller is served,
// so nothing it cannot see moves a hold (invariant 6).
export function momentHolds(moments: readonly WorkRow[], label: readonly string[]): Map<string, number> {
  const holds = new Map<string, number>();
  const byApp = new Map<string, WorkRow[]>();
  for (const row of moments) {
    if (!within(row.compartments, label) && !within(label, row.compartments)) continue;
    const app = row.work?.kind === "moment" ? row.work.bundle.toLowerCase() : "";
    if (byApp.get(app)?.push(row) === undefined) byApp.set(app, [row]);
  }
  for (const rows of byApp.values()) {
    // Latest end first, so each end meets the earliest start of the moments ending after it.
    const byEnd = [...rows].sort((a, b) => b.endedAt - a.endedAt);
    let earliest = Number.POSITIVE_INFINITY;
    for (let at = 0; at < byEnd.length; ) {
      const end = (byEnd[at] as WorkRow).endedAt;
      let next = at;
      while (next < byEnd.length && (byEnd[next] as WorkRow).endedAt === end) next += 1;
      const tied = byEnd.slice(at, next);
      for (const row of tied)
        holds.set(row.id, row.startedAt >= end ? end : Math.max(end, Math.min(earliest, end + SESSION_GAP_MS)));
      for (const row of tied) earliest = Math.min(earliest, row.startedAt);
      at = next;
    }
  }
  return holds;
}
