import { BlockItem, EntityId, EventId, MeetingItem, MomentItem } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  captureBlock,
  captureFacts,
  meetingText,
  momentLines,
  SERVED_ID_PREFIXES,
  sourceOwnerWord,
  systemIdIn,
} from "./capture.ts";

// The capture functions. Made-up values on reserved domains only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = (time: string): string => `2026-10-01T${time}-05:00`;
const app = { bundle: "test.example.meet", name: "Meet" };
const CANARY = "CANARY-7Q2X";

const meeting = MeetingItem.parse({
  kind: "meeting",
  key: `meeting:${ULID}`,
  revision: 1,
  startedAt: at("10:00:00"),
  endedAt: at("10:30:00"),
  app,
  title: "Alpha review",
  account: "owner@example.com",
  consent: true,
  mode: "call",
  calendar: {
    start: at("10:00:00"),
    end: at("10:30:00"),
    title: "Alpha weekly",
    uid: "series-alpha@example.com",
    organizer: { address: "lee@example.com" },
    attendees: [{ name: "Lee Example", address: "lee@example.com" }],
  },
  speakers: [
    { label: "S1", owner: true, mention: { address: "owner@example.com" } },
    { label: "S2", owner: false, mention: { name: "Lee Example", address: "lee@example.com" } },
  ],
  segments: [
    { speaker: "S1", fromMs: 0, toMs: 2000, channel: "input", text: `Hello ${CANARY} one.` },
    { speaker: "S2", fromMs: 2000, toMs: 4000, channel: "output", text: "I will send the deck by Friday." },
    { speaker: null, fromMs: 4000, toMs: 5000, channel: "mixed", text: "Thanks." },
  ],
  host: "meet.example.com",
});
const moment = MomentItem.parse({
  kind: "moment",
  key: `moment:${ULID}`,
  revision: 0,
  observedAt: at("09:00:00"),
  endedAt: at("09:05:00"),
  app: { bundle: "test.example.reader", name: "Reader" },
  window: "Alpha plan",
  url: "https://wiki.example.org/teams/alpha",
  account: "owner@example.com",
  entity: "doc",
  thread: "Alpha",
  participants: [{ name: "Lee Example" }],
  document: "~/test/alpha/plan.md",
  repository: "git.example.org/owner/alpha",
  text: `The plan ${CANARY} two.`,
  read: "ax",
});
const block = BlockItem.parse({
  kind: "block",
  key: `block:${ULID}`,
  revision: 0,
  day: "2026-10-01",
  blocks: [
    {
      start: at("09:00:00"),
      end: at("09:30:00"),
      minutes: 30,
      app,
      title: "Alpha review",
      host: "meet.example.com",
      account: "owner@example.com",
    },
    {
      start: at("10:00:00"),
      end: at("10:12:00"),
      minutes: 12.5,
      app: { bundle: "test.example.reader", name: "Reader" },
    },
  ],
});
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("systemIdIn", () => {
  it("an ent_ or msg_ id with a ULID, an mpr_ or mir_ id with 40 hexadecimal characters, an memory-adapters stamp and an i6 handle are each found, and the word ent_ alone is not", () => {
    for (const text of [
      `see ent_${ULID} here`,
      `msg_${ULID}`,
      `(mpr_${"a1".repeat(20)})`,
      `mir_${"0f".repeat(20)}.`,
      "a line [pi:mpr_0 f:1 s:2]",
      `hdl_${ULID}`,
      `cap_${ULID}`,
      `cin_${ULID}`,
      `csr_${ULID}`,
      `mcr_${ULID}`,
    ]) {
      expect(systemIdIn(text), text).toBe(true);
    }
    for (const text of [
      "the word ent_ alone",
      "ent_123",
      `ent_${ULID.toLowerCase()}`,
      `mpr_${"a".repeat(39)}`,
      "pi: a note",
      "",
      "Lee Example",
    ])
      expect(systemIdIn(text), text).toBe(false);
  });

  it("the served forms are a frozen list holding Lens's four", () => {
    expect(Object.isFrozen(SERVED_ID_PREFIXES)).toBe(true);
    for (const prefix of ["ent", "msg", "cap", "cin", "csr", "mcr", "hdl", "pan"])
      expect(SERVED_ID_PREFIXES, prefix).toContain(prefix);
  });
});

describe("captureBlock", () => {
  it("captureBlock gives the same bytes for the same item in any key order, sorted and with no white space", () => {
    const reordered = Object.fromEntries(Object.entries(moment).reverse()) as MomentItem;
    const bytes = captureBlock(moment);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(captureBlock(reordered)).toEqual(bytes);
    const text = decode(bytes);
    expect(JSON.parse(text)).toEqual(moment);
    expect(text.startsWith('{"account":')).toBe(true);
    expect(text).not.toMatch(/":\s|,\s"|\n/);
    // The control: another item gives other bytes.
    expect(captureBlock({ ...moment, revision: 1 })).not.toEqual(bytes);
  });

  it("captureBlock of a block day cut to one compartment holds only the blocks given", () => {
    const cut = { ...block, blocks: [block.blocks[0] as BlockItem["blocks"][number]] };
    const value = JSON.parse(decode(captureBlock(cut))) as BlockItem;
    expect(value.blocks).toEqual([block.blocks[0]]);
    expect((JSON.parse(decode(captureBlock(block))) as BlockItem).blocks).toHaveLength(2);
  });
});

describe("captureFacts", () => {
  it("captureFacts seals a source moment's source and handles, and no text or thread key", () => {
    const text = `Are we on for Saturday?\nYes, ten o'clock ${CANARY}.`;
    const source = MomentItem.parse({
      kind: "moment",
      key: `moment:${ULID}`,
      revision: 0,
      observedAt: at("09:00:00"),
      endedAt: at("09:02:00"),
      app: { bundle: "com.apple.MobileSMS", name: "Messages" },
      entity: "chat",
      participants: [{ handle: "+15555550101" }, { address: "robin@example.org" }],
      text,
      read: "db",
      turns: [
        { from: 0, to: 23, speaker: "participant", participant: 0, at: at("09:00:00") },
        { from: 24, to: text.length, speaker: "owner", at: at("09:02:00") },
      ],
      source: "imessage",
      threadKey: "chat:01JABCDEFGHJKMNPQRSTVWXYZ1",
    });
    const facts = captureFacts(source, { linkedEvent: null, pushedAt: "2026-10-01T14:30:00.000Z" });
    expect(facts).toMatchObject({
      kind: "moment",
      entity: "chat",
      source: "imessage",
      thread: null,
      participants: [{ handle: "+15555550101" }, { address: "robin@example.org" }],
      pushedAt: "2026-10-01T14:30:00.000Z",
    });
    const sealed = JSON.stringify(facts);
    for (const absent of [CANARY, "Saturday", "chat:01JABCDEFGHJKMNPQRSTVWXYZ1"]) expect(sealed).not.toContain(absent);
    expect(captureFacts(moment, { linkedEvent: null })).not.toHaveProperty("source");
    // The drain's vouched mark, on a source moment alone.
    expect(captureFacts(source, { linkedEvent: null, vouched: true })).toMatchObject({ vouched: true });
    expect(captureFacts(source, { linkedEvent: null, vouched: false })).not.toHaveProperty("vouched");
    expect(captureFacts(moment, { linkedEvent: null, vouched: true })).not.toHaveProperty("vouched");
  });

  // A source moment's facts seal its lines, who sent each turn
  // and when, and nothing of their text; a screen chat's and a page's seal none.
  const chat = (
    turns: { speaker: "owner" | "participant"; participant?: number; at: string }[],
    participants = [{ handle: "+15555550101" }, { address: "robin@example.org" }],
  ) => {
    const parts = turns.map((_, i) => `line ${i} ${CANARY}`);
    let from = 0;
    return MomentItem.parse({
      kind: "moment",
      key: `moment:${ULID}`,
      revision: 0,
      observedAt: at("09:00:00"),
      endedAt: at("09:10:00"),
      app: { bundle: "com.apple.MobileSMS", name: "Messages" },
      entity: "chat",
      participants,
      text: parts.join("\n"),
      read: "db",
      turns: turns.map((turn, i) => {
        const one = { from, to: from + (parts[i] as string).length, ...turn };
        from = one.to + 1;
        return one;
      }),
      source: "imessage",
      threadKey: "chat:01JABCDEFGHJKMNPQRSTVWXYZ1",
    });
  };

  it("a source moment's facts hold lines: handles in participants' order, one [who, at] per turn, −1 for the owner", () => {
    const item = chat([
      { speaker: "participant", participant: 0, at: at("09:00:00") },
      { speaker: "owner", at: at("09:01:00") },
      { speaker: "participant", participant: 1, at: at("09:02:00") },
    ]);
    const facts = captureFacts(item, { linkedEvent: null, pushedAt: "2026-10-01T14:30:00.000Z" });
    expect(facts).toMatchObject({
      lines: {
        handles: ["+15555550101", "robin@example.org"],
        turns: [
          [0, at("09:00:00")],
          [-1, at("09:01:00")],
          [1, at("09:02:00")],
        ],
      },
    });
    // No text, offset or length: the canary is nowhere, and each turn is exactly its two fields.
    const sealed = JSON.stringify(facts);
    expect(sealed).not.toContain(CANARY);
    expect(sealed).not.toContain("line 0");
    if (facts.kind !== "moment" || facts.lines === undefined) throw new Error("no lines");
    for (const turn of facts.lines.turns) expect(turn).toHaveLength(2);
    expect(Object.keys(facts.lines).sort()).toEqual(["handles", "turns"]);
  });

  it("turns are ordered by time, then by their order for equal times", () => {
    const same = at("09:03:00");
    const lines = momentLines(
      chat([
        { speaker: "participant", participant: 0, at: at("09:01:00") },
        { speaker: "owner", at: same },
        { speaker: "participant", participant: 1, at: same },
      ]),
    );
    expect(lines?.turns).toEqual([
      [0, at("09:01:00")],
      [-1, same],
      [1, same],
    ]);
  });

  it("a screen chat's facts, a page's and a doc moment's hold no lines", () => {
    const text = "Are we on?\nYes.";
    const screen = MomentItem.parse({
      kind: "moment",
      key: `moment:${ULID}`,
      revision: 0,
      observedAt: at("09:00:00"),
      endedAt: at("09:02:00"),
      app: { bundle: "test.example.chat", name: "Chat" },
      entity: "chat",
      participants: [{ name: "Lee Example" }],
      text,
      read: "ax",
      turns: [
        { from: 0, to: 10, speaker: "participant", participant: 0 },
        { from: 11, to: text.length, speaker: "owner" },
      ],
    });
    expect(captureFacts(screen, { linkedEvent: null })).not.toHaveProperty("lines");
    expect(momentLines(screen)).toBeUndefined();
    expect(captureFacts(moment, { linkedEvent: null })).not.toHaveProperty("lines");
    const page = MomentItem.parse({
      ...moment,
      entity: "page",
      text: "Alpha",
      participants: [],
      window: undefined,
      document: undefined,
      repository: undefined,
      thread: undefined,
    });
    expect(captureFacts(page, { linkedEvent: null })).not.toHaveProperty("lines");
  });

  it("the owner's word holds 6 hours after the end, not 7, and always inside the vouched window", () => {
    const end = "2026-10-01T14:00:00.000Z";
    const after = (hours: number) => new Date(Date.parse(end) + hours * 3_600_000).toISOString();
    expect(sourceOwnerWord({ source: "imessage", pushedAt: after(6) }, end)).toBe(true);
    expect(sourceOwnerWord({ source: "imessage", pushedAt: after(7) }, end)).toBe(false);
    expect(sourceOwnerWord({ source: "imessage", pushedAt: after(7), vouched: true }, end)).toBe(true);
    // A vouch counts only on a source moment; facts with no push time make no word.
    expect(sourceOwnerWord({ pushedAt: after(7), vouched: true }, end)).toBe(false);
    expect(sourceOwnerWord({ source: "imessage" }, end)).toBe(false);
  });

  it("captureFacts holds no text: a canary in a segment and a moment's text is in no field; a title is kept as its field", () => {
    for (const item of [meeting, moment, block]) {
      const facts = JSON.stringify(captureFacts(item, { linkedEvent: null }));
      expect(facts, item.kind).not.toContain(CANARY);
      expect(facts).not.toContain("I will send the deck");
      expect(facts).not.toContain("The plan");
    }
    // What it keeps: the fields and the counts.
    const meetingFacts = captureFacts(meeting, { linkedEvent: null });
    expect(meetingFacts).toMatchObject({
      kind: "meeting",
      app,
      title: "Alpha review",
      account: "owner@example.com",
      host: "meet.example.com",
      calendar: {
        title: "Alpha weekly",
        uid: "series-alpha@example.com",
        organizer: { address: "lee@example.com" },
        attendees: [{ name: "Lee Example", address: "lee@example.com" }],
      },
      speakers: [
        { label: "S1", owner: true, mention: { address: "owner@example.com" } },
        { label: "S2", owner: false, mention: { name: "Lee Example", address: "lee@example.com" } },
      ],
      counts: { segments: 3, chars: [...`Hello ${CANARY} one.`].length + 31 + 7, minutes: 30, blanked: 0 },
    });
    expect(captureFacts(moment, { linkedEvent: null })).toMatchObject({
      kind: "moment",
      window: "Alpha plan",
      url: "https://wiki.example.org/teams/alpha",
      thread: "Alpha",
      document: "~/test/alpha/plan.md",
      repository: "git.example.org/owner/alpha",
      participants: [{ name: "Lee Example" }],
      counts: { chars: [...`The plan ${CANARY} two.`].length },
    });
    expect(captureFacts(block, { linkedEvent: null })).toMatchObject({
      kind: "block",
      day: "2026-10-01",
      counts: { blocks: 2, minutes: 42.5 },
    });
    const blanked = {
      ...meeting,
      segments: meeting.segments.map((segment, index) => (index === 0 ? { ...segment, text: "" } : segment)),
    };
    expect(captureFacts(blanked, { linkedEvent: null })).toMatchObject({ counts: { blanked: 1 } });
  });

  it("captureFacts of a linked meeting holds the event's owner-backing and each speaker's participant, and of an unlinked one neither", () => {
    const event = EventId.parse(`evt_${ULID}`);
    const lee = EntityId.parse(`ent_${ULID}`);
    const linked = captureFacts(meeting, { linkedEvent: { id: event, ownerBacked: true, speakers: { S2: lee } } });
    expect(linked).toMatchObject({ linked: { event, ownerBacked: true, speakers: { S2: lee } } });
    expect(captureFacts(meeting, { linkedEvent: null })).toMatchObject({ linked: null });
    // Only a meeting is linked.
    expect(() => captureFacts(moment, { linkedEvent: { id: event, ownerBacked: true, speakers: {} } })).toThrow();
  });

  it("a meeting's facts carry the revision's push time when given, and none otherwise", () => {
    const at = "2026-10-01T15:00:00.000Z";
    expect(captureFacts(meeting, { linkedEvent: null, pushedAt: at })).toMatchObject({ kind: "meeting", pushedAt: at });
    expect(captureFacts(meeting, { linkedEvent: null })).not.toHaveProperty("pushedAt");
  });

  it("a meeting's owner-typed attendees are sealed as mentions, an email as the address; none when it has none", () => {
    const typed = {
      ...meeting,
      attendees: [{ name: "Lee Moss" }, { name: "Devon Ash", email: "devon.ash@example.net" }],
    };
    expect(captureFacts(typed, { linkedEvent: null })).toMatchObject({
      attendees: [{ name: "Lee Moss" }, { name: "Devon Ash", address: "devon.ash@example.net" }],
    });
    expect(captureFacts(meeting, { linkedEvent: null })).not.toHaveProperty("attendees");
  });

  it("a moment's facts carry the revision's push time when given, and none otherwise; no word of its text or turns", () => {
    const at = "2026-10-01T15:00:00.000Z";
    expect(captureFacts(moment, { linkedEvent: null, pushedAt: at })).toMatchObject({ kind: "moment", pushedAt: at });
    expect(captureFacts(moment, { linkedEvent: null })).not.toHaveProperty("pushedAt");
    const facts = captureFacts(moment, { linkedEvent: null, pushedAt: at });
    expect(facts).not.toHaveProperty("turns");
    expect(facts).not.toHaveProperty("text");
  });
});

describe("meetingText", () => {
  it("meetingText puts each segment on its line as S<n>: text, and each seg:<i> slices it back", () => {
    const { text, spans } = meetingText(meeting);
    expect(text).toBe(`S1: Hello ${CANARY} one.\nS2: I will send the deck by Friday.\nS?: Thanks.`);
    expect(spans.map((span) => span.segment)).toEqual(["seg:0", "seg:1", "seg:2"]);
    spans.forEach((span, index) => {
      expect(text.slice(span.from, span.to)).toBe(meeting.segments[index]?.text);
    });
    // Offsets are UTF-16 code units: a four-byte character counts two.
    const wide = {
      ...meeting,
      segments: [
        { ...meeting.segments[0], text: "\u{1F600} hi" } as MeetingItem["segments"][number],
        meeting.segments[1] as MeetingItem["segments"][number],
      ],
    };
    const second = meetingText(wide).spans[1];
    expect(meetingText(wide).text.slice(second?.from, second?.to)).toBe("I will send the deck by Friday.");
  });

  it("a meeting's notes follow its segments on a line of their own as Notes: text, their span `notes`; the segments' spans are unchanged", () => {
    const plain = meetingText(meeting);
    const noted = meetingText({ ...meeting, notes: "Tiles ordered.\nDeck Friday." });
    expect(noted.text).toBe(`${plain.text}\nNotes: Tiles ordered.\nDeck Friday.`);
    expect(noted.spans.slice(0, -1)).toEqual(plain.spans);
    const notes = noted.spans.at(-1);
    expect(notes?.segment).toBe("notes");
    expect(noted.text.slice(notes?.from, notes?.to)).toBe("Tiles ordered.\nDeck Friday.");
    expect(meetingText({ ...meeting, segments: [], notes: "Only notes." }).text).toBe("Notes: Only notes.");
    expect(meetingText({ ...meeting, notes: "" } as MeetingItem).text).toBe(plain.text);
  });
});
