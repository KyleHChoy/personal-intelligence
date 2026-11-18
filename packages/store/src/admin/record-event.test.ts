import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { CARD_HELD, CARD_PENDING, HYPOTHESIS_EVENT, recordEvent, TASK_WITHDRAWN } from "./record-event.ts";

// The statement recordEvent sends for a declaration and a call, and the values it binds.
async function sent(...args: Parameters<typeof recordEvent> extends [Query, ...infer Rest] ? Rest : never) {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const query = (async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return [];
  }) as Query;
  await recordEvent(query, ...args);
  return calls;
}

describe("recordEvent", () => {
  it("writes the declared row kind, event and author, the label through ledger.label when normalised", async () => {
    expect(await sent(CARD_PENDING, "crd_1", "2026-06-15T12:00:00.000Z", ["own"])).toEqual([
      {
        text: "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, $4, $5, ledger.label($6))",
        values: ["card", "crd_1", "pending", "2026-06-15T12:00:00.000Z", "owner", ["own"]],
      },
    ]);
  });

  it("keeps the label as given when not normalised, and adds the declared code", async () => {
    const [held] = await sent(CARD_HELD, "crd_1", "t", ["own"]);
    expect(held?.text).toContain("values ($1, $2, $3, $4, $5, $6)");
    const [withdrawn] = await sent(TASK_WITHDRAWN, "opp_1", "t", ["own"]);
    expect(withdrawn).toEqual({
      text: "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ($1, $2, $3, $4, $5, $6, $7)",
      values: ["opportunity", "opp_1", "withdrawn", "t", "owner", ["own"], "owner_withdrew"],
    });
  });

  it("takes the event, author, code and body a call adds", async () => {
    const [row] = await sent(HYPOTHESIS_EVENT, "hyp_1", "t", ["own"], { event: "rejected", by: "x", body: { s: 1 } });
    expect(row?.values).toEqual(["hypothesis", "hyp_1", "rejected", "t", "x", ["own"], { s: 1 }]);
    expect(row?.text).toContain("(row_kind, row_id, event, at, by, compartments, body_enc)");
  });

  it("refuses a declaration and call with no event", async () => {
    await expect(sent(HYPOTHESIS_EVENT, "hyp_1", "t", ["own"])).rejects.toThrow();
  });
});
