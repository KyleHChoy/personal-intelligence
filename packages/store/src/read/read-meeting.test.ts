import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEETING_TEXT_PER_CALL,
  MEETING_TURNS_PER_CALL,
  type MeetingSegment,
  type SessionId,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { log } from "../test-support/unit.ts";
import { meetingPassage, meetingView, TRANSCRIPT, type TranscriptRow } from "./read-meeting.ts";

// What read_meeting makes of the row its definer answers: the page's turns and its caps, blanked
// segments, masking, the owner's notes and the meeting's people, and get_evidence_span's passage of
// a meeting fact. Which rows a caller is answered is read-meeting.db.test.ts's.

let dir = "";
let keys: Keys;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-read-meeting-"));
  await generateKeyFile(join(dir, "keys.json"), ["own"]);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OWN = ["own"];
const CAPTURE = `cap_${"0".repeat(26)}`;
const BLOB = `blb_${"0".repeat(26)}`;
const START = new Date("2026-01-05T10:00:00.000Z");
const ctx = (): Ctx => ({
  run: async () => [],
  keys,
  session: async () => "ses_x" as SessionId,
  log,
});

const segment = (text: string, n: number, speaker: string | null = "S1"): MeetingSegment => ({
  speaker,
  fromMs: n * 1_000,
  toMs: n * 1_000 + 500,
  channel: "input",
  text,
});

function row(segments: MeetingSegment[], notes?: string): TranscriptRow {
  const item = {
    kind: "meeting",
    key: `meeting:${"0".repeat(26)}`,
    revision: 0,
    startedAt: START.toISOString(),
    endedAt: new Date(START.getTime() + 3_600_000).toISOString(),
    app: { bundle: "test.seed.call", name: "Seed Call" },
    consent: true,
    mode: "room",
    speakers: [
      { label: "S1", owner: true },
      { label: "S2", owner: false },
    ],
    segments,
    ...(notes === undefined ? {} : { notes }),
  };
  const facts = {
    kind: "meeting",
    app: item.app,
    title: null,
    calendar: {
      title: "Planning",
      uid: null,
      organizer: { name: "Rhea Alder" },
      attendees: [{ address: "rhea@alder.example" }],
    },
    attendees: [{ name: "Jo Fenn" }],
    speakers: [
      { label: "S1", owner: true, mention: null },
      { label: "S2", owner: false, mention: { name: "Rhea Alder" } },
    ],
    linked: null,
  };
  return {
    capture_id: CAPTURE,
    evidence_id: "e".repeat(64),
    started_at: START,
    ended_at: new Date(START.getTime() + 3_600_000),
    compartments: OWN,
    facts_enc: sealUnder(
      keys,
      OWN,
      { table: "knowledge.captures", id: CAPTURE, column: "facts_enc" },
      JSON.stringify(facts),
    ),
    evidence_compartments: OWN,
    blob_ref: BLOB,
    envelope: sealUnder(
      keys,
      OWN,
      { table: "vault.evidence_blobs", id: BLOB, column: "envelope" },
      Buffer.from(JSON.stringify(item)).toString("base64"),
    ),
  };
}

describe("read_meeting's page", () => {
  it("serves the facts' title, people and mode, and each turn at the meeting's start plus its offset", () => {
    const view = meetingView(ctx(), row([segment("Shall we start?", 0), segment("Yes.", 2, "S2")]), 0);
    expect(view).toMatchObject({
      meeting: CAPTURE,
      startedAt: START.toISOString(),
      app: { untrusted: "Seed Call" },
      title: { untrusted: "Planning" },
      mode: "room",
      organizer: { name: { untrusted: "Rhea Alder" }, address: null },
      attendees: [
        { name: null, address: { untrusted: "rhea@alder.example" } },
        { name: { untrusted: "Jo Fenn" }, address: null },
      ],
      notes: null,
      next: null,
    });
    expect(view.speakers[1]).toEqual({
      label: "S2",
      owner: false,
      person: { name: { untrusted: "Rhea Alder" }, address: null },
    });
    expect(view.turns[1]).toEqual({
      index: 1,
      speaker: "S2",
      at: "2026-01-05T10:00:02.000Z",
      text: { untrusted: "Yes." },
    });
  });

  it("serves no turn for a segment the recovery check blanked, and keeps every other's index", () => {
    const view = meetingView(ctx(), row([segment("One.", 0), segment("", 1), segment("Three.", 2)]), 0);
    expect(view.turns.map((one) => [one.index, one.text.untrusted])).toEqual([
      [0, "One."],
      [2, "Three."],
    ]);
  });

  it("stops at the turn cap and at the text cap, with next the first turn left, and always serves one turn", () => {
    const many = Array.from({ length: MEETING_TURNS_PER_CALL + 5 }, (_, n) => segment(`Turn ${n}.`, n));
    const first = meetingView(ctx(), row(many), 0);
    expect(first.turns).toHaveLength(MEETING_TURNS_PER_CALL);
    expect(first.next).toBe(MEETING_TURNS_PER_CALL);
    const rest = meetingView(ctx(), row(many), first.next ?? 0);
    expect(rest.turns.map((one) => one.index)).toEqual([200, 201, 202, 203, 204]);
    expect(rest.next).toBeNull();

    const long = Array.from({ length: 8 }, (_, n) => segment("a".repeat(4_000), n));
    const page = meetingView(ctx(), row(long), 0);
    expect(page.turns).toHaveLength(MEETING_TEXT_PER_CALL / 4_000);
    expect(page.next).toBe(MEETING_TEXT_PER_CALL / 4_000);
  });

  it("masks credential-shaped values in a turn and counts them", () => {
    const key = `ghp_${"a1".repeat(18)}`;
    const view = meetingView(ctx(), row([segment(`the token is ${key} ok`, 0)]), 0);
    expect(view.turns[0]?.text.untrusted).toBe(`the token is ghp_${"*".repeat(36)} ok`);
    expect(view.masked).toBe(1);
  });

  it("serves the owner's notes, masked, on the page from turn 0 alone", () => {
    const key = `ghp_${"b2".repeat(18)}`;
    const meeting = row([segment("One.", 0), segment("Two.", 1)], `Follow up; token ${key}`);
    const first = meetingView(ctx(), meeting, 0);
    expect(first.notes).toEqual({ untrusted: `Follow up; token ghp_${"*".repeat(36)}` });
    expect(first.masked).toBe(1);
    expect(meetingView(ctx(), meeting, 1)).toMatchObject({ notes: null });
  });

  it("serves a meeting of notes alone: no turns, its notes, nothing to read on", () => {
    const view = meetingView(ctx(), row([], "Agreed the spring budget."), 0);
    expect(view).toMatchObject({ turns: [], notes: { untrusted: "Agreed the spring budget." }, next: null });
  });
});

describe("a meeting fact's passage", () => {
  // The claim as the lane stores it, citing `span` of the meeting's evidence, and a runner that
  // answers the definer with the meeting.
  const passageOf = (meeting: TranscriptRow, span: string) => {
    const made = claimRecord(meeting.evidence_id, "own", `ent_${"0".repeat(26)}`, { factKey: "k-meeting" });
    const record = { ...made, claim: { ...made.claim, evidence: [{ evidenceId: meeting.evidence_id, span }] } };
    const claim = {
      id: made.claim.id,
      compartments: OWN,
      content_enc: sealUnder(
        keys,
        OWN,
        { table: "knowledge.claims", id: made.claim.id, column: "content_enc" },
        JSON.stringify(record),
      ),
    };
    const answering: Ctx = {
      ...ctx(),
      run: async <Row>(text: string) => (text === TRANSCRIPT ? [meeting] : []) as Row[],
    };
    return meetingPassage(answering, claim, meeting.evidence_id);
  };

  it("a claim citing the notes is given the notes' line; one citing a turn, that turn's line", async () => {
    // meetingText: "S1: One.\nNotes: Bring the plans." The notes' text starts at 16.
    const meeting = row([segment("One.", 0)], "Bring the plans.");
    expect((await passageOf(meeting, "chars:16-32"))?.passage.text).toBe("Notes: Bring the plans.");
    expect((await passageOf(meeting, "seg:4-8"))?.passage.text).toBe("S1: One.");
    expect(await passageOf(meeting, "chars:40-50")).toBeNull();
  });
});
