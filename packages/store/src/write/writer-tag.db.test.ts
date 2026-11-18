import type { Timestamp } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { connect, LATER_OWNER, OWNER, QUENTIN, RHEA, type Who } from "../test-support/cast.ts";
import { insertClient, testId } from "../test-support/clients.ts";
import { asOwner, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import {
  derive,
  eventFacts,
  eventItem,
  type MailFixture,
  mail,
  mailFacts,
  mailItem,
  mailRevision,
  mailSourceId,
  sentBodyHash,
} from "../test-support/items.ts";
import { EVENTS } from "../test-support/items-named.ts";
import { recordingStatements } from "../test-support/recording.ts";
import { withStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// A send's rows are written as pi_owner, as begin_send and finish_send would leave them, so each
// test sets exactly the state of the send it needs; the functions themselves have their own tests.

const ME: Who = { address: OWNER.personal, name: OWNER.name };

type Evidence = {
  system_originated: boolean;
  answers_system: boolean;
  sent_id: string | null;
};
const evidenceOf = async (db: TestDatabase, account: SourceAccountRow, fixture: MailFixture): Promise<Evidence[]> =>
  queryAs<Evidence>(
    db.urls.admin,
    "select system_originated, answers_system, sent_id from vault.evidence_items where source_account_id = $1 and source_item_fp = $2 order by revision",
    [account.id, fingerprint(db.keys, "source_id", mailSourceId(fixture))],
  );

const sentCopy = (id: string, to: Who[], at: Timestamp, threadId = `thread-${id}`): MailFixture =>
  mail({
    id,
    threadId,
    messageId: `${id}@owner.test`,
    at,
    from: ME,
    to,
    subject: `Sent ${id}`,
    labels: ["SENT"],
    text: `The words of ${id}.`,
  });

const received = (id: string, threadId: string, at: Timestamp, from: Who = QUENTIN): MailFixture =>
  mail({
    id,
    threadId,
    messageId: `${id}@lighthouse.test`,
    at,
    from,
    to: [ME],
    subject: `Re: ${id}`,
    labels: ["INBOX"],
  });

// One committed transaction as pi_owner (asOwner rolls back: it is for reads and controls).
async function asOwnerKept(db: TestDatabase, fn: (query: Query) => Promise<void>): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("begin");
    try {
      await query("set local role pi_owner");
      await fn(query);
      await query("commit");
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });
}

// A send of `copy`, as the send functions leave it: its draft, the owner's decision, the send's
// row and its events. `state` is its latest event; `filled` is finish_send's fill of the copy's
// source and thread fingerprints.
async function seedSend(
  db: TestDatabase,
  account: SourceAccountRow,
  copy: MailFixture,
  options: {
    state: "sending" | "sent" | "unknown" | "failed";
    filled: boolean;
    begunAt: Timestamp;
    threadOnDraft?: boolean;
  },
): Promise<string> {
  const client = await insertClient(db, `drafter-${testId("x").slice(-6).toLowerCase()}`, ["own"]);
  const draft = testId("drf");
  const send = testId("snt");
  const ruling = testId("rul");
  const recipients = [...new Set((copy.to ?? []).map((who) => fingerprint(db.keys, "address", who.address)))].sort();
  const domains = [
    ...new Set((copy.to ?? []).map((who) => fingerprint(db.keys, "domain", who.address.split("@")[1] ?? ""))),
  ].sort();
  const body = fingerprint(db.keys, "body_hash", await sentBodyHash(copy));
  const thread = fingerprint(db.keys, "thread", copy.threadId);
  await asOwnerKept(db, async (query) => {
    await query(
      `insert into ledger.drafts (id, request_id, created_by, compartments, source_account_id, thread_fp, recipient_fps, recipient_domain_fps,
         payload_fp, body_fp, case_key, body_enc)
       values ($1, $2, $3, '{own}', $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb)`,
      [
        draft,
        `req-${draft}`,
        `client:${client.id}`,
        account.id,
        options.threadOnDraft === false ? null : thread,
        recipients,
        domains,
        "a".repeat(64),
        body,
        "b".repeat(64),
      ],
    );
    await query(
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, details, decided_at, compartments)
       values ($1, $2, 'send', 'draft', $3, 'clear', 0, '{"firstContact": false, "newThread": false, "released": []}', $4, '{own}')`,
      [ruling, `req-${ruling}`, draft, options.begunAt],
    );
    await query(
      `insert into ledger.sent_messages (id, request_id, created_by, compartments, draft_id, ruling_id, decision_id, source_account_id, recipient_fps,
         payload_fp, body_fp, begun_at, source_item_fp, thread_fp, sent_at)
       values ($1, $2, 'owner', '{own}', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        send,
        `req-${send}`,
        draft,
        ruling,
        testId("gdc"),
        account.id,
        recipients,
        "a".repeat(64),
        body,
        options.begunAt,
        options.filled ? fingerprint(db.keys, "source_id", mailSourceId(copy)) : null,
        options.filled ? thread : null,
        options.filled ? options.begunAt : null,
      ],
    );
    const events = options.state === "sending" ? ["sending"] : ["sending", options.state];
    for (const event of events) {
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('send', $1, $2, $3, 'owner', '{own}')",
        [send, event, options.begunAt],
      );
    }
  });
  return send;
}

describe("the writer's tag at sync", () => {
  it(
    "a sent copy is marked system_originated with its sent_id when sync stores it, by its source item fingerprint after finish_send",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const copy = sentCopy("tag-filled", [QUENTIN], "2026-09-20T10:00:05Z");
        // Its body differs from the send's, so only the source fingerprint can match.
        const send = await seedSend(
          db,
          personalMail,
          { ...copy, text: "other words" },
          { state: "sent", filled: true, begunAt: "2026-09-20T10:00:00Z" },
        );
        expect(await writer.ingestItem(personalMail, mailItem(copy, personalMail), mailFacts(copy))).toBe("stored");
        expect(await evidenceOf(db, personalMail, copy)).toEqual([
          { system_originated: true, answers_system: false, sent_id: send },
        ]);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "a copy stored between begin_send and finish_send, and a copy of a send whose command died, are marked by their body fingerprint and recipients",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        for (const [id, state] of [
          ["tag-sending", "sending"],
          ["tag-unknown", "unknown"],
        ] as const) {
          const copy = sentCopy(id, [QUENTIN, RHEA], "2026-09-20T10:00:05Z");
          const send = await seedSend(db, personalMail, copy, {
            state,
            filled: false,
            begunAt: "2026-09-20T10:00:00Z",
          });
          await writer.ingestItem(personalMail, mailItem(copy, personalMail), mailFacts(copy));
          expect(await evidenceOf(db, personalMail, copy), id).toEqual([
            { system_originated: true, answers_system: false, sent_id: send },
          ]);
        }
        // The control: a copy with one recipient fewer than the send is not marked.
        const full = sentCopy("tag-fewer", [QUENTIN, RHEA], "2026-09-20T10:00:05Z");
        await seedSend(db, personalMail, full, {
          state: "sending",
          filled: false,
          begunAt: "2026-09-20T10:00:00Z",
        });
        const fewer = { ...full, to: [QUENTIN] };
        mail(fewer);
        await writer.ingestItem(personalMail, mailItem(fewer, personalMail), mailFacts(fewer));
        expect(await evidenceOf(db, personalMail, fewer)).toEqual([
          { system_originated: false, answers_system: false, sent_id: null },
        ]);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "a later inbound message on a sent message's thread is marked answers_system, also when sync stores it before the copy",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const copy = sentCopy("tag-thread", [QUENTIN], "2026-09-20T10:00:05Z", "thread-tag-thread");
        await seedSend(db, personalMail, copy, {
          state: "sending",
          filled: false,
          begunAt: "2026-09-20T10:00:00Z",
        });
        // The reply first: no evidence row of the thread exists yet; the send's draft names it.
        const reply = received("tag-reply", "thread-tag-thread", "2026-09-20T11:00:00Z");
        await writer.ingestItem(personalMail, mailItem(reply, personalMail), mailFacts(reply));
        expect(await evidenceOf(db, personalMail, reply)).toEqual([
          { system_originated: false, answers_system: true, sent_id: null },
        ]);
        await writer.ingestItem(personalMail, mailItem(copy, personalMail), mailFacts(copy));
        expect((await evidenceOf(db, personalMail, copy))[0]?.system_originated).toBe(true);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "an earlier message of the thread has neither mark; the owner's own hand-sent mail has neither mark; a calendar item has neither mark and makes no call",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail, personalCalendar } = await connect(writer);
        const copy = sentCopy("tag-later", [QUENTIN], "2026-09-20T10:00:05Z", "thread-tag-earlier");
        await seedSend(db, personalMail, copy, {
          state: "sending",
          filled: false,
          begunAt: "2026-09-20T10:00:00Z",
        });
        const earlier = received("tag-earlier", "thread-tag-earlier", "2026-09-20T09:00:00Z");
        await writer.ingestItem(personalMail, mailItem(earlier, personalMail), mailFacts(earlier));
        expect(await evidenceOf(db, personalMail, earlier)).toEqual([
          { system_originated: false, answers_system: false, sent_id: null },
        ]);
        // The owner's own message, typed in Gmail before the send began, to the same person.
        const typed = sentCopy("tag-typed", [QUENTIN], "2026-09-20T09:30:00Z");
        await writer.ingestItem(personalMail, mailItem(typed, personalMail), mailFacts(typed));
        expect(await evidenceOf(db, personalMail, typed)).toEqual([
          { system_originated: false, answers_system: false, sent_id: null },
        ]);

        const { statements } = await recordingStatements(() =>
          writer.ingestItem(personalCalendar, eventItem(EVENTS.canary, personalCalendar), eventFacts(EVENTS.canary)),
        );
        expect(statements.filter((one) => one.text.includes("sent_tag"))).toEqual([]);
        const rows = await queryAs(
          db.urls.admin,
          "select system_originated, answers_system, sent_id from vault.evidence_items where source_account_id = $1",
          [personalCalendar.id],
        );
        expect(rows).toEqual([{ system_originated: false, answers_system: false, sent_id: null }]);
        // The control: an email's ingest makes exactly one call, and it opens no sealed value.
        const reply = received("tag-one-call", "thread-tag-earlier", "2026-09-20T12:00:00Z");
        const mailed = await recordingStatements(() =>
          writer.ingestItem(personalMail, mailItem(reply, personalMail), mailFacts(reply)),
        );
        const calls = mailed.statements.filter((one) => one.text.includes("ledger.sent_tag"));
        expect(calls).toHaveLength(1);
        expect(calls[0]?.text).not.toMatch(/_enc/);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "a later revision of a sent copy is marked again by its own call, and the earlier revision's row is unchanged",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const copy = sentCopy("tag-revised", [QUENTIN], "2026-09-20T10:00:05Z");
        const send = await seedSend(db, personalMail, copy, {
          state: "sent",
          filled: true,
          begunAt: "2026-09-20T10:00:00Z",
        });
        await writer.ingestItem(personalMail, mailItem(copy, personalMail), mailFacts(copy));
        await writer.ingestItem(personalMail, mailRevision(copy, personalMail), mailFacts(copy));
        expect(await evidenceOf(db, personalMail, copy)).toEqual([
          { system_originated: true, answers_system: false, sent_id: send },
          { system_originated: true, answers_system: false, sent_id: send },
        ]);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "a re-derive leaves both marks and sent_id as they were",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        // A person first, then an owner address: the re-derive is needed.
        const toLater = sentCopy("tag-to-later", [LATER_OWNER], "2026-09-19T10:00:00Z");
        await writer.ingestItem(personalMail, mailItem(toLater, personalMail), mailFacts(toLater));
        const copy = sentCopy("tag-rederive", [QUENTIN], "2026-09-20T10:00:05Z", "thread-tag-rederive");
        const send = await seedSend(db, personalMail, copy, {
          state: "sent",
          filled: true,
          begunAt: "2026-09-20T10:00:00Z",
        });
        await writer.ingestItem(personalMail, mailItem(copy, personalMail), mailFacts(copy));
        const reply = received("tag-rederive-reply", "thread-tag-rederive", "2026-09-20T11:00:00Z");
        await writer.ingestItem(personalMail, mailItem(reply, personalMail), mailFacts(reply));
        const fromLater = mail({
          ...sentCopy("tag-from-later", [RHEA], "2026-09-21T10:00:00Z"),
          from: { address: LATER_OWNER.address },
        });
        await writer.ingestItem(personalMail, mailItem(fromLater, personalMail), mailFacts(fromLater));
        const before = await queryAs(
          db.urls.admin,
          "select id, system_originated, answers_system, sent_id from vault.evidence_items order by id",
        );
        expect((await writer.rederiveIfNeeded(derive)).rederived).toBe(true);
        expect(
          await queryAs(
            db.urls.admin,
            "select id, system_originated, answers_system, sent_id from vault.evidence_items order by id",
          ),
        ).toEqual(before);
        expect(before).toContainEqual(expect.objectContaining({ system_originated: true, sent_id: send }));
        expect(before).toContainEqual(expect.objectContaining({ answers_system: true }));
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "Regression: a message that sync stores with no send row of its account is stored exactly as before this step",
    () =>
      withStore(async ({ db, writer }) => {
        const { personalMail } = await connect(writer);
        const typed = sentCopy("tag-plain-sent", [QUENTIN], "2026-09-20T10:00:00Z", "thread-tag-plain");
        const reply = received("tag-plain-reply", "thread-tag-plain", "2026-09-20T11:00:00Z");
        await writer.ingestItem(personalMail, mailItem(typed, personalMail), mailFacts(typed));
        await writer.ingestItem(personalMail, mailItem(reply, personalMail), mailFacts(reply));
        expect(
          await queryAs(db.urls.admin, "select system_originated, answers_system, sent_id from vault.evidence_items"),
        ).toEqual([
          { system_originated: false, answers_system: false, sent_id: null },
          { system_originated: false, answers_system: false, sent_id: null },
        ]);
        // Stage 1's rule still holds: an earlier system-originated row of the thread tags a reply.
        await queryAs(
          db.urls.admin,
          "update vault.evidence_items set system_originated = true where source_item_fp = $1",
          [fingerprint(db.keys, "source_id", mailSourceId(typed))],
        );
        const later = received("tag-plain-later", "thread-tag-plain", "2026-09-20T12:00:00Z", RHEA);
        await writer.ingestItem(personalMail, mailItem(later, personalMail), mailFacts(later));
        expect(await evidenceOf(db, personalMail, later)).toEqual([
          { system_originated: false, answers_system: true, sent_id: null },
        ]);
      }),
    DB_TEST_TIMEOUT,
  );

  it(
    "the writer's role gained no table privilege: it calls one function",
    () =>
      withStore(async ({ db }) => {
        const privileges = await asOwner(db, (query) =>
          query<{ table: string }>(
            `select table_schema || '.' || table_name as table from information_schema.role_table_grants
           where grantee = 'pi_writer' and table_name in ('drafts', 'draft_beliefs', 'gate_checks', 'sent_messages')`,
          ),
        );
        expect(privileges).toEqual([]);
        const [can] = await asOwner(db, (query) =>
          query<{ tag: boolean; begin: boolean }>(
            `select has_function_privilege('pi_writer', 'ledger.sent_tag(text, text, text, text, text[], boolean, timestamptz)', 'EXECUTE') as tag,
                  has_function_privilege('pi_writer', 'ledger.begin_send(text, text, text, text, text, text, boolean, boolean, text[], text, integer, text)', 'EXECUTE') as begin`,
          ),
        );
        expect(can).toEqual({ tag: true, begin: false });
      }),
    DB_TEST_TIMEOUT,
  );
});
