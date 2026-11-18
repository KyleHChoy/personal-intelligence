import type { OpenedCapture } from "@intelligence/contracts/personal";
import { meetingText } from "@intelligence/personal-core/lens";

// A meeting's passages, its repaired turns and the measure of its speaker labels, by code, before
// any request. Pure functions over the item: nothing here reads a model's words. The meeting lane
// (meeting-plan.ts) and the meeting prompt's example (meeting-prompts.ts) use them.

// One passage of a meeting: one segment with text, its span in code units of meetingText as the
// model is shown it (`seg:`) and as the shared checker reads it (`chars:`), its range and its
// segment's index. Or a run of adjacent passages, its span the run's whole range, its text theirs
// joined by single spaces, and `parts` where each passage's text stands in it. `toMs` is its last
// segment's end, and `last` its last segment's index, so a turn of several segments, or a run of
// turns, knows what it spans.
export type MeetingPassage = {
  span: string;
  chars: string;
  speaker: string | null;
  channel: "input" | "output" | "mixed";
  fromMs: number;
  toMs: number;
  text: string;
  from: number;
  to: number;
  index: number;
  last: number;
  parts: { speaker: string | null; at: number; length: number }[];
  // A turn whose sentence a diarizer cut across labels, at its start or its end: with the labels
  // reliable overall, a line of it is still nobody's known words.
  cut?: boolean;
  notes?: true;
};

export function meetingPassages(item: OpenedCapture["item"]): { text: string; passages: MeetingPassage[] } {
  const { text, spans } = meetingText(item);
  const passages = spans.flatMap((span, index): MeetingPassage[] => {
    if (span.segment === "notes") {
      const at = item.segments.at(-1)?.toMs ?? 0;
      const notes = item.notes ?? "";
      const owner = item.speakers.find((one) => one.owner)?.label ?? null;
      const gap = item.segments.length + 1;
      return [
        {
          span: `seg:${span.from}-${span.to}`,
          chars: `chars:${span.from}-${span.to}`,
          speaker: owner,
          channel: "input",
          fromMs: at,
          toMs: at,
          text: notes,
          from: span.from,
          to: span.to,
          index: gap,
          last: gap,
          parts: [{ speaker: owner, at: 0, length: notes.length }],
          notes: true,
        },
      ];
    }
    const segment = item.segments[index];
    if (segment === undefined || segment.text === "") return [];
    return [
      {
        span: `seg:${span.from}-${span.to}`,
        chars: `chars:${span.from}-${span.to}`,
        speaker: segment.speaker,
        channel: segment.channel,
        fromMs: segment.fromMs,
        toMs: segment.toMs,
        text: segment.text,
        from: span.from,
        to: span.to,
        index,
        last: index,
        parts: [{ speaker: segment.speaker, at: 0, length: segment.text.length }],
      },
    ];
  });
  return { text, passages };
}

// Adjacent passages as one: its range from the first's start to the last's end, its texts joined
// by single spaces, and where each passage's own parts stand in that text. Its speaker is the one
// label of every part, else none; its channel the one channel, else mixed.
export function joinPassages(run: readonly MeetingPassage[]): MeetingPassage {
  const head = run[0] as MeetingPassage;
  const tail = run[run.length - 1] as MeetingPassage;
  const parts: MeetingPassage["parts"] = [];
  let at = 0;
  for (const one of run) {
    for (const part of one.parts) parts.push({ ...part, at: at + part.at });
    at += one.text.length + 1;
  }
  const speakers = new Set(parts.map((part) => part.speaker));
  const channels = new Set(run.map((one) => one.channel));
  return {
    span: `seg:${head.from}-${tail.to}`,
    chars: `chars:${head.from}-${tail.to}`,
    speaker: speakers.size === 1 ? head.speaker : null,
    channel: channels.size === 1 ? head.channel : "mixed",
    fromMs: head.fromMs,
    toMs: tail.toMs,
    text: run.map((one) => one.text).join(" "),
    from: head.from,
    to: tail.to,
    index: head.index,
    last: tail.last,
    parts,
    ...(run.some((one) => one.cut === true) ? { cut: true } : {}),
  };
}

// Turn repair and the labels' reliability, by code, before any request. A segment of fewer than
// FRAGMENT_WORDS words is a fragment. A sentence is the segments from one that follows a sentence's
// end to one whose text ends with . ! or ?, with no segment blanked between them; it is mixed when
// its segments carry more than one label (no label counts as one). The labels are unreliable when,
// over at least RELIABILITY_MIN_SENTENCES sentences, at least MIXED_SENTENCE_SHARE of them are
// mixed, or, over at least RELIABILITY_MIN_SEGMENTS segments, at least FRAGMENT_SHARE of them are
// fragments, and whenever there are fewer than RELIABILITY_MIN_SENTENCES sentences to measure by.
// The diagnosed meeting: 59 of 74 sentences mixed.
export const FRAGMENT_WORDS = 4;
export const MIXED_SENTENCE_SHARE = 0.25;
const FRAGMENT_SHARE = 0.5;
const RELIABILITY_MIN_SENTENCES = 4;
export const RELIABILITY_MIN_SEGMENTS = 10;
// A turn: consecutive segments, each at most TURN_GAP_MS after the one before, their texts joined
// at most TURN_MAX_CHARS code units.
export const TURN_GAP_MS = 2_000;
export const TURN_MAX_CHARS = 600;
// From the meeting prompt's version 4, a segment that ends no sentence joins the next one up to
// TURN_PAUSE_MS after it, so a speaker's pause mid-sentence does not cut it in two.
export const TURN_PAUSE_MS = 4_000;

export type Fragmentation = {
  segments: number;
  fragments: number;
  sentences: number;
  mixed: number;
  reliable: boolean;
};

const ENDS_SENTENCE = /[.!?]["')\]’”]*\s*$/u;
const wordsIn = (text: string): number => text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
const follows = (next: MeetingPassage, before: MeetingPassage, gap = TURN_GAP_MS): boolean =>
  next.index === before.last + 1 && next.fromMs - before.toMs <= gap;

// The passages by sentence, as `fragmentation` reads them: from one that follows a sentence's end
// to one that ends one, and a gap where a segment was blanked ends one too.
function sentencesOf(passages: readonly MeetingPassage[]): MeetingPassage[][] {
  const sentences: MeetingPassage[][] = [];
  let open: MeetingPassage[] = [];
  passages.forEach((one, n) => {
    const before = passages[n - 1];
    if (before !== undefined && open.length > 0 && one.index !== before.last + 1) {
      sentences.push(open);
      open = [];
    }
    open.push(one);
    if (ENDS_SENTENCE.test(one.text) || n === passages.length - 1) {
      sentences.push(open);
      open = [];
    }
  });
  return sentences;
}

export function fragmentation(all: readonly MeetingPassage[]): Fragmentation {
  const passages = all.filter((one) => one.notes !== true);
  const fragments = passages.filter((one) => wordsIn(one.text) < FRAGMENT_WORDS).length;
  const sentences = sentencesOf(passages);
  const mixed = sentences.filter((sentence) => new Set(sentence.map((one) => one.speaker)).size > 1).length;
  // Fewer than RELIABILITY_MIN_SENTENCES sentences is too little to measure by, as a
  // transcript with no punctuation is, and fails closed.
  const reliable =
    sentences.length >= RELIABILITY_MIN_SENTENCES &&
    mixed < MIXED_SENTENCE_SHARE * sentences.length &&
    !(passages.length >= RELIABILITY_MIN_SEGMENTS && fragments >= FRAGMENT_SHARE * passages.length);
  return { segments: passages.length, fragments, sentences: sentences.length, mixed, reliable };
}

// A call's channels, measured as the labels are. Lens sets each segment's channel from the device
// its transcript came from (input, the owner's microphone; output, the call's remote audio; mixed
// when it has none), so in a call a sentence of one voice is on one channel. A sentence is mixed
// when it holds more than one channel or a segment of channel mixed. The channels are clean when,
// over at least RELIABILITY_MIN_SENTENCES sentences, fewer than MIXED_SENTENCE_SHARE of them are
// mixed, and at least one sentence is on each of input and output: a call with no remote sentence
// shows nothing the channels separated.
export type Channels = { sentences: number; mixed: number; clean: boolean };
export function channelMixing(all: readonly MeetingPassage[]): Channels {
  const sentences = sentencesOf(all.filter((one) => one.notes !== true));
  const channelOf = (sentence: MeetingPassage[]): MeetingPassage["channel"] => {
    const channels = new Set(sentence.map((one) => one.channel));
    return channels.size === 1 ? (sentence[0] as MeetingPassage).channel : "mixed";
  };
  const channels = sentences.map(channelOf);
  const mixed = channels.filter((one) => one === "mixed").length;
  const clean =
    sentences.length >= RELIABILITY_MIN_SENTENCES &&
    mixed < MIXED_SENTENCE_SHARE * sentences.length &&
    channels.includes("input") &&
    channels.includes("output");
  return { sentences: sentences.length, mixed, clean };
}

// The turns: with reliable labels, consecutive segments of one speaker on one channel; with
// unreliable ones, consecutive segments of any label up to a sentence's end, so a sentence the
// diarization cut is one passage again. Each turn is joined as a run is (joinPassages). `pause` is
// how long after a segment that ends no sentence the next may start and still join it: TURN_GAP_MS
// before version 4, so its saved calls replay, TURN_PAUSE_MS from it.
export function repairTurns(
  passages: readonly MeetingPassage[],
  reliable: boolean,
  pause = TURN_GAP_MS,
): MeetingPassage[] {
  const turns: MeetingPassage[] = [];
  let open: MeetingPassage[] = [];
  const close = (): void => {
    if (open.length > 0) turns.push(open.length === 1 ? (open[0] as MeetingPassage) : joinPassages(open));
    open = [];
  };
  for (const one of passages) {
    const before = open[open.length - 1];
    const joins =
      before !== undefined &&
      follows(one, before, ENDS_SENTENCE.test(before.text) ? TURN_GAP_MS : pause) &&
      open.reduce((sum, part) => sum + part.text.length + 1, one.text.length) <= TURN_MAX_CHARS &&
      (reliable ? one.speaker === before.speaker && one.channel === before.channel : !ENDS_SENTENCE.test(before.text));
    if (!joins) close();
    open.push(one);
  }
  close();
  // Where the labels are reliable overall, a turn that ends mid-sentence into the next turn's other
  // label, or starts mid-sentence after the last one's, within the pause a sentence may span, is
  // cut.
  if (!reliable) return turns;
  return turns.map((one, n) => {
    const before = turns[n - 1];
    const after = turns[n + 1];
    const into =
      after !== undefined &&
      follows(after, one, pause) &&
      after.speaker !== one.speaker &&
      !ENDS_SENTENCE.test(one.text);
    const from =
      before !== undefined &&
      follows(one, before, pause) &&
      before.speaker !== one.speaker &&
      !ENDS_SENTENCE.test(before.text);
    return into || from ? { ...one, cut: true } : one;
  });
}
