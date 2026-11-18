import type { Timestamp } from "@intelligence/contracts";
import { DAY_MS } from "@intelligence/personal-core";
import type { Attachment, GmailMessage } from "@intelligence/personal-core/items";
import { bad, record, text } from "./http.ts";

// One messages.get answer read into a GmailMessage, checked field by field. Code only: nothing here
// makes a call, and nothing a header or a text says is followed.

export const HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Date",
  "Subject",
  "Message-ID",
  "In-Reply-To",
  "References",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "Authentication-Results",
];
const LISTED = new Set(HEADERS.map((name) => name.toLowerCase()));
const MAX_LEVELS = 32;
const MAX_PARTS = 1000;
const MAX_NAME = 255;
const MAX_TYPE = 127;
// The last millisecond of the year 9999: the latest time RawItem accepts.
const MAX_DATE_MS = 253_402_300_799_999;
// The first millisecond of 1971: a Date header must be later to stand in for internalDate, and
// no later than a day after the page's clock, since its sender wrote it.
const MIN_HEADER_DATE_MS = 31_536_000_000;
// An RFC 2822 date: an optional day name, the day, the month's name, the year, the time and the
// zone, with an optional comment after it.
const RFC_2822_DATE =
  /^\s*(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4,}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|[A-Za-z]{1,5})\s*(?:\(.*\))?\s*$/;

// Anything else that is not a list is a bad shape.
export function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad();
  return value;
}

// A list of label ids. An absent one is empty.
export function labelsOf(value: unknown): string[] {
  return list(value).map((label) => {
    if (typeof label !== "string") throw bad();
    return label;
  });
}

type Header = { name: string; value: string };

const headersOf = (value: unknown): Header[] =>
  list(value).map((header) => {
    const { name, value: said } = record(header);
    if (typeof name !== "string" || typeof said !== "string") throw bad();
    return { name, value: said };
  });

function headerDate(headers: Header[], latest: number): number | undefined {
  const said = headers.find((header) => header.name.toLowerCase() === "date")?.value;
  if (said === undefined || !RFC_2822_DATE.test(said)) return undefined;
  const at = Date.parse(said);
  return at > MIN_HEADER_DATE_MS && at <= Math.min(latest, MAX_DATE_MS) ? at : undefined;
}

// What every answer holds, whatever its format: the ids, the date, the labels and the listed
// headers, in Google's order and spelling. An absent payload is one with nothing in it.
function envelope(
  body: unknown,
  id: string,
  now: Timestamp,
): { message: GmailMessage; payload: Record<string, unknown> | undefined } {
  const { id: answered, threadId, internalDate, labelIds, payload } = record(body);
  if (answered !== id || !text(threadId)) throw bad();
  if (typeof internalDate !== "string" || !/^\d+$/.test(internalDate) || Number(internalDate) > MAX_DATE_MS)
    throw bad();
  const labels = labelsOf(labelIds);
  const root = payload === undefined ? undefined : record(payload);
  const headers = headersOf(root?.headers).filter((header) => LISTED.has(header.name.toLowerCase()));
  // An internalDate of 0, the epoch, is no time of receipt: the Date header stands in for it
  // when it is an RFC 2822 date after the start of 1971 and no more than a day after the page's
  // clock. With neither, the shape is refused.
  const at = Number(internalDate) === 0 ? headerDate(headers, Date.parse(now) + DAY_MS) : Number(internalDate);
  if (at === undefined) throw bad();
  return { message: { id, threadId, internalDate: at, labelIds: labels, headers }, payload: root };
}

// A filename Google leaves out is the empty one: Google writes it only on an attachment.
type Part = {
  mimeType: string;
  filename: string;
  size: number;
  data?: string;
  attachmentId?: string;
  headers: Header[];
  parts: unknown[];
};

function partOf(value: unknown): Part {
  const part = record(value);
  const { mimeType, filename = "", body = {} } = part;
  if (typeof mimeType !== "string" || typeof filename !== "string") throw bad();
  const { size = 0, data, attachmentId } = record(body);
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw bad();
  if (data !== undefined && typeof data !== "string") throw bad();
  if (attachmentId !== undefined && typeof attachmentId !== "string") throw bad();
  return {
    mimeType,
    filename,
    size,
    ...(data === undefined ? {} : { data }),
    ...(attachmentId === undefined ? {} : { attachmentId }),
    headers: headersOf(part.headers),
    parts: list(part.parts),
  };
}

type Leaf = { kind: "plain" | "html"; part: Part } | { kind: "apart" } | { kind: "attachment"; attachment: Attachment };

const cut = (value: string, most: number): string => [...value].slice(0, most).join("");

// A part with a file name is an attachment and nothing under it is read.
function leavesOf(root: unknown): Leaf[] | "too_big" {
  const leaves: Leaf[] = [];
  let parts = 0;
  const walk = (value: unknown, level: number): boolean => {
    parts += 1;
    if (level > MAX_LEVELS || parts > MAX_PARTS) return false;
    const part = partOf(value);
    const attachment = (name: string): Leaf => ({
      kind: "attachment",
      attachment: { name: cut(name, MAX_NAME), type: cut(part.mimeType, MAX_TYPE), size: part.size },
    });
    if (part.filename !== "") leaves.push(attachment(part.filename));
    else if (part.parts.length > 0) return part.parts.every((child) => walk(child, level + 1));
    else {
      const type = part.mimeType.toLowerCase();
      const kind = type === "text/plain" ? "plain" : type === "text/html" ? "html" : null;
      // A text leaf whose text Gmail holds apart: never fetched, and not an attachment.
      if (kind !== null && part.data === undefined && part.attachmentId !== undefined) leaves.push({ kind: "apart" });
      else leaves.push(kind === null ? attachment("") : { kind, part });
    }
    return true;
  };
  return walk(root, 1) ? leaves : "too_big";
}

// The charset a part's own Content-Type names, if any.
function charsetOf(headers: Header[]): string | undefined {
  const type = headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
  const named = type === undefined ? null : /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(type);
  return named?.[1];
}

function decoded(part: Part): string {
  const bytes = Buffer.from(part.data ?? "", "base64url");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: tried by its charset below.
  }
  const charset = charsetOf(part.headers);
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // A charset TextDecoder does not know.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

const joined = (leaves: Leaf[], kind: "plain" | "html"): string | undefined => {
  const value = leaves.flatMap((leaf) => (leaf.kind === kind ? [decoded(leaf.part)] : [])).join("\n");
  return value === "" ? undefined : value;
};

// A tree over either bound, or text Gmail holds apart, makes the message one read by its headers:
// no text, no html, and unreadable.
export function fullMessage(body: unknown, id: string, now: Timestamp): GmailMessage {
  const { message, payload } = envelope(body, id, now);
  const leaves = payload === undefined ? [] : leavesOf(payload);
  if (leaves === "too_big") return { ...message, unreadable: true };
  const attachments = leaves.flatMap((leaf) => (leaf.kind === "attachment" ? [leaf.attachment] : []));
  const files = attachments.length === 0 ? {} : { attachments };
  if (leaves.some((leaf) => leaf.kind === "apart")) return { ...message, ...files, unreadable: true };
  // The first text leaf decides: a plain part after the HTML is a footer, not the text.
  const first = leaves.find((leaf) => leaf.kind === "plain" || leaf.kind === "html");
  const plain = first?.kind === "plain" ? joined(leaves, "plain") : undefined;
  const html = joined(leaves, "html");
  return {
    ...message,
    ...(plain === undefined ? {} : { text: plain }),
    ...(html === undefined ? {} : { html }),
    ...files,
  };
}

export function headersMessage(body: unknown, id: string, now: Timestamp): GmailMessage {
  return { ...envelope(body, id, now).message, unreadable: true };
}
