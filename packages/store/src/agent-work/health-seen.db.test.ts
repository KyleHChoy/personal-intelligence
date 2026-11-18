import {
  AGENT_SEEN_KINDS,
  BOX_HEALTH_KINDS,
  type BoxHealthKind,
  CARD_OPTIONS,
  type CardId,
  type CoverageRow,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { closeHealth, raiseHealth } from "../core/box-health.ts";
import { newId } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { request, testId } from "../test-support/clients.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// The card must be one the caller is cleared for, of a kind that is an agent's to mark, and still
// waiting; a card of a label the caller is not cleared for is `not_found` as no card is, and changes
// nothing (invariant 6). The box's own rules raise the condition again while it holds. Synthetic
// rows only; names are examples.

const TOOLS = ["get_health", "mark_health_seen"];
const HIDDEN = "employer:example";
const MINUTE = 60_000;
const OWNERS_KINDS = BOX_HEALTH_KINDS.filter((kind) => !(AGENT_SEEN_KINDS as readonly string[]).includes(kind));

const seen = (w: WorkWorld, token: string, card: string) =>
  w.work.markHealthSeen(token, { card, requestId: request() } as never);
const raise = async (w: WorkWorld, kind: BoxHealthKind, about: string, now = new Date()): Promise<CardId> => {
  const card = await raiseHealth(w.admin, now, recordingLogger().log, kind, about);
  if (card === null) throw new Error("expected a new card");
  return card;
};
const events = (w: WorkWorld, card: string) =>
  w.admin<{ event: string; by: string; code: string | null; session_id: string | null }>(
    "select event, by, code, session_id from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
    [card],
  );
const latest = async (w: WorkWorld, card: string): Promise<string | undefined> => (await events(w, card)).at(-1)?.event;
const healthCards = async (w: WorkWorld, client: WorkClient): Promise<string[]> =>
  ok(await w.work.getHealth(client.token, {} as never)).cards.map((one) => one.card);
const asAdmin = async <T>(w: WorkWorld, now: Date, fn: (admin: Admin) => Promise<T>): Promise<T> => {
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log, now: () => now });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
};
const casesOf = async (w: WorkWorld, key: string): Promise<string[]> =>
  (
    await w.admin<{ id: string }>(
      "select id from ledger.cards where kind = 'box_health' and case_key = $1 order by created_at, id",
      [key],
    )
  ).map((row) => row.id);

describe("mark_health_seen", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent cleared for a box health card marks it seen: one event by the agent, no ruling of the owner's, and pia status names it", () =>
    withWorkWorld(async (w) => {
      const mender = await w.client("mender", ["own"], { tools: TOOLS });
      const other = await w.client("other", ["own"], { tools: TOOLS });
      const card = await raise(w, "failure_streak", "extract");
      const rulings = async () =>
        Number((await w.admin<{ n: string }>("select count(*) as n from knowledge.owner_decisions"))[0]?.n);
      const before = await rulings();
      expect(await healthCards(w, mender)).toEqual([card]);

      const done = ok(await seen(w, mender.token, card));
      expect(done.card).toBe(card);
      const last = (await events(w, card)).at(-1);
      expect(last).toMatchObject({ event: "decided", by: `client:${mender.id}`, code: "agent_seen" });
      expect(last?.session_id).not.toBeNull();
      expect(await rulings()).toBe(before);
      expect(await healthCards(w, mender)).toEqual([]);

      // A repeat by the same agent: the same time, nothing written.
      const count = (await events(w, card)).length;
      expect(ok(await seen(w, mender.token, card))).toEqual(done);
      expect((await events(w, card)).length).toBe(count);
      // Another agent finds it no longer waits.
      expect(await seen(w, other.token, card)).toMatchObject({ ok: false, code: "not_found", refusal: "card_closed" });

      // The owner's status names the agent and the card.
      const status = await asAdmin(w, new Date(), (admin) => admin.accounts.status({ tables: "estimate" }));
      expect(status.boxHealthSeen).toEqual([
        { card, kind: "failure_streak", about: "extract", client: "mender", at: done.seenAt },
      ]);
    }));

  it("a client not cleared for the card's label is told not_found, as for no card, and nothing changes; one cleared marks it", () =>
    withWorkWorld(
      async (w) => {
        const narrow = await w.client("narrow", ["own"], { tools: TOOLS });
        const wide = await w.client("wide", ["own", HIDDEN], { tools: TOOLS });
        // A box health card as raiseHealth raises one, under employer:example: the product raises
        // them under `own` alone, so this is the twin of a row only a later change could write.
        const hidden = await raiseCard(
          w.admin,
          {
            id: newId("crd") as CardId,
            requestId: newId("crd"),
            kind: "box_health",
            author: "system:health",
            options: [...CARD_OPTIONS.box_health],
            target: null,
            refs: [],
            compartments: [HIDDEN] as never,
            expiresAt: null,
            expiresAfterDays: null,
            caseKey: "box:failure_streak:extract",
            run: null,
            body: null,
            bodyFrom: null,
          },
          { now: new Date(), log: recordingLogger().log },
        );
        const before = await events(w, hidden.id);
        const absent = `crd_${testId("x").slice(-26)}`;
        const refused = await seen(w, narrow.token, hidden.id);
        expect(refused).toEqual({ ok: false, code: "not_found" });
        expect(JSON.stringify(refused)).toBe(JSON.stringify(await seen(w, narrow.token, absent)));
        expect(await events(w, hidden.id)).toEqual(before);
        expect(await latest(w, hidden.id)).toBe("pending");

        // The control: a client cleared for the label marks it.
        ok(await seen(w, wide.token, hidden.id));
        expect((await events(w, hidden.id)).at(-1)).toMatchObject({ event: "decided", by: `client:${wide.id}` });
      },
      ["own", HIDDEN],
    ));

  it("another kind of card is not_found, its answer unchanged; a client without the tool is not permitted", () =>
    withWorkWorld(async (w) => {
      const mender = await w.client("mender", ["own"], { tools: TOOLS });
      const reader = await w.client("reader", ["own"], { tools: ["get_health"] });
      const drift = await raiseCard(
        w.admin,
        {
          id: newId("crd") as CardId,
          requestId: newId("crd"),
          kind: "calibration_drift",
          author: "system:calibration",
          options: [...CARD_OPTIONS.calibration_drift],
          target: { kind: "report", id: testId("rpt") },
          refs: [],
          compartments: ["own"] as never,
          expiresAt: null,
          expiresAfterDays: null,
          caseKey: "drift:example:1",
          run: null,
          body: null,
          bodyFrom: null,
        },
        { now: new Date(), log: recordingLogger().log },
      );
      const before = await events(w, drift.id);
      expect(await seen(w, mender.token, drift.id)).toEqual({ ok: false, code: "not_found" });
      expect(await events(w, drift.id)).toEqual(before);

      const card = await raise(w, "timed_out", "extract");
      expect(await seen(w, reader.token, card)).toMatchObject({ ok: false, code: "not_permitted" });
      expect(await latest(w, card)).toBe("pending");
      expect(await seen(w, mender.token, "not-a-card")).toMatchObject({ ok: false, code: "invalid_request" });
    }));

  it("each agent's kind is marked; each of the owner's kinds, and a card the owner deferred, is owners_card", () =>
    withWorkWorld(async (w) => {
      const mender = await w.client("mender", ["own"], { tools: TOOLS });
      for (const kind of AGENT_SEEN_KINDS) {
        const card = await raise(w, kind, `example_${kind}`);
        expect(await seen(w, mender.token, card), kind).toMatchObject({ ok: true });
      }
      expect(OWNERS_KINDS.length).toBeGreaterThan(0);
      for (const kind of OWNERS_KINDS) {
        const card = await raise(w, kind, `example_${kind}`);
        expect(await seen(w, mender.token, card), kind).toMatchObject({
          ok: false,
          code: "not_found",
          refusal: "owners_card",
        });
        expect(await latest(w, card), kind).toBe("pending");
      }
      const deferred = await raise(w, "stores_nothing", "example_deferred");
      await w.status("card", deferred, "deferred", "owner");
      expect(await seen(w, mender.token, deferred)).toMatchObject({
        ok: false,
        code: "not_found",
        refusal: "owners_card",
      });
      expect(await latest(w, deferred)).toBe("deferred");
      // A card code withdrew no longer waits.
      const mended = await raise(w, "timed_out", "example_mended");
      await closeHealth(w.admin, new Date(), "timed_out", "example_mended");
      expect(await seen(w, mender.token, mended)).toMatchObject({
        ok: false,
        code: "not_found",
        refusal: "card_closed",
      });
    }));

  it("a failure streak an agent marked seen is raised again while it holds, and that card is the owner's", () =>
    withWorkWorld(async (w) => {
      const mender = await w.client("mender", ["own"], { tools: TOOLS });
      const start = new Date();
      const at = (minutes: number): Date => new Date(start.getTime() + minutes * MINUTE);
      const failed = (minutes: number) =>
        asAdmin(w, at(minutes + 1), (admin) =>
          admin.box.recordJob({ job: "extract", code: "failed", startedAt: at(minutes) } as never),
        );
      for (const minutes of [0, 2, 4]) await failed(minutes);
      const key = "box:failure_streak:extract";
      const [first] = await casesOf(w, key);
      if (first === undefined) throw new Error("expected a streak card");
      ok(await seen(w, mender.token, first));

      // Three more failures: within the day, nothing; a day after the seen, the card again.
      for (const minutes of [10, 12, 14]) await failed(minutes);
      expect(await casesOf(w, key)).toEqual([first]);
      await asAdmin(w, at(25 * 60), (admin) => admin.box.recordCoverage([]));
      const again = await casesOf(w, key);
      expect(again).toHaveLength(2);
      const second = again[1] as string;
      expect(await seen(w, mender.token, second)).toMatchObject({
        ok: false,
        code: "not_found",
        refusal: "came_back_after_seen",
      });
      expect(await latest(w, second)).toBe("pending");
    }));

  it("a silent row an agent marked seen rests a day, then is raised again while still silent; a card after one code withdrew is the agent's", () =>
    withWorkWorld(async (w) => {
      const mender = await w.client("mender", ["own"], { tools: TOOLS });
      const start = new Date();
      await asAdmin(w, start, (admin) => admin.box.backupTaken());
      const silent: CoverageRow = { kind: "job", id: "sync", state: "silent", code: "sync_gap", counts: {} };
      const covered: CoverageRow = { kind: "job", id: "sync", state: "covered", counts: {} };
      const record = (minutes: number, row: CoverageRow) =>
        asAdmin(w, new Date(start.getTime() + minutes * MINUTE), (admin) => admin.box.recordCoverage([row]));
      const key = "box:silent:job/sync";

      await record(0, silent);
      const [first] = await casesOf(w, key);
      if (first === undefined) throw new Error("expected a silent card");
      ok(await seen(w, mender.token, first));
      await record(23 * 60, silent);
      expect(await casesOf(w, key)).toEqual([first]);
      // The seen was written at the database's time, just after start: a day and an hour on, raised.
      await record(25 * 60, silent);
      const [, second] = await casesOf(w, key);
      if (second === undefined) throw new Error("expected the silent card again");
      expect(await seen(w, mender.token, second)).toMatchObject({
        ok: false,
        code: "not_found",
        refusal: "came_back_after_seen",
      });

      // It mends (code withdraws the card), and later enters silent again: that card is the agent's.
      await record(26 * 60, covered);
      expect(await latest(w, second)).toBe("withdrawn");
      await record(26 * 60 + 5, silent);
      await record(51 * 60, silent);
      const third = (await casesOf(w, key))[2];
      if (third === undefined) throw new Error("expected a third silent card");
      ok(await seen(w, mender.token, third));
    }));
});
