// Stored rows as pack items: the agent-record and preference queries, and the builders for a
// record, a preference, a meeting and the person. A record or preference whose body does not open
// under the caller's keys is left out with a trace of ids, so one bad row denies no client its pack.

import type { Envelope } from "@intelligence/contracts";
import {
  type AgentRecordId,
  type AgentRecordKind,
  type ClientName,
  type EntityView,
  isStatement,
  keyPhraseOf,
  type MeetingView,
  type PackEntity,
  type PackItem,
  type PackSection,
  parseProposalBody,
} from "@intelligence/contracts/personal";
import { maskedIn, maskedSpans } from "@intelligence/personal-core";
import type { PackTemplate } from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { openUnder } from "../core/seal.ts";
import { CORRECTED } from "../core/visibility.ts";

// The participants a meeting item carries.
const PARTICIPANTS = 25;

// The calling client's own latest handoff, removed or not: one
// row.
export const HANDOFF = `
  select w.id, w.kind, w.client_name, w.created_at, w.compartments, w.body_enc
  from ledger.agent_writes w
  where w.client_name = $1 and w.kind = 'handoff'
  order by w.created_at desc, w.id
  limit 1`;

// A section of a template. Each purpose's highest version, the one served, holds every section its
// read names; a read of one it lacks is a programming error.
export const sectionOf = (template: PackTemplate, name: PackSection) => {
  const found = template.sections.find((one) => one.name === name);
  if (found === undefined) throw new Error(`pack: ${template.purpose}@${template.version} has no section ${name}`);
  return found;
};

// The latest notes and findings of any client the caller may see, with a body. The row policy returns none outside the clearance, none whose writer held a view the caller lacks,
// and no flagged finding. None with a live correction, as policy.live_corrections, the one definition, answers it under the caller's row policy: a record that supersedes it, or
// supersedes one that does, down the chain, with a body. A caller that cannot see a correction (another label, a view its writer held, a flag) is served what it was served
// before (invariant 6), and a chain is followed past an erased link. Each row is asked for its own chain as the scan reaches it, so the limit stops the scan; the function is
// asked only of a row that a record the caller can read supersedes (one probe of agent_writes_supersedes, under the same row policy), and `case` keeps that order. A correction
// whose body does not open is left out as any record is, and so is what it replaced, while the correction remains unreadable.
export const NOTES_LEFT_OUT = `
  select w.id, w.kind, w.client_name, w.created_at, w.compartments, w.body_enc
  from ledger.agent_writes w
  where w.kind in ('note', 'finding') and w.body_enc is not null
    and not ${CORRECTED}
  order by w.created_at desc, w.id
  limit $1`;

// The database function is the one definition of which are served.
export const PREFERENCES =
  "select record_id, evidence_id, confirmed_at, compartments, body_enc from policy.confirmed_preferences()";

export type RecordRow = {
  id: AgentRecordId;
  kind: AgentRecordKind;
  client_name: ClientName;
  created_at: Date;
  compartments: string[];
  body_enc: Envelope | null;
};

// The faults of opening a sealed value: a key the call lacks, an envelope that is malformed, and
// one that does not authenticate (seal.ts, the crypto package's CryptoError).
const OPEN_FAILURES = new Set(["unknown_compartment", "bad_envelope", "open_failed"]);
const isOpenFailure = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  OPEN_FAILURES.has(error.code);

// An agent record's body, or null when the value does not open. Any other error is the call's and
// answers `unavailable`.
function recordBody(ctx: Ctx, id: string, compartments: string[], sealed: Envelope): string | null {
  try {
    return openUnder(ctx.keys, compartments, { table: "ledger.agent_writes", id, column: "body_enc" }, sealed);
  } catch (error) {
    if (!isOpenFailure(error)) throw error;
    return null;
  }
}

// An agent record as an item. A removed one (no body) is shown as removed. One whose body does not
// open under the caller's keys is left out, so that one bad row denies no client its pack. A
// compartment the keys lack here is one the key file lacks: rows outside the clearance were refused
// before this.
export function recordItem(
  ctx: Ctx,
  row: RecordRow,
  section: PackSection,
  required: boolean,
  cutChars: number | undefined,
): PackItem | null {
  const base = { id: row.id, kind: row.kind, client: row.client_name, at: stamp(row.created_at) };
  let record: Extract<PackItem, { kind: "record" }>["record"];
  if (row.body_enc === null) record = { ...base, id: row.id, body: null, chars: 0, cut: false, removed: true };
  else {
    const body = recordBody(ctx, row.id, row.compartments, row.body_enc);
    if (body === null) {
      // Only a value that does not open is left out, and it leaves this trace: ids, never content.
      ctx.log.warn({
        event: "pack_record_skipped",
        ids: { record: row.id, client: row.client_name },
      });
      return null;
    }
    // Cut by code points, never inside a character outside the basic plane.
    const masked = maskedSpans(body);
    const points = Array.from(masked.text);
    const cut = cutChars !== undefined && points.length > cutChars;
    const count = maskedIn(masked.spans, 0, Math.min(cutChars ?? points.length, points.length));
    record = {
      ...base,
      id: row.id,
      body: { untrusted: cut ? points.slice(0, cutChars).join("") : masked.text },
      chars: points.length,
      cut,
      removed: false,
      ...(count > 0 ? { masked: count } : {}),
    };
  }
  return { id: row.id, section, required, provenance: "agent_reported", asOf: base.at, kind: "record", record };
}

export type PreferenceRow = {
  record_id: AgentRecordId;
  evidence_id: string | null;
  confirmed_at: Date;
  compartments: string[];
  body_enc: Envelope;
};

// A confirmed client-scoped preference as an item: its body opened under
// its label and parsed as propose_about_you's arguments less requestId; only its `what` and
// `polarity` are served, never its quote, its cites or anything else of it. A body that does not
// open, or is not a this_client preference, is left out with one trace of ids, as recordItem
// leaves out a record; any other error is the call's.
export function preferenceItem(ctx: Ctx, row: PreferenceRow, required: boolean): PackItem | null {
  const skipped = (): null => {
    ctx.log.warn({ event: "pack_preference_skipped", ids: { record: row.record_id } });
    return null;
  };
  const body = recordBody(ctx, row.record_id, row.compartments, row.body_enc);
  if (body === null) return skipped();
  const proposal = parseProposalBody(body);
  if (
    proposal === null ||
    isStatement(proposal) ||
    proposal.kind !== "preference" ||
    proposal.scope !== "this_client" ||
    !("polarity" in proposal.fields)
  )
    return skipped();
  // The key phrase, a legacy body's `what`.
  const what = keyPhraseOf(proposal.kind, proposal.fields);
  if (what === undefined) return skipped();
  const confirmedAt = stamp(row.confirmed_at);
  return {
    kind: "preference",
    id: row.record_id,
    section: "preferences",
    required,
    // The owner confirmed it.
    provenance: "owner",
    asOf: confirmedAt,
    what: { untrusted: what },
    polarity: proposal.fields.polarity,
    confirmedAt,
  };
}

// A meeting's participants cut to 25.
const cutMeeting = (meeting: MeetingView): MeetingView => ({
  ...meeting,
  participants: meeting.participants.slice(0, PARTICIPANTS),
});

// A meeting as an item, its participants cut to 25 and the cut said.
export function meetingItem(meeting: MeetingView, section: PackSection, required: boolean, asOf: string): PackItem {
  const cut = meeting.participants.length > PARTICIPANTS;
  return {
    id: meeting.id,
    section,
    required,
    provenance: "source",
    asOf: meeting.startsAt ?? asOf,
    kind: "meeting",
    meeting: cutMeeting(meeting),
    cut,
  };
}

// person_brief's person: get_entity's view without its facts, which the facts section
// serves, and its last and next meetings' participants cut to 25, as every meeting of a pack is.
export function packEntity(view: EntityView): PackEntity {
  const { facts: _facts, ...entity } = view;
  return {
    ...entity,
    lastMeeting: entity.lastMeeting === null ? null : cutMeeting(entity.lastMeeting),
    nextMeeting: entity.nextMeeting === null ? null : cutMeeting(entity.nextMeeting),
  };
}
