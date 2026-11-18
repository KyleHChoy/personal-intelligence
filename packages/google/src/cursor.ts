import { ConnectorCursor } from "@intelligence/contracts";
import { GoogleError, isRecord, text } from "./http.ts";

// The cursor codec for the four connectors: base64url JSON with a version, the connector and a
// phase. Private to this package; sync stores a cursor and never reads one.

// Gmail: a reset, which starts a reconciling listing; a listing in progress; or history from a
// history id. A listing's `start` is the history id its first page read, where history takes over
// when the listing ends; `after` is its window's start in epoch seconds. With no `pending`, a list
// cursor's pass and page token are the next list call. With `pending`, they are where that call's
// page stood once its ids are fetched: the page token its answer carried, none at a pass's end. A
// history cursor with `pending` is the next history page; its `sent` are the pending ids the owner
// sent, by their history records, whose threads are still to be looked up once they are fetched.
// With `sent`, `seen` are the ids the page's earlier parts already handled, outside `pending`, and
// `threads` the threads they already looked up, so the rest of the page fetches neither again.
export type MailPass = "sent" | "rest" | "older";
export type MailList = {
  phase: "list";
  start: string;
  pass: MailPass;
  pageToken?: string;
  reconcile: boolean;
  after?: number;
  pending?: string[];
};
export type MailHistory = {
  phase: "history";
  historyId: string;
  pageToken?: string;
  pending?: string[];
  sent?: string[];
  seen?: string[];
  threads?: string[];
};
export type MailPhase = { phase: "reset" } | MailList | MailHistory;

// Calendar: a listing in progress, with the timeMin and timeMax its first page sent, or changes
// since a sync token, with the horizon, the timeMax of the listing that issued it. A cursor
// written before timeMax has neither: its listing resumes without one, and its horizon is
// unknown.
export type CalendarPhase =
  | { phase: "list"; pageToken: string; timeMin?: string; timeMax?: string }
  | { phase: "sync"; syncToken: string; pageToken?: string; horizon?: string };

// Contacts: a listing in progress, or changes since a sync token. No cursor starts a listing.
// `fields`: the version of the person fields the phase's listing asked for; a cursor without it, or
// of another version, starts a new listing, since Google asks every later request to match the
// first.
export type ContactsPhase = (
  | { phase: "list"; pageToken: string }
  | { phase: "sync"; syncToken: string; pageToken?: string }
) & { fields?: number };
// Drive: the reset, which starts a listing that fetches every document again; a listing in
// progress from `start`, the change token taken before it; or the changes feed from a token.
// `pending` are ids listed or changed and not handed over yet.
export type DrivePhase =
  | { phase: "d_reset" }
  | { phase: "d_list"; start: string; pageToken?: string; refetch: boolean; pending?: string[] }
  | { phase: "d_changes"; token: string; pending?: string[] };

const VERSION = 4;

// Each reader returns the phase with its keys in one order, so one phase has one encoding, or
// null for anything that is not a phase of its connector.
const PASSES: MailPass[] = ["sent", "rest", "older"];
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text);
// An optional field: absent, or what `check` accepts.
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const seconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function mailPhase(raw: Record<string, unknown>): MailPhase | null {
  const { phase, start, historyId, pass, pageToken, reconcile, after, pending, sent, seen, threads } = raw;
  if (!optional(pageToken, text) || !optional(pending, ids)) return null;
  const token = pageToken as string | undefined;
  const left = pending as string[] | undefined;
  if (phase === "reset") return { phase };
  if (
    phase === "list" &&
    text(start) &&
    PASSES.some((one) => one === pass) &&
    typeof reconcile === "boolean" &&
    optional(after, seconds)
  ) {
    const at = pass as MailPass;
    // The older pass is a reconciling listing's, over a window, and fetches nothing.
    if (at === "older" && (!reconcile || after === undefined || left !== undefined)) return null;
    return {
      phase,
      start,
      pass: at,
      ...(token === undefined ? {} : { pageToken: token }),
      reconcile,
      ...(after === undefined ? {} : { after: after as number }),
      ...(left === undefined ? {} : { pending: left }),
    };
  }
  // `seen` and `threads` come only with `sent`, and `seen` holds no pending id.
  const withSent = (value: unknown): boolean => sent !== undefined && ids(value);
  if (
    phase === "history" &&
    text(historyId) &&
    optional(sent, (value) => ids(value) && value.every((id) => left?.includes(id) === true)) &&
    optional(seen, (value) => withSent(value) && (value as string[]).every((id) => left?.includes(id) !== true)) &&
    optional(threads, withSent)
  ) {
    return {
      phase,
      historyId,
      ...(token === undefined ? {} : { pageToken: token }),
      ...(left === undefined ? {} : { pending: left }),
      ...(sent === undefined ? {} : { sent: sent as string[] }),
      ...(seen === undefined ? {} : { seen: seen as string[] }),
      ...(threads === undefined ? {} : { threads: threads as string[] }),
    };
  }
  return null;
}

function calendarPhase(raw: Record<string, unknown>): CalendarPhase | null {
  const { phase, syncToken, pageToken, timeMin, timeMax, horizon } = raw;
  if (phase === "list" && text(pageToken) && optional(timeMin, text) && optional(timeMax, text)) {
    return {
      phase,
      pageToken,
      ...(timeMin === undefined ? {} : { timeMin: timeMin as string }),
      ...(timeMax === undefined ? {} : { timeMax: timeMax as string }),
    };
  }
  if (phase === "sync" && text(syncToken) && optional(pageToken, text) && optional(horizon, text)) {
    return {
      phase,
      syncToken,
      ...(pageToken === undefined ? {} : { pageToken: pageToken as string }),
      ...(horizon === undefined ? {} : { horizon: horizon as string }),
    };
  }
  return null;
}

function contactsPhase(raw: Record<string, unknown>): ContactsPhase | null {
  const { phase, syncToken, pageToken, fields } = raw;
  if (fields !== undefined && !(Number.isSafeInteger(fields) && (fields as number) > 0)) return null;
  const at = fields === undefined ? {} : { fields: fields as number };
  const keys = Object.keys(raw).filter((key) => key !== "v" && key !== "connector" && key !== "fields");
  if (phase === "list" && text(pageToken) && keys.length === 2) return { phase, pageToken, ...at };
  if (phase === "sync" && text(syncToken) && pageToken === undefined && keys.length === 2)
    return { phase, syncToken, ...at };
  if (phase === "sync" && text(syncToken) && text(pageToken) && keys.length === 3)
    return { phase, syncToken, pageToken, ...at };
  return null;
}

function drivePhase(raw: Record<string, unknown>): DrivePhase | null {
  const { phase, start, pageToken, refetch, pending, token } = raw;
  if (!optional(pending, ids)) return null;
  const left = pending as string[] | undefined;
  if (phase === "d_reset" && Object.keys(raw).every((key) => ["v", "connector", "phase"].includes(key)))
    return { phase };
  if (
    phase === "d_list" &&
    text(start) &&
    optional(pageToken, text) &&
    typeof refetch === "boolean" &&
    token === undefined
  ) {
    return {
      phase,
      start,
      ...(pageToken === undefined ? {} : { pageToken: pageToken as string }),
      refetch,
      ...(left === undefined ? {} : { pending: left }),
    };
  }
  if (phase === "d_changes" && text(token) && start === undefined && pageToken === undefined && refetch === undefined) {
    return { phase, token, ...(left === undefined ? {} : { pending: left }) };
  }
  return null;
}

function encode<Phase>(connector: string, phase: Phase | null): ConnectorCursor {
  if (phase === null) throw new GoogleError("bad_cursor");
  return ConnectorCursor.parse(Buffer.from(JSON.stringify({ v: VERSION, connector, ...phase })).toString("base64url"));
}

// A cursor that does not decode, or that holds the other connector's phase, is bad_cursor.
function decode<Phase>(
  connector: string,
  cursor: ConnectorCursor,
  read: (raw: Record<string, unknown>) => Phase | null,
): Phase {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new GoogleError("bad_cursor");
  }
  const phase = isRecord(raw) && raw.v === VERSION && raw.connector === connector ? read(raw) : null;
  if (phase === null) throw new GoogleError("bad_cursor");
  return phase;
}

export const mailCursor = (phase: MailPhase): ConnectorCursor => encode("google_mail", mailPhase(phase));
export const calendarCursor = (phase: CalendarPhase): ConnectorCursor =>
  encode("google_calendar", calendarPhase(phase));
export const readMailCursor = (cursor: ConnectorCursor): MailPhase => decode("google_mail", cursor, mailPhase);
export const readCalendarCursor = (cursor: ConnectorCursor): CalendarPhase =>
  decode("google_calendar", cursor, calendarPhase);
export const contactsCursor = (phase: ContactsPhase): ConnectorCursor =>
  encode("google_contacts", contactsPhase(phase));
export const readContactsCursor = (cursor: ConnectorCursor): ContactsPhase =>
  decode("google_contacts", cursor, contactsPhase);
export const driveCursor = (phase: DrivePhase): ConnectorCursor =>
  encode("google_docs", drivePhase(phase as unknown as Record<string, unknown>));
export const readDriveCursor = (cursor: ConnectorCursor): DrivePhase => decode("google_docs", cursor, drivePhase);
