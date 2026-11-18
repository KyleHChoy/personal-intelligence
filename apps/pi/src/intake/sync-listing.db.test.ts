import type { CalendarEvent, GmailMessage } from "@intelligence/personal-core/items";
import { type WorldAccount, world } from "@intelligence/personal-core/testing";
import { fingerprint } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OK,
  accountOf,
  accountStates,
  cleanUp,
  count,
  eventsLogged,
  failed,
  first,
  fromNell,
  gmailId,
  HOUR,
  headerOf,
  inWindow,
  isJunk,
  isSent,
  isStored,
  keptBy,
  kindsOf,
  LONG,
  leftOut,
  NELL,
  NOW,
  newestFirst,
  ok,
  pagesOf,
  passes,
  personalOf,
  pi,
  reconcileSkipped,
  rows,
  sourcesOf,
  stack,
  sync,
  syncEnv,
  syncedLine,
  withAdmin,
} from "../test-support/sync-db-fixtures.ts";

// runSync's listings and cursors: the first backfill, incremental syncs, reconciles, resets, and
// the failures that leave a cursor where it was. Shared setup is in sync-db-fixtures.ts.

// The machine is shared: a test that makes a database and syncs the world may take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterEach(cleanUp);

describe("runSync", () => {
  it(
    "a first backfill covers the window, reconciles nothing and logs reconcile_skipped",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      // The window holds less than the mailbox: the rest is older than it.
      expect(box.messages.filter((one) => !inWindow(one)).length).toBeGreaterThan(4);

      expect(await sync(s, all)).toEqual(ALL_OK);

      // What is inside the window and kept is stored; nothing older is fetched or stored. One
      // call for the profile, one per page of the two passes, and the empty history page.
      const kept = new Set(keptBy(box).map((one) => one.id));
      for (const one of box.messages) expect(await isStored(s, gmailId(one.id)), one.id).toBe(kept.has(one.id));
      expect(
        personal.gmail.fetched.filter((id) => !inWindow(box.messages.find((one) => one.id === id) as GmailMessage)),
      ).toEqual([]);
      const { sent, rest } = passes(box, 2);
      expect(personal.gmail.calls).toBe(1 + sent + rest + 1);

      // Each mail listing ended at its window without reconciling; the calendar listings ended complete.
      const mail = await accountOf(s, "personal", "google_mail");
      const work = await accountOf(s, "work", "google_mail");
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([reconcileSkipped(mail.id), reconcileSkipped(work.id)]);
      expect(await count(s, "vault.listed_items")).toBe(0);
    },
    LONG,
  );

  it(
    "an incremental sync adds and removes",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(doomed))).toBe(true);
      expect(await isStored(s, w.handles.eightDayEventId)).toBe(true);
      expect(await kindsOf(s, NELL)).toEqual([]);
      const calls = personal.gmail.calls;

      personal.gmail.add(fromNell("19c0000000000001", first(w.owner.addresses)));
      personal.gmail.deletePermanently(doomed);
      const dinner: CalendarEvent = {
        id: "evt-added",
        status: "confirmed",
        summary: "Supper",
        start: { dateTime: new Date(NOW.getTime() + 50 * HOUR).toISOString() },
        end: { dateTime: new Date(NOW.getTime() + 51 * HOUR).toISOString() },
        organizer: { email: first(w.owner.addresses), self: true },
        attendees: [
          { email: first(w.owner.addresses), self: true, responseStatus: "accepted" },
          { email: NELL, responseStatus: "accepted" },
        ],
      };
      personal.calendar.upsert(dinner);
      personal.calendar.remove(w.handles.eightDayEventId);
      expect(await sync(s, all)).toEqual(ALL_OK);

      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(await isStored(s, "evt-added")).toBe(true);
      expect(await isStored(s, w.handles.eightDayEventId)).toBe(false);
      expect(await kindsOf(s, NELL)).toEqual(["person"]);
      // It read history, not the mailbox again: the profile, one page of changes, one empty page.
      expect(personal.gmail.calls - calls).toBe(3);
    },
    LONG,
  );

  it(
    "a draft is never stored",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      // The draft is on the rest pass's first page, beside a message that is stored.
      const [mate, draft] = newestFirst(box.messages.filter((one) => inWindow(one) && !isSent(one) && !isJunk(one)));
      expect(draft?.id).toBe(w.handles.draftMessageId);
      const recipient = headerOf(w, w.handles.draftMessageId, "To");

      // Killed at the page after it, the listing has handed over the draft and stored only the other.
      personal.gmail.failAt(1 + passes(box, 2).sent + 2, "unavailable");
      expect((await sync(s, all)).outcomes[0]).toEqual({ label: "personal", kind: "gmail", outcome: "unavailable" });
      const mail = await accountOf(s, "personal", "google_mail");
      // The draft's id is listed: it is the page's, though it is not stored.
      expect(
        await count(s, "vault.listed_items", "account_id = $1 and source_item_fp = $2", [
          mail.id,
          fingerprint(s.db.keys, "source_id", gmailId(w.handles.draftMessageId)),
        ]),
      ).toBe(1);
      expect(await isStored(s, gmailId(mate?.id ?? ""))).toBe(true);
      expect(await isStored(s, gmailId(w.handles.draftMessageId))).toBe(false);

      expect((await sync(s, all)).outcomes).toEqual(ALL_OK.outcomes);
      expect(await isStored(s, gmailId(w.handles.draftMessageId))).toBe(false);
      expect(await kindsOf(s, recipient)).toEqual([]);
      // The positive control: a person on a message that is no draft is there.
      expect(await kindsOf(s, w.handles.topContactAddress)).toEqual(["person"]);
    },
    LONG,
  );

  it(
    "a trashed message survives a full sync",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const inTrash = first((w.accounts[0]?.messages ?? []).filter((one) => one.labelIds.includes("TRASH"))).id;
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(inTrash))).toBe(true);

      personal.gmail.trash(w.handles.noMessageIdMessageId);
      personal.gmail.deletePermanently(doomed);
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);

      expect(await isStored(s, gmailId(inTrash))).toBe(true);
      expect(await isStored(s, gmailId(w.handles.noMessageIdMessageId))).toBe(true);
      // The positive control: the same full listing removed the message that was deleted.
      expect(await isStored(s, gmailId(doomed))).toBe(false);
    },
    LONG,
  );

  it(
    "an out-of-order listing removes nothing it did not cover",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      expect(await sync(s, sourcesOf(w).all)).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      const stored = await count(s, "vault.evidence_items", "source_account_id = $1", [mail.id]);
      const messages = personalOf(w).messages;
      expect(stored).toBe(keptBy(personalOf(w)).length);

      // A new first listing, one message a page, in an order that is not newest first: it covers
      // the window only, so a message it does not reach is no message it removes.
      await s.writer.setCursor(mail, null);
      const shuffled = sourcesOf(w, { pageSize: 1, order: "shuffled" });
      s.events.length = 0;
      expect(await sync(s, shuffled.all)).toEqual(ALL_OK);

      // It stopped short of the mailbox's end, and removed nothing.
      expect(shuffled.personal.gmail.calls).toBeLessThan(messages.length);
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([{ event: "reconcile_skipped", ids: { account: mail.id } }]);
      expect(await count(s, "vault.evidence_items", "source_account_id = $1", [mail.id])).toBe(stored);
    },
    LONG,
  );

  it(
    "an expired cursor starts a new listing that reads the window again and reconciles the rest",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      const older = box.messages.filter((one) => !inWindow(one));
      const doomed = first(box.deleteLater);
      // A stored message older than the window, put there by an earlier run with a longer window.
      const old = first(newestFirst(older.filter((one) => !leftOut(one))));
      expect(await sync(s, all, { backfillDays: 365 })).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(old.id))).toBe(true);
      expect(await isStored(s, gmailId(doomed))).toBe(true);

      // A message inside the window is deleted, and history from before it is no longer kept.
      personal.gmail.deletePermanently(doomed);
      personal.gmail.expireHistoryBefore("1001");
      const fetched = personal.gmail.fetched.length;
      s.events.length = 0;
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);

      // The new listing read the window, named what is older, ended complete and reconciled:
      // the deleted message is gone, the old one Gmail still has stays, and nothing older than
      // the window was fetched.
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(await isStored(s, gmailId(old.id))).toBe(true);
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([]);
      expect(personal.gmail.fetched.slice(fetched).filter((id) => older.some((one) => one.id === id))).toEqual([]);

      // Once Gmail deletes the old message too, the next reconciling listing removes it.
      personal.gmail.deletePermanently(old.id);
      personal.gmail.expireHistoryBefore("1002");
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(old.id))).toBe(false);

      // In a store a 90-day run made, no message older than the window was fetched or stored.
      const fresh = await stack(s.db.keyFile);
      const again = sourcesOf(w, { pageSize: 2 });
      expect(await sync(fresh, again.all)).toEqual(ALL_OK);
      again.personal.gmail.deletePermanently(doomed);
      again.personal.gmail.expireHistoryBefore("1001");
      expect(await sync(fresh, again.all)).toEqual(ALL_OK);
      expect(again.personal.gmail.fetched.filter((id) => older.some((one) => one.id === id))).toEqual([]);
      for (const one of older) expect(await isStored(fresh, gmailId(one.id)), one.id).toBe(false);
      expect(await isStored(fresh, gmailId(doomed))).toBe(false);
    },
    LONG,
  );

  it(
    "a full listing removes what the source no longer lists",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      const sender = w.handles.oneMessageSenderAddress;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(doomed))).toBe(true);
      expect(await kindsOf(s, sender)).toEqual(["person"]);

      // With the cursor cleared no history reports the deletion: only the listing's end can.
      personal.gmail.deletePermanently(doomed);
      expect(await sync(s, all, { reset: ["gmail", "calendar"] })).toEqual(ALL_OK);

      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(await kindsOf(s, sender)).toEqual([]);
    },
    LONG,
  );

  it(
    "a listing that failed removes nothing",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      expect(await sync(s, all)).toEqual(ALL_OK);

      // The full listing fails at its third page.
      personal.gmail.deletePermanently(doomed);
      personal.gmail.failAt(personal.gmail.calls + 4, "unavailable");
      const failed = await sync(s, all, { reset: ["gmail"] });

      expect(failed.outcomes).toEqual([
        { label: "personal", kind: "gmail", outcome: "unavailable" },
        ...ok("personal").slice(1),
        ...ok("work"),
      ]);
      expect((await accountStates(s))[0]).toMatchObject({
        label: "personal",
        connector: "google_mail",
        outcome: "unavailable",
      });
      expect(await isStored(s, gmailId(doomed))).toBe(true);
    },
    LONG,
  );

  it(
    "killed between history pages, a rerun misses nothing",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      expect(await sync(s, all)).toEqual(ALL_OK);

      // Six changes: three history pages. The second page fails.
      const added = [
        "19c0000000000001",
        "19c0000000000002",
        "19c0000000000003",
        "19c0000000000004",
        "19c0000000000005",
      ];
      for (const [at, id] of added.entries()) personal.gmail.add(fromNell(id, first(w.owner.addresses), 30 + at));
      personal.gmail.deletePermanently(doomed);
      personal.gmail.failAt(personal.gmail.calls + 3, "unavailable");
      expect((await sync(s, all)).outcomes[0]).toEqual({ label: "personal", kind: "gmail", outcome: "unavailable" });
      expect(await Promise.all(added.map((id) => isStored(s, gmailId(id))))).toEqual([true, true, false, false, false]);
      expect(await isStored(s, gmailId(doomed))).toBe(true);

      const calls = personal.gmail.calls;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await Promise.all(added.map((id) => isStored(s, gmailId(id))))).toEqual([true, true, true, true, true]);
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      // It resumed at the second page: the profile, two pages of changes, one empty page.
      expect(personal.gmail.calls - calls).toBe(4);
    },
    LONG,
  );

  it(
    "an empty page with a next page token does not end the run",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      expect(await sync(s, all)).toEqual(ALL_OK);

      // Three changes, two to a page. The first page holds two label changes that derive
      // nothing, so it hands nothing over; the message is on the page after it.
      const [one, other] = newestFirst(w.accounts[0]?.messages ?? []).filter((message) => !leftOut(message));
      personal.gmail.relabel(one?.id ?? "", [...(one?.labelIds ?? []), "STARRED"]);
      personal.gmail.relabel(other?.id ?? "", [...(other?.labelIds ?? []), "Label_7"]);
      personal.gmail.add(fromNell("19c0000000000001", first(w.owner.addresses)));
      const calls = personal.gmail.calls;
      expect(await sync(s, all)).toEqual(ALL_OK);

      // The run read on past the empty page: the profile, the two pages, and the page that
      // holds nothing and leads nowhere, which ends it.
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(personal.gmail.calls - calls).toBe(4);
    },
    LONG,
  );

  it(
    "a listing killed mid-way resumes at its stored page and still reconciles",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      const older = box.messages.filter((one) => !inWindow(one));
      const doomed = first(box.deleteLater);
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      // Each reconciling listing pages over the mailbox as it is, without what was deleted first.
      const without = (...ids: string[]): WorldAccount => ({
        ...box,
        messages: box.messages.filter((one) => !ids.includes(one.id)),
      });
      const { sent, rest } = passes(without(doomed), 2);
      const olderPages = pagesOf(older.filter((one) => !one.labelIds.includes("SPAM")).length, 2);
      expect([sent, olderPages].every((pages) => pages >= 3)).toBe(true);

      // A reconciling listing, killed after its second page.
      personal.gmail.deletePermanently(doomed);
      personal.gmail.failAt(personal.gmail.calls + 4, "unavailable");
      expect((await sync(s, all, { backfillDays: 90, reset: ["gmail"] })).outcomes[0]).toEqual({
        label: "personal",
        kind: "gmail",
        outcome: "unavailable",
      });
      expect(await isStored(s, gmailId(doomed))).toBe(true);
      expect(await count(s, "vault.listed_items", "account_id = $1", [mail.id])).toBe(4);

      // The rerun asks for no reset. It resumes at the third page, reads the rest of the window
      // and the older pass, and reconciles over every page the listing named.
      const calls = personal.gmail.calls;
      s.events.length = 0;
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      expect(personal.gmail.calls - calls).toBe(1 + (sent + rest + olderPages - 2) + 1);
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      for (const one of older) expect(await isStored(s, gmailId(one.id)), one.id).toBe(false);
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([]);
      expect(await count(s, "vault.listed_items")).toBe(0);

      // Killed in the older pass, it resumes there and fetches nothing.
      const gone = w.handles.noMessageIdMessageId;
      personal.gmail.deletePermanently(gone);
      const again = passes(without(doomed, gone), 2);
      personal.gmail.failAt(personal.gmail.calls + 1 + again.sent + again.rest + 2, "unavailable");
      expect((await sync(s, all, { backfillDays: 90, reset: ["gmail"] })).outcomes[0]).toEqual({
        label: "personal",
        kind: "gmail",
        outcome: "unavailable",
      });
      expect(await isStored(s, gmailId(gone))).toBe(true);
      const fetched = personal.gmail.fetched.length;
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      expect(personal.gmail.fetched.slice(fetched)).toEqual([]);
      expect(await isStored(s, gmailId(gone))).toBe(false);
      expect(await count(s, "vault.listed_items")).toBe(0);
    },
    LONG,
  );

  it(
    "a reset whose first page fails, then a run without --reset, still reconciles",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      const oldest = first(newestFirst(box.messages).slice(-1)).id;
      const doomed = first(box.deleteLater);
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      expect(await isStored(s, gmailId(oldest))).toBe(false);

      // The reset's very first page fails, after the profile: nothing of the listing is read.
      personal.gmail.deletePermanently(doomed);
      personal.gmail.failAt(personal.gmail.calls + 2, "unavailable");
      expect((await sync(s, all, { backfillDays: 90, reset: ["gmail"] })).outcomes[0]).toEqual({
        label: "personal",
        kind: "gmail",
        outcome: "unavailable",
      });
      expect(await count(s, "vault.listed_items", "account_id = $1", [mail.id])).toBe(0);
      // The reset is stored: the account's cursor is one that starts the listing, not none.
      expect(await s.writer.cursor(mail)).not.toBeNull();

      // The rerun asks for no reset, and has its window. It still reads the window, names what
      // is older, ends complete and reconciles the deleted message away; it stores nothing older.
      s.events.length = 0;
      expect(await sync(s, all, { backfillDays: 90 })).toEqual(ALL_OK);
      expect(await isStored(s, gmailId(oldest))).toBe(false);
      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([]);
      expect(eventsLogged(s, "account_synced")[0]).toEqual(
        syncedLine(mail.id, { stored: 0, unreadable: 0, removed: 1, held: 0, records_removed: 0 }),
      );
      expect(await count(s, "vault.listed_items")).toBe(0);

      // A calendar reset clears the cursor, as before: a failure there leaves none stored.
      const calendar = await accountOf(s, "personal", "google_calendar");
      expect(await s.writer.cursor(calendar)).not.toBeNull();
      personal.calendar.failAt(personal.calendar.calls + 1, "unavailable");
      expect((await sync(s, all, { reset: ["calendar"] })).outcomes[1]).toEqual({
        label: "personal",
        kind: "calendar",
        outcome: "unavailable",
      });
      expect(await s.writer.cursor(calendar)).toBeNull();
      expect(await sync(s, all)).toEqual(ALL_OK);
    },
    LONG,
  );

  it(
    "a reset stores nothing older than the window",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 5 });
      const box = personalOf(w);
      const older = box.messages.filter((one) => !inWindow(one));
      expect(older.length).toBeGreaterThan(4);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const stored = await count(s, "vault.evidence_items");
      expect(await sync(s, all, { reset: ["gmail"] })).toEqual(ALL_OK);
      // The older pass named them, and none was fetched or stored.
      expect(personal.gmail.fetched.filter((id) => older.some((one) => one.id === id))).toEqual([]);
      for (const one of older) expect(await isStored(s, gmailId(one.id)), one.id).toBe(false);
      expect(await count(s, "vault.evidence_items")).toBe(stored);
    },
    LONG,
  );

  it(
    "sync re-derives once when a later label's address was a person",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const workAddress = w.accounts[1]?.address ?? "";
      personal.gmail.add(fromNell("19c0000000000001", workAddress));

      expect(await sync(s, all)).toEqual({ ...ALL_OK, rederive: "done" });
      const rederived = eventsLogged(s, "rederived");
      expect(rederived).toHaveLength(1);
      expect(rederived[0]?.counts?.items).toBeGreaterThan(0);
      // The address is the owner's alone, and the person who wrote to it is still a person.
      expect(
        await withAdmin(s, async (admin) => [
          (await admin.accounts.inspect(workAddress))?.kind,
          (await admin.accounts.inspect(NELL))?.kind,
        ]),
      ).toEqual(["owner", "person"]);
      expect(await kindsOf(s, workAddress)).toEqual(["owner"]);

      const nell = await withAdmin(s, async (admin) => (await admin.accounts.inspect(NELL))?.id);
      s.events.length = 0;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(eventsLogged(s, "rederived")).toEqual([]);
      expect(await withAdmin(s, async (admin) => (await admin.accounts.inspect(NELL))?.id)).toBe(nell);
    },
    LONG,
  );

  it(
    "a fetch failure mid-page stops without moving the cursor",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      const cursor = await s.writer.cursor(mail);
      expect(cursor).not.toBeNull();

      // The page of changes fails as it is read: nothing of it is handed over.
      personal.gmail.add(fromNell("19c0000000000001", first(w.owner.addresses)));
      personal.gmail.failAt(personal.gmail.calls + 2, "unavailable");
      expect((await sync(s, all)).outcomes).toEqual([
        { label: "personal", kind: "gmail", outcome: "unavailable" },
        ...ok("personal").slice(1),
        ...ok("work"),
      ]);
      expect(await s.writer.cursor(mail)).toBe(cursor);
      expect((await accountStates(s))[0]).toMatchObject({ connector: "google_mail", outcome: "unavailable" });
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(false);

      // The positive control: the next sync reads the same page, stores it and moves the cursor.
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(await isStored(s, gmailId("19c0000000000001"))).toBe(true);
      expect(await s.writer.cursor(mail)).not.toBe(cursor);
    },
    LONG,
  );

  it(
    "invalid_grant records reconnect_google and keeps the cursor",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      expect(await sync(s, all)).toEqual(ALL_OK);
      const mail = await accountOf(s, "personal", "google_mail");
      const calendar = await accountOf(s, "personal", "google_calendar");
      const cursors = [await s.writer.cursor(mail), await s.writer.cursor(calendar)];

      // The second sync's profile fails on accounts that exist: both kinds record it.
      personal.gmail.failAt(personal.gmail.calls + 1, "oauth_failed");
      const calendarCalls = personal.calendar.calls;
      expect(await sync(s, all)).toEqual({
        outcomes: [
          { label: "personal", kind: "gmail", outcome: "reconnect_google" },
          { label: "personal", kind: "calendar", outcome: "reconnect_google" },
          ...ok("work"),
        ],
        rederive: "none",
        refused: 0,
      });
      expect((await accountStates(s)).map((one) => `${one.label} ${one.connector} ${one.outcome}`)).toEqual([
        "personal google_mail reconnect_google",
        "personal google_calendar reconnect_google",
        "work google_mail ok",
        "work google_calendar ok",
      ]);
      expect([await s.writer.cursor(mail), await s.writer.cursor(calendar)]).toEqual(cursors);
      expect(personal.calendar.calls).toBe(calendarCalls);
    },
    LONG,
  );

  it("a second sync exits already_running with 0", async () => {
    const s = await stack();
    // A sync that holds the lock until the test lets it go.
    let taken: () => void = () => {};
    let release: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const first = s.writer.withSyncLock(async () => {
      taken();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    });
    await holding;
    try {
      expect(await pi(["sync"], syncEnv(s))).toEqual({
        exit: 0,
        stdout: "",
        stderr: `${JSON.stringify({ event: "already_running" })}\n`,
      });
    } finally {
      release();
    }

    // The positive control: with the lock free, the same command gets past it.
    expect(await first).toBe("done");
    expect(await pi(["sync"], syncEnv(s))).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "no_accounts" })}\n`,
    });
    // An argument that is neither a number of days nor a kind is a usage error.
    for (const argv of [
      ["sync", "--backfill-days", "soon"],
      ["sync", "--backfill-days", "0"],
      ["sync", "--reset", "everything"],
    ]) {
      expect(await pi(argv, syncEnv(s)), argv.join(" ")).toEqual({ exit: 2, stdout: "", stderr: failed("usage") });
    }
  });

  it(
    "a backfill rerun resumes after its last finished page, and stops at the window",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w, { pageSize: 2 });
      const box = personalOf(w);
      const { sent, rest } = passes(box, 2);
      expect(sent).toBeGreaterThan(2);
      const sentFirst = newestFirst(box.messages.filter((one) => inWindow(one) && isSent(one))).slice(0, 4);

      // The first run's third page fails: two pages of the sent pass are finished.
      personal.gmail.failAt(4, "unavailable");
      expect((await sync(s, all)).outcomes[0]).toEqual({ label: "personal", kind: "gmail", outcome: "unavailable" });
      expect(personal.gmail.calls).toBe(4);
      for (const one of box.messages) expect(await isStored(s, gmailId(one.id)), one.id).toBe(sentFirst.includes(one));

      // The rerun reads the profile, the pages from the third on, and the empty history page.
      s.events.length = 0;
      expect(await sync(s, all)).toEqual(ALL_OK);
      expect(personal.gmail.calls - 4).toBe(1 + (sent + rest - 2) + 1);
      const kept = keptBy(box);
      for (const one of box.messages) expect(await isStored(s, gmailId(one.id)), one.id).toBe(kept.includes(one));
      const mail = await accountOf(s, "personal", "google_mail");
      expect(eventsLogged(s, "reconcile_skipped")).toEqual([{ event: "reconcile_skipped", ids: { account: mail.id } }]);
    },
    LONG,
  );

  it(
    "a message deleted at the source is removed by the deletion that names it",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal } = sourcesOf(w);
      const doomed = first(w.accounts[0]?.deleteLater ?? []);
      const sender = w.handles.oneMessageSenderAddress;
      expect(await sync(s, all)).toEqual(ALL_OK);
      const [evidence] = await rows<{ id: string }>(
        s,
        "select id from vault.evidence_items where source_item_fp = $1",
        [fingerprint(s.db.keys, "source_id", gmailId(doomed))],
      );
      expect(await count(s, "knowledge.messages", "evidence_id = $1", [evidence?.id])).toBe(1);
      expect(await count(s, "knowledge.interaction_log", "evidence_id = $1", [evidence?.id])).toBeGreaterThan(0);
      expect(await kindsOf(s, sender)).toEqual(["person"]);

      // History names the deleted message by its Gmail id, which is the id its item is stored under.
      personal.gmail.deletePermanently(doomed);
      expect(await sync(s, all)).toEqual(ALL_OK);

      expect(await isStored(s, gmailId(doomed))).toBe(false);
      expect(await count(s, "knowledge.messages", "evidence_id = $1", [evidence?.id])).toBe(0);
      expect(await count(s, "knowledge.interaction_log", "evidence_id = $1", [evidence?.id])).toBe(0);
      expect(await kindsOf(s, sender)).toEqual([]);
    },
    LONG,
  );
});
