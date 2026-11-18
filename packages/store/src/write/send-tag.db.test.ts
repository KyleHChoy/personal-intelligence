import { describe, expect, it } from "vitest";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import {
  type Account,
  finish,
  hex,
  insertAccount,
  insertMessage,
  madeDraft,
  readyReply,
  recipient,
  type SendCtx,
  sendNow,
  settle,
  TIMEOUT,
  watched,
  withSendWorld,
} from "../test-support/send-fixtures.ts";

// Written without reading the migration.

type Tag = {
  system_originated: boolean;
  answers_system: boolean;
  sent_id: string | null;
};
type TagArgs = {
  account?: Account;
  sourceFp?: string;
  threadFp?: string | null;
  bodyFp?: string | null;
  recipientFps?: string[];
  outbound?: boolean;
  observedAt?: string;
};

const tag = async (w: SendCtx, a: TagArgs): Promise<Tag> =>
  one(
    await queryAs<Tag>(
      w.db.urls.writer,
      "select system_originated, answers_system, sent_id from ledger.sent_tag($1::text, $2::text, $3::text, $4::text, $5::text[], $6::boolean, $7::timestamptz)",
      [
        (a.account ?? w.account).id,
        a.sourceFp ?? hex(),
        a.threadFp === undefined ? null : a.threadFp,
        a.bodyFp === undefined ? null : a.bodyFp,
        [...(a.recipientFps ?? [])].sort(),
        a.outbound ?? true,
        a.observedAt ?? new Date(Date.now() + 1000).toISOString(),
      ],
    ),
  );
const none: Tag = {
  system_originated: false,
  answers_system: false,
  sent_id: null,
};

describe("the tag at sync", { timeout: TIMEOUT }, () => {
  it("a copy with the send's source item fingerprint is system_originated with its sent_id", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const sourceFp = hex();
      await finish(w, send, "sent", {
        sourceFp,
        threadFp: ready.message.threadFp,
      });
      expect(await tag(w, { sourceFp, bodyFp: null, recipientFps: [] })).toEqual({
        system_originated: true,
        answers_system: false,
        sent_id: send,
      });
      // Another source fingerprint, with no body to match, is not the copy.
      expect(
        await tag(w, {
          sourceFp: hex(),
          bodyFp: null,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual(none);
    }));

  it("a copy stored between begin_send and finish_send is system_originated, by body and recipients", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual({
        system_originated: true,
        answers_system: false,
        sent_id: send,
      });
    }));

  it("a copy of a send that was never finished is system_originated, and so is one of a send whose answer was unknown", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "unknown");
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual({
        system_originated: true,
        answers_system: false,
        sent_id: send,
      });
    }));

  it("a failed send's row matches no copy", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "failed", { status: 400 });
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual(none);
    }));

  it("a copy with one recipient more or fewer is not marked", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w, {
        to: ["a@send-example.test", "b@send-example.test"],
      });
      const send = await sendNow(w, ready);
      const extra = recipient(w.db, "c@send-example.test").fp;
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: [...ready.recipientFps, extra],
        }),
      ).toEqual(none);
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps.slice(0, 1),
        }),
      ).toEqual(none);
      expect(
        (
          await tag(w, {
            bodyFp: ready.bodyFp,
            recipientFps: ready.recipientFps,
          })
        ).sent_id,
      ).toBe(send);
    }));

  it("the recipients are compared as the item's sorted fingerprints, each once", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w, {
        to: ["zed@send-example.test", "abe@send-example.test"],
      });
      const send = await sendNow(w, ready);
      expect(
        (
          await tag(w, {
            bodyFp: ready.bodyFp,
            recipientFps: [...ready.recipientFps].reverse(),
          })
        ).sent_id,
      ).toBe(send);
    }));

  it("a message the owner typed with the same words before the send began is not marked", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      await sendNow(w, ready);
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
          observedAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ).toEqual(none);
    }));

  it("a message of another account with the same fingerprints is not marked", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const sourceFp = hex();
      await finish(w, send, "sent", { sourceFp });
      const other = await insertAccount(w.db, w.admin, "second");
      expect(
        await tag(w, {
          account: other,
          sourceFp,
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual(none);
      expect(
        await tag(w, {
          account: other,
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
          outbound: false,
          threadFp: ready.message.threadFp,
        }),
      ).toEqual(none);
    }));

  it("of two sends that match by body and recipients, the earliest not yet named is taken", () =>
    withSendWorld(async (w) => {
      const message = await insertMessage(w, {
        from: "twin@send-example.test",
      });
      await readyReply(w, { to: ["twin@send-example.test"], message });
      const bodyFp = hex();
      const first = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const s1 = await sendNow(w, first);
      // The first failed and was sent again; then a second draft of the same text was sent too.
      await finish(w, s1, "unknown");
      expect(await settle(w, s1, "sent")).toBe("settled");
      // A second draft of the same text, made after the first became sent, is sent too.
      const second = await madeDraft(w, {
        to: ["twin@send-example.test"],
        replyTo: message.id,
        bodyFp,
      });
      const s2 = await sendNow(w, second);
      await finish(w, s2, "unknown");
      const r = recipient(w.db, "twin@send-example.test").fp;
      expect((await tag(w, { bodyFp, recipientFps: [r] })).sent_id).toBe(s1);
      // Once a copy of another source item names the first, the second is taken.
      await insertMessage(w, {
        direction: "outbound",
        to: ["twin@send-example.test"],
        systemOriginated: true,
        sentId: s1,
      });
      expect((await tag(w, { bodyFp, recipientFps: [r] })).sent_id).toBe(s2);
    }));

  it("an inbound message on the thread of a send that is not failed, observed after begun_at, answers_system; one observed before it does not", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      await sendNow(w, ready);
      const threadFp = ready.message.threadFp;
      expect(await tag(w, { outbound: false, threadFp, bodyFp: null })).toEqual({
        system_originated: false,
        answers_system: true,
        sent_id: null,
      });
      expect(
        await tag(w, {
          outbound: false,
          threadFp,
          bodyFp: null,
          observedAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ).toEqual(none);
      // Another thread does not.
      expect(await tag(w, { outbound: false, threadFp: hex(), bodyFp: null })).toEqual(none);
    }));

  it("an inbound message on the thread of a failed send does not answer it", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "failed", { status: 404 });
      expect(
        await tag(w, {
          outbound: false,
          threadFp: ready.message.threadFp,
          bodyFp: null,
        }),
      ).toEqual(none);
    }));

  it("an inbound message on a thread whose earlier evidence row is system_originated answers_system, as stage 1's rule has it", () =>
    withSendWorld(async (w) => {
      const thread = `thread-system-${hex().slice(0, 6)}`;
      const copy = await insertMessage(w, {
        thread,
        direction: "outbound",
        to: ["x@send-example.test"],
        systemOriginated: true,
        at: new Date(Date.now() - 7_200_000).toISOString(),
      });
      expect(
        await tag(w, {
          outbound: false,
          threadFp: copy.threadFp,
          bodyFp: null,
        }),
      ).toEqual({
        system_originated: false,
        answers_system: true,
        sent_id: null,
      });
      // A thread whose earlier rows are all the owner's own answers nothing.
      const plain = await insertMessage(w, {
        direction: "outbound",
        to: ["x@send-example.test"],
        at: new Date(Date.now() - 7_200_000).toISOString(),
      });
      expect(
        await tag(w, {
          outbound: false,
          threadFp: plain.threadFp,
          bodyFp: null,
        }),
      ).toEqual(none);
    }));

  it("a reply to a new-thread send whose thread_fp is still null answers_system by the draft's thread once the copy is stored", () =>
    withSendWorld(async (w) => {
      // The account connected and the recipient known, through a reply set up first.
      await readyReply(w, { to: ["new@send-example.test"] });
      const fresh = await madeDraft(w, { to: ["new@send-example.test"] });
      const send = await sendNow(w, fresh, { newThread: true });
      // The copy is stored before finish_send: marked by body and recipients, with its thread.
      const thread = `thread-new-${hex().slice(0, 6)}`;
      const copyTag = await tag(w, {
        bodyFp: fresh.bodyFp,
        recipientFps: fresh.recipientFps,
      });
      expect(copyTag.sent_id).toBe(send);
      const copy = await insertMessage(w, {
        thread,
        direction: "outbound",
        to: ["new@send-example.test"],
        systemOriginated: true,
        sentId: send,
        at: new Date(Date.now() - 1000).toISOString(),
      });
      expect(
        await tag(w, {
          outbound: false,
          threadFp: copy.threadFp,
          bodyFp: null,
        }),
      ).toEqual({
        system_originated: false,
        answers_system: true,
        sent_id: null,
      });
    }));

  it("after eraseItem of a sent copy, a later outbound message with the same body and recipients is not marked", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      const sourceFp = hex();
      await finish(w, send, "sent", { sourceFp });
      expect((await tag(w, { sourceFp })).sent_id).toBe(send);
      // The erasure's hook clears the fingerprint: the send was filled, so nothing matches it.
      await queryAs(w.db.urls.admin, "select ledger.forget_sent_source($1::text[], $2::text[])", [
        [w.account.id],
        [sourceFp],
      ]);
      expect(await tag(w, { sourceFp })).toEqual(none);
      expect(
        await tag(w, {
          bodyFp: ready.bodyFp,
          recipientFps: ready.recipientFps,
        }),
      ).toEqual(none);
    }));

  it("a send settled sent by the owner is still matched by body and recipients", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      const send = await sendNow(w, ready);
      await finish(w, send, "unknown");
      expect(await settle(w, send, "sent")).toBe("settled");
      expect(
        (
          await tag(w, {
            bodyFp: ready.bodyFp,
            recipientFps: ready.recipientFps,
          })
        ).sent_id,
      ).toBe(send);
      // A send finish_send filled is matched by its source fingerprint alone.
      const other = await readyReply(w, { to: ["filled@send-example.test"] });
      const s2 = await sendNow(w, other);
      await finish(w, s2, "sent");
      expect(
        await tag(w, {
          bodyFp: other.bodyFp,
          recipientFps: other.recipientFps,
        }),
      ).toEqual(none);
    }));

  it("sent_tag writes nothing, and only the writer may call it", () =>
    withSendWorld(async (w) => {
      const ready = await readyReply(w);
      await sendNow(w, ready);
      const before = await watched(w.db);
      await tag(w, { bodyFp: ready.bodyFp, recipientFps: ready.recipientFps });
      await tag(w, { outbound: false, threadFp: ready.message.threadFp });
      expect(await watched(w.db)).toEqual(before);
      for (const url of [w.db.urls.admin, w.db.urls.reader, w.db.urls.proxy, w.db.urls.work]) {
        const state = await queryAs(
          url,
          "select * from ledger.sent_tag($1::text, $2::text, null, null, '{}'::text[], true, now())",
          [w.account.id, hex()],
        ).then(
          () => null,
          (error: { code?: string }) => error.code ?? "?",
        );
        expect(state, url).toBe("42501");
      }
    }));
});
