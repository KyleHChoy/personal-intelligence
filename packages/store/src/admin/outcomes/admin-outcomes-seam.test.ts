import { describe, expect, it } from "vitest";
import type { Query } from "../../core/db.ts";
import { seamSignals } from "./admin-outcomes-seam.ts";

// The headline's arithmetic and what its statements read, with no database: the counts themselves
// are proven against one in work/agent-seam.db.test.ts.

const CLOCK = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-08T00:00:00.000Z", within: ["own"] };

function fake(rows: { raised: object; picked: object; roles?: object[]; written?: object[] }): {
  query: Query;
  asked: string[];
} {
  const asked: string[] = [];
  const query = (async (text: string) => {
    asked.push(text);
    if (text.includes("as surfaced")) return [rows.raised];
    if (text.includes("holders")) return rows.roles ?? [];
    if (text.includes("as median_minutes")) return [rows.picked];
    if (text.includes("ledger.signal_marks")) return rows.written ?? [];
    return [];
  }) as Query;
  return { query, asked };
}

describe("signals picked up", () => {
  it("counts a signal read in the feed or whose task was claimed, each once, and says how many of each", async () => {
    const { query, asked } = fake({
      raised: { surfaced: 10, gaps: 10, code_closed: 0 },
      picked: { picked: 12, read: 5, claimed: 9, median_minutes: 4.4 },
    });
    const view = await seamSignals(query, 7, CLOCK);
    expect(view.pickedUp).toBe(12);
    expect(view.medianPickupMinutes).toBe(4);
    expect(view.metrics[0]).toMatchObject({
      metric: "signals_picked_up",
      value: 0.6,
      sample: 20,
      state: "ok",
      parts: { read: 5, claimed: 9 },
    });
    const picked = asked.find((text) => text.includes("as median_minutes") && !text.includes("holders")) ?? "";
    expect(picked).toContain("ledger.change_log");
    expect(picked).toContain("r.event = 'claimed'");
  });

  it("a claim with no read of the feed is no zero", async () => {
    const { query } = fake({
      raised: { surfaced: 0, gaps: 20, code_closed: 0 },
      picked: { picked: 15, read: 0, claimed: 15, median_minutes: null },
    });
    expect((await seamSignals(query, 7, CLOCK)).metrics[0]).toMatchObject({ value: 0.75, state: "ok" });
  });

  it("counts a role's claims with its reads", async () => {
    const { query, asked } = fake({
      raised: { surfaced: 0, gaps: 2, code_closed: 0 },
      picked: { picked: 1, read: 0, claimed: 1, median_minutes: 3 },
      roles: [{ role: "chief", picked: 1, median_minutes: 3, written: 0, gaps: 2 }],
    });
    expect((await seamSignals(query, 7, CLOCK)).byRole).toEqual([
      { role: "chief", gapsRaised: 2, pickedUp: 1, writtenBack: 0, medianPickupMinutes: 3 },
    ]);
    expect(asked.find((text) => text.includes("holders"))).toContain("r.event = 'claimed'");
  });
});

describe("signals raised", () => {
  it("leaves out a task code closed with no claim, and says how many beside it", async () => {
    const { query, asked } = fake({
      raised: { surfaced: 4, gaps: 6, code_closed: 2928 },
      picked: { picked: 5, read: 5, claimed: 0, median_minutes: null },
    });
    const view = await seamSignals(query, 7, CLOCK);
    expect(view.raised).toBe(10);
    expect(view.codeClosed).toBe(2928);
    expect(view.metrics[0]).toMatchObject({ value: 0.5, sample: 10 });
    const raised = asked.find((text) => text.includes("as surfaced")) ?? "";
    expect(raised).toContain("d.decided_by = 'policy' and d.decision = 'no_go'");
    expect(raised).toContain("as code_closed");
  });
});

describe("signals written back", () => {
  it("counts a claimed gap task its agent reported on, beside what was written back, and says how many of each", async () => {
    const { query, asked } = fake({
      raised: { surfaced: 0, gaps: 20, code_closed: 0 },
      picked: { picked: 10, read: 2, claimed: 8, median_minutes: null },
      written: [
        { state: "handled", n: 1 },
        { state: "reported", n: 3 },
      ],
    });
    const view = await seamSignals(query, 7, CLOCK);
    expect(view.writtenBack).toEqual({ handled: 1, drafted: 0, needsOwner: 0, reported: 3 });
    expect(view.metrics[1]).toMatchObject({
      metric: "signals_written_back",
      value: 0.4,
      sample: 10,
      state: "ok",
      parts: { handled: 1, drafted: 0, needs_owner: 0, reported: 3 },
    });
    const written = asked.find((text) => text.includes("ledger.signal_marks") && !text.includes("holders")) ?? "";
    expect(written).toContain("r.event = 'reported'");
    expect(written).toContain("r.code is distinct from 'progress'");
    expect(asked.find((text) => text.includes("holders"))).toContain("r.event = 'reported'");
  });
});
