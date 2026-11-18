// How a meeting is asked: its passages, groups and windows, the slot each call carries and the
// plan for the whole meeting, with the run bounds and the prompt versions that change them.

import type { MeetingCaptureFacts, OpenedCapture } from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import type { Prompt } from "@intelligence/personal-models";
import { sha256 } from "./call-failure.ts";
import { EXTRACT_CONFIG } from "./config.ts";
import { CAPTURE_ACCOUNT, readBuilt, rendered } from "./interpret.ts";
import { type VersionBehaviour, versionDoes } from "./lane-versions.ts";
import {
  MEETING_RUN_CHARS,
  MEETING_RUN_PASSAGES,
  MEETING_TURN_RUN_CHARS,
  MEETING_TURN_RUN_PASSAGES,
} from "./meeting-prompts.ts";
import { meetingPrompt } from "./prompts.ts";
import {
  type Channels,
  channelMixing,
  type Fragmentation,
  fragmentation,
  joinPassages,
  type MeetingPassage,
  meetingPassages,
  repairTurns,
  TURN_GAP_MS,
  TURN_PAUSE_MS,
} from "./turns.ts";

export const MEETING_MAX_CALLS = 6;

// A run's bounds: over segments, or over repaired turns, which are already whole sentences, so a
// run of turns is only for a claim whose words cross two to four turns.
type RunBounds = { passages: number; chars: number };
export const SEGMENT_RUN: RunBounds = { passages: MEETING_RUN_PASSAGES, chars: MEETING_RUN_CHARS };

export const TURN_RUN: RunBounds = { passages: MEETING_TURN_RUN_PASSAGES, chars: MEETING_TURN_RUN_CHARS };

// A listed span is its passage. With runs allowed (a room asked with version 2 or later, or from version
// 3 a meeting whose labels are unreliable), `FIRST..LAST`, two listed spans, the first before the last,
// is the run of every passage between them: at most `bounds.passages`, their texts joined by single
// spaces at most `bounds.chars` code units, and no segment the recovery check blanked between them.
// Anything else cites nothing, and the check refuses it (`bad_span`).
export function citedPassage(
  span: string,
  group: readonly MeetingPassage[],
  runs: boolean,
  bounds: RunBounds = SEGMENT_RUN,
): MeetingPassage | undefined {
  const listed = group.find((one) => one.span === span);
  if (listed !== undefined || !runs) return listed;
  const ends = span.split("..");
  if (ends.length !== 2) return undefined;
  const first = group.findIndex((one) => one.span === ends[0]);
  const last = group.findIndex((one) => one.span === ends[1]);
  if (first < 0 || last <= first || last - first + 1 > bounds.passages) return undefined;
  const run = group.slice(first, last + 1);
  if (run.some((one, n) => n > 0 && one.index !== (run[n - 1] as MeetingPassage).last + 1)) return undefined;
  const joined = joinPassages(run);
  return joined.text.length > bounds.chars ? undefined : joined;
}

// With no slice in the text, the passage's speaker: a run's only when every passage of it has that
// one speaker. Otherwise none.
export function claimSpeaker(passage: MeetingPassage, slices: readonly string[]): string | null {
  if (passage.parts.length === 1) return passage.speaker;
  const counts = new Map<string | null, number>();
  let total = 0;
  for (const slice of slices) {
    const at = passage.text.indexOf(slice);
    if (at < 0 || slice === "") continue;
    for (const part of passage.parts) {
      const overlap = Math.max(0, Math.min(at + slice.length, part.at + part.length) - Math.max(at, part.at));
      counts.set(part.speaker, (counts.get(part.speaker) ?? 0) + overlap);
      total += overlap;
    }
  }
  if (total === 0) return passage.speaker;
  for (const [speaker, count] of counts) if (count * 2 > total) return speaker;
  return null;
}

// The speakers as the slot lists them: each linked participant numbered P1, P2 and so on by its
// first speaker, from the drain's answer. No address is shown. From version 3, a speaker's name as
// the owner labelled it, as a moment's participants are shown, so the model can tell from the words
// who is speaking when the labels are unreliable.
function speakersOf(
  facts: MeetingCaptureFacts,
  named: boolean,
): { label: string; owner: boolean; participant: string | null; name?: string }[] {
  const numbered = new Map<string, string>();
  return facts.speakers.map((speaker) => {
    const entity = facts.linked?.speakers[speaker.label];
    if (entity !== undefined && !numbered.has(entity)) numbered.set(entity, `P${numbered.size + 1}`);
    const name = named ? speaker.mention?.name : undefined;
    return {
      label: speaker.label,
      owner: speaker.owner,
      participant: entity === undefined ? null : (numbered.get(entity) ?? null),
      ...(name === undefined ? {} : { name }),
    };
  });
}

// From version 3, `labels` says whether code found the speaker labels reliable, and each speaker's
// name. With `remote` (from version 4, `remoteHint`), a passage wholly on the output channel says
// so, as `channel: "remote"`; no other passage carries a channel.
function meetingSlot(
  opened: OpenedCapture,
  passages: MeetingPassage[],
  labels?: "reliable" | "unreliable",
  remote = false,
): { meeting: string } {
  const { facts } = opened.capture;
  return {
    meeting: JSON.stringify({
      title: facts.title ?? "",
      start: opened.item.startedAt,
      mode: facts.mode,
      ...(labels === undefined ? {} : { labels }),
      speakers: speakersOf(facts, labels !== undefined),
      passages: passages.map((passage) => ({
        span: passage.span,
        speaker: passage.speaker,
        text: passage.text,
        ...(remote && passage.channel === "output" ? { channel: "remote" } : {}),
      })),
    }),
  };
}

export function groupMeeting<T>(
  passages: T[],
  size: (group: T[]) => number,
  bound: number,
  most: number,
): { groups: T[][]; leftOut: number } {
  const groups: T[][] = [];
  let at = 0;
  while (at < passages.length && groups.length < most) {
    const group: T[] = [];
    while (at < passages.length && size([...group, passages[at] as T]) <= bound) group.push(passages[at++] as T);
    if (group.length === 0) break;
    groups.push(group);
  }
  return { groups, leftOut: passages.length - at };
}

// Windows. A long meeting is asked in overlapping windows of turns, each about
// MEETING_WINDOW_CHARS of turn text, the next starting with the last turns of the one before that
// hold at least MEETING_WINDOW_OVERLAP_CHARS, so a fact said across the cut is whole in one. At
// most MEETING_MAX_WINDOWS; the turns after them are counted left out and logged.
const MEETING_WINDOW_CHARS = 8_000;
const MEETING_WINDOW_OVERLAP_CHARS = 1_000;
export const MEETING_MAX_WINDOWS = 24;

export function windowMeeting<T>(
  items: readonly T[],
  length: (one: T) => number,
  fits: (window: T[]) => boolean,
  most: number,
  runs: RunBounds = TURN_RUN,
): { groups: T[][]; leftOut: number } {
  const windows: T[][] = [];
  let start = 0;
  let done = 0;
  while (done < items.length && windows.length < most) {
    // Turns to about MEETING_WINDOW_CHARS, then the prompt bound checked once and the
    // window shortened from its end until it fits, rather than a render for every turn.
    let end = start;
    let chars = 0;
    while (end < items.length && (end === start || chars + length(items[end] as T) <= MEETING_WINDOW_CHARS))
      chars += length(items[end++] as T);
    while (end > start && !fits(items.slice(start, end))) end -= 1;
    // A window that adds no turn past the last one's end is not asked: start again at that end,
    // with no overlap, or stop when even one turn does not fit.
    if (end <= done) {
      if (start === done) break;
      start = done;
      continue;
    }
    windows.push(items.slice(start, end));
    done = end;
    if (end >= items.length) break;
    // The overlap also holds the start of every run a model may cite across the cut,
    // at most runs.passages turns of at most runs.chars code units, so each is whole in one window.
    let next = end;
    let overlap = 0;
    const reaches = (): boolean =>
      end - (next - 1) <= runs.passages - 1 && overlap + length(items[next - 1] as T) <= runs.chars;
    while (next - 1 > start && (overlap < MEETING_WINDOW_OVERLAP_CHARS || reaches()))
      overlap += length(items[--next] as T);
    start = next;
  }
  return { groups: windows, leftOut: items.length - done };
}

export type MeetingGroup = {
  passages: MeetingPassage[];
  spans: ReadonlySet<string>;
  data: { meeting: string };
  text: string;
  inputHash: string;
};
// `prompt` is the version the meeting is asked with, the lane's latest. From version 3, `passages`
// are the repaired turns, `groups` the windows, and `labels` the fragmentation measure; before it,
// the segments, the greedy groups and no measure.
export type MeetingPlan = {
  parsed: Parsed;
  read: ReadItem;
  text: string;
  passages: MeetingPassage[];
  groups: MeetingGroup[];
  leftOut: number;
  prompt: Prompt;
  labels: Fragmentation | null;
  // From version 3, a call's channel measure and its segments whose label and
  // channel disagree (`channelLabelDisagree`), else null; `remote`, from version 4, whether the
  // slot marks the remote passages (`remoteHint`).
  channels: (Channels & { disagree: number }) | null;
  remote: boolean;
};

// What a meeting prompt's version does (lane-versions.ts VersionBehaviour). A call keeps the rules of
// the version it was asked.
const does = (prompt: Prompt, behaviour: VersionBehaviour): boolean =>
  versionDoes("meeting", prompt.version, behaviour);
export const tiesFrom = (prompt: Prompt): boolean => does(prompt, "ties");
export const roomContextFrom = (prompt: Prompt): boolean => does(prompt, "roomContext");

// The people the meeting's calendar entry and the owner's typed attendees name who are not the
// owner, each once: by address; a mention with no address by its name, unless an addressed
// mention or the owner's speaker carries that name; else by handle.
function othersInvited(facts: MeetingCaptureFacts, ownerAddresses: readonly string[]): number {
  const fold = (text: string): string => text.trim().toLowerCase();
  const owner = new Set(ownerAddresses.map(fold));
  const mentions = [
    ...(facts.calendar === null
      ? []
      : [...(facts.calendar.organizer === null ? [] : [facts.calendar.organizer]), ...facts.calendar.attendees]),
    ...(facts.attendees ?? []),
  ];
  const ownerName = facts.speakers.find((speaker) => speaker.owner)?.mention?.name;
  const named = new Set([
    ...mentions.flatMap((mention) =>
      mention.address !== undefined && mention.name !== undefined ? [fold(mention.name)] : [],
    ),
    ...(ownerName === undefined ? [] : [fold(ownerName)]),
  ]);
  const keys = new Set(
    mentions.flatMap((mention) => {
      if (mention.address !== undefined)
        return owner.has(fold(mention.address)) ? [] : [`address:${fold(mention.address)}`];
      if (mention.name !== undefined) return named.has(fold(mention.name)) ? [] : [`name:${fold(mention.name)}`];
      return mention.handle === undefined ? [] : [`handle:${fold(mention.handle)}`];
    }),
  );
  return keys.size;
}

// Whether the slot marks a call's remote passages, when its labels are unreliable. The output
// channel carries the call's remote audio alone, so a passage wholly on it was said by someone on
// the other end. Marked only when that is one person, as far as code can tell: a call, one speaker
// marked the owner and exactly one not, exactly one person other than the owner invited
// (`othersInvited`; a meeting with no calendar entry and no typed attendees has none), and clean
// channels (`channelMixing`). The input side is never marked: the owner's microphone also carries a
// second voice in the room, a speakerphone or the owner's speakers' echo, and no wording tells a
// first-person line of that voice's from the owner's. The mark changes only whom the model says a claim is about:
// every claim of a meeting whose labels are unreliable is still credited to nobody
// (attributeMeeting), so the owner's word never rests on a channel.
function remoteHint(opened: OpenedCapture, labels: Fragmentation, channels: Channels | null): boolean {
  const { facts } = opened.capture;
  if (labels.reliable || facts.mode !== "call" || channels === null || !channels.clean) return false;
  // Exactly one speaker marked the owner, so "the one who is not the owner" is not
  // also the label of the owner's own lines.
  return (
    facts.speakers.filter((speaker) => speaker.owner).length === 1 &&
    facts.speakers.filter((speaker) => !speaker.owner).length === 1 &&
    othersInvited(facts, opened.context.ownerAddresses) === 1
  );
}

// A call's segments whose label and channel disagree: the owner-marked label on the output
// channel, or another label on the input one; a segment of no known channel is neither. Counted
// for meeting_checked; it grants nothing.
// With no speaker marked the owner there is nothing to disagree with, and none is counted.
export function channelLabelDisagree(opened: OpenedCapture): number {
  const owner = opened.capture.facts.speakers.find((speaker) => speaker.owner)?.label;
  if (owner === undefined) return 0;
  return opened.item.segments.filter(
    (segment) =>
      segment.text !== "" &&
      segment.speaker !== null &&
      (segment.speaker === owner ? segment.channel === "output" : segment.channel === "input"),
  ).length;
}

// The meeting as the shared functions take it: one segment per passage, no author and not quoted,
// its label verified as a message's is, against the row's whole label. Then its groups, or from
// version 3 its turns and windows.
export function planMeeting(opened: OpenedCapture, prompt: Prompt = meetingPrompt()): MeetingPlan {
  const { context, capture } = opened;
  const { text, passages: segments } = meetingPassages(opened.item);
  const labels = does(prompt, "turns") ? fragmentation(segments) : null;
  const passages =
    labels === null
      ? segments
      : repairTurns(segments, labels.reliable, does(prompt, "pauseAndRemote") ? TURN_PAUSE_MS : TURN_GAP_MS);
  const channels =
    labels !== null && opened.capture.facts.mode === "call"
      ? { ...channelMixing(segments), disagree: channelLabelDisagree(opened) }
      : null;
  const remote = labels !== null && does(prompt, "pauseAndRemote") && remoteHint(opened, labels, channels);
  const { parsed, read } = readBuilt(
    {
      id: context.evidenceId,
      sourceKind: "transcript",
      sourceAccount: CAPTURE_ACCOUNT,
      revision: context.revision,
      contentHash: sha256(text),
      mediaType: "application/json",
      observedAt: capture.startedAt,
      ingestedAt: capture.firstPushedAt,
      compartments: context.compartments,
    },
    context.compartments,
    text,
    passages.map((passage) => ({ span: passage.chars, text: passage.text })),
  );
  const slotOf = (group: MeetingPassage[]) =>
    meetingSlot(opened, group, labels === null ? undefined : labels.reliable ? "reliable" : "unreliable", remote);
  const fits = (group: MeetingPassage[]): boolean =>
    rendered(prompt, slotOf(group)).text.length <= EXTRACT_CONFIG.limits.promptChars;
  const { groups, leftOut } =
    labels === null
      ? groupMeeting(
          passages,
          (group) => rendered(prompt, slotOf(group)).text.length,
          EXTRACT_CONFIG.limits.promptChars,
          MEETING_MAX_CALLS,
        )
      : windowMeeting(passages, (one) => one.text.length, fits, MEETING_MAX_WINDOWS);
  return {
    parsed,
    read,
    text,
    passages,
    leftOut,
    prompt,
    labels,
    channels,
    remote,
    groups: groups.map((group) => {
      const data = slotOf(group);
      return { passages: group, spans: new Set(group.map((one) => one.chars)), data, ...rendered(prompt, data) };
    }),
  };
}
