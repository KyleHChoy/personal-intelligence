import { randomBytes } from "node:crypto";
import { type CardId, CardsWithLines, type NewCard } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import { one } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { noticeCard as notice } from "../../test-support/new-card.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { Admin } from "../admin.ts";

// Made-up values only.

const TIMEOUT = 120_000;
const T0 = new Date("2026-10-29T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

const adminAt = (store: TestStore, now: Date): Admin =>
  new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, now: () => now });

const count = async (store: TestStore, table: string): Promise<number> =>
  one(await queryAs<{ n: number }>(store.db.urls.admin, `select count(*)::int as n from ${table}`)).n;

const withStore = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

describe("R-T5: cards with lines", { timeout: TIMEOUT }, () => {
  it("lists the pending, unexpired cards oldest first with their lines, pages them, and records no view until one is opened", () =>
    withStore(async (store) => {
      // Four pending cards a minute apart, one of them with a model's body; a fifth decided and a
      // sixth expired, which the read leaves out.
      const made: NewCard[] = [];
      for (let n = 0; n < 4; n += 1) {
        const card = notice(n === 1 ? { body: "canary-waiting-line", bodyFrom: "model" } : {});
        await adminAt(store, new Date(T0.getTime() + n * MINUTE)).cards.raiseCard(card);
        made.push(card);
      }
      const decided = notice();
      await adminAt(store, new Date(T0.getTime() + 5 * MINUTE)).cards.raiseCard(decided);
      await store.admin.cards.decide({ cards: [decided.id], answer: "acknowledge", requestId: requestId() });
      const expired = notice({
        expiresAt: new Date(T0.getTime() + 6 * MINUTE + DAY).toISOString() as NewCard["expiresAt"],
      });
      await adminAt(store, new Date(T0.getTime() + 6 * MINUTE)).cards.raiseCard(expired);

      const later = adminAt(store, new Date(T0.getTime() + 2 * DAY));
      const events = await count(store, "ledger.record_events");

      const first = await later.cards.withLines({ limit: 3 });
      expect(CardsWithLines.parse(first)).toEqual(first);
      expect(first.cards.map((card) => card.id)).toEqual(made.slice(0, 3).map((card) => card.id));
      expect(first.cards.every((card) => card.state === "pending" && card.options.join() === "acknowledge")).toBe(true);
      expect(first.cards[1]?.lines.at(-1)).toEqual({ text: "canary-waiting-line", from: "model" });
      expect(first.next).not.toBeNull();
      const second = await later.cards.withLines({ limit: 3, cursor: first.next ?? undefined });
      expect(second.cards.map((card) => card.id)).toEqual([made[3]?.id]);
      expect(second.next).toBeNull();

      // W8: listing opened nothing. No view row, and nothing else written to the ledger.
      expect(await count(store, "ledger.owner_views")).toBe(0);
      expect(await count(store, "ledger.record_events")).toBe(events);

      // The owner opens one: `card` shows the same lines and records exactly that card's view.
      const opened = await later.cards.card(made[1]?.id as CardId, { view: "web" });
      expect(opened?.lines).toEqual(first.cards[1]?.lines);
      expect(
        await queryAs(store.db.urls.admin, "select target_kind, target_id, surface from ledger.owner_views"),
      ).toEqual([{ target_kind: "card", target_id: made[1]?.id, surface: "web" }]);
      // Listing again still records nothing more.
      await later.cards.withLines({});
      expect(await count(store, "ledger.owner_views")).toBe(1);
    }));

  it("refuses a cursor the read did not issue", () =>
    withStore(async (store) => {
      await store.admin.cards.raiseCard(notice());
      const made = (place: unknown[]): string => Buffer.from(JSON.stringify(place)).toString("base64url");
      const id = newId("crd");
      const foreign = [
        made(["not-a-time", id]),
        // Times Date.parse takes and Postgres would not, and a date that does not exist.
        made(["1", id]),
        made(["+275760-09-13T00:00:00Z", id]),
        made(["2026-02-30T00:00:00.000000Z", id]),
        // A well-formed time with an id that is no card's.
        made(["2026-10-29T12:00:00.000000Z", "zzz"]),
        made([1, 2]),
        "garbage",
      ];
      for (const cursor of foreign) {
        await expect(store.admin.cards.withLines({ cursor })).rejects.toMatchObject({ code: "invalid_argument" });
      }
      // The control: no cursor reads the first page.
      expect((await store.admin.cards.withLines({})).cards).toHaveLength(1);
    }));
});
