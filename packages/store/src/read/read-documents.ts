import {
  type DocumentId,
  type DocumentKind,
  type DocumentList,
  type DocumentSummary,
  type DocumentUnreadable,
  type DocumentView,
  FindDocumentsArgs,
  GetDocumentArgs,
  type SectionView,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { type MaskedSpan, maskCredentials, maskedField, maskedSpans } from "@intelligence/personal-core";
import { documentLink } from "@intelligence/personal-core/items";
import { stamp } from "../core/db.ts";
import { type Ctx, epochSeconds, type Found, shownOnly, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool, timed } from "../core/read-tool.ts";
import type { Sealed, SealedRow } from "../core/seal.ts";
import { servedOrNone } from "../core/served.ts";
import { zonedBounds } from "../core/zone.ts";
import { ENTITY } from "./read-fact-rows.ts";
import { normalized } from "./read-search.ts";

// The two document tools' fixed queries. Each reads knowledge.documents, and for an entity
// knowledge.entities and knowledge.accounts, under the caller's token and nothing else. The row
// policy returns no held document; the statements say `not held` as well. Every filter is on a
// clear column or a fingerprint, but a title search, which opens at most 5 000 titles of the rows
// the other filters match. fetch_template (read-templates.ts) reads a document by the same
// statement and slices its text by the same window.

const FOUND_DEFAULT = 20;
const FOUND_MAX = 50;
const WINDOW_DEFAULT = 20_000;
const WINDOW_MAX = 50_000;
const TITLE_SCAN = 5_000;
const OUTLINE_PAST = 100;
const HEADING_UNITS = 200;
const RESULT_UNITS = 60_000;

const SUMMARY_COLUMNS =
  "d.id, d.kind, d.modified_at, d.mine, d.reference, d.title_enc, d.owner_enc, d.facts_enc, d.compartments, d.evidence_id";

// Every filter given, newest modified first, ties by id. An entity matches a document whose
// owner or sharer is one of its addresses the caller can see.
const FIND = `
  select ${SUMMARY_COLUMNS}
  from knowledge.documents d
  where not d.held
    and ($1::text is null or d.kind = $1)
    and ($2::boolean is null or d.mine = $2)
    and ($3::boolean is null or d.reference = $3)
    and ($4::float8 is null or d.modified_at >= to_timestamp($4))
    and ($5::float8 is null or d.modified_at <= to_timestamp($5))
    and ($6::text is null or exists (
      select 1 from knowledge.accounts a where a.entity_id = $6 and (a.value_fp = d.owner_fp or a.value_fp = d.sharer_fp)))
  order by d.modified_at desc, d.id
  limit $7`;

type SummaryRow = {
  id: string;
  kind: DocumentKind;
  modified_at: Date;
  mine: boolean;
  reference: boolean;
  title_enc: Sealed | null;
  owner_enc: Sealed | null;
  facts_enc: Sealed | null;
  compartments: string[];
  evidence_id: string;
};

type Facts = { chars: number; sections: number; size: number | null; unreadable: DocumentUnreadable | null };

// A sealed JSON value of the writer's: null when the row has none. One that does not read as JSON
// is a value that does not open.
type Outline = { heading: string; start: number; end: number };
type JsonColumn = "knowledge.documents.facts_enc" | "knowledge.documents.owner_enc" | "knowledge.documents.outline_enc";
function jsonOf<C extends JsonColumn, T>(ctx: Ctx, row: SealedRow<C>, column: C): T | null {
  const text = servedOrNone(ctx, row, column)?.untrusted;
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Unavailable();
  }
}

const wrapped = (value: string | undefined): UntrustedString | null =>
  value === undefined ? null : { untrusted: value };

// A document's summary with its title masked, and how many values the title held, which get_document and
// fetch_template count.
function summaryOf(ctx: Ctx, row: SummaryRow): DocumentSummary {
  return maskedSummaryOf(ctx, row).summary;
}

export function maskedSummaryOf(ctx: Ctx, row: SummaryRow): { summary: DocumentSummary; masked: number } {
  const facts: Facts | null = jsonOf(ctx, row, "knowledge.documents.facts_enc");
  if (facts === null) throw new Unavailable();
  const owner: { address?: string; name?: string } | null = jsonOf(ctx, row, "knowledge.documents.owner_enc");
  const title = maskCredentials(servedOrNone(ctx, row, "knowledge.documents.title_enc")?.untrusted ?? "");
  const summary: DocumentSummary = {
    id: row.id as DocumentId,
    title: { untrusted: title.text },
    kind: row.kind,
    modifiedAt: stamp(row.modified_at),
    mine: row.mine,
    owner: owner === null ? null : { name: wrapped(owner.name), address: wrapped(owner.address) },
    reference: row.reference,
    chars: facts.chars,
    sections: facts.sections,
    unreadable: facts.unreadable,
  };
  return { summary, masked: title.masked };
}

const wordsOf = (text: string): string[] =>
  normalized(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

// Whether every word of the query is a word of the title or the start of one.
function titleHolds(title: string, query: string[]): boolean {
  const words = wordsOf(title);
  return query.every((asked) => words.some((word) => word.startsWith(asked)));
}

async function findDocuments(ctx: Ctx, args: FindDocumentsArgs): Promise<Found<DocumentList> | null> {
  if (args.entity !== undefined && (await ctx.run(ENTITY, [args.entity])).length === 0) return null;
  const limit = Math.min(args.limit ?? FOUND_DEFAULT, FOUND_MAX);
  const query = args.title === undefined ? null : wordsOf(args.title);
  const rows = await ctx.run<SummaryRow>(FIND, [
    args.kind ?? null,
    args.mine ?? null,
    args.reference ?? null,
    args.from === undefined ? null : epochSeconds(args.from),
    args.to === undefined ? null : epochSeconds(args.to),
    args.entity ?? null,
    query === null ? limit + 1 : TITLE_SCAN + 1,
  ]);
  let scanned = true;
  let matched = rows;
  if (query !== null) {
    scanned = rows.length <= TITLE_SCAN;
    matched = rows
      .slice(0, TITLE_SCAN)
      .filter((row) => titleHolds(servedOrNone(ctx, row, "knowledge.documents.title_enc")?.untrusted ?? "", query));
  }
  const kept = matched.slice(0, limit);
  const documents = kept.map((row) => summaryOf(ctx, row));
  return {
    value: { documents, more: matched.length > limit, scanned },
    rows: documents.length,
    read: shownOnly(kept.map((row) => row.evidence_id)),
  };
}

// The one row with that id, never a held one: a held id and an unknown one send this same
// statement and get the same empty answer.
const READ = `
  select ${SUMMARY_COLUMNS}, d.file_id_enc, d.body_enc, d.outline_enc
  from knowledge.documents d
  where d.id = $1 and not d.held
  order by d.id`;

type DocumentRow = SummaryRow & { file_id_enc: Sealed | null; body_enc: Sealed | null; outline_enc: Sealed | null };

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

// A position moved so that it never falls inside a surrogate pair: back to the pair's start.
const onBoundary = (text: string, at: number): number =>
  at > 0 && at < text.length && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1)) ? at - 1 : at;

// At most `units` code units of a value, never inside a pair.
const cut = (value: string, units: number): string => value.slice(0, onBoundary(value, Math.min(units, value.length)));

// The one visible document with that id, unopened, or null for a hidden, held or absent one.
export async function documentRow(ctx: Ctx, id: string): Promise<DocumentRow | null> {
  const [row] = await ctx.run<DocumentRow>(READ, [id]);
  return row ?? null;
}

// The document's text, undefined when it has none, with its credential-shaped values masked
// whole before any window, and their places for the count a window carries.
export function bodyOf(ctx: Ctx, row: DocumentRow): { text: string; spans: MaskedSpan[] } | undefined {
  const opened = servedOrNone(ctx, row, "knowledge.documents.body_enc")?.untrusted;
  return opened === undefined ? undefined : maskedSpans(opened);
}

// A cut never falls inside a pair. `chars` is the code points of the slice served, which the read
// quota counts.
export function windowOf<V>(
  body: string,
  args: { offset?: number | undefined; limit?: number | undefined },
  viewFor: (offset: number, end: number) => V,
): { view: V; chars: number } {
  const offset = onBoundary(body, Math.min(args.offset ?? 0, body.length));
  let end = onBoundary(body, Math.min(offset + Math.min(args.limit ?? WINDOW_DEFAULT, WINDOW_MAX), body.length));
  let view = viewFor(offset, end);
  for (
    let length = JSON.stringify(view).length;
    length >= RESULT_UNITS && end > offset;
    length = JSON.stringify(view).length
  ) {
    end = onBoundary(body, Math.max(offset, end - Math.max(1, length - RESULT_UNITS + 1)));
    view = viewFor(offset, end);
  }
  return { view, chars: [...body.slice(offset, end)].length };
}

async function getDocument(ctx: Ctx, args: GetDocumentArgs): Promise<Found<DocumentView> | null> {
  const row = await documentRow(ctx, args.id);
  if (row === null) return null;
  const { summary, masked: titled } = maskedSummaryOf(ctx, row);
  const fileId = servedOrNone(ctx, row, "knowledge.documents.file_id_enc")?.untrusted;
  const link = fileId === undefined ? null : documentLink(row.kind, fileId);
  const masked = bodyOf(ctx, row);
  const read = { bound: [row.evidence_id], shown: [], factKeyFps: [] };
  if (masked === undefined)
    return {
      value: {
        ...summary,
        outline: [],
        text: null,
        offset: args.offset ?? 0,
        more: false,
        link,
        ...maskedField(titled),
      },
      rows: 1,
      read,
      chars: 0,
    };
  const body = masked.text;

  // A heading is masked as the text is, before its cut. Its text is the body's at its start, so a
  // value in it is the body's value there: each value is counted once, when it overlaps the window
  // served or a heading served. A heading whose value the body does not hold there counts its own.
  const outline: Outline[] | null = jsonOf(ctx, row, "knowledge.documents.outline_enc");
  const sections = (outline ?? []).map((one, ordinal) => {
    const heading = maskCredentials(one.heading);
    const at = { start: one.start, end: one.start + one.heading.length };
    const inBody = masked.spans.some((span) => span.startUnit < at.end && at.start < span.endUnit);
    return { ...one, ordinal, heading: heading.text, at, own: inBody ? 0 : heading.masked };
  });
  const viewFor = (offset: number, to: number) => {
    const inside = sections.filter((one) => one.start >= offset && one.start < to);
    const past = sections.filter((one) => one.start >= to).slice(0, OUTLINE_PAST);
    const served = [...inside, ...past];
    const counted = masked.spans.filter(
      (span) =>
        (span.startUnit < to && offset < span.endUnit) ||
        served.some((one) => span.startUnit < one.at.end && one.at.start < span.endUnit),
    ).length;
    return {
      ...summary,
      outline: served.map(
        ({ ordinal, heading, start, end: stop }): SectionView => ({
          ordinal,
          heading: { untrusted: cut(heading, HEADING_UNITS) },
          start,
          end: stop,
        }),
      ),
      text: { untrusted: body.slice(offset, to) },
      offset,
      more: to < body.length,
      link,
      ...maskedField(titled + counted + served.reduce((sum, one) => sum + one.own, 0)),
    };
  };
  const { view, chars } = windowOf(body, args, viewFor);
  return { value: view, rows: 1, read, chars };
}

// The two document tools, view `work`.
export const FIND_DOCUMENTS_TOOL: ReadTool<FindDocumentsArgs, DocumentList> = {
  tool: "find_documents",
  parse: (args) => timed(parsed(FindDocumentsArgs.safeParse(args))),
  work: async (ctx, valid) => findDocuments(ctx, await zonedBounds(ctx, valid)),
};

export const GET_DOCUMENT_TOOL: ReadTool<GetDocumentArgs, DocumentView> = {
  tool: "get_document",
  parse: (args) => parsed(GetDocumentArgs.safeParse(args)),
  work: (ctx, valid) => getDocument(ctx, valid),
};
