import {
  BLOCK_DAY_MAX_BYTES,
  BLOCK_PAGES_MAX,
  BlockItem,
  BlockPage,
  BROWSER_BUNDLES,
  CaptureId,
  CaptureItem,
  CaptureKey,
  CaptureScopeRule,
  CaptureScopeRuleId,
  ClientRegistration,
  CommitmentItem,
  CREDENTIAL_SHAPED,
  deepFreeze,
  FactView,
  ForgetItem,
  isSourceAddress,
  LensDeviceView,
  MacContactItem,
  MacContactsListed,
  MEETING_ATTENDEES_MAX,
  MeetingItem,
  MOMENT_SOURCE_BUNDLES,
  MOMENT_TURNS_MAX,
  MomentItem,
  MULTI_ACCOUNT_SURFACES,
  PersonalRef,
  PersonalSourceKind,
  PushCaptureAck,
  PushCaptureArgs,
  QUOTA_DEFAULTS,
  RequestId,
  RetentionClass,
  SEARCH_HOSTS,
  StoredMeetingItem,
  sendAddress,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The capture shapes. Made-up values on reserved domains only.

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const ULID2 = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const at = (time: string): string => `2026-10-01T${time}-05:00`;
const app = { bundle: "test.example.meet", name: "Meet" };

const meeting = {
  kind: "meeting",
  key: `meeting:${ULID}`,
  revision: 0,
  startedAt: at("10:00:00"),
  endedAt: at("11:00:00"),
  app,
  title: "Alpha review",
  consent: true,
  mode: "call",
  calendar: {
    start: at("10:00:00"),
    end: at("11:00:00"),
    title: "Alpha review",
    uid: "series-alpha@example.com",
    organizer: { address: "lee@example.com" },
    attendees: [{ name: "Lee Example", address: "lee@example.com" }],
  },
  speakers: [
    { label: "S1", owner: true },
    { label: "S2", owner: false, mention: { name: "Lee Example" } },
  ],
  segments: [
    { speaker: "S1", fromMs: 0, toMs: 2000, channel: "input", text: "Hello." },
    { speaker: "S2", fromMs: 2000, toMs: 4000, channel: "output", text: "I will send the deck by Friday." },
  ],
};
const moment = {
  kind: "moment",
  key: `moment:${ULID}`,
  revision: 0,
  observedAt: at("09:00:00"),
  endedAt: at("09:05:00"),
  app: { bundle: "test.example.reader", name: "Reader" },
  url: "https://wiki.example.org/teams/alpha",
  entity: "doc",
  participants: [],
  text: "Alpha plan",
  read: "ax",
};
const block = {
  kind: "block",
  key: `block:${ULID}`,
  revision: 0,
  day: "2026-10-01",
  blocks: [
    {
      start: at("09:00:00"),
      end: at("09:30:00"),
      minutes: 30.5,
      app,
      host: "meet.example.com",
      account: "owner@example.com",
    },
  ],
};
const forget = { kind: "forget", key: `forget:${ULID}`, keys: [`meeting:${ULID}`, `block:${ULID}`] };
const ITEMS = [meeting, moment, block, forget];

describe("capture items", () => {
  it("every capture item is strict: a field named label, compartments, entity, belief, fact or any other unknown key fails the batch", () => {
    for (const item of ITEMS) expect(accepts(CaptureItem, item), item.kind).toBe(true);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: ITEMS })).toBe(true);
    for (const item of ITEMS) {
      for (const key of ["label", "compartments", "entity_id", "belief", "fact", "factKey", "unknown"]) {
        expect(
          accepts(PushCaptureArgs, { batch: "batch-0001", items: [{ ...item, [key]: "x" }] }),
          `${item.kind} ${key}`,
        ).toBe(false);
      }
    }
    // Nested objects are strict too: a speaker, a segment, a mention, a block, the calendar.
    expect(
      accepts(MeetingItem, {
        ...meeting,
        speakers: [{ ...meeting.speakers[0], entity: `ent_${ULID}` }, meeting.speakers[1]],
      }),
    ).toBe(false);
    expect(
      accepts(MeetingItem, { ...meeting, segments: [{ ...meeting.segments[0], label: "own" }, meeting.segments[1]] }),
    ).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, calendar: { ...meeting.calendar, compartments: ["own"] } })).toBe(false);
    expect(accepts(MomentItem, { ...moment, participants: [{ name: "Lee Example", entity: `ent_${ULID}` }] })).toBe(
      false,
    );
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], label: "own" }] })).toBe(false);
    // A mention names something, and a string holds no control character but tab and line feed.
    expect(accepts(MomentItem, { ...moment, participants: [{}] })).toBe(false);
    expect(accepts(MomentItem, { ...moment, text: "line one\n\tline two" })).toBe(true);
    expect(accepts(MomentItem, { ...moment, text: "a\u0000b" })).toBe(false);
    expect(accepts(MomentItem, { ...moment, text: "a\u0007b" })).toBe(false);
    expect(accepts(MomentItem, { ...moment, text: "" })).toBe(false);
  });

  it("a capture key is its kind, a colon and a ULID, and a forget naming a forget key or one key twice is refused", () => {
    for (const kind of ["meeting", "moment", "block", "forget"])
      expect(accepts(CaptureKey, `${kind}:${ULID}`), kind).toBe(true);
    for (const bad of [`meeting:${ULID.toLowerCase()}`, `meeting-${ULID}`, `note:${ULID}`, `meeting:${ULID}0`, ULID])
      expect(accepts(CaptureKey, bad), bad).toBe(false);
    // An item's key is of its own kind.
    expect(accepts(MomentItem, { ...moment, key: `meeting:${ULID}` })).toBe(false);
    expect(accepts(ForgetItem, forget)).toBe(true);
    expect(accepts(ForgetItem, { ...forget, keys: [`forget:${ULID2}`] })).toBe(false);
    expect(accepts(ForgetItem, { ...forget, keys: [`meeting:${ULID}`, `meeting:${ULID}`] })).toBe(false);
    expect(accepts(ForgetItem, { ...forget, keys: [] })).toBe(false);
    expect(accepts(CaptureId, `cap_${ULID}`)).toBe(true);
    expect(accepts(CaptureId, `msg_${ULID}`)).toBe(false);
  });

  it("a meeting over 120 000 code points, over 921 600 bytes, with 2 001 segments, with segments out of order or naming a speaker it lacks, is refused", () => {
    const segments = (count: number, text: string) =>
      Array.from({ length: count }, (_, i) => ({ speaker: "S1", fromMs: i, toMs: i + 1, channel: "mixed", text }));
    // 30 segments of 4 000 code points is exactly 120 000; one more code point is over.
    const full = segments(30, "a".repeat(4000));
    expect(accepts(MeetingItem, { ...meeting, segments: full })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: [...full, { ...full[0], fromMs: 40, text: "a" }] })).toBe(
      false,
    );
    // Within the code points but over the bytes: four-byte characters, and 200 long attendees.
    const face = (count: number): string => "\u{1F600}".repeat(count);
    const wide = segments(30, face(4000));
    const attendees = Array.from({ length: 200 }, () => ({ name: face(200), address: face(320), handle: face(200) }));
    expect(accepts(MeetingItem, { ...meeting, segments: wide })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: wide, calendar: { ...meeting.calendar, attendees } })).toBe(
      false,
    );
    expect(
      accepts(MeetingItem, { ...meeting, segments: segments(1, "a"), calendar: { ...meeting.calendar, attendees } }),
    ).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: segments(2000, "a") })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: segments(2001, "a") })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, segments: [meeting.segments[1], meeting.segments[0]] })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, segments: [{ ...meeting.segments[0], speaker: "S3" }] })).toBe(false);
    // A segment with no speaker, and one that ends before it starts.
    expect(accepts(MeetingItem, { ...meeting, segments: [{ ...meeting.segments[0], speaker: null }] })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: [{ ...meeting.segments[0], toMs: -1 }] })).toBe(false);
    expect(
      accepts(MeetingItem, { ...meeting, speakers: [meeting.speakers[0], { ...meeting.speakers[1], owner: true }] }),
    ).toBe(false);
  });

  it("a meeting's own typed notes, at most 20 000 code points, stand in for a transcript; an item with neither is refused", () => {
    expect(accepts(MeetingItem, { ...meeting, notes: "Agreed the tile order; Robin sends the deck Friday." })).toBe(
      true,
    );
    expect(accepts(MeetingItem, { ...meeting, segments: [], notes: "Agreed the tile order." })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: [] })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, segments: [], notes: "" })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, segments: [], notes: "a".repeat(20_000) })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, segments: [], notes: "a".repeat(20_001) })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, segments: [], notes: "a\u0000b" })).toBe(false);
    expect(accepts(StoredMeetingItem, { ...meeting, notes: "" })).toBe(true);
  });

  it("a meeting with a segment blanked parses as the store keeps it, and is refused as Lens sends it", () => {
    const blanked = { ...meeting, segments: [{ ...meeting.segments[0], text: "" }, meeting.segments[1]] };
    expect(accepts(StoredMeetingItem, blanked)).toBe(true);
    expect(accepts(MeetingItem, blanked)).toBe(false);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [blanked] })).toBe(false);
    // The stored shape keeps every other rule of the sent one.
    expect(accepts(StoredMeetingItem, meeting)).toBe(true);
    expect(accepts(StoredMeetingItem, { ...blanked, segments: [blanked.segments[1], blanked.segments[0]] })).toBe(
      false,
    );
    expect(
      accepts(StoredMeetingItem, { ...blanked, segments: [{ ...blanked.segments[0], text: "a".repeat(4001) }] }),
    ).toBe(false);
    expect(accepts(StoredMeetingItem, { ...blanked, label: "own" })).toBe(false);
  });

  it("a meeting with no diarization has no speakers, every segment's speaker null; 51 speakers are refused", () => {
    const undiarized = {
      ...meeting,
      speakers: [],
      segments: meeting.segments.map((segment) => ({ ...segment, speaker: null })),
    };
    expect(accepts(MeetingItem, undiarized)).toBe(true);
    expect(accepts(MeetingItem, { ...undiarized, segments: meeting.segments })).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ label: `S${i + 1}`, owner: false }));
    expect(accepts(MeetingItem, { ...meeting, speakers: many.slice(0, 50) })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, speakers: many })).toBe(false);
  });

  it("an optional field is absent, never null: a null title, account, host, window or calendar uid fails the item", () => {
    for (const field of ["title", "account", "host", "series"])
      expect(accepts(MeetingItem, { ...meeting, [field]: null }), field).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, calendar: { ...meeting.calendar, uid: null } })).toBe(false);
    for (const field of ["window", "url", "account", "thread", "document", "repository"])
      expect(accepts(MomentItem, { ...moment, [field]: null }), field).toBe(false);
  });

  it("a meeting's consent is a boolean, and a meeting with consent false parses", () => {
    expect(accepts(MeetingItem, { ...meeting, consent: false })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, consent: "yes" })).toBe(false);
    const { consent: _consent, ...without } = meeting;
    expect(accepts(MeetingItem, without)).toBe(false);
  });

  it("a meeting and a block may carry an account, a Bounded(320)", () => {
    expect(accepts(MeetingItem, { ...meeting, account: "owner@example.com" })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, account: "a".repeat(320) })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, account: "a".repeat(321) })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, account: "" })).toBe(false);
    expect(accepts(BlockItem, block)).toBe(true);
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], account: "a".repeat(321) }] })).toBe(false);
    // A block's minutes take one decimal at most.
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], minutes: 30.25 }] })).toBe(false);
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], minutes: 1441 }] })).toBe(false);
  });

  it("series and part come together, part 1 only on the series' own key, and endedAt at most 12 hours after startedAt", () => {
    expect(accepts(MeetingItem, { ...meeting, series: meeting.key, part: 1 })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, key: `meeting:${ULID2}`, series: meeting.key, part: 2 })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, series: meeting.key })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, part: 1 })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, series: meeting.key, part: 2 })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, key: `meeting:${ULID2}`, series: meeting.key, part: 1 })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, endedAt: at("22:00:00") })).toBe(true);
    expect(accepts(MeetingItem, { ...meeting, endedAt: at("22:00:01") })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, endedAt: at("09:59:59") })).toBe(false);
  });

  it("a moment, each time block and a meeting's calendar entry end not before they start", () => {
    expect(accepts(MomentItem, { ...moment, endedAt: moment.observedAt })).toBe(true);
    expect(accepts(MomentItem, { ...moment, endedAt: at("08:59:59") })).toBe(false);
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], end: block.blocks[0]?.start }] })).toBe(true);
    expect(accepts(BlockItem, { ...block, blocks: [{ ...block.blocks[0], end: at("08:59:59") }] })).toBe(false);
    expect(accepts(MeetingItem, { ...meeting, calendar: { ...meeting.calendar, end: meeting.calendar.start } })).toBe(
      true,
    );
    expect(accepts(MeetingItem, { ...meeting, calendar: { ...meeting.calendar, end: at("09:59:59") } })).toBe(false);
  });

  it("a moment URL with a query, a fragment, a user or a password is refused", () => {
    for (const url of [
      "https://wiki.example.org/a?b=1",
      "https://wiki.example.org/a?",
      "https://wiki.example.org/a#top",
      "https://wiki.example.org/a#",
      "https://lee@wiki.example.org/a",
      "https://lee:pw@wiki.example.org/a",
      "ftp://wiki.example.org/a",
      "/a/b",
      `https://wiki.example.org/${"a".repeat(2048)}`,
    ]) {
      expect(accepts(MomentItem, { ...moment, url }), url).toBe(false);
    }
    expect(accepts(MomentItem, { ...moment, url: "http://wiki.example.org:8080/a/b" })).toBe(true);
  });

  it("a Bounded string counts code points: an app name of 64 emoji parses, of 65 or none fails, and a control character fails", () => {
    const face = (count: number): string => "\u{1F600}".repeat(count);
    expect(accepts(MomentItem, { ...moment, app: { ...moment.app, name: face(64) } })).toBe(true);
    for (const name of [face(65), "", "Re\u0007ader"])
      expect(accepts(MomentItem, { ...moment, app: { ...moment.app, name } }), name).toBe(false);
    expect(accepts(MomentItem, { ...moment, text: "a\tb\nc" })).toBe(true);
  });

  it("a moment URL's bound of 2048 counts UTF-16 code units, not code points", () => {
    const prefix = "https://wiki.example.org/";
    const fits = prefix + "a".repeat(2048 - prefix.length);
    expect(accepts(MomentItem, { ...moment, url: fits })).toBe(true);
    // 1 012 astral characters: under 2048 code points, over 2048 code units.
    const astral = prefix + "\u{1F600}".repeat(1012);
    expect([...astral].length).toBeLessThan(2048);
    expect(astral.length).toBeGreaterThan(2048);
    expect(accepts(MomentItem, { ...moment, url: astral })).toBe(false);
    expect(accepts(MomentItem, { ...moment, url: prefix + "\u{1F600}".repeat(1000) })).toBe(true);
  });

  it("a moment's document is a path from ~/ or / with no . or .. segment, and its repository is host, owner and name in lower case", () => {
    for (const document of ["~/test/alpha/notes.md", "/srv/test/alpha.md"])
      expect(accepts(MomentItem, { ...moment, document }), document).toBe(true);
    for (const document of [
      "test/alpha",
      "~test",
      "~/test/./alpha",
      "~/test/../alpha",
      "/srv/..",
      `~/${"a".repeat(1023)}`,
      "~/a\u0000b",
    ])
      expect(accepts(MomentItem, { ...moment, document }), document).toBe(false);
    expect(accepts(MomentItem, { ...moment, repository: "git.example.org/owner/alpha" })).toBe(true);
    for (const repository of [
      "git.example.org/Owner/alpha",
      "git.example.org/owner",
      "git.example.org/owner/alpha/x",
      "https://git.example.org/owner/alpha",
    ]) {
      expect(accepts(MomentItem, { ...moment, repository }), repository).toBe(false);
    }
  });

  it("a meeting's host, when present, is a host name of at most 253 characters", () => {
    expect(accepts(MeetingItem, { ...meeting, host: "meet.example.com" })).toBe(true);
    const long = `${`${"a".repeat(60)}.`.repeat(4)}example.com`;
    expect(long.length).toBeGreaterThan(253);
    for (const host of [
      long,
      "meet example.com",
      "https://meet.example.com",
      "meet.example.com/a",
      "-meet.example.com",
      "",
    ])
      expect(accepts(MeetingItem, { ...meeting, host }), host).toBe(false);
  });

  it("a batch of 51 items, or naming a key twice, is refused", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...moment,
        key: `moment:01JABCDEFGHJKMNPQRSTVW${String(i).padStart(4, "0")}`,
      }));
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: many(50) })).toBe(true);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: many(51) })).toBe(false);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [moment, moment] })).toBe(false);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [] })).toBe(false);
    expect(accepts(PushCaptureArgs, { batch: "short", items: [moment] })).toBe(false);
    expect(PushCaptureArgs.shape.batch).toBe(RequestId);
  });

  it("the ack's code is present exactly when the outcome is refused", () => {
    const key = `moment:${ULID}`;
    expect(
      accepts(PushCaptureAck, {
        items: [
          { key, outcome: "accepted" },
          { key, outcome: "replayed" },
          { key, outcome: "refused", code: "ceiling" },
        ],
      }),
    ).toBe(true);
    for (const code of ["conflict", "out_of_order", "out_of_scope", "ceiling"])
      expect(accepts(PushCaptureAck, { items: [{ key, outcome: "refused", code }] }), code).toBe(true);
    expect(accepts(PushCaptureAck, { items: [{ key, outcome: "refused" }] })).toBe(false);
    expect(accepts(PushCaptureAck, { items: [{ key, outcome: "accepted", code: "conflict" }] })).toBe(false);
    expect(accepts(PushCaptureAck, { items: [{ key, outcome: "refused", code: "system_ids" }] })).toBe(false);
  });

  it("MULTI_ACCOUNT_SURFACES and BROWSER_BUNDLES are deep-frozen", () => {
    expect(Object.isFrozen(MULTI_ACCOUNT_SURFACES)).toBe(true);
    expect(Object.isFrozen(MULTI_ACCOUNT_SURFACES.hosts)).toBe(true);
    expect(Object.isFrozen(MULTI_ACCOUNT_SURFACES.bundles)).toBe(true);
    expect(Object.isFrozen(BROWSER_BUNDLES)).toBe(true);
    expect(MULTI_ACCOUNT_SURFACES.hosts).toContain("mail.google.com");
    expect(BROWSER_BUNDLES).toContain("com.apple.Safari");
    // Aside is a browser: its pages are admitted by host alone.
    expect(BROWSER_BUNDLES).toContain("at.studio.AsideBrowser");
    // The control: a list that is not frozen reports so.
    expect(Object.isFrozen([...BROWSER_BUNDLES])).toBe(false);
    // The one deepFreeze the capture, anchor and mirror constants share freezes every level.
    const nested = deepFreeze({ a: [{ b: 1 }] });
    expect([Object.isFrozen(nested), Object.isFrozen(nested.a), Object.isFrozen(nested.a[0])]).toEqual([
      true,
      true,
      true,
    ]);
  });
});

// The people the owner typed on a meeting's note.
describe("a meeting's owner-typed attendees", () => {
  it("each a name and an optional email, strict, at most MEETING_ATTENDEES_MAX; absent, the meeting parses as before", () => {
    const ok = (attendees: unknown) => MeetingItem.safeParse({ ...meeting, attendees }).success;
    expect(ok([{ name: "Lee Moss" }, { name: "Devon Ash", email: "devon.ash@example.net" }])).toBe(true);
    expect(MeetingItem.safeParse(meeting).success).toBe(true);
    expect(ok([{ email: "devon.ash@example.net" }])).toBe(false);
    expect(ok([{ name: "" }])).toBe(false);
    expect(ok([{ name: "Lee", entity: "ent_x" }])).toBe(false);
    expect(ok([{ name: "x".repeat(201) }])).toBe(false);
    expect(ok([{ name: "Lee", email: "x".repeat(321) }])).toBe(false);
    expect(ok(Array.from({ length: MEETING_ATTENDEES_MAX }, (_, n) => ({ name: `Guest ${n}` })))).toBe(true);
    expect(ok(Array.from({ length: MEETING_ATTENDEES_MAX + 1 }, (_, n) => ({ name: `Guest ${n}` })))).toBe(false);
  });
});

// Who wrote each run of a chat moment's text.
describe("a moment's turns", () => {
  const text = "Are you free Friday?\nYes, I will bring the map.";
  const chat = {
    ...moment,
    entity: "chat",
    url: undefined,
    participants: [{ name: "Lena Park", address: "lena@north.example" }, { name: "Omar Reyes" }],
    text,
  };
  const first = { from: 0, to: 20, speaker: "participant", participant: 0 };
  const second = { from: 21, to: text.length, speaker: "owner" };
  const ok = (turns: unknown[], over: Record<string, unknown> = {}) =>
    MomentItem.safeParse({ ...chat, ...over, turns }).success;

  it("a chat read ax takes turns of the owner, a participant by index and an agent, in order, within its text", () => {
    expect(ok([first, second])).toBe(true);
    expect(ok([{ from: 0, to: text.length, speaker: "agent" }])).toBe(true);
    expect(MomentItem.safeParse(chat).success).toBe(true);
  });

  it("refuses turns out of order, overlapping, empty, past the text, or with an index of no participant", () => {
    expect(ok([second, first])).toBe(false);
    expect(ok([first, { ...second, from: 19 }])).toBe(false);
    expect(ok([{ ...first, to: 0 }])).toBe(false);
    expect(ok([{ ...second, to: text.length + 1 }])).toBe(false);
    expect(ok([{ ...first, participant: 2 }])).toBe(false);
    expect(ok([])).toBe(false);
  });

  it("a participant index comes exactly with a participant's turn", () => {
    expect(ok([{ from: 0, to: 20, speaker: "participant" }])).toBe(false);
    expect(ok([{ from: 0, to: 20, speaker: "owner", participant: 0 }])).toBe(false);
    expect(ok([{ ...first, extra: 1 }])).toBe(false);
  });

  it("an offset is in UTF-16 code units and never inside a surrogate pair", () => {
    const emoji = "Ok \u{1F44D} see you";
    expect(ok([{ from: 0, to: 5, speaker: "owner" }], { text: emoji })).toBe(true);
    expect(ok([{ from: 0, to: 4, speaker: "owner" }], { text: emoji })).toBe(false);
    expect(ok([{ from: 4, to: 8, speaker: "owner" }], { text: emoji })).toBe(false);
  });

  it("only a chat read ax carries turns, at most MOMENT_TURNS_MAX", () => {
    expect(ok([second], { read: "ocr" })).toBe(false);
    expect(ok([second], { entity: "mail" })).toBe(false);
    expect(ok([second], { entity: "doc" })).toBe(false);
    const long = "x".repeat(MOMENT_TURNS_MAX + 1);
    const many = Array.from({ length: MOMENT_TURNS_MAX + 1 }, (_, n) => ({ from: n, to: n + 1, speaker: "owner" }));
    expect(ok(many, { text: long })).toBe(false);
    expect(ok(many.slice(0, MOMENT_TURNS_MAX), { text: long })).toBe(true);
  });
});

// A chat moment read from Messages' own database. Made-up handles only: phone numbers in the 555
// range and addresses on reserved domains.
describe("a source moment", () => {
  const text = "Lunch Friday?\nYes, noon works.\nGreat, see you there.";
  const lines = text.split("\n");
  const offsets = lines.map((_, n) => lines.slice(0, n).reduce((total, line) => total + line.length + 1, 0));
  const turn = (n: number, speaker: "owner" | "participant", time: string, participant?: number) => ({
    from: offsets[n],
    to: (offsets[n] ?? 0) + (lines[n]?.length ?? 0),
    speaker,
    ...(participant === undefined ? {} : { participant }),
    at: at(time),
  });
  const imessage = {
    kind: "moment",
    key: `moment:${ULID}`,
    revision: 0,
    observedAt: at("12:00:00"),
    endedAt: at("12:04:00"),
    app: { bundle: MOMENT_SOURCE_BUNDLES.imessage, name: "Messages" },
    entity: "chat",
    participants: [{ handle: "+15555550123" }, { address: "lena@north.example" }],
    text,
    read: "db",
    source: "imessage",
    threadKey: `chat:${ULID2}`,
    turns: [turn(0, "participant", "12:00:00", 0), turn(1, "owner", "12:02:00"), turn(2, "participant", "12:04:00", 1)],
  };
  const ok = (over: Record<string, unknown>) => MomentItem.safeParse({ ...imessage, ...over }).success;

  it("a chat of Messages read db, with its thread key, phone and email handles, and a time on every turn", () => {
    expect(MomentItem.safeParse(imessage).success).toBe(true);
    expect(accepts(CaptureItem, imessage)).toBe(true);
    // A named group's name may be its thread title; the key still groups it.
    expect(ok({ thread: "Book club" })).toBe(true);
    expect(MOMENT_SOURCE_BUNDLES.imessage).toBe("com.apple.MobileSMS");
    expect(Object.isFrozen(MOMENT_SOURCE_BUNDLES)).toBe(true);
  });

  it("a source, a thread key and read db come together, and only for a source's own app", () => {
    expect(ok({ source: undefined })).toBe(false);
    expect(ok({ threadKey: undefined })).toBe(false);
    expect(ok({ read: "ax" })).toBe(false);
    expect(ok({ source: "whatsapp" })).toBe(false);
    expect(ok({ app: { bundle: "test.example.chat", name: "Chat" } })).toBe(false);
    expect(ok({ entity: "mail" })).toBe(false);
    expect(ok({ turns: undefined })).toBe(false);
    // A screen moment takes neither a source nor a thread key.
    const screen = { ...moment, entity: "chat", url: undefined, participants: [{ name: "Lena Park" }], text: "Hello" };
    expect(MomentItem.safeParse({ ...screen, read: "db" }).success).toBe(false);
    expect(MomentItem.safeParse({ ...screen, threadKey: `chat:${ULID2}` }).success).toBe(false);
    expect(MomentItem.safeParse(screen).success).toBe(true);
  });

  it("a thread key is chat: and a ULID, holding nothing of the chat", () => {
    expect(ok({ threadKey: `chat:${ULID2.toLowerCase()}` })).toBe(false);
    expect(ok({ threadKey: "iMessage;-;+15555550123" })).toBe(false);
    expect(ok({ threadKey: `moment:${ULID2}` })).toBe(false);
  });

  it("no window, URL, account, document or repository on a source moment", () => {
    for (const over of [
      { window: "Messages" },
      { url: "https://chat.example.com/t" },
      { account: "owner@example.com" },
      { document: "~/Notes/a.txt" },
      { repository: "example.com/a/b" },
    ]) {
      expect(ok(over), JSON.stringify(over)).toBe(false);
    }
  });

  it("each participant is one E.164 phone or one email handle, with no name, listed once", () => {
    expect(
      ok({
        participants: [{ handle: "+15555550123" }],
        turns: [
          turn(0, "participant", "12:00:00", 0),
          turn(1, "owner", "12:02:00"),
          turn(2, "participant", "12:04:00", 0),
        ],
      }),
    ).toBe(true);
    for (const participants of [
      [{ handle: "+15555550123", name: "Lena Park" }, { address: "lena@north.example" }],
      [{ handle: "5555550123" }, { address: "lena@north.example" }],
      [{ handle: "+05555550123" }, { address: "lena@north.example" }],
      [{ handle: "+1555555012345678" }, { address: "lena@north.example" }],
      [{ handle: "246810" }, { address: "lena@north.example" }],
      [{ handle: "+15555550123" }, { address: "Lena <lena@north.example>" }],
      [{ handle: "+15555550123" }, { handle: "lena@north.example" }],
      [{ handle: "+15555550123" }, { handle: "+15555550123" }],
      [{ handle: "+15555550123", address: "lena@north.example" }, { address: "omar@north.example" }],
    ]) {
      expect(ok({ participants }), JSON.stringify(participants)).toBe(false);
    }
    expect(ok({ participants: [], turns: [turn(1, "owner", "12:02:00")] })).toBe(false);
  });

  it("participants are sorted by their value, and an email handle is a lower-case send address", () => {
    const swapped = {
      participants: [{ address: "lena@north.example" }, { handle: "+15555550123" }],
      turns: [
        turn(0, "participant", "12:00:00", 1),
        turn(1, "owner", "12:02:00"),
        turn(2, "participant", "12:04:00", 0),
      ],
    };
    expect(ok(swapped)).toBe(false);
    expect(ok({ participants: [{ handle: "+15555550123" }, { address: "Lena@north.example" }] })).toBe(false);
    const vectors = [
      "lena@north.example",
      "Lena@north.example",
      "a`b@north.example",
      "lena@north.123",
      `${"x".repeat(65)}@north.example`,
      `lena@${"y".repeat(64)}.example`,
      "lena@north",
      "le..na@north.example",
      "lena@north.example ",
    ];
    for (const vector of vectors) expect(isSourceAddress(vector), vector).toBe(sendAddress(vector) === vector);
  });

  it("the turns cover the text, one message each, joined by line feeds", () => {
    const [first, second, third] = imessage.turns;
    expect(ok({ turns: [first, third] })).toBe(false);
    expect(ok({ turns: [{ ...first, from: 1 }, second, third] })).toBe(false);
    expect(ok({ turns: [first, second, { ...third, to: (third?.to ?? 0) - 1 }] })).toBe(false);
    const twoLines = "Lunch Friday?\nOr Saturday?\nYes, noon works.";
    const turns = [
      { from: 0, to: 26, speaker: "participant", participant: 0, at: at("12:00:00") },
      { from: 27, to: twoLines.length, speaker: "owner", at: at("12:02:00") },
    ];
    expect(ok({ text: twoLines, turns })).toBe(true);
  });

  it("every turn is the owner's or a participant's, with its time within the moment, in time order", () => {
    const [first, second, third] = imessage.turns;
    expect(ok({ turns: [first, { ...second, at: undefined }, third] })).toBe(false);
    expect(ok({ turns: [first, { ...second, speaker: "agent" }, third] })).toBe(false);
    expect(ok({ turns: [{ ...first, at: at("11:59:00") }, second, third] })).toBe(false);
    expect(ok({ turns: [first, second, { ...third, at: at("12:05:00") }] })).toBe(false);
    expect(ok({ turns: [first, { ...second, at: at("12:04:30") }, third] })).toBe(false);
    expect(ok({ turns: [first, { ...second, at: at("12:04:00") }, third] })).toBe(true);
  });

  it("a screen moment's turns carry no time", () => {
    const screen = {
      ...moment,
      entity: "chat",
      url: undefined,
      participants: [{ name: "Lena Park" }],
      text: "Hello there",
    };
    expect(MomentItem.safeParse({ ...screen, turns: [{ from: 0, to: 5, speaker: "owner" }] }).success).toBe(true);
    expect(
      MomentItem.safeParse({ ...screen, turns: [{ from: 0, to: 5, speaker: "owner", at: at("09:01:00") }] }).success,
    ).toBe(false);
  });

  it("a source rule is a plain bundle rule admitting moments alone; a rule made before parses unchanged", () => {
    const rule = {
      id: `csr_${ULID}`,
      match: "bundle",
      account: false,
      compartment: "own",
      kinds: ["moment"],
      agentApp: false,
      client: null,
    };
    expect(accepts(CaptureScopeRule, rule)).toBe(true);
    expect(accepts(CaptureScopeRule, { ...rule, source: "imessage" })).toBe(true);
    expect(accepts(CaptureScopeRule, { ...rule, source: "imessage", kinds: ["moment", "block"] })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, source: "imessage", match: "host" })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, source: "imessage", agentApp: true })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, source: "screen" })).toBe(false);
  });
});

describe("Lens's registration, refs and owner shapes", () => {
  const device = {
    name: "mac-capture",
    runtime: "local",
    vendorRetention: "none",
    kind: "device",
    compartments: ["own"],
    views: ["self"],
    tools: ["push_capture"],
  };

  it("a device registration holds exactly push_capture, self and own with retention none, and a registration of any other kind holding push_capture is refused", () => {
    expect(accepts(ClientRegistration, device)).toBe(true);
    for (const over of [
      { tools: ["push_capture", "get_self"] },
      { tools: ["get_self"] },
      { views: ["self", "people"] },
      { views: ["work"] },
      { compartments: ["own", "employer:example"] },
      { vendorRetention: "retains" },
    ]) {
      expect(accepts(ClientRegistration, { ...device, ...over }), JSON.stringify(over)).toBe(false);
    }
    for (const kind of [undefined, "agent", "reasoner"])
      expect(accepts(ClientRegistration, { ...device, kind }), String(kind)).toBe(false);
    // A device's id mode is stable: given, it is stable, and session is refused.
    expect(accepts(ClientRegistration, { ...device, idMode: "stable" })).toBe(true);
    expect(accepts(ClientRegistration, { ...device, idMode: "session" })).toBe(false);
    // The control: an agent without push_capture is still registered.
    expect(accepts(ClientRegistration, { ...device, name: "mac", kind: "agent", tools: ["get_self"] })).toBe(true);
    expect(QUOTA_DEFAULTS.device).toEqual({ maxItemsDay: 0, maxCharsDay: 0, maxRowsDay: 0, maxCallsMinute: 120 });
  });

  it("a fact names at most one of message, document, page and capture", () => {
    const fact = {
      id: "a".repeat(64),
      subject: { id: `ent_${ULID}`, kind: "person", name: null, address: null },
      statedBy: null,
      basis: "third_party",
      statementKind: "stated_fact",
      at: "2026-10-01T10:00:00Z",
      message: null,
      document: null,
      passage: null,
      page: null,
      capture: `cap_${ULID}`,
      segment: { from: 0, to: 12 },
      thirdParty: true,
      agentReported: false,
      provenance: "source",
      type: "capability",
      fields: { what: { untrusted: "Deck design." } },
    };
    expect(accepts(FactView, fact)).toBe(true);
    expect(accepts(FactView, { ...fact, segment: null })).toBe(true);
    expect(accepts(FactView, { ...fact, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(FactView, { ...fact, document: `doc_${ULID}` })).toBe(false);
    expect(
      accepts(FactView, {
        ...fact,
        page: { id: `pag_${ULID}`, url: { untrusted: "https://news.example/a" }, fetchedAt: "2026-10-01T10:00:00Z" },
      }),
    ).toBe(false);
    expect(accepts(FactView, { ...fact, capture: `msg_${ULID}` })).toBe(false);
    // A segment only with a capture item, and a span that ends after it starts.
    expect(accepts(FactView, { ...fact, capture: null, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(FactView, { ...fact, capture: null, segment: null, message: `msg_${ULID}` })).toBe(true);
    expect(accepts(FactView, { ...fact, segment: { from: 5, to: 4 } })).toBe(false);
    const { capture: _capture, ...noCapture } = fact;
    expect(accepts(FactView, noCapture)).toBe(false);
    // A commitment item names a capture and its span as a fact does.
    const belief = {
      fact: "b".repeat(64),
      state: "c".repeat(64),
      kind: "commitment",
      type: "commitment",
      status: "active",
      disputed: false,
      provenance: "source",
      confirmedAt: "2026-10-01T10:00:00Z",
      reviewAfter: null,
    };
    const item = {
      belief,
      direction: "owed_to_owner",
      counterparty: null,
      due: null,
      what: null,
      message: null,
      capture: `cap_${ULID}`,
      segment: { from: 0, to: 4 },
    };
    expect(accepts(CommitmentItem, item)).toBe(true);
    expect(accepts(CommitmentItem, { ...item, capture: `msg_${ULID}` })).toBe(false);
    // As FactView's: a segment only with a capture item, and at most one source.
    expect(accepts(CommitmentItem, { ...item, capture: null, segment: null, message: `msg_${ULID}` })).toBe(true);
    expect(accepts(CommitmentItem, { ...item, capture: null, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(CommitmentItem, { ...item, segment: null, message: `msg_${ULID}` })).toBe(false);
  });

  it("a capture ref parses, and a ref of kind capture holding a message id is refused", () => {
    expect(accepts(PersonalRef, { kind: "capture", id: `cap_${ULID}` })).toBe(true);
    expect(accepts(PersonalRef, { kind: "capture", id: `msg_${ULID}` })).toBe(false);
    expect(accepts(PersonalRef, { kind: "message", id: `cap_${ULID}` })).toBe(false);
  });

  it("a scope rule refuses kinds outside meeting, moment and block", () => {
    const rule = {
      id: `csr_${ULID}`,
      match: "host",
      account: true,
      compartment: "employer:example",
      kinds: ["moment", "block", "meeting"],
      agentApp: false,
      client: null,
    };
    expect(accepts(CaptureScopeRule, rule)).toBe(true);
    for (const kinds of [["forget"], ["message"], [], ["moment", "moment"]])
      expect(accepts(CaptureScopeRule, { ...rule, kinds }), JSON.stringify(kinds)).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, match: "url" })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, value: "mail.google.com" })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, id: `cap_${ULID}` })).toBe(false);
    expect(CaptureScopeRule.shape.id).toBe(CaptureScopeRuleId);
    expect([
      accepts(CaptureScopeRuleId, `csr_${ULID}`),
      accepts(CaptureScopeRuleId, `csr_${ULID.toLowerCase()}`),
    ]).toEqual([true, false]);
  });

  it("an agent-app rule may name a client and admits no meeting; a client only on an agent-app rule", () => {
    const rule = {
      id: `csr_${ULID}`,
      match: "host",
      account: false,
      compartment: "own",
      kinds: ["moment", "block"],
      agentApp: true,
      client: `cli_${ULID}`,
    };
    expect(accepts(CaptureScopeRule, rule)).toBe(true);
    expect(accepts(CaptureScopeRule, { ...rule, client: null })).toBe(true);
    expect(accepts(CaptureScopeRule, { ...rule, kinds: ["moment", "meeting"] })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, agentApp: false })).toBe(false);
    expect(accepts(CaptureScopeRule, { ...rule, client: `csr_${ULID}` })).toBe(false);
    const { agentApp: _flag, ...unflagged } = rule;
    expect(accepts(CaptureScopeRule, unflagged)).toBe(false);
  });

  it("the three capture retention classes parse", () => {
    for (const value of ["capture_transcript", "capture_moment", "capture_block"])
      expect(accepts(RetentionClass, value), value).toBe(true);
    expect(accepts(RetentionClass, "capture_audio")).toBe(false);
  });

  it("a moment and a time block are source kinds of their own; a meeting is the shared transcript", () => {
    expect(PersonalSourceKind.options).toEqual([
      "agent_record",
      "screen_activity",
      "time_block",
      "owner_task",
      "owner_command",
    ]);
  });

  it("a device's view holds ids, codes, counts and times only", () => {
    const view = {
      name: "mac",
      capture: `cli_${ULID}`,
      mirror: `cli_${ULID2}`,
      status: "active",
      inbox: { waiting: 2, forgetsWaiting: 1, refused: { out_of_scope: 3 }, dropped: { system_ids: 1 } },
      blankedSegments: 1,
      lastPushAt: "2026-10-01T10:00:00Z",
      lastPassAt: null,
      mirrorEntries: 40,
      unconfirmed: 0,
      ownWords: [{ day: "2026-10-01", count: 2 }],
    };
    expect(accepts(LensDeviceView, view)).toBe(true);
    expect(accepts(LensDeviceView, { ...view, host: "mail.google.com" })).toBe(false);
    expect(accepts(LensDeviceView, { ...view, inbox: { ...view.inbox, refused: { "Mail Google": 1 } } })).toBe(false);
    expect(accepts(LensDeviceView, { ...view, ownWords: Array.from({ length: 8 }, () => view.ownWords[0]) })).toBe(
      false,
    );
  });
});

describe("history pages on blocks and how far Lens saw the day", () => {
  const page = {
    url: "https://wiki.example.org/teams/alpha",
    title: "Alpha plan",
    firstAt: at("09:05:00"),
    lastAt: at("09:20:00"),
    count: 3,
  };
  const search = {
    url: `https://${SEARCH_HOSTS[0]}/search`,
    title: "alpha budget",
    firstAt: at("09:01:00"),
    lastAt: at("09:01:00"),
    count: 1,
    query: "alpha budget",
  };
  const withPages = (pages: unknown[]) => ({ ...block, blocks: [{ ...block.blocks[0], pages }] });

  it("a block carries the pages visited during it, each with its first and last visit and count", () => {
    expect(accepts(BlockItem, withPages([page, search]))).toBe(true);
    expect(accepts(BlockItem, block)).toBe(true);
    expect(accepts(BlockItem, withPages([]))).toBe(false);
    expect(
      accepts(
        BlockItem,
        withPages(Array.from({ length: BLOCK_PAGES_MAX + 1 }, (_, n) => ({ ...page, url: `${page.url}/${n}` }))),
      ),
    ).toBe(false);
    expect(
      accepts(
        BlockItem,
        withPages(Array.from({ length: BLOCK_PAGES_MAX }, (_, n) => ({ ...page, url: `${page.url}/${n}` }))),
      ),
    ).toBe(true);
    expect(accepts(BlockPage, { ...page, count: 0 })).toBe(false);
    expect(accepts(BlockPage, { ...page, lastAt: at("09:04:59") })).toBe(false);
    expect(accepts(BlockPage, { url: page.url, firstAt: page.firstAt, lastAt: page.lastAt, count: 1 })).toBe(true);
  });

  it("a page is strict, in a page moment's URL form, and holds no label, account or mention", () => {
    for (const extra of [
      { label: "own" },
      { account: "owner@example.com" },
      { compartment: "own" },
      { participants: [] },
    ])
      expect(accepts(BlockPage, { ...page, ...extra })).toBe(false);
    for (const url of [
      "https://wiki.example.org/a?token=x",
      "https://wiki.example.org/a#top",
      "https://user:pw@wiki.example.org/a",
      "ftp://wiki.example.org/a",
    ]) {
      expect(accepts(BlockPage, { ...page, url }), url).toBe(false);
    }
    expect(accepts(BlockPage, { ...page, title: "t".repeat(301) })).toBe(false);
  });

  it("a query only on a SEARCH_HOSTS page", () => {
    expect(accepts(BlockPage, search)).toBe(true);
    expect(accepts(BlockPage, { ...page, query: "alpha budget" })).toBe(false);
    expect(accepts(BlockPage, { ...search, url: "https://search.example.com/search" })).toBe(false);
    expect(accepts(BlockPage, { ...search, query: "" })).toBe(false);
    for (const one of SEARCH_HOSTS)
      expect(accepts(BlockPage, { ...search, url: `https://${one}/search` }), one).toBe(true);
  });

  it("each page's visits fall within its block, and a URL and query pair once a block", () => {
    expect(accepts(BlockItem, withPages([{ ...page, firstAt: at("08:59:59") }]))).toBe(false);
    expect(accepts(BlockItem, withPages([{ ...page, lastAt: at("09:30:01") }]))).toBe(false);
    expect(accepts(BlockItem, withPages([{ ...page, firstAt: at("09:00:00"), lastAt: at("09:30:00") }]))).toBe(true);
    expect(accepts(BlockItem, withPages([page, page]))).toBe(false);
    expect(accepts(BlockItem, withPages([search, { ...search, query: "alpha plan" }]))).toBe(true);
  });

  it("coveredThrough is a timestamp on the item's own day, optional", () => {
    expect(accepts(BlockItem, { ...block, coveredThrough: at("23:59:00") })).toBe(true);
    expect(accepts(BlockItem, { ...block, coveredThrough: at("11:58:00") })).toBe(true);
    expect(accepts(BlockItem, { ...block, coveredThrough: "2026-10-02T00:01:00-05:00" })).toBe(false);
    expect(accepts(BlockItem, { ...block, coveredThrough: "2026-10-01" })).toBe(false);
    expect(accepts(CaptureItem, { ...block, coveredThrough: at("23:59:00") })).toBe(true);
  });

  it("a block day is at most BLOCK_DAY_MAX_BYTES of JSON", () => {
    const long = (n: number) => ({
      ...page,
      url: `https://wiki.example.org/${"p".repeat(1900)}/${n}`,
      title: "t".repeat(300),
    });
    const day = (blocks: number) => ({
      ...block,
      blocks: Array.from({ length: blocks }, () => ({
        ...block.blocks[0],
        pages: Array.from({ length: BLOCK_PAGES_MAX }, (_, n) => long(n)),
      })),
    });
    expect(JSON.stringify(day(20)).length).toBeGreaterThan(BLOCK_DAY_MAX_BYTES);
    expect(accepts(BlockItem, day(20))).toBe(false);
    expect(accepts(BlockItem, day(2))).toBe(true);
  });
});

// The credential test's vectors. A positive keeps its prefix; a negative matches no format. Each
// made-up value is split in two literals so no literal in the file has a provider's key shape.
describe("CREDENTIAL_SHAPED", () => {
  const matches = (text: string): string[] =>
    CREDENTIAL_SHAPED.flatMap(({ pattern }) =>
      [...text.matchAll(new RegExp(pattern.source, "g"))].map((one) => one[1]!),
    );
  const positives: Array<[string, string, string]> = [
    ["sk-ant", "key sk-ant-" + "api03-Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk0Lz end", "sk-ant-"],
    ["sk", "OPENAI=sk-" + "proj-4fT9xQ2wE7rY1uI5oP3aS8dF6gH0jK", "sk-"],
    ["ghp", "token gh" + "p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5 here", "ghp_"],
    ["github_pat", "github_" + "pat_11ABCDEFG0123456789abcdefghijk_lmnop", "github_pat_"],
    ["akia", "id AKIA" + "IOSFODNN7EXAMPLE,", "AKIA"],
    ["aiza", "AIza" + "SyD3x9Q2w7E5r1T3y5U7i9O1p3A5s7D9f1G", "AIza"],
    ["slack", "xoxb" + "-123456789012-abcdefABCDEF", "xoxb-"],
    [
      "pem",
      "-----BEGIN RSA PRIVATE" +
        " KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE" +
        " KEY-----",
      "-----BEGIN RSA PRIVATE" + " KEY-----",
    ],
    [
      "jwt",
      "Bearer eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "eyJ",
    ],
  ];
  it.each(positives)("matches a %s value and keeps its prefix", (_format, text, prefix) => {
    expect(matches(text)).toEqual([prefix]);
  });
  const negatives: Array<[string, string]> = [
    ["ordinary text", "The key was rotated on Monday; ask Sam before the skip-level meeting."],
    ["an email address", "write to someone.else@example.com about it"],
    ["a hyphenated compound", "a sk-based approach and a task-oriented, well-thought-out plan for sk-learn-compatible"],
    ["a version string", "upgrade to v1.24.3-beta.2+build.20261020"],
    ["a SKU", "order SKU AB-4471-XL-BLK, qty 2"],
    ["a commit hash", "fixed in 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
    ["a Gmail message id", "msg 18c2f4a9b7e3d1f0"],
    ["a ULID-form id", "rec_01HZX3K9Q2W7E5R1T3Y5U7I9OP"],
    ["a 64-character hex fingerprint", "fp 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"],
  ];
  it("no pattern is global, so none holds state between callers", () => {
    expect(CREDENTIAL_SHAPED.every(({ pattern }) => !pattern.global && !pattern.sticky)).toBe(true);
  });
  it.each(negatives)("matches no format in %s", (_what, text) => {
    expect(matches(text)).toEqual([]);
  });
  // A PEM block's body is held to its own alphabet: base64, white space and the header lines'
  // `:`, `,` and `-`. One the text cuts off before its END is matched to the end, failing closed.
  const pem = CREDENTIAL_SHAPED.find((one) => one.format === "pem")!.pattern;
  const pemMatch = (text: string): string | undefined => new RegExp(pem.source, "g").exec(text)?.[0];
  it("matches a truncated PEM key to the end of the text", () => {
    const text =
      "-----BEGIN OPENSSH PRIVATE" +
      " KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACB";
    expect(matches(text)).toEqual(["-----BEGIN OPENSSH PRIVATE" + " KEY-----"]);
    expect(pemMatch(text)).toBe(text);
  });
  it("matches a stray BEGIN line only to the end of its alphabet, never to a far END", () => {
    const text = "-----BEGIN CERTIFICATE-----\nnot one, see the notes. The rest is prose.\n-----END CERTIFICATE-----";
    expect(pemMatch(text)).toBe("-----BEGIN CERTIFICATE-----\nnot one, see the notes");
  });
  it("matches a PEM key with encryption header lines to its END", () => {
    const text =
      "-----BEGIN RSA PRIVATE" +
      " KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F17F5316E2BAC89\n\nMIIBOgIBAAJBAKj34GkxFhD9+/0vcN==\n-----END RSA PRIVATE" +
      " KEY----- and then words.";
    expect(pemMatch(text)).toBe(text.slice(0, text.indexOf(" and then words.")));
  });
});

describe("Mac contacts on the wire", () => {
  const contact = {
    kind: "contact",
    key: `contact:${ULID}`,
    revision: 0,
    name: "Lena Ortiz",
    phones: ["+15555550100"],
    emails: ["lena@example.com"],
  };
  const listing = { kind: "contacts", key: `contacts:${ULID2}`, revision: 0, keys: [`contact:${ULID}`] };

  it("a contact and a listing are capture items, each pushed in a batch, and their keys are capture keys", () => {
    expect(accepts(CaptureItem, contact)).toBe(true);
    expect(accepts(CaptureItem, listing)).toBe(true);
    expect(accepts(PushCaptureArgs, { batch: "batch-0001", items: [contact] })).toBe(true);
    expect(accepts(PushCaptureArgs, { batch: "batch-0002", items: [listing] })).toBe(true);
    expect(accepts(CaptureKey, `contact:${ULID}`)).toBe(true);
    expect(accepts(CaptureKey, `contacts:${ULID}`)).toBe(true);
  });

  it("each kind is parsed by its own shape: a listing's fields on a contact, or a contact's on a listing, fail", () => {
    expect(accepts(CaptureItem, { ...contact, keys: [] })).toBe(false);
    expect(accepts(CaptureItem, { ...listing, kind: "contact" })).toBe(false);
    expect(accepts(CaptureItem, { ...contact, key: `contacts:${ULID}` })).toBe(false);
    expect(accepts(CaptureItem, { ...listing, revision: 1 })).toBe(false);
    expect(MacContactItem.safeParse(contact).success && MacContactsListed.safeParse(listing).success).toBe(true);
  });

  it("a forget never names a Mac contact or a listing: a listing removes them, and no forget erases one", () => {
    expect(accepts(ForgetItem, { kind: "forget", key: `forget:${ULID2}`, keys: [`moment:${ULID}`] })).toBe(true);
    expect(
      accepts(ForgetItem, { kind: "forget", key: `forget:${ULID2}`, keys: [`moment:${ULID}`, `contact:${ULID}`] }),
    ).toBe(false);
    expect(accepts(ForgetItem, { kind: "forget", key: `forget:${ULID2}`, keys: [`contacts:${ULID}`] })).toBe(false);
  });

  it("an ack's erased keys never name a Mac contact or a listing: neither has a capture row", () => {
    const items = [{ key: `moment:${ULID}`, outcome: "accepted" }];
    expect(accepts(PushCaptureAck, { erased: [`moment:${ULID}`], items })).toBe(true);
    expect(accepts(PushCaptureAck, { erased: [`contact:${ULID}`], items })).toBe(false);
    expect(accepts(PushCaptureAck, { erased: [`contacts:${ULID}`], items })).toBe(false);
  });

  it("a device's view parses with and without its Mac contacts' counts", () => {
    const view = {
      name: "mac",
      capture: `cli_${ULID}`,
      mirror: `cli_${ULID2}`,
      status: "active",
      inbox: { waiting: 0, forgetsWaiting: 0, refused: {}, dropped: {} },
      blankedSegments: 0,
      lastPushAt: null,
      lastPassAt: null,
      mirrorEntries: 0,
      unconfirmed: 0,
      ownWords: [],
    };
    expect(accepts(LensDeviceView, view)).toBe(true);
    expect(accepts(LensDeviceView, { ...view, macContacts: { on: true, stored: 3, dropped: { outranked: 1 } } })).toBe(
      true,
    );
    expect(
      accepts(LensDeviceView, { ...view, macContacts: { on: true, stored: 3, dropped: { unknown_code: 1 } } }),
    ).toBe(false);
    expect(accepts(LensDeviceView, { ...view, macContacts: { device: "mac", on: true, stored: 3, dropped: {} } })).toBe(
      false,
    );
  });
});
