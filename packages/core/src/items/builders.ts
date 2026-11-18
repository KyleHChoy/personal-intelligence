import {
  type ChangeKind,
  type RawItem,
  type SourceAccountId,
  type SourceDeletion,
  Timestamp,
} from "@intelligence/contracts";
import { addressParser } from "postal-mime";
import { normalizeAddress } from "../addresses.ts";
import { gmailItemId } from "../item-id.ts";
import { among, fields, isBoolean, isString, optional, refuse, required, unique, whitelisted } from "../values.ts";
import { derivingLabels } from "./bulk.ts";
import { ATTACHMENT_HEADER, UNREADABLE_HEADER } from "./message.ts";
import type { CalendarEvent, CalendarPerson, CalendarTime, GmailMessage } from "./types.ts";

// The RawItem builders the Google connector and the fakes share, so a fake item is byte for
// byte what the connector hands over. Code only: no network, and nothing here follows what a
// header or an event says.

type Header = { name: string; value: string };

// RawItem takes at most this many addressees.
const MAX_ADDRESSEES = 1000;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

// A header name is one or more printable ASCII characters other than a colon: "!" to "~",
// without ":". Read one character at a time, with no pattern.
function isFieldName(name: string): boolean {
  for (let at = 0; at < name.length; at += 1) {
    const code = name.charCodeAt(at);
    if (code < 0x21 || code > 0x7e || code === 0x3a) return false;
  }
  return name.length > 0;
}

// The names of the lines that say how a message block is read, in lower case: MIME-Version,
// every Content-* header and the builder's X-Pi- lines. Only the builder writes them, so a
// sender's, in any case, is left out.
const isOwnName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return lower === "mime-version" || lower.startsWith("content-") || lower.startsWith("x-pi-");
};

// The headers a block is written from. A name is other people's data too: one that holds a
// line break, a space or a colon would add, fold or rename a header, and one named as the
// builder's own would be read as the builder's, so its header is left out.
const written = (headers: Header[]): Header[] =>
  headers.filter((header) => isFieldName(header.name) && !isOwnName(header.name));

// A CR or LF inside a value becomes a space, so a value cannot start a header of its own.
const headerLines = (headers: Header[]): string =>
  written(headers)
    .map((header) => `${header.name}: ${header.value.replaceAll(/[\r\n]/g, " ")}\r\n`)
    .join("");

// The header lines and one closing CRLF, as UTF-8.
export function headerBlock(headers: Header[]): Uint8Array {
  return new TextEncoder().encode(`${headerLines(headers)}\r\n`);
}

const BOUNDARY = "=_pi_part";

// One text as a part: its two headers, the empty line, and the base64 of its UTF-8 in lines of
// 76 characters, each ended by CRLF. A base64 line holds no "-", so no text can end a part.
const part = (type: "plain" | "html", text: string): string =>
  `Content-Type: text/${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll(/.{1,76}/g, "$&\r\n")}`;

// A message marked unreadable has its text and HTML left out.
export function messageBlock(message: GmailMessage): Uint8Array {
  const attachments = (message.attachments ?? []).map(
    ({ name, type, size }, i) =>
      `${ATTACHMENT_HEADER}: ${Buffer.from(JSON.stringify({ i, name, type, size })).toString("base64url")}\r\n`,
  );
  const own = `${message.unreadable === true ? `${UNREADABLE_HEADER}: 1\r\n` : ""}${attachments.join("")}MIME-Version: 1.0\r\n`;
  const { text, html } = message.unreadable === true ? { text: undefined, html: undefined } : message;
  const parts = [
    ...(text === undefined ? [] : [part("plain", text)]),
    ...(html === undefined ? [] : [part("html", html)]),
  ];
  const body =
    parts.length === 2
      ? `Content-Type: multipart/alternative; boundary="${BOUNDARY}"\r\n\r\n${parts.map((one) => `--${BOUNDARY}\r\n${one}`).join("")}--${BOUNDARY}--\r\n`
      : (parts[0] ?? "\r\n");
  return new TextEncoder().encode(`${headerLines(message.headers)}${own}${body}`);
}

// The link that opens a message's conversation in Gmail, from Gmail's own thread id alone, so
// it carries nothing a sender chose. The form is not documented by Google.
export const gmailLink = (threadId: string | undefined): string | null =>
  threadId !== undefined && /^[0-9a-f]{1,32}$/.test(threadId)
    ? `https://mail.google.com/mail/u/0/#all/${threadId}`
    : null;

// The mailboxes of one address header, groups expanded, in source order.
const mailboxes = (value: string): { address: string }[] => addressParser(value).flatMap((one) => one.group ?? [one]);

// Those of them whose address normalizes.
const addressesOf = (value: string): string[] => mailboxes(value).flatMap((one) => normalizeAddress(one.address) ?? []);

// Header names are matched in any case, as Gmail keeps the sender's spelling. A header the block
// leaves out is read for nothing here, and nothing in the text, the HTML or the attachments changes
// any field but the payload.
export function gmailItem(
  message: GmailMessage,
  at: { sourceAccount: SourceAccountId; changeKind: ChangeKind },
): RawItem {
  const headers = written(message.headers);
  const named = (...names: string[]): Header[] => headers.filter((header) => names.includes(header.name.toLowerCase()));
  // The first address of the first From, when it normalizes, and never a later one: the shared
  // parse reads the first mailbox as the sender, and the two must not name different people.
  const [from] = named("from");
  const [first] = from === undefined ? [] : mailboxes(from.value);
  const sender = first === undefined ? null : normalizeAddress(first.address);
  const addressees = unique(named("to", "cc", "bcc").flatMap((header) => addressesOf(header.value)));
  return {
    sourceKind: "email",
    sourceAccount: at.sourceAccount,
    // Gmail's own id, never the Message-ID header. The header is the sender's claim: a message
    // that reused a genuine one's would become that item's next revision and replace it.
    sourceItemId: gmailItemId(message.id),
    // Gmail never edits a message's headers, but its labels change, and what is derived from it
    // changes with some of them: those are in the tag, so a change of one is the next revision.
    // The "f" says full content.
    revisionTag: `f:${message.id}:${derivingLabels(message.labelIds).join(",")}`,
    threadId: message.threadId,
    observedAt: new Date(message.internalDate).toISOString(),
    depth: "full",
    changeKind: at.changeKind,
    payload: base64(messageBlock(message)),
    mediaType: "message/rfc822",
    permissions: {
      scope: "listed",
      identifiers: unique(named("from", "to", "cc", "bcc").flatMap((header) => addressesOf(header.value))),
    },
    ...(sender === null ? {} : { sender }),
    addressees: addressees.slice(0, MAX_ADDRESSEES),
    markers: [...message.labelIds],
  };
}

// An event Google deleted: cancelled, and nothing left of it but its id.
export const isBareCancellation = (event: CalendarEvent): boolean =>
  event.status === "cancelled" && event.start === undefined;

// The calendar whitelist, read in this one place: by the connector from Google's answer, by
// `calendarItem` to write a payload, and by `eventOf` from a stored one. Each field is checked as
// it is read. A key the event does not have is left out, a key outside the whitelist is never read,
// and the keys come out in the whitelist's order.

const STATUSES = ["confirmed", "tentative", "cancelled"] as const;
const RESPONSES = ["needsAction", "declined", "tentative", "accepted"] as const;

function time(value: unknown): CalendarTime {
  const raw = fields(value);
  const [dateTime, date] = [optional(raw.dateTime, isString), optional(raw.date, isString)];
  return { ...(dateTime === undefined ? {} : { dateTime }), ...(date === undefined ? {} : { date }) };
}

// One organizer or attendee, or null for one that is dropped. Every field is checked before
// the email decides that.
function person(value: unknown, noEmail: "refused" | "dropped"): CalendarPerson | null {
  const raw = fields(value);
  const [email, displayName] = [optional(raw.email, isString), optional(raw.displayName, isString)];
  const responseStatus = optional(raw.responseStatus, among(RESPONSES));
  const [self, resource, organizer] = [
    optional(raw.self, isBoolean),
    optional(raw.resource, isBoolean),
    optional(raw.organizer, isBoolean),
  ];
  if (email === undefined && noEmail === "refused") refuse();
  if (email === undefined || (email === "" && noEmail === "dropped")) return null;
  return {
    email,
    ...(displayName === undefined ? {} : { displayName }),
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(self === undefined ? {} : { self }),
    ...(resource === undefined ? {} : { resource }),
    ...(organizer === undefined ? {} : { organizer }),
  };
}

// No host is checked here: the owner's page links only the hosts it allows (pi-web-client
// `safe-link.ts`) and shows any other as text.
const LINK_MOST = 2048;
function httpsLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const link = value.trim();
  if (link.length === 0 || link.length > LINK_MOST) return undefined;
  try {
    return new URL(link).protocol === "https:" ? link : undefined;
  } catch {
    return undefined;
  }
}

// The first https URL written in a location, its trailing punctuation left off. The rest of the
// location is never kept.
function linkInLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const found = value.match(/https:\/\/[^\s<>"'`]+/);
  return found === null ? undefined : httpsLink(found[0].replace(/[.,;:!?)\]}]+$/, ""));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The event's call link: a video entry point of its conference data, else Google's hangoutLink, else
// an https URL in its location; or the one a stored payload already kept. A field of the wrong shape
// gives none and never refuses the event.
function callLinkOf(raw: Record<string, unknown>): string | undefined {
  const kept = httpsLink(raw.callLink);
  if (kept !== undefined) return kept;
  const points = isObject(raw.conferenceData) ? raw.conferenceData.entryPoints : undefined;
  for (const point of Array.isArray(points) ? points : []) {
    const link = isObject(point) && point.entryPointType === "video" ? httpsLink(point.uri) : undefined;
    if (link !== undefined) return link;
  }
  return httpsLink(raw.hangoutLink) ?? linkInLocation(raw.location);
}

// The event's own calendar link: Google's htmlLink, or the one a stored payload already kept.
const inviteLinkOf = (raw: Record<string, unknown>): string | undefined =>
  httpsLink(raw.inviteLink) ?? httpsLink(raw.htmlLink);

// The event a value holds, or null when a field of the whitelist has the wrong type. `noEmail` says
// what becomes of a person with no email: the event is refused, or, as the connector reads Google's
// answer, that person is dropped, one with an empty email included.
export function whitelistedEvent(value: unknown, noEmail: "refused" | "dropped" = "refused"): CalendarEvent | null {
  return whitelisted(() => {
    const raw = fields(value);
    const [id, status] = [required(raw.id, isString), required(raw.status, among(STATUSES))];
    const [etag, updated, summary] = [
      optional(raw.etag, isString),
      optional(raw.updated, isString),
      optional(raw.summary, isString),
    ];
    const [start, end] = [
      raw.start === undefined ? undefined : time(raw.start),
      raw.end === undefined ? undefined : time(raw.end),
    ];
    const organizer = raw.organizer === undefined ? null : person(raw.organizer, noEmail);
    const attendees = optional(raw.attendees, (list): list is unknown[] => Array.isArray(list));
    const [callLink, inviteLink] = [callLinkOf(raw), inviteLinkOf(raw)];
    return {
      id,
      status,
      ...(etag === undefined ? {} : { etag }),
      ...(updated === undefined ? {} : { updated }),
      ...(summary === undefined ? {} : { summary }),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...(organizer === null ? {} : { organizer }),
      ...(attendees === undefined ? {} : { attendees: attendees.flatMap((one) => person(one, noEmail) ?? []) }),
      ...(callLink === undefined ? {} : { callLink }),
      ...(inviteLink === undefined ? {} : { inviteLink }),
    };
  });
}

// No subject, and so no recovery or restricted screen, which is why no message row and no claim
// ever comes of such an item.
export const TIES_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Date",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;
const TIES_LISTED = new Set<string>(TIES_HEADERS.map((name) => name.toLowerCase()));

// Whatever the message was handed over with, the block holds the listed headers alone: no body, no
// attachment fact. The "h" of its tag makes a later full fetch of the message its next revision.
export function gmailHeadersItem(
  message: GmailMessage,
  at: { sourceAccount: SourceAccountId; changeKind: ChangeKind },
): RawItem {
  const { id, threadId, internalDate, labelIds } = message;
  const headers = message.headers.filter((header) => TIES_LISTED.has(header.name.toLowerCase()));
  const item = gmailItem({ id, threadId, internalDate, labelIds, headers, unreadable: true }, at);
  return { ...item, depth: "headers", revisionTag: `h:${id}:${derivingLabels(labelIds).join(",")}` };
}

// An item of the ties backfill: mail read by its headers alone. It derives people and interaction
// rows, and no message row, so nothing that reads messages or extracts from them ever sees it.
export const isHeadersMail = (raw: Pick<RawItem, "sourceKind" | "depth">): boolean =>
  raw.sourceKind === "email" && raw.depth === "headers";

export function calendarItem(
  event: CalendarEvent,
  at: { sourceAccount: SourceAccountId; changeKind: ChangeKind; now: Timestamp },
): RawItem | SourceDeletion {
  if (isBareCancellation(event)) return { sourceAccount: at.sourceAccount, sourceItemId: event.id, deletedAt: at.now };
  // Only a value that is no CalendarEvent is refused, which the parameter's type rules out.
  const whitelisted = whitelistedEvent(event);
  if (whitelisted === null) throw new TypeError("not a calendar event");
  const sender = event.organizer === undefined ? null : normalizeAddress(event.organizer.email);
  const attendees = unique((event.attendees ?? []).flatMap((one) => normalizeAddress(one.email) ?? []));
  return {
    sourceKind: "calendar",
    sourceAccount: at.sourceAccount,
    sourceItemId: event.id,
    revisionTag: event.etag || event.updated || "none",
    observedAt: event.updated !== undefined && Timestamp.safeParse(event.updated).success ? event.updated : at.now,
    depth: "headers",
    changeKind: at.changeKind,
    payload: base64(new TextEncoder().encode(JSON.stringify(whitelisted))),
    mediaType: "application/json",
    permissions: { scope: "listed", identifiers: unique([...(sender === null ? [] : [sender]), ...attendees]) },
    ...(sender === null ? {} : { sender }),
    addressees: attendees.slice(0, MAX_ADDRESSEES),
    markers: event.status === "cancelled" ? ["calendar", "cancelled"] : ["calendar"],
  };
}
