import type {
  ConnectorCursor,
  RawItem,
  SourceAccount,
  SourceAccountId,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { calendarItem, isBareCancellation } from "../items/builders.ts";
import type { CalendarEvent, ConnectorOptions, PersonalConnector, PersonalPage } from "../items/types.ts";
import { callPlan, coded, decodeCursor, encodeCursor, type FailureKind, pageLimit, windowStart } from "./support.ts";
import type { WorldAccount } from "./world.ts";

// A primary calendar in memory that hands over the pages the Google connector would, with
// items from the same builder. Deterministic: its clock is the `now` it is given.

export type FakeCalendar = {
  connector(sourceAccount: SourceAccountId, options: ConnectorOptions): PersonalConnector;
  upsert(event: CalendarEvent): void;
  remove(id: string): void;
  expireSyncTokens(): void;
  failAt(n: number, kind: FailureKind): void;
  // Every `listChanges` call so far.
  readonly calls: number;
};

// A sync token: the calendar's sequence when it was issued, and which round of tokens it is of.
type Token = { seq: number; round: number };
// A listing: how far it has read, the lower bound it started with, and the sequence it started
// at, which its sync token is issued for.
type ListCursor = { fake: "calendar"; phase: "list"; offset: number; from: number; since?: Timestamp };
// The changes since a token, of which those up to `after` are already handed over.
type SyncCursor = { fake: "calendar"; phase: "sync"; token: Token; after?: number };
type Cursor = ListCursor | SyncCursor;

// When an event ends, or NaN when it does not say.
function endOf(event: CalendarEvent): number {
  if (event.end?.dateTime !== undefined) return Date.parse(event.end.dateTime);
  return event.end?.date === undefined ? Number.NaN : Date.parse(`${event.end.date}T00:00:00Z`);
}

export function fakeCalendar(account: WorldAccount, options: { now: Timestamp; pageSize?: number }): FakeCalendar {
  const pageSize = options.pageSize ?? 250;
  // Each event's versions, oldest first, each with the sequence it was made at. A removed
  // event stays, as a bare cancellation.
  type Version = { event: CalendarEvent; changed: number };
  const events = new Map<string, Version[]>(account.events.map((event) => [event.id, [{ event, changed: 0 }]]));
  // Every event as it is now, and as it was at a sequence, for those that existed then.
  const latest = (): Version[] => [...events.values()].flatMap((versions) => versions.slice(-1));
  const at = (seq: number): Version[] =>
    [...events.values()].flatMap((versions) => versions.filter((version) => version.changed <= seq).slice(-1));
  let seq = 0;
  let round = 0;
  const plan = callPlan();

  function connector(sourceAccount: SourceAccountId, built: ConnectorOptions): PersonalConnector {
    const since = windowStart(built);
    function page(
      source: SourceAccount,
      listed: CalendarEvent[],
      changeKind: "backfill" | "live",
    ): Pick<PersonalPage, "items" | "deletions" | "skipped"> {
      const made = listed.map((event) =>
        calendarItem(event, { sourceAccount: source.id, changeKind, now: options.now }),
      );
      return {
        items: made.filter((one): one is RawItem => "payload" in one),
        deletions: made.filter((one): one is SourceDeletion => !("payload" in one)),
        skipped: [],
      };
    }

    function listingPage(
      source: SourceAccount,
      cursor: Omit<ListCursor, "fake" | "phase">,
      first: boolean,
      size: number,
    ): PersonalPage {
      const { since } = cursor;
      // Every event that ended after the bound when the listing began, cancelled ones included;
      // a bare cancellation, which has no time, is always listed. A change made since does not
      // shift its pages: each event is handed over as it is now, and the sync token the listing
      // ends with reports the change.
      const all = at(cursor.from)
        .filter(({ event }) => since === undefined || isBareCancellation(event) || !(endOf(event) <= Date.parse(since)))
        .flatMap(({ event }) => events.get(event.id)?.slice(-1) ?? [])
        .map((version) => version.event);
      const last = cursor.offset + size >= all.length;
      // The last page's `next` carries the sync token, issued for when the listing began.
      const next: Cursor = last
        ? { fake: "calendar", phase: "sync", token: { seq: cursor.from, round } }
        : { fake: "calendar", phase: "list", ...cursor, offset: cursor.offset + size };
      return {
        ...page(source, all.slice(cursor.offset, cursor.offset + size), "backfill"),
        more: !last,
        next: encodeCursor(next),
        listing: { first, ...(last ? { ended: "complete" as const } : {}), ...(since === undefined ? {} : { since }) },
      };
    }

    function syncPage(source: SourceAccount, cursor: SyncCursor, size: number): PersonalPage {
      // Paging is live: the changes are read again on every page, in the order they were made.
      const changed = latest()
        .filter((stored) => stored.changed > (cursor.after ?? cursor.token.seq))
        .sort((a, b) => a.changed - b.changed);
      const listed = changed.slice(0, size);
      const after = listed.at(-1)?.changed;
      const last = changed.length <= size || after === undefined;
      const next: SyncCursor = last
        ? { fake: "calendar", phase: "sync", token: { seq, round } }
        : { fake: "calendar", phase: "sync", token: cursor.token, after };
      return {
        ...page(
          source,
          listed.map((stored) => stored.event),
          "live",
        ),
        more: !last,
        next: encodeCursor(next),
      };
    }

    return {
      async listChanges(source: SourceAccount, cursor: ConnectorCursor | null, limit: number): Promise<PersonalPage> {
        const failure = plan.next();
        if (source.id !== sourceAccount || source.connector !== "google_calendar") throw coded("off_allowlist");
        const size = Math.min(pageLimit(limit), pageSize);
        const state = cursor === null ? null : decodeCursor<Cursor>(cursor, "calendar");
        if (failure !== undefined && !(failure === "not_found" && state?.phase === "sync")) throw coded(failure);
        // A new listing starts with the bound this connector was built with.
        const fresh = (): PersonalPage =>
          listingPage(source, { offset: 0, from: seq, ...(since === undefined ? {} : { since }) }, true, size);
        if (state === null) return fresh();
        // A resumed listing keeps the bound it started with, whatever this connector's is.
        if (state.phase === "list") return listingPage(source, state, false, size);
        // A token from before the last expiry has expired: the page is a new listing's first page.
        return failure === "not_found" || state.token.round < round ? fresh() : syncPage(source, state, size);
      },
      // These accounts have no access list: no call is made.
      syncAccessList: async (_source, cursor) => ({
        changes: [],
        next: cursor ?? encodeCursor({ fake: "calendar-access" }),
      }),
      // A calendar's reset is the cleared cursor.
      resetCursor: () => null,
    };
  }

  return {
    connector,
    upsert(event) {
      seq += 1;
      // Its previous `updated`, or now when it has none, plus the sequence in seconds.
      const versions = events.get(event.id) ?? [];
      const previous = Date.parse(versions.at(-1)?.event.updated ?? options.now);
      const updated = new Date(
        (Number.isNaN(previous) ? Date.parse(options.now) : previous) + seq * 1000,
      ).toISOString();
      events.set(event.id, [...versions, { event: { ...event, updated, etag: `fake-etag-${seq}` }, changed: seq }]);
    },
    // Deleted at the source: listed afterwards as a bare cancellation.
    remove(id) {
      const versions = events.get(id);
      if (versions === undefined) throw new Error("unknown event");
      seq += 1;
      events.set(id, [...versions, { event: { id, status: "cancelled" }, changed: seq }]);
    },
    expireSyncTokens() {
      round += 1;
    },
    failAt: plan.failAt,
    get calls() {
      return plan.calls;
    },
  };
}
