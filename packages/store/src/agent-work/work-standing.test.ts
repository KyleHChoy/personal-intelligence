import type { OpportunityView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Unavailable } from "../read/read-ctx.ts";
import { byStanding, standingRows, type TaskStandingRow } from "./work-standing.ts";

// The order tasks are offered in: dated first, then what was used. Nothing leaves.

const view = (id: string, trigger: string | null, dueAt: string | null = null): OpportunityView =>
  ({
    id,
    kind: "research",
    tier: "task",
    dueAt,
    ...(trigger === null ? {} : { gap: { trigger } }),
  }) as unknown as OpportunityView;
const row = (trigger: string, over: Partial<TaskStandingRow>): TaskStandingRow => ({
  trigger,
  scored: 0,
  used: 0,
  kept: 0,
  dropped: 0,
  ...over,
});
const sorted = (rows: TaskStandingRow[], views: OpportunityView[]): string[] =>
  [...views].sort(byStanding(rows)).map((one) => one.id);

describe("reading the order", () => {
  const ctxWith = (read: () => Promise<unknown[]>) => {
    const statements: string[] = [];
    const warned: unknown[] = [];
    const run = (async (text: string) => {
      statements.push(text);
      return text.includes("task_standing") ? read() : [];
    }) as never;
    return {
      ctx: { run, log: { info() {}, error() {}, warn: (line: unknown) => warned.push(line) } as never },
      statements,
      warned,
    };
  };
  const END = ["rollback to savepoint board_order", "release savepoint board_order"];

  it("bounds the read by a short timeout that ends with it", async () => {
    const rows = [row("close_no_tie", { scored: 1, used: 1 })];
    const { ctx, statements, warned } = ctxWith(async () => rows);
    expect(await standingRows(ctx, "2026-11-01T00:00:00.000Z")).toEqual(rows);
    expect(statements[1]).toMatch(/^set local statement_timeout = \d+$/);
    expect(statements.slice(-2)).toEqual(END);
    expect(warned).toEqual([]);
  });

  for (const [what, sqlstate] of [
    ["a timeout", "57014"],
    ["an undefined function", "42883"],
  ] as const)
    it(`${what} leaves the order by date, with a code, and never fails the board`, async () => {
      const { ctx, statements, warned } = ctxWith(() => Promise.reject(new Unavailable(sqlstate)));
      expect(await standingRows(ctx, "2026-11-01T00:00:00.000Z")).toEqual([]);
      expect(statements.slice(-2)).toEqual(END);
      expect(warned).toEqual([{ event: "board_order_fallback", code: sqlstate }]);
    });
});

describe("the order tasks are offered in", () => {
  const fills = view("opp_1", "close_no_tie");
  const reply = view("opp_2", "reply_owed");
  const meeting = view("opp_3", "meeting_soon", "2026-11-06T12:00:00.000Z");
  const sooner = view("opp_4", "deadline_soon", "2026-11-05T12:00:00.000Z");

  it("puts what has a date first, soonest first, however its trigger stands", () => {
    const rows = [row("meeting_soon", { scored: 10, dropped: 5 })];
    expect(sorted(rows, [fills, reply, meeting, sooner])).toEqual(["opp_4", "opp_3", "opp_1", "opp_2"]);
  });

  it("with nothing known, undated work keeps its old order", () => {
    expect(sorted([], [view("opp_5", "close_no_role"), fills, reply])).toEqual(["opp_1", "opp_2", "opp_5"]);
  });

  it("a trigger whose work nobody used goes after one whose work was", () => {
    const rows = [row("reply_owed", { scored: 17, used: 0 }), row("close_no_tie", { scored: 30, used: 18 })];
    expect(sorted(rows, [reply, fills])).toEqual(["opp_1", "opp_2"]);
  });

  it("work the owner dropped goes after work that was used, and stays on the board", () => {
    const rows = [row("close_no_tie", { scored: 10, dropped: 3 }), row("close_no_role", { scored: 10, used: 9 })];
    expect(sorted(rows, [fills, view("opp_5", "close_no_role")])).toEqual(["opp_5", "opp_1"]);
  });

  it("leaves an opportunity's place alone", () => {
    const opportunity = { ...view("opp_0", null), kind: "research", tier: "opportunity" } as OpportunityView;
    const rows = [row("research", { scored: 10, dropped: 3 })];
    expect(sorted(rows, [fills, opportunity])).toEqual(["opp_0", "opp_1"]);
  });
});
