import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { session } from "../../test-support/connections.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";

// `pia work report`'s count of the owner's decisions per day by how they teach,
// read as pi_admin, the role that writes them: an answer is classed by its card's kind, or
// unclassed when its card is tainted; a tainted decision, one before the window and one of today,
// still partial, are left out. Made-up ids only.

const NOW = new Date("2026-10-29T15:00:00.000Z");
const OWN = ["own"];

let store: TestStore;

// As pi_admin, the role that writes cards and the owner's decisions.
const asAdmin = (text: string, values: unknown[]): Promise<unknown> =>
  session(store.db.urls.admin, (query) => query(text, values));

async function card(kind: string, tainted = false): Promise<string> {
  const id = testId("crd");
  await asAdmin(
    "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, tainted_at, compartments) values ($1, $2, $3, 'reasoner', $4, '{yes,no}', $5, $6)",
    [id, testId("req"), NOW, kind, tainted ? NOW : null, OWN],
  );
  return id;
}

async function decision(kind: string, at: string, options: { card?: string; tainted?: boolean } = {}): Promise<void> {
  await asAdmin(
    `insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, queue_depth, decided_at, tainted_at, compartments)
     values ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
    [
      testId("rul"),
      testId("req"),
      kind,
      options.card === undefined ? null : "yes",
      options.card ?? null,
      at,
      options.tainted === true ? at : null,
      OWN,
    ],
  );
}

beforeAll(async () => {
  store = await openStore({ now: NOW, writer: false });
  await decision("goal_reword", "2026-10-28T10:00:00.000Z");
  await decision("answer", "2026-10-28T11:00:00.000Z", { card: await card("opportunity_decision") });
  await decision("answer", "2026-10-28T12:00:00.000Z", { card: await card("lesson") });
  await decision("warmth_tier", "2026-10-22T09:00:00.000Z");
  await decision("task_add", "2026-10-22T09:30:00.000Z");
  await decision("erase", "2026-10-22T10:00:00.000Z");
  await decision("answer", "2026-10-22T11:00:00.000Z", { card: await card("opportunity_decision", true) });
  await decision("goal_set", "2026-10-22T11:00:00.000Z", { tainted: true });
  await decision("goal_set", "2026-10-21T23:59:00.000Z");
  await decision("goal_set", "2026-10-29T01:00:00.000Z");
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

describe("pia work report: the owner's decisions per day by how they teach", () => {
  it(
    "counts each untainted decision of the window once, by its class, and the mean per day of plan ones",
    async () => {
      const report = await store.admin.work.report(7);
      expect(report.decisions).toEqual({
        byDay: [
          { day: "2026-10-22", plan: 1, ruling: 1, none: 1, unclassed: 1 },
          { day: "2026-10-28", plan: 2, ruling: 0, none: 1, unclassed: 0 },
        ],
        plan: 3,
        planPerDay: 0.43,
      });
    },
    DB_TEST_TIMEOUT,
  );
});
