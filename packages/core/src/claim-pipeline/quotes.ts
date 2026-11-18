import type { Mention, ParsedSegment, Timestamp } from "@intelligence/contracts";
import { PipelineError } from "./errors.ts";
import { type Limits, MAX_INTRO_CHARS, MAX_PARTIES, MAX_QUOTE_DEPTH } from "./limits.ts";

// Splits a message body so each stretch of text is credited to the person who wrote it: the
// sender for their own words, the original author for text they quote or forward, and nobody
// when that author cannot be told. Code only.
//
// The body is untrusted, so the work is one pass over its lines: every helper here reads a
// character a bounded number of times, and no pattern can backtrack.

// Someone named in the message's own headers, whom a quote may be credited to by name.
export interface Party {
  name: string;
  address: string;
}

export interface SplitContext {
  parties: Party[];
  observedAt: Timestamp;
}

interface Line {
  // The line without its quote markers.
  text: string;
  depth: number;
  blank: boolean;
  // Character offsets in the body, end excluded, markers included.
  start: number;
  end: number;
}

// Characters that end an address on either side.
const STOP = new Set([" ", "\t", "\r", "\n", "<", ">", "(", ")", "[", "]", '"', "'", ",", ";", ":", "@"]);

// Every address in a text, lower-cased. One pass: the text between two @ signs is read at most twice.
export function addressesIn(text: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", from)) {
    let start = at;
    while (start > from && !STOP.has(text[start - 1] as string)) start -= 1;
    let end = at + 1;
    while (end < text.length && !STOP.has(text[end] as string)) end += 1;
    while (end > at + 1 && text[end - 1] === ".") end -= 1;
    const domain = text.slice(at + 1, end);
    if (start < at && domain.includes(".") && !domain.startsWith(".")) found.push(text.slice(start, end).toLowerCase());
    from = at + 1;
  }
  return found;
}

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

// Whether a text holds a whole name: the name with no letter or digit on either side of it.
function holdsName(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    if (!isWordCharacter(text[at - 1]) && !isWordCharacter(text[at + name.length])) return true;
  }
  return false;
}

// The address a line gives, or the address of the person on the message whose whole display
// name it gives. Undefined when it names nobody: the author is then unknown, never guessed.
// A line that introduces a quote is short, so no name is looked for in a long one.
function authorIn(text: string, context: SplitContext): Mention | undefined {
  const lower = text.toLowerCase();
  const named = (): string | undefined =>
    lower.length > MAX_INTRO_CHARS ? undefined : context.parties.find((party) => holdsName(lower, party.name))?.address;
  const address = addressesIn(lower)[0] ?? named();
  return address === undefined
    ? undefined
    : { key: { kind: "address", value: address }, observedAt: context.observedAt };
}

// The people a quote may be credited to by name: each name once, lower-cased. A name two
// addresses share names nobody.
function namedParties(parties: Party[]): Party[] {
  const byName = new Map<string, string | null>();
  for (const party of parties.slice(0, MAX_PARTIES)) {
    const name = party.name.toLowerCase();
    if (name.length < 3) continue;
    const known = byName.get(name);
    byName.set(name, known === undefined || known === party.address ? party.address : null);
  }
  return [...byName].flatMap(([name, address]) => (address === null ? [] : [{ name, address }]));
}

// White space of any kind, and the characters that take no room, may stand before a marker.
const SKIPPED = /\s|\u200b|\u200c|\u200d|\u2060/;
const isSkipped = (character: string | undefined): boolean => character !== undefined && SKIPPED.test(character);

// How many quote markers a line starts with, and the line without them.
function unquote(text: string): { depth: number; rest: string } {
  let depth = 0;
  let at = 0;
  while (depth < MAX_QUOTE_DEPTH) {
    let marker = at;
    while (isSkipped(text[marker])) marker += 1;
    if (text[marker] !== ">") break;
    depth += 1;
    at = isSkipped(text[marker + 1]) ? marker + 2 : marker + 1;
  }
  return { depth, rest: text.slice(at) };
}

const NAME = /^\p{L}[\p{L}\p{M} '-]*$/u;

// A line shaped like a header, "Name: value". The name is short and made of letters; a colon
// with no space after it (a time, a link) is not one.
function headerOf(line: Line): { name: string; value: string } | undefined {
  const text = line.text.trimEnd();
  const colon = text.indexOf(":");
  if (colon < 1 || colon > 40 || (colon + 1 < text.length && text[colon + 1] !== " ")) return undefined;
  const name = text.slice(0, colon).trim();
  return NAME.test(name) ? { name: name.toLowerCase(), value: text.slice(colon + 1).trim() } : undefined;
}

// The header names a forwarded or original message is written with, as mail clients spell
// them in English, German, French, Spanish, Portuguese, Italian and Dutch.
const FROM_NAMES = new Set(["from", "von", "de", "da", "van"]);
const OTHER_NAMES = new Map<string, "sent" | "date" | "to" | "subject">([
  ...["sent", "gesendet", "envoyé", "enviado", "enviada", "inviato", "verzonden"].map((name): [string, "sent"] => [
    name,
    "sent",
  ]),
  ...["date", "datum", "fecha", "data"].map((name): [string, "date"] => [name, "date"]),
  ...["to", "an", "à", "a", "para", "aan"].map((name): [string, "to"] => [name, "to"]),
  ...["subject", "betreff", "objet", "asunto", "assunto", "oggetto", "onderwerp"].map((name): [string, "subject"] => [
    name,
    "subject",
  ]),
]);

// A forwarded or original message: a run of header lines, with at most one blank line between
// two of them, that holds a From line and at least two of Sent, Date, To and Subject, in any
// order. A signature, an agenda or a contact card has header lines but is not one. `end` is
// the line to look at next; `from` is the From line's value when this line starts a block.
function headerBlockAt(lines: Line[], at: number): { end: number; from?: string } {
  const depth = (lines[at] as Line).depth;
  const others = new Set<string>();
  let from: string | undefined;
  let firstKnown = -1;
  let end = at;
  for (let index = at; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    if (line.blank) {
      if ((lines[index - 1] as Line | undefined)?.blank === true) break;
      continue;
    }
    const header = line.depth === depth ? headerOf(line) : undefined;
    if (header === undefined) break;
    end = index + 1;
    const other = OTHER_NAMES.get(header.name);
    if (!FROM_NAMES.has(header.name) && other === undefined) continue;
    if (firstKnown < 0) firstKnown = index;
    if (other !== undefined) others.add(other);
    else from ??= header.value;
  }
  if (end === at) return { end: at + 1 };
  if (from === undefined || others.size < 2) return { end };
  // The block starts at its first known header: a header-shaped line of the sender's above it stays.
  return firstKnown === at ? { end, from } : { end: firstKnown };
}

const endsWithColon = (line: Line): boolean => line.text.trimEnd().endsWith(":");

// One level of quoting: the text outside any quote, or the inside of a quote.
interface Level {
  author: Mention | undefined;
  quoted: boolean;
  // The first line inside a quote may be the line that introduces it.
  awaitingIntro: boolean;
  // A forwarded block's text is its author's to the end of its first paragraph.
  forwarded: "no" | "first_paragraph" | "paragraph_ended";
}

// A span is "chars:<start>-<end>", end excluded, over the body text given here.
export function splitBody(body: string, sender: Mention, context: SplitContext, limits: Limits): ParsedSegment[] {
  if (body.length > limits.bodyChars) throw new PipelineError("parse_failed");
  const known: SplitContext = { parties: namedParties(context.parties), observedAt: context.observedAt };

  const lines: Line[] = [];
  for (let start = 0; start <= body.length; ) {
    const newline = body.indexOf("\n", start);
    const end = newline < 0 ? body.length : newline;
    if (end - start > limits.lineChars) throw new PipelineError("parse_failed");
    const { depth, rest } = unquote(body.slice(start, end));
    lines.push({ text: rest, depth, blank: rest.trim() === "", start, end });
    start = end + 1;
  }

  const out: ParsedSegment[] = [];
  const levels: Level[] = [{ author: sender, quoted: false, awaitingIntro: false, forwarded: "no" }];
  const top = (): Level => levels[levels.length - 1] as Level;
  // The lines of the segment being read, blank ones included, and who it belongs to.
  let run: Line[] = [];
  let runOf: Level = top();
  let runAuthor = sender as Mention | undefined;

  const flush = (): void => {
    let last = run.length - 1;
    while (last >= 0 && (run[last] as Line).blank) last -= 1;
    const first = run[0];
    if (first !== undefined && last >= 0) {
      const text = run
        .slice(0, last + 1)
        .map((line) => line.text)
        .join("\n");
      const span = `chars:${first.start}-${(run[last] as Line).end}`;
      if (out.length >= limits.segments) throw new PipelineError("parse_failed");
      out.push({ span, ...(runAuthor !== undefined && { author: runAuthor }), quoted: runOf.quoted, text });
    }
    run = [];
  };

  // The last line of text in the run, with the blank lines after it.
  const lastText = (): number => {
    let last = run.length - 1;
    while (last >= 0 && (run[last] as Line).blank) last -= 1;
    return last;
  };

  // The line that introduces a quote ("On <date>, <person> wrote:"), when it names someone.
  // It may be wrapped in two. It is taken out of the text above the quote.
  const takeIntroAbove = (): Mention | undefined => {
    const last = lastText();
    const line = run[last];
    if (line === undefined || !endsWithColon(line)) return undefined;
    const alone = authorIn(line.text, known);
    const above = run[last - 1];
    const wrapped = alone === undefined && line.text.trim().length <= 24 && above !== undefined && !above.blank;
    const author = alone ?? (wrapped ? authorIn(`${above.text} ${line.text}`, known) : undefined);
    if (author !== undefined) run.length = alone === undefined ? last - 1 : last;
    return author;
  };

  // The line right above a forwarded block is dropped only when it is a delimiter, a line
  // that begins and ends in dashes or underscores ("---- Forwarded message ----"), or the
  // line one mail client introduces a forward with. Any other line is the sender's and stays.
  const dropDelimiterAbove = (): void => {
    const last = lastText();
    const text = run[last]?.text.trim().toLowerCase() ?? "";
    const ruled = (edge: string): boolean => edge === "--" || edge === "__";
    if ((ruled(text.slice(0, 2)) && ruled(text.slice(-2))) || text === "begin forwarded message:") run.length = last;
  };

  let noBlockBefore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as Line;
    if (line.blank) {
      // A blank line ends nothing but a forwarded block's first paragraph.
      if (top().forwarded === "first_paragraph" && run.length > 0) top().forwarded = "paragraph_ended";
      if (run.length > 0) run.push(line);
      continue;
    }

    // Quotes that have ended: a clear end, after which the text outside them resumes.
    while (levels.length - 1 > line.depth) {
      flush();
      levels.pop();
    }
    // Quotes that begin.
    while (levels.length - 1 < line.depth) {
      const author = runOf === top() ? takeIntroAbove() : undefined;
      flush();
      if (top().forwarded === "first_paragraph") top().forwarded = "paragraph_ended";
      levels.push({ author, quoted: true, awaitingIntro: author === undefined, forwarded: "no" });
    }
    const level = top();

    if (level.awaitingIntro) {
      level.awaitingIntro = false;
      const author = endsWithColon(line) ? authorIn(line.text, known) : undefined;
      if (author !== undefined) {
        level.author = author;
        continue;
      }
    }

    if (index >= noBlockBefore) {
      const block = headerBlockAt(lines, index);
      if (block.from !== undefined) {
        if (runOf === level) dropDelimiterAbove();
        flush();
        level.author = authorIn(block.from, known);
        level.quoted = true;
        level.forwarded = "first_paragraph";
        index = block.end - 1;
        continue;
      }
      noBlockBefore = block.end;
    }

    // Past the first paragraph of a forwarded block, nothing says whose the text is.
    if (level.forwarded === "paragraph_ended") {
      level.author = undefined;
      level.forwarded = "no";
    }
    if (run.length > 0 && (runOf !== level || runAuthor !== level.author)) flush();
    if (run.length === 0) {
      runOf = level;
      runAuthor = level.author;
    }
    run.push(line);
  }
  flush();
  return out;
}
