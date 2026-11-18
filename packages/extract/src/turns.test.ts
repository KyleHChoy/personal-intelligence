import type { MeetingItem, MeetingSegment } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fragmentation, meetingPassages, repairTurns } from "./turns.ts";

// A meeting's notes as the meeting lane reads them: pure functions over synthetic items.

const segment = (
  speaker: string | null,
  at: number,
  channel: MeetingSegment["channel"],
  text: string,
): MeetingSegment => ({
  speaker,
  fromMs: at * 1000,
  toMs: at * 1000 + 900,
  channel,
  text,
});
const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: "meeting:01JTVRNSNTES0000000000000001",
  revision: 0,
  startedAt: "2026-03-02T15:00:00Z",
  endedAt: "2026-03-02T15:30:00Z",
  app: { bundle: "test.example.meet", name: "Meet" },
  title: "Porch plan",
  consent: true,
  mode: "call",
  speakers: [
    { label: "S1", owner: true, mention: { address: "owner@example.org" } },
    { label: "S2", owner: false, mention: { name: "Robin Vale", address: "robin.vale@example.org" } },
  ],
  segments: [segment("S1", 0, "input", "First."), segment("S2", 1, "output", "Second.")],
  ...over,
});

describe("a meeting's notes", () => {
  it("a meeting's notes are one passage after the segments, the owner's, never joined into a turn nor counted in the label measures", () => {
    const item = meeting({ notes: "I will order the tiles tomorrow." });
    const { text, passages } = meetingPassages(item);
    expect(text).toBe("S1: First.\nS2: Second.\nNotes: I will order the tiles tomorrow.");
    const last = passages.at(-1);
    expect(last).toMatchObject({
      speaker: "S1",
      channel: "input",
      text: "I will order the tiles tomorrow.",
      notes: true,
    });
    expect(text.slice(last?.from, last?.to)).toBe("I will order the tiles tomorrow.");
    expect(repairTurns(passages, true).at(-1)?.text).toBe("I will order the tiles tomorrow.");
    expect(repairTurns(passages, false).at(-1)?.text).toBe("I will order the tiles tomorrow.");
    expect(fragmentation(passages)).toEqual(fragmentation(passages.slice(0, -1)));
  });

  it("notes alone are one passage, nobody's label when no speaker is the owner; notes R22 blanked are none", () => {
    const alone = meetingPassages(meeting({ speakers: [], segments: [], notes: "Agreed the plan." }));
    expect(alone.passages).toMatchObject([{ speaker: null, text: "Agreed the plan.", notes: true }]);
    expect(meetingPassages(meeting({ notes: "" })).passages).toHaveLength(2);
  });
});
