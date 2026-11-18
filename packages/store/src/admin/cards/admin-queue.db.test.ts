import { randomBytes } from "node:crypto";
import { CardDetail, type CardId, CardView, type NewCard } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { codeOf, one } from "../../test-support/connections.ts";
import { adminRows as rows } from "../../test-support/database.ts";
import { namesSealed, recordingPool } from "../../test-support/recording.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { daysFrom } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

// The admin's queue.

const TIMEOUT = 120_000;
const T0 = new Date("2026-09-15T12:00:00.000Z");
const AUTHOR = "system:test";

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

const notice = (over: Partial<NewCard> = {}): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestId(),
  kind: "notice",
  author: AUTHOR,
  options: ["acknowledge"],
  target: null,
  refs: [],
  compartments: ["own"],
  expiresAt: null,
  expiresAfterDays: null,
  caseKey: null,
  run: null,
  body: null,
  bodyFrom: null,
  ...over,
});

// The admin of `store` with its clock at `now`, and optionally other keys.
const adminAt = (store: TestStore, now: Date, keys: Keys = store.db.keys, pool: pg.Pool = store.adminPool): Admin =>
  new Admin({ pool, keys, log: store.log, now: () => now });

// A card deferred at `at`, as a hold for a name defers one.
const defer = (store: TestStore, id: CardId, at: Date): Promise<unknown> =>
  rows(
    store,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'deferred', $2, 'system:names', '{own}')",
    [id, at],
  );

const stateOf = async (store: TestStore, id: CardId): Promise<string> =>
  one(
    await rows<{ event: string }>(
      store,
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [id],
    ),
  ).event;

const decisions = (store: TestStore) =>
  rows<{ n: number }>(store, "select count(*)::int as n from knowledge.owner_decisions").then((list) => one(list).n);

const withQueue = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

const decide = (admin: Admin, cards: CardId[], answer = "acknowledge") =>
  admin.cards.decide({ cards, answer, requestId: requestId() });

describe("the queue", { timeout: TIMEOUT }, () => {
  it("an answer's row names the card and the card's target", () =>
    withQueue(async (store) => {
      const about = await store.admin.cards.raiseCard(notice());
      const made = notice({ target: { kind: "card", id: about.id }, compartments: ["employer:example", "own"] });
      await store.admin.cards.raiseCard(made);
      const [ruled] = await decide(store.admin, [made.id]);
      expect(ruled?.card).toBe(made.id);
      expect(
        await rows(
          store,
          "select id, kind, target_kind, target_id, answer, card_id, supersedes, batch, labels, details, compartments, body_enc from knowledge.owner_decisions",
        ),
      ).toEqual([
        {
          id: ruled?.ruling,
          kind: "answer",
          target_kind: "card",
          target_id: about.id,
          answer: "acknowledge",
          card_id: made.id,
          supersedes: null,
          batch: false,
          labels: [],
          details: {},
          compartments: ["employer:example", "own"],
          body_enc: null,
        },
      ]);
      expect(await stateOf(store, made.id)).toBe("decided");
    }));

  it("a repeated decision writes one row and returns the first ruling", () =>
    withQueue(async (store) => {
      const made = notice();
      await store.admin.cards.raiseCard(made);
      const args = { cards: [made.id], answer: "acknowledge", requestId: requestId() };
      const first = await store.admin.cards.decide(args);
      expect(await store.admin.cards.decide(args)).toEqual(first);
      expect(await decisions(store)).toBe(1);
      expect(
        one(
          await rows<{ n: number }>(
            store,
            "select count(*)::int as n from ledger.record_events where row_id = $1 and event = 'decided'",
            [made.id],
          ),
        ).n,
      ).toBe(1);
    }));

  it("an answer outside the card's options is refused", () =>
    withQueue(async (store) => {
      const made = notice();
      await store.admin.cards.raiseCard(made);
      expect(await codeOf(() => decide(store.admin, [made.id], "reject"))).toBe("invalid_answer");
      expect(await decisions(store)).toBe(0);
      // The positive control.
      await decide(store.admin, [made.id]);
      expect(await decisions(store)).toBe(1);
    }));

  it("a decided card is refused", () =>
    withQueue(async (store) => {
      const made = notice();
      await store.admin.cards.raiseCard(made);
      await decide(store.admin, [made.id]);
      expect(await codeOf(() => decide(store.admin, [made.id]))).toBe("not_pending");
      expect(await decisions(store)).toBe(1);
    }));

  it("a card past its expiry is refused", () =>
    withQueue(async (store) => {
      const past = notice({ expiresAt: daysFrom(T0, 1).toISOString() });
      const later = notice({ expiresAt: daysFrom(T0, 3).toISOString() });
      await store.admin.cards.raiseCard(past);
      await store.admin.cards.raiseCard(later);
      const at = adminAt(store, daysFrom(T0, 2));
      expect(await codeOf(() => decide(at, [past.id]))).toBe("not_pending");
      // The positive control: one whose moment has not come.
      expect(await decide(at, [later.id])).toHaveLength(1);
    }));

  it("a tainted card is refused, and so is one whose target is a tainted ledger row", () =>
    withQueue(async (store) => {
      const entity = newId("ent");
      const about = notice({ target: { kind: "entity", id: entity } as NewCard["target"] });
      await store.admin.cards.raiseCard(about);
      const onTarget = notice({ target: { kind: "card", id: about.id } });
      await store.admin.cards.raiseCard(onTarget);
      const control = notice();
      await store.admin.cards.raiseCard(control);
      // The entity goes: the card about it is tainted, and the card about that card with it.
      await rows(store, "select ledger.taint_citing('{}', array['entity'], array[$1])", [entity]);
      expect(await codeOf(() => decide(store.admin, [about.id]))).toBe("not_pending");
      expect(await codeOf(() => decide(store.admin, [onTarget.id]))).toBe("not_pending");
      expect(await decide(store.admin, [control.id])).toHaveLength(1);
    }));

  it("one refused card refuses the command", () =>
    withQueue(async (store) => {
      const good = notice();
      const done = notice();
      await store.admin.cards.raiseCard(good);
      await store.admin.cards.raiseCard(done);
      await decide(store.admin, [done.id]);
      expect(await codeOf(() => decide(store.admin, [good.id, done.id]))).toBe("not_pending");
      expect(await stateOf(store, good.id)).toBe("pending");
      expect(await decisions(store)).toBe(1);
    }));

  it("a card that counts its expiry in days is refused once that many days have passed since it became pending, and not before, however long it was deferred", () =>
    withQueue(async (store) => {
      // A card raised 20 days ago and deferred then (held for a name), and another of its author's.
      const ago = daysFrom(new Date(), -20);
      const old = adminAt(store, ago);
      const first = (await old.cards.raiseCard(notice())).id;
      const waiting = notice({ expiresAfterDays: 14 });
      await old.cards.raiseCard(waiting);
      await defer(store, waiting.id, ago);

      // A decision now admits it: its 14 days start now.
      expect(await decide(adminAt(store, new Date()), [first])).toHaveLength(1);
      expect(await stateOf(store, waiting.id)).toBe("pending");
      const admitted = one(
        await rows<{ at: Date }>(
          store,
          "select at from ledger.record_events where row_id = $1 and event = 'pending' order by id desc limit 1",
          [waiting.id],
        ),
      ).at;
      expect(await codeOf(() => decide(adminAt(store, daysFrom(admitted, 14.01)), [waiting.id]))).toBe("not_pending");
      expect(await decide(adminAt(store, daysFrom(admitted, 13.99)), [waiting.id])).toHaveLength(1);
    }));

  it("two cards in one command are marked batch, and a decision records the queue depth", () =>
    withQueue(async (store) => {
      const [a, b, c] = [notice(), notice(), notice()];
      for (const made of [a, b, c]) await store.admin.cards.raiseCard(made);
      await decide(store.admin, [a.id]);
      await decide(store.admin, [b.id, c.id]);
      expect(
        await rows(
          store,
          "select card_id, batch, queue_depth from knowledge.owner_decisions order by decided_at, queue_depth desc",
        ),
      ).toEqual([
        { card_id: a.id, batch: false, queue_depth: 3 },
        { card_id: b.id, batch: true, queue_depth: 2 },
        { card_id: c.id, batch: true, queue_depth: 1 },
      ]);
    }));

  it("no cap defers a card, and deciding one admits every deferred card of its author", () =>
    withQueue(async (store) => {
      const pending: CardId[] = [];
      for (let n = 0; n < 12; n += 1) {
        const raised = await store.admin.cards.raiseCard(notice());
        expect(raised.state).toBe("pending");
        pending.push(raised.id);
      }
      const older = notice();
      const newer = notice();
      await adminAt(store, daysFrom(T0, 1)).cards.raiseCard(older);
      await adminAt(store, daysFrom(T0, 2)).cards.raiseCard(newer);
      await defer(store, older.id, daysFrom(T0, 1));
      await defer(store, newer.id, daysFrom(T0, 2));
      await decide(store.admin, [pending[0] as CardId]);
      expect([await stateOf(store, older.id), await stateOf(store, newer.id)]).toEqual(["pending", "pending"]);
    }));

  it("a card deferred for 20 days and then admitted expires 14 days after it was admitted", () =>
    withQueue(async (store) => {
      const ago = daysFrom(new Date(), -20);
      const old = adminAt(store, ago);
      const first = (await old.cards.raiseCard(notice())).id;
      const waiting = notice({ expiresAfterDays: 14 });
      await old.cards.raiseCard(waiting);
      await defer(store, waiting.id, ago);
      await decide(adminAt(store, new Date()), [first]);
      // Listed with its expiry counted from its admission, not from when it was raised.
      const admitted = one(
        await rows<{ at: Date }>(
          store,
          "select at from ledger.record_events where row_id = $1 and event = 'pending' order by id desc limit 1",
          [waiting.id],
        ),
      ).at;
      const listed = (await adminAt(store, new Date()).cards.listPending({ limit: 50 })).find(
        (view) => view.id === waiting.id,
      );
      expect(listed?.expiresAt).toBe(daysFrom(admitted, 14).toISOString());
      expect(await codeOf(() => decide(adminAt(store, daysFrom(admitted, 14)), [waiting.id]))).toBe("not_pending");
    }));

  it("a decide and an expiry of one card at once leave one outcome", () =>
    withQueue(async (store) => {
      // What the durable work tick does when it expires a card: the card's locks, its state,
      // `expired`, and the author's admission, in one transaction.
      const expire = async (client: pg.Client, id: CardId): Promise<boolean> => {
        await client.query("select ledger.lock_rows($1)", [[id, `author:${AUTHOR}`]]);
        const {
          rows: [latest],
        } = await client.query<{ event: string }>(
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [id],
        );
        if (latest?.event !== "pending") return false;
        await client.query(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'expired', now(), 'system:tick', '{own}')",
          [id],
        );
        await client.query("select ledger.admit_deferred($1)", [AUTHOR]);
        return true;
      };
      // Until the connection `pid` waits for a lock; or, with no pid, until some pi_admin
      // connection to this database other than `others` does, whose pid it returns.
      const waiter = async (others: number[], pid?: number): Promise<number> => {
        for (let tries = 0; tries < 400; tries += 1) {
          const [row] = await rows<{ pid: number }>(
            store,
            "select l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.usename = 'pi_admin' and a.datname = current_database() and not (l.pid = any($1)) and ($2::int is null or l.pid = $2) limit 1",
            [others, pid ?? null],
          );
          if (row !== undefined) return row.pid;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("no connection waited");
      };
      const clients = [new pg.Client(store.db.urls.admin), new pg.Client(store.db.urls.admin)];
      for (const client of clients) await client.connect();
      try {
        const [holder, other] = clients as [pg.Client, pg.Client];
        const pidOf = async (client: pg.Client) =>
          one((await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows).pid;
        const [holderPid, otherPid] = [await pidOf(holder), await pidOf(other)];

        // The expiry holds the card's lock and writes `expired`; the decide waits, then finds it
        // expired.
        const first = notice();
        await store.admin.cards.raiseCard(first);
        await holder.query("begin");
        expect(await expire(holder, first.id)).toBe(true);
        const deciding = codeOf(() => decide(store.admin, [first.id]));
        await waiter([holderPid, otherPid]);
        await holder.query("commit");
        expect(await deciding).toBe("not_pending");
        expect(await stateOf(store, first.id)).toBe("expired");

        // The other way round: a third transaction holds the lock, the decide queues first and
        // the expiry second; the expiry then finds the card decided and writes nothing.
        const second = notice();
        await store.admin.cards.raiseCard(second);
        await holder.query("begin");
        await holder.query("select ledger.lock_rows($1)", [[second.id]]);
        const decided = decide(store.admin, [second.id]);
        await waiter([holderPid, otherPid]);
        await other.query("begin");
        const expiring = expire(other, second.id);
        await waiter([], otherPid);
        await holder.query("commit");
        expect(await decided).toHaveLength(1);
        expect(await expiring).toBe(false);
        await other.query("commit");
        expect(await stateOf(store, second.id)).toBe("decided");
        expect(
          one(
            await rows<{ n: number }>(
              store,
              "select count(*)::int as n from ledger.record_events where row_id = $1 and event = 'expired'",
              [second.id],
            ),
          ).n,
        ).toBe(0);
      } finally {
        for (const client of clients) await client.end();
      }
    }));

  it("review opens no sealed value", () =>
    withQueue(async (store) => {
      await store.admin.cards.raiseCard(notice({ body: "canary-review-body", bodyFrom: "model" }));
      const recorded = recordingPool(store.adminPool);
      const listed = await adminAt(store, T0, store.db.keys, recorded.pool).cards.listPending({});
      expect(listed).toHaveLength(1);
      expect(CardView.array().parse(listed)).toEqual(listed);
      expect(recorded.statements.length).toBeGreaterThan(0);
      expect(recorded.statements.filter(namesSealed)).toEqual([]);
    }));

  it("a card's body line is marked with who wrote it, and a model's line is never marked code", () =>
    withQueue(async (store) => {
      const byModel = notice({ body: "canary-model-line", bodyFrom: "model" });
      const byCode = notice({ body: "canary-code-line", bodyFrom: "code" });
      await store.admin.cards.raiseCard(byModel);
      await store.admin.cards.raiseCard(byCode);
      const model = await store.admin.cards.card(byModel.id);
      expect(CardDetail.parse(model)).toEqual(model);
      expect(model?.lines.filter((line) => line.text === "canary-model-line")).toEqual([
        { text: "canary-model-line", from: "model" },
      ]);
      expect(model?.lines.filter((line) => line.from === "code").some((line) => line.text.includes("canary"))).toBe(
        false,
      );
      expect((await store.admin.cards.card(byCode.id))?.lines.at(-1)).toEqual({
        text: "canary-code-line",
        from: "code",
      });
      expect(await store.admin.cards.card(newId("crd") as CardId)).toBeNull();
    }));

  it("a card whose compartment key is missing is shown with body_unreadable and can be decided", () =>
    withQueue(async (store) => {
      const made = notice({ body: "canary-unreadable", bodyFrom: "model", compartments: ["employer:example", "own"] });
      await store.admin.cards.raiseCard(made);
      const ownOnly: Keys = {
        ...store.db.keys,
        compartments: new Map([...store.db.keys.compartments].filter(([name]) => name === "own")),
      };
      const lacking = adminAt(store, T0, ownOnly);
      const shown = await lacking.cards.card(made.id);
      expect(shown?.lines.at(-1)).toEqual({
        text: "body_unreadable",
        from: "code",
        key: "unreadable",
        value: [{ kind: "code", code: "body" }],
      });
      expect(JSON.stringify(shown)).not.toContain("canary-unreadable");
      // The positive control: the whole key file opens it.
      expect((await store.admin.cards.card(made.id))?.lines.at(-1)).toEqual({
        text: "canary-unreadable",
        from: "model",
      });
      const [ruled] = await lacking.cards.decide({ cards: [made.id], answer: "acknowledge", requestId: requestId() });
      expect(ruled?.ruling).toMatch(/^rul_/);
      expect(await stateOf(store, made.id)).toBe("decided");
    }));
});
