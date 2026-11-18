import { type ConnectorCursor, ConnectorPage, RawItem, SourceAccount } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { CalendarEvent, GmailMessage, PersonalConnector, PersonalPage, PersonalSource } from "../items/index.ts";
import { calendarItem, gmailItem, isBareCancellation, isJunk, ownerSent } from "../items/index.ts";
import type { Connector } from "../items/types.ts";
import {
  type FailureKind,
  fakeCalendar,
  fakeGmail as fakeGmailAt,
  fakeSources,
  type WorldAccount,
  world,
} from "../testing.ts";

// Made-up values on reserved domains.
const [HOUR, DAY] = [3_600_000, 86_400_000];
const NOW = "2026-03-10T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const daysAgo = (days: number): string => new Date(nowMs - days * DAY).toISOString();

const mailId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ1");
const calendarId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ2");
const account = (id: SourceAccountId, connector: "google_mail" | "google_calendar"): SourceAccount =>
  SourceAccount.parse({
    id,
    connector,
    sourceKind: connector === "google_mail" ? "email" : "calendar",
    vault: "personal",
    externalRef: "personal",
    accessSyncKind: "none",
    compartments: ["own"],
    markerCompartments: [],
  });
const MAIL = account(mailId, "google_mail");
const CALENDAR = account(calendarId, "google_calendar");

// A message some days and three hours old, in a thread of its own unless said otherwise.
const mail = (
  id: string,
  days: number,
  labelIds: string[] = ["INBOX"],
  more: Partial<GmailMessage> = {},
): GmailMessage => ({
  id,
  threadId: id,
  internalDate: nowMs - days * DAY - 3 * HOUR,
  labelIds,
  headers: [
    { name: "From", value: "Alex Example <alex@example.com>" },
    { name: "To", value: "owner@example.org" },
    { name: "Date", value: new Date(nowMs - days * DAY - 3 * HOUR - 60_000).toUTCString().replace("GMT", "+0000") },
    { name: "Subject", value: "Notes" },
    { name: "Message-ID", value: `<${id}@example.com>` },
  ],
  ...more,
});
// An hour-long event that starts some days from now.
const meeting = (id: string, days: number): CalendarEvent => ({
  id,
  status: "confirmed",
  etag: `etag-${id}`,
  updated: daysAgo(5),
  summary: "Review",
  start: { dateTime: new Date(nowMs + days * DAY).toISOString() },
  end: { dateTime: new Date(nowMs + days * DAY + HOUR).toISOString() },
  organizer: { email: "owner@example.org", self: true },
  attendees: [{ email: "owner@example.org", self: true }, { email: "alex@example.com" }],
});
const box = (messages: GmailMessage[], events: CalendarEvent[] = []): WorldAccount => ({
  label: "personal",
  compartment: "own",
  address: "owner@example.org",
  messages,
  events,
  deleteLater: [],
  contacts: [],
});

// A mailbox whose clock is NOW.
const fakeGmail = (
  of: WorldAccount,
  options: { pageSize?: number; order?: "newest" | "shuffled"; pageBytes?: number } = {},
) => fakeGmailAt(of, { now: NOW, ...options });

const tags = (page: PersonalPage): string[] => page.items.map((item) => item.revisionTag);
// The source item ids of the messages a page reports gone.
const gone = (page: PersonalPage): string[] => page.deletions.map((one) => one.sourceItemId);
const ids = (page: PersonalPage): string[] => page.items.map((item) => item.sourceItemId);

// Every page of one listing, from a cursor until the page that ends it.
async function listing(
  connector: PersonalConnector,
  source: SourceAccount,
  cursor: ConnectorCursor | null = null,
  limit = 500,
): Promise<PersonalPage[]> {
  const pages: PersonalPage[] = [];
  let next = cursor;
  do {
    const page = await connector.listChanges(source, next, limit);
    if (page.listing === undefined) throw new Error("not a listing page");
    pages.push(page);
    next = page.next;
  } while (pages.at(-1)?.listing?.ended === undefined);
  return pages;
}
// Every page from a cursor until one that says there is nothing more.
async function drain(
  connector: PersonalConnector,
  source: SourceAccount,
  cursor: ConnectorCursor | null,
): Promise<PersonalPage[]> {
  const pages: PersonalPage[] = [];
  let next = cursor;
  do {
    const page = await connector.listChanges(source, next, 500);
    pages.push(page);
    next = page.next;
  } while (pages.at(-1)?.more === true);
  return pages;
}
const last = (pages: PersonalPage[]): PersonalPage => pages.at(-1) as PersonalPage;

async function codeOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe("the Gmail fake", () => {
  it("a history page reports the mailbox's current id", async () => {
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("m3", 3)]), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    const listed = await listing(connector, MAIL);
    // The sent pass, which is empty, then the rest pass over two pages.
    expect(listed.map(tags)).toEqual([[], ["f:m1:", "f:m2:"], ["f:m3:"]]);
    // Three additions: the history id goes from 1000 to 1003.
    for (const id of ["m4", "m5", "m6"]) gmail.add(mail(id, 0.5));
    const first = await connector.listChanges(MAIL, last(listed).next, 500);
    expect(tags(first)).toEqual(["f:m4:", "f:m5:"]);
    expect(first.items.every((item) => item.changeKind === "live")).toBe(true);
    expect(first.listing).toBeUndefined();
    // A change between two pages appears on a later page. The trash is a change too, of labels
    // that derive nothing: an addition makes the mailbox's id 1004 and the trash 1005.
    gmail.add(mail("m7", 0.25));
    gmail.trash("m1");
    const second = await connector.listChanges(MAIL, first.next, 500);
    expect(tags(second)).toEqual(["f:m6:", "f:m7:"]);
    expect(second.deletions).toEqual([]);
    // The trash has a page of its own, which hands nothing over.
    const third = await connector.listChanges(MAIL, second.next, 500);
    expect([third.items, third.deletions, third.skipped, third.listing]).toEqual([[], [], [], undefined]);
    // Its `next` stands at the mailbox's current id, 1005: history kept from 1005 on still
    // serves it, and history kept from 1006 on does not.
    gmail.expireHistoryBefore("1005");
    const quiet = await connector.listChanges(MAIL, third.next, 500);
    expect([quiet.items, quiet.deletions, quiet.listing, quiet.next]).toEqual([[], [], undefined, third.next]);
    gmail.expireHistoryBefore("1006");
    expect((await connector.listChanges(MAIL, third.next, 500)).listing?.first).toBe(true);
    // A page holds at most min(limit, pageSize) messages.
    expect(tags(await connector.listChanges(MAIL, (listed[0] as PersonalPage).next, 1))).toHaveLength(1);
  });

  it("an expired history id starts a new listing", async () => {
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("old", 40)]));
    const connector = gmail.connector(mailId, { since: daysAgo(30) });
    const history = last(await listing(connector, MAIL)).next;
    gmail.add(mail("m3", 0.5));
    // The control: while the id is kept, the cursor gives the change alone.
    const live = await connector.listChanges(MAIL, history, 500);
    expect([tags(live), live.listing]).toEqual([["f:m3:"], undefined]);
    gmail.expireHistoryBefore("1001");
    // A reconciling listing: the window again, then what is older by id alone.
    const again = await listing(connector, MAIL, history);
    expect(again.map((page) => page.listing)).toEqual([
      { first: true },
      { first: false },
      { first: false, ended: "complete" },
    ]);
    expect(again.flatMap(tags)).toEqual(["f:m3:", "f:m1:", "f:m2:"]);
    expect(again.flatMap((page) => page.listed ?? [])).toEqual(["gmail-id:old"]);
    expect(again.flatMap((page) => page.items).every((item) => item.changeKind === "backfill")).toBe(true);
    // An id the mailbox never issued expires too: here, one from a mailbox that is further on.
    const other = fakeGmail(box([mail("m1", 1)]));
    for (const id of ["a", "b", "c"]) other.add(mail(id, 0.5));
    const ahead = last(await listing(other.connector(mailId, {}), MAIL)).next;
    expect((await connector.listChanges(MAIL, ahead, 500)).listing?.first).toBe(true);
  });

  it("a listing lists sent mail first, then the rest, trash and drafts included and junk left out; history hands junk over", async () => {
    const gmail = fakeGmail(
      box([
        mail("m1", 1),
        mail("m2", 2, ["SPAM"]),
        mail("m3", 3, ["TRASH"]),
        mail("m4", 4, ["DRAFT"]),
        mail("m5", 5, ["SENT"]),
        mail("m6", 6, ["INBOX", "CATEGORY_PROMOTIONS"]),
        mail("m7", 7, ["SENT", "CATEGORY_PROMOTIONS"]),
        mail("m8", 8, ["SENT", "SPAM"]),
      ]),
    );
    const connector = gmail.connector(mailId, {});
    const pages = await listing(connector, MAIL);
    // The sent pass: what the owner sent, Promotions included and Spam left out.
    expect(pages.map((page) => page.items.map((item) => [item.revisionTag, item.markers]))).toEqual([
      [
        ["f:m5:SENT", ["SENT"]],
        ["f:m7:CATEGORY_PROMOTIONS,SENT", ["SENT", "CATEGORY_PROMOTIONS"]],
      ],
      [
        ["f:m1:", ["INBOX"]],
        ["f:m3:", ["TRASH"]],
        ["f:m4:", ["DRAFT"]],
      ],
    ]);
    // History hands junk over: sync is what leaves it out.
    gmail.add(mail("n1", 0.5, ["SPAM"]));
    gmail.add(mail("n2", 0.4, ["INBOX", "CATEGORY_PROMOTIONS"]));
    gmail.add(mail("n3", 0.3, ["SENT", "SPAM"]));
    const junk = await connector.listChanges(MAIL, last(pages).next, 500);
    expect(ids(junk)).toEqual(["gmail-id:n1", "gmail-id:n2", "gmail-id:n3"]);
    expect(junk.items.every((item) => isJunk(item))).toBe(true);
    // Trashing changes only labels that derive nothing: its history page hands nothing over,
    // and the next listing shows it.
    gmail.trash("m1");
    const quiet = await connector.listChanges(MAIL, junk.next, 500);
    expect([quiet.items, quiet.deletions]).toEqual([[], []]);
    const relisted = (await listing(connector, MAIL)).flatMap((page) => page.items);
    expect(relisted.find((item) => item.sourceItemId === "gmail-id:m1")?.markers).toEqual(["TRASH"]);
    expect(() => gmail.trash("m9")).toThrow();
  });

  it("a label change is in history, and its message is read again only when a deriving label changed", async () => {
    const gmail = fakeGmail(
      box([mail("m1", 1, ["SPAM"]), mail("m2", 2), mail("m3", 3), mail("m4", 4, ["INBOX", "UNREAD"])]),
    );
    const connector = gmail.connector(mailId, {});
    const history = last(await listing(connector, MAIL)).next;
    const read = async (cursor: ConnectorCursor) => {
      const page = await connector.listChanges(MAIL, cursor, 500);
      return { page, items: page.items.map((item) => [item.revisionTag, item.markers, item.changeKind]) };
    };

    // Out of spam, into a bulk category, and sent: each changes a label the derived rows
    // depend on, so the message is handed over again, as it is now, under a new revision tag.
    gmail.relabel("m1", ["INBOX"]);
    gmail.relabel("m2", ["INBOX", "CATEGORY_PROMOTIONS"]);
    gmail.relabel("m3", ["SENT"]);
    // Read, starred and filed: nothing is handed over.
    gmail.relabel("m4", ["INBOX", "STARRED", "Label_7"]);
    const first = await read(history);
    expect(first.items).toEqual([
      ["f:m1:", ["INBOX"], "live"],
      ["f:m2:CATEGORY_PROMOTIONS", ["INBOX", "CATEGORY_PROMOTIONS"], "live"],
      ["f:m3:SENT", ["SENT"], "live"],
    ]);
    expect([first.page.deletions, first.page.skipped, first.page.listing]).toEqual([[], [], undefined]);
    expect(first.page.items).toEqual([
      gmailItem({ ...mail("m1", 1), labelIds: ["INBOX"] }, { sourceAccount: mailId, changeKind: "live" }),
      ...first.page.items.slice(1),
    ]);

    // A message whose labels changed twice is handed over once, as it is now. A change that
    // leaves its labels as they were is no change at all.
    gmail.relabel("m1", ["SPAM"]);
    gmail.relabel("m1", ["INBOX", "SPAM"]);
    gmail.relabel("m2", ["CATEGORY_PROMOTIONS", "INBOX"]);
    const second = await read(first.page.next);
    expect(second.items).toEqual([["f:m1:SPAM", ["INBOX", "SPAM"], "live"]]);
    // One whose labels changed and that is then deleted is a deletion, and no item.
    gmail.relabel("m3", ["INBOX"]);
    gmail.deletePermanently("m3");
    const third = await read(second.page.next);
    expect([third.items, gone(third.page)]).toEqual([[], ["gmail-id:m3"]]);

    // A listing reads every message with the labels it has now, and so leaves out the two
    // that became junk.
    expect((await listing(connector, MAIL)).flatMap(tags)).toEqual(["f:m4:"]);
    expect(() => gmail.relabel("m9", ["INBOX"])).toThrow();
  });

  it("more is true while the source has another page, whatever the page holds", async () => {
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("m3", 3)]), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    const listed = await listing(connector, MAIL);
    // The sent pass's last page leads to the rest pass; the listing's last page has none after it.
    expect(listed.map((page) => page.more)).toEqual([true, true, false]);
    // Two label changes that derive nothing fill a page of their own: it hands nothing over,
    // and still says there is another page.
    gmail.relabel("m1", ["INBOX", "STARRED"]);
    gmail.trash("m2");
    gmail.add(mail("m4", 0.5));
    const first = await connector.listChanges(MAIL, last(listed).next, 500);
    expect([first.items, first.deletions, first.skipped, first.listing, first.more]).toEqual([
      [],
      [],
      [],
      undefined,
      true,
    ]);
    const second = await connector.listChanges(MAIL, first.next, 500);
    expect([tags(second), second.more]).toEqual([["f:m4:"], false]);
    expect((await connector.listChanges(MAIL, second.next, 500)).more).toBe(false);
    // A reconciling listing: each pass's end leads on, and only its last page ends it.
    const reconciled = fakeGmail(box([1, 40, 41, 42].map((days) => mail(`d${days}`, days))), { pageSize: 1 });
    const windowed = reconciled.connector(mailId, { since: daysAgo(30) });
    const pages = await listing(windowed, MAIL, windowed.resetCursor());
    expect(pages.map((page) => [page.listing?.ended, page.more])).toEqual([
      [undefined, true],
      [undefined, true],
      [undefined, true],
      [undefined, true],
      ["complete", false],
    ]);

    // Calendar: a listing's pages, then a sync token's.
    const calendar = fakeCalendar(box([], [meeting("e1", 1), meeting("e2", 2), meeting("e3", 3)]), {
      now: NOW,
      pageSize: 2,
    });
    const events = calendar.connector(calendarId, {});
    const calendarPages = await listing(events, CALENDAR);
    expect(calendarPages.map((page) => page.more)).toEqual([true, false]);
    for (const id of ["e1", "e2", "e3"]) calendar.upsert({ ...meeting(id, 4), summary: "Moved" });
    const changed = await events.listChanges(CALENDAR, last(calendarPages).next, 500);
    expect([ids(changed), changed.more]).toEqual([["e1", "e2"], true]);
    const rest = await events.listChanges(CALENDAR, changed.next, 500);
    expect([ids(rest), rest.more]).toEqual([["e3"], false]);
  });

  it("the reset cursor starts a reconciling listing: the window as items, what is older as ids that are never fetched; a calendar has none", async () => {
    const messages = [
      mail("d1", 1),
      mail("d2", 2),
      mail("d40", 40),
      mail("d41", 41),
      mail("spam42", 42, ["SPAM"]),
      mail("d43", 43),
      mail("d44", 44),
    ];
    const gmail = fakeGmail(box(messages), { pageSize: 2 });
    const windowed = gmail.connector(mailId, { since: daysAgo(30) });
    // The positive control: from no cursor, this connector's listing covers the window and ends there.
    const first = await listing(windowed, MAIL);
    expect(first.map((page) => page.listing?.ended)).toEqual([undefined, "window"]);
    expect(first.flatMap((page) => page.listed ?? [])).toEqual([]);
    // From the reset cursor it reads the window again, then names what is older, Spam left out.
    const reset = windowed.resetCursor();
    expect(windowed.resetCursor()).toBe(reset);
    const before = gmail.fetched.length;
    const pages = await listing(windowed, MAIL, reset);
    expect(pages.map((page) => page.listing)).toEqual([
      { first: true },
      { first: false },
      { first: false },
      { first: false, ended: "complete" },
    ]);
    expect(pages.flatMap(ids)).toEqual(["gmail-id:d1", "gmail-id:d2"]);
    expect(pages.map((page) => page.listed)).toEqual([
      undefined,
      undefined,
      ["gmail-id:d40", "gmail-id:d41"],
      ["gmail-id:d43", "gmail-id:d44"],
    ]);
    // Nothing older than the window was handed over: `fetched` holds the window's two alone.
    expect(gmail.fetched.slice(before)).toEqual(["d1", "d2"]);
    expect(gmail.fetched.filter((id) => !["d1", "d2"].includes(id))).toEqual([]);
    // Resumed in the older pass by a connector built with another since, it keeps its window.
    const resumed = await listing(
      gmail.connector(mailId, { since: daysAgo(50) }),
      MAIL,
      (pages[2] as PersonalPage).next,
    );
    expect(resumed).toEqual(pages.slice(3));
    // A failure at its first page leaves the cursor as it is: the next read starts the same listing.
    gmail.failAt(gmail.calls + 1, "unavailable");
    expect(await codeOf(() => windowed.listChanges(MAIL, reset, 500))).toBe("unavailable");
    expect((await windowed.listChanges(MAIL, reset, 500)).listing).toEqual({ first: true });

    expect(
      fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW })
        .connector(calendarId, {})
        .resetCursor(),
    ).toBeNull();
  });

  it("a history page with a message the owner sent hands over the conditional messages of its thread after it", async () => {
    const social = mail("s1", 3, ["INBOX", "CATEGORY_SOCIAL"], { threadId: "t1" });
    const updates = mail("u1", 3, ["INBOX", "CATEGORY_UPDATES"], { threadId: "t1" });
    const sentBefore = mail("o1", 4, ["SENT"], { threadId: "t1" });
    const forums = mail("f1", 2, ["INBOX", "CATEGORY_FORUMS"], { threadId: "t2" });
    const gmail = fakeGmail(box([social, updates, sentBefore, forums]));
    const connector = gmail.connector(mailId, {});
    const history = last(await listing(connector, MAIL)).next;
    // The owner replies in t1, and a spoofed message under SENT and SPAM arrives in t2.
    gmail.add(mail("r1", 0.5, ["SENT"], { threadId: "t1" }));
    gmail.add(mail("x1", 0.4, ["SENT", "SPAM"], { threadId: "t2" }));
    const page = await connector.listChanges(MAIL, history, 500);
    // The reply, the spam, then the thread's Social message: not the Updates one, not the
    // owner's own, and nothing of t2, which a message the owner did not send cannot open.
    expect(ids(page)).toEqual(["gmail-id:r1", "gmail-id:x1", "gmail-id:s1"]);
    expect(page.items.every((item) => item.changeKind === "live")).toBe(true);
    // One already on the page is not handed over twice.
    gmail.relabel("s1", ["INBOX", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"]);
    gmail.add(mail("r2", 0.3, ["SENT"], { threadId: "t1" }));
    const again = await connector.listChanges(MAIL, page.next, 500);
    expect(ids(again)).toEqual(["gmail-id:r2", "gmail-id:s1"]);
    // A listing asks about no thread: every message of the window is in it anyway.
    expect((await listing(connector, MAIL)).flatMap(ids).filter((id) => id === "gmail-id:s1")).toHaveLength(1);
  });

  it("a shuffled listing is a permutation that is not newest first", async () => {
    const personal = world({ now: new Date(NOW) }).accounts[0] as WorldAccount;
    const read = async (order: "newest" | "shuffled"): Promise<RawItem[]> =>
      (await listing(fakeGmail(personal, { order, pageSize: 7 }).connector(mailId, {}), MAIL)).flatMap(
        (page) => page.items,
      );
    const [newest, shuffled] = [await read("newest"), await read("shuffled")];
    const tagsOf = (items: RawItem[]): string[] => items.map((item) => item.revisionTag);
    const dates = new Map(personal.messages.map((message) => [`gmail-id:${message.id}`, message.internalDate]));
    const newestFirst = (items: RawItem[]): boolean =>
      items.every(
        (item, at) =>
          at === 0 ||
          (dates.get((items[at - 1] as RawItem).sourceItemId) as number) >= (dates.get(item.sourceItemId) as number),
      );
    expect(newest).toHaveLength(
      personal.messages.filter((message) => !isJunk({ markers: message.labelIds } as RawItem)).length,
    );
    // Each pass is newest first, the owner's mail before the rest.
    const sentPass = (items: RawItem[]): RawItem[] => items.filter((item) => ownerSent(item));
    const restPass = (items: RawItem[]): RawItem[] => items.filter((item) => !ownerSent(item));
    expect([...sentPass(newest), ...restPass(newest)]).toEqual(newest);
    expect(newestFirst(sentPass(newest)) && newestFirst(restPass(newest))).toBe(true);
    expect([...tagsOf(shuffled)].sort()).toEqual([...tagsOf(newest)].sort());
    expect([...sentPass(shuffled), ...restPass(shuffled)]).toEqual(shuffled);
    expect(newestFirst(restPass(shuffled))).toBe(false);
    // A fixed order: the same every time.
    expect(tagsOf(await read("shuffled"))).toEqual(tagsOf(shuffled));
  });

  it("a permanent deletion is reported as a source deletion", async () => {
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("m3", 3)]));
    const connector = gmail.connector(mailId, {});
    const history = last(await listing(connector, MAIL)).next;
    gmail.deletePermanently("m2");
    // A message added and then deleted in the range is a deletion too, and no item.
    gmail.add(mail("m4", 0.5));
    gmail.add(mail("m5", 0.25));
    gmail.deletePermanently("m4");
    const page = await connector.listChanges(MAIL, history, 500);
    expect(tags(page)).toEqual(["f:m5:"]);
    expect(gone(page).sort()).toEqual(["gmail-id:m2", "gmail-id:m4"]);
    // Each names its account and is dated by the fake's clock.
    expect(page.deletions[0]).toEqual({ sourceAccount: mailId, sourceItemId: "gmail-id:m4", deletedAt: NOW });
    // It is gone from a listing.
    expect((await listing(connector, MAIL)).flatMap(tags)).toEqual(["f:m5:", "f:m1:", "f:m3:"]);
    // An id that exists cannot be added, and an unknown one cannot be deleted.
    expect(() => gmail.add(mail("m1", 1))).toThrow();
    expect(() => gmail.deletePermanently("m2")).toThrow();
    // An added message that is gone before its page is read is a deletion on that page, though
    // its deletion is a change on a later one: its metadata answers 404, as the connector finds.
    const paged = fakeGmail(box([mail("m1", 1)]), { pageSize: 1 });
    const one = paged.connector(mailId, {});
    const start = last(await listing(one, MAIL)).next;
    paged.add(mail("m6", 0.5));
    paged.add(mail("m7", 0.25));
    paged.deletePermanently("m6");
    const added = await one.listChanges(MAIL, start, 500);
    expect([tags(added), gone(added)]).toEqual([[], ["gmail-id:m6"]]);
    expect(tags(await one.listChanges(MAIL, added.next, 500))).toEqual(["f:m7:"]);
  });

  it("a change made during a listing is reported after it", async () => {
    // Gmail: the history that follows a listing starts at the id the listing began at.
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("m3", 3)]), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    const first = await connector.listChanges(MAIL, null, 500);
    gmail.add(mail("m4", 4));
    const rest = await listing(connector, MAIL, first.next);
    expect(rest.flatMap(tags)).not.toContain("f:m4:");
    expect(tags(await connector.listChanges(MAIL, last(rest).next, 500))).toEqual(["f:m4:"]);
    // Calendar: the sync token a listing ends with is issued for when the listing began.
    const calendar = fakeCalendar(box([], [meeting("e1", 1), meeting("e2", 2)]), { now: NOW, pageSize: 1 });
    const events = calendar.connector(calendarId, {});
    const page = await events.listChanges(CALENDAR, null, 500);
    expect(ids(page)).toEqual(["e1"]);
    calendar.upsert({ ...meeting("e1", 1), summary: "Moved" });
    const remaining = await listing(events, CALENDAR, page.next);
    expect(ids(await events.listChanges(CALENDAR, last(remaining).next, 500))).toEqual(["e1"]);
  });

  it("a first listing lists only what is inside its window, in both passes, and marks its last page window; a reconciling one marks its last page complete", async () => {
    const messages = [
      mail("d1", 1),
      mail("d2", 2),
      mail("d3", 3),
      mail("s4", 4, ["SENT"]),
      mail("d40", 40),
      mail("d41", 41),
      mail("s45", 45, ["SENT"]),
    ];
    const gmail = fakeGmail(box(messages), { pageSize: 2 });
    const windowed = gmail.connector(mailId, { since: daysAgo(30) });
    const first = await listing(windowed, MAIL);
    expect(first.map(tags)).toEqual([["f:s4:SENT"], ["f:d1:", "f:d2:"], ["f:d3:"]]);
    expect(first.map((page) => page.listing)).toEqual([
      { first: true },
      { first: false },
      { first: false, ended: "window" },
    ]);
    expect(first.flatMap((page) => page.listed ?? [])).toEqual([]);
    // A reconciling one reads the same window, then names what is older in both passes' place.
    const reconciling = await listing(windowed, MAIL, windowed.resetCursor());
    expect(reconciling.map(tags)).toEqual([["f:s4:SENT"], ["f:d1:", "f:d2:"], ["f:d3:"], [], []]);
    expect(reconciling.map((page) => page.listed)).toEqual([
      undefined,
      undefined,
      undefined,
      ["gmail-id:d40", "gmail-id:d41"],
      ["gmail-id:s45"],
    ]);
    expect(last(reconciling).listing).toEqual({ first: false, ended: "complete" });
    // Either end moves on to history: the next page is no listing page.
    for (const pages of [first, reconciling]) {
      expect((await gmail.connector(mailId, {}).listChanges(MAIL, last(pages).next, 500)).listing).toBeUndefined();
    }
    // An empty mailbox: two empty passes, and a listing that ends.
    const empty = await listing(fakeGmail(box([])).connector(mailId, { since: daysAgo(30) }), MAIL);
    expect(empty.map((page) => [page.items, page.listing])).toEqual([
      [[], { first: true }],
      [[], { first: false, ended: "window" }],
    ]);
  });

  it("a listing with no since, or after an expired history id, runs past since and ends complete, also when resumed", async () => {
    const messages = [
      mail("d1", 1),
      mail("d2", 2),
      mail("d3", 3),
      mail("d40", 40),
      mail("d41", 41),
      mail("d42", 42),
      mail("d43", 43),
    ];
    const all = messages.map((message) => `f:${message.id}:`);
    // No since: a connector with no window lists the whole mailbox in its two passes. Its
    // reconciling listing has no older pass and ends complete at the rest pass's end; a first
    // listing ends window there, as the connector's does.
    const gmail = fakeGmail(box(messages), { pageSize: 2 });
    const open = gmail.connector(mailId, {});
    const whole = await listing(open, MAIL, open.resetCursor());
    expect(whole.flatMap(tags)).toEqual(all);
    expect(whole.flatMap((page) => page.listed ?? [])).toEqual([]);
    expect(whole.map((page) => page.listing?.ended)).toEqual([undefined, undefined, undefined, undefined, "complete"]);
    expect((await listing(open, MAIL)).flatMap(tags)).toEqual(all);
    expect(last(await listing(open, MAIL)).listing?.ended).toBe("window");
    // Resumed from its cursor by a connector built with a since, it still lists to the end.
    const bounded = gmail.connector(mailId, { since: daysAgo(30) });
    const resumed = await listing(bounded, MAIL, (whole[1] as PersonalPage).next);
    expect(resumed.flatMap(tags)).toEqual(all.slice(2));
    expect(last(resumed).listing?.ended).toBe("complete");
    // The control: the same connector's own first listing stops at the window.
    const windowed = await listing(bounded, MAIL);
    expect(windowed.flatMap(tags)).toEqual(all.slice(0, 3));
    expect(last(windowed).listing?.ended).toBe("window");
    // After an expired history id, the new listing reads the window and names what is older,
    // also when resumed.
    gmail.add(mail("new", 0.5));
    gmail.expireHistoryBefore("1001");
    const restarted = await listing(bounded, MAIL, last(windowed).next);
    expect(restarted[0]?.listing?.first).toBe(true);
    expect(restarted.flatMap(tags)).toEqual(["f:new:", ...all.slice(0, 3)]);
    expect(restarted.flatMap((page) => page.listed ?? [])).toEqual(
      messages.slice(3).map((message) => `gmail-id:${message.id}`),
    );
    expect(last(restarted).listing?.ended).toBe("complete");
    const again = await listing(
      gmail.connector(mailId, { since: daysAgo(2) }),
      MAIL,
      (restarted[1] as PersonalPage).next,
    );
    expect(again).toEqual(restarted.slice(2));
  });

  it("the same cursor gives the same page", async () => {
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2), mail("m3", 3)]), { pageSize: 2 });
    const connector = gmail.connector(mailId, { since: daysAgo(30) });
    const listed = await listing(connector, MAIL);
    gmail.add(mail("m4", 0.5));
    gmail.deletePermanently("m2");
    const history = await connector.listChanges(MAIL, last(listed).next, 500);
    // A connector never advances a cursor: each of these, asked again, answers the same.
    for (const cursor of [null, ...listed.map((page) => page.next), history.next]) {
      expect(await connector.listChanges(MAIL, cursor, 500)).toEqual(await connector.listChanges(MAIL, cursor, 500));
    }
    expect(await connector.listChanges(MAIL, last(listed).next, 500)).toEqual(history);
    // Every connector the fake makes reads the same mailbox.
    expect(await gmail.connector(mailId, { since: daysAgo(30) }).listChanges(MAIL, last(listed).next, 500)).toEqual(
      history,
    );
    // A cursor that is not this fake's is refused, and so is another account.
    const sync = last(
      await listing(fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW }).connector(calendarId, {}), CALENDAR),
    ).next;
    expect(await codeOf(() => connector.listChanges(MAIL, sync, 500))).toBe("bad_cursor");
    expect(await codeOf(() => connector.listChanges(CALENDAR, null, 500))).toBe("off_allowlist");
    // The access list makes no call and changes nothing.
    const before = gmail.calls;
    const first = (listed[0] as PersonalPage).next;
    expect(await connector.syncAccessList(MAIL, first)).toEqual({ changes: [], next: first });
    expect((await connector.syncAccessList(MAIL, null)).changes).toEqual([]);
    expect(gmail.calls).toBe(before);
  });
});

describe("injected failures", () => {
  const THROWN: FailureKind[] = ["unavailable", "rate_limited", "oauth_failed", "not_found"];

  it("an injected failure happens at the Nth call only", async () => {
    for (const kind of THROWN) {
      // Gmail: the profile is call 1, the failing listing call 2, the same listing again call 3.
      const gmail = fakeGmail(box([mail("m1", 1, ["SENT"]), mail("m2", 2, ["SENT"])]));
      const connector = gmail.connector(mailId, {});
      gmail.failAt(2, kind);
      expect(await gmail.profile()).toEqual({ address: "owner@example.org" });
      expect(await codeOf(() => connector.listChanges(MAIL, null, 500)), kind).toBe(kind);
      const page = await connector.listChanges(MAIL, null, 500);
      expect(tags(page), kind).toEqual(["f:m1:SENT", "f:m2:SENT"]);
      expect(gmail.calls).toBe(3);
      // The profile fails the same way, once.
      gmail.failAt(4, kind);
      expect(await codeOf(() => gmail.profile()), kind).toBe(kind);
      expect((await gmail.profile()).address).toBe("owner@example.org");
      expect(gmail.calls).toBe(5);

      // Calendar: calls 1 and 3 succeed around the failing call 2.
      const calendar = fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW });
      const events = calendar.connector(calendarId, {});
      calendar.failAt(2, kind);
      expect(ids(await events.listChanges(CALENDAR, null, 500))).toEqual(["e1"]);
      expect(await codeOf(() => events.listChanges(CALENDAR, null, 500)), kind).toBe(kind);
      expect(ids(await events.listChanges(CALENDAR, null, 500))).toEqual(["e1"]);
      expect(calendar.calls).toBe(3);
    }

    // not_found on a history read or a sync-token read is no error: the cursor expired, and the
    // page is a new listing's first page. The calls around it are untouched. The listing is
    // calls 1 and 2, its two passes.
    const gmail = fakeGmail(box([mail("m1", 1), mail("m2", 2)]));
    const connector = gmail.connector(mailId, { since: daysAgo(30) });
    const history = last(await listing(connector, MAIL)).next;
    gmail.failAt(4, "not_found");
    expect((await connector.listChanges(MAIL, history, 500)).listing).toBeUndefined();
    expect((await connector.listChanges(MAIL, history, 500)).listing).toEqual({ first: true });
    expect((await connector.listChanges(MAIL, history, 500)).listing).toBeUndefined();
    expect(gmail.calls).toBe(5);

    const calendar = fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW });
    const events = calendar.connector(calendarId, {});
    const sync = last(await listing(events, CALENDAR)).next;
    calendar.failAt(3, "not_found");
    expect((await events.listChanges(CALENDAR, sync, 500)).listing).toBeUndefined();
    expect((await events.listChanges(CALENDAR, sync, 500)).listing).toEqual({ first: true, ended: "complete" });
    expect((await events.listChanges(CALENDAR, sync, 500)).listing).toBeUndefined();
    expect(calendar.calls).toBe(4);
  });
});

describe("the Calendar fake", () => {
  const three = (): CalendarEvent[] => [meeting("e1", 1), meeting("e2", 2), meeting("e3", 3)];

  it("a sync token after a change returns only the change", async () => {
    const calendar = fakeCalendar(box([], three()), { now: NOW, pageSize: 1 });
    const connector = calendar.connector(calendarId, {});
    const listed = await listing(connector, CALENDAR);
    expect(listed.map(ids)).toEqual([["e1"], ["e2"], ["e3"]]);
    expect(listed.flatMap((page) => page.items).every((item) => item.changeKind === "backfill")).toBe(true);
    const sync = last(listed).next;
    // Nothing changed: an empty page, and the same token again.
    const quiet = await connector.listChanges(CALENDAR, sync, 500);
    expect([quiet.items, quiet.deletions, quiet.listing, quiet.next]).toEqual([[], [], undefined, sync]);

    calendar.upsert({ ...meeting("e2", 2), summary: "Moved" });
    calendar.upsert(meeting("e4", 4));
    const first = await connector.listChanges(CALENDAR, sync, 500);
    expect([ids(first), first.items[0]?.changeKind, first.listing]).toEqual([["e2"], "live", undefined]);
    // Paging is live: a change made between two pages appears on a later page.
    calendar.upsert({ ...meeting("e1", 1), summary: "Moved too" });
    const second = await connector.listChanges(CALENDAR, first.next, 500);
    const third = await connector.listChanges(CALENDAR, second.next, 500);
    expect([ids(second), ids(third)]).toEqual([["e4"], ["e1"]]);
    // The last page's token is a new one: nothing is left after it.
    expect((await connector.listChanges(CALENDAR, third.next, 500)).items).toEqual([]);
    // The same cursor gives the same page.
    expect(await connector.listChanges(CALENDAR, sync, 500)).toEqual(await connector.listChanges(CALENDAR, sync, 500));
    expect(await connector.listChanges(CALENDAR, null, 500)).toEqual(await connector.listChanges(CALENDAR, null, 500));
  });

  it("an edited event has a new etag and a later updated", async () => {
    const calendar = fakeCalendar(box([], three()), { now: NOW });
    const connector = calendar.connector(calendarId, {});
    const sync = last(await listing(connector, CALENDAR)).next;
    const before = meeting("e1", 1);
    calendar.upsert({ ...before, summary: "Moved" });
    const once = await connector.listChanges(CALENDAR, sync, 500);
    // The first change: one second after its previous updated.
    expect(once.items.map((item) => [item.revisionTag, item.observedAt])).toEqual([
      ["fake-etag-1", new Date(Date.parse(before.updated as string) + 1000).toISOString()],
    ]);
    expect(once.items[0]?.revisionTag).not.toBe(before.etag);
    calendar.upsert({ ...before, status: "cancelled" });
    const twice = await connector.listChanges(CALENDAR, once.next, 500);
    // The second change: two seconds after that. A cancelled event that keeps its fields is an edit.
    expect(twice.items.map((item) => [item.revisionTag, item.observedAt, item.markers])).toEqual([
      ["fake-etag-2", new Date(Date.parse(before.updated as string) + 3000).toISOString(), ["calendar", "cancelled"]],
    ]);
    expect(twice.deletions).toEqual([]);
    // A new event has no previous updated: the fake's now, plus its sequence in seconds.
    const { updated: _updated, etag: _etag, ...fresh } = meeting("e9", 9);
    calendar.upsert(fresh);
    const added = await connector.listChanges(CALENDAR, twice.next, 500);
    expect(added.items.map((item) => [item.sourceItemId, item.revisionTag, item.observedAt])).toEqual([
      ["e9", "fake-etag-3", new Date(nowMs + 3000).toISOString()],
    ]);
  });

  it("a removed event's deletedAt is the fake's now", async () => {
    const calendar = fakeCalendar(box([], three()), { now: NOW });
    const connector = calendar.connector(calendarId, {});
    const sync = last(await listing(connector, CALENDAR)).next;
    calendar.remove("e2");
    const page = await connector.listChanges(CALENDAR, sync, 500);
    expect(page.deletions).toEqual([{ sourceAccount: calendarId, sourceItemId: "e2", deletedAt: NOW }]);
    expect(page.items).toEqual([]);
    // The fake reads no clock: another now gives another time.
    const later = fakeCalendar(box([], [{ id: "gone", status: "cancelled" }]), { now: "2026-04-01T00:00:00.000Z" });
    expect((await later.connector(calendarId, {}).listChanges(CALENDAR, null, 500)).deletions[0]?.deletedAt).toBe(
      "2026-04-01T00:00:00.000Z",
    );
  });

  it("a removed event comes back as a source deletion", async () => {
    const calendar = fakeCalendar(box([], three()), { now: NOW });
    calendar.remove("e2");
    // A new listing still lists it, as a deletion and never as an item, whatever the window.
    for (const options of [{}, { since: new Date(nowMs + 30 * DAY).toISOString() }]) {
      const pages = await listing(calendar.connector(calendarId, options), CALENDAR);
      expect(pages.flatMap((page) => page.deletions).map((deletion) => deletion.sourceItemId)).toEqual(["e2"]);
      expect(pages.flatMap(ids)).not.toContain("e2");
    }
    expect(() => calendar.remove("e7")).toThrow();
  });

  it("an expired sync token starts a new listing", async () => {
    const calendar = fakeCalendar(box([], three()), { now: NOW });
    const connector = calendar.connector(calendarId, { since: daysAgo(90) });
    const sync = last(await listing(connector, CALENDAR)).next;
    calendar.upsert({ ...meeting("e2", 2), summary: "Moved" });
    // The control: while the token is good, the page holds the change alone.
    expect(ids(await connector.listChanges(CALENDAR, sync, 500))).toEqual(["e2"]);
    calendar.expireSyncTokens();
    const again = await connector.listChanges(CALENDAR, sync, 500);
    expect(again.listing).toEqual({ first: true, ended: "complete", since: daysAgo(90) });
    expect(ids(again)).toEqual(["e1", "e2", "e3"]);
    expect(again.items.every((item) => item.changeKind === "backfill")).toBe(true);
    // The token that listing ends with was issued after the expiry, and works.
    const fresh = await connector.listChanges(CALENDAR, again.next, 500);
    expect([fresh.items, fresh.listing]).toEqual([[], undefined]);
  });

  it("a listing holds the events that end after since, and keeps the since it started with", async () => {
    const events = [
      meeting("past", -10),
      meeting("recent", -2),
      meeting("soon", 2),
      { id: "gone", status: "cancelled" as const },
      { ...meeting("called-off", 3), status: "cancelled" as const },
    ];
    const calendar = fakeCalendar(box([], events), { now: NOW, pageSize: 2 });
    const since = daysAgo(5);
    const pages = await listing(calendar.connector(calendarId, { since }), CALENDAR);
    // Cancelled events are listed, and a bare cancellation, which has no time, always is.
    expect(pages.map(ids)).toEqual([["recent", "soon"], ["called-off"]]);
    expect(pages.flatMap((page) => page.deletions).map((deletion) => deletion.sourceItemId)).toEqual(["gone"]);
    expect(pages.map((page) => page.listing)).toEqual([
      { first: true, since },
      { first: false, ended: "complete", since },
    ]);
    // Resumed by a connector built with another since, it lists from the first one.
    const resumed = await listing(
      calendar.connector(calendarId, { since: daysAgo(30) }),
      CALENDAR,
      (pages[0] as PersonalPage).next,
    );
    expect(resumed).toEqual(pages.slice(1));
    // With no since it holds every event, and its pages carry none.
    const whole = await listing(calendar.connector(calendarId, {}), CALENDAR);
    expect(whole.flatMap(ids)).toEqual(["past", "recent", "soon", "called-off"]);
    expect(whole.map((page) => page.listing)).toEqual([
      { first: true },
      { first: false },
      { first: false, ended: "complete" },
    ]);
  });
});

describe("the fakes' paging", () => {
  const four = (): GmailMessage[] => [mail("m1", 1), mail("m2", 2), mail("m3", 3), mail("m4", 4)];

  it("a limit that is not a positive integer is refused with bad_request", async () => {
    const gmail = fakeGmail(box(four()));
    const calendar = fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW });
    const [messages, events] = [gmail.connector(mailId, {}), calendar.connector(calendarId, {})];
    // A cursor of each fake, which the other refuses. The mail one stands at the rest pass.
    const mailCursor = (await messages.listChanges(MAIL, null, 500)).next;
    const eventCursor = (await events.listChanges(CALENDAR, null, 500)).next;
    for (const limit of [0, 1.5, -1, Number.NaN]) {
      expect(await codeOf(() => messages.listChanges(MAIL, null, limit)), String(limit)).toBe("bad_request");
      expect(await codeOf(() => events.listChanges(CALENDAR, null, limit)), String(limit)).toBe("bad_request");
      // Before the cursor is read: with a cursor that is not this fake's, it is still the limit that is refused.
      expect(await codeOf(() => messages.listChanges(MAIL, eventCursor, limit)), String(limit)).toBe("bad_request");
      expect(await codeOf(() => events.listChanges(CALENDAR, mailCursor, limit)), String(limit)).toBe("bad_request");
    }
    // The controls: a limit of 1 is one message or event, and the same cursors with it are bad_cursor.
    expect(tags(await messages.listChanges(MAIL, mailCursor, 1))).toEqual(["f:m1:"]);
    expect(ids(await events.listChanges(CALENDAR, null, 1))).toEqual(["e1"]);
    expect(await codeOf(() => messages.listChanges(MAIL, eventCursor, 1))).toBe("bad_cursor");
    expect(await codeOf(() => events.listChanges(CALENDAR, mailCursor, 1))).toBe("bad_cursor");
    // The account is checked first, as the connector checks it.
    expect(await codeOf(() => messages.listChanges(CALENDAR, null, 0))).toBe("off_allowlist");
  });

  it("a Gmail listing pages over the mailbox it had at its first page", async () => {
    // A message deleted after page 1 does not make page 2 skip one that is still there.
    const gmail = fakeGmail(box(four()), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    const sent = await connector.listChanges(MAIL, null, 500);
    const first = await connector.listChanges(MAIL, sent.next, 500);
    expect(tags(first)).toEqual(["f:m1:", "f:m2:"]);
    gmail.deletePermanently("m1");
    const second = await connector.listChanges(MAIL, first.next, 500);
    expect([tags(second), gone(second), second.listing]).toEqual([
      ["f:m3:", "f:m4:"],
      [],
      { first: false, ended: "window" },
    ]);
    // The history that follows the listing reports the change.
    const after = await connector.listChanges(MAIL, second.next, 500);
    expect([tags(after), gone(after)]).toEqual([[], ["gmail-id:m1"]]);

    // A message added after the first page does not make a later page repeat one, and is not in
    // the listing; nor does one whose labels move it to another pass.
    const grown = fakeGmail(box(four()), { pageSize: 2 });
    const growing = grown.connector(mailId, {});
    const page = await growing.listChanges(MAIL, null, 500);
    grown.add(mail("m0", 0.5));
    grown.relabel("m4", ["SENT"]);
    const rest = await listing(growing, MAIL, page.next);
    expect(rest.map(tags)).toEqual([
      ["f:m1:", "f:m2:"],
      ["f:m3:", "f:m4:SENT"],
    ]);
    expect(ids(await growing.listChanges(MAIL, last(rest).next, 500))).toEqual(["gmail-id:m0", "gmail-id:m4"]);

    // A listed message that is gone before its page is read is a deletion on that page, as the
    // connector reports one whose metadata answers 404; one trashed since has the labels it has now.
    const changed = fakeGmail(box(four()), { pageSize: 2 });
    const changing = changed.connector(mailId, {});
    const start = await listing(changing, MAIL).then((pages) => pages[1] as PersonalPage);
    changed.deletePermanently("m3");
    changed.trash("m4");
    const end = await changing.listChanges(MAIL, start.next, 500);
    expect([tags(end), gone(end), end.items[0]?.markers, end.listing?.ended]).toEqual([
      ["f:m4:"],
      ["gmail-id:m3"],
      ["TRASH"],
      "window",
    ]);

    // The shuffled order is fixed at the first page too.
    const six = (): GmailMessage[] => [...four(), mail("m5", 5), mail("m6", 6)];
    const whole = (
      await listing(fakeGmail(box(six()), { pageSize: 2, order: "shuffled" }).connector(mailId, {}), MAIL)
    ).flatMap(tags);
    expect(whole).toEqual(["f:m1:", "f:m4:", "f:m2:", "f:m5:", "f:m3:", "f:m6:"]);
    const shuffled = fakeGmail(box(six()), { pageSize: 2, order: "shuffled" });
    const shuffling = shuffled.connector(mailId, {});
    const one = await shuffling.listChanges(MAIL, null, 500);
    const two = await shuffling.listChanges(MAIL, one.next, 500);
    shuffled.add(mail("m0", 0.5));
    shuffled.deletePermanently("m1");
    expect([...tags(one), ...tags(two), ...(await listing(shuffling, MAIL, two.next)).flatMap(tags)]).toEqual(whole);
  });

  it("a Calendar listing pages over the events it had at its first page", async () => {
    const since = daysAgo(1);
    const calendar = fakeCalendar(box([], [meeting("e1", 1), meeting("e2", 2), meeting("e3", 3), meeting("e4", 4)]), {
      now: NOW,
      pageSize: 2,
    });
    const connector = calendar.connector(calendarId, { since });
    const first = await connector.listChanges(CALENDAR, null, 500);
    expect(ids(first)).toEqual(["e1", "e2"]);
    // An edit moves a listed event to before since, and an event is added: page 2 does not shift.
    calendar.upsert(meeting("e1", -10));
    calendar.upsert(meeting("e5", 5));
    const second = await connector.listChanges(CALENDAR, first.next, 500);
    expect([ids(second), second.listing]).toEqual([["e3", "e4"], { first: false, ended: "complete", since }]);
    // The sync token the listing ends with reports both changes.
    expect(ids(await connector.listChanges(CALENDAR, second.next, 500))).toEqual(["e1", "e5"]);

    // An edit that moves an event into the window does not make page 2 repeat one, and an event
    // removed before its page is read is handed over as it is now: a deletion.
    const other = fakeCalendar(box([], [meeting("old", -10), meeting("e1", 1), meeting("e2", 2), meeting("e3", 3)]), {
      now: NOW,
      pageSize: 2,
    });
    const moving = other.connector(calendarId, { since });
    const page = await moving.listChanges(CALENDAR, null, 500);
    expect(ids(page)).toEqual(["e1", "e2"]);
    other.upsert(meeting("old", 6));
    other.remove("e3");
    const rest = await moving.listChanges(CALENDAR, page.next, 500);
    expect([ids(rest), rest.deletions.map((deletion) => deletion.sourceItemId), rest.listing?.ended]).toEqual([
      [],
      ["e3"],
      "complete",
    ]);
    const sync = await moving.listChanges(CALENDAR, rest.next, 500);
    expect([ids(sync), sync.deletions.map((deletion) => deletion.sourceItemId)]).toEqual([["old"], ["e3"]]);
  });

  it("a forbidden message is skipped on the page that would have carried it", async () => {
    const gmail = fakeGmail(box(four().slice(0, 3)), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    // The control: before it is forbidden, the message is an item.
    expect((await listing(connector, MAIL)).map(tags)).toEqual([[], ["f:m1:", "f:m2:"], ["f:m3:"]]);
    gmail.forbid("m2");
    const pages = await listing(connector, MAIL);
    expect(pages.map(tags)).toEqual([[], ["f:m1:"], ["f:m3:"]]);
    expect(pages.map((page) => page.skipped)).toEqual([[], [{ sourceItemId: "gmail-id:m2", reason: "forbidden" }], []]);
    expect(pages.flatMap(gone)).toEqual([]);
    // An added message that is forbidden is skipped on its history page.
    gmail.forbid("m4");
    gmail.add(mail("m4", 0.5));
    gmail.add(mail("m5", 0.25));
    const live = await connector.listChanges(MAIL, last(pages).next, 500);
    expect([tags(live), live.skipped, gone(live)]).toEqual([
      ["f:m5:"],
      [{ sourceItemId: "gmail-id:m4", reason: "forbidden" }],
      [],
    ]);
    for (const page of [...pages, live]) expect(ConnectorPage.safeParse(page).success).toBe(true);
  });

  it("a message gone at its get is a source deletion and no item", async () => {
    const gmail = fakeGmail(box(four().slice(0, 3)), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    // The control: before, the message is an item.
    expect((await listing(connector, MAIL)).map(tags)).toEqual([[], ["f:m1:", "f:m2:"], ["f:m3:"]]);
    gmail.goneAtGet("m2");
    const pages = await listing(connector, MAIL);
    expect(pages.map(tags)).toEqual([[], ["f:m1:"], ["f:m3:"]]);
    expect(pages.map(gone)).toEqual([[], ["gmail-id:m2"], []]);
    expect(pages.flatMap((page) => page.skipped)).toEqual([]);
    // An added message that is gone at its get is a deletion on its history page.
    gmail.goneAtGet("m4");
    gmail.add(mail("m4", 0.5));
    gmail.add(mail("m5", 0.25));
    const live = await connector.listChanges(MAIL, last(pages).next, 500);
    expect([tags(live), gone(live), live.skipped]).toEqual([["f:m5:"], ["gmail-id:m4"], []]);
    // Neither control is a change to the mailbox: the history id stays where it was.
    const quiet = await connector.listChanges(MAIL, live.next, 500);
    gmail.goneAtGet("m1");
    gmail.forbid("m3");
    gmail.tooLarge("m1");
    expect(await connector.listChanges(MAIL, live.next, 500)).toEqual(quiet);
  });

  it("a message marked too large is an item read by its headers, unreadable, and gone or forbidden wins over it", async () => {
    const full = (id: string, days: number): GmailMessage =>
      mail(id, days, ["INBOX"], {
        text: "Plain words",
        html: "<p>Plain words</p>",
        attachments: [{ name: "notes.pdf", type: "application/pdf", size: 120 }],
      });
    const gmail = fakeGmail(box([full("m1", 1), full("m2", 2), full("m3", 3), full("m4", 4)]));
    const connector = gmail.connector(mailId, {});
    // A test can mark it before the message is added, and an unknown id is no error.
    for (const id of ["m1", "m2", "m3", "m5", "nowhere"]) gmail.tooLarge(id);
    gmail.goneAtGet("m2");
    gmail.forbid("m3");
    const pages = await listing(connector, MAIL);
    const { text: _text, html: _html, attachments: _attachments, ...headers } = full("m1", 1);
    // Its headers alone, marked unreadable; the one beside it, not marked, is read whole.
    expect(pages.flatMap((page) => page.items)).toEqual([
      gmailItem({ ...headers, unreadable: true }, { sourceAccount: mailId, changeKind: "backfill" }),
      gmailItem(full("m4", 4), { sourceAccount: mailId, changeKind: "backfill" }),
    ]);
    expect(pages.flatMap(gone)).toEqual(["gmail-id:m2"]);
    expect(pages.flatMap((page) => page.skipped)).toEqual([{ sourceItemId: "gmail-id:m3", reason: "forbidden" }]);
    // The same in history, and it is no skipped item there either.
    gmail.add(full("m5", 0.5));
    const live = await connector.listChanges(MAIL, last(pages).next, 500);
    expect([ids(live), live.skipped, live.items[0]?.depth]).toEqual([["gmail-id:m5"], [], "full"]);
    expect(Buffer.from(live.items[0]?.payload ?? "", "base64").toString("utf8")).toContain("X-Pi-Unreadable: 1");
    expect(Buffer.from(live.items[0]?.payload ?? "", "base64").toString("utf8")).not.toContain("notes.pdf");
  });

  it("a since that is not a timestamp is refused with bad_request", async () => {
    const gmail = fakeGmail(box(four()));
    const calendar = fakeCalendar(box([], [meeting("e1", 1)]), { now: NOW });
    // A word, a time with no offset, a date alone, and nothing.
    for (const since of ["yesterday", "2026-02-08T12:00:00", "2026-02-08", ""]) {
      expect(await codeOf(async () => gmail.connector(mailId, { since })), since).toBe("bad_request");
      expect(await codeOf(async () => calendar.connector(calendarId, { since })), since).toBe("bad_request");
    }
    // It is refused when the connector is made, before any call.
    expect([gmail.calls, calendar.calls]).toEqual([0, 0]);
    // The controls: a timestamp, with "Z" or an offset, and no since at all.
    for (const options of [{ since: daysAgo(30) }, { since: "2026-02-08T12:00:00+01:00" }, {}]) {
      expect((await listing(gmail.connector(mailId, options), MAIL)).flatMap(tags)).toHaveLength(4);
      expect(ids(await calendar.connector(calendarId, options).listChanges(CALENDAR, null, 500))).toEqual(["e1"]);
    }
  });

  it("a message that is gone or deleted is a source deletion, though it is forbidden", async () => {
    const gmail = fakeGmail(box(four()), { pageSize: 2 });
    const connector = gmail.connector(mailId, {});
    for (const id of ["m1", "m2", "m3", "m5"]) gmail.forbid(id);
    // Forbidden and gone at its get: gone wins. The control beside it is forbidden alone.
    gmail.goneAtGet("m2");
    const sent = await connector.listChanges(MAIL, null, 500);
    const first = await connector.listChanges(MAIL, sent.next, 500);
    expect([tags(first), gone(first), first.skipped]).toEqual([
      [],
      ["gmail-id:m2"],
      [{ sourceItemId: "gmail-id:m1", reason: "forbidden" }],
    ]);
    // Forbidden and deleted before its page is read: a deletion, and nothing skipped.
    gmail.deletePermanently("m3");
    const second = await connector.listChanges(MAIL, first.next, 500);
    expect([tags(second), gone(second), second.skipped]).toEqual([["f:m4:"], ["gmail-id:m3"], []]);
    // The same in history: a forbidden message added and deleted again is a deletion alone.
    gmail.add(mail("m5", 0.5));
    gmail.deletePermanently("m5");
    const live = await connector.listChanges(MAIL, second.next, 500);
    expect([tags(live), gone(live), live.skipped]).toEqual([[], ["gmail-id:m5", "gmail-id:m3"], []]);
  });

  it("add refuses an id the mailbox ever held", async () => {
    const gmail = fakeGmail(box(four()));
    const connector = gmail.connector(mailId, {});
    const history = last(await listing(connector, MAIL)).next;
    gmail.deletePermanently("m3");
    // Gmail never uses an id again: one that was deleted cannot come back as a new message.
    expect(() => gmail.add(mail("m3", 0.5))).toThrow();
    expect(() => gmail.add(mail("m1", 0.5))).toThrow();
    // So no history page holds one id as both an item and a deletion.
    const page = await connector.listChanges(MAIL, history, 500);
    expect([tags(page), gone(page)]).toEqual([[], ["gmail-id:m3"]]);
    // The refused calls changed nothing, and an id never held is added.
    gmail.add(mail("m9", 0.5));
    const after = await connector.listChanges(MAIL, history, 500);
    expect([tags(after), gone(after)]).toEqual([["f:m9:"], ["gmail-id:m3"]]);
  });

  it("with pageBytes, a page stops at the bound, keeps the rest pending in its cursor and hands them over before it lists again", async () => {
    const bodied = (
      id: string,
      days: number,
      labelIds: string[] = ["INBOX"],
      more: Partial<GmailMessage> = {},
    ): GmailMessage => mail(id, days, labelIds, { text: `Words of ${id} `.repeat(20), ...more });
    const messages = [
      bodied("s1", 1, ["SENT"]),
      ...[2, 3, 4, 5, 6, 7, 8].map((days) => bodied(`m${days}`, days)),
      bodied("old", 40),
    ];
    const one = gmailItem(messages[1] as GmailMessage, { sourceAccount: mailId, changeKind: "backfill" }).payload
      .length;
    // Below three payloads: a page stops once its payloads pass it, after its second item.
    const pageBytes = Math.floor(one * 1.5);
    const run = async (options: { pageBytes?: number }) => {
      const gmail = fakeGmail(box(messages), { pageSize: 50, ...options });
      const connector = gmail.connector(mailId, { since: daysAgo(30) });
      const listed = await listing(connector, MAIL, connector.resetCursor());
      // History: two received, then the owner's reply in the thread of a Social message, and two more.
      gmail.add(bodied("social", 0.9, ["INBOX", "CATEGORY_SOCIAL"], { threadId: "t9" }));
      const quiet = await drain(connector, MAIL, last(listed).next);
      for (const [id, days] of [
        ["h1", 0.8],
        ["h2", 0.7],
      ] as const)
        gmail.add(bodied(id, days));
      gmail.add(bodied("reply", 0.6, ["SENT"], { threadId: "t9" }));
      for (const [id, days] of [
        ["h3", 0.5],
        ["h4", 0.4],
      ] as const)
        gmail.add(bodied(id, days));
      gmail.deletePermanently("m8");
      const live = await drain(connector, MAIL, last(quiet).next);
      return { connector, listed, live, fetched: gmail.fetched };
    };
    const plain = await run({});
    const bound = await run({ pageBytes });
    // The same items, in the same order, over more pages.
    expect(bound.listed.flatMap(ids)).toEqual(plain.listed.flatMap(ids));
    expect(bound.listed.flatMap((page) => page.listed ?? [])).toEqual(
      plain.listed.flatMap((page) => page.listed ?? []),
    );
    expect(bound.live.flatMap(ids)).toEqual(plain.live.flatMap(ids));
    // The reply's thread is looked up once it is fetched, though its fetch was deferred.
    expect(bound.live.flatMap(ids)).toEqual([
      "gmail-id:h1",
      "gmail-id:h2",
      "gmail-id:reply",
      "gmail-id:h3",
      "gmail-id:h4",
      "gmail-id:social",
    ]);
    expect(bound.fetched).toEqual(plain.fetched);
    expect(bound.listed.length).toBeGreaterThan(plain.listed.length);
    expect(bound.live.length).toBeGreaterThan(plain.live.length);
    // Every page that fetched holds at least one item and stops once its payloads pass the bound;
    // `more` is true while ids are pending. The deletion comes with the history page's first part.
    for (const page of [...bound.listed, ...bound.live]) {
      const sizes = page.items.map((item) => item.payload.length);
      expect(sizes.slice(0, -1).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(pageBytes);
      if (page !== last(bound.listed) && page !== last(bound.live)) expect(page.more).toBe(true);
    }
    expect(bound.live.flatMap(gone)).toEqual(["gmail-id:m8"]);
    expect((bound.live.find((page) => page.items.length > 0) as PersonalPage).deletions).toHaveLength(1);
    // The same cursor gives the same page, a cursor with pending ids included.
    for (const page of [...bound.listed, ...bound.live])
      expect(await bound.connector.listChanges(MAIL, page.next, 500)).toEqual(
        await bound.connector.listChanges(MAIL, page.next, 500),
      );
    // fakeSources passes the option on.
    const [source] = fakeSources(world({ now: new Date(NOW) }), { pageBytes: 1 });
    const sentPage = await (source as PersonalSource).connector("google_mail", mailId, {}).listChanges(MAIL, null, 500);
    expect([sentPage.items.length, sentPage.more]).toEqual([1, true]);
  });
});

describe("the fakes and the builders", () => {
  it("the fakes' items equal the builders' for the same message and event", async () => {
    const w = world({ now: new Date(NOW) });
    for (const [n, source] of fakeSources(w).entries()) {
      const box = w.accounts[n] as WorldAccount;
      const mailPages = await listing(source.connector("google_mail", mailId, {}), MAIL);
      // The owner's mail first, then the rest that is not junk, each newest first.
      const newestFirst = [...box.messages].sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? -1 : 1));
      const built = newestFirst.map((message) => gmailItem(message, { sourceAccount: mailId, changeKind: "backfill" }));
      expect(mailPages.flatMap((page) => page.items)).toEqual([
        ...built.filter(ownerSent),
        ...built.filter((item) => !ownerSent(item) && !isJunk(item)),
      ]);

      const calendarPages = await listing(source.connector("google_calendar", calendarId, {}), CALENDAR);
      const events = box.events.map((event) =>
        calendarItem(event, { sourceAccount: calendarId, changeKind: "backfill", now: w.now }),
      );
      expect(calendarPages.flatMap((page) => page.items)).toEqual(events.filter((item) => "payload" in item));
      expect(calendarPages.flatMap((page) => page.deletions)).toEqual(events.filter((item) => !("payload" in item)));
      expect(calendarPages.flatMap((page) => page.deletions)).toHaveLength(
        box.events.filter(isBareCancellation).length,
      );

      // Every page is a page the shared code takes, and every item a RawItem: mail at depth full, events at depth headers.
      for (const page of [...mailPages, ...calendarPages]) {
        expect(ConnectorPage.safeParse(page).success).toBe(true);
        for (const item of page.items)
          expect(
            RawItem.safeParse(item).success && item.depth === (item.sourceKind === "email" ? "full" : "headers"),
            item.sourceItemId,
          ).toBe(true);
      }
    }
  });

  it("fakeSources gives one source per account, in the shape sync takes", async () => {
    const w = world({ now: new Date(NOW) });
    const sources = fakeSources(w, { pageSize: 5, order: "shuffled" });
    // Checked by the type check: each is a PersonalSource, and its connectors are shared Connectors.
    const typed: PersonalSource[] = sources;
    const shared: Connector = (typed[0] as PersonalSource).connector("google_mail", mailId, {});
    expect(shared).toBeDefined();
    expect(sources.map((source) => [source.label, source.compartment])).toEqual(
      w.accounts.map((box) => [box.label, box.compartment]),
    );
    for (const [n, source] of sources.entries()) {
      expect(await source.profile()).toEqual({ address: w.accounts[n]?.address });
      // The options reach both fakes, and the calendar's now is the world's.
      const mailPages = await listing(source.connector("google_mail", mailId, {}), MAIL);
      expect(mailPages.every((page) => page.items.length <= 5)).toBe(true);
      expect(mailPages.some((page) => page.items.length === 5)).toBe(true);
      const page = await source.connector("google_calendar", calendarId, {}).listChanges(CALENDAR, null, 500);
      expect(page.items.length + page.deletions.length).toBeLessThanOrEqual(5);
      // The source's controls are its two fakes: a change made on one shows through the source.
      source.calendar.upsert(meeting("added", 1));
      source.calendar.remove("added");
      const pages = await listing(source.connector("google_calendar", calendarId, {}), CALENDAR);
      expect(
        pages.flatMap((one) => one.deletions).find((deletion) => deletion.sourceItemId === "added")?.deletedAt,
      ).toBe(w.now);
      expect(source.gmail.calls).toBe(1 + mailPages.length);
      expect(source.gmail.fetched).toHaveLength(mailPages.flatMap((one) => one.items).length);
    }
  });
});

// The send side: Google's token, send and revoke URLs, as `pi send` reaches them.
describe("the Gmail fake's send endpoint", () => {
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
  const CRLF = "\r\n";
  const TEXT = "Shall we meet on Thursday?\nBest,\n\tthe owner";
  const SUBJECT = "Réunion jeudi";

  // A message as renderMessage writes one: CRLF lines, an encoded-word subject, base64 lines of 76.
  const raw = (to: string[], more: string[] = []): string => {
    const body = Buffer.from(TEXT.replaceAll("\n", CRLF), "utf8").toString("base64");
    const lines = body.match(/.{1,76}/g) ?? [];
    const headers = [
      "From: owner@example.org",
      `To: ${to.join(`,${CRLF} `)}`,
      `Subject: =?UTF-8?B?${Buffer.from(SUBJECT, "utf8").toString("base64")}?=`,
      ...more,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ];
    return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${lines.join(CRLF)}${CRLF}`, "utf8").toString("base64url");
  };

  // A mailbox, a first listing's history cursor, and an access token from the token URL.
  async function ready(messages: GmailMessage[] = [mail("m1", 1)]) {
    const gmail = fakeGmail(box(messages));
    const connector = gmail.connector(mailId, {});
    const cursor = last(await listing(connector, MAIL)).next;
    const token = (await (
      await gmail.fetch(TOKEN_URL, { method: "POST", body: "grant_type=refresh_token&refresh_token=send-refresh" })
    ).json()) as { access_token: string; scope: string };
    const send = (body: unknown, signal?: AbortSignal) =>
      gmail.fetch(SEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    const listed = async () => (await drain(connector, MAIL, cursor)).flatMap((page) => page.items);
    return { gmail, token, send, listed };
  }

  it("a sent message is listed under SENT on its thread, with the text that was sent", async () => {
    const { gmail, token, send, listed } = await ready();
    expect(token.scope).toBe(
      "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email",
    );
    const answer = await send({
      raw: raw(
        ["alex@example.com", "blair@example.com"],
        ["In-Reply-To: <m1@example.com>", "References: <m1@example.com>"],
      ),
      threadId: "m1",
    });
    expect(answer.status).toBe(200);
    const { id, threadId } = (await answer.json()) as { id: string; threadId: string };
    expect(threadId).toBe("m1");
    const [item, ...more] = await listed();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      sourceItemId: `gmail-id:${id}`,
      threadId: "m1",
      markers: ["SENT"],
      addressees: ["alex@example.com", "blair@example.com"],
      sender: "owner@example.org",
    });
    expect(gmail.message(id)?.text).toBe(TEXT);
    const header = (name: string) => gmail.message(id)?.headers.find((one) => one.name === name)?.value;
    expect([header("Subject"), header("In-Reply-To"), header("References")]).toEqual([
      SUBJECT,
      "<m1@example.com>",
      "<m1@example.com>",
    ]);
    // A message with no thread named starts its own.
    const second = (await (await send({ raw: raw(["alex@example.com"]) })).json()) as { id: string; threadId: string };
    expect(second.threadId).toBe(second.id);
    expect(gmail.requests.map((request) => request.url)).toEqual([TOKEN_URL, SEND_URL, SEND_URL]);
  });

  it("a dropped answer still stores the message", async () => {
    const { gmail, send, listed } = await ready();
    gmail.dropNextSendAnswer();
    await expect(send({ raw: raw(["alex@example.com"]) })).rejects.toThrow();
    expect((await listed()).map((item) => item.markers)).toEqual([["SENT"]]);
  });

  it("a held answer stores the message before it answers", async () => {
    const { gmail, send, listed } = await ready();
    gmail.holdNextSend();
    let answered = false;
    const answer = send({ raw: raw(["alex@example.com"]) }).then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [item] = await listed();
    expect(answered).toBe(false);
    gmail.releaseSend();
    const { id } = (await (await answer).json()) as { id: string };
    expect(item?.sourceItemId).toBe(`gmail-id:${id}`);
    // A held answer whose request is aborted fails, and the message stays stored.
    gmail.holdNextSend();
    const controller = new AbortController();
    const aborted = send({ raw: raw(["blair@example.com"]) }, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(gmail.requests.filter((request) => request.url === SEND_URL)).toHaveLength(2);
  });

  it("failNextSend stores nothing and answers its status; answerNextSend answers its body as given and stores the message", async () => {
    const { gmail, send, listed } = await ready();
    gmail.failNextSend(400);
    expect((await send({ raw: raw(["alex@example.com"]) })).status).toBe(400);
    expect(await listed()).toEqual([]);
    gmail.answerNextSend("not json");
    const answer = await send({ raw: raw(["alex@example.com"]) });
    expect([answer.status, await answer.text()]).toEqual([200, "not json"]);
    expect(await listed()).toHaveLength(1);
    // A send with no access token the fake issued is a 401, and stores nothing.
    const stranger = await gmail.fetch(SEND_URL, {
      method: "POST",
      headers: { Authorization: "Bearer not-issued" },
      body: JSON.stringify({ raw: raw(["alex@example.com"]) }),
    });
    expect(stranger.status).toBe(401);
    expect(await listed()).toHaveLength(1);
  });

  it("addReply adds an inbound message on the thread; the revoke URL records the token and answers 200; any other URL is refused and recorded", async () => {
    const { gmail, listed } = await ready();
    const reply = gmail.addReply("m1", "alex@example.com");
    expect(await listed()).toMatchObject([
      {
        sourceItemId: `gmail-id:${reply}`,
        threadId: "m1",
        markers: ["INBOX"],
        sender: "alex@example.com",
        addressees: ["owner@example.org"],
      },
    ]);
    expect((await gmail.fetch(REVOKE_URL, { method: "POST", body: "token=send-refresh" })).status).toBe(200);
    expect(gmail.revoked).toEqual(["send-refresh"]);
    await expect(gmail.fetch("https://example.com/elsewhere", { method: "GET" })).rejects.toThrow();
    expect(gmail.requests.map((request) => request.url).at(-1)).toBe("https://example.com/elsewhere");
  });
});
