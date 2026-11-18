import { randomBytes } from "node:crypto";
import type { RawItem } from "@intelligence/contracts";
import type { MessageId, PersonalLogEvent, RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { connect, OWNER, type Who } from "../test-support/cast.ts";
import { codeOf, committedAs, one, type Query } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../test-support/database.ts";
import { derive, mail, mailItem, NOW } from "../test-support/items.ts";
import { noticeCard as notice } from "../test-support/new-card.ts";
import { withStore } from "../test-support/store.ts";
import type { Writer } from "../write/writer.ts";
import { newId } from "./ids.ts";
import { type Decision, lockRows, raiseCard, vetoed, vetoedBy, writeDecision } from "./queue.ts";
import { open, type Sealed } from "./seal.ts";

const TIMEOUT = 120_000;
const AT = new Date(NOW);
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

// One committed pi_admin transaction.
const asAdmin = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> => committedAs(db.urls.admin, fn);

// A query that keeps every statement it sends.
function recording(query: Query): { query: Query; sent: { text: string; values: unknown[] }[] } {
  const sent: { text: string; values: unknown[] }[] = [];
  return {
    sent,
    query: (text, values = []) => {
      sent.push({ text, values });
      return query(text, values);
    },
  };
}

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string): Promise<number> =>
  one(await admin<{ n: number }>(db, `select count(*)::int as n from ${table}`)).n;
const states = async (db: TestDatabase, author: string): Promise<Record<string, number>> => {
  const rows = await admin<{ state: string; n: number }>(
    db,
    `select (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state, count(*)::int as n
     from ledger.cards c where c.created_by = $1 group by 1`,
    [author],
  );
  return Object.fromEntries(rows.map((row) => [row.state, row.n]));
};

// One message from Pippa, stored, and its id.
async function aMessage(db: TestDatabase, writer: Writer): Promise<MessageId> {
  const { personalMail } = await connect(writer);
  const fixture = mail({
    id: "queue-pippa-1",
    threadId: "thread-queue-pippa-1",
    at: NOW,
    from: PIPPA,
    to: [{ address: OWNER.personal }],
    subject: "Hello",
    labels: ["INBOX"],
  });
  const raw: RawItem = mailItem(fixture, personalMail);
  await writer.ingestItem(personalMail, raw, (ctx) => derive(raw, ctx));
  return one(await admin<{ id: MessageId }>(db, "select id from knowledge.messages")).id;
}

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: newId("rul") as RulingId,
  requestId: requestId(),
  kind: "release",
  target: null,
  answer: null,
  card: null,
  supersedes: null,
  batch: false,
  labels: [],
  details: {},
  compartments: ["own"],
  ...over,
});

describe("queue.ts: raising a card", { timeout: TIMEOUT }, () => {
  // raiseCard's `replayed`: true for a card that was already there.
  it("no cap holds an author's card back: the eleventh and later cards are pending, and nothing is logged", () =>
    withStore(async ({ db }) => {
      const logged: PersonalLogEvent[] = [];
      const log = { info: () => {}, warn: (event: PersonalLogEvent) => void logged.push(event), error: () => {} };
      for (let n = 0; n < 12; n += 1)
        expect((await asAdmin(db, (query) => raiseCard(query, notice(), { now: AT, log }))).state).toBe("pending");
      expect(logged).toEqual([]);
      expect(await states(db, "system:test")).toEqual({ pending: 12 });
    }));

  it("a second card for one case returns the first and writes nothing", () =>
    withStore(async ({ db }) => {
      const first = notice({ caseKey: "case-one" });
      expect(await asAdmin(db, (query) => raiseCard(query, first, { now: AT }))).toEqual({
        id: first.id,
        state: "pending",
        replayed: false,
      });
      const before = [await count(db, "ledger.cards"), await count(db, "ledger.record_events")];
      expect(await asAdmin(db, (query) => raiseCard(query, notice({ caseKey: "case-one" }), { now: AT }))).toEqual({
        id: first.id,
        state: "pending",
        replayed: true,
      });
      expect([await count(db, "ledger.cards"), await count(db, "ledger.record_events")]).toEqual(before);
      // Another case is another card.
      expect(
        (await asAdmin(db, (query) => raiseCard(query, notice({ caseKey: "case-two" }), { now: AT }))).id,
      ).not.toBe(first.id);
    }));

  it("a card's body is sealed for its compartments and appears in no column", () =>
    withStore(async ({ db }) => {
      const body = "canary-card-body-Q7Z3";
      const card = notice({ body, bodyFrom: "code" });
      await asAdmin(db, (query) => raiseCard(query, card, { now: AT, keys: db.keys }));
      expect(await scanForPlaintext(db.urls.admin, [body])).toEqual([]);
      const row = one(
        await admin<{ body_enc: Sealed; body_from: string }>(
          db,
          "select body_enc, body_from from ledger.cards where id = $1",
          [card.id],
        ),
      );
      expect(row.body_from).toBe("code");
      expect(
        open(db.keys, { id: card.id, compartments: ["own"], body_enc: row.body_enc }, "ledger.cards.body_enc", "throw"),
      ).toBe(body);
    }));

  it("a card for two compartments does not open with one key", () =>
    withStore(async ({ db }) => {
      const card = notice({ compartments: ["employer:example", "own"], body: "two keys", bodyFrom: "code" });
      await asAdmin(db, (query) => raiseCard(query, card, { now: AT, keys: db.keys }));
      const row = one(
        await admin<{ body_enc: Sealed; compartments: string[] }>(
          db,
          "select body_enc, compartments from ledger.cards where id = $1",
          [card.id],
        ),
      );
      expect(row.compartments).toEqual(["employer:example", "own"]);
      const opened = (compartments: string[]): string =>
        open(db.keys, { id: card.id, compartments, body_enc: row.body_enc }, "ledger.cards.body_enc", "throw");
      for (const compartment of ["own", "employer:example"]) expect(() => opened([compartment]), compartment).toThrow();
      expect(opened(["own", "employer:example"])).toBe("two keys");
    }));

  it("a card for a ref that does not exist is refused", () =>
    withStore(async ({ db, writer }) => {
      const message = await aMessage(db, writer);
      const missing = notice({
        refs: [
          { kind: "message", id: message },
          { kind: "message", id: newId("msg") as MessageId },
        ],
      });
      expect(await codeOf(() => asAdmin(db, (query) => raiseCard(query, missing, { now: AT })))).toBe("not_found");
      expect([
        await count(db, "ledger.cards"),
        await count(db, "ledger.basis"),
        await count(db, "ledger.record_events"),
      ]).toEqual([0, 0, 0]);
      // The positive control: the ref that exists makes the card, and its basis row.
      const found = notice({ refs: [{ kind: "message", id: message }] });
      expect((await asAdmin(db, (query) => raiseCard(query, found, { now: AT }))).state).toBe("pending");
      expect(
        await admin(db, "select row_kind, row_id, ref_kind, ref_id, source_class, compartments from ledger.basis"),
      ).toEqual([
        {
          row_kind: "card",
          row_id: found.id,
          ref_kind: "message",
          ref_id: message,
          source_class: "source",
          compartments: ["own"],
        },
      ]);
    }));

  it("a repeated request id returns the first card", () =>
    withStore(async ({ db }) => {
      const first = notice();
      await asAdmin(db, (query) => raiseCard(query, first, { now: AT }));
      expect(
        await asAdmin(db, (query) => raiseCard(query, notice({ requestId: first.requestId }), { now: AT })),
      ).toEqual({ id: first.id, state: "pending", replayed: true });
      expect(await count(db, "ledger.cards")).toBe(1);
      // The same request id from another author is another card.
      expect(
        (
          await asAdmin(db, (query) =>
            raiseCard(query, notice({ requestId: first.requestId, author: "owner" }), { now: AT }),
          )
        ).id,
      ).not.toBe(first.id);
    }));

  it("a card with a body and no keys throws", () =>
    withStore(async ({ db }) => {
      expect(
        await codeOf(() =>
          asAdmin(db, (query) => raiseCard(query, notice({ body: "text", bodyFrom: "code" }), { now: AT })),
        ),
      ).toBe("thrown");
      expect(await count(db, "ledger.cards")).toBe(0);
    }));

  it("a kind with no row is not_built", () =>
    withStore(async ({ db }) => {
      expect(
        await codeOf(() => asAdmin(db, (query) => raiseCard(query, notice({ kind: "nonesuch" }), { now: AT }))),
      ).toBe("not_built");
      // Options that are not the kind's are refused too.
      expect(
        await codeOf(() => asAdmin(db, (query) => raiseCard(query, notice({ options: ["approve"] }), { now: AT }))),
      ).toBe("invalid_argument");
      expect(await count(db, "ledger.cards")).toBe(0);
    }));

  it("a card that counts its expiry in days has no expires_at", () =>
    withStore(async ({ db }) => {
      const days = notice({ expiresAfterDays: 14 });
      const fixed = notice({ expiresAt: "2026-10-01T00:00:00.000Z" });
      await asAdmin(db, (query) => raiseCard(query, days, { now: AT }));
      await asAdmin(db, (query) => raiseCard(query, fixed, { now: AT }));
      const rows = await admin<{ id: string; expires_at: Date | null; expires_after_days: number | null }>(
        db,
        "select id, expires_at, expires_after_days from ledger.cards",
      );
      expect(rows.find((row) => row.id === days.id)).toMatchObject({ expires_at: null, expires_after_days: 14 });
      expect(rows.find((row) => row.id === fixed.id)?.expires_at?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(rows.find((row) => row.id === fixed.id)?.expires_after_days).toBeNull();
    }));

  it("two cards raised at once for an author with nine pending are both pending", () =>
    withStore(async ({ db }) => {
      for (let n = 0; n < 9; n += 1) await asAdmin(db, (query) => raiseCard(query, notice(), { now: AT }));
      const answers = await Promise.all([
        asAdmin(db, (query) => raiseCard(query, notice(), { now: AT })),
        asAdmin(db, (query) => raiseCard(query, notice(), { now: AT })),
      ]);
      expect(answers.map((answer) => answer.state)).toEqual(["pending", "pending"]);
      expect(await states(db, "system:test")).toEqual({ pending: 11 });
    }));

  it("two cards for one case raised at once by two authors leave one card", () =>
    withStore(async ({ db }) => {
      const answers = await Promise.all([
        asAdmin(db, (query) => raiseCard(query, notice({ caseKey: "case-raced" }), { now: AT })),
        asAdmin(db, (query) =>
          raiseCard(query, notice({ caseKey: "case-raced", author: "system:other" }), { now: AT }),
        ),
      ]);
      expect(answers[0].id).toBe(answers[1].id);
      expect(await count(db, "ledger.cards")).toBe(1);
    }));

  it("a card with no refs makes no add_basis call, and its first event's `by` is its author", () =>
    withStore(async ({ db }) => {
      const card = notice({ author: "system:extract" });
      const sent = await asAdmin(db, async (query) => {
        const recorded = recording(query);
        await raiseCard(recorded.query, card, { now: AT });
        return recorded.sent;
      });
      expect(sent.some((statement) => statement.text.includes("add_basis"))).toBe(false);
      // Its first statement takes the locks, for the author's word.
      expect(sent[0]).toEqual({
        text: expect.stringContaining("ledger.lock_rows"),
        values: [["author:system:extract"]],
      });
      // A card with a case key locks the case's word with it.
      const cased = await asAdmin(db, async (query) => {
        const recorded = recording(query);
        await raiseCard(recorded.query, notice({ caseKey: "case-locked" }), { now: AT });
        return recorded.sent;
      });
      expect(cased[0]?.values).toEqual([["author:system:test", "case:case-locked"]]);
      expect(
        await admin(
          db,
          "select row_kind, row_id, event, by, compartments from ledger.record_events where row_id = $1",
          [card.id],
        ),
      ).toEqual([{ row_kind: "card", row_id: card.id, event: "pending", by: "system:extract", compartments: ["own"] }]);
    }));
});

describe("queue.ts: decisions, vetoes and locks", { timeout: TIMEOUT }, () => {
  it("a decision whose details do not parse for its kind is refused and writes nothing", () =>
    withStore(async ({ db }) => {
      expect(
        await codeOf(() =>
          asAdmin(db, (query) =>
            writeDecision(query, decision({ details: { firstContact: true } as never }), { now: AT }),
          ),
        ),
      ).toBe("invalid_argument");
      expect(
        await codeOf(() =>
          asAdmin(db, (query) => writeDecision(query, decision({ kind: "send", details: {} }), { now: AT })),
        ),
      ).toBe("invalid_argument");
      expect(await count(db, "knowledge.owner_decisions")).toBe(0);
      // A kind with no entry takes the empty object, and one with an entry its own details.
      await asAdmin(db, (query) => writeDecision(query, decision(), { now: AT }));
      await asAdmin(db, (query) =>
        writeDecision(
          query,
          decision({ kind: "send", details: { firstContact: true, newThread: false, released: [] } }),
          { now: AT },
        ),
      );
      expect(await count(db, "knowledge.owner_decisions")).toBe(2);
    }));

  it("a repeated request id returns the first ruling", () =>
    withStore(async ({ db }) => {
      const first = decision();
      expect(await asAdmin(db, (query) => writeDecision(query, first, { now: AT }))).toBe(first.id);
      expect(
        await asAdmin(db, (query) => writeDecision(query, decision({ requestId: first.requestId }), { now: AT })),
      ).toBe(first.id);
      expect(await count(db, "knowledge.owner_decisions")).toBe(1);
    }));

  it("two decisions with one request id written at once both return the first ruling", () =>
    withStore(async ({ db }) => {
      const first = decision();
      const answers = await Promise.all([
        asAdmin(db, (query) => writeDecision(query, first, { now: AT })),
        asAdmin(db, (query) => writeDecision(query, decision({ requestId: first.requestId }), { now: AT })),
      ]);
      expect(new Set(answers).size).toBe(1);
      expect(await count(db, "knowledge.owner_decisions")).toBe(1);
    }));

  it("a decision records the queue depth, its labels sorted and each once, and seals its body", () =>
    withStore(async ({ db }) => {
      for (let n = 0; n < 3; n += 1) await asAdmin(db, (query) => raiseCard(query, notice(), { now: AT }));
      const made = decision({
        compartments: ["own", "employer:example"] as never,
        body: { text: "canary-decision-body-H2", keys: db.keys },
      });
      await asAdmin(db, (query) => writeDecision(query, made, { now: AT }));
      const row = one(
        await admin<{ queue_depth: number; compartments: string[]; body_enc: Sealed; decided_at: Date }>(
          db,
          "select queue_depth, compartments, body_enc, decided_at from knowledge.owner_decisions",
        ),
      );
      expect(row.queue_depth).toBe(3);
      expect(row.compartments).toEqual(["employer:example", "own"]);
      expect(row.decided_at.toISOString()).toBe(AT.toISOString());
      expect(await scanForPlaintext(db.urls.admin, ["canary-decision-body-H2"])).toEqual([]);
      expect(open(db.keys, { ...row, id: made.id }, "knowledge.owner_decisions.body_enc", "throw")).toBe(
        "canary-decision-body-H2",
      );
    }));

  it("vetoedBy with an address ref passes the two kinds through to vetoed_by", () =>
    withStore(async ({ db }) => {
      const address = fingerprint(db.keys, "address", PIPPA.address);
      const domain = fingerprint(db.keys, "domain", "quayside.test");
      const ruling = newId("rul");
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'veto', 0, $3, '{own}')",
        [ruling, requestId(), AT],
      );
      await admin(
        db,
        "insert into knowledge.vetoes (ruling_id, subject, value_fps, created_at, compartments) values ($1, 'person', $2, $3, '{own}')",
        [ruling, [address], AT],
      );
      const sent = await asAdmin(db, async (query) => {
        const recorded = recording(query);
        expect(
          await vetoedBy(recorded.query, {
            refs: [
              { kind: "address", id: address },
              { kind: "domain", id: domain },
            ],
          }),
        ).toBe(ruling);
        return recorded.sent;
      });
      expect(sent).toEqual([
        { text: expect.stringContaining("policy.vetoed_by"), values: [["address", "domain"], [address, domain], null] },
      ]);
      await asAdmin(db, async (query) => {
        expect(await vetoed(query, { refs: [{ kind: "address", id: address }] })).toBe(true);
        // A person veto covers no domain ref, and a work kind passes through.
        expect(await vetoedBy(query, { refs: [{ kind: "domain", id: address }] })).toBeNull();
        expect(await vetoed(query, { refs: [{ kind: "domain", id: domain }], kind: "follow_up" })).toBe(false);
      });
    }));

  it("lockRows is one call of ledger.lock_rows, made also for an empty list", () =>
    withStore(async ({ db }) => {
      const sent = await asAdmin(db, async (query) => {
        const recorded = recording(query);
        await lockRows(recorded.query, []);
        await lockRows(recorded.query, ["b", "a"]);
        return recorded.sent;
      });
      expect(sent).toEqual([
        { text: expect.stringContaining("ledger.lock_rows"), values: [[]] },
        { text: expect.stringContaining("ledger.lock_rows"), values: [["b", "a"]] },
      ]);
    }));
});
