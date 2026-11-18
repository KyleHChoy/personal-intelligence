import { inspect } from "node:util";
import {
  ConnectorCursor,
  DataKey,
  EvidenceId,
  LocalEntityId,
  MemberId,
  type RawItem,
  RequestId,
  type Timestamp,
} from "@intelligence/contracts";
import { PersonalLogEvent } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import type { ItemContext, ItemFacts } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { connect, LATER_OWNER, OWNER, QUENTIN } from "../test-support/cast.ts";
import { asTablesOwner } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, sealRow, type TestDatabase } from "../test-support/database.ts";
import {
  derive,
  eventFacts,
  eventItem,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailMessage,
  mailRevision,
  NOW,
} from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { comparableRows, lines, rowCounts, snapshot } from "../test-support/snapshot.ts";
import { withDatabase, withStore, withWriter } from "../test-support/store.ts";
import { createWriter, type Writer } from "./writer.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// The writer's own tests of security and correctness rulings the named blind tests do not cover.
// The blind tests are in writer.db.test.ts.

const TIMEOUT = 240_000;
const OPEN_FAILED = { name: "CryptoError", code: "open_failed" };

const count = async (db: TestDatabase, text: string, values?: unknown[]): Promise<number> =>
  (await queryAs<{ n: number }>(db.urls.admin, text, values))[0]?.n ?? -1;
const accountRows = (db: TestDatabase, address: string): Promise<number> =>
  count(db, "select count(*)::int as n from knowledge.accounts where value_fp = $1", [
    fingerprint(db.keys, "address", address),
  ]);
const domainRows = (db: TestDatabase, domain: string): Promise<number> =>
  count(db, "select count(*)::int as n from knowledge.domains where domain_fp = $1", [
    fingerprint(db.keys, "domain", domain),
  ]);
const entityKinds = async (db: TestDatabase): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await queryAs<{ kind: string; n: number }>(
        db.urls.admin,
        "select kind, count(*)::int as n from knowledge.entities group by kind",
      )
    ).map((row) => [row.kind, row.n]),
  );

// What a call rejected with, or undefined when it resolved.
type Refused = { code?: string; cause?: { sqlstate?: string; constraint?: string } };
const rejection = (call: Promise<unknown>): Promise<Refused | undefined> =>
  call.then(
    () => undefined,
    (error: unknown) => error as Refused,
  );

// Ends the one backend of this database, connected as pi_writer, that matches. A role may end
// its own sessions.
const terminate = async (db: TestDatabase, where: string): Promise<number> =>
  (
    await queryAs(
      db.urls.writer,
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = current_database() and usename = current_user and pid <> pg_backend_pid() and ${where}`,
    )
  ).length;

// Runs fn, and gives every error nothing caught while it ran and for a moment after.
async function uncaughtDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const note = (error: unknown): void => void uncaught.push(error);
  process.on("uncaughtException", note);
  process.on("unhandledRejection", note);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    process.off("uncaughtException", note);
    process.off("unhandledRejection", note);
  }
  return uncaught;
}

describe("the writer's security fixes", { timeout: TIMEOUT }, () => {
  it("an envelope under a compartment the keys lack never opens, even one sealed under a zero key", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, workMail } = await connect(writer);
      const real = (await writer.ownerAddresses()).sort();
      expect(real).toEqual([OWNER.personal, OWNER.work].sort());
      await writer.setCursor(workMail, ConnectorCursor.parse("cursor-real-0001"));

      // What anyone can make: a value sealed under a key of 32 zero bytes, bound to its row. The
      // key file has no key for `employer:ghost`; under `own`, the forger still lacks the real key.
      const zero = (compartment: string): Keys => ({
        compartments: new Map([[compartment, DataKey.parse(Buffer.alloc(32).toString("base64"))]]),
        fingerprintKey: db.keys.fingerprintKey,
      });
      const forged = (compartment: string, table: string, id: string, column: string, value: string) =>
        sealRow(zero(compartment), compartment, { table, id, column }, value);
      const asWriter = (text: string, values: unknown[]) => queryAs(db.urls.writer, text, values);
      const owner = (
        await queryAs<{ id: string }>(db.urls.admin, "select id from knowledge.entities where kind = 'owner'")
      )[0]?.id;

      // 1. An account row of the owner, written as pi_writer.
      const address = "forged-owner@attacker-canary.test";
      const id = "adr_00000000000000000000FORGED";
      for (const compartment of ["employer:ghost", "own"]) {
        await asWriter(
          "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
          [
            id,
            owner,
            fingerprint(db.keys, "address", address),
            fingerprint(db.keys, "domain", "attacker-canary.test"),
            forged(compartment, "knowledge.accounts", id, "value_enc", address),
            [compartment],
          ],
        );
        // Under `employer:ghost` it must fail as it does under `own`, the control: it never opens.
        await expect(writer.ownerAddresses(), compartment).rejects.toMatchObject(OPEN_FAILED);
        // And so no derive is ever handed the forged address.
        let called = false;
        await expect(
          writer.ingestItem(personalMail, mailItem(MAIL.fromQuentin, personalMail), async (ctx) => {
            called = true;
            return mailFacts(MAIL.fromQuentin)(ctx);
          }),
          compartment,
        ).rejects.toMatchObject(OPEN_FAILED);
        expect(called, compartment).toBe(false);
        await asWriter("delete from knowledge.accounts where id = $1", [id]);
      }
      // The positive control: with the forged row gone, the same call gives the owner's addresses.
      expect((await writer.ownerAddresses()).sort()).toEqual(real);

      // 2. A source account's cursor, with the account's compartment changed to match, as the table's
      // owner: no runtime role updates a label.
      const asAccountsOwner = (text: string, values: unknown[]) =>
        asTablesOwner(db, ["vault.source_accounts"], (query) => query(text, values));
      const original = (
        await queryAs<{ cursor_enc: unknown }>(
          db.urls.admin,
          "select cursor_enc from vault.source_accounts where id = $1",
          [workMail.id],
        )
      )[0]?.cursor_enc;
      for (const compartment of ["employer:ghost", "employer:example"]) {
        await asAccountsOwner("update vault.source_accounts set compartments = $2, cursor_enc = $3 where id = $1", [
          workMail.id,
          [compartment],
          forged(compartment, "vault.source_accounts", workMail.id, "cursor_enc", "cursor-forged-0001"),
        ]);
        const stored = (await writer.listSourceAccounts()).find((account) => account.id === workMail.id);
        expect(stored?.compartment).toBe(compartment);
        if (stored === undefined) throw new Error("the account is not stored");
        await expect(writer.cursor(stored), compartment).rejects.toMatchObject(OPEN_FAILED);
      }
      // The positive control: the account as it was opens its own cursor.
      await asAccountsOwner("update vault.source_accounts set compartments = $2, cursor_enc = $3 where id = $1", [
        workMail.id,
        ["employer:example"],
        original,
      ]);
      expect(await writer.cursor(workMail)).toBe("cursor-real-0001");
    }));

  it("facts that name another member are refused and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, personalCalendar } = await connect(writer);
      await writer.ingestItem(personalMail, mailItem(MAIL.fromQuentin, personalMail), mailFacts(MAIL.fromQuentin));
      const before = lines(await snapshot(db));
      // An address where a member id belongs: it would be stored in clear.
      const canary = "member.canary@member-canary.test";
      const other = MemberId.parse(canary);
      const invalid = { code: "invalid_facts" };

      type Change = (facts: ItemFacts) => ItemFacts;
      const changed =
        (facts: (ctx: ItemContext) => Promise<ItemFacts>, change: Change) =>
        async (ctx: ItemContext): Promise<ItemFacts> =>
          change(await facts(ctx));
      const withRecord =
        (change: (record: Extract<ItemFacts, { kind: "event" }>["record"]) => void): Change =>
        (facts) => {
          if (
            facts.kind === "unread" ||
            facts.kind === "contact" ||
            facts.kind === "document" ||
            facts.kind === "page" ||
            (facts.kind === "email" && facts.bulk)
          )
            throw new Error("these facts have no record");
          change(facts.record);
          return facts;
        };
      const changes: [string, Change][] = [
        [
          "a participant member",
          (facts) => ({ ...facts, members: { ...facts.members, participantMembers: [THE_OWNER, other] } }),
        ],
        ["the sender member", (facts) => ({ ...facts, members: { ...facts.members, senderMember: other } })],
        ["a team recipient of the record", withRecord((record) => void (record.teamRecipients = [other]))],
        ["the sender of the record", withRecord((record) => void (record.sender = other))],
      ];
      const items: [string, SourceAccountRow, RawItem, (ctx: ItemContext) => Promise<ItemFacts>][] = [
        ["a received message", personalMail, mailItem(MAIL.canary, personalMail), mailFacts(MAIL.canary)],
        ["a sent message", personalMail, mailItem(MAIL.reply, personalMail), mailFacts(MAIL.reply)],
        ["an event", personalCalendar, eventItem(EVENTS.guest, personalCalendar), eventFacts(EVENTS.guest)],
      ];
      for (const [what, account, raw, facts] of items) {
        for (const [where, change] of changes) {
          await expect(
            writer.ingestItem(account, raw, changed(facts, change)),
            `${what}: ${where}`,
          ).rejects.toMatchObject(invalid);
          // Nothing is written: not the evidence, not the people the derive resolved, not the
          // sender of the sent message as an owner address.
          expect(lines(await snapshot(db)), `${what}: ${where}`).toEqual(before);
        }
      }
      // Facts with no record are checked too.
      const members = { participantMembers: [other] };
      await expect(
        writer.ingestItem(personalMail, mailItem(MAIL.newsletter, personalMail), async () => ({
          kind: "email",
          members,
          bulk: true,
          message: mailMessage(MAIL.newsletter),
        })),
      ).rejects.toMatchObject(invalid);
      await expect(
        writer.ingestItem(personalMail, mailItem(MAIL.unread, personalMail), async () => ({ kind: "unread", members })),
      ).rejects.toMatchObject(invalid);
      expect(lines(await snapshot(db))).toEqual(before);
      expect(await scanForPlaintext(db.urls.admin, [canary])).toEqual([]);

      // A re-derive refuses them as an ingest does, and leaves every row as it was.
      await writer.ensureSourceAccount("second", "google_mail", "own", MAIL.fromQuentin.from?.address ?? "");
      const needing = lines(await snapshot(db));
      await expect(
        writer.rederiveIfNeeded(async (raw, ctx) => changes[2]?.[1](await derive(raw, ctx)) as ItemFacts),
      ).rejects.toMatchObject(invalid);
      expect(lines(await snapshot(db))).toEqual(needing);
      expect(await scanForPlaintext(db.urls.admin, [canary])).toEqual([]);

      // The positive control: the same items with the facts as they were.
      for (const [, account, raw, facts] of items) expect(await writer.ingestItem(account, raw, facts)).toBe("stored");
      expect(await writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });
    }));

  it("an organization does not outlive its last person because the owner has an address on its domain", async () => {
    // The smallest case: the owner's own account is on the domain, and one message names one
    // person on it.
    await withStore(async ({ db, writer }) => {
      const account = await writer.ensureSourceAccount("personal", "google_mail", "own", "owner@corp.example");
      const owner = { address: "owner@corp.example" };
      const m1: MailFixture = {
        id: "gm-m1-0301",
        threadId: "thread-m1-0301",
        at: "2026-09-10T09:00:00Z",
        from: { address: "p@corp.example", name: "P Corp" },
        to: [owner],
        labels: ["INBOX"],
      };
      expect(await writer.ingestItem(account, mailItem(m1, account), mailFacts(m1))).toBe("stored");
      // The positive control: while the person is there, so are the domain row and its organization.
      expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });
      expect(await domainRows(db, "corp.example")).toBe(1);

      await writer.applyDeletion(account, {
        sourceAccount: account.id,
        sourceItemId: mailItem(m1, account).sourceItemId,
        deletedAt: NOW,
      });
      // The owner alone, and no domain row.
      expect(await entityKinds(db)).toEqual({ owner: 1 });
      expect(await domainRows(db, "corp.example")).toBe(0);
      expect(await accountRows(db, "owner@corp.example")).toBe(1);

      // The same at a new revision that no longer names the person.
      const m2: MailFixture = {
        id: "gm-m2-0302",
        threadId: "thread-m2-0302",
        at: "2026-09-11T09:00:00Z",
        from: { address: "p2@corp.example" },
        to: [owner],
        labels: ["INBOX"],
      };
      const m2Again: MailFixture = { ...m2, from: { address: "q@elsewhere.example" } };
      expect(await writer.ingestItem(account, mailItem(m2, account), mailFacts(m2))).toBe("stored");
      expect(await domainRows(db, "corp.example")).toBe(1);
      expect(await writer.ingestItem(account, mailRevision(m2Again, account), mailFacts(m2Again))).toBe("stored");
      expect(await accountRows(db, "p2@corp.example")).toBe(0);
      expect(await domainRows(db, "corp.example")).toBe(0);
      expect(await domainRows(db, "elsewhere.example")).toBe(1);
      expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });
    });

    // And against a re-derive, in two stores with one key file.
    await withDatabase((deleted) =>
      withDatabase(
        async (rederived) => {
          // A person on the domain of the owner's own work address, seen in one item.
          const colleague: MailFixture = mail({
            id: "gm-colleague-0201",
            threadId: "thread-colleague-0201",
            at: "2026-09-10T09:00:00Z",
            from: { address: "alice.colleague@employer-example.test", name: "Alice Colleague" },
            to: [{ address: OWNER.work }],
            subject: "From the next desk",
            labels: ["INBOX"],
          });
          const domain = "employer-example.test";
          expect(OWNER.work.endsWith(`@${domain}`)).toBe(true);
          const organizations = async (db: TestDatabase): Promise<{ domains: number; organizations: number }> => {
            const [row] = await queryAs<{ domains: number; organizations: number }>(
              db.urls.admin,
              `select (select count(*)::int from knowledge.domains where domain_fp = $1) as domains,
                 (select count(*)::int from knowledge.entities where kind = 'organization') as organizations`,
              [fingerprint(db.keys, "domain", domain)],
            );
            if (row === undefined) throw new Error("no row");
            return row;
          };
          const second = (writer: Writer): Promise<SourceAccountRow> =>
            writer.ensureSourceAccount("second", "google_mail", "own", LATER_OWNER.address);
          // Both stores: the colleague's message under the work account, and a message from an
          // address that is the owner's own, known from the start in one store and learned after
          // in the other, so that only the other needs a re-derive.
          const load = async (writer: Writer, db: TestDatabase): Promise<void> => {
            const { personalMail, workMail } = await connect(writer);
            expect(await writer.ingestItem(workMail, mailItem(colleague, workMail), mailFacts(colleague))).toBe(
              "stored",
            );
            expect(
              await writer.ingestItem(personalMail, mailItem(MAIL.fromLater, personalMail), mailFacts(MAIL.fromLater)),
            ).toBe("stored");
            // The positive control: while the colleague is there, so is the organization.
            expect((await organizations(db)).domains).toBe(1);
            await writer.applyDeletion(workMail, {
              sourceAccount: workMail.id,
              sourceItemId: mailItem(colleague, workMail).sourceItemId,
              deletedAt: NOW,
            });
          };

          await withWriter(deleted, async (writer) => {
            await second(writer);
            await load(writer, deleted);
            // The colleague was the domain's last person: the owner's address does not keep it.
            expect(await organizations(deleted)).toEqual({ domains: 0, organizations: 1 });
            expect(await writer.rederiveIfNeeded(derive)).toEqual({ rederived: false, items: 0, coarser: 0 });
          });
          await withWriter(rederived, async (writer) => {
            await load(writer, rederived);
            expect((await organizations(rederived)).domains).toBe(0);
            await second(writer);
            expect(await writer.rederiveIfNeeded(derive)).toMatchObject({ rederived: true });
          });

          // The rows after the deletion are the rows after a re-derive.
          expect(await rowCounts(deleted)).toEqual(await rowCounts(rederived));
          expect(await comparableRows(deleted)).toEqual(await comparableRows(rederived));
          expect(await organizations(rederived)).toEqual({ domains: 0, organizations: 1 });
        },
        { keyFile: deleted.keyFile },
      ),
    );
  });

  it("a backend terminated during a transaction gives unavailable", () =>
    withStore(async ({ db, writer, logged }) => {
      const { personalMail } = await connect(writer);
      const raw = mailItem(MAIL.fromQuentin, personalMail);
      const before = lines(await snapshot(db));
      let ended = 0;
      let error: Refused | undefined;
      const uncaught = await uncaughtDuring(async () => {
        error = await rejection(
          writer.ingestItem(personalMail, raw, async (ctx) => {
            const facts = await mailFacts(MAIL.fromQuentin)(ctx);
            // The item's own connection, between two of its statements.
            ended = await terminate(db, "state = 'idle in transaction'");
            return facts;
          }),
        );
      });
      expect(ended).toBe(1);
      expect(error).toMatchObject({ code: "unavailable" });
      expect(uncaught).toEqual([]);
      // One log line, with a code and nothing else.
      expect(logged.map((call) => call.event)).toHaveLength(1);
      expect(["write_failed", "connection_lost"]).toContain(logged[0]?.event.event);
      expect(logged[0]?.event.code).toBe("unavailable");
      // Nothing of the item was kept.
      expect(lines(await snapshot(db))).toEqual(before);
      // The positive control: the same call on a connection that lasts.
      expect(await writer.ingestItem(personalMail, raw, mailFacts(MAIL.fromQuentin))).toBe("stored");
    }));

  it("a backend terminated while the sync lock is held gives unavailable", () =>
    withStore(async ({ db, writer, logged }) => {
      const lockHolder =
        "pid in (select l.pid from pg_locks l where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database()))";
      let ran = 0;
      let ended = 0;
      let error: Refused | undefined;
      const uncaught = await uncaughtDuring(async () => {
        error = await rejection(
          writer.withSyncLock(async () => {
            // The lock's connection is idle for the whole of a sync.
            ended = await terminate(db, lockHolder);
            // The sync goes on with its other connections, not knowing.
            await writer.ownerAddresses();
            ran += 1;
            return "synced";
          }),
        );
      });
      expect(ended).toBe(1);
      expect(ran).toBe(1);
      // The lock went with its connection, so the run is not reported as one that held it.
      expect(error).toMatchObject({ code: "unavailable" });
      expect(uncaught).toEqual([]);
      expect(logged.map((call) => call.event)).toHaveLength(1);
      expect(["write_failed", "connection_lost"]).toContain(logged[0]?.event.event);
      expect(logged[0]?.event.code).toBe("unavailable");
      // The positive control: the same call when the connection lasts.
      expect(await writer.withSyncLock(async () => "synced")).toBe("synced");
    }));

  it("a refused write is write_refused, and a lost connection unavailable", () =>
    withStore(async ({ db, writer, logged }) => {
      const { personalMail } = await connect(writer);
      const before = lines(await snapshot(db));

      // A check violation (class 23).
      const check = await rejection(writer.recordOutcome(personalMail, "Not A Code", NOW));
      expect(check).toMatchObject({ code: "write_refused", cause: { sqlstate: "23514" } });
      // A bad value (class 22): a count that is no integer.
      const value = await rejection(writer.recordOutcome(personalMail, "ok", NOW, 1.5));
      expect(value).toMatchObject({ code: "write_refused" });
      expect(value?.cause?.sqlstate).toMatch(/^22/);
      // A foreign-key violation (class 23): facts that name an entity that is not stored.
      const nobody = LocalEntityId.parse(`ent_${"0".repeat(26)}`);
      const foreign = await rejection(
        writer.ingestItem(personalMail, mailItem(MAIL.fromQuentin, personalMail), async (ctx) => ({
          kind: "email",
          members: { participantMembers: [THE_OWNER] },
          bulk: false,
          message: { ...mailMessage(MAIL.fromQuentin), subject: null },
          record: {
            evidenceId: ctx.evidenceId,
            occurredAt: MAIL.fromQuentin.at,
            channel: "email",
            direction: "inbound",
            teamRecipients: [THE_OWNER],
            participants: [nobody],
          },
          roles: [{ entity: nobody, role: "sender" }],
          names: [],
        })),
      );
      expect(foreign).toMatchObject({ code: "write_refused", cause: { sqlstate: "23503" } });
      expect(lines(await snapshot(db))).toEqual(before);

      // Against a connection that is not there: nothing a retry of the same call could not mend.
      const { log, calls } = recordingLogger();
      const nowhere = createWriter({ url: "postgres://pi_writer:local-only@127.0.0.1:1/nowhere", keys: db.keys, log });
      const lost = await rejection(nowhere.ownerAddresses());
      await nowhere.close();
      expect(lost).toMatchObject({ code: "unavailable" });

      // An SQLSTATE is never a code, and a log line carries the code and nothing else.
      for (const error of [check, value, foreign, lost]) expect(error?.code).not.toMatch(/^[0-9A-Z]{5}$/);
      const events = [...logged, ...calls].map((call) => call.event);
      expect(events).toEqual([
        { event: "write_failed", code: "write_refused" },
        { event: "write_failed", code: "write_refused" },
        { event: "write_failed", code: "write_refused" },
        { event: "write_failed", code: "unavailable" },
      ]);
      for (const event of events) expect(PersonalLogEvent.safeParse(event).success).toBe(true);
      // The positive control: the same calls with values the database takes.
      await writer.recordOutcome(personalMail, "ok", NOW);
      expect(
        await writer.ingestItem(personalMail, mailItem(MAIL.fromQuentin, personalMail), mailFacts(MAIL.fromQuentin)),
      ).toBe("stored");
    }));

  it("a database error carries no value", () =>
    withStore(async ({ db, writer, logged }) => {
      const { personalMail } = await connect(writer);
      const canary = "lunch with alice.canary@corp.example";
      const holds = (value: unknown): boolean => {
        const error = value as Error;
        const shown = [
          JSON.stringify(value),
          inspect(value, { depth: 10, showHidden: true, getters: true }),
          String(error?.message),
          String(error?.stack),
          JSON.stringify(Object.getOwnPropertyDescriptors(value ?? {})),
        ];
        return shown.some((text) => /canary|lunch|alice/i.test(text));
      };

      // A value the database refuses for its type (class 22), and one a check refuses (class 23):
      // each reaches a statement as a bind parameter, and the server's answer quotes it.
      const badValue = () => writer.recordOutcome(personalMail, "ok", NOW, canary as unknown as number);
      const badCode = () => writer.recordOutcome(personalMail, canary, NOW);
      // The control: what the driver itself says of the same two statements does hold the value.
      const driver = async (text: string, values: unknown[]): Promise<unknown> =>
        queryAs(db.urls.writer, text, values).catch((error: unknown) => error);
      expect(
        holds(
          await driver("update vault.source_accounts set skipped_items = $2 where id = $1", [personalMail.id, canary]),
        ),
      ).toBe(true);
      // For a constraint the server itself says nothing of the row: every table has row-level
      // security, and under it Postgres leaves the failing row and key out of its message. So
      // no class 23 failure can be made to hold the value here; the writer's error is checked
      // all the same, and this line says so if that ever changes.
      expect(
        holds(
          await driver("update vault.source_accounts set last_outcome = $2 where id = $1", [personalMail.id, canary]),
        ),
      ).toBe(false);

      const value = await rejection(badValue());
      const code = await rejection(badCode());
      expect(value).toMatchObject({ code: "write_refused", cause: { sqlstate: "22P02" } });
      expect(code).toMatchObject({
        code: "write_refused",
        cause: { sqlstate: "23514", constraint: "source_accounts_last_outcome_check" },
      });
      for (const error of [value, code]) {
        expect(error).toBeInstanceOf(Error);
        expect(holds(error)).toBe(false);
        expect(holds(error?.cause)).toBe(false);
        // The cause is the writer's own small object, and nothing of the driver's error.
        expect(Object.keys(error?.cause ?? {}).filter((key) => key !== "sqlstate" && key !== "constraint")).toEqual([]);
        expect(error?.cause).not.toBeInstanceOf(Error);
      }
      expect(Object.keys(value?.cause ?? {})).toEqual(["sqlstate"]);
      // A failure that is no answer of the server has neither.
      const { log } = recordingLogger();
      const nowhere = createWriter({ url: "postgres://pi_writer:local-only@127.0.0.1:1/nowhere", keys: db.keys, log });
      const lost = await rejection(nowhere.ownerAddresses());
      await nowhere.close();
      expect(lost).toMatchObject({ code: "unavailable", cause: {} });
      expect(Object.keys(lost?.cause ?? { none: true })).toEqual([]);
      expect(holds(logged)).toBe(false);
    }));

  it("a time that is not a timestamp is refused before any write", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, personalCalendar } = await connect(writer);
      const canary = "lunch with alice.canary@corp.example" as Timestamp;
      const before = lines(await snapshot(db));

      // recordOutcome's own argument.
      const outcome = await rejection(writer.recordOutcome(personalMail, "ok", canary));
      expect(outcome).toMatchObject({ code: "invalid_argument" });
      expect(inspect(outcome, { depth: 10, showHidden: true })).not.toContain("canary");

      // Times that come from a derive: the record's, and an event's start and end.
      const message = mailItem(MAIL.canary, personalMail);
      const meeting = eventItem(EVENTS.guest, personalCalendar);
      type Event = Extract<ItemFacts, { kind: "event" }>;
      const event = async (ctx: ItemContext): Promise<Event> => {
        const facts = await eventFacts(EVENTS.guest)(ctx);
        if (facts.kind !== "event") throw new Error("the fixture is an event");
        return facts;
      };
      const cases: [string, SourceAccountRow, RawItem, (ctx: ItemContext) => Promise<ItemFacts>][] = [
        [
          "a message record's time",
          personalMail,
          message,
          async (ctx) => {
            const facts = await mailFacts(MAIL.canary)(ctx);
            if (facts.kind !== "email" || facts.bulk) throw new Error("the fixture is a message that is read");
            return { ...facts, record: { ...facts.record, occurredAt: canary } };
          },
        ],
        [
          "an event record's time",
          personalCalendar,
          meeting,
          async (ctx) => ((facts) => ({ ...facts, record: { ...facts.record, occurredAt: canary } }))(await event(ctx)),
        ],
        [
          "an event's start",
          personalCalendar,
          meeting,
          async (ctx) => ((facts) => ({ ...facts, facts: { ...facts.facts, startsAt: canary } }))(await event(ctx)),
        ],
        [
          "an event's end",
          personalCalendar,
          meeting,
          async (ctx) => ((facts) => ({ ...facts, facts: { ...facts.facts, endsAt: "2026-09-12" } }))(await event(ctx)),
        ],
      ];
      for (const [what, account, raw, facts] of cases) {
        const error = await rejection(writer.ingestItem(account, raw, facts));
        expect(error, what).toMatchObject({ code: "invalid_facts" });
        expect(inspect(error, { depth: 10, showHidden: true }), what).not.toContain("canary");
        expect(lines(await snapshot(db)), what).toEqual(before);
      }
      // The positive control: the same calls with times that are timestamps, and an event with none.
      await writer.recordOutcome(personalMail, "ok", NOW);
      expect(await writer.ingestItem(personalMail, message, mailFacts(MAIL.canary))).toBe("stored");
      expect(
        await writer.ingestItem(personalCalendar, meeting, async (ctx) =>
          ((facts) => ({ ...facts, facts: { ...facts.facts, startsAt: null, endsAt: null } }))(await event(ctx)),
        ),
      ).toBe("stored");
    }));

  it("after the lock is lost no write is made", () =>
    withStore(({ db, writer }) =>
      withWriter(db, async (other) => {
        const { personalMail } = await connect(writer);
        const lockHolder =
          "pid in (select l.pid from pg_locks l where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database()))";
        const raw = mailItem(MAIL.fromQuentin, personalMail);
        const deletion = { sourceAccount: personalMail.id, sourceItemId: raw.sourceItemId, deletedAt: NOW };
        const page = {
          listing: { first: true, ended: "complete" as const },
          listedIds: [],
          skippedIds: [],
          next: ConnectorCursor.parse("cursor-after-loss"),
        };
        let derived = 0;
        const facts = async (ctx: ItemContext): Promise<ItemFacts> => {
          derived += 1;
          return mailFacts(MAIL.fromQuentin)(ctx);
        };
        const writes: [string, () => Promise<unknown>][] = [
          ["ingestItem", () => writer.ingestItem(personalMail, raw, facts)],
          ["applyDeletion", () => writer.applyDeletion(personalMail, deletion)],
          ["finishPage", () => writer.finishPage(personalMail, page)],
          ["setCursor", () => writer.setCursor(personalMail, ConnectorCursor.parse("cursor-after-loss"))],
          ["recordOutcome", () => writer.recordOutcome(personalMail, "ok", NOW)],
          [
            "ensureSourceAccount",
            () => writer.ensureSourceAccount("third", "google_mail", "own", "owner.third@third-account.test"),
          ],
          ["rederiveIfNeeded", () => writer.rederiveIfNeeded(derive)],
        ];

        const refused: Record<string, string | undefined> = {};
        let before: string[] = [];
        let after: string[] = [];
        let second: unknown;
        let read: string[] = [];
        const uncaught = await uncaughtDuring(async () => {
          const error = await rejection(
            writer.withSyncLock(async () => {
              // The positive control: while the lock is held, a write is made.
              await writer.recordOutcome(personalMail, "ok", NOW);
              before = lines(await snapshot(db));
              expect(await terminate(db, lockHolder)).toBe(1);
              // The backend is gone, and the writer has heard of it.
              while ((await count(db, `select count(*)::int as n from pg_stat_activity where ${lockHolder}`)) > 0)
                await new Promise((resolve) => setTimeout(resolve, 20));
              await new Promise((resolve) => setTimeout(resolve, 100));

              for (const [name, write] of writes) refused[name] = (await rejection(write()))?.code;
              after = lines(await snapshot(db));
              // Reading is still allowed, and a second writer can take the lock.
              read = await writer.ownerAddresses();
              second = await other.withSyncLock(async () => "ran");
              return "synced";
            }),
          );
          expect(error).toMatchObject({ code: "unavailable" });
        });
        expect(uncaught).toEqual([]);
        expect(refused).toEqual(Object.fromEntries(writes.map(([name]) => [name, "unavailable"])));
        // Nothing was stored, and no derive was called.
        expect(derived).toBe(0);
        expect(after).toEqual(before);
        expect(read.sort()).toEqual([OWNER.personal, OWNER.work].sort());
        expect(second).toBe("ran");

        // Outside any withSyncLock, and in the next one, the writer writes as before.
        expect(await writer.ingestItem(personalMail, raw, facts)).toBe("stored");
        expect(
          await writer.withSyncLock(() => writer.recordOutcome(personalMail, "ok", NOW).then(() => "synced")),
        ).toBe("synced");
      }),
    ));

  it("an item that does not parse is refused and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail } = await connect(writer);
      const good = mailItem(MAIL.canary, personalMail);
      const crowd = Array.from({ length: 1001 }, (_, index) => `to-${index}@crowd.example`);
      const items: [string, RawItem][] = [
        ["an extra key", { ...good, notes: "canary-extra-key" } as RawItem],
        [
          "more than 1000 addressees",
          { ...good, addressees: crowd, permissions: { scope: "listed", identifiers: [...crowd, good.sender ?? ""] } },
        ],
        ["a sender missing from its permissions", { ...good, sender: "elsewhere-canary@not-listed.example" }],
        ["a payload that is not base64", { ...good, payload: "not base64!" }],
      ];
      const before = lines(await snapshot(db));
      for (const [what, raw] of items) {
        let called = false;
        const error = await rejection(
          writer.ingestItem(personalMail, raw, async (ctx) => {
            called = true;
            return mailFacts(MAIL.canary)(ctx);
          }),
        );
        expect(error, what).toMatchObject({ code: "invalid_item" });
        expect(called, what).toBe(false);
        // The refusal carries nothing of the item.
        const shown = inspect(error, { depth: 8, showHidden: true });
        for (const part of ["canary", "crowd.example", "not base64"]) expect(shown, what).not.toContain(part);
        expect(lines(await snapshot(db)), what).toEqual(before);
      }
      // The positive control: the item as the builder made it. And what is stored always parses
      // again, so a re-derive never meets an item it cannot read.
      expect(await writer.ingestItem(personalMail, good, mailFacts(MAIL.canary))).toBe("stored");
      await writer.ensureSourceAccount("second", "google_mail", "own", QUENTIN.address);
      expect(await writer.rederiveIfNeeded(derive)).toEqual({ rederived: true, items: 1, coarser: 0 });
    }));

  it("a person the port resolved and the facts do not name is removed in the same transaction", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, workMail } = await connect(writer);
      const passerby = "passerby@passing-through.example";
      // Resolves one address more than the facts name.
      const resolving =
        (address: string, fixture: MailFixture, outcomes: string[]) =>
        async (ctx: ItemContext): Promise<ItemFacts> => {
          const resolution = await ctx.identity.resolve(
            { key: { kind: "address", value: address }, observedAt: fixture.at },
            "people",
            RequestId.parse("fixture:resolving"),
          );
          outcomes.push(resolution.outcome);
          return mailFacts(fixture)(ctx);
        };

      const outcomes: string[] = [];
      expect(
        await writer.ingestItem(
          personalMail,
          mailItem(MAIL.fromQuentin, personalMail),
          resolving(passerby, MAIL.fromQuentin, outcomes),
        ),
      ).toBe("stored");
      expect(outcomes).toEqual(["created"]);
      // Quentin and Quentin's organization, and nothing of the address no row names.
      expect(await accountRows(db, passerby)).toBe(0);
      expect(await domainRows(db, "passing-through.example")).toBe(0);
      expect(await entityKinds(db)).toEqual({ owner: 1, person: 1, organization: 1 });

      // A person known under one compartment, resolved under another and not named there:
      // the row it had stays, and it gains none.
      expect(
        await writer.ingestItem(
          workMail,
          mailItem(MAIL.workOnly, workMail),
          resolving(QUENTIN.address, MAIL.workOnly, outcomes),
        ),
      ).toBe("stored");
      expect(outcomes).toEqual(["created", "linked"]);
      expect(
        await queryAs(db.urls.admin, "select compartments from knowledge.accounts where value_fp = $1", [
          fingerprint(db.keys, "address", QUENTIN.address),
        ]),
      ).toEqual([{ compartments: ["own"] }]);
      expect(
        await queryAs(db.urls.admin, "select compartments from knowledge.domains where domain_fp = $1", [
          fingerprint(db.keys, "domain", "lighthouse.test"),
        ]),
      ).toEqual([{ compartments: ["own"] }]);

      // The positive control: the same address, when the facts name it, stays.
      const named: MailFixture = {
        id: "gm-passerby-0401",
        threadId: "thread-passerby-0401",
        at: "2026-09-12T09:00:00Z",
        from: { address: passerby },
        to: [{ address: OWNER.personal }],
        labels: ["INBOX"],
      };
      expect(await writer.ingestItem(personalMail, mailItem(named, personalMail), mailFacts(named))).toBe("stored");
      expect(await accountRows(db, passerby)).toBe(1);
      expect(await domainRows(db, "passing-through.example")).toBe(1);
      expect(await resolveAddressOnce(writer, personalMail, passerby)).toBe("linked");
    }));

  it("facts that do not fit their item are refused and nothing is written", () =>
    withStore(async ({ db, writer }) => {
      const { personalMail, personalCalendar } = await connect(writer);
      const before = lines(await snapshot(db));
      const message = mailItem(MAIL.canary, personalMail);
      const meeting = eventItem(EVENTS.guest, personalCalendar);
      type Email = Extract<ItemFacts, { kind: "email"; bulk: false }>;
      const email = async (ctx: ItemContext): Promise<Email> => {
        const facts = await mailFacts(MAIL.canary)(ctx);
        if (facts.kind !== "email" || facts.bulk) throw new Error("the fixture is a message that is read");
        return facts;
      };
      const cases: [string, SourceAccountRow, RawItem, (ctx: ItemContext) => Promise<ItemFacts>, string][] = [
        [
          "a role missing for an entity the record names",
          personalMail,
          message,
          async (ctx) => ({ ...(await email(ctx)), roles: (await email(ctx)).roles.slice(1) }),
          "invalid_facts",
        ],
        [
          "a role given twice",
          personalMail,
          message,
          async (ctx) =>
            ((facts) => ({ ...facts, roles: [...facts.roles, ...facts.roles.slice(0, 1)] }))(await email(ctx)),
          "invalid_facts",
        ],
        ["event facts for a message", personalMail, message, eventFacts(EVENTS.guest), "invalid_facts"],
        ["message facts for an event", personalCalendar, meeting, mailFacts(MAIL.canary), "invalid_facts"],
        [
          "a record for another item",
          personalMail,
          message,
          async (ctx) =>
            ((facts) => ({ ...facts, record: { ...facts.record, evidenceId: EvidenceId.parse("f".repeat(64)) } }))(
              await email(ctx),
            ),
          "invalid_facts",
        ],
        // An item of one kind under an account of the other.
        [
          "a calendar item under a mail account",
          personalMail,
          eventItem(EVENTS.guest, personalMail),
          eventFacts(EVENTS.guest),
          "account_mismatch",
        ],
        [
          "a message under a calendar account",
          personalCalendar,
          mailItem(MAIL.canary, personalCalendar),
          mailFacts(MAIL.canary),
          "account_mismatch",
        ],
      ];
      for (const [what, account, raw, facts, code] of cases) {
        expect(await rejection(writer.ingestItem(account, raw, facts)), what).toMatchObject({ code });
        expect(lines(await snapshot(db)), what).toEqual(before);
      }
      // The positive control: each item with its own facts.
      expect(await writer.ingestItem(personalMail, message, mailFacts(MAIL.canary))).toBe("stored");
      expect(await writer.ingestItem(personalCalendar, meeting, eventFacts(EVENTS.guest))).toBe("stored");
      // The sender of the message kept its role.
      expect(
        await queryAs(
          db.urls.admin,
          "select entity_role, count(*)::int as n from knowledge.interaction_log group by entity_role order by entity_role",
        ),
      ).toEqual([
        { entity_role: "recipient", n: 1 },
        { entity_role: "sender", n: 1 },
      ]);
    }));
});

// What the port answers for an address, asked inside an item that is then left unstored.
async function resolveAddressOnce(
  writer: Writer,
  account: SourceAccountRow,
  address: string,
): Promise<string | undefined> {
  let outcome: string | undefined;
  const probe: MailFixture = {
    id: "gm-probe-0499",
    threadId: "thread-probe-0499",
    at: "2026-09-13T09:00:00Z",
    from: { address },
    to: [{ address: OWNER.personal }],
    labels: ["INBOX"],
  };
  await writer
    .ingestItem(account, mailItem(probe, account), async (ctx) => {
      outcome = (
        await ctx.identity.resolve(
          { key: { kind: "address", value: address }, observedAt: probe.at },
          "people",
          RequestId.parse("fixture:probe"),
        )
      ).outcome;
      throw new Error("the probe keeps nothing");
    })
    .catch(() => undefined);
  return outcome;
}
