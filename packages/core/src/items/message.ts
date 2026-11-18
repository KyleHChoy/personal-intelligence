import PostalMime from "postal-mime";
import { PipelineError } from "../claim-pipeline/errors.ts";
import type { Attachment } from "./types.ts";

// The message block read back: the lines `messageBlock` writes above a message's own headers' end,
// and the headers alone. A sender cannot write one of these lines: the builder leaves out every
// header named as one of its own.

export const UNREADABLE_HEADER = "X-Pi-Unreadable";
export const ATTACHMENT_HEADER = "X-Pi-Attachment";

const refuse = (): never => {
  throw new PipelineError("parse_failed");
};

// The builder ends every line with CRLF, so an empty line is a CRLF at the payload's start or right
// after another.
export function headersOnly(payload: Uint8Array): Uint8Array {
  if (payload[0] === 13 && payload[1] === 10) return payload.slice(0, 2);
  const end = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).indexOf("\r\n\r\n");
  return end < 0 ? payload.slice() : payload.slice(0, end + 4);
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// One attachment line's value: the base64url of {"i":…,"name":…,"type":…,"size":…}, keys in
// that order and no other. Anything else is not a line the builder wrote.
function attachmentLine(value: string): { i: number; attachment: Attachment } {
  const encoded = value.trim();
  const json = Buffer.from(encoded, "base64url");
  if (encoded === "" || json.toString("base64url") !== encoded) return refuse();
  const read: unknown = JSON.parse(json.toString("utf8"));
  if (typeof read !== "object" || read === null || Object.keys(read).join() !== "i,name,type,size") return refuse();
  const { i, name, type, size } = read as Record<string, unknown>;
  if (!isCount(i) || typeof name !== "string" || typeof type !== "string" || !isCount(size)) return refuse();
  return { i, attachment: { name, type, size } };
}

// What the builder's own lines say of a message: whether it is marked unreadable, and its
// attachment facts, sorted by their index. Given the headers alone, no body is parsed.
export async function blockMarks(payload: Uint8Array): Promise<{ unreadable: boolean; attachments: Attachment[] }> {
  try {
    const { headers } = await PostalMime.parse(payload);
    const named = (name: string): string[] =>
      headers.filter((header) => header.key === name.toLowerCase()).map((header) => header.value);
    const lines = named(ATTACHMENT_HEADER).map(attachmentLine);
    return {
      unreadable: named(UNREADABLE_HEADER).length > 0,
      attachments: lines.sort((a, b) => a.i - b.i).map((line) => line.attachment),
    };
  } catch {
    // A parser's own error can quote the bytes it stopped on, so it is dropped.
    return refuse();
  }
}

export const attachmentsOf = async (payload: Uint8Array): Promise<Attachment[]> =>
  (await blockMarks(payload)).attachments;
