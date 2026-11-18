// How the mail check reads a message's part tree: its leaves, their sizes and data, their
// headers and charsets, and whether a text part's bytes read as UTF-8.

import { isRecord, listOf } from "./check-google-kit.ts";

type Part = { mimeType: string; filename: string; headers: unknown[]; body: Record<string, unknown> };
export function partsOf(payload: unknown): Part[] {
  if (!isRecord(payload)) return [];
  const part: Part = {
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType.toLowerCase() : "",
    filename: typeof payload.filename === "string" ? payload.filename : "",
    headers: listOf(payload.headers),
    body: isRecord(payload.body) ? payload.body : {},
  };
  const children = listOf(payload.parts);
  if (part.filename !== "" || children.length === 0) return [part];
  return children.flatMap(partsOf);
}

export const isText = (part: Part): boolean =>
  part.filename === "" && (part.mimeType === "text/plain" || part.mimeType === "text/html");
export const hasData = (part: Part): boolean => typeof part.body.data === "string" && part.body.data !== "";
export const hasAttachmentId = (part: Part): boolean =>
  typeof part.body.attachmentId === "string" && part.body.attachmentId !== "";
export const sizeOf = (part: Part): number => (typeof part.body.size === "number" ? part.body.size : 0);

// A header's values by name, compared case-insensitively.
export function headerValues(headers: unknown[], name: string): string[] {
  return headers.flatMap((header) =>
    isRecord(header) &&
    typeof header.name === "string" &&
    header.name.toLowerCase() === name.toLowerCase() &&
    typeof header.value === "string"
      ? [header.value]
      : [],
  );
}

// The charset a part's own Content-Type names, lower case, or "" when it names none.
export function charsetOf(part: Part): string {
  const type = headerValues(part.headers, "Content-Type")[0] ?? "";
  return /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]?.toLowerCase() ?? "";
}

const ESCAPE = 0x1b;
const bytesOf = (part: Part): Buffer => Buffer.from(String(part.body.data), "base64url");
// Whether a text part holds anything a charset changes: a byte above 0x7F, or the escape a
// 7-bit charset such as ISO-2022-JP is written in. A part of plain ASCII reads the same in any.
export const beyondAscii = (part: Part): boolean => bytesOf(part).some((byte) => byte > 0x7f || byte === ESCAPE);

// Whether a text part's bytes read as UTF-8, with none of the escapes a 7-bit charset such as
// ISO-2022-JP is written in.
export function readsAsUtf8(part: Part): boolean {
  const bytes = bytesOf(part);
  if (bytes.includes(ESCAPE)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
