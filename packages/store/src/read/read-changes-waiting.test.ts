import { CHANGES_MOST, type ClientView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { changesWaiting } from "./read-changes.ts";

// The change feed's count on the board and the inbox: what the statements are and that every path
// gives the savepoint back. The database tests show the count itself and that nothing is marked
// read.

const client = (tools: string[]): ClientView =>
  ({ id: "cli_1", name: "scout", compartments: ["own"], views: ["self", "work"], tools }) as unknown as ClientView;

// A context whose run records each statement and answers the feed with `rows` rows, or throws.
function fakeCtx(rows: number, fail?: Error) {
  const sent: { text: string; values: unknown[] }[] = [];
  const run = async (text: string, values: unknown[] = []) => {
    sent.push({ text, values });
    if (/ledger\.change_feed/.test(text)) {
      if (fail !== undefined) throw fail;
      return Array.from({ length: rows }, (_, n) => ({ signal_key: `sig_${n}` }));
    }
    return [];
  };
  return { ctx: { run } as unknown as Ctx, sent };
}

describe("the change feed's count", () => {
  it("a client with no feed is asked nothing", async () => {
    const { ctx, sent } = fakeCtx(3);
    expect(await changesWaiting(ctx, client(["list_opportunities"]))).toBeNull();
    expect(sent).toEqual([]);
  });

  it("counts what the cheap step would serve from where the client last read, inside a savepoint it rolls back", async () => {
    const { ctx, sent } = fakeCtx(3);
    expect(await changesWaiting(ctx, client(["list_opportunities", "get_changes"]))).toBe(3);
    expect(sent.map((one) => one.text.replace(/\s+/g, " ").trim())).toEqual([
      "savepoint changes_waiting",
      "select ledger.changes_quick($1::timestamptz, $2::text, $3::interval) as full",
      expect.stringMatching(/^select .* from ledger\.change_feed\(/),
      "rollback to savepoint changes_waiting",
      "release savepoint changes_waiting",
    ]);
    // No cursor of the caller's own choosing, no signal computed, nothing said to be complete.
    // The cheap step looks back a day and no further: the count is rolled back, so it never moves
    // where the client last polled.
    expect(sent[1]?.values).toEqual([null, null, "24 hours"]);
    expect(sent[2]?.values).toEqual([[], [], [], [], false, null, null, CHANGES_MOST, false]);
  });

  it("stands at CHANGES_MOST for that many or more", async () => {
    const { ctx } = fakeCtx(CHANGES_MOST + 1);
    expect(await changesWaiting(ctx, client(["get_changes"]))).toBe(CHANGES_MOST);
  });

  it("a serialization failure leaves the count out and gives the savepoint back; any other failure is the call's", async () => {
    const lost = fakeCtx(0, new Unavailable("40001"));
    expect(await changesWaiting(lost.ctx, client(["get_changes"]))).toBeNull();
    expect(lost.sent.map((one) => one.text).slice(-2)).toEqual([
      "rollback to savepoint changes_waiting",
      "release savepoint changes_waiting",
    ]);
    const broken = fakeCtx(0, new Unavailable("42883"));
    await expect(changesWaiting(broken.ctx, client(["get_changes"]))).rejects.toBeInstanceOf(Unavailable);
  });
});
