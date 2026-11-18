import { z } from "zod";
import { Timestamp } from "../ids.ts";
import {
  bounded,
  codePoints,
  documentPath,
  host,
  keyOf,
  momentUrl,
  ordered,
  repository,
  revision,
  span,
  utf8Bytes,
} from "./capture-fields.ts";
import { deepFreeze, E164_PHONE, isSourceAddress } from "./capture-forms.ts";
import { ULID_PATTERN } from "./ids.ts";

// Lens: what the owner's desktop app pushes with push_capture. Every string here is the device's
// account of what was on screen or said: untrusted data, checked for form and size and never for
// meaning. No shape has a field for a label, a compartment, an entity id, a belief id, a fact key
// or any other id of the system, and every object is strict, so a batch carrying one fails whole.

// A raw mention as Lens saw it: never an identity.
export const CaptureMention = z
  .strictObject({ name: bounded(200).optional(), address: bounded(320).optional(), handle: bounded(200).optional() })
  .refine((mention) => mention.name !== undefined || mention.address !== undefined || mention.handle !== undefined, {
    message: "a mention names something",
  });
export type CaptureMention = z.infer<typeof CaptureMention>;

export const CaptureApp = z.strictObject({
  bundle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/),
  name: bounded(64),
});
export type CaptureApp = z.infer<typeof CaptureApp>;

// A scope rule for one must name an account, for every kind, and an item there matches only a rule
// naming its account. Products, not data; extended by a commit.
export const MULTI_ACCOUNT_SURFACES: { readonly hosts: readonly string[]; readonly bundles: readonly string[] } =
  deepFreeze({
    hosts: [
      "mail.google.com",
      "docs.google.com",
      "drive.google.com",
      "calendar.google.com",
      "meet.google.com",
      "outlook.office.com",
      "outlook.office365.com",
      "outlook.live.com",
      "app.slack.com",
      "teams.microsoft.com",
      "teams.live.com",
      "zoom.us",
      "app.zoom.us",
      "notion.so",
      "www.notion.so",
    ],
    bundles: ["com.tinyspeck.slackmacgap", "com.microsoft.teams", "com.microsoft.teams2", "us.zoom.xos", "notion.id"],
  });

// An item from one matches host rules only, and a bundle rule for one is refused
// (`browser_bundle`). Products, not data; extended by a commit.
export const BROWSER_BUNDLES: readonly string[] = deepFreeze([
  "com.apple.Safari",
  "com.google.Chrome",
  "company.thebrowser.Browser",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "at.studio.AsideBrowser",
]);

const SPEAKER = /^S[1-9][0-9]?$/;

// At most one speaker per meeting has `owner` true: the one whose every segment came from the input
// device.
export const MeetingSpeaker = z.strictObject({
  label: z.string().regex(SPEAKER),
  owner: z.boolean(),
  mention: CaptureMention.optional(),
});
export type MeetingSpeaker = z.infer<typeof MeetingSpeaker>;

const segmentOf = (text: z.ZodType<string>) =>
  z
    .strictObject({
      speaker: z.string().regex(SPEAKER).nullable(),
      fromMs: z.number().int().min(0),
      toMs: z.number().int().min(0),
      channel: z.enum(["input", "output", "mixed"]),
      text,
    })
    .refine((segment) => segment.toMs >= segment.fromMs, { message: "a segment ends after it starts", path: ["toMs"] });
export const MeetingSegment = segmentOf(bounded(4000));
export type MeetingSegment = z.infer<typeof MeetingSegment>;
const StoredMeetingSegment = segmentOf(z.literal("").or(bounded(4000)));

const MEETING_NOTES_MAX = 20_000;
const MeetingNotes = bounded(MEETING_NOTES_MAX);
const StoredMeetingNotes = z.literal("").or(MeetingNotes);

// A longer meeting is sent as consecutive parts.
const MEETING_MAX_TEXT = 120_000;
const MEETING_MAX_BYTES = 921_600;
const TWELVE_HOURS = 12 * 3_600_000;

// It is the owner's assertion that the person attended, never evidence of what they said.
export const MEETING_ATTENDEES_MAX = 200;
const MeetingAttendee = z.strictObject({ name: bounded(200), email: bounded(320).optional() });

// `consent` is true only when the owner's own gesture over the owner channel started the recording;
// one the detector or an engine route started is sent with false. `account` is match data for the
// scope, `host` the browser's for a meeting in a browser, and `calendar.uid` a meeting_series
// anchor's value.
const meetingOf = (segment: typeof MeetingSegment, notes: z.ZodType<string>) =>
  z
    .strictObject({
      kind: z.literal("meeting"),
      key: keyOf("meeting"),
      revision,
      series: keyOf("meeting").optional(),
      part: z.number().int().min(1).max(50).optional(),
      startedAt: Timestamp,
      endedAt: Timestamp,
      app: CaptureApp,
      title: bounded(300).optional(),
      account: bounded(320).optional(),
      consent: z.boolean(),
      mode: z.enum(["call", "room"]),
      calendar: z
        .strictObject({
          start: Timestamp,
          end: Timestamp,
          title: bounded(300).optional(),
          uid: bounded(255).optional(),
          organizer: CaptureMention.optional(),
          attendees: z.array(CaptureMention).max(200),
        })
        .refine((entry) => span(entry.start, entry.end) >= 0, ordered)
        .optional(),
      // The people the owner typed as there, apart from `calendar`.
      attendees: z.array(MeetingAttendee).max(MEETING_ATTENDEES_MAX).optional(),
      // Empty when the source has no diarization: every segment's speaker is then null.
      speakers: z.array(MeetingSpeaker).max(50),
      segments: z.array(segment).max(2000),
      notes: notes.optional(),
      host: host.optional(),
    })
    .refine((item) => item.segments.length > 0 || item.notes !== undefined, {
      message: "a transcript or notes",
      path: ["segments"],
    })
    .refine((item) => item.speakers.filter((speaker) => speaker.owner).length <= 1, {
      message: "at most one speaker is the owner",
      path: ["speakers"],
    })
    .refine(
      (item) =>
        item.segments.every(
          (segment, index) => index === 0 || (item.segments[index - 1]?.fromMs ?? 0) <= segment.fromMs,
        ),
      {
        message: "segments in fromMs order",
        path: ["segments"],
      },
    )
    .refine(
      (item) =>
        item.segments.every(
          (segment) => segment.speaker === null || item.speakers.some((speaker) => speaker.label === segment.speaker),
        ),
      {
        message: "every speaker a segment names is in speakers",
        path: ["segments"],
      },
    )
    .refine(
      (item) => item.segments.reduce((total, segment) => total + codePoints(segment.text), 0) <= MEETING_MAX_TEXT,
      { message: "at most 120 000 code points of text", path: ["segments"] },
    )
    .refine((item) => utf8Bytes(item) <= MEETING_MAX_BYTES, { message: "at most 921 600 bytes of JSON" })
    .refine((item) => (item.series === undefined) === (item.part === undefined), {
      message: "series and part come together",
      path: ["part"],
    })
    .refine((item) => item.series === undefined || (item.part === 1) === (item.series === item.key), {
      message: "part 1 exactly on the series' own key",
      path: ["part"],
    })
    .refine((item) => span(item.startedAt, item.endedAt) >= 0 && span(item.startedAt, item.endedAt) <= TWELVE_HOURS, {
      message: "endedAt not before startedAt and at most 12 hours after it",
      path: ["endedAt"],
    });
export const MeetingItem = meetingOf(MeetingSegment, MeetingNotes);
export type MeetingItem = z.infer<typeof MeetingItem>;
export const StoredMeetingItem = meetingOf(StoredMeetingSegment, StoredMeetingNotes);
export type StoredMeetingItem = z.infer<typeof StoredMeetingItem>;

// `page`, a web page or article the owner read in a browser. It is stored, linked and served as
// every moment is, and never sent to a model.
export const MomentEntity = z.enum(["chat", "doc", "mail", "page"]);
export type MomentEntity = z.infer<typeof MomentEntity>;

// `imessage` is Messages' `chat.db`.
export const MomentSource = z.enum(["imessage"]);
export type MomentSource = z.infer<typeof MomentSource>;

// A `db` moment names this bundle, and a screen moment of it is refused at push (`out_of_scope`)
// whatever the rules say. Products, not data; extended by a commit.
export const MOMENT_SOURCE_BUNDLES: Readonly<Record<MomentSource, string>> = deepFreeze({
  imessage: "com.apple.MobileSMS",
});

// It holds nothing of the chat: not its name, its members or the source's own id.
const ThreadKey = z.string().regex(new RegExp(`^chat:${ULID_PATTERN}$`));

const sourceValue = (mention: CaptureMention): string | null =>
  mention.name !== undefined
    ? null
    : mention.handle !== undefined && mention.address === undefined && E164_PHONE.test(mention.handle)
      ? mention.handle
      : mention.address !== undefined && mention.handle === undefined && isSourceAddress(mention.address)
        ? mention.address
        : null;

// The most a page moment's text holds: the page's title alone, no excerpt.
export const PAGE_MAX_TEXT = 300;

// `from` and `to` are UTF-16 code units of `text` (the unit of JavaScript's String length and
// Swift's String.utf16), neither inside a surrogate pair. `owner` is the Mac's own outgoing line
// (the owner's sent message, their prompt in an agent app), `participant` the line of
// `participants[participant]`, `agent` an agent app's assistant. Text no turn covers is nobody's
// known words. `at`, when the line was sent, exactly on a source moment's turns, each of which is
// one message.
export const MOMENT_TURNS_MAX = 400;
export const MomentTurn = z
  .strictObject({
    from: z.number().int().min(0),
    to: z.number().int().min(1),
    speaker: z.enum(["owner", "participant", "agent"]),
    participant: z.number().int().min(0).max(49).optional(),
    at: Timestamp.optional(),
  })
  .refine((turn) => turn.from < turn.to, { message: "a turn ends after it starts", path: ["to"] })
  .refine((turn) => (turn.speaker === "participant") === (turn.participant !== undefined), {
    message: "a participant index exactly with a participant's turn",
    path: ["participant"],
  });
export type MomentTurn = z.infer<typeof MomentTurn>;

// An offset between the two halves of a surrogate pair.
const highHalf = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const lowHalf = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const splitsPair = (text: string, at: number): boolean =>
  at > 0 && at < text.length && highHalf(text.charCodeAt(at - 1)) && lowHalf(text.charCodeAt(at));

export const MomentItem = z
  .strictObject({
    kind: z.literal("moment"),
    key: keyOf("moment"),
    revision,
    observedAt: Timestamp,
    endedAt: Timestamp,
    app: CaptureApp,
    window: bounded(300).optional(),
    url: momentUrl.optional(),
    account: bounded(320).optional(),
    entity: MomentEntity,
    thread: bounded(300).optional(),
    participants: z.array(CaptureMention).max(50),
    document: documentPath.optional(),
    repository: repository.optional(),
    text: bounded(4000),
    // `db`: read from the source's own database, with `source` and `threadKey`.
    read: z.enum(["ax", "ocr", "db"]),
    turns: z.array(MomentTurn).min(1).max(MOMENT_TURNS_MAX).optional(),
    source: MomentSource.optional(),
    threadKey: ThreadKey.optional(),
  })
  .refine((item) => span(item.observedAt, item.endedAt) >= 0, {
    message: "endedAt not before observedAt",
    path: ["endedAt"],
  })
  // A page moment is the page's title alone, at most PAGE_MAX_TEXT code points, of a URL, with no
  // participant.
  .refine((item) => item.entity !== "page" || codePoints(item.text) <= PAGE_MAX_TEXT, {
    message: `a page's text is at most ${PAGE_MAX_TEXT} code points`,
    path: ["text"],
  })
  .refine((item) => item.entity !== "page" || item.url !== undefined, { message: "a page has a url", path: ["url"] })
  .refine((item) => item.entity !== "page" || item.participants.length === 0, {
    message: "a page has no participant",
    path: ["participants"],
  })
  // Turns only on a chat read from the accessibility tree or from a source's database, in text
  // order, not overlapping, within the text, and each participant one the moment lists.
  .refine(
    (item) => item.turns === undefined || (item.entity === "chat" && (item.read === "ax" || item.read === "db")),
    {
      message: "turns only on a chat moment read ax or db",
      path: ["turns"],
    },
  )
  .refine((item) => (item.source !== undefined) === (item.read === "db"), {
    message: "a source exactly on a moment read db",
    path: ["source"],
  })
  .refine((item) => (item.source !== undefined) === (item.threadKey !== undefined), {
    message: "a thread key exactly on a source moment",
    path: ["threadKey"],
  })
  .refine(
    (item) =>
      item.source === undefined ||
      // A chat by the turns rule above, which a source moment's required turns invoke.
      (item.app.bundle === MOMENT_SOURCE_BUNDLES[item.source] &&
        item.turns !== undefined &&
        [item.window, item.url, item.account, item.document, item.repository].every((field) => field === undefined)),
    {
      message:
        "a source moment is a chat of its source's app, with turns and no window, url, account, document or repository",
      path: ["source"],
    },
  )
  .refine(
    (item) => {
      if (item.source === undefined) return true;
      const values = item.participants.map(sourceValue);
      return (
        values.length >= 1 &&
        values.every((value, index) => value !== null && (index === 0 || (values[index - 1] ?? "") < value))
      );
    },
    {
      message: "a source moment's participants are E.164 or lower-case email handles with no name, sorted, each once",
      path: ["participants"],
    },
  )
  .refine(
    (item) =>
      item.source === undefined ||
      item.turns === undefined ||
      (item.turns[0]?.from === 0 &&
        item.turns[item.turns.length - 1]?.to === item.text.length &&
        item.turns.every(
          (turn, index) =>
            index === 0 ||
            (turn.from === (item.turns?.[index - 1]?.to ?? -2) + 1 && item.text.charCodeAt(turn.from - 1) === 10),
        )),
    { message: "a source moment's turns cover its text, one message each, joined by line feeds", path: ["turns"] },
  )
  // A screen moment's turns carry no time.
  .refine(
    (item) =>
      item.turns === undefined ||
      (item.source === undefined
        ? item.turns.every((turn) => turn.at === undefined)
        : item.turns.every(
            (turn, index) =>
              turn.speaker !== "agent" &&
              turn.at !== undefined &&
              span(item.observedAt, turn.at) >= 0 &&
              span(turn.at, item.endedAt) >= 0 &&
              (index === 0 || span(item.turns?.[index - 1]?.at ?? turn.at, turn.at) >= 0),
          )),
    {
      message:
        "a source moment's turns are the owner's or a participant's, each with its time within the moment, in order; a screen moment's carry none",
      path: ["turns"],
    },
  )
  .refine(
    (item) =>
      item.turns === undefined ||
      item.turns.every(
        (turn, index) =>
          turn.to <= item.text.length &&
          (index === 0 || turn.from >= (item.turns?.[index - 1]?.to ?? 0)) &&
          !splitsPair(item.text, turn.from) &&
          !splitsPair(item.text, turn.to) &&
          (turn.participant === undefined || turn.participant < item.participants.length),
      ),
    { message: "turns in text order, not overlapping, within the text, each participant listed", path: ["turns"] },
  );
export type MomentItem = z.infer<typeof MomentItem>;

// The credential test, from the known secret formats (provisional values), in order. Each
// pattern's first group is the prefix a mask keeps; the rest of a match is the secret. The patterns
// are not global, so a shared one holds no lastIndex between callers: a consumer that scans every
// match makes its own copy, `new RegExp(p.source, "g")`. A later format never matches inside an
// earlier one's match. The high-entropy, card and one-time-code classes are not here: on stored
// mail they would mask message ids, order numbers and dates; the credential tripwire on Lens's
// typed and page text adds them for its own use. Marked pure so a bundle that does not use the list
// (the web client) leaves it out: its PEM pattern would read as a key in the built code.
export const CREDENTIAL_SHAPED: ReadonlyArray<{ readonly format: string; readonly pattern: RegExp }> =
  /* @__PURE__ */ Object.freeze([
    // A PEM block's body is its own alphabet: base64, white space and the header lines' `:`, `,` and
    // `-`. A BEGIN with no END is matched to the end of that alphabet's run, failing closed; a stray
    // BEGIN line before prose masks no more than the run after it. ASCII only, so a match keeps its
    // length in code units as well as in code points.
    {
      format: "pem",
      pattern:
        /(-----BEGIN [A-Z0-9 ]{1,40}-----)[A-Za-z0-9+/=:,\s-]*?(?:-----END [A-Z0-9 ]{1,40}-----|(?![A-Za-z0-9+/=:,\s-]))/,
    },
    { format: "jwt", pattern: /(?<![A-Za-z0-9_-])(eyJ)[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
    { format: "sk-ant", pattern: /(?<![A-Za-z0-9_-])(sk-ant-)[A-Za-z0-9_-]{20,}/ },
    { format: "sk", pattern: /(?<![A-Za-z0-9_-])(sk-)(?!ant-)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/ },
    { format: "github_pat", pattern: /(?<![A-Za-z0-9_])(github_pat_)[A-Za-z0-9_]{22,}/ },
    { format: "ghp", pattern: /(?<![A-Za-z0-9_])(ghp_)[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
    { format: "akia", pattern: /(?<![A-Za-z0-9])(AKIA)[0-9A-Z]{16}(?![A-Za-z0-9])/ },
    { format: "aiza", pattern: /(?<![A-Za-z0-9_-])(AIza)[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/ },
    { format: "slack", pattern: /(?<![A-Za-z0-9-])(xox[a-z]-)(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9-]{10,}/ },
  ]);
