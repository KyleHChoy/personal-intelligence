// Reading a moment and planning its group's one request: a moment's passages by turn, the group's
// participants, the `moments` slot, the bound on the request's size, and the owner's-word test on a
// moment's facts. Pure code over opened moments: nothing here calls a model or writes.

import type { CaptureMention, DueCapture, ItemProject, OpenedMoment } from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import type { Prompt } from "@intelligence/personal-models";
import { sha256 } from "./call-failure.ts";
import { EXTRACT_CONFIG } from "./config.ts";
import { CAPTURE_ACCOUNT, readBuilt, rendered } from "./interpret.ts";
import { MOMENT_PROJECT_VERSIONS, versionDoes } from "./lane-versions.ts";
import { ownWordMoment } from "./own-word.ts";
import { folded } from "./phrase-words.ts";
import { namedIn } from "./project-named.ts";
import { momentPrompt } from "./prompts.ts";

// One moment of a group as the store listed it: the group's members carry their own marks.
export type MomentMember = Omit<DueCapture, "moments">;

// `participant` is a mention's key into the group's participants (participantKey).
type MomentRange = {
  from: number;
  to: number;
  speaker: { kind: "owner" | "agent" } | { kind: "participant"; key: string } | null;
};

// A mention's identity for grouping and for the erasure check: its three parts, in a fixed order.
const participantKey = (mention: CaptureMention): string =>
  JSON.stringify([mention.name ?? null, mention.address ?? null, mention.handle ?? null]);

// So a turn is a participant's only while an equal mention is still sealed; otherwise nobody's.
// From version 4, consecutive turns of one speaker with only white space between them are one
// passage, up to MOMENT_PASSAGE_CHARS code units, so a thought sent as several bubbles is one
// passage to cite. Its speaker is theirs, so no credit changes.
export const MOMENT_PASSAGE_CHARS = 1_200;
export function momentRanges(opened: OpenedMoment, join = false): MomentRange[] {
  const ranges = turnRanges(opened);
  return join ? joinedRanges(ranges, opened.item.text) : ranges;
}

function joinedRanges(ranges: readonly MomentRange[], text: string, most = MOMENT_PASSAGE_CHARS): MomentRange[] {
  const same = (a: MomentRange["speaker"], b: MomentRange["speaker"]): boolean =>
    a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
  const joined: MomentRange[] = [];
  for (const range of ranges) {
    const last = joined[joined.length - 1];
    if (
      last !== undefined &&
      same(last.speaker, range.speaker) &&
      text.slice(last.to, range.from).trim() === "" &&
      range.to - last.from <= most
    )
      joined[joined.length - 1] = { ...last, to: range.to };
    else joined.push(range);
  }
  return joined;
}

// A run of them, with white space alone between, longer than can be typed may be pasted, and one
// holding a quoted line or a message's header is another's text: either refuses the whole moment, since
// Lens may send a paste in pieces. An agent's turn and text no turn covers are in no range, so nothing
// else of the moment is sent or can be cited. Weaker on purpose: another's words must not become the
// owner's.
export const OWN_LINE_MAX_CHARS = 2_000;
const QUOTED_LINE =
  /^\s*(?:>|(?:from|to|cc|bcc|subject|sent|date|reply-to):\s|on\s.{1,200}\swrote:\s*$|-{2,}\s*(?:forwarded|original)\s+message)/im;
export function ownLineRanges(opened: OpenedMoment): MomentRange[] {
  const text = opened.item.text;
  const runs = joinedRanges(
    turnRanges(opened).filter((range) => range.speaker?.kind === "owner"),
    text,
    Number.POSITIVE_INFINITY,
  );
  return runs.some((run) => run.to - run.from > OWN_LINE_MAX_CHARS || QUOTED_LINE.test(text.slice(run.from, run.to)))
    ? []
    : runs;
}

function turnRanges(opened: OpenedMoment): MomentRange[] {
  const { item, capture } = opened;
  const turns = item.turns;
  if (turns === undefined) return [{ from: 0, to: item.text.length, speaker: null }];
  const sealed = new Set(capture.facts.participants.map(participantKey));
  // Two participants the moment lists alike cannot be told apart: a turn naming either is nobody's.
  const keys = item.participants.map(participantKey);
  const twice = new Set(keys.filter((key, at) => keys.indexOf(key) !== at));
  const ranges: MomentRange[] = [];
  const gap = (from: number, to: number): void => {
    if (to > from && item.text.slice(from, to).trim() !== "") ranges.push({ from, to, speaker: null });
  };
  let at = 0;
  for (const turn of turns) {
    gap(at, turn.from);
    const mention = turn.participant === undefined ? undefined : item.participants[turn.participant];
    const key = mention === undefined ? null : participantKey(mention);
    const speaker =
      turn.speaker === "participant"
        ? key !== null && sealed.has(key) && !twice.has(key)
          ? { kind: "participant" as const, key }
          : null
        : { kind: turn.speaker };
    ranges.push({ from: turn.from, to: turn.to, speaker });
    at = turn.to;
  }
  gap(at, item.text.length);
  return ranges;
}

// The slot shows a label and a name, never an address or a handle. `bound` false leaves out the
// bound handles' names, so the request reads as it did before the handles bound.
export type MomentParticipant = { label: string; mention: CaptureMention; name?: string };
function groupParticipants(openeds: readonly OpenedMoment[], bound = true): Map<string, MomentParticipant> {
  const found = new Map<string, MomentParticipant>();
  for (const opened of openeds) {
    for (const mention of opened.capture.facts.participants) {
      const key = participantKey(mention);
      const name =
        mention.name ?? (mention.handle === undefined || !bound ? undefined : opened.handleNames?.[mention.handle]);
      const known = found.get(key);
      if (known === undefined)
        found.set(key, { label: `P${found.size + 1}`, mention, ...(name === undefined ? {} : { name }) });
      else if (known.name === undefined && name !== undefined) known.name = name;
    }
  }
  return found;
}

// The label a passage's speaker is shown by: owner, agent, a participant's label, or null.
const speakerLabel = (range: MomentRange, people: ReadonlyMap<string, MomentParticipant>): string | null =>
  range.speaker === null
    ? null
    : range.speaker.kind === "participant"
      ? (people.get(range.speaker.key)?.label ?? null)
      : range.speaker.kind;

// One moment as the shared functions take it: each passage one segment, `chars:<from>-<to>`, with
// no author and not quoted, its label verified as a message's is, against the row's whole label.
// The shared source kinds have no screen's, so it reads as a transcript, which nothing here changes.
function readMoment(
  opened: OpenedMoment,
  ranges: readonly MomentRange[] = [{ from: 0, to: opened.item.text.length, speaker: null }],
): { parsed: Parsed; read: ReadItem } {
  const { context, capture, item: moment } = opened;
  const text = moment.text;
  return readBuilt(
    {
      id: context.evidenceId,
      sourceKind: "transcript",
      sourceAccount: CAPTURE_ACCOUNT,
      revision: context.revision,
      contentHash: sha256(text),
      mediaType: "text/plain",
      observedAt: capture.observedAt,
      ingestedAt: capture.firstPushedAt,
      compartments: context.compartments,
    },
    context.compartments,
    text,
    ranges.map((range) => ({ span: `chars:${range.from}-${range.to}`, text: text.slice(range.from, range.to) })),
  );
}

// One passage of the request: its span as the model is shown it (`mom:<i>:<from>-<to>`, in code
// units of its moment's text), as the shared checker reads it (`chars:`), and as the store keeps
// it, with its speaker's label.
export type MomentPassage = {
  span: string;
  chars: string;
  stored: string;
  speaker: string | null;
  range: MomentRange;
  opened: OpenedMoment;
  member: MomentMember;
  parsed: Parsed;
  read: ReadItem;
};

// Nothing else of a moment is shown: no window, URL, account, thread, app, address or handle.
function momentSlot(
  moments: { index: number; opened: OpenedMoment; ranges: readonly MomentRange[] }[],
  bound = true,
  ownLines = false,
  told = false,
): { moments: string } {
  const people = ownLines
    ? new Map<string, MomentParticipant>()
    : groupParticipants(
        moments.map((one) => one.opened),
        bound,
      );
  return {
    moments: JSON.stringify({
      participants: [...people.values()].map(({ label, name }) => ({ label, ...(name === undefined ? {} : { name }) })),
      moments: moments.map(({ index, opened, ranges }) => ({
        kind: opened.capture.facts.entity,
        seen: opened.capture.observedAt,
        ...(told ? projectField(opened) : {}),
        passages: ranges.map((range) => ({
          span: `mom:${index}:${range.from}-${range.to}`,
          speaker: speakerLabel(range, people),
          text: opened.item.text.slice(range.from, range.to),
        })),
      })),
    }),
  };
}

const projectField = (opened: OpenedMoment): { project?: string } => {
  const project = momentProject(opened);
  return project === null ? {} : { project: project.name };
};

// `tooLong`: the moments that alone do not fit a request, each committed `too_long`. `later`: the
// moments past the bound once the request is full, left uncommitted and due, so a later page or run
// forms them into a group of their own. `people`: the group's participants as the slot shows them.
// `sent`: each moment sent, by its first passage, in the request's order.
// `prompt`: the version asked, whose types the check reads.
export type MomentPlan = {
  prompt: Prompt;
  passages: MomentPassage[];
  sent: MomentPassage[];
  tooLong: MomentMember[];
  later: MomentMember[];
  data: { moments: string };
  inputHash: string;
  people: Map<string, MomentParticipant>;
  ownLines?: true;
};

// A group is one request, so the moments past the bound wait for the next one (`later`), and only a
// moment that cannot fit even alone is `too_long`. Null when not one fits, so every moment is
// `too_long`. Every claim of the request is labelled by the moment it cites, so a group whose
// moments' labels differ would label a claim narrower than what the model read (invariant 4): the
// store never forms one, and one given is refused before anything is sent. `bound` as momentSlot's.
// `prompt`, the version asked, the lane's current one unless factKindPrompt chose another.
// `ownLines`: only each moment's own lines, and no participant.
export function planMoments(
  members: { opened: OpenedMoment; member: MomentMember }[],
  bound = true,
  prompt: Prompt = momentPrompt(),
  ownLines = false,
): MomentPlan | null {
  const label = JSON.stringify(members[0]?.opened.context.compartments ?? []);
  if (members.some(({ opened }) => JSON.stringify(opened.context.compartments) !== label))
    throw new Error("a moment group spans labels");
  const join = versionDoes("moment", prompt.version, "joinedTurns");
  const told = MOMENT_PROJECT_VERSIONS.includes(prompt.version);
  type Taken = { index: number; opened: OpenedMoment; member: MomentMember; ranges: MomentRange[] };
  const fits = (moments: Taken[]): boolean =>
    rendered(prompt, momentSlot(moments, bound, ownLines, told)).text.length <= EXTRACT_CONFIG.limits.promptChars;
  const taken: Taken[] = [];
  const tooLong: MomentMember[] = [];
  const later: MomentMember[] = [];
  for (const { opened, member } of members) {
    const ranges = ownLines ? ownLineRanges(opened) : momentRanges(opened, join);
    if (!fits([{ index: 0, opened, member, ranges }])) {
      tooLong.push(member);
      continue;
    }
    const next = { index: taken.length, opened, member, ranges };
    if (later.length > 0 || !fits([...taken, next])) {
      later.push(member);
      continue;
    }
    taken.push(next);
  }
  if (taken.length === 0) return null;
  const data = momentSlot(taken, bound, ownLines, told);
  const people = ownLines
    ? new Map<string, MomentParticipant>()
    : groupParticipants(
        taken.map((one) => one.opened),
        bound,
      );
  const perMoment = taken.map(({ index, opened, member, ranges }) => {
    const reading = readMoment(opened, ranges);
    return ranges.map((range) => ({
      span: `mom:${index}:${range.from}-${range.to}`,
      chars: `chars:${range.from}-${range.to}`,
      stored: `seg:${range.from}-${range.to}`,
      speaker: speakerLabel(range, people),
      range,
      opened,
      member,
      ...reading,
    }));
  });
  const passages = perMoment.flat();
  const sent = perMoment.map((one) => one[0] as MomentPassage);
  return {
    prompt,
    passages,
    sent,
    tooLong,
    later,
    data,
    inputHash: rendered(prompt, data).inputHash,
    people,
    ...(ownLines ? { ownLines: true as const } : {}),
  };
}

// The one project a chat is in, by the mail rule's name test over the owner's own lines under the
// owner's word and nothing else: no participant's line, no title and no app. Only with the store's
// projects, which the run asks for with the lanes on.
export function momentProject(opened: OpenedMoment): ItemProject | null {
  const projects = opened.projects ?? [];
  if (projects.length === 0 || !ownWordMoment(opened)) return null;
  const owners = momentRanges(opened).filter((range) => range.speaker?.kind === "owner");
  return namedIn(projects, folded(owners.map((range) => opened.item.text.slice(range.from, range.to)).join("\n")));
}
