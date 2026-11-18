import type {
  ChangeKind,
  HttpPort,
  RawItem,
  SkippedItem,
  SourceAccount,
  SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import {
  type ConnectorOptions,
  calendarItem,
  type PersonalPage,
  whitelistedEvent,
} from "@intelligence/personal-core/items";
import { type CalendarPhase, calendarCursor } from "./cursor.ts";
import {
  apiGet,
  bad,
  type GoogleDeps,
  GoogleError,
  isRecord,
  optionalToken,
  record,
  text,
  withDefaults,
} from "./http.ts";

// The Calendar phases, on the primary calendar: a listing, then changes since a sync token.
// An event is read field by field from the whitelist, by core's one reading of it; nothing a
// title says is followed.

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_PAGE = 250;

// One events.list answer: its events as items and deletions, those it could not read, and
// where it leads.
type Answer = { items: RawItem[]; deletions: SourceDeletion[]; skipped: SkippedItem[] } & (
  | { pageToken: string }
  | { syncToken: string }
);

export function calendarPages(
  http: HttpPort,
  options: ConnectorOptions,
  deps: GoogleDeps,
): (account: SourceAccount, phase: CalendarPhase | null, limit: number) => Promise<PersonalPage> {
  const { now } = withDefaults(deps);

  async function read(
    account: SourceAccount,
    changeKind: ChangeKind,
    query: [string, string][],
    limit: number,
    at: Timestamp,
  ): Promise<Answer> {
    const url = new URL(EVENTS);
    const params: [string, string][] = [
      ["singleEvents", "true"],
      ["showDeleted", "true"],
      ["maxResults", String(Math.min(limit, MAX_PAGE))],
      ...query,
    ];
    for (const [name, value] of params) url.searchParams.append(name, value);
    const body = record((await apiGet(http, url.toString(), deps)).body);
    const [pageToken, syncToken] = [optionalToken(body.nextPageToken), optionalToken(body.nextSyncToken)];
    const { items: listed } = body;
    if (listed !== undefined && !Array.isArray(listed)) throw bad();

    const items: RawItem[] = [];
    const deletions: SourceDeletion[] = [];
    const skipped: SkippedItem[] = [];
    for (const one of listed ?? []) {
      // Everything else in the answer, the description, the rest of the location and conference
      // data, attachments and other links included, is left behind, and a person without an email
      // is no person.
      const read = whitelistedEvent(one, "dropped");
      if (read === null || read.id === "") {
        // An entry that names no event fails the page.
        if (!isRecord(one) || !text(one.id)) throw bad();
        skipped.push({ sourceItemId: one.id, reason: "unsupported" });
        continue;
      }
      const made = calendarItem(read, { sourceAccount: account.id, changeKind, now: at });
      if ("payload" in made) items.push(made);
      else deletions.push(made);
    }
    if (pageToken !== undefined) return { items, deletions, skipped, pageToken };
    // The last page of a listing or of a set of changes always carries a sync token.
    if (syncToken === undefined) throw bad();
    return { items, deletions, skipped, syncToken };
  }

  const token = (pageToken: string | undefined): [string, string][] =>
    pageToken === undefined ? [] : [["pageToken", pageToken]];

  // A listing sends the timeMin and timeMax it started with, from its cursor, on every page,
  // and marks every page with them as since and until. Its sync cursor keeps the timeMax as
  // the horizon.
  async function listing(
    account: SourceAccount,
    at: { first: boolean; pageToken?: string; timeMin?: string; timeMax?: string },
    limit: number,
    clock: Timestamp,
  ): Promise<PersonalPage> {
    const bound = {
      ...(at.timeMin === undefined ? {} : { timeMin: at.timeMin }),
      ...(at.timeMax === undefined ? {} : { timeMax: at.timeMax }),
    };
    const answer = await read(account, "backfill", [...Object.entries(bound), ...token(at.pageToken)], limit, clock);
    const last = "syncToken" in answer;
    return {
      items: answer.items,
      deletions: answer.deletions,
      skipped: answer.skipped,
      more: !last,
      listing: {
        first: at.first,
        ...(last ? { ended: "complete" as const } : {}),
        ...(at.timeMin === undefined ? {} : { since: at.timeMin }),
        ...(at.timeMax === undefined ? {} : { until: at.timeMax }),
      },
      next: last
        ? calendarCursor({
            phase: "sync",
            syncToken: answer.syncToken,
            ...(at.timeMax === undefined ? {} : { horizon: at.timeMax }),
          })
        : calendarCursor({ phase: "list", pageToken: answer.pageToken, ...bound }),
    };
  }

  // A sync page sends the sync token and the page token, and nothing a sync token forbids. Its
  // cursor keeps the horizon. Once the horizon is unknown or less than eleven months ahead, a
  // new listing starts instead, so the horizon rolls on about once a month.
  async function sync(
    account: SourceAccount,
    at: { syncToken: string; pageToken?: string; horizon?: string },
    limit: number,
    clock: Timestamp,
  ): Promise<PersonalPage> {
    if (at.horizon === undefined || Date.parse(at.horizon) < ahead(clock, 0, 11)) return first(account, limit, clock);
    const kept = { horizon: at.horizon };
    let answer: Answer;
    try {
      answer = await read(account, "live", [["syncToken", at.syncToken], ...token(at.pageToken)], limit, clock);
    } catch (error) {
      // A new listing starts in this same call.
      if (error instanceof GoogleError && error.status === 410) return first(account, limit, clock);
      throw error;
    }
    return {
      items: answer.items,
      deletions: answer.deletions,
      skipped: answer.skipped,
      more: "pageToken" in answer,
      next: calendarCursor(
        "syncToken" in answer
          ? { phase: "sync", syncToken: answer.syncToken, ...kept }
          : { phase: "sync", syncToken: at.syncToken, pageToken: answer.pageToken, ...kept },
      ),
    };
  }

  function ahead(clock: Timestamp, years: number, months: number): number {
    const at = new Date(clock);
    at.setUTCFullYear(at.getUTCFullYear() + years, at.getUTCMonth() + months);
    return at.getTime();
  }
  // A new listing's horizon is one calendar year after the page's clock: with no timeMax,
  // Google expands a recurring event that never ends without bound.
  const horizon = (clock: Timestamp): string => new Date(ahead(clock, 1, 0)).toISOString();

  const first = (account: SourceAccount, limit: number, clock: Timestamp): Promise<PersonalPage> =>
    listing(
      account,
      { first: true, ...(options.since === undefined ? {} : { timeMin: options.since }), timeMax: horizon(clock) },
      limit,
      clock,
    );

  return (account, phase, limit) => {
    // The calendar's clock, read once per page.
    const clock = new Date(now()).toISOString();
    if (phase === null) return first(account, limit, clock);
    return phase.phase === "list"
      ? listing(account, { first: false, ...phase }, limit, clock)
      : sync(account, phase, limit, clock);
  };
}
