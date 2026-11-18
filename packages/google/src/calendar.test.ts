import {
  type ConnectorCursor,
  type HttpPort,
  type HttpRequest,
  RawItem,
  type SourceAccount,
  type SourceCredential,
  SourceDeletion,
} from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import {
  type CalendarEvent,
  type ConnectorOptions,
  calendarItem,
  type PersonalPage,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { createGoogleConnector } from "./connector.ts";
import { mailCursor } from "./cursor.ts";
import { createGoogleHttp, GOOGLE_SCOPES, type GoogleDeps, GoogleError, type TokenSource } from "./http.ts";
import { failureOf as failure } from "./test-support/fixtures.ts";

// Hand-written Calendar answers on reserved domains. No test reaches the network: every
// request goes through the real port to a fake fetch that plays one small calendar.

const accountId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ2");
const account: SourceAccount = {
  id: accountId,
  connector: "google_calendar",
  sourceKind: "calendar",
  vault: "personal",
  externalRef: "owner@example.org",
  accessSyncKind: "none",
  compartments: ["own"],
  markerCompartments: [],
};
const credential: SourceCredential = {
  connector: "google_calendar",
  sourceAccount: accountId,
  scopes: [...GOOGLE_SCOPES],
  secret: '{"fake":"secret"}',
};

const NOW = "2026-03-10T12:00:00.000Z";
const SINCE = "2025-12-10T00:00:00.000Z";
const OTHER_SINCE = "2026-02-01T00:00:00.000Z";
// One year after NOW: the horizon a listing started at NOW sends as timeMax.
const HORIZON = "2027-03-10T12:00:00.000Z";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type Reply = { status: number; body?: unknown };
// By "<syncToken>|<pageToken>"; "|" is a listing's first page. A missing key answers 410 to a
// sync token and 400 to anything else.
type Calendar = Record<string, unknown>;

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && typeof (value as Reply).status === "number";

// One event as Google writes it, with fields the whitelist leaves out.
const answer = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "calendar#event",
  etag: `"etag-${id}"`,
  id,
  status: "confirmed",
  htmlLink: `https://calendar.example.test/event?eid=fake-link-${id}`,
  created: "2026-03-01T08:00:00.000Z",
  updated: "2026-03-09T08:00:00.000Z",
  summary: `Review ${id}`,
  description: "fake-description of the agenda",
  location: "fake-location, Room 4",
  creator: { email: "alex@example.com" },
  organizer: { email: "alex@example.com", displayName: "Alex Example" },
  start: { dateTime: "2026-03-12T15:00:00Z", timeZone: "Etc/UTC" },
  end: { dateTime: "2026-03-12T16:00:00Z", timeZone: "Etc/UTC" },
  iCalUID: `${id}@calendar.example.test`,
  sequence: 0,
  attendees: [
    { email: "owner@example.org", self: true, responseStatus: "accepted", comment: "fake-comment" },
    { email: "alex@example.com", organizer: true, displayName: "Alex Example", responseStatus: "accepted" },
    { email: "room-4@example.org", resource: true, responseStatus: "needsAction" },
  ],
  hangoutLink: "https://meet.example.test/fake-meeting",
  conferenceData: { conferenceId: "fake-conference", entryPoints: [{ uri: "https://meet.example.test/fake-meeting" }] },
  attachments: [{ fileUrl: "https://files.example.test/fake-attachment", title: "fake-attachment-title" }],
  reminders: { useDefault: true },
  eventType: "default",
  ...over,
});
const read = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  status: "confirmed",
  etag: `"etag-${id}"`,
  updated: "2026-03-09T08:00:00.000Z",
  summary: `Review ${id}`,
  start: { dateTime: "2026-03-12T15:00:00Z" },
  end: { dateTime: "2026-03-12T16:00:00Z" },
  organizer: { email: "alex@example.com", displayName: "Alex Example" },
  attendees: [
    { email: "owner@example.org", responseStatus: "accepted", self: true },
    { email: "alex@example.com", displayName: "Alex Example", responseStatus: "accepted", organizer: true },
    { email: "room-4@example.org", responseStatus: "needsAction", resource: true },
  ],
  callLink: "https://meet.example.test/fake-meeting",
  inviteLink: `https://calendar.example.test/event?eid=fake-link-${id}`,
  ...over,
});
const made = (event: CalendarEvent, changeKind: "backfill" | "live" = "backfill") =>
  calendarItem(event, { sourceAccount: accountId, changeKind, now: NOW });

function google(
  calendar: Calendar,
  options: ConnectorOptions = {},
  timeoutMs = 1000,
  tokens: TokenSource = { accessToken: async () => "fake-access-token", invalidate: () => {} },
) {
  const calls: URL[] = [];
  const requests: HttpRequest[] = [];
  const clock = { reads: 0, at: Date.parse(NOW) };
  const flight = { now: 0, most: 0 };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    flight.now += 1;
    flight.most = Math.max(flight.most, flight.now);
    await new Promise((resolve) => setImmediate(resolve));
    flight.now -= 1;
    const { status, body } = route(url);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  function route(url: URL): Reply {
    if (`${url.origin}${url.pathname}` !== EVENTS) return { status: 400 };
    const syncToken = url.searchParams.get("syncToken");
    const found = calendar[`${syncToken ?? ""}|${url.searchParams.get("pageToken") ?? ""}`];
    if (found === undefined) return { status: syncToken === null ? 400 : 410 };
    return isReply(found) ? found : { status: 200, body: found };
  }
  const deps: GoogleDeps = {
    fetch,
    sleep: async () => {},
    now: () => {
      clock.reads += 1;
      return clock.at;
    },
    random: () => 0.5,
    timeoutMs,
  };
  const port = createGoogleHttp({ tokens, deps });
  const http: HttpPort = {
    send: (req) => {
      requests.push(req);
      return port.send(req);
    },
  };
  const connector = createGoogleConnector("google_calendar", credential, http, options, deps);
  const page = (cursor: ConnectorCursor | null, limit = 100): Promise<PersonalPage> =>
    connector.listChanges(account, cursor, limit);
  const query = (index: number): Record<string, string> => Object.fromEntries(calls[index]?.searchParams ?? []);
  return {
    calls,
    requests,
    clock,
    flight,
    page,
    query,
    withOptions: (other: ConnectorOptions) => createGoogleConnector("google_calendar", credential, http, other, deps),
  };
}

// A cursor in the sync phase at `token`: the end of an empty listing.
const syncAt = async (token: string): Promise<ConnectorCursor> =>
  (await google({ "|": { nextSyncToken: token } }).page(null)).next;
const payloadOf = (one: RawItem | undefined): unknown =>
  JSON.parse(Buffer.from(one?.payload ?? "", "base64").toString("utf8"));
const base = { singleEvents: "true", showDeleted: "true", maxResults: "100" };

describe("a Calendar listing", () => {
  it("the first request sends timeMin from since, singleEvents, showDeleted and 250 a page", async () => {
    const windowed = google({ "|": { items: [answer("e1")], nextSyncToken: "s1" } }, { since: SINCE });
    const first = await windowed.page(null, 9999);
    expect(windowed.calls).toHaveLength(1);
    expect(windowed.query(0)).toEqual({
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "250",
      timeMin: SINCE,
      timeMax: HORIZON,
    });
    expect(first.items).toEqual([made(read("e1"))]);
    expect(first.items[0]?.changeKind).toBe("backfill");

    await windowed.page(null, 40);
    expect(windowed.query(1)).toEqual({
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "40",
      timeMin: SINCE,
      timeMax: HORIZON,
    });

    // With no since, no bound is sent.
    const whole = google({ "|": { nextSyncToken: "s1" } });
    await whole.page(null);
    expect(whole.query(0)).toEqual({ ...base, timeMax: HORIZON });
  });

  it("requests the primary calendar's events", async () => {
    const { calls, requests, page } = google(
      {
        "|": { items: [answer("e1")], nextPageToken: "p2" },
        "|p2": { nextSyncToken: "s1" },
        "s1|": { nextSyncToken: "s2" },
      },
      { since: SINCE },
      4321,
    );
    const first = await page(null);
    const second = await page(first.next);
    await page(second.next);
    expect(calls).toHaveLength(3);
    for (const url of calls)
      expect(`${url.origin}${url.pathname}`).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    // Every API request is a read with the timeout from deps.
    for (const request of requests)
      expect(request).toEqual({ method: "GET", url: request.url, headers: {}, timeoutMs: 4321, kind: "read" });
  });

  it("a listing resumed by a connector built with another since resends the cursor's timeMin", async () => {
    const calendar: Calendar = {
      "|": { items: [answer("e1")], nextPageToken: "p2" },
      "|p2": { items: [answer("e2")], nextPageToken: "p3" },
      "|p3": { nextSyncToken: "s1" },
    };
    const started = google(calendar, { since: SINCE });
    const first = await started.page(null);
    const second = await started.withOptions({ since: OTHER_SINCE }).listChanges(account, first.next, 100);
    expect(started.query(1)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON, pageToken: "p2" });
    await started.withOptions({}).listChanges(account, second.next, 100);
    expect(started.query(2)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON, pageToken: "p3" });

    // A listing started with no since stays unbounded.
    const whole = google(calendar);
    const unbounded = await whole.page(null);
    const resumed = await whole.withOptions({ since: OTHER_SINCE }).listChanges(account, unbounded.next, 100);
    expect(whole.query(1)).toEqual({ ...base, timeMax: HORIZON, pageToken: "p2" });
    expect(resumed.listing).toEqual({ first: false, until: HORIZON });
  });

  it("every listing page's mark carries the cursor's timeMin", async () => {
    const calendar: Calendar = {
      "|": { items: [answer("e1")], nextPageToken: "p2" },
      "|p2": { items: [answer("e2")], nextPageToken: "p3" },
      "|p3": { items: [answer("e3")], nextSyncToken: "s1" },
    };
    const started = google(calendar, { since: SINCE });
    const other = started.withOptions({ since: OTHER_SINCE });
    const first = await started.page(null);
    const second = await other.listChanges(account, first.next, 100);
    const third = await other.listChanges(account, second.next, 100);
    expect([first.listing, second.listing, third.listing]).toEqual([
      { first: true, since: SINCE, until: HORIZON },
      { first: false, since: SINCE, until: HORIZON },
      { first: false, since: SINCE, until: HORIZON, ended: "complete" },
    ]);

    const whole = google(calendar);
    const unbounded = await whole.page(null);
    expect(unbounded.listing).toEqual({ first: true, until: HORIZON });
    expect("since" in (unbounded.listing ?? {})).toBe(false);
  });

  it("the last listing page is complete and carries the sync token in next", async () => {
    const { page, query } = google(
      {
        "|": { items: [answer("e1")], nextPageToken: "p2" },
        "|p2": { items: [answer("e2")], nextSyncToken: "s1" },
        "s1|": { nextSyncToken: "s1" },
      },
      { since: SINCE },
    );
    const first = await page(null);
    expect(first.listing).toEqual({ first: true, since: SINCE, until: HORIZON });
    const last = await page(first.next);
    expect(last.listing).toEqual({ first: false, since: SINCE, until: HORIZON, ended: "complete" });
    expect(last.items).toEqual([made(read("e2"))]);
    const synced = await page(last.next);
    expect(query(2)).toEqual({ ...base, syncToken: "s1" });
    expect(synced.listing).toBeUndefined();
  });

  it("a listing sends timeMax one year after the connector's clock, and a resumed page resends the cursor's", async () => {
    const calendar: Calendar = {
      "|": { items: [answer("e1")], nextPageToken: "p2" },
      "|p2": { items: [answer("e2")], nextPageToken: "p3" },
      "|p3": { nextSyncToken: "s1" },
      "s1|": { nextSyncToken: "s1" },
    };
    const started = google(calendar, { since: SINCE });
    const first = await started.page(null);
    expect(started.query(0)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON });
    // A later run, a month on, resends the horizon the listing's first page sent.
    started.clock.at = Date.parse("2026-04-10T12:00:00.000Z");
    const second = await started.page(first.next);
    expect(started.query(1)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON, pageToken: "p2" });
    const last = await started.page(second.next);
    expect(started.query(2)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON, pageToken: "p3" });
    // The mark carries the cursor's timeMin as since and its timeMax as until.
    expect(last.listing).toEqual({ first: false, since: SINCE, until: HORIZON, ended: "complete" });
    // Sync-token pages send no timeMax.
    await started.page(last.next);
    expect(started.query(3)).toEqual({ ...base, syncToken: "s1" });

    // A new listing reads the clock again: on the 29th of February the horizon is the 1st of March.
    const leap = google({ "|": { nextSyncToken: "s1" } });
    leap.clock.at = Date.parse("2028-02-29T09:00:00.000Z");
    await leap.page(null);
    expect(leap.query(0)).toEqual({ ...base, timeMax: "2029-03-01T09:00:00.000Z" });
  });

  it("a cursor written before the horizon keeps its meaning", async () => {
    // Cursors of version 4 as they were written before timeMax: a sync cursor, and a listing's
    // with and without timeMin. A listing resumes without timeMax, since its page token belongs
    // to the query its first page sent.
    const old = (phase: Record<string, unknown>): ConnectorCursor =>
      Buffer.from(JSON.stringify({ v: 4, connector: "google_calendar", ...phase })).toString(
        "base64url",
      ) as ConnectorCursor;
    const { page, query } = google(
      {
        "|": { nextSyncToken: "s1" },
        "s1|": { nextSyncToken: "s2" },
        "|p2": { nextPageToken: "p3" },
        "|p3": { nextSyncToken: "s3" },
      },
      { since: SINCE },
    );
    // A sync cursor with no horizon is read, and its horizon is unknown: a new listing starts.
    const relisted = await page(old({ phase: "sync", syncToken: "s1" }));
    expect(query(0)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON });
    expect(relisted.listing).toEqual({ first: true, since: SINCE, until: HORIZON, ended: "complete" });
    const resumed = await page(old({ phase: "list", pageToken: "p2", timeMin: SINCE }));
    expect(query(1)).toEqual({ ...base, timeMin: SINCE, pageToken: "p2" });
    expect(resumed.listing).toEqual({ first: false, since: SINCE });
    const ended = await page(resumed.next);
    expect(query(2)).toEqual({ ...base, timeMin: SINCE, pageToken: "p3" });
    // The listing's horizon is unknown, so the sync cursor it ends with has none either.
    await page(ended.next);
    expect(query(3)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON });
    await page(old({ phase: "list", pageToken: "p2" }));
    expect(query(4)).toEqual({ ...base, pageToken: "p2" });

    // A timeMax or a horizon that is no text fails bad_cursor before any call.
    const before = google({});
    for (const phase of [
      { phase: "list", pageToken: "p2", timeMax: 7 },
      { phase: "list", pageToken: "p2", timeMax: "" },
      { phase: "sync", syncToken: "s1", horizon: 7 },
      { phase: "sync", syncToken: "s1", horizon: "" },
    ]) {
      expect((await failure(before.page(old(phase)))).code, JSON.stringify(phase)).toBe("bad_cursor");
    }
    expect(before.calls).toHaveLength(0);
  });

  it("a page with no items returns no events", async () => {
    for (const body of [{ nextSyncToken: "s1" }, { items: [], nextSyncToken: "s1" }]) {
      const result = await google({ "|": body }).page(null);
      expect(result).toEqual({
        items: [],
        deletions: [],
        skipped: [],
        more: false,
        listing: { first: true, until: HORIZON, ended: "complete" },
        next: result.next,
      });
    }
  });
});

describe("Calendar changes", () => {
  it("a request with a sync token carries no timeMin, timeMax, updatedMin, q, orderBy or iCalUID", async () => {
    const { calls, page, query } = google({ "s1|": { items: [answer("e1")], nextSyncToken: "s2" } }, { since: SINCE });
    const result = await page(await syncAt("s1"));
    expect(query(0)).toEqual({ ...base, syncToken: "s1" });
    for (const name of ["timeMin", "timeMax", "updatedMin", "q", "orderBy", "iCalUID"])
      expect(calls[0]?.searchParams.has(name), name).toBe(false);
    expect(result.items).toEqual([made(read("e1"), "live")]);
    expect(result.items[0]?.changeKind).toBe("live");
    expect(result.listing).toBeUndefined();
  });

  it("the horizon rolls: a sync page whose horizon is less than eleven months ahead starts a new listing", async () => {
    const calendar: Calendar = {
      "|": { items: [answer("e1")], nextSyncToken: "s1" },
      "s1|": { items: [answer("e2")], nextPageToken: "p2" },
      "s1|p2": { nextSyncToken: "s2" },
      "s2|": { nextSyncToken: "s3" },
    };
    const { page, query, clock } = google(calendar, { since: SINCE });
    const listed = await page(null);
    // A month on, to the millisecond, the horizon is eleven months ahead: the sync token is used,
    // and every sync page keeps the horizon.
    clock.at = Date.parse("2026-04-10T12:00:00.000Z");
    const first = await page(listed.next);
    expect(query(1)).toEqual({ ...base, syncToken: "s1" });
    expect(first.listing).toBeUndefined();
    const second = await page(first.next);
    expect(query(2)).toEqual({ ...base, syncToken: "s1", pageToken: "p2" });
    // A millisecond later it is less: the next page is a new listing's first, with a new horizon.
    clock.at += 1;
    const relisted = await page(second.next);
    expect(query(3)).toEqual({ ...base, timeMin: SINCE, timeMax: "2027-04-10T12:00:00.001Z" });
    expect(relisted.listing).toEqual({
      first: true,
      since: SINCE,
      until: "2027-04-10T12:00:00.001Z",
      ended: "complete",
    });
    expect(relisted.items).toEqual([
      calendarItem(read("e1"), { sourceAccount: accountId, changeKind: "backfill", now: "2026-04-10T12:00:00.001Z" }),
    ]);
    // The listing's sync cursor carries the new horizon, so the next page uses its token.
    await page(relisted.next);
    expect(query(4)).toEqual({ ...base, syncToken: "s1" });
  });

  it("a later page resends the same sync token with the page token", async () => {
    const { page, query } = google(
      {
        "s1|": { items: [answer("e1")], nextPageToken: "p2" },
        "s1|p2": { items: [answer("e2")], nextPageToken: "p3" },
        "s1|p3": { nextSyncToken: "s2" },
      },
      { since: SINCE },
    );
    const first = await page(await syncAt("s1"));
    const second = await page(first.next);
    await page(second.next);
    expect([query(0), query(1), query(2)]).toEqual([
      { ...base, syncToken: "s1" },
      { ...base, syncToken: "s1", pageToken: "p2" },
      { ...base, syncToken: "s1", pageToken: "p3" },
    ]);
    expect(second.items).toEqual([made(read("e2"), "live")]);
  });

  it("the last sync page carries the new sync token in next", async () => {
    const { page, query } = google({
      "s1|": { items: [answer("e1")], nextPageToken: "p2" },
      "s1|p2": { nextSyncToken: "s2" },
      "s2|": { nextSyncToken: "s3" },
    });
    const first = await page(await syncAt("s1"));
    const last = await page(first.next);
    await page(last.next);
    expect(query(2)).toEqual({ ...base, syncToken: "s2" });
  });

  it("an expired token starts a new listing in the same call", async () => {
    const { page, query, calls } = google(
      { "|": { items: [answer("e1")], nextPageToken: "p2" }, "|p2": { nextSyncToken: "s9" } },
      { since: SINCE },
    );
    const result = await page(await syncAt("expired"));
    // Never an error and never an empty page: the new listing's first page.
    expect(calls).toHaveLength(2);
    expect(query(0)).toEqual({ ...base, syncToken: "expired" });
    expect(query(1)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON });
    expect(result.listing).toEqual({ first: true, since: SINCE, until: HORIZON });
    expect(result.items).toEqual([made(read("e1"))]);
    await page(result.next);
    expect(query(2)).toEqual({ ...base, timeMin: SINCE, timeMax: HORIZON, pageToken: "p2" });

    // A 410 to a listing is no expiry: it fails the page. So does a 404 to a sync token.
    expect((await failure(google({ "|": { status: 410 } }).page(null))).code).toBe("not_found");
    expect((await failure(google({ "s1|": { status: 404 } }).page(await syncAt("s1")))).code).toBe("not_found");
  });
});

describe("a token that cannot be had", () => {
  it("a token that cannot be had for a sync page fails the page and starts no listing", async () => {
    const calendar: Calendar = {
      "|": { items: [answer("e1")], nextSyncToken: "s9" },
      "s1|": { items: [answer("e2")], nextSyncToken: "s2" },
    };
    const start = await syncAt("s1");
    for (const [code, status] of [
      ["not_found", 410],
      ["not_found", 404],
      ["forbidden", 403],
    ] as const) {
      const asked = { times: 0 };
      const tokens: TokenSource = {
        accessToken: async () => {
          asked.times += 1;
          throw new GoogleError(code, status);
        },
        invalidate: () => {},
      };
      const { page, calls } = google(calendar, { since: SINCE }, 1000, tokens);
      const error = await failure(page(start));
      // A 410 from the token endpoint is not an expired sync token.
      expect([error.code, error.status]).toEqual([code, undefined]);
      expect(calls).toHaveLength(0);
      expect(asked.times).toBe(1);
    }
    // The positive control: with a token, the same cursor returns the change.
    expect((await google(calendar, { since: SINCE }).page(start)).items).toEqual([made(read("e2"), "live")]);
  });
});

describe("Calendar events", () => {
  it("a bare cancellation is a source deletion, never an item", async () => {
    const bare = [
      { kind: "calendar#event", etag: '"etag-gone"', id: "e-gone", status: "cancelled" },
      { id: "e-gone-2", status: "cancelled" },
    ];
    const { page } = google({ "s1|": { items: [bare[0], answer("e1"), bare[1]], nextSyncToken: "s2" } });
    const result = await page(await syncAt("s1"));
    expect(result.deletions).toEqual([
      { sourceAccount: accountId, sourceItemId: "e-gone", deletedAt: NOW },
      { sourceAccount: accountId, sourceItemId: "e-gone-2", deletedAt: NOW },
    ]);
    for (const deletion of result.deletions) expect(SourceDeletion.safeParse(deletion).success).toBe(true);
    expect(result.items).toEqual([made(read("e1"), "live")]);
    expect(result.items.map((one) => one.sourceItemId)).toEqual(["e1"]);

    // In a listing too, as showDeleted returns them.
    const listed = await google({ "|": { items: [bare[1]], nextSyncToken: "s1" } }).page(null);
    expect(listed.deletions).toEqual([{ sourceAccount: accountId, sourceItemId: "e-gone-2", deletedAt: NOW }]);
    expect(listed.items).toEqual([]);
  });

  it("a bare cancellation's deletedAt is the injected clock", async () => {
    const { page, clock } = google({
      "|": {
        items: [
          { id: "e-gone", status: "cancelled" },
          { id: "e-gone-2", status: "cancelled" },
          answer("e1", { updated: "not a time" }),
        ],
        nextSyncToken: "s1",
      },
    });
    const result = await page(null);
    expect(result.deletions.map((one) => one.deletedAt)).toEqual([NOW, NOW]);
    // An event with no valid updated is observed at the same clock.
    expect(result.items[0]?.observedAt).toBe(NOW);
    // Read once for the page.
    expect(clock.reads).toBe(1);
  });

  it("a cancelled event with its fields is an item marked cancelled", async () => {
    const { page } = google({ "|": { items: [answer("e1", { status: "cancelled" })], nextSyncToken: "s1" } });
    const result = await page(null);
    expect(result.deletions).toEqual([]);
    expect(result.items).toEqual([made(read("e1", { status: "cancelled" }))]);
    expect(result.items[0]?.markers).toEqual(["calendar", "cancelled"]);
  });

  it("the output equals the whitelist: description, location, conference data, attachments, other links and unknown fields are dropped", async () => {
    const allDay = answer("e2", {
      start: { date: "2026-03-14" },
      end: { date: "2026-03-15" },
      status: "tentative",
      fakeUnknownField: "fake-unknown-value",
    });
    const { page } = google({ "|": { items: [answer("e1"), allDay], nextSyncToken: "s1" } });
    const { items } = await page(null);
    expect(items).toEqual([
      made(read("e1")),
      made(read("e2", { status: "tentative", start: { date: "2026-03-14" }, end: { date: "2026-03-15" } })),
    ]);
    expect(payloadOf(items[0])).toEqual(read("e1"));
    expect(Object.keys(payloadOf(items[0]) as object)).toEqual([
      "id",
      "status",
      "etag",
      "updated",
      "summary",
      "start",
      "end",
      "organizer",
      "attendees",
      "callLink",
      "inviteLink",
    ]);
    for (const one of items) {
      expect(RawItem.safeParse(one).success).toBe(true);
      expect(one.depth).toBe("headers");
    }
    // Everything but the two kept links, which the toEqual above holds exactly.
    const unlinked = items.map((one) => {
      const { callLink: _call, inviteLink: _invite, ...rest } = payloadOf(one) as CalendarEvent;
      return rest;
    });
    const everything = JSON.stringify(unlinked) + JSON.stringify(items.map((one) => ({ ...one, payload: "" })));
    for (const word of [
      "fake-description",
      "fake-location",
      "fake-conference",
      "fake-meeting",
      "fake-attachment",
      "fake-link",
      "fake-comment",
      "fake-unknown",
      "timeZone",
      "creator",
      "iCalUID",
    ]) {
      expect(everything, word).not.toContain(word);
    }
  });

  describe("an event's call link and calendar link", () => {
    // The payload of one event read from Google's answer with these fields changed.
    const kept = async (over: Record<string, unknown>): Promise<CalendarEvent> => {
      const { page } = google({ "|": { items: [answer("e1", over)], nextSyncToken: "s1" } });
      const { items, skipped } = await page(null);
      expect(skipped).toEqual([]);
      return payloadOf(items[0]) as CalendarEvent;
    };

    it("a Meet link is the conference data's video entry point, before the hangoutLink", async () => {
      const event = await kept({
        conferenceData: {
          conferenceId: "fake-conference",
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1-555-0100" },
            { entryPointType: "video", uri: "https://meet.google.com/aaa-bbbb-ccc" },
          ],
        },
        hangoutLink: "https://meet.example.test/other",
      });
      expect(event.callLink).toBe("https://meet.google.com/aaa-bbbb-ccc");
      expect(event.inviteLink).toBe("https://calendar.example.test/event?eid=fake-link-e1");
      expect(JSON.stringify(event)).not.toContain("fake-conference");
      expect(JSON.stringify(event)).not.toContain("tel:");
    });

    it("with no video entry point, the hangoutLink", async () => {
      const event = await kept({ conferenceData: undefined, hangoutLink: "https://meet.google.com/ddd-eeee-fff" });
      expect(event.callLink).toBe("https://meet.google.com/ddd-eeee-fff");
    });

    it("with neither, the first https URL in the location, and nothing else of the location", async () => {
      const event = await kept({
        conferenceData: undefined,
        hangoutLink: undefined,
        location: "Zoom (https://example.zoom.us/j/123456789?pwd=fakepass), fake-location Room 4",
      });
      expect(event.callLink).toBe("https://example.zoom.us/j/123456789?pwd=fakepass");
      expect(JSON.stringify(event)).not.toContain("fake-location");
      expect(JSON.stringify(event)).not.toContain("Room 4");
    });

    it("a value that is not https, or not a URL, is none", async () => {
      const event = await kept({
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "javascript:alert(1)" }] },
        hangoutLink: "http://meet.example.test/plain",
        location: "ftp://files.example.test/fake-location and https:// nothing",
        htmlLink: "http://calendar.example.test/event?eid=plain",
      });
      expect(event).not.toHaveProperty("callLink");
      expect(event).not.toHaveProperty("inviteLink");
    });

    it("a link field of the wrong shape gives none and still reads the event", async () => {
      const event = await kept({ conferenceData: "fake-conference", hangoutLink: 5, location: 7, htmlLink: {} });
      expect(event).toMatchObject({ id: "e1", status: "confirmed" });
      expect(event).not.toHaveProperty("callLink");
      expect(event).not.toHaveProperty("inviteLink");
    });

    it("the description is still dropped, a URL in it included", async () => {
      const event = await kept({
        conferenceData: undefined,
        hangoutLink: undefined,
        location: undefined,
        description: "fake-description https://example.zoom.us/j/999",
      });
      expect(event).not.toHaveProperty("callLink");
      expect(JSON.stringify(event)).not.toContain("fake-description");
      expect(JSON.stringify(event)).not.toContain("/j/999");
    });
  });

  it("an attendee without an email is dropped, and an organizer without one is omitted", async () => {
    const over = {
      organizer: { displayName: "Unnamed Calendar", self: true },
      attendees: [
        { displayName: "No Address", responseStatus: "accepted" },
        { email: "", displayName: "Empty Address" },
        { email: "casey@example.com", responseStatus: "tentative" },
      ],
    };
    const { page } = google({ "|": { items: [answer("e1", over)], nextSyncToken: "s1" } });
    const { items } = await page(null);
    const { organizer: _organizer, ...unorganized } = read("e1");
    const expected: CalendarEvent = {
      ...unorganized,
      attendees: [{ email: "casey@example.com", responseStatus: "tentative" }],
    };
    expect(items).toEqual([made(expected)]);
    expect(payloadOf(items[0])).toEqual(expected);
    expect("organizer" in (payloadOf(items[0]) as object)).toBe(false);
    expect(items[0]?.sender).toBeUndefined();
  });

  it("one malformed event is skipped as unsupported and the page completes; an entry with no usable id fails the page", async () => {
    const { status: _status, ...statusless } = answer("e2");
    // Each fails a check of its own, and each still says which event it is.
    const malformed: unknown[] = [
      answer("e2", { status: "pending" }),
      statusless,
      answer("e2", { status: 7 }),
      answer("e2", { summary: 7 }),
      answer("e2", { start: "2026-03-12" }),
      answer("e2", { start: { dateTime: 7 } }),
      answer("e2", { attendees: "alex@example.com" }),
      answer("e2", { attendees: [{ email: 7 }] }),
      answer("e2", { attendees: [{ email: "alex@example.com", responseStatus: "maybe" }] }),
      answer("e2", { attendees: [{ email: "alex@example.com", self: "yes" }] }),
      answer("e2", { organizer: "alex@example.com" }),
    ];
    for (const e2 of malformed) {
      // In a listing: the events beside it are handed over, and the listing still ends.
      const listed = await google({
        "|": { items: [answer("e1"), e2, { id: "e-gone", status: "cancelled" }, answer("e3")], nextSyncToken: "s1" },
      }).page(null);
      expect(listed.items, JSON.stringify(e2)).toEqual([made(read("e1")), made(read("e3"))]);
      expect(listed.skipped, JSON.stringify(e2)).toEqual([{ sourceItemId: "e2", reason: "unsupported" }]);
      expect(listed.deletions.map((one) => one.sourceItemId)).toEqual(["e-gone"]);
      expect(listed.listing).toEqual({ first: true, until: HORIZON, ended: "complete" });
      // Among changes too, and the page still leads on.
      const changed = await google({ "s1|": { items: [e2, answer("e3")], nextSyncToken: "s2" } }).page(
        await syncAt("s1"),
      );
      expect([changed.items, changed.skipped], JSON.stringify(e2)).toEqual([
        [made(read("e3"), "live")],
        [{ sourceItemId: "e2", reason: "unsupported" }],
      ]);
      expect(changed.next).not.toBe(await syncAt("s1"));
    }
    // Nothing of a skipped event is handed over but its id.
    const skipping = await google({
      "|": { items: [answer("e2", { status: "pending", summary: "fake-skipped-title" })], nextSyncToken: "s1" },
    }).page(null);
    expect(JSON.stringify(skipping)).not.toContain("fake-skipped-title");

    // An entry that names no event cannot be skipped by name: it fails its whole page.
    const { id: _id, ...nameless } = answer("e2");
    for (const e2 of [
      nameless,
      answer("e2", { id: "" }),
      answer("e2", { id: 7 }),
      answer("e2", { id: null }),
      "text",
      7,
      null,
      ["e2"],
    ]) {
      const { page } = google({ "|": { items: [answer("e1"), e2, answer("e3")], nextSyncToken: "s1" } });
      expect((await failure(page(null))).code, JSON.stringify(e2)).toBe("bad_response");
    }
    // A page without the expected shape fails the same way.
    for (const body of [
      { items: "none", nextSyncToken: "s1" },
      { items: [] },
      { nextPageToken: 7 },
      { nextSyncToken: "" },
      [],
    ]) {
      expect((await failure(google({ "|": body }).page(null))).code, JSON.stringify(body)).toBe("bad_response");
    }

    // The positive control: the three statuses are read.
    const statuses = ["confirmed", "tentative", "cancelled"] as const;
    const { page } = google({
      "|": { items: statuses.map((status) => answer(`e-${status}`, { status })), nextSyncToken: "s1" },
    });
    expect((await page(null)).items).toEqual(statuses.map((status) => made(read(`e-${status}`, { status }))));
  });
});

describe("every Calendar page", () => {
  const calendar: Calendar = {
    "|": { items: [answer("e1"), { id: "e-gone", status: "cancelled" }], nextPageToken: "p2" },
    "|p2": { items: [answer("e2")], nextSyncToken: "s1" },
    "s1|": { items: [answer("e3")], nextSyncToken: "s2" },
  };

  it("more is true exactly when the answer carried a next page token, whatever the page holds", async () => {
    const { page } = google({
      "|": { items: [], nextPageToken: "p2" },
      "|p2": { items: [answer("e1")], nextSyncToken: "s1" },
      "s1|": { nextPageToken: "c2" },
      "s1|c2": { items: [answer("e2")], nextSyncToken: "s2" },
      "s2|": { nextSyncToken: "s3" },
    });
    const pages: PersonalPage[] = [await page(null)];
    for (let read = 1; read < 5; read += 1) pages.push(await page((pages.at(-1) as PersonalPage).next));
    expect(pages.map((one) => [one.items.length, one.listing?.ended, one.more])).toEqual([
      [0, undefined, true],
      [1, "complete", false],
      [0, undefined, true],
      [1, undefined, false],
      [0, undefined, false],
    ]);
  });

  it("the same cursor gives the same page", async () => {
    const { page, flight } = google(calendar, { since: SINCE });
    const first = await page(null);
    expect(await page(null)).toEqual(first);
    const second = await page(first.next);
    expect(await page(first.next)).toEqual(second);
    const third = await page(second.next);
    expect(await page(second.next)).toEqual(third);
    expect(new Set([first.next, second.next, third.next]).size).toBe(3);
    expect(flight.most).toBe(1);
  });

  it("a cursor of the other connector fails bad_cursor", async () => {
    const { page, calls } = google(calendar);
    for (const cursor of [
      mailCursor({ phase: "list", start: "1000", pass: "rest", pageToken: "p2", reconcile: false }),
      mailCursor({ phase: "history", historyId: "1000" }),
    ]) {
      expect((await failure(page(cursor))).code).toBe("bad_cursor");
    }
    expect(calls).toHaveLength(0);
    // The positive control: its own cursor is read.
    await page((await page(null)).next);
    expect(calls).toHaveLength(2);
  });
});
