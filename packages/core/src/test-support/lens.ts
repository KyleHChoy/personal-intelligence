import type {
  BlockItem,
  CaptureMention,
  ForgetItem,
  MeetingItem,
  MeetingSegment,
  MeetingSpeaker,
  MomentItem,
} from "@intelligence/contracts/personal";

// The owner's Mac, `mac`, as Lens would push it: meetings, moments, a block day and a forget, each
// with its handle and, but the forget, its canary. Every value is made up and on a reserved domain,
// every bundle id under `test.`, but for the products of MULTI_ACCOUNT_SURFACES and
// BROWSER_BUNDLES. Times are relative to `now`, written with the Mac's local offset, and nothing is
// random: two at one `now` are deep-equal. Some meetings and moments are evaluation cases.

export type LensHandles = {
  linkedMeeting: string;
  roomMeeting: string;
  thirdPartyMeeting: string;
  consentedCall: string;
  unconsentedMeeting: string;
  accountMeeting: string;
  noAccountMeeting: string;
  recoveryMeeting: string;
  inScopeMoment: string;
  outOfScopeMoment: string;
  systemIdMoment: string;
  recoveryMoment: string;
  gmailAccountMoment: string;
  gmailNoAccountMoment: string;
  unruledBrowserMoment: string;
  sourceMoment: string;
  sourceMomentLater: string;
  groupSourceMoment: string;
  messagesScreenMoment: string;
  blockDay: string;
  forget: string;
};

// A rule of the owner's capture scope a test may add.
export type LensScopeRule = {
  match: "bundle" | "host";
  value: string;
  account?: string;
  compartment: string;
  kinds: ("meeting" | "moment" | "block")[];
};

export type LensWorld = {
  device: "mac";
  meetings: MeetingItem[];
  moments: MomentItem[];
  // The source moments and the Messages screen moment, apart from `moments`.
  sources: MomentItem[];
  blocks: BlockItem[];
  forgets: ForgetItem[];
  scope: LensScopeRule[];
  // The world's employer event the linked meeting overlaps.
  linkedEvent: { id: string; compartment: string };
  handles: LensHandles;
  // Each meeting's, moment's and block day's key to the marker it alone holds.
  canaries: Record<string, string>;
};

const [MINUTE, HOUR, DAY] = [60_000, 3_600_000, 86_400_000];
// The Mac's local offset, as Lens writes a time.
const OFFSET = -5 * HOUR;

// The world's people the device saw. The owner's work address and the work-only colleague are
// the world's (world.ts, OWNER and WORK_ONLY); the rest appear nowhere else.
const OWNER_WORK = "avery.quinn@employer.test";
const OWNER_PERSONAL = "avery@quinn.test";
const DEVON: CaptureMention = { name: "Devon Marsh", address: "devon.marsh@employer.test" };
const ROBIN: CaptureMention = { name: "Robin Vale", address: "robin.vale@example.org" };
const OWNER: CaptureMention = { name: "Avery Quinn", address: OWNER_PERSONAL };

// Apps: test bundles, and the products the test cases need.
const MEET = { bundle: "test.example.meet", name: "Meet" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const MAIL = { bundle: "test.example.mail", name: "Mail" };
const GAMES = { bundle: "test.example.games", name: "Games" };
const ZOOM = { bundle: "us.zoom.xos", name: "Zoom" };
const SAFARI = { bundle: "com.apple.Safari", name: "Safari" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };
// Messages, MOMENT_SOURCE_BUNDLES' app, and two contacts' phones on 555 numbers.
const MESSAGES = { bundle: "com.apple.MobileSMS", name: "Messages" };
export const LENS_PHONES = { lena: "+15555550101", sam: "+15555550102" } as const;

// A ULID for the n-th item, and its key.
const ulid = (n: number): string => `01JCAPTVRE${String(n).padStart(16, "0")}`;

const SCOPE: LensScopeRule[] = [
  { match: "host", value: "wiki.example.org", compartment: "own", kinds: ["moment", "block"] },
  { match: "host", value: "mail.google.com", account: OWNER_WORK, compartment: "employer:example", kinds: ["moment"] },
  {
    match: "bundle",
    value: ZOOM.bundle,
    account: OWNER_WORK,
    compartment: "employer:example",
    kinds: ["meeting", "block"],
  },
  { match: "bundle", value: MEET.bundle, compartment: "own", kinds: ["meeting"] },
  { match: "bundle", value: MAIL.bundle, compartment: "own", kinds: ["moment"] },
];

export function fakeLens({ now }: { now: Date }): LensWorld {
  const base = Math.floor(now.getTime() / 1000) * 1000;
  const local = (offset: number): string => `${new Date(base + offset + OFFSET).toISOString().slice(0, 19)}-05:00`;
  const canaries: Record<string, string> = {};
  const canary = (key: string, tag: string): string => {
    canaries[key] = `CANARY-LENS-${tag}`;
    return canaries[key];
  };

  const speaker = (label: string, owner: boolean, mention?: CaptureMention): MeetingSpeaker => ({
    label,
    owner,
    ...(mention === undefined ? {} : { mention }),
  });
  const segment = (
    label: string | null,
    from: number,
    channel: MeetingSegment["channel"],
    text: string,
  ): MeetingSegment => ({ speaker: label, fromMs: from * 1000, toMs: (from + 20) * 1000, channel, text });
  const meeting = (
    n: number,
    start: number,
    minutes: number,
    fields: Omit<MeetingItem, "kind" | "key" | "revision" | "startedAt" | "endedAt" | "title"> & { title: string },
  ): MeetingItem => {
    const key = `meeting:${ulid(n)}`;
    return {
      kind: "meeting",
      key,
      revision: 0,
      startedAt: local(start),
      endedAt: local(start + minutes * MINUTE),
      ...fields,
      title: `${fields.title} ${canary(key, `M${n}`)}`,
    };
  };
  const moment = (
    n: number,
    start: number,
    fields: Omit<MomentItem, "kind" | "key" | "revision" | "observedAt" | "endedAt" | "participants" | "read"> &
      Partial<Pick<MomentItem, "participants">>,
  ): MomentItem => {
    const key = `moment:${ulid(n)}`;
    return {
      kind: "moment",
      key,
      revision: 0,
      observedAt: local(start),
      endedAt: local(start + 5 * MINUTE),
      participants: [],
      read: "ax",
      ...fields,
      text: `${fields.text} ${canary(key, `O${n}`)}`,
    };
  };
  const owned = (label: string): MeetingSpeaker => speaker(label, true, { address: OWNER_PERSONAL });
  type Line = [who: "owner" | number, minute: number, text: string];
  const source = (
    n: number,
    start: number,
    threadKey: string,
    participants: CaptureMention[],
    lines: Line[],
    thread?: string,
  ): MomentItem => {
    const key = `moment:${ulid(n)}`;
    const texts = lines.map(([, , text], index) =>
      index === lines.length - 1 ? `${text} ${canary(key, `O${n}`)}` : text,
    );
    let at = 0;
    const turns = lines.map(([who, minute], index) => {
      const from = at;
      at += (texts[index] ?? "").length + 1;
      return {
        from,
        to: from + (texts[index] ?? "").length,
        ...(who === "owner" ? { speaker: "owner" as const } : { speaker: "participant" as const, participant: who }),
        at: local(start + minute * MINUTE),
      };
    });
    return {
      kind: "moment",
      key,
      revision: 0,
      observedAt: local(start + (lines[0]?.[1] ?? 0) * MINUTE),
      endedAt: local(start + (lines[lines.length - 1]?.[1] ?? 0) * MINUTE),
      app: MESSAGES,
      entity: "chat",
      ...(thread === undefined ? {} : { thread }),
      participants,
      text: texts.join("\n"),
      read: "db",
      turns,
      source: "imessage",
      threadKey,
    };
  };

  const meetings: MeetingItem[] = [
    // Linked to the world's evt-work-review (now + 27 h, an hour long, Devon Marsh attending):
    // 55 minutes of overlap, and Devon on the calendar entry and as S2.
    meeting(1, 27 * HOUR + 5 * MINUTE, 60, {
      app: MEET,
      title: "Rota review",
      account: OWNER_WORK,
      consent: true,
      mode: "call",
      calendar: {
        start: local(27 * HOUR),
        end: local(28 * HOUR),
        title: "Rota review",
        uid: "evt-work-review@employer.test",
        organizer: DEVON,
        attendees: [DEVON, { address: OWNER_WORK }],
      },
      speakers: [speaker("S1", true, { address: OWNER_WORK }), speaker("S2", false, DEVON)],
      segments: [
        segment("S1", 0, "input", "Shall we go through the rota?"),
        segment("S2", 20, "output", "Yes, the weekend slots first."),
      ],
    }),
    meeting(2, -3 * DAY, 30, {
      app: MEET,
      title: "Kitchen planning",
      consent: true,
      mode: "room",
      speakers: [speaker("S1", false), speaker("S2", false, ROBIN)],
      segments: [
        segment("S1", 0, "mixed", "I will order the tiles tomorrow."),
        segment("S2", 20, "mixed", "The cabinets come on Tuesday."),
      ],
    }),
    meeting(3, -2 * DAY, 30, {
      app: MEET,
      title: "Deck check-in",
      consent: true,
      mode: "call",
      calendar: {
        start: local(-2 * DAY),
        end: local(-2 * DAY + 30 * MINUTE),
        title: "Deck check-in",
        organizer: OWNER,
        attendees: [OWNER, ROBIN],
      },
      speakers: [owned("S1"), speaker("S2", false, ROBIN)],
      segments: [
        segment("S1", 0, "input", "Where are we on the deck?"),
        segment("S2", 20, "output", "I will send the deck by Friday."),
      ],
    }),
    meeting(4, -2 * DAY + 3 * HOUR, 30, {
      app: MEET,
      title: "Budget call",
      consent: true,
      mode: "call",
      speakers: [owned("S1"), speaker("S2", false, ROBIN)],
      segments: [
        segment("S1", 0, "input", "I will review the budget by Monday."),
        segment("S2", 20, "output", "Thanks, that works."),
        segment("S1", 40, "input", "Talk soon."),
      ],
    }),
    meeting(5, -1 * DAY, 20, {
      app: MEET,
      title: "Detected call",
      consent: false,
      mode: "call",
      speakers: [owned("S1"), speaker("S2", false, ROBIN)],
      segments: [segment("S1", 0, "input", "I will draft the summary tonight."), segment("S2", 20, "output", "Great.")],
    }),
    meeting(6, -1 * DAY + 2 * HOUR, 30, {
      app: ZOOM,
      title: "Supplier sync",
      account: OWNER_WORK,
      consent: true,
      mode: "call",
      speakers: [owned("S1"), speaker("S2", false, DEVON)],
      segments: [segment("S1", 0, "input", "Any update from the supplier?"), segment("S2", 20, "output", "Not yet.")],
    }),
    meeting(7, -1 * DAY + 4 * HOUR, 30, {
      app: ZOOM,
      title: "Open call",
      consent: true,
      mode: "call",
      speakers: [owned("S1"), speaker("S2", false, ROBIN)],
      segments: [segment("S1", 0, "input", "Hello, can you hear me?"), segment("S2", 20, "output", "Loud and clear.")],
    }),
    meeting(8, -4 * DAY, 30, {
      app: MEET,
      title: "Account help",
      consent: true,
      mode: "call",
      speakers: [owned("S1"), speaker("S2", false, ROBIN)],
      segments: [
        segment("S1", 0, "input", "I cannot get into the account."),
        segment("S2", 20, "output", "Read me the one-time code from the text."),
        segment("S1", 40, "input", "Done, it works now."),
      ],
    }),
  ];

  const moments: MomentItem[] = [
    moment(9, -5 * HOUR, {
      app: READER,
      url: "https://wiki.example.org/teams/alpha",
      window: "Alpha plan",
      entity: "doc",
      text: "The alpha plan, second draft.",
    }),
    moment(10, -5 * HOUR + 10 * MINUTE, {
      app: GAMES,
      window: "Lobby",
      entity: "chat",
      participants: [{ handle: "player-two" }],
      text: "Good game.",
    }),
    moment(11, -4 * HOUR, {
      app: READER,
      url: "https://wiki.example.org/teams/alpha/ids",
      window: "Notes",
      entity: "doc",
      text: `See ent_${ulid(99)} for the person.`,
    }),
    moment(12, -4 * HOUR + 10 * MINUTE, {
      app: MAIL,
      window: "Inbox",
      entity: "mail",
      text: "Enter the verification code 551920 to continue.",
    }),
    moment(13, -3 * HOUR, {
      app: SAFARI,
      url: "https://mail.google.com/mail/u/0/inbox",
      account: OWNER_WORK,
      window: "Inbox",
      entity: "mail",
      participants: [DEVON],
      thread: "Rota",
      text: "The rota for next week.",
    }),
    moment(14, -3 * HOUR + 10 * MINUTE, {
      app: SAFARI,
      url: "https://mail.google.com/mail/u/1/inbox",
      window: "Inbox",
      entity: "mail",
      text: "Your parcel is on its way.",
    }),
    moment(15, -2 * HOUR, {
      app: CHROME,
      url: "https://unruled.example.net/notes",
      window: "Notes",
      entity: "doc",
      text: "A page no rule names.",
    }),
  ];

  const [lena, sam] = [{ handle: LENS_PHONES.lena }, { handle: LENS_PHONES.sam }];
  const sources: MomentItem[] = [
    source(
      18,
      -26 * HOUR,
      `chat:${ulid(20)}`,
      [lena],
      [
        [0, 0, "Are we still on for the climbing gym on Saturday?"],
        ["owner", 2, "Yes, I will book the ten o'clock slot tonight."],
        [0, 3, "Great, I will bring the spare harness."],
      ],
    ),
    source(
      19,
      -25 * HOUR,
      `chat:${ulid(20)}`,
      [lena],
      [
        ["owner", 0, "Booked for ten."],
        [0, 4, "Perfect, see you there."],
      ],
    ),
    source(
      21,
      -24 * HOUR,
      `chat:${ulid(22)}`,
      [lena, sam],
      [
        [1, 0, "Who is driving on Saturday?"],
        [0, 1, "I can drive Sam, I will pick you up at nine."],
        ["owner", 5, "I will meet you both there."],
      ],
      "Saturday crew",
    ),
    moment(23, -23 * HOUR, {
      app: MESSAGES,
      window: "Lena",
      entity: "chat",
      participants: [{ name: "Lena" }],
      text: "A line read from the screen.",
    }),
  ];

  // The block day is yesterday on the Mac's clock, its blocks at fixed hours from its local
  // midnight (as an offset from now), so they fall inside it whatever the hour of now.
  const blockKey = `block:${ulid(16)}`;
  const midnight = Math.floor((base + OFFSET) / DAY) * DAY - DAY - OFFSET - base;
  const blocks: BlockItem[] = [
    {
      kind: "block",
      key: blockKey,
      revision: 0,
      day: local(midnight).slice(0, 10),
      blocks: [
        {
          start: local(midnight + 9 * HOUR),
          end: local(midnight + 10 * HOUR),
          minutes: 60,
          app: READER,
          title: `Alpha plan ${canary(blockKey, "B16")}`,
          host: "wiki.example.org",
        },
        {
          start: local(midnight + 14 * HOUR),
          end: local(midnight + 14 * HOUR + 30 * MINUTE),
          minutes: 30,
          app: ZOOM,
          title: "Supplier sync",
          account: OWNER_WORK,
        },
      ],
    },
  ];

  const [, room] = meetings;
  const [, outOfScope] = moments;
  const forgets: ForgetItem[] = [
    { kind: "forget", key: `forget:${ulid(17)}`, keys: [room?.key ?? "", outOfScope?.key ?? ""] },
  ];

  const keyOf = (list: { key: string }[], index: number): string => list[index]?.key ?? "";
  return {
    device: "mac",
    meetings,
    moments,
    sources,
    blocks,
    forgets,
    scope: SCOPE.map((rule) => ({ ...rule, kinds: [...rule.kinds] })),
    linkedEvent: { id: "evt-work-review", compartment: "employer:example" },
    handles: {
      linkedMeeting: keyOf(meetings, 0),
      roomMeeting: keyOf(meetings, 1),
      thirdPartyMeeting: keyOf(meetings, 2),
      consentedCall: keyOf(meetings, 3),
      unconsentedMeeting: keyOf(meetings, 4),
      accountMeeting: keyOf(meetings, 5),
      noAccountMeeting: keyOf(meetings, 6),
      recoveryMeeting: keyOf(meetings, 7),
      inScopeMoment: keyOf(moments, 0),
      outOfScopeMoment: keyOf(moments, 1),
      systemIdMoment: keyOf(moments, 2),
      recoveryMoment: keyOf(moments, 3),
      gmailAccountMoment: keyOf(moments, 4),
      gmailNoAccountMoment: keyOf(moments, 5),
      unruledBrowserMoment: keyOf(moments, 6),
      sourceMoment: keyOf(sources, 0),
      sourceMomentLater: keyOf(sources, 1),
      groupSourceMoment: keyOf(sources, 2),
      messagesScreenMoment: keyOf(sources, 3),
      blockDay: blockKey,
      forget: keyOf(forgets, 0),
    },
    canaries,
  };
}
