import { SendPayload, sendAddress } from "@intelligence/contracts/personal";

// The message's bytes for a payload and its sender. Pure: the same payload and sender give the same
// bytes. Every value is parsed before it is written, so nothing in a payload can add a header line
// or a recipient.

const CRLF = "\r\n";
// A line is folded where a fold is possible before it passes this.
const FOLD_AT = 78;
// The most UTF-8 bytes in one encoded word: 52 base64 characters, so a word is 64 characters and
// "Subject: " with the first word is 73, inside RFC 2047's 75 and 76.
const WORD_BYTES = 39;
const BODY_LINE = 76;

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");
const word = (text: string): string => `=?UTF-8?B?${utf8(text).toString("base64")}?=`;

// A subject that is not ASCII, or that holds what a reader would decode as an encoded word, is
// written as encoded words, each split between code points and never inside one.
function subjectOf(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject) && !subject.includes("=?")) return subject;
  const words: string[] = [];
  let held = "";
  for (const point of subject) {
    if (utf8(held + point).byteLength > WORD_BYTES) {
      words.push(word(held));
      held = "";
    }
    held += point;
  }
  words.push(word(held));
  return words.join(`${CRLF} `);
}

// One header of items joined by a separator, folded after the separator so no line passes
// FOLD_AT where a fold is possible. An item is at most 254 characters, so no line passes 998.
function folded(name: string, items: readonly string[], separator: string): string {
  const lines = [`${name}: ${items[0] ?? ""}`];
  for (const item of items.slice(1)) {
    const last = lines.length - 1;
    const line = lines[last] ?? "";
    if (line.length + separator.length + item.length > FOLD_AT) {
      lines[last] = line + separator.trimEnd();
      lines.push(` ${item}`);
    } else lines[last] = line + separator + item;
  }
  return lines.join(CRLF);
}

function bodyOf(body: string): string {
  const encoded = utf8(body.replaceAll("\n", CRLF)).toString("base64");
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += BODY_LINE) lines.push(encoded.slice(at, at + BODY_LINE));
  return lines.join(CRLF);
}

export function renderMessage(payload: SendPayload, from: string): Uint8Array {
  const { to, cc, subject, body, thread } = SendPayload.parse(payload);
  if (sendAddress(from) === null) throw new Error("not a send address");
  const headers = [
    `From: ${from}`,
    folded("To", to, ", "),
    ...(cc.length > 0 ? [folded("Cc", cc, ", ")] : []),
    `Subject: ${subjectOf(subject)}`,
    ...(thread === null
      ? []
      : [
          `In-Reply-To: ${thread.inReplyTo}`,
          ...(thread.references.length > 0 ? [folded("References", thread.references, " ")] : []),
        ]),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  return new TextEncoder().encode(`${headers.join(CRLF)}${CRLF}${CRLF}${bodyOf(body)}${CRLF}`);
}
