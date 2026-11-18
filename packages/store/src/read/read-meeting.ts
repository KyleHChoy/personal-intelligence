import type { Envelope } from "@intelligence/contracts";
import {
  type CaptureId,
  type CaptureMention,
  ClaimRecord,
  MEETING_TEXT_PER_CALL,
  MEETING_TURNS_PER_CALL,
  type MeetingTurn,
  type ReadMeetingResult,
  StoredMeetingItem,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import { maskCredentials, maskedSpans } from "@intelligence/personal-core";
import { type CaptureFacts, meetingText } from "@intelligence/personal-core/lens";
import { stamp } from "../core/db.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { served, servedJson } from "../core/served.ts";

// A recorded meeting as an agent reads it: read_meeting's
// transcript and notes, and get_evidence_span's passage of a meeting fact. One definer,
// ledger.meeting_transcript, gates the caller (the tool, its view, its own session) and answers the
// capture row and its evidence's sealed blob only within the caller's clearance; pi_reader holds no
// grant on the vault. Both are opened here under the call's own keys, which open only the
// compartments the caller is cleared for. Nothing is stored. The facts give the meeting's people, as
// a person's erasure leaves them; the blob gives the turns and the notes.

export const TRANSCRIPT = `select capture_id, evidence_id, started_at, ended_at, compartments, facts_enc, evidence_compartments, blob_ref, envelope
  from ledger.meeting_transcript($1, $2, $3)`;

export type TranscriptRow = {
  capture_id: string;
  evidence_id: string;
  started_at: Date;
  ended_at: Date;
  compartments: string[];
  facts_enc: Envelope;
  evidence_compartments: string[];
  blob_ref: string;
  envelope: Envelope;
};

type MeetingFacts = Extract<CaptureFacts, { kind: "meeting" }>;
type Opened = { item: StoredMeetingItem; facts: MeetingFacts | null };

// The meeting a fact's passage names by its evidence id, as the definer answers it to the caller;
// none when it answers no row. read_meeting names its capture id (work-meeting.ts).
const meetingByEvidence = (ctx: Ctx, session: string, evidence: string) =>
  ctx.run<TranscriptRow>(TRANSCRIPT, [session, null, evidence]);

// The blob, as the drain sealed it under the evidence row's whole label: base64 of the
// stored item's JSON. The facts, sealed under the capture row's label. A value that does not open or
// parse is a stored value that does not open.
const BLOB = "vault.evidence_blobs.envelope";
function openedMeeting(ctx: Ctx, row: TranscriptRow): Opened {
  let item: StoredMeetingItem;
  try {
    const blob = served(ctx, { ...row, id: row.blob_ref, compartments: row.evidence_compartments }, BLOB);
    const json = Buffer.from(blob.untrusted, "base64").toString("utf8");
    item = StoredMeetingItem.parse(JSON.parse(json));
  } catch {
    throw new Unavailable();
  }
  const facts = servedJson(
    ctx,
    { id: row.capture_id, compartments: row.compartments, facts_enc: row.facts_enc },
    "knowledge.captures.facts_enc",
  ) as MeetingFacts | { kind?: unknown } | null;
  return { item, facts: facts !== null && facts.kind === "meeting" ? (facts as MeetingFacts) : null };
}

// The owner's typed notes, which a stored item carries once the store keeps them; an item with none,
// or with notes the recovery check blanked, has no notes.
function notesOf(item: StoredMeetingItem): string | null {
  return item.notes === undefined || item.notes === "" ? null : item.notes;
}

const wrap = (text: string | null | undefined): UntrustedString | null =>
  text === null || text === undefined ? null : { untrusted: text };
const person = (mention: CaptureMention | null | undefined) =>
  mention === null || mention === undefined
    ? null
    : { name: wrap(mention.name ?? mention.handle), address: wrap(mention.address) };
const points = (text: string): number => Array.from(text).length;

// read_meeting's page from turn `from`: at most MEETING_TURNS_PER_CALL turns and
// MEETING_TEXT_PER_CALL code points of their text, but always the first turn left; credential-shaped
// values masked, `masked` counting them.
export function meetingView(ctx: Ctx, row: TranscriptRow, from: number): ReadMeetingResult {
  const { item, facts } = openedMeeting(ctx, row);
  const start = row.started_at.getTime();
  let masked = 0;
  const maskedText = (text: string): UntrustedString => {
    const done = maskCredentials(text);
    masked += done.masked;
    return { untrusted: done.text };
  };
  const said = item.segments.flatMap((segment, index) => (segment.text === "" ? [] : [{ segment, index }]));
  const turns: MeetingTurn[] = [];
  let chars = 0;
  let next: number | null = null;
  for (const { segment, index } of said) {
    if (index < from) continue;
    const length = points(segment.text);
    if (turns.length === MEETING_TURNS_PER_CALL || (turns.length > 0 && chars + length > MEETING_TEXT_PER_CALL)) {
      next = index;
      break;
    }
    chars += length;
    turns.push({
      index,
      speaker: segment.speaker,
      at: new Date(start + segment.fromMs).toISOString(),
      text: maskedText(segment.text),
    });
  }
  const notes = from === 0 ? notesOf(item) : null;
  const calendar = facts?.calendar ?? null;
  return {
    meeting: row.capture_id as CaptureId,
    startedAt: stamp(row.started_at),
    endedAt: stamp(row.ended_at),
    app: { untrusted: facts?.app?.name ?? item.app.name },
    title: wrap(facts?.title ?? calendar?.title ?? item.title),
    mode: facts?.mode ?? item.mode,
    speakers: (facts?.speakers ?? []).map((one) => ({
      label: one.label,
      owner: one.owner,
      person: person(one.mention),
    })),
    organizer: person(calendar?.organizer),
    attendees: [...(calendar?.attendees ?? []), ...(facts?.attendees ?? [])].flatMap((one) => {
      const found = person(one);
      return found === null ? [] : [found];
    }),
    turns,
    notes: notes === null ? null : maskedText(notes),
    from,
    next,
    ...(masked > 0 ? { masked } : {}),
  };
}

// A span the meeting lane stores: offsets into meetingText, `seg:` as the model is shown them or
// `chars:` as the shared checker reads them.
type ClaimSealed = SealedRow<"knowledge.claims.content_enc">;
const SPAN = /^(?:seg|chars):(\d+)-(\d+)$/;

// The ranges a claim cites in its own meeting: each of its passages whose evidence id is the row's.
function citedRanges(ctx: Ctx, claim: ClaimSealed, evidence: string): { from: number; to: number }[] {
  const parsed = ClaimRecord.safeParse(servedJson(ctx, claim, "knowledge.claims.content_enc"));
  if (!parsed.success) return [];
  return parsed.data.claim.evidence.flatMap((passage) => {
    if (passage.evidenceId !== evidence) return [];
    const found = SPAN.exec(passage.span);
    return found === null ? [] : [{ from: Number(found[1]), to: Number(found[2]) }];
  });
}

// get_evidence_span for a meeting fact: the turns the claim cites, each a line of
// meetingText (`S<n>: <text>`, the notes `Notes: <text>`), in order, joined by line breaks, masked
// whole. Null when the caller is not answered the meeting, or the claim cites no turn with text.
export async function meetingPassage(
  ctx: Ctx,
  claim: ClaimSealed,
  evidence: string,
): Promise<{ passage: { text: string; spans: ReturnType<typeof maskedSpans>["spans"] }; capture: string } | null> {
  const ranges = citedRanges(ctx, claim, evidence);
  if (ranges.length === 0) return null;
  const [row] = await meetingByEvidence(ctx, await ctx.session(), evidence);
  if (row === undefined) return null;
  const { item } = openedMeeting(ctx, row);
  const { text, spans } = meetingText(item);
  const lines = spans
    .filter((span) => span.to > span.from && ranges.some((range) => range.from <= span.to && range.to >= span.from))
    .map((span) => text.slice(text.lastIndexOf("\n", span.from) + 1, span.to));
  if (lines.length === 0) return null;
  return { passage: maskedSpans(lines.join("\n")), capture: row.capture_id };
}
