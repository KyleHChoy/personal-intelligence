import { type ChangeKind, type RawItem, type SourceAccountId, Timestamp } from "@intelligence/contracts";
import { type DocumentKind, DocumentUnreadable } from "@intelligence/contracts/personal";
import { normalizeAddress } from "../addresses.ts";
import { PipelineError } from "../claim-pipeline/errors.ts";
import type { Limits } from "../claim-pipeline/limits.ts";
import { parse } from "../claim-pipeline/parse.ts";
import { sha256 } from "../hash.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { fields, isBoolean, isString, optional, refuse, required, whitelisted } from "../values.ts";
import { payloadOf, pipelineItemOf } from "./adapter.ts";
import { recoveryHold } from "./hold.ts";
import type { DocBlock, DocBody, DocumentFacts, DriveFile, DrivePerson, ItemContext, ItemFacts } from "./types.ts";

// Code only: no network, and nothing a document says is followed.

// The version of the reading rules. It is in every revision tag, so a change to the reading fetches
// every document again.
export const DRIVE_READING = 1;

const NAME_POINTS = 255;
const TYPE_POINTS = 127;

const GOOGLE_TYPES: Readonly<Record<string, DocumentKind>> = Object.freeze({
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.presentation": "slides",
  "application/pdf": "pdf",
});

export const documentKind = (mimeType: string): DocumentKind =>
  Object.hasOwn(GOOGLE_TYPES, mimeType) ? (GOOGLE_TYPES[mimeType] as DocumentKind) : "other";

// The first `points` code points of a value.
const cut = (value: string, points: number): string => [...value.slice(0, 2 * points)].slice(0, points).join("");

function person(one: DrivePerson | undefined): DrivePerson | undefined {
  if (one === undefined) return undefined;
  const address = one.address === undefined ? null : normalizeAddress(one.address);
  const name = one.name === undefined || one.name === "" ? undefined : cut(one.name, NAME_POINTS);
  const kept = { ...(address === null ? {} : { address }), ...(name === undefined ? {} : { name }) };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

// The file as it is written into a block and a tag: the name and type cut, the people checked,
// and no key the file does not have.
function cleaned(file: DriveFile): DriveFile {
  const [owner, sharer] = [person(file.owner), person(file.sharer)];
  return {
    id: file.id,
    name: cut(file.name, NAME_POINTS),
    mimeType: cut(file.mimeType, TYPE_POINTS),
    ...(file.size === undefined ? {} : { size: file.size }),
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    ...(file.parent === undefined ? {} : { parent: file.parent }),
    root: file.root,
    ownedByMe: file.ownedByMe,
    modifiedByMe: file.modifiedByMe,
    ...(owner === undefined ? {} : { owner }),
    ...(sharer === undefined ? {} : { sharer }),
    canDownload: file.canDownload,
  };
}

const bit = (value: boolean): string => (value ? "1" : "0");

export function driveRevisionTag(file: DriveFile): string {
  const one = cleaned(file);
  const name = sha256(one.name).slice(0, 16);
  return `d${DRIVE_READING}:${one.modifiedTime}:${one.root}:${one.parent ?? "-"}:${bit(one.canDownload)}:${bit(one.ownedByMe)}:${name}`;
}

// Text escaped for an HTML element: no byte of it is read as markup. A page's text/plain body
// takes the same escape (page.ts).
export const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const blockText = (block: DocBlock): string => (block.kind === "row" ? block.cells.join(" | ") : block.text);

function bodyLines(body: DocBody | null): string[] {
  const lines: string[] = [];
  let inList = false;
  for (const block of body?.blocks ?? []) {
    if ((block.kind === "item") !== inList) {
      lines.push(inList ? "</ul>" : "<ul>");
      inList = !inList;
    }
    const tag = block.kind === "heading" ? `h${block.level}` : block.kind === "item" ? "li" : "p";
    lines.push(`<${tag}>${escaped(blockText(block))}</${tag}>`);
  }
  if (inList) lines.push("</ul>");
  return lines;
}

// The opening tags of the head: html, head, meta, title and body.
const HEAD_TAGS = 5;

// The head holds the file's facts, as the base64url of their JSON, and the file's name as the
// title.
export function documentBlock(
  file: DriveFile,
  body: DocBody | null,
  unreadable: DocumentUnreadable | null,
): Uint8Array {
  const one = cleaned(file);
  const facts = Buffer.from(JSON.stringify({ file: one, unreadable })).toString("base64url");
  const head = `<html><head><meta name="pi-file" content="${facts}"><title>${escaped(one.name)}</title></head><body>`;
  return new TextEncoder().encode([head, ...bodyLines(body), "</body></html>", ""].join("\n"));
}

// What a head can add to a block, at most: the facts' JSON in base64url and the title, with room.
const HEAD_BYTES = 16 * 1024;

// Each counted on the safe side.
export function documentTooLong(body: DocBody): boolean {
  const { blocks } = body;
  const limits = PERSONAL_LIMITS;
  let chars = 0;
  let headings = 0;
  let runs = 0;
  for (const [at, block] of blocks.entries()) {
    // Its text and the line breaks and mark the parse writes around it.
    chars += blockText(block).length + 3;
    if (block.kind === "heading") headings += 1;
    if (block.kind === "item" && blocks[at - 1]?.kind !== "item") runs += 1;
  }
  if (
    chars > limits.bodyChars ||
    HEAD_TAGS + blocks.length + runs > limits.htmlTags - 100 ||
    headings + 1 > limits.segments
  )
    return true;
  const html = bodyLines(body).join("\n");
  return (
    html.length + HEAD_BYTES > limits.htmlChars || Buffer.byteLength(html, "utf8") + HEAD_BYTES > limits.payloadBytes
  );
}

// No sender, no addressees, and the owner's own address as the only one who can see it: a
// document's sharing is not read.
export function driveItem(
  file: DriveFile,
  body: DocBody | null,
  unreadable: DocumentUnreadable | null,
  at: { sourceAccount: SourceAccountId; changeKind: ChangeKind; ownerAddress: string },
): RawItem {
  const id = `drive-file:${file.id}`;
  return {
    sourceKind: "document",
    sourceAccount: at.sourceAccount,
    sourceItemId: id,
    revisionTag: driveRevisionTag(file),
    threadId: id,
    observedAt: file.modifiedTime,
    depth: body === null ? "headers" : "full",
    changeKind: at.changeKind,
    payload: Buffer.from(documentBlock(file, body, unreadable)).toString("base64"),
    mediaType: "text/html",
    permissions: { scope: "listed", identifiers: [at.ownerAddress] },
    markers: ["drive", `root:${file.root}`],
  };
}

const LINK_PATHS: Readonly<Record<DocumentKind, string>> = Object.freeze({
  doc: "docs.google.com/document/d/",
  sheet: "docs.google.com/spreadsheets/d/",
  slides: "docs.google.com/presentation/d/",
  pdf: "drive.google.com/file/d/",
  other: "drive.google.com/file/d/",
});

// The address that opens a file in Google, from its id and kind alone, or null for an id of
// another shape.
export function documentLink(kind: DocumentKind, fileId: string): string | null {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) return null;
  const end = kind === "pdf" || kind === "other" ? "view" : "edit";
  return `https://${LINK_PATHS[kind]}${fileId}/${end}`;
}

// The head the builder writes, read by its exact form and nothing looser.
const HEAD = /^<html><head><meta name="pi-file" content="([A-Za-z0-9_-]+)"><title>/;

const isTimestamp = (value: unknown): value is Timestamp => Timestamp.safeParse(value).success;
const isNumber = (value: unknown): value is number => typeof value === "number";

function personOf(value: unknown): DrivePerson | undefined {
  if (value === undefined) return undefined;
  const raw = fields(value);
  const [address, name] = [optional(raw.address, isString), optional(raw.name, isString)];
  return { ...(address === undefined ? {} : { address }), ...(name === undefined ? {} : { name }) };
}

// The file and its unreadable value as the builder wrote them, or null for any other value.
function fileFacts(payload: Uint8Array): { file: DriveFile; unreadable: DocumentUnreadable | null } | null {
  const head = HEAD.exec(new TextDecoder().decode(payload.subarray(0, 64 * 1024)));
  if (head === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(head[1] as string, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return whitelisted(() => {
    const raw = fields(value);
    const f = fields(raw.file);
    const unreadable = raw.unreadable === null ? null : DocumentUnreadable.safeParse(raw.unreadable);
    if (unreadable !== null && !unreadable.success) refuse();
    const [owner, sharer] = [personOf(f.owner), personOf(f.sharer)];
    const [size, parent] = [optional(f.size, isNumber), optional(f.parent, isString)];
    const file: DriveFile = {
      id: required(f.id, isString),
      name: required(f.name, isString),
      mimeType: required(f.mimeType, isString),
      ...(size === undefined ? {} : { size }),
      createdTime: required(f.createdTime, isTimestamp),
      modifiedTime: required(f.modifiedTime, isTimestamp),
      ...(parent === undefined ? {} : { parent }),
      root: required(f.root, isString),
      ownedByMe: required(f.ownedByMe, isBoolean),
      modifiedByMe: required(f.modifiedByMe, isBoolean),
      ...(owner === undefined ? {} : { owner }),
      ...(sharer === undefined ? {} : { sharer }),
      canDownload: required(f.canDownload, isBoolean),
    };
    return { file, unreadable: unreadable?.success ? unreadable.data : null };
  });
}

// Its file facts from the block's pi-file value, which this package wrote; its text and sections
// from the shared parse, read by sections. The parse reads an item by sections only when it carries
// a reference kind, so the value handed to the parse, and only that value, carries the sentinel
// `register`. Nothing in the text is read as a person, and no entity is resolved. A block the parse
// refuses gives no text and `unparsed`.
export async function deriveDocument(raw: RawItem, ctx: ItemContext, limits: Limits): Promise<ItemFacts> {
  const members = { participantMembers: [THE_OWNER] };
  const payload = payloadOf(raw);
  const read = fileFacts(payload);
  if (read === null) return { kind: "unread", members };
  const { file } = read;
  let unreadable = read.unreadable;
  let text: string | null = null;
  let sections: DocumentFacts["sections"] = [];
  if (raw.depth === "full") {
    try {
      const parsed = await parse({ ...pipelineItemOf(raw, ctx), referenceKind: "register" }, payload, limits);
      const whole = parsed.texts[""] ?? "";
      if (whole !== "") {
        text = whole;
        sections = (parsed.document?.content.sections ?? []).map((section, i) => {
          const [start, end] = (parsed.segments[i]?.span ?? "chars:0-0").slice("chars:".length).split("-").map(Number);
          return { heading: section.heading, start: start ?? 0, end: end ?? 0 };
        });
      }
    } catch (error) {
      if (!(error instanceof PipelineError) || error.code !== "parse_failed") throw error;
      unreadable = "unparsed";
    }
  }
  const document: DocumentFacts = {
    fileId: file.id,
    title: file.name,
    kind: documentKind(file.mimeType),
    modifiedAt: file.modifiedTime,
    createdAt: file.createdTime,
    mine: file.ownedByMe,
    editedByMe: file.modifiedByMe,
    ...(file.owner === undefined ? {} : { owner: file.owner }),
    ...(file.sharer === undefined ? {} : { sharer: file.sharer }),
    root: file.root,
    ...(file.parent === undefined ? {} : { parent: file.parent }),
    ...(file.size === undefined ? {} : { size: file.size }),
    text,
    sections,
    unreadable,
    held: recoveryHold({ subject: file.name, text }),
  };
  return { kind: "document", members, document };
}
