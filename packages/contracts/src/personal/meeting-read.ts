import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { CaptureId, Handle } from "./ids.ts";
import type { PersonalWorkTool } from "./tools.ts";
import { UntrustedString } from "./tools-args.ts";

// read_meeting: a recorded meeting's transcript and the owner's typed notes, for an agent cleared
// for its label. No shape here has a key for a label, a compartment or a reader. Every value a
// source wrote is under untrusted: a turn's text, the notes, the title, the app's name and each
// person as the meeting's facts hold them.

// The most turns one call serves, and the most code points of their text; past either, `next`.
export const MEETING_TURNS_PER_CALL = 200;
export const MEETING_TEXT_PER_CALL = 20_000;

const count = z.number().int().nonnegative();
// Credential-shaped values masked in the text a result carries.
const masked = z.number().int().positive();

// `meeting`: a cap_ id from get_timeline's captured_meeting, a meeting fact's `capture` in
// find_facts or a pack's `lastCapture`. `from`: the turn to start at, the `next` a page answered.
export const ReadMeetingArgs = z.strictObject({
  meeting: CaptureId.or(Handle),
  from: count.optional(),
});
export type ReadMeetingArgs = z.infer<typeof ReadMeetingArgs>;

// A person as the meeting's facts name them: a name, an address, or both.
const MeetingPerson = z.strictObject({ name: UntrustedString.nullable(), address: UntrustedString.nullable() });

// One turn: its segment's index in the meeting, which `from` takes, its speaker's label (S1, S2...;
// null when the source has no diarization), when it was said and what. A segment the recovery check
// blanked is no turn.
export const MeetingTurn = z.strictObject({
  index: count,
  speaker: z
    .string()
    .regex(/^S[1-9][0-9]?$/)
    .nullable(),
  at: Timestamp,
  text: UntrustedString,
});
export type MeetingTurn = z.infer<typeof MeetingTurn>;

// `speakers`: each label, whether it is the owner's, and the person its facts name. `attendees`:
// the calendar entry's organizer and attendees and the people the owner typed as there.
// `notes`: the owner's typed notes, on the page that starts at the first turn, null with none.
// `next`: the turn to read on from, null at the end.
export const ReadMeetingResult = z.strictObject({
  meeting: CaptureId.or(Handle),
  startedAt: Timestamp,
  endedAt: Timestamp,
  app: UntrustedString,
  title: UntrustedString.nullable(),
  mode: z.enum(["call", "room"]),
  speakers: z
    .array(z.strictObject({ label: z.string(), owner: z.boolean(), person: MeetingPerson.nullable() }))
    .max(50),
  organizer: MeetingPerson.nullable(),
  attendees: z.array(MeetingPerson).max(400),
  turns: z.array(MeetingTurn).max(MEETING_TURNS_PER_CALL),
  notes: UntrustedString.nullable(),
  from: count,
  next: count.nullable(),
  masked: masked.optional(),
});
export type ReadMeetingResult = z.infer<typeof ReadMeetingResult>;

export const MEETING_READ_ARGS = Object.freeze({ read_meeting: ReadMeetingArgs } satisfies Partial<
  Record<PersonalWorkTool, z.ZodType>
>);
export const MEETING_READ_RESULTS = Object.freeze({ read_meeting: ReadMeetingResult } satisfies Partial<
  Record<PersonalWorkTool, z.ZodType>
>);
