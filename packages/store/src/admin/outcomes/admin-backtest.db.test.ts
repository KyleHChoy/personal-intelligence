import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { type Query, session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { SCORED_AFTER_DAYS } from "./admin-backtest.ts";

// The meter on a small made-up world, every number worked out by hand: what was surfaced before an act
// counts, what came after does not, an act from before the first record is left out, an item within a
// week of being surfaced is not scored, and a restricted row is in no count.

const TIMEOUT = 180_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ago = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * DAY_MS - hours * 3_600_000).toISOString();
const fp = (n: number): string => n.toString(16).padStart(64, "0");

const moved = (store: TestStore, text: string, values: unknown[]): Promise<unknown> =>
  session(store.db.urls.bootstrap, async (query: Query) => {
    const table = /^\s*(?:update|insert into) (\S+)/.exec(text)?.[1];
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`alter table ${table} disable trigger user`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} enable trigger user`);
      await query(`alter table ${table} force row level security`);
    }
  });

describe("the meter", () => {
  let store: TestStore;

  beforeAll(async () => {
    store = await openStore({ now: NOW, compartments: ["own"] });
    await session(store.db.urls.admin, async (query: Query) => {
      const seed = seeder(store.db, query);
      const surfaced = (key: string, at: string, kind: string, thread: string | null, label = ["own"]) =>
        moved(
          store,
          `insert into ledger.surfaced_items (day, surface, source_kind, item_key, thread_fp, evidence_ids, first_at, compartments)
         values ($1::timestamptz::date, 'next', $2, $3, $4, array['ev'], $1, $5::text[])`,
          [at, kind, key, thread, label],
        );
      const mail = async (thread: string, direction: "inbound" | "outbound", at: string, label = ["own"]) => {
        const evidence = await seed.evidence(label);
        const id = await seed.message(label, evidence, { held: false, text: "body" });
        await moved(
          store,
          "update knowledge.messages set bulk = false, thread_fp = $2, direction = $3, sent_at = $4 where id = $1",
          [id, thread, direction, at],
        );
      };

      // The first record: 20 days ago. A reply from before it is left out.
      await surfaced("msg_first", ago(20), "message", fp(1));
      await mail(fp(9), "inbound", ago(30));
      await mail(fp(9), "outbound", ago(25));

      // Replies at least a week old: one surfaced before, one surfaced only after, one on a thread never shown.
      await mail(fp(1), "inbound", ago(19));
      await mail(fp(1), "outbound", ago(18));
      await mail(fp(1), "outbound", ago(10));
      await mail(fp(2), "inbound", ago(15));
      await mail(fp(2), "outbound", ago(12));
      await surfaced("msg_late", ago(11), "message", fp(2));
      await mail(fp(3), "inbound", ago(9));
      await mail(fp(3), "outbound", ago(8));
      // First on a thread nobody wrote in: not a reply.
      await mail(fp(4), "outbound", ago(10));
      // Too young: not scored yet.
      await mail(fp(1), "outbound", ago(2));

      // A plan surfaced, then closed as done five days on: a deadline met, surfaced beforehand, and touched.
      await surfaced("plan_done", ago(14), "plan", null);
      await moved(
        store,
        `insert into knowledge.owner_decisions (id, request_id, kind, answer, queue_depth, labels, details, decided_at, compartments)
         values ($1, $2, 'open_item_close', 'done', 0, '{}', $3, $4, '{own}')`,
        [testId("rul"), testId("req"), JSON.stringify({ key: "plan_done", due: null }), ago(9)],
      );
      // A plan surfaced, nothing done of it within the week: untouched. And one first seen this week: not scored.
      await surfaced("plan_ignored", ago(15), "plan", null);
      await surfaced("plan_young", ago(3), "plan", null);
      // A meeting the owner declined, surfaced: no row of the meter.
      const declined = await seed.event(["own"]);
      await seed.eventDetails(["own"], declined);
      await moved(store, "update knowledge.event_details set owner_response = 'declined' where event_id = $1", [
        declined,
      ]);
      await surfaced(declined, ago(16), "event", null);
      // A restricted row is in no count.
      await surfaced("msg_hidden", ago(12), "message", fp(5), ["restricted:health"]);
      await queryAs(
        store.db.urls.pipeline,
        `insert into ledger.recall_checks (filter, target_key, evidence_id, judge, verdict, population, compartments) values
       ('mail_no_deadline_word', $1, 'ev1', 'model:t/opus@personal_recall_audit@1', 'missed', 12, '{own}'),
       ('mail_no_deadline_word', $2, 'ev2', 'model:t/opus@personal_recall_audit@1', 'rightly_dropped', 12, '{own}')`,
        [fp(11), fp(12)],
      );
      await queryAs(
        store.db.urls.pipeline,
        `insert into ledger.recall_checks (filter, target_key, evidence_id, judge, code, population, compartments) values
       ('bar_not_a_promise', $1, 'ev3', 'model:t/opus@personal_recall_audit@1', 'uncited', 4, '{own}')`,
        [fp(13)],
      );
    });
  }, TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  it(
    "scores the acts a week old against what was shown before them, and says what it cannot see",
    async () => {
      const { meter } = await store.admin.box.outcomes(30);
      expect(meter.surfaced).toMatchObject({
        value: 0.6,
        sample: 5,
        state: "no_data",
        window: { fromDaysAgo: 30 + SCORED_AFTER_DAYS, toDaysAgo: SCORED_AFTER_DAYS },
      });
      expect(meter.surfaced.parts).toMatchObject({
        replies_sent: 4,
        replies_surfaced: 2,
        meetings_held: 0,
        deadlines_met: 1,
        deadlines_surfaced: 1,
        // No audience is built on this box, so the commitments' read says rebuilding: said, and the rest stands.
        commitments_unread: 1,
      });
      // First surfaced at least a week ago: the first, late, done and ignored rows. The first's thread was
      // mailed within its week and the late one's only before it; the done plan was closed, the ignored one not.
      expect(meter.untouched).toMatchObject({ value: 0.5, sample: 4 });
      expect(meter.untouched.parts).toMatchObject({ message: 2, message_untouched: 1, plan: 2, plan_untouched: 1 });
      expect(meter.undercounts).toEqual(expect.arrayContaining(["chat", "phone"]));
    },
    TIMEOUT,
  );

  it(
    "comes right below the headline in the outcome report, the cost below it, and the recall audit's rates by filter",
    async () => {
      const view = await store.admin.box.outcomes(14);
      expect(Object.keys(view).slice(0, 5)).toEqual(["days", "at", "headline", "meter", "recall"]);
      expect(view.meter.cost).toEqual({ raised: 0, claimed: 0, done: 0 });
      expect(view.recall).toEqual([
        expect.objectContaining({
          filter: "bar_not_a_promise",
          checks: 1,
          scored: 0,
          noVerdict: 1,
          missRate: null,
          population: 4,
        }),
        expect.objectContaining({
          filter: "mail_no_deadline_word",
          checks: 2,
          scored: 2,
          missed: 1,
          missRate: 0.5,
          population: 12,
        }),
      ]);
      expect(view.usage.tables.find((one) => one.table === "ledger.recall_checks")).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "says nothing until something was recorded",
    async () => {
      const empty = await openStore({ now: NOW, compartments: ["own"] });
      try {
        const { meter } = await empty.admin.box.outcomes(14);
        expect(meter.surfaced).toMatchObject({ value: null, state: "no_data", code: "not_recorded_yet" });
      } finally {
        await empty.close();
      }
    },
    TIMEOUT,
  );
});
