import type { ReadMeetingArgs, ReadMeetingResult } from "@intelligence/contracts/personal";
import { type Done, isRefused, refused, type WorkCall } from "../core/work-refs.ts";
import { meetingView, TRANSCRIPT, type TranscriptRow } from "../read/read-meeting.ts";

// read_meeting, as pi_reader: one recorded meeting the caller is cleared for, its turns paged from
// `from` and the owner's typed notes. The definer answers a meeting outside the caller's label, a
// forgotten one and an id that names nothing alike, with no row: each is not_found. The meeting's
// evidence is bound in the read log, as a message read whole is, so a forget removes what a session
// wrote from it.

export async function readMeeting(call: WorkCall, valid: ReadMeetingArgs): Promise<Done<ReadMeetingResult>> {
  const rows = await call.fn<TranscriptRow>(TRANSCRIPT, [await call.session(), valid.meeting, null]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined) return refused("not_found");
  return {
    outcome: { ok: true, value: meetingView(call.ctx, row, valid.from ?? 0) },
    rows: 1,
    bound: [row.evidence_id],
  };
}
