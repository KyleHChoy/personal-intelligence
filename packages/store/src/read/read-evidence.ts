import {
  type AgentRecordId,
  type CaptureId,
  ClaimRecord,
  type DocumentId,
  type EvidenceSource,
  type EvidenceSpan,
  type FactId,
  GetEvidenceSpanArgs,
  type MessageId,
  NO_PASSAGE,
} from "@intelligence/contracts/personal";
import { type MaskedSpan, maskedField, maskedIn, maskedInUnits, maskedSpans } from "@intelligence/personal-core";
import { passageOf, recordPassageOf } from "@intelligence/personal-core/items";
import { TITLE_LINK_TYPE } from "../core/link-types.ts";
import type { Found, ReadSet } from "../core/read-ctx.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import type { Sealed } from "../core/seal.ts";
import { served, servedJson, servedOrNone } from "../core/served.ts";
import { OWN_CONTACT_CLAIM } from "../core/statements.ts";
import { NAMES_SHOWN, RELEASE_IN_FORCE, sourceJoins, sourceShown } from "../core/visibility.ts";
import { factSourceOf } from "./fact-source.ts";
import { meetingPassage } from "./read-meeting.ts";

// get_evidence_span's fixed query: the passage one
// fact cites, from the fact's own source and no other: its message, or the agent record of a
// finding. One statement, the same for every answer: a fact the token does not return, a fact whose
// message is held, and an id no claim has all find no row, so each answers not_found after exactly
// what an absent id sends. A fact find_facts would return with no passage here answers where it
// came from: EVIDENCE_POINTER, sent whenever no passage was found, whatever the id.

// The most code points of a passage served in one call.
const PASSAGE_MAX = 4_000;

// The most claims of one belief tried for a passage.
const SPAN_ROWS = 20;

// The claim with its message, never a held one, or with its agent record, and only a claim
// find_facts would return: one that names no person or organization the token does not show,
// and for a finding one whose ledger.agent_writes row the token returns (find_facts' second
// branch: that row policy holds the record's whole label, its writer's views and its flag). `$1` is a
// fact's id, or a belief line's fact, which answers with the newest claim behind it that has a passage
// here. A fact from a document or a chat finds no row here: a reader may not open a capture's text.
export const EVIDENCE_SPAN = `
  select c.id, c.fact_key_fp, c.content_enc, c.compartments, c.evidence_id,
    m.id as message_id, m.compartments as message_compartments, m.subject_enc, m.body_enc,
    w.id as record_id, w.compartments as record_compartments, w.body_enc as record_body_enc
  from knowledge.claims c
  ${sourceJoins(["message"])}
  left join ledger.agent_writes w on w.evidence_id = c.evidence_id and w.flagged_at is null
  where (c.id = $1 or c.fact_key_fp = $1) and ${sourceShown(["message"], ["record"])}
    and ${RELEASE_IN_FORCE}
    and ${NAMES_SHOWN}
  order by c.valid_from desc, c.id, m.id, w.id
  limit ${SPAN_ROWS}`;

// The newest claim of `$1` that FIND_FACTS' terms return, whatever its source, with what names that
// source: a claim hidden from find_facts is hidden here. Never opens a source's text.
const POINTER_ITEMS = ["message", "document", "page", "capture"] as const;
const EVIDENCE_POINTER = `
  select c.id, c.fact_key_fp, c.content_enc, c.compartments, c.evidence_id, m.id as message_id, d.id as document_id, g.id as page_id,
    k.id as capture_id, k.kind as capture_kind, k.source as capture_source, w.id as record_id,
    ${OWN_CONTACT_CLAIM} as contact
  from knowledge.claims c
  ${sourceJoins(POINTER_ITEMS)}
  left join ledger.agent_writes w on w.evidence_id = c.evidence_id and w.flagged_at is null
  where (c.id = $1 or c.fact_key_fp = $1)
    and ${sourceShown(POINTER_ITEMS, ["released", "record", "contact"])}
    and c.type <> '${TITLE_LINK_TYPE}'
    and ${RELEASE_IN_FORCE}
    and ${NAMES_SHOWN}
  order by c.valid_from desc, c.id, m.id, d.id, g.id, k.id, w.id
  limit 1`;

type PointerRow = {
  id: FactId;
  fact_key_fp: string;
  content_enc: Sealed;
  compartments: string[];
  evidence_id: string;
  message_id: MessageId | null;
  document_id: DocumentId | null;
  page_id: string | null;
  capture_id: CaptureId | null;
  capture_kind: string | null;
  capture_source: string | null;
  record_id: AgentRecordId | null;
  contact: boolean;
};

// Where a fact with no passage here came from. Its origin only tells an owner's word from others;
// a record that does not open is simply of no named kind. A meeting's is the meeting, which
// read_meeting opens.
function pointerSource(ctx: Ctx, row: PointerRow): EvidenceSource {
  if (row.document_id !== null) return { kind: "document", id: row.document_id };
  if (row.capture_id !== null && row.capture_kind === "meeting") return { kind: "meeting", id: row.capture_id };
  if (row.message_id !== null) return { kind: "message", id: row.message_id };
  if (row.record_id !== null) return { kind: "record", id: row.record_id };
  const opened = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
  return { kind: "elsewhere", from: factSourceOf(row, opened.success ? opened.data.origin : "") };
}

// The answer for a fact the caller sees with no passage here: no text, nothing bound, so it counts
// as reading no source. The read log still names the fact and shows the evidence its id points at.
// A meeting fact's passage is the turns its claim cites, read through the meeting's
// definer under the caller's clearance, and bound as a message's passage is.
async function pointerOf(ctx: Ctx, args: GetEvidenceSpanArgs): Promise<Found<EvidenceSpan> | null> {
  const [row] = await ctx.run<PointerRow>(EVIDENCE_POINTER, [args.fact]);
  if (row === undefined) return null;
  if (row.capture_id !== null && row.capture_kind === "meeting") {
    const found = await meetingPassage(ctx, row, row.evidence_id);
    if (found !== null) {
      const all = Array.from(found.passage.text);
      const served = all.slice(0, PASSAGE_MAX);
      return {
        value: {
          fact: row.id,
          source: { kind: "meeting", id: found.capture as CaptureId },
          passage: { untrusted: served.join("") },
          chars: all.length,
          cut: all.length > PASSAGE_MAX,
          ...maskedField(maskedIn(found.passage.spans, 0, served.length)),
        },
        rows: 1,
        read: { bound: [row.evidence_id], shown: [], factKeyFps: [row.fact_key_fp] },
        chars: served.length,
      };
    }
  }
  const source = pointerSource(ctx, row);
  return {
    value: { fact: row.id, source, passage: null, chars: 0, cut: false, noPassage: NO_PASSAGE[source.kind] },
    rows: 1,
    read: { bound: [], shown: [row.evidence_id], factKeyFps: [row.fact_key_fp] },
    chars: 0,
  };
}

type SpanRow = {
  id: FactId;
  fact_key_fp: string;
  content_enc: Sealed;
  compartments: string[];
  evidence_id: string;
  message_id: MessageId | null;
  message_compartments: string[] | null;
  subject_enc: Sealed | null;
  body_enc: Sealed | null;
  record_id: AgentRecordId | null;
  record_compartments: string[] | null;
  record_body_enc: Sealed | null;
};

// `counted` gives how many masked values overlap its first `served` code points, by their places in the whole
// text, so a value cut by a segment's edge is counted where it is served.
type Source = {
  passage: string;
  source: EvidenceSource;
  read: Omit<ReadSet, "factKeyFps">;
  counted: (served: number) => number;
};

// The values of a whole masked text that overlap the passage's first `served` code points. The
// passage is the text's own words, found in it by position; one the parse rewrote counts every
// value whose masked form it holds, so a count is never short.
function countedIn(whole: { text: string; spans: MaskedSpan[] }, passage: string): (served: number) => number {
  const at = whole.text.indexOf(passage);
  return (served) => {
    const shown = Array.from(passage).slice(0, served).join("");
    if (at >= 0) return maskedInUnits(whole.spans, at, at + shown.length);
    return whole.spans.filter((span) => shown.includes(whole.text.slice(span.startUnit, span.endUnit))).length;
  };
}

// The span the claim cites in its own message: that of its passage whose evidence id is the
// row's, so a span is never read against another message's text. A claim with none is a stored
// value that does not open.
function spanOf(ctx: Ctx, row: SpanRow): string {
  const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
  const span = parsed.success
    ? parsed.data.claim.evidence.find((passage) => passage.evidenceId === row.evidence_id)?.span
    : undefined;
  if (span === undefined) throw new Unavailable();
  return span;
}

// A span that names a text the store does not keep (an attachment's) has no passage, and answers
// not_found; so does a removed agent record's.
async function sourceOf(ctx: Ctx, row: SpanRow, span: string): Promise<Source | null> {
  if (row.message_id !== null && row.message_compartments !== null) {
    // Only the text the span names is opened: the store keeps no attachment's.
    if (span.startsWith("attachment:")) return null;
    const message = {
      id: row.message_id,
      compartments: row.message_compartments,
      body_enc: row.body_enc,
      subject_enc: row.subject_enc,
    };
    const subject = span.startsWith("subject:");
    const texts = {
      body: subject ? null : (servedOrNone(ctx, message, "knowledge.messages.body_enc")?.untrusted ?? null),
      subject: subject ? (servedOrNone(ctx, message, "knowledge.messages.subject_enc")?.untrusted ?? null) : null,
    };
    const whole = subject ? texts.subject : texts.body;
    if (whole === null) return null;
    const masked = maskedSpans(whole);
    const passage = await passageOf(
      subject ? { body: null, subject: masked.text } : { body: masked.text, subject: null },
      span,
    );
    if (passage === null) return null;
    return {
      passage,
      source: { kind: "message", id: row.message_id },
      read: { bound: [row.evidence_id], shown: [] },
      counted: countedIn(masked, passage),
    };
  }
  if (row.record_id === null || row.record_compartments === null || row.record_body_enc === null) return null;
  const body = maskedSpans(
    served(
      ctx,
      { id: row.record_id, compartments: row.record_compartments, body_enc: row.record_body_enc },
      "ledger.agent_writes.body_enc",
    ).untrusted,
  );
  // A record's passage is its whole body.
  const passage = recordPassageOf(body.text, span);
  return passage === null
    ? null
    : {
        passage,
        source: { kind: "record", id: row.record_id },
        read: { bound: [], shown: [row.record_id] },
        counted: (served) => maskedIn(body.spans, 0, served),
      };
}

export async function getEvidenceSpan(ctx: Ctx, args: GetEvidenceSpanArgs): Promise<Found<EvidenceSpan> | null> {
  return (await evidenceSpanOf(ctx, args))?.found ?? (await pointerOf(ctx, args));
}

// get_evidence_span's answer, and how many masked values a shorter cut of its passage serves, for
// context's passages.
export async function evidenceSpanOf(
  ctx: Ctx,
  args: GetEvidenceSpanArgs,
): Promise<{ found: Found<EvidenceSpan>; maskedWithin: (served: number) => number } | null> {
  let row: SpanRow | undefined;
  let found: Source | null = null;
  // A belief's newest claim may cite what has no passage here, an attachment; an older one may.
  for (const candidate of await ctx.run<SpanRow>(EVIDENCE_SPAN, [args.fact])) {
    found = await sourceOf(ctx, candidate, spanOf(ctx, candidate));
    row = candidate;
    if (found !== null) break;
  }
  if (row === undefined || found === null) return null;
  const { passage, source } = found;
  // Cut by code points, never inside a character outside the basic plane.
  const points = Array.from(passage);
  const served = points.slice(0, PASSAGE_MAX);
  return {
    found: {
      value: {
        fact: row.id,
        source,
        passage: { untrusted: served.join("") },
        chars: points.length,
        cut: points.length > PASSAGE_MAX,
        ...maskedField(found.counted(served.length)),
      },
      rows: 1,
      read: { ...found.read, factKeyFps: [row.fact_key_fp] },
      chars: served.length,
    },
    maskedWithin: (cut) => found.counted(Math.min(cut, served.length)),
  };
}

// The passage one fact cites, cut at 4 000 code points.
export const GET_EVIDENCE_SPAN_TOOL: ReadTool<GetEvidenceSpanArgs, EvidenceSpan> = {
  tool: "get_evidence_span",
  parse: (args) => parsed(GetEvidenceSpanArgs.safeParse(args)),
  work: (ctx, valid) => getEvidenceSpan(ctx, valid),
};
