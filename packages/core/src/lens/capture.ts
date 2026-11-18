import type {
  BlockAttribute,
  BlockItem,
  CaptureApp,
  CaptureKey,
  CaptureMention,
  EntityId,
  EventId,
  MeetingItem,
  MomentEntity,
  MomentItem,
  MomentLines,
  MomentSource,
  TaskItem,
} from "@intelligence/contracts/personal";
import { ULID_PATTERN } from "@intelligence/contracts/personal";
import { canonicalJson, deepFreeze } from "../json.ts";
import { codePoints, tenths } from "../units.ts";

// Lens's capture items as the store keeps them. Pure: no clock, no key, no database. Nothing here
// reads a word of an item for its meaning.

type Item = MeetingItem | MomentItem | BlockItem | TaskItem;
type LinkedEvent = { id: EventId; ownerBacked: boolean; speakers: Record<string, EntityId> };

// The item's canonical JSON as UTF-8: keys sorted, no white space. The payload the vault seals. A
// block day split by compartment is cut to one compartment's blocks by the caller first.
export function captureBlock(item: Item): Uint8Array {
  return new TextEncoder().encode(canonicalJson(item));
}

// What knowledge.captures seals: an item's fields and mentions, and its counts. No text: no
// segment's words and no moment's text. For a linked meeting, what the meeting lane needs of the
// event and cannot read itself: its owner-backing and the participant each speaker resolved to, as
// of the drain.
export type CaptureFacts =
  | {
      kind: "meeting";
      app: CaptureApp;
      title: string | null;
      account: string | null;
      host: string | null;
      consent: boolean;
      mode: MeetingItem["mode"];
      series: CaptureKey | null;
      part: number | null;
      calendar: {
        title: string | null;
        uid: string | null;
        organizer: CaptureMention | null;
        attendees: CaptureMention[];
      } | null;
      attendees?: CaptureMention[];
      speakers: { label: string; owner: boolean; mention: CaptureMention | null }[];
      linked: { event: EventId; ownerBacked: boolean; speakers: Record<string, EntityId> } | null;
      pushedAt?: string;
      counts: { segments: number; chars: number; minutes: number; blanked: number };
    }
  | {
      kind: "moment";
      app: CaptureApp;
      entity: MomentEntity;
      window: string | null;
      url: string | null;
      account: string | null;
      thread: string | null;
      document: string | null;
      repository: string | null;
      participants: CaptureMention[];
      counts: { chars: number };
      pushedAt?: string;
      source?: MomentSource;
      vouched?: true;
      // A source moment's lines, who sent each turn and when; no text.
      lines?: MomentLines;
    }
  | {
      kind: "block";
      day: string;
      // Where each block was worked, with how Lens derived it. Its repository, document and folder
      // are optional: facts sealed before Lens derived them have none.
      blocks: {
        app: CaptureApp;
        title: string | null;
        host: string | null;
        account: string | null;
        minutes: number;
        repository?: BlockAttribute | null;
        document?: BlockAttribute | null;
        folder?: BlockAttribute | null;
      }[];
      counts: { blocks: number; minutes: number };
    }
  // Work time: a task's facts are its event count and no text.
  | { kind: "task"; counts: { events: number } };

// Minutes with one decimal, as a block's are.

// `vouched`, the drain's answer whether this revision of a source moment was pushed inside the
// device's vouched window; sealed only on a source moment.
export function captureFacts(
  item: Item,
  at: { linkedEvent: LinkedEvent | null; pushedAt?: string; vouched?: boolean },
): CaptureFacts {
  if (item.kind !== "meeting" && at.linkedEvent !== null)
    throw new Error("capture: only a meeting is linked to an event");
  switch (item.kind) {
    case "meeting":
      return {
        kind: "meeting",
        app: item.app,
        title: item.title ?? null,
        account: item.account ?? null,
        host: item.host ?? null,
        consent: item.consent,
        mode: item.mode,
        series: item.series ?? null,
        part: item.part ?? null,
        calendar:
          item.calendar === undefined
            ? null
            : {
                title: item.calendar.title ?? null,
                uid: item.calendar.uid ?? null,
                organizer: item.calendar.organizer ?? null,
                attendees: item.calendar.attendees,
              },
        speakers: item.speakers.map((speaker) => ({
          label: speaker.label,
          owner: speaker.owner,
          mention: speaker.mention ?? null,
        })),
        linked:
          at.linkedEvent === null
            ? null
            : {
                event: at.linkedEvent.id,
                ownerBacked: at.linkedEvent.ownerBacked,
                speakers: { ...at.linkedEvent.speakers },
              },
        ...(item.attendees === undefined
          ? {}
          : {
              attendees: item.attendees.map((one) => ({
                name: one.name,
                ...(one.email === undefined ? {} : { address: one.email }),
              })),
            }),
        ...(at.pushedAt === undefined ? {} : { pushedAt: at.pushedAt }),
        counts: {
          segments: item.segments.length,
          chars: item.segments.reduce((total, segment) => total + codePoints(segment.text), 0),
          minutes: tenths((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 60_000),
          blanked: item.segments.filter((segment) => segment.text === "").length,
        },
      };
    case "moment": {
      const lines = momentLines(item);
      return {
        kind: "moment",
        app: item.app,
        entity: item.entity,
        window: item.window ?? null,
        url: item.url ?? null,
        account: item.account ?? null,
        thread: item.thread ?? null,
        document: item.document ?? null,
        repository: item.repository ?? null,
        participants: item.participants,
        counts: { chars: codePoints(item.text) },
        ...(at.pushedAt === undefined ? {} : { pushedAt: at.pushedAt }),
        ...(item.source === undefined ? {} : { source: item.source }),
        ...(item.source !== undefined && at.vouched === true ? { vouched: true as const } : {}),
        ...(lines === undefined ? {} : { lines }),
      };
    }
    case "block":
      return {
        kind: "block",
        day: item.day,
        blocks: item.blocks.map((one) => ({
          app: one.app,
          title: one.title ?? null,
          host: one.host ?? null,
          account: one.account ?? null,
          minutes: one.minutes,
          repository: one.repository ?? null,
          document: one.document ?? null,
          folder: one.folder ?? null,
        })),
        counts: {
          blocks: item.blocks.length,
          minutes: tenths(item.blocks.reduce((total, one) => total + one.minutes, 0)),
        },
      };
    case "task":
      return { kind: "task", counts: { events: item.events.length } };
  }
}

// A source moment's lines, as its facts seal them: the participants' handles (a phone handle or an
// email address) in `participants`' order, and one `[who, at]` per turn, `who` the index into
// `handles` or −1 for the owner's turn (Lens marks it from Messages' own flag), ordered by `at`,
// then by the turn's order, since an edit makes a revision whose positions can shift. No text,
// offset or length. Undefined for a screen moment, whose turns have no time, and for any moment of
// another kind. Pure: the drain seals it, and the lines catch-up re-derives it from a stored item.
export function momentLines(item: MomentItem): MomentLines | undefined {
  if (item.source === undefined || item.turns === undefined) return undefined;
  const handles = item.participants.map((one) => one.handle ?? one.address ?? null);
  const turns = item.turns
    .map((turn, order) => ({
      who: turn.speaker === "owner" ? -1 : (turn.participant ?? -1),
      at: turn.at ?? item.endedAt,
      order,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order)
    .map((turn): [number, typeof turn.at] => [turn.who, turn.at]);
  return { handles, turns };
}

// Facts with neither make none. The caller checks the moment is a chat with turns.
export const OWN_WORD_WINDOW_MS = 6 * 3_600_000;
export function sourceOwnerWord(
  facts: { pushedAt?: string | undefined; vouched?: true | undefined; source?: MomentSource | undefined },
  endedAt: string,
): boolean {
  if (facts.source !== undefined && facts.vouched === true) return true;
  if (facts.pushedAt === undefined) return false;
  return Date.parse(facts.pushedAt) - Date.parse(endedAt) <= OWN_WORD_WINDOW_MS;
}

// Each is a prefix, "_" and a ULID; `hdl` is a one-time handle. The memory adapter's and the
// mirror's projections are `mpr_` and `mir_` with 40 hexadecimal characters, and the memory
// adapter's stamp begins `[pi:`.
export const SERVED_ID_PREFIXES: readonly string[] = deepFreeze([
  ...[
    "tex",
    "tpr",
    "tru",
    "aan",
    "atr",
    "acc",
    "adr",
    "als",
    "asg",
    "blb",
    "cal",
    "cas",
    "cli",
    "con",
    "crd",
    "dcc",
    "dcl",
    "doc",
    "dom",
    "dpc",
    "drf",
    "drt",
    "ent",
    "ers",
    "evt",
    "fct",
    "gdc",
    "gol",
  ],
  ...[
    "hrn",
    "hyp",
    "int",
    "itn",
    "mbd",
    "mcl",
    "mov",
    "mrl",
    "msg",
    "mus",
    "oas",
    "opp",
    "pag",
    "pan",
    "prp",
    "pvd",
    "rec",
    "rft",
    "rme",
    "rsp",
    "rsq",
    "rtr",
    "rul",
  ],
  ...["run", "rvw", "sel", "ses", "sls", "snt", "sup", "thr", "tpr", "trn", "tst", "umn", "wch", "wrq"],
  // Lens: a capture item, a mirror cursor, an inbox row and a scope rule.
  ...["cap", "mcr", "cin", "csr"],
  // An exclusion and a mapped account of the deny-list.
  ...["cex", "cac"],
  // A shadow prediction.
  "prd",
  // The owner's name for an organization.
  "onm",
  // A one-time handle.
  "hdl",
  "lst",
  // An agent message, an improvement and an improvement's event.
  ...["amg", "imp", "ime"],
  // An agent's learning.
  "lrn",
  ...["otr", "ott", "hoq"],
  // An area of the owner's life or work.
  "are",
  // A promotion, sent or taken.
  "prm",
]);
const SERVED = new RegExp(`(?:${SERVED_ID_PREFIXES.join("|")})_${ULID_PATTERN}|(?:mpr|mir)_[0-9a-f]{40}|\\[pi:`);

// Such text can only have come from the screen showing the system's own output.
export function systemIdIn(text: string): boolean {
  return SERVED.test(text);
}

export function meetingText(item: MeetingItem): {
  text: string;
  spans: { segment: string; from: number; to: number }[];
} {
  let text = "";
  const spans: { segment: string; from: number; to: number }[] = [];
  item.segments.forEach((segment, index) => {
    if (index > 0) text += "\n";
    text += `${segment.speaker ?? "S?"}: `;
    spans.push({ segment: `seg:${index}`, from: text.length, to: text.length + segment.text.length });
    text += segment.text;
  });
  if (item.notes !== undefined && item.notes !== "") {
    if (text !== "") text += "\n";
    text += "Notes: ";
    spans.push({ segment: "notes", from: text.length, to: text.length + item.notes.length });
    text += item.notes;
  }
  return { text, spans };
}
