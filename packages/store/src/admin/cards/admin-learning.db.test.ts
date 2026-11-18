import { randomBytes } from "node:crypto";
import type { CardId, RequestId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { weekDayOf } from "../../cards/asked-less.ts";
import { newId } from "../../core/ids.ts";
import { testId } from "../../test-support/clients.ts";
import { one } from "../../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { refusedWith } from "../../test-support/values.ts";
import { type WorkWorld, withWorkWorld } from "../../test-support/work-fixtures.ts";
import { type Admin, createAdmin } from "../admin.ts";
import { drawOrder } from "./admin-learning.ts";

// The owner's views of cards, labels given afterwards and the silence sample, through the real
// Admin on a real database. Each refusal has its control. Made-up values only.

const DAY = 86_400_000;
const T0 = new Date("2026-10-07T12:00:00.000Z");

const request = (): RequestId => randomBytes(12).toString("base64url") as RequestId;

// The world with an Admin on its database whose clock the test moves.
async function withAdmin(fn: (world: WorkWorld, admin: Admin, clock: { now: Date }) => Promise<void>): Promise<void> {
  await withWorkWorld(async (world) => {
    const clock = { now: T0 };
    const admin = createAdmin({ url: world.db.urls.admin, keys: world.db.keys, log: world.log, now: () => clock.now });
    try {
      await fn(world, admin, clock);
    } finally {
      await admin.close();
    }
  });
}

type ViewRow = { target_kind: string; target_id: string; surface: string; shown_at: Date; compartments: string[] };
const views = (world: WorkWorld): Promise<ViewRow[]> =>
  world.admin<ViewRow>(
    "select target_kind, target_id, surface, shown_at, compartments from ledger.owner_views order by id",
  );

type DecisionRow = {
  id: string;
  kind: string;
  target_kind: string;
  target_id: string;
  answer: string | null;
  card_id: string | null;
  supersedes: string | null;
  batch: boolean;
  queue_depth: number;
  labels: string[];
  details: Record<string, unknown>;
  compartments: string[];
};
const decisions = (world: WorkWorld, kind: string): Promise<DecisionRow[]> =>
  world.admin<DecisionRow>(
    `select id, kind, target_kind, target_id, answer, card_id, supersedes, batch, queue_depth, labels, details, compartments from knowledge.owner_decisions
     where kind = $1 order by decided_at, id collate "C"`,
    [kind],
  );

// A silence as durable work writes one, `days` before T0, as pi_admin.
let serial = 0;
async function silence(
  world: WorkWorld,
  options: { reason?: string; days?: number; tainted?: boolean; run?: string | null; compartments?: string[] } = {},
): Promise<string> {
  serial += 1;
  const created = new Date(T0.getTime() - (options.days ?? 1) * DAY);
  return one(
    await world.admin<{ id: string }>(
      `insert into ledger.silences (request_id, created_at, created_by, run_id, compartments, reason, wake_source, wake_key, day, tainted_at)
       values ($1, $2, 'system:work', $3, $4, $5, 'daily_sweep', $6, $7, $8) returning id::text as id`,
      [
        testId("req"),
        created,
        options.run ?? null,
        options.compartments ?? ["own"],
        options.reason ?? "below_bar",
        `sweep:lrn-${serial}`,
        created.toISOString().slice(0, 10),
        options.tainted === true ? created : null,
      ],
    ),
  ).id;
}

describe("card views", { timeout: DB_TEST_TIMEOUT }, () => {
  it("pi show's read and the web page's each write one view row, with the card's label, in the read that shows it", () =>
    withAdmin(async (world, admin, clock) => {
      const card = (await world.card({
        kind: "notice",
        state: "pending",
        compartments: ["employer:example", "own"],
      })) as CardId;
      expect(await admin.cards.card(card)).not.toBeNull();
      // A read that names no surface writes nothing: only the owner's two views count.
      expect(await views(world)).toEqual([]);

      expect((await admin.cards.card(card, { view: "cli" }))?.id).toBe(card);
      clock.now = new Date(T0.getTime() + 60_000);
      expect((await admin.cards.card(card, { view: "web" }))?.id).toBe(card);
      expect(await views(world)).toEqual([
        {
          target_kind: "card",
          target_id: card,
          surface: "cli",
          shown_at: T0,
          compartments: ["employer:example", "own"],
        },
        {
          target_kind: "card",
          target_id: card,
          surface: "web",
          shown_at: clock.now,
          compartments: ["employer:example", "own"],
        },
      ]);
      // An unknown card is not found, and writes no view.
      expect(await admin.cards.card(newId("crd") as CardId, { view: "cli" })).toBeNull();
      expect((await views(world)).length).toBe(2);
    }));

  it("a second show writes a second row and the first stays the first", () =>
    withAdmin(async (world, admin, clock) => {
      const card = (await world.card({ kind: "notice", state: "pending" })) as CardId;
      await admin.cards.card(card, { view: "cli" });
      const [first] = await views(world);
      clock.now = new Date(T0.getTime() + 5_000);
      await admin.cards.card(card, { view: "cli" });
      const after = await views(world);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(first);
      expect(after[1]?.shown_at).toEqual(clock.now);
    }));

  it("markViewed writes a view of a card, a silence sample and a saved call, with its target's label, and refuses another kind", () =>
    withAdmin(async (world, admin) => {
      const card = await world.card({ kind: "notice", state: "pending" });
      await silence(world, { compartments: ["employer:example"] });
      const [drawn] = await admin.learning.drawSilences({ sample: 1, requestId: request() });
      expect(await admin.learning.markViewed({ kind: "card", id: card }, "cli")).toEqual(T0);
      expect(await admin.learning.markViewed({ kind: "silence_sample", id: drawn?.sample ?? "" }, "cli")).toEqual(T0);
      expect((await views(world)).map((row) => [row.target_kind, row.compartments])).toEqual([
        ["card", ["own"]],
        ["silence_sample", ["employer:example"]],
      ]);
      expect(
        await refusedWith(() => admin.learning.markViewed({ kind: "opportunity", id: newId("opp") }, "cli")),
      ).toEqual({ name: "AdminError", code: "invalid_argument" });
      expect(await refusedWith(() => admin.learning.markViewed({ kind: "card", id: newId("crd") }, "cli"))).toEqual({
        name: "AdminError",
        code: "not_found",
      });
      expect((await views(world)).length).toBe(2);
    }));
});

describe("labels afterwards", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a label on an undecided card is not_decided", () =>
    withAdmin(async (world, admin) => {
      const pending = (await world.card({ kind: "notice", state: "pending" })) as CardId;
      expect(
        await refusedWith(() => admin.learning.labelCard({ card: pending, labels: ["acted"], requestId: request() })),
      ).toEqual({ name: "AdminError", code: "not_decided" });
      expect(
        await refusedWith(() =>
          admin.learning.labelCard({ card: newId("crd") as CardId, labels: ["acted"], requestId: request() }),
        ),
      ).toEqual({ name: "AdminError", code: "not_found" });
      expect(await decisions(world, "card_label")).toEqual([]);
      // The control: a decided card takes it.
      const decided = (await world.card({ kind: "notice", state: "decided" })) as CardId;
      await admin.learning.labelCard({ card: decided, labels: ["acted"], requestId: request() });
      expect((await decisions(world, "card_label")).map((row) => row.target_id)).toEqual([decided]);
    }));

  it("a later card_label supersedes and an empty list clears", () =>
    withAdmin(async (world, admin, clock) => {
      const card = (await world.card({
        kind: "notice",
        state: "decided",
        compartments: ["employer:example", "own"],
      })) as CardId;
      const first = await admin.learning.labelCard({
        card,
        labels: ["would_act", "correct", "correct"],
        requestId: request(),
      });
      clock.now = new Date(T0.getTime() + 1_000);
      const second = await admin.learning.labelCard({ card, labels: ["acted"], requestId: request() });
      clock.now = new Date(T0.getTime() + 2_000);
      const cleared = await admin.learning.labelCard({ card, labels: [], requestId: request() });
      expect(
        (await decisions(world, "card_label")).map((row) => ({
          id: row.id,
          supersedes: row.supersedes,
          labels: row.labels,
        })),
      ).toEqual([
        { id: first, supersedes: null, labels: ["correct", "would_act"] },
        { id: second, supersedes: first, labels: ["acted"] },
        { id: cleared, supersedes: second, labels: [] },
      ]);
      // A repeated request returns its first ruling and writes nothing.
      const requestId = request();
      const again = await admin.learning.labelCard({ card, labels: ["novel"], requestId });
      expect(await admin.learning.labelCard({ card, labels: ["novel"], requestId })).toBe(again);
      expect((await decisions(world, "card_label")).length).toBe(4);
    }));

  it("the label decision records its own batch and queue_depth, with the card's label and no card id", () =>
    withAdmin(async (world, admin) => {
      const card = (await world.card({
        kind: "notice",
        state: "decided",
        compartments: ["employer:example", "own"],
      })) as CardId;
      for (let n = 0; n < 3; n += 1) await world.card({ kind: "notice", state: "pending" });
      await admin.learning.labelCard({ card, labels: ["acted"], requestId: request() });
      expect(await decisions(world, "card_label")).toEqual([
        {
          id: expect.any(String),
          kind: "card_label",
          target_kind: "card",
          target_id: card,
          answer: null,
          card_id: null,
          supersedes: null,
          batch: false,
          queue_depth: 3,
          labels: ["acted"],
          details: {},
          compartments: ["employer:example", "own"],
        },
      ]);
    }));
});

describe("the silence sample", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the draw is the lowest sample fingerprints of the week and the same twice in one week", () =>
    withAdmin(async (world, admin) => {
      const ids: string[] = [];
      for (let n = 0; n < 8; n += 1) ids.push(await silence(world, { days: 1 + n }));
      const week = weekDayOf(T0);
      expect(week).toBe("2026-10-05");
      const expected = drawOrder(world.db.keys, ids, week).slice(0, 3);
      // The same week, another day: the same order.
      expect(drawOrder(world.db.keys, ids, weekDayOf(new Date(T0.getTime() + 4 * DAY))).slice(0, 3)).toEqual(expected);
      const drawn = await admin.learning.drawSilences({ sample: 3, requestId: request() });
      expect(drawn.map((one) => one.silence)).toEqual(expected);
      expect(
        await world.admin("select week::text as week, created_by from ledger.silence_samples group by 1, 2"),
      ).toEqual([{ week, created_by: "owner" }]);
      // The next draw of the week takes the next lowest, never one already sampled.
      const next = await admin.learning.drawSilences({ sample: 3, requestId: request() });
      expect(next.map((one) => one.silence)).toEqual(drawOrder(world.db.keys, ids, week).slice(3, 6));
    }));

  it("only judgment silences are drawn", () =>
    withAdmin(async (world, admin) => {
      const judged: string[] = [];
      for (const reason of ["nothing_to_do", "below_bar", "waiting_is_better"])
        judged.push(await silence(world, { reason }));
      for (const reason of ["kill_switch", "vetoed", "no_reasoner", "owner_backlog", "budget"])
        await silence(world, { reason });
      const drawn = await admin.learning.drawSilences({ sample: 20, requestId: request() });
      expect(drawn.map((one) => one.silence).sort()).toEqual([...judged].sort());
      expect(drawn.map((one) => one.reason).sort()).toEqual(["below_bar", "nothing_to_do", "waiting_is_better"]);
    }));

  it("a tainted silence, one already sampled and one older than 28 days are not drawn", () =>
    withAdmin(async (world, admin) => {
      await silence(world, { tainted: true });
      await silence(world, { days: 29 });
      const kept = await silence(world, { days: 27 });
      const first = await admin.learning.drawSilences({ sample: 5, requestId: request() });
      expect(first.map((one) => one.silence)).toEqual([kept]);
      expect(await admin.learning.drawSilences({ sample: 5, requestId: request() })).toEqual([]);
    }));

  it("the samples are stored before the first is shown, each with its silence's label, and are shown with the silence's reason, wake and refs", () =>
    withAdmin(async (world, admin) => {
      const mail = await world.mail();
      // A run whose ignore wrote the silence, anchored on a message, queued as the tick queues one.
      const run = testId("run");
      await world.work(
        `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
         values ($1, $1, 'system:work', '{own}', 'daily_sweep', 'sweep:' || $1, 'run_outcome', 1, 'personal_run', '1')`,
        [run],
      );
      expect(
        one(
          await world.work<{ ok: boolean }>(
            "select ledger.add_basis('run', $1, '{own}'::text[], '{message}'::text[], $2::text[], null) as ok",
            [run, [mail.id]],
          ),
        ).ok,
      ).toBe(true);
      const id = await silence(world, { run, compartments: ["employer:example", "own"] });
      const drawn = await admin.learning.drawSilences({ sample: 5, requestId: request() });
      expect(drawn).toEqual([
        {
          sample: expect.stringMatching(/^sls_/),
          silence: id,
          reason: "below_bar",
          wakeSource: "daily_sweep",
          wakeKey: expect.stringMatching(/^sweep:lrn-/),
          run,
          refs: [{ kind: "message", id: mail.id }],
        },
      ]);
      // Stored, and pending, before anything is shown or answered.
      expect(
        await world.admin("select id, silence_id::text as silence, compartments from ledger.silence_samples"),
      ).toEqual([{ id: drawn[0]?.sample, silence: id, compartments: ["employer:example", "own"] }]);
      expect((await admin.learning.pendingSilences()).map((one) => one.sample)).toEqual([drawn[0]?.sample]);
    }));

  it("a skip stores nothing and the sample stays pending; a verdict ends it", () =>
    withAdmin(async (world, admin, clock) => {
      await silence(world);
      await silence(world);
      const drawn = await admin.learning.drawSilences({ sample: 2, requestId: request() });
      const [a, b] = drawn.map((one) => one.sample);
      if (a === undefined || b === undefined) throw new Error("two samples");
      // A skip is no call at all: both stay pending.
      expect((await admin.learning.pendingSilences()).map((one) => one.sample)).toEqual([a, b]);
      await admin.learning.markViewed({ kind: "silence_sample", id: a }, "cli");
      clock.now = new Date(T0.getTime() + 30_000);
      const requestId = request();
      const ruling = await admin.learning.recordSilenceVerdict({ sample: a, verdict: "missed", requestId });
      // A repeated request returns its ruling, not a refusal.
      expect(await admin.learning.recordSilenceVerdict({ sample: a, verdict: "missed", requestId })).toBe(ruling);
      expect((await admin.learning.pendingSilences()).map((one) => one.sample)).toEqual([b]);
      expect(
        await refusedWith(() =>
          admin.learning.recordSilenceVerdict({ sample: a, verdict: "fine", requestId: request() }),
        ),
      ).toEqual({ name: "AdminError", code: "not_pending" });
      expect(
        await refusedWith(() =>
          admin.learning.recordSilenceVerdict({ sample: newId("sls"), verdict: "fine", requestId: request() }),
        ),
      ).toEqual({ name: "AdminError", code: "not_found" });
      expect(
        (await decisions(world, "silence_verdict")).map((row) => [
          row.target_kind,
          row.target_id,
          row.answer,
          row.details,
          row.card_id,
        ]),
      ).toEqual([["silence_sample", a, "missed", { hurried: false }, null]]);
    }));

  it("a verdict 1.5 seconds after the view is hurried, one 2 seconds after is not, and one with no view is", () =>
    withAdmin(async (world, admin, clock) => {
      for (let n = 0; n < 3; n += 1) await silence(world);
      const [a, b, c] = (await admin.learning.drawSilences({ sample: 3, requestId: request() })).map(
        (one) => one.sample,
      );
      if (a === undefined || b === undefined || c === undefined) throw new Error("three samples");
      await admin.learning.markViewed({ kind: "silence_sample", id: a }, "cli");
      clock.now = new Date(T0.getTime() + 1_500);
      await admin.learning.recordSilenceVerdict({ sample: a, verdict: "fine", requestId: request() });
      // An earlier view of b, then the one that showed it: the time runs from the latest.
      await admin.learning.markViewed({ kind: "silence_sample", id: b }, "cli");
      clock.now = new Date(T0.getTime() + 60_000);
      const shownB = await admin.learning.markViewed({ kind: "silence_sample", id: b }, "cli");
      clock.now = new Date(shownB.getTime() + 2_000);
      await admin.learning.recordSilenceVerdict({ sample: b, verdict: "fine", requestId: request() });
      // Never shown: not a judgment.
      await admin.learning.recordSilenceVerdict({ sample: c, verdict: "missed", requestId: request() });
      expect((await decisions(world, "silence_verdict")).map((row) => [row.target_id, row.details])).toEqual([
        [a, { hurried: true }],
        [b, { hurried: false }],
        [c, { hurried: true }],
      ]);
    }));
});
