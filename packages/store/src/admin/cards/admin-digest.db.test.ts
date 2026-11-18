import { randomBytes } from "node:crypto";
import type { RawItem, Timestamp } from "@intelligence/contracts";
import { type CardId, Digest, type NewCard } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import { OWNER } from "../../test-support/cast.ts";
import { queryAs, type TestDatabase } from "../../test-support/database.ts";
import { derive, type MailFixture, mail, mailItem } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { batchOf, stored, withPipeline } from "../../test-support/pipeline-fixtures.ts";
import { namesSealed, recordingLogger, recordingPool } from "../../test-support/recording.ts";
import type { Writer } from "../../write/writer.ts";
import type { SourceAccountRow } from "../../write/writer-types.ts";
import { Admin } from "../admin.ts";

const TIMEOUT = 120_000;
const T0 = new Date("2026-09-15T12:00:00.000Z");
const DAY_MS = 86_400_000;

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

const notice = (author: string): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestId(),
  kind: "notice",
  author,
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
});

const adminOf = (db: TestDatabase, pool: pg.Pool, now: Date): Admin =>
  new Admin({ pool, keys: db.keys, log: recordingLogger().log, now: () => now });

async function withAdmin<T>(db: TestDatabase, now: Date, fn: (admin: Admin, pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  try {
    return await fn(adminOf(db, pool, now), pool);
  } finally {
    await pool.end();
  }
}

// A card of a kind no step has registered yet, written as pi_admin, pending since `at`: the
// digest counts every kind the ledger holds, not only the kinds this build knows.
async function otherKind(db: TestDatabase, at: Date): Promise<CardId> {
  const id = newId("crd") as CardId;
  await queryAs(
    db.urls.admin,
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments)
     values ($1, $2, $3, 'system:test', 'proposal', '{acknowledge}', ledger.label('{own}'))`,
    [id, requestId(), at],
  );
  await queryAs(
    db.urls.admin,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:test', ledger.label('{own}'))",
    [id, at],
  );
  return id;
}

const ME = { address: OWNER.personal, name: OWNER.name };
const SENDER = { address: "pippa@quayside.test", name: "Pippa Quayside" };

// A message held by the recovery markers, stored through the writer.
async function heldMessage(writer: Writer, account: SourceAccountRow, id: string): Promise<void> {
  const fixture: MailFixture = mail({
    id,
    threadId: `thread-${id}`,
    at: T0.toISOString() as Timestamp,
    from: SENDER,
    to: [ME],
    subject: `Your sign-in code ${id}`,
    labels: ["INBOX"],
    held: true,
    text: "Your code is 000000.",
  });
  const raw: RawItem = mailItem(fixture, account);
  await writer.ingestItem(account, raw, (ctx) => derive(raw, ctx));
}

describe("the digest", { timeout: TIMEOUT }, () => {
  it("the digest counts pending cards by kind, deferred cards, held messages and withheld items", () =>
    withPipeline(async ({ db, writer, pipeline, accounts }) => {
      await withAdmin(db, T0, async (admin) => {
        // Nothing waits: every count is zero, and no kind is listed.
        expect(await admin.cards.digest()).toEqual({
          pending: {},
          deferred: 0,
          oldestPendingDays: null,
          heldMessages: 0,
          withheldItems: 0,
        });

        // Ten notices of one author, pending; one is decided, so it counts no more. Two more notices
        // are pending too; the second is then deferred, as a hold for a name defers one.
        const raised = [];
        for (let n = 0; n < 10; n += 1) raised.push(await admin.cards.raiseCard(notice("system:test")));
        expect(raised.every((one) => one.state === "pending")).toBe(true);
        await admin.cards.decide({ cards: [raised[0]?.id as CardId], answer: "acknowledge", requestId: requestId() });
        const later = [
          await admin.cards.raiseCard(notice("system:test")),
          await admin.cards.raiseCard(notice("system:test")),
        ];
        expect(later.map((one) => one.state)).toEqual(["pending", "pending"]);
        await queryAs(
          db.urls.admin,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'deferred', $2, 'system:names', ledger.label('{own}'))",
          [later[1]?.id, T0],
        );
        await otherKind(db, T0);

        // Two held messages, one not held; one withheld item, one done.
        await heldMessage(writer, accounts.personalMail, "gm-digest-held-1");
        await heldMessage(writer, accounts.personalMail, "gm-digest-held-2");
        const withheld = await stored(writer, accounts.personalMail, MAIL.canary);
        const done = await stored(writer, accounts.personalMail, MAIL.solo);
        expect(await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "sensitive" }))).toBe(
          "committed",
        );
        expect(await pipeline.commit(batchOf(done, []))).toBe("committed");

        const digest = await admin.cards.digest();
        expect(Digest.parse(digest)).toEqual(digest);
        expect(digest).toEqual({
          pending: { notice: 10, proposal: 1 },
          deferred: 1,
          oldestPendingDays: 0,
          heldMessages: 2,
          withheldItems: 1,
        });
      });
    }));

  it("its oldest age is in whole days, and null with no pending card", () =>
    withPipeline(async ({ db }) => {
      await withAdmin(db, T0, async (admin) => {
        expect((await admin.cards.digest()).oldestPendingDays).toBeNull();
        // Pending since three and a half days before now, and a newer one: the oldest counts, in whole days.
        await otherKind(db, new Date(T0.getTime() - 3.5 * DAY_MS));
        await otherKind(db, new Date(T0.getTime() - DAY_MS));
        expect((await admin.cards.digest()).oldestPendingDays).toBe(3);
      });
      // Just under four days later by the admin's clock, still three.
      await withAdmin(db, new Date(T0.getTime() + 0.49 * DAY_MS), async (admin) => {
        expect((await admin.cards.digest()).oldestPendingDays).toBe(3);
      });
      await withAdmin(db, new Date(T0.getTime() + 0.5 * DAY_MS), async (admin) => {
        expect((await admin.cards.digest()).oldestPendingDays).toBe(4);
      });
    }));

  it("it selects no _enc column, in one transaction", () =>
    withPipeline(async ({ db, writer, accounts }) => {
      await withAdmin(db, T0, async (admin, pool) => {
        await admin.cards.raiseCard({ ...notice("system:test"), body: "canary-digest-body", bodyFrom: "model" });
        await heldMessage(writer, accounts.personalMail, "gm-digest-held-3");
        const recorded = recordingPool(pool);
        const digest = await adminOf(db, recorded.pool, T0).cards.digest();
        expect(digest).toEqual({
          pending: { notice: 1 },
          deferred: 0,
          oldestPendingDays: 0,
          heldMessages: 1,
          withheldItems: 0,
        });
        expect(JSON.stringify(digest)).not.toContain("canary");
        expect(recorded.statements.filter(namesSealed)).toEqual([]);
        // One transaction of three counting statements, one pass over the cards.
        const counting = recorded.statements.filter(
          (text) => !/^(begin|commit|rollback|set |select set_config)/i.test(text.trim()),
        );
        expect(counting).toHaveLength(3);
        expect(counting.filter((text) => text.includes("ledger.cards"))).toHaveLength(1);
      });
    }));
});
