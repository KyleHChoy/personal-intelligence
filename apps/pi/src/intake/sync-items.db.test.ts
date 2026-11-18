import { EntityId, MessageId } from "@intelligence/contracts/personal";
import { type GmailMessage, gmailItem, type PersonalSource } from "@intelligence/personal-core/items";
import { world } from "@intelligence/personal-core/testing";
import type { SourceAccountRow } from "@intelligence/personal-store";
import { fingerprint } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OK,
  accountOf,
  accountStates,
  addressesIn,
  cleanUp,
  count,
  eventsLogged,
  first,
  fromNell,
  gmailId,
  HOUR,
  isStored,
  kindsOf,
  LONG,
  labelled,
  message,
  NELL,
  NOW,
  ok,
  personalOf,
  readerOf,
  rows,
  type Stack,
  sourcesOf,
  stack,
  stacks,
  sync,
  syncedLine,
  threeAtATime,
  withAdmin,
} from "../test-support/sync-db-fixtures.ts";
import { runSync } from "./sync.ts";

// runSync's items: what reaches a message's or an event's rows, and what a change or deletion
// at the source removes. Shared setup is in sync-db-fixtures.ts.

// The machine is shared: a test that makes a database and syncs the world may take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

describe("runSync", () => {
  it(
    "a message too large is stored by its headers, unreadable, in its sender's timeline, and the run exits 0 with nothing skipped",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const id = w.handles.tooLargeMessageId;
      const sender =
        addressesIn(personalOf(w).messages.find((one) => one.id === id) as GmailMessage, ["from"])[0] ?? "";
      personal.gmail.tooLarge(id);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect((await accountStates(s)).map((one) => one.skipped)).toEqual([0, 0, 0, 0]);
      expect(eventsLogged(s, "item_skipped")).toEqual([]);
      const read = await readerOf(s);
      const entity = await withAdmin(s, (admin) => admin.accounts.inspect(sender));
      expect(entity?.kind).toBe("person");
      const timeline = await read.reader.getTimeline(read.token, { id: EntityId.parse(entity?.id) });
      expect(timeline.ok && timeline.value.entries.length).toBe(1);
      const found = await read.reader.findMessages(read.token, { sender });
      const opened = await read.reader.readMessage(read.token, {
        id: MessageId.parse(found.ok ? found.value.messages[0]?.id : undefined),
      });
      expect(opened.ok && [opened.value.text, opened.value.unreadable, opened.value.chars]).toEqual([null, true, 0]);
    },
    LONG,
  );

  it(
    "a sync ends each account with one account_synced line that counts what it stored, what it stored unreadable, what it held and what a reconcile removed",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      personal.gmail.tooLarge(w.handles.tooLargeMessageId);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      const calendar = await accountOf(s, "personal", "google_calendar");
      const work = await accountOf(s, "work", "google_mail");
      const workCalendar = await accountOf(s, "work", "google_calendar");
      const written = (account: SourceAccountRow) =>
        count(s, "vault.evidence_items", "source_account_id = $1", [account.id]);
      // The two unreadable messages: the one marked too large and the one whose HTML the parse refuses.
      expect(eventsLogged(s, "account_synced")).toEqual([
        syncedLine(mail.id, { stored: await written(mail), unreadable: 2, removed: 0, held: 1, records_removed: 0 }),
        syncedLine(calendar.id, {
          stored: await written(calendar),
          unreadable: 0,
          removed: 0,
          held: 0,
          records_removed: 0,
        }),
        syncedLine(work.id, { stored: await written(work), unreadable: 0, removed: 0, held: 0, records_removed: 0 }),
        syncedLine(workCalendar.id, {
          stored: await written(workCalendar),
          unreadable: 0,
          removed: 0,
          held: 0,
          records_removed: 0,
        }),
      ]);
      // After the account's items_not_stored line.
      const order = s.events
        .filter((one) => one.ids?.account === mail.id && ["items_not_stored", "account_synced"].includes(one.event))
        .map((one) => one.event);
      expect(order).toEqual(["items_not_stored", "account_synced"]);

      // Nothing new: four zeros for each.
      s.events.length = 0;
      expect(await sync(s, all)).toEqual(ALL_OK);
      const zero = { stored: 0, unreadable: 0, removed: 0, held: 0, records_removed: 0 };
      expect(eventsLogged(s, "account_synced")).toEqual(
        [mail, calendar, work, workCalendar].map((one) => syncedLine(one.id, zero)),
      );

      // A message deleted at the source, and a reset: the reconcile removes it.
      personal.gmail.deletePermanently(first(personalOf(w).deleteLater));
      s.events.length = 0;
      expect(await sync(s, [personal], { reset: ["gmail"] })).toEqual({ ...ALL_OK, outcomes: ok("personal") });
      expect(eventsLogged(s, "account_synced")[0]).toEqual(syncedLine(mail.id, { ...zero, removed: 1 }));

      // An account whose sync fails mid-way still has its line, with the counts so far: here
      // after the sent pass's first two pages, four messages.
      const failing = await stack();
      const two = sourcesOf(w, { pageSize: 2 });
      two.personal.gmail.failAt(4, "unavailable");
      expect((await sync(failing, [two.personal])).outcomes[0]).toEqual({
        label: "personal",
        kind: "gmail",
        outcome: "unavailable",
      });
      const failedMail = await accountOf(failing, "personal", "google_mail");
      expect(eventsLogged(failing, "account_synced")[0]).toEqual(syncedLine(failedMail.id, { ...zero, stored: 4 }));
    },
    LONG,
  );

  it(
    "a page that left ids pending in its cursor, killed and rerun, gives the same rows",
    async () => {
      const w = world({ now: NOW });
      const sizes = personalOf(w)
        .messages.map(
          (one) =>
            gmailItem(one, {
              sourceAccount: "acc_01JABCDEFGHJKMNPQRSTVWXYZ1" as SourceAccountRow["id"],
              changeKind: "backfill",
            }).payload.length,
        )
        .sort((a, b) => a - b);
      // Below three payloads of a typical message.
      const pageBytes = 2 * (sizes[Math.floor(sizes.length / 2)] ?? 0);
      // Four messages, each with a text as long as a typical payload, so a history page of them
      // stops at the bound too.
      const body = "Words ".repeat(Math.ceil((sizes[Math.floor(sizes.length / 2)] ?? 0) / 6));
      const later = [20, 19, 18, 17].map((hours, at) => ({
        ...fromNell(`19c000000000000${at + 1}`, first(w.owner.addresses), hours),
        text: body,
      }));
      // A first backfill, then a history run of four messages, with the call numbered `killAt`
      // failing and the sync it failed in run again.
      const run = async (s: Stack, options: { pageBytes?: number }, killAt?: number) => {
        const { all, personal } = sourcesOf(w, options);
        let calls = 0;
        let fired = false;
        const pendingCursors: unknown[] = [];
        const counted = all.map(
          (source): PersonalSource => ({
            ...source,
            connector(id, account, built) {
              const made = source.connector(id, account, built);
              return {
                ...made,
                async listChanges(...given) {
                  calls += 1;
                  if (calls === killAt) {
                    fired = true;
                    throw Object.assign(new Error("unavailable"), { code: "unavailable" });
                  }
                  const page = await made.listChanges(...given);
                  const opened = JSON.parse(Buffer.from(page.next, "base64url").toString("utf8")) as {
                    pending?: string[];
                  };
                  if (opened.pending !== undefined) pendingCursors.push(opened);
                  return page;
                },
              };
            },
          }),
        );
        for (const before of [
          () => {},
          () => {
            later.forEach((one) => {
              personal.gmail.add(one);
            });
          },
        ]) {
          before();
          await runSync({ writer: s.writer, sources: counted, log: s.log, now: NOW });
          if (fired) {
            fired = false;
            expect(
              await runSync({ writer: s.writer, sources: counted, log: s.log, now: NOW }),
              `killed at ${killAt}`,
            ).toEqual(ALL_OK);
          }
        }
        return { calls, pendingCursors };
      };
      const state = async (s: Stack) => ({
        evidence: await rows(
          s,
          "select source_item_fp, revision_tag_fp, revision from vault.evidence_items order by 1, 2",
        ),
        messages: await count(s, "knowledge.messages"),
        interactions: await count(s, "knowledge.interaction_log"),
        entities: await count(s, "knowledge.entities"),
      });
      const plain = await stack();
      await run(plain, {});
      const expected = await state(plain);

      const bound = await stack(plain.db.keyFile);
      const { calls, pendingCursors } = await run(bound, { pageBytes });
      // Pages left ids pending, in the backfill and in history, and the stored cursor holds them.
      expect(pendingCursors.some((one) => (one as { phase?: string }).phase === "list")).toBe(true);
      expect(pendingCursors.some((one) => (one as { phase?: string }).phase === "history")).toBe(true);
      expect(await state(bound)).toEqual(expected);
      // Each revision once: no message is stored twice.
      expect(expected.evidence.every((one) => (one as { revision: number }).revision === 0)).toBe(true);

      await threeAtATime(
        Array.from({ length: 8 }, (_, at) => Math.max(1, Math.round(((at + 1) * calls) / 9))),
        async (point) => {
          const s = await stack(plain.db.keyFile);
          await run(s, { pageBytes }, point);
          expect(await state(s), `killed at call ${point}`).toEqual(expected);
          stacks.splice(stacks.indexOf(s), 1);
          await s.writer.close();
          await s.db.drop();
        },
      );
    },
    LONG,
  );

  it(
    "a message's text, sender, category and attachment list reach its row, for a person's message and for a receipt",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      expect(await sync(s, sourcesOf(w).all)).toEqual(ALL_OK);
      const read = await readerOf(s);
      // The receipt: no entity, found by its sender.
      const receipt = await read.reader.findMessages(read.token, { sender: w.handles.receiptSender });
      expect(
        receipt.ok &&
          receipt.value.messages.map((one) => [one.category, one.bulk, one.sender?.address, one.attachments]),
      ).toEqual([["updates", true, { untrusted: w.handles.receiptSender }, 1]]);
      const opened = await read.reader.readMessage(read.token, {
        id: MessageId.parse(receipt.ok ? receipt.value.messages[0]?.id : undefined),
      });
      expect(opened.ok && opened.value.text?.untrusted).toContain(w.canaries.body);
      expect(opened.ok && opened.value.attachmentList).toEqual([
        { name: { untrusted: w.canaries.attachmentName }, type: { untrusted: "application/pdf" }, size: 48_213 },
      ]);
      // A person's message: the top contact's, found by its entity.
      const entity = await withAdmin(s, (admin) => admin.accounts.inspect(w.handles.topContactAddress));
      const theirs = await read.reader.findMessages(read.token, { entity: EntityId.parse(entity?.id), limit: 50 });
      const inbound = theirs.ok ? theirs.value.messages.filter((one) => one.direction === "inbound") : [];
      expect(inbound.map((one) => [one.category, one.bulk, one.sender])).toEqual(
        Array(5).fill([
          "primary",
          false,
          { address: { untrusted: w.handles.topContactAddress }, name: { untrusted: "Maren Holt" } },
        ]),
      );
      const text = await read.reader.readMessage(read.token, { id: MessageId.parse(inbound[0]?.id) });
      expect(text.ok && text.value.text).toEqual({ untrusted: "Thanks for the note.\nSee you soon.\n" });
    },
    LONG,
  );

  it(
    "a body the parse refuses still gives the message to its people, with no text",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      expect(await sync(s, sourcesOf(w).all)).toEqual(ALL_OK);
      const deep = personalOf(w).messages.find((one) => one.id === w.handles.deepHtmlMessageId) as GmailMessage;
      const sender = addressesIn(deep, ["from"])[0] ?? "";
      expect(await kindsOf(s, sender)).toEqual(["person"]);
      const read = await readerOf(s);
      const entity = await withAdmin(s, (admin) => admin.accounts.inspect(sender));
      const found = await read.reader.findMessages(read.token, { entity: EntityId.parse(entity?.id) });
      const opened = await read.reader.readMessage(read.token, {
        id: MessageId.parse(found.ok ? found.value.messages[0]?.id : undefined),
      });
      expect(opened.ok && [opened.value.text, opened.value.unreadable]).toEqual([null, true]);
    },
    LONG,
  );

  it(
    "a message moved to Updates loses its derived rows",
    async () => {
      const { s, all, gmail, id, held } = await labelled(["INBOX"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 1, nell: ["person"] });

      // Its evidence stays, under a new revision; the rows derived from it go, and the person
      // only it named with them.
      gmail.relabel(id, ["CATEGORY_UPDATES"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 2, messages: 1, interactions: 0, nell: [] });

      // Updates, the inbox, then Updates again: a label set seen before is a new revision.
      gmail.relabel(id, ["INBOX"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      gmail.relabel(id, ["CATEGORY_UPDATES"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 4, messages: 1, interactions: 0, nell: [] });
    },
    LONG,
  );

  it(
    "a non-deriving label change fetches and stores nothing",
    async () => {
      const { s, all, gmail, id, held } = await labelled(["INBOX", "UNREAD"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const before = { revisions: 1, messages: 1, interactions: 1, nell: ["person"] };
      expect(await held()).toEqual(before);
      const stored = await count(s, "vault.evidence_items");

      // Read, starred, filed under a user label, then trashed: none of them is a label the
      // derived rows depend on, so the message is not handed over and no revision is made.
      gmail.relabel(id, ["INBOX", "STARRED", "Label_7"]);
      gmail.trash(id);
      // The wrapped source counts what each page of changes hands over.
      let handed = 0;
      const counting = all.map(
        (source): PersonalSource => ({
          ...source,
          connector(kind, account, options) {
            const made = source.connector(kind, account, options);
            return {
              ...made,
              async listChanges(...given) {
                const page = await made.listChanges(...given);
                handed += page.items.length + page.deletions.length + page.skipped.length;
                return page;
              },
            };
          },
        }),
      );
      expect(await sync(s, counting)).toEqual(ALL_OK);
      expect(handed).toBe(0);
      expect(await held()).toEqual(before);
      expect(await count(s, "vault.evidence_items")).toBe(stored);

      // The positive control: a deriving label on the same message is handed over and stored.
      gmail.relabel(id, ["CATEGORY_UPDATES"]);
      expect(await sync(s, counting)).toEqual(ALL_OK);
      expect(handed).toBe(1);
      expect((await held()).revisions).toBe(2);
    },
    LONG,
  );

  it(
    "a full relist picks up a changed label",
    async () => {
      const { s, all, gmail, id, held } = await labelled(["CATEGORY_UPDATES"]);
      expect(await sync(s, all)).toEqual(ALL_OK);
      // First seen under Updates, it is bulk: its evidence and its message row are kept, and no
      // person or interaction is derived from it.
      expect(await held()).toEqual({ revisions: 1, messages: 1, interactions: 0, nell: [] });

      // The label changes, and the next sync is a full listing: no history page is read before
      // the listing hands the message over, with the labels it has now.
      gmail.relabel(id, ["INBOX"]);
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);
      expect(await held()).toEqual({ revisions: 2, messages: 1, interactions: 1, nell: ["person"] });

      // The positive control: a relist with nothing changed is a repeat, and stores no revision.
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);
      expect((await held()).revisions).toBe(2);
    },
    LONG,
  );

  it(
    "a message is stored under its Gmail id, and removed when deleted",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      // The message with no Message-ID header: its Gmail id is the only name it has.
      const id = w.handles.noMessageIdMessageId;
      expect(
        (w.accounts[0]?.messages ?? [])
          .find((one) => one.id === id)
          ?.headers.some((header) => header.name === "Message-ID"),
      ).toBe(false);

      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(id))).toBe(true);
      expect(await isStored(s, id)).toBe(false);

      personal.gmail.deletePermanently(id);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(id))).toBe(false);
    },
    LONG,
  );

  it(
    "two messages with one Message-ID are two items, and deleting one leaves the other",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const to = first(w.owner.addresses);
      personal.gmail.add(
        message("19c0000000000001", `Nell Ashdown <${NELL}>`, to, 30, { messageId: "<same@id.example.com>" }),
      );
      personal.gmail.add(
        message("19c0000000000002", `Nell Ashdown <${NELL}>`, to, 31, { messageId: "<same@id.example.com>" }),
      );

      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await isStored(s, gmailId("19c0000000000002"))).toBe(true);

      personal.gmail.deletePermanently("19c0000000000001");
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(false);
      expect(await isStored(s, gmailId("19c0000000000002"))).toBe(true);
      expect(await kindsOf(s, NELL)).toEqual(["person"]);
    },
    LONG,
  );

  it(
    "an event deleted at the source is removed with its participants",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const me = first(w.owner.addresses);
      // An event whose one guest appears in no other item.
      personal.calendar.upsert({
        id: "evt-added",
        status: "confirmed",
        summary: "Supper",
        start: { dateTime: new Date(NOW.getTime() + 50 * HOUR).toISOString() },
        end: { dateTime: new Date(NOW.getTime() + 51 * HOUR).toISOString() },
        organizer: { email: me, self: true },
        attendees: [
          { email: me, self: true, responseStatus: "accepted" },
          { email: NELL, displayName: "Nell Ashdown", responseStatus: "accepted" },
        ],
      });
      const details = () =>
        rows<{ event_id: string }>(s, "select event_id from knowledge.event_details where source_event_fp = $1", [
          fingerprint(s.db.keys, "source_id", "evt-added"),
        ]);

      expect(await sync(s, all)).toEqual(ALL_OK);
      const [event] = await details();
      expect(event).toBeDefined();
      expect(await count(s, "knowledge.event_participants", "event_id = $1", [event?.event_id])).toBe(1);
      expect(await kindsOf(s, NELL)).toEqual(["person"]);

      personal.calendar.remove("evt-added");
      expect(await sync(s, all)).toEqual(ALL_OK);

      expect(await isStored(s, "evt-added")).toBe(false);
      expect(await details()).toEqual([]);
      expect(await count(s, "knowledge.events", "id = $1", [event?.event_id])).toBe(0);
      expect(await count(s, "knowledge.event_participants", "event_id = $1", [event?.event_id])).toBe(0);
      expect(await kindsOf(s, NELL)).toEqual([]);
    },
    LONG,
  );

  it(
    "a cancelled event that keeps its fields stays, marked cancelled",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const details = (id: string) =>
        rows<{ event_id: string; cancelled: boolean }>(
          s,
          "select event_id, cancelled from knowledge.event_details where source_event_fp = $1",
          [fingerprint(s.db.keys, "source_id", id)],
        );

      expect(await sync(s, all)).toEqual(ALL_OK);
      expect((await details(w.handles.cancelledEventId)).map((row) => row.cancelled)).toEqual([true]);
      const [before] = await details(w.handles.eightDayEventId);
      expect(before?.cancelled).toBe(false);

      // An event cancelled later, with its fields kept, is a new revision of the same event.
      const kept = (w.accounts[0]?.events ?? []).find((one) => one.id === w.handles.eightDayEventId);
      if (kept === undefined) throw new Error("no such event");
      personal.calendar.upsert({ ...kept, status: "cancelled" });
      expect(await sync(s, all)).toEqual(ALL_OK);

      expect(await details(w.handles.eightDayEventId)).toEqual([{ event_id: before?.event_id, cancelled: true }]);
      expect(await count(s, "knowledge.event_participants", "event_id = $1", [before?.event_id])).toBe(1);
    },
    LONG,
  );

  it(
    "an item whose facts cannot be read is stored, counted in skipped_items, and derives nothing",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect((await accountStates(s)).map((one) => one.skipped)).toEqual([0, 0, 0, 0]);

      // One message with no From header, which the shared parse refuses, and one the source
      // will not let the connector read.
      const to = first(w.owner.addresses);
      personal.gmail.add(message("19c0000000000001", "", to, 30, { noFrom: true }));
      personal.gmail.add(fromNell("19c0000000000002", to));
      personal.gmail.add(message("19c0000000000003", "Orla Finn <orla.finn@example.org>", to, 32));
      personal.gmail.forbid("19c0000000000002");
      expect(await sync(s, all)).toEqual(ALL_OK);

      expect((await accountStates(s))[0]).toMatchObject({ connector: "google_mail", outcome: "ok", skipped: 2 });
      // Each has its line: the count matches the lines, and each skip carries its code.
      const mail = await accountOf(s, "personal", "google_mail");
      expect(eventsLogged(s, "item_unread")).toEqual([{ event: "item_unread", ids: { account: mail.id } }]);
      expect(eventsLogged(s, "item_skipped")).toEqual([
        { event: "item_skipped", code: "forbidden", ids: { account: mail.id } },
      ]);
      const [unread] = await rows<{ id: string }>(s, "select id from vault.evidence_items where source_item_fp = $1", [
        fingerprint(s.db.keys, "source_id", gmailId("19c0000000000001")),
      ]);
      expect(unread).toBeDefined();
      expect(await count(s, "knowledge.messages", "evidence_id = $1", [unread?.id])).toBe(0);
      expect(await count(s, "knowledge.interaction_log", "evidence_id = $1", [unread?.id])).toBe(0);
      expect(await isStored(s, gmailId("19c0000000000002"))).toBe(false);
      expect(await kindsOf(s, NELL)).toEqual([]);
      // The positive control: the message beside them was read.
      expect(await kindsOf(s, "orla.finn@example.org")).toEqual(["person"]);

      // The count is each run's own.
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect((await accountStates(s))[0]).toMatchObject({ skipped: 0 });
    },
    LONG,
  );
});
