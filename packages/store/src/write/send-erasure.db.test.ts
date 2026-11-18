import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, MessageId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { connect, OWNER, QUENTIN, RHEA } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mail, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  appendDraft,
  connectForSend,
  draftArgs,
  finish,
  gateDraft,
  hex,
  insertSendClient,
  knownTo,
  latest,
  madeDraft,
  recipient,
  type SendCtx,
  sendNow,
  syncedAt,
  TIMEOUT,
} from "../test-support/send-fixtures.ts";
import { openStore } from "../test-support/store.ts";

// Written without reading the migration or the hooks.

type World = SendCtx & {
  erase: Admin;
  message: (fixture: MailFixture) => Promise<{ id: MessageId; evidence: string }>;
  personOf: (address: string) => Promise<EntityId>;
};

async function inWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-send-erase-"));
  const store = await openStore({ compartments: ["own", "employer:example"] });
  try {
    const accounts = await connect(store.writer);
    const erase = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      recordEnabled: true,
    });
    const client = await insertSendClient(store.db, "drafter");
    await session(store.db.urls.admin, (admin) =>
      fn({
        db: store.db,
        admin,
        client,
        account: {
          id: accounts.personalMail.id,
          label: accounts.personalMail.label,
          address: OWNER.personal,
          compartments: ["own"],
        },
        erase,
        message: async (fixture) => {
          expect(await ingestMail(store.writer, accounts.personalMail, fixture)).toBe("stored");
          const row = one(
            await admin<{ id: string; evidence_id: string }>(
              "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
              [accounts.personalMail.id, fingerprint(store.db.keys, "source_id", mailSourceId(fixture))],
            ),
          );
          return { id: row.id as MessageId, evidence: row.evidence_id };
        },
        personOf: async (address) =>
          one(
            await admin<{ entity_id: string }>(
              "select distinct entity_id from knowledge.accounts where value_fp = $1",
              [fingerprint(store.db.keys, "address", address)],
            ),
          ).entity_id as EntityId,
      }),
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const req = (): string => testId("req");
const holding = async (w: World, fp: string): Promise<{ drafts: number; sends: number }> => ({
  drafts: one(
    await w.admin<{ n: number }>("select count(*)::int as n from ledger.drafts where $1 = any (recipient_fps)", [fp]),
  ).n,
  sends: one(
    await w.admin<{ n: number }>("select count(*)::int as n from ledger.sent_messages where $1 = any (recipient_fps)", [
      fp,
    ]),
  ).n,
});
const ready = async (w: World): Promise<void> => {
  await connectForSend(w, w.account);
  await syncedAt(w, w.account, 5);
};

// A sent copy the owner's account stores: the owner writing to Rhea.
const COPY: MailFixture = mail({
  id: "gm-send-copy-0901",
  threadId: "thread-send-copy-0901",
  messageId: "copy-0901@send-home.test",
  at: "2026-09-03T09:00:00Z",
  from: { address: OWNER.personal, name: OWNER.name },
  to: [RHEA],
  subject: "A sent copy",
  labels: ["SENT"],
});

describe("an erasure reaches drafts and sends", { timeout: TIMEOUT }, () => {
  it("after erasePerson, no row of drafts or sent_messages holds the person's address fingerprint or a value computed from it: a tainted draft's case_key is null, and ErasureReport.more holds send_recipients with the count", () =>
    inWorld(async (w) => {
      const quentin = recipient(w.db, QUENTIN.address);
      // A draft to Quentin made before Quentin had an entity: its basis does not cite Quentin.
      const early = draftArgs(w, { to: [QUENTIN.address] });
      expect(await appendDraft(w, early)).toBe(early.id);
      await gateDraft(w, early.id, early.payloadFp);
      expect(
        one(
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.basis where row_kind = 'draft' and row_id = $1",
            [early.id],
          ),
        ).n,
      ).toBe(0);

      const fromQuentin = await w.message(MAIL.fromQuentin);
      await ready(w);
      await knownTo(w, [QUENTIN.address, RHEA.address]);
      // A reply to Quentin and Rhea, sent: the send keeps Rhea.
      const reply = await madeDraft(w, {
        to: [QUENTIN.address, RHEA.address],
        replyTo: fromQuentin.id,
      });
      const send = await sendNow(w, reply);
      await finish(w, send, "sent");
      expect(await holding(w, quentin.fp)).toEqual({ drafts: 2, sends: 1 });

      const dry = await w.erase.erasure.erasePerson(await w.personOf(QUENTIN.address), {
        requestId: req(),
        dryRun: true,
      });
      expect(await holding(w, quentin.fp), "a dry run changes no row").toEqual({
        drafts: 2,
        sends: 1,
      });
      const report = await w.erase.erasure.erasePerson(await w.personOf(QUENTIN.address), { requestId: req() });
      expect(report.more).toMatchObject({ send_recipients: 3 });
      expect(dry.more).toMatchObject({
        send_recipients: report.more.send_recipients,
      });
      expect(await holding(w, quentin.fp)).toEqual({ drafts: 0, sends: 0 });

      for (const id of [early.id, reply.id]) {
        const row = one(
          await w.admin<{
            tainted: boolean;
            body: unknown;
            case_key: string | null;
          }>("select tainted_at is not null as tainted, body_enc as body, case_key from ledger.drafts where id = $1", [
            id,
          ]),
        );
        expect(row, id).toEqual({ tainted: true, body: null, case_key: null });
      }
      // The send's row keeps every other recipient and is not tainted.
      const sent = one(
        await w.admin<{ recipient_fps: string[]; tainted: boolean }>(
          "select recipient_fps, tainted_at is not null as tainted from ledger.sent_messages where id = $1",
          [send],
        ),
      );
      expect(sent).toEqual({
        recipient_fps: [recipient(w.db, RHEA.address).fp],
        tainted: false,
      });
    }));

  it("forget_recipients withdraws the draft's undecided card in the same transaction", () =>
    inWorld(async (w) => {
      const d = await madeDraft(w, { to: [QUENTIN.address] });
      const card = testId("crd");
      await w.admin(
        `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, case_key, compartments) values ($1, $2, now(), $3, 'draft_waiting', 'draft', $4, '{reject,acknowledge}', $5, '{own}')`,
        [card, req(), `client:${w.client.id}`, d.id, `draft:${d.id}`],
      );
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:test', '{own}')",
        [card],
      );
      const n = one(
        await queryAs<{ n: number }>(w.db.urls.admin, "select ledger.forget_recipients($1::text[]) as n", [
          [recipient(w.db, QUENTIN.address).fp],
        ]),
      ).n;
      expect(n).toBe(1);
      expect(await latest(w, "card", card)).toBe("withdrawn");
      // A second call changes nothing.
      expect(
        one(
          await queryAs<{ n: number }>(w.db.urls.admin, "select ledger.forget_recipients($1::text[]) as n", [
            [recipient(w.db, QUENTIN.address).fp],
          ]),
        ).n,
      ).toBe(0);
    }));

  it("after eraseItem of a sent copy, no row of sent_messages holds its source fingerprint, thread_fp is kept, and ErasureReport.more holds sent_source with the count", () =>
    inWorld(async (w) => {
      await ready(w);
      await knownTo(w, [RHEA.address]);
      const copy = await w.message(COPY);
      const sourceFp = fingerprint(w.db.keys, "source_id", mailSourceId(COPY));
      const threadFp = fingerprint(w.db.keys, "thread", COPY.threadId);
      const d = await madeDraft(w, { to: [RHEA.address] });
      const send = await sendNow(w, d, { newThread: true });
      await finish(w, send, "sent", { sourceFp, threadFp });
      // A second send of the account whose copy is another item stays.
      const other = await madeDraft(w, { to: ["other@send-example.test"] });
      await knownTo(w, ["other@send-example.test"]);
      const keep = hex();
      const s2 = await sendNow(w, other, { newThread: true });
      await finish(w, s2, "sent", { sourceFp: keep });

      const dry = await w.erase.erasure.eraseItem({ kind: "message", id: copy.id }, { requestId: req(), dryRun: true });
      expect(
        one(
          await w.admin<{ fp: string }>("select source_item_fp as fp from ledger.sent_messages where id = $1", [send]),
        ).fp,
        "a dry run changes no row",
      ).toBe(sourceFp);
      const report = await w.erase.erasure.eraseItem({ kind: "message", id: copy.id }, { requestId: req() });
      expect(report.more).toMatchObject({ sent_source: 1 });
      expect(dry.more).toMatchObject({ sent_source: 1 });
      expect(
        one(
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.sent_messages where source_item_fp = $1",
            [sourceFp],
          ),
        ).n,
      ).toBe(0);
      expect(
        one(
          await w.admin(
            "select source_item_fp, thread_fp, sent_at is not null as at from ledger.sent_messages where id = $1",
            [send],
          ),
        ),
      ).toEqual({ source_item_fp: null, thread_fp: threadFp, at: true });
      expect(
        one(await w.admin<{ fp: string }>("select source_item_fp as fp from ledger.sent_messages where id = $1", [s2]))
          .fp,
      ).toBe(keep);
      // A second fill by finish_send is refused; the hook's clearing to null was not.
      expect(await finish(w, send, "sent", { sourceFp })).toBe(false);
    }));

  it("forget_sent_source clears only the rows of the erased item's account and source fingerprint, as the hook gets them in `sources`, and a dry run counts the same rows", () =>
    inWorld(async (w) => {
      await ready(w);
      await knownTo(w, [RHEA.address]);
      const fp = hex();
      const d = await madeDraft(w, { to: [RHEA.address] });
      const send = await sendNow(w, d, { newThread: true });
      await finish(w, send, "sent", { sourceFp: fp });
      const otherAccount = testId("acc");
      // Another account's pair with the same fingerprint, and this account's other fingerprint: nothing.
      expect(
        one(
          await queryAs<{ n: number }>(
            w.db.urls.admin,
            "select ledger.forget_sent_source($1::text[], $2::text[]) as n",
            [[otherAccount], [fp]],
          ),
        ).n,
      ).toBe(0);
      expect(
        one(
          await queryAs<{ n: number }>(
            w.db.urls.admin,
            "select ledger.forget_sent_source($1::text[], $2::text[]) as n",
            [[w.account.id], [hex()]],
          ),
        ).n,
      ).toBe(0);
      expect(
        one(
          await queryAs<{ n: number }>(
            w.db.urls.admin,
            "select ledger.forget_sent_source($1::text[], $2::text[]) as n",
            [
              [otherAccount, w.account.id],
              [hex(), fp],
            ],
          ),
        ).n,
      ).toBe(1);
      expect(
        one(
          await w.admin<{ fp: string | null }>("select source_item_fp as fp from ledger.sent_messages where id = $1", [
            send,
          ]),
        ).fp,
      ).toBeNull();
    }));

  it("forget_recipients and forget_sent_source as any role but pi_admin are refused", () =>
    inWorld(async (w) => {
      for (const url of [w.db.urls.writer, w.db.urls.reader, w.db.urls.proxy, w.db.urls.work, w.db.urls.pipeline]) {
        expect(await sqlState(() => queryAs(url, "select ledger.forget_recipients($1::text[])", [[hex()]])), url).toBe(
          "42501",
        );
        expect(
          await sqlState(() =>
            queryAs(url, "select ledger.forget_sent_source($1::text[], $2::text[])", [[w.account.id], [hex()]]),
          ),
          url,
        ).toBe("42501");
      }
      expect(
        await sqlState(() => queryAs(w.db.urls.admin, "select ledger.forget_recipients($1::text[])", [[hex()]])),
      ).toBeNull();
      expect(
        await sqlState(() =>
          queryAs(w.db.urls.admin, "select ledger.forget_sent_source($1::text[], $2::text[])", [
            [w.account.id],
            [hex()],
          ]),
        ),
      ).toBeNull();
    }));

  it("a draft to an erased person is tainted and its body cleared, also one whose basis cited them; a draft to anyone else is untouched", () =>
    inWorld(async (w) => {
      const fromQuentin = await w.message(MAIL.fromQuentin);
      const cited = await madeDraft(w, {
        to: [QUENTIN.address],
        replyTo: fromQuentin.id,
      });
      const other = await madeDraft(w, { to: [RHEA.address] });
      await w.erase.erasure.erasePerson(await w.personOf(QUENTIN.address), {
        requestId: req(),
      });
      expect(
        one(
          await w.admin<{ t: boolean; b: unknown }>(
            "select tainted_at is not null as t, body_enc as b from ledger.drafts where id = $1",
            [cited.id],
          ),
        ),
      ).toEqual({ t: true, b: null });
      expect(
        one(
          await w.admin<{ t: boolean }>("select tainted_at is not null as t from ledger.drafts where id = $1", [
            other.id,
          ]),
        ).t,
      ).toBe(false);
    }));
});
