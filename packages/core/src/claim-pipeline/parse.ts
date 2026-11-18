import {
  type DocumentContent,
  type Mention,
  type ParsedItem,
  type ParsedSegment,
  Timestamp,
} from "@intelligence/contracts";
import PostalMime, { type Address, type Email } from "postal-mime";
import { extractText, getDocumentProxy } from "unpdf";
import { PipelineError } from "./errors.ts";
import { htmlDocumentToText, htmlToText } from "./html.ts";
import type { Limits } from "./limits.ts";
import type { PipelineItem } from "./ports.ts";
import { type Party, splitBody } from "./quotes.ts";
import { fallbackTitle, readSections } from "./sections.ts";

// Turns one item's bytes into text credited to who wrote it. Code only: no model, no network.
// The bytes are untrusted, so the parser takes only what is inside its limits, and every
// failure ends as one bare code.

// What the document lane holds of one reference document, beside its parsed text: the item,
// whose `reference` is what its source says about it, and what its content says of itself.
interface DocumentReading {
  item: PipelineItem;
  title: string;
  content: DocumentContent;
}

// The texts a span counts over, by the prefix its span carries: the plain-text body under
// "", the subject under "subject:", each read attachment under "attachment:<n>:". Exactly
// the strings the segments' offsets index, so a span cut from these is the cited text.
type SpanTexts = Record<string, string>;

// A parsed item, and how many attachments were left out because they could not be read. An
// email keeps its plain text body, which the interaction record's hash is taken over. A
// reference document keeps its reading.
// Beside the contract's fields: the parties of an email's headers with the names they were
// written with, which the checker sends as a subject's name alias.
export type Parsed = ParsedItem & {
  unreadAttachments: number;
  texts: SpanTexts;
  body?: string;
  document?: DocumentReading;
  parties?: Party[];
};

type Read = Pick<
  Parsed,
  "automated" | "segments" | "headers" | "unreadAttachments" | "texts" | "body" | "document" | "parties"
>;

const refuse = (): never => {
  throw new PipelineError("parse_failed");
};

// pdf.js takes over the buffer it is given, so it gets a copy. Verbosity 0 keeps it from
// printing warnings about the file, which could quote it.
async function pdfToText(bytes: Uint8Array, limits: Limits): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(bytes.slice(), { verbosity: 0 }), { mergePages: true });
  return text.length > limits.bodyChars ? refuse() : text;
}

// One segment over a whole text. A prefix names a text that is not the body.
const whole = (text: string, prefix = ""): ParsedSegment[] =>
  text.trim() === "" ? [] : [{ span: `${prefix}chars:0-${text.length}`, quoted: false, text }];

function mailboxes(value: Address | Address[] | undefined): Party[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list
    .flatMap((one) => one.group ?? [one])
    .filter((one) => one.address.includes("@"))
    .map((one) => ({ name: one.name.trim(), address: one.address.trim().toLowerCase() }));
}

// Message-IDs are short tokens in angle brackets. Read with no pattern that can backtrack.
function messageIds(value: string | undefined): string[] {
  const ids: string[] = [];
  for (const part of (value ?? "").split("<").slice(1)) {
    const close = part.indexOf(">");
    const id = close < 0 ? "" : part.slice(0, close);
    if (id !== "" && !/\s/.test(id)) ids.push(`<${id}>`);
  }
  return ids;
}

// Mailbox names follow RFC 2142 and common practice; a room is a calendar resource and is flagged
// when calendars are read.
const NOT_A_PERSON = new Set([
  "mailer-daemon",
  "postmaster",
  "hostmaster",
  "webmaster",
  "bounce",
  "bounces",
  "abuse",
  "noc",
  "security",
  "info",
  "marketing",
  "sales",
  "support",
  "hello",
  "contact",
  "team",
  "admin",
  "billing",
  "help",
  "office",
  "notification",
  "notifications",
  "newsletter",
  "news",
]);
const NO_REPLY = ["noreply", "donotreply"];

function isAutomated(mail: Email, sender: string): boolean {
  const header = (key: string): string | undefined =>
    mail.headers
      .find((one) => one.key === key)
      ?.value.trim()
      .toLowerCase();
  // The mailbox name up to any "+tag" or ".suffix", and again with its separators removed.
  const local = sender.split("@")[0] ?? "";
  const name = local.split(/[+.]/)[0] ?? "";
  const joined = local.replaceAll(/[-_.]/g, "");
  return (
    NOT_A_PERSON.has(name) ||
    NO_REPLY.some((word) => joined.startsWith(word)) ||
    ["bulk", "list", "junk"].includes(header("precedence") ?? "") ||
    header("list-id") !== undefined ||
    header("list-unsubscribe") !== undefined ||
    (header("auto-submitted") ?? "no") !== "no"
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// The zones a date can name: UTC by its own names, and the eight RFC 5322 gives an offset.
const ZONES = new Map([
  ["ut", "Z"],
  ["utc", "Z"],
  ["gmt", "Z"],
  ["z", "Z"],
  ["est", "-05:00"],
  ["edt", "-04:00"],
  ["cst", "-06:00"],
  ["cdt", "-05:00"],
  ["mst", "-07:00"],
  ["mdt", "-06:00"],
  ["pst", "-08:00"],
  ["pdt", "-07:00"],
]);
// The date RFC 5322 writes, lower-cased and with one space between its parts: an optional day
// of the week, the day, the month, a year of four digits, the time, and a zone or none.
// Anchored, and each part can match one way only.
const DATE =
  /^(?:[a-z]{3} ?, ?)?(\d{1,2}) ([a-z]{3}) (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ([+-]\d{2})(\d{2})| ([a-z]{1,5}))?$/;

// The sender writes the header, so it is read by this grammar alone and never by `Date.parse`,
// which takes forms no mail has and reads a date with no zone in the host's own. A date with no
// zone is UTC. One that is not such a date, that names a zone with no known offset, or that falls
// outside what a Timestamp holds, is read as no date: a wrong time is worse than none.
function sentAt(mail: Email): Timestamp[] {
  const value = mail.headers.find((one) => one.key === "date")?.value ?? "";
  // A comment after the date says nothing, and neither does how its parts are spaced.
  const fields = DATE.exec((value.split("(")[0] ?? "").toLowerCase().replaceAll(/\s+/g, " ").trim());
  if (fields === null) return [];
  const [, day = "", month = "", year, hour = "", minute, second = "00", offsetHours, offsetMinutes, name] = fields;
  const zone =
    offsetHours !== undefined ? `${offsetHours}:${offsetMinutes}` : name === undefined ? "Z" : ZONES.get(name);
  if (zone === undefined) return [];
  const two = (digits: string): string => digits.padStart(2, "0");
  // The contract refuses a day no calendar has, an hour past 23 and a year below 100.
  const written = Timestamp.safeParse(
    `${year}-${two(String(MONTHS.indexOf(month) + 1))}-${two(day)}T${two(hour)}:${minute}:${second}${zone}`,
  );
  if (!written.success) return [];
  // In UTC the time can fall in another year, so what is given is checked as well.
  const utc = Timestamp.safeParse(new Date(written.data).toISOString());
  return utc.success ? [utc.data] : [];
}

async function readEmail(item: PipelineItem, payload: Uint8Array, limits: Limits): Promise<Read> {
  const mail = await PostalMime.parse(payload);
  const [from] = mailboxes(mail.from);
  if (from === undefined) return refuse();
  const sender: Mention = { key: { kind: "address", value: from.address }, observedAt: item.observedAt };
  const [to, cc, bcc] = [mailboxes(mail.to), mailboxes(mail.cc), mailboxes(mail.bcc)];

  const subject = mail.subject ?? "";
  if (subject.length > limits.lineChars) refuse();
  // The plain text part when the message has one, otherwise its HTML as text.
  const plain = mail.text !== undefined && mail.text.trim() !== "" ? mail.text : htmlToText(mail.html ?? "", limits);
  const body = plain.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  const segments = [
    ...whole(subject, "subject:").map((segment) => ({ ...segment, author: sender })),
    ...splitBody(body, sender, { parties: [from, ...to, ...cc], observedAt: item.observedAt }, limits),
  ];
  const texts: SpanTexts = { "": body, "subject:": subject };

  // Only PDFs are opened. One that cannot be read (encrypted, cut short) is left out and
  // counted; one over a limit refuses the item like any other limit.
  if (mail.attachments.length > limits.attachments) refuse();
  let unreadAttachments = 0;
  for (const [index, attachment] of mail.attachments.entries()) {
    if (attachment.mimeType !== "application/pdf") continue;
    const bytes = typeof attachment.content === "string" ? undefined : new Uint8Array(attachment.content);
    if (bytes !== undefined && bytes.byteLength > limits.attachmentBytes) refuse();
    let text: string | undefined;
    try {
      text = bytes === undefined ? undefined : await pdfToText(bytes, limits);
    } catch (error) {
      if (error instanceof PipelineError) throw error;
    }
    if (text === undefined) unreadAttachments += 1;
    else {
      segments.push(...whole(text, `attachment:${index}:`));
      texts[`attachment:${index}:`] = text;
    }
  }

  const headers: Record<string, string[]> = {};
  const put = (key: string, values: string[]): void => {
    if (values.length > 0) headers[key] = values;
  };
  put("from", [from.address]);
  put(
    "to",
    to.map((one) => one.address),
  );
  put(
    "cc",
    cc.map((one) => one.address),
  );
  put(
    "bcc",
    bcc.map((one) => one.address),
  );
  put("date", sentAt(mail));
  put("message-id", messageIds(mail.messageId));
  put("in-reply-to", messageIds(mail.inReplyTo));
  put("references", messageIds(mail.references));

  return {
    automated: isAutomated(mail, from.address),
    segments,
    headers,
    unreadAttachments,
    texts,
    body,
    parties: [from, ...to, ...cc, ...bcc],
  };
}

// Its title, sections and a template's placeholders are read from the content. Its text has no
// author: the content names none, a `<meta>` is not looked at, and nobody is credited with what a
// document says.
async function readDocument(item: PipelineItem, payload: Uint8Array, limits: Limits): Promise<Read> {
  let title = "";
  let text: string;
  if (item.mediaType === "text/html") ({ title, text } = htmlDocumentToText(new TextDecoder().decode(payload), limits));
  else if (item.mediaType === "application/pdf") text = await pdfToText(payload, limits);
  else return refuse();
  const read = readSections(text, item.referenceKind === "template");
  const named = title !== "" ? title : fallbackTitle(read.content);
  if (named === undefined) return refuse();
  return {
    automated: false,
    segments: read.segments,
    headers: {},
    unreadAttachments: 0,
    texts: { "": read.text },
    document: { item, title: named, content: read.content },
  };
}

// Whether the payload has more line ends than the limit. It stops counting once it knows.
function tooManyLines(payload: Uint8Array, limit: number): boolean {
  let lines = 0;
  for (let at = payload.indexOf(10); at >= 0; at = payload.indexOf(10, at + 1)) {
    lines += 1;
    if (lines > limit) return true;
  }
  return false;
}

type Reader = (item: PipelineItem, payload: Uint8Array, limits: Limits) => Promise<Read>;

// The media types a connector reports. The parser reads the type and never guesses.
const READERS: Record<string, Reader> = {
  "message/rfc822": readEmail,
  "text/html": async (_item, payload, limits) => plain(htmlToText(new TextDecoder().decode(payload), limits)),
  "application/pdf": async (_item, payload, limits) => plain(await pdfToText(payload, limits)),
};

// One text with no author and no headers: the whole of it is the body.
const plain = (text: string): Read => ({
  automated: false,
  segments: whole(text),
  headers: {},
  unreadAttachments: 0,
  texts: { "": text },
});

// The reply chain is filled in by processItem, which alone can look an earlier message up. An
// item from a source confirmed as reference is read as a document.
export async function parse(item: PipelineItem, payload: Uint8Array, limits: Limits): Promise<Parsed> {
  try {
    const reader =
      item.referenceKind !== undefined
        ? readDocument
        : Object.hasOwn(READERS, item.mediaType)
          ? READERS[item.mediaType]
          : undefined;
    if (reader === undefined || payload.byteLength > limits.payloadBytes || tooManyLines(payload, limits.payloadLines))
      return refuse();
    const read = await reader(item, payload, limits);
    if (read.segments.length > limits.segments) return refuse();
    return {
      evidenceId: item.id,
      revision: item.revision,
      sourceKind: item.sourceKind,
      replyChainEvidenceIds: [],
      ...read,
    };
  } catch {
    // A parser's own error can quote the bytes it stopped on, so it is dropped.
    throw new PipelineError("parse_failed");
  }
}

// Anchored, and each part can match one way only, so it reads a span in one pass.
const SPAN = /^((?:subject:|attachment:\d{1,4}:)?)chars:(\d{1,9})-(\d{1,9})$/;

// Finds the segment a span falls wholly inside. A span is "chars:<start>-<end>", end excluded,
// over the message's plain text body; "subject:" or "attachment:<n>:" before it names another text.
export function segmentFinder(parsed: ParsedItem): (span: string) => ParsedSegment | undefined {
  const ranges = parsed.segments.flatMap((segment) => {
    const own = SPAN.exec(segment.span);
    return own === null ? [] : [{ segment, prefix: own[1], start: Number(own[2]), end: Number(own[3]) }];
  });
  return (span) => {
    const asked = SPAN.exec(span);
    if (asked === null || Number(asked[2]) >= Number(asked[3])) return undefined;
    return ranges.find(
      (range) => range.prefix === asked[1] && range.start <= Number(asked[2]) && Number(asked[3]) <= range.end,
    )?.segment;
  };
}

export const segmentAt = (parsed: ParsedItem, span: string): ParsedSegment | undefined => segmentFinder(parsed)(span);
