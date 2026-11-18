import type { RunSummary } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { runAgeing, runExtraction } from "./run.ts";
import * as beliefs from "./test-support/rebuild.ts";
import { NOW, type Setup, setup } from "./test-support/support.ts";

// The rebuild is wrapped so a test sees whether it ran.
vi.mock("./test-support/rebuild.ts", async (original) => {
  const module = await original<typeof import("./test-support/rebuild.ts")>();
  return { ...module, rebuildBeliefs: vi.fn(module.rebuildBeliefs) };
});

const DAY_MS = 86_400_000;
// Past the 180 days after which a commitment goes stale with nothing to reconfirm it.
const LATER = new Date(NOW.getTime() + 200 * DAY_MS);

const extracted = async (): Promise<Setup> => {
  const s = await setup();
  const summary = await runExtraction(s.deps);
  if (summary === "already_running" || summary.code !== "ok") throw new Error("the world did not extract");
  return s;
};

const statuses = async (s: Setup): Promise<string[]> =>
  (await s.store.audiences())
    .flatMap((audience) => s.store.beliefs(audience).map((row) => `${row.factKeyFp} ${row.belief.status}`))
    .sort();

const age = async (s: Setup, now: Date): Promise<RunSummary> => {
  const result = await runAgeing({ store: s.store, log: s.log, now: () => now });
  if (result === "already_running") throw new Error("locked");
  return result;
};

describe("runAgeing", () => {
  // Every answer is computed when asked, so its status moves with the clock at read: age stores no
  // belief, and rebuilds none.
  it("age rebuilds and stores no belief, makes no model call, reads no key and writes its row", async () => {
    const s = await extracted();
    const calls = s.calls.length;
    const secret = vi.spyOn(s.store, "secret");
    const rebuild = vi.mocked(beliefs.rebuildBeliefs);
    rebuild.mockClear();

    const summary = await age(s, LATER);

    expect(summary.code).toBe("ok");
    expect(summary.counts.beliefsChanged).toBe(0);
    // Zero items: done, skipped, withheld, failed, waiting and live calls all nought.
    expect([
      summary.counts.done,
      summary.counts.skipped,
      summary.counts.withheld,
      summary.counts.failed,
      summary.counts.waiting,
      summary.counts.liveCalls,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rebuild).not.toHaveBeenCalled();
    expect(await statuses(s)).toEqual([]);
    expect(s.calls.length).toBe(calls);
    expect(secret).not.toHaveBeenCalled();
    expect(s.store.runs().at(-1)).toEqual(summary);
    expect(s.log.lines.at(-1)).toMatchObject({ level: "info", event: { event: "extract_age", code: "ok" } });
  });

  it("an age while a run holds the lock is already_running and writes nothing", async () => {
    const s = await extracted();
    const runs = s.store.runs().length;
    const result = await s.store.withExtractLock(() => runAgeing({ store: s.store, log: s.log, now: () => LATER }));
    expect(result).toBe("already_running");
    expect(s.store.runs().length).toBe(runs);
  });
});
