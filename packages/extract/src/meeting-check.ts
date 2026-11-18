// Each group's call and the code that checks every candidate: its span, speaker, ties and
// duplicates, with a tally of what became of each. The moment lane shares the identity
// recording, the drop codes and the speaker filings.

import type { Claim, ClaimCandidate, InterpreterOutput, Mention } from "@intelligence/contracts";
import type { DueCapture, FiledMention, MeetingCaptureFacts, OpenedCapture } from "@intelligence/contracts/personal";
import { normal, personalType } from "@intelligence/personal-beliefs";
import type { GroundingHook, Parsed } from "@intelligence/personal-core";
import { type CaptureTally, citedAs, dropCode, recordingAnswers, SPEAKER, speakerNames } from "./capture-check.ts";
import { personalGrounding, strip } from "./check.ts";
import { type CallPort, interpret } from "./interpret.ts";
import type { Found } from "./item-ends.ts";
import { checkClaims, withheldBy } from "./lane-check.ts";
import { ontologyFor, versionDoes } from "./lane-versions.ts";
import {
  attributeMeeting,
  type MeetingCredit,
  meetingCredit,
  type meetingIdentity,
  ownWordMeeting,
} from "./meeting-identity.ts";
import {
  citedPassage,
  type MeetingGroup,
  type MeetingPlan,
  roomContextFrom,
  SEGMENT_RUN,
  TURN_RUN,
  tiesFrom,
} from "./meeting-plan.ts";
import { type Credit, type FilingOptions, fileable, notingUnresolved, wholeNames } from "./mentions.ts";
import { withSharedDetail } from "./refused.ts";
import type { MeetingPassage } from "./turns.ts";

// Whether a claim about a speaker (its subject a `speaker:` mention) stands on nothing that ties
// it, where the labels are unreliable. Code decides this because asking the model not to guess did
// not stop it mis-attributing. A passage wholly on the remote stream that the slot marked ties its
// claims to the one listed speaker not marked the owner, so one about the owner-marked label is
// untied. A passage of the owner's own line (`ownLine`) ties a claim about the owner, and nobody
// else's, so the owner's own "I'll send it Friday" stands though it names nobody. Any other passage ties a claim only
// when it names, as a whole word, a listed speaker's first name (whom the line is spoken to, or
// who speaks), from the speakers' names in the sealed facts. The name must stand in the sentence of the cited passage that holds the claim's words:
// the sentence sharing most of the words of its text fields (enum fields such as a domain left
// out, hesitations and marks ignored), so a name in another sentence ties nothing, and a claim no
// sentence shares a word with is untied (fail closed). A subject written as a listed speaker's
// name or address is that speaker's, so it is tied the same way.
const HESITATIONS = new Set(["uh", "um", "er", "erm", "ah"]);
const tieWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length >= 3 && !HESITATIONS.has(word));
export function textValuesOf(type: string, fields: Readonly<Record<string, unknown>>): string[] {
  const spec = personalType(type);
  return (spec?.fields ?? [])
    .filter((one) => one.kind === "text")
    .flatMap((one) => (typeof fields[one.name] === "string" ? [fields[one.name] as string] : []));
}
function speakerLabelOf(subject: Mention, facts: MeetingCaptureFacts): string | null {
  const { kind, value } = subject.key;
  if (kind === "source_id") return value.startsWith(SPEAKER) ? value.slice(SPEAKER.length) : null;
  const folded = value.trim().toLowerCase();
  const speaker = facts.speakers.find((one) =>
    kind === "name"
      ? one.mention?.name?.trim().toLowerCase() === folded
      : kind === "address" && one.mention?.address?.trim().toLowerCase() === folded,
  );
  return speaker?.label ?? null;
}
// Whether a passage is the owner's own line, where the meeting-wide labels are unreliable: a
// consented call whose channels are clean and agree with the labels in every segment (`channels`:
// each owner-labelled segment on input and each other label on output, so the input channel carried
// no second labelled voice), the passage wholly on input, labelled the owner's and not cut across
// labels, and no output segment overlapping it in time carrying half or more of its words, which
// would make it the remote voice's echo on the owner's microphone. A second person in the room whom
// the diarizer gave the owner's label is not told apart by any of these.
export type OwnLine = {
  channels: { clean: boolean; disagree: number } | null;
  segments: readonly { channel: string; fromMs: number; toMs: number; text: string }[];
};
const ECHO_SHARE = 0.5;
function ownLine(cited: MeetingPassage, facts: MeetingCaptureFacts, own: OwnLine | undefined): boolean {
  const owners = facts.speakers.filter((one) => one.owner);
  if (own === undefined || owners.length !== 1 || !facts.consent || facts.mode !== "call") return false;
  if (own.channels === null || !own.channels.clean || own.channels.disagree !== 0) return false;
  if (cited.channel !== "input" || cited.cut === true || cited.speaker !== owners[0]?.label) return false;
  const words = new Set(tieWords(cited.text));
  if (words.size === 0) return false;
  const heard = new Set(
    own.segments
      .filter((one) => one.channel === "output" && one.fromMs <= cited.toMs && one.toMs >= cited.fromMs)
      .flatMap((one) => tieWords(one.text)),
  );
  return [...words].filter((word) => heard.has(word)).length < ECHO_SHARE * words.size;
}
export function untied(
  subject: Mention,
  cited: MeetingPassage,
  remote: boolean,
  facts: MeetingCaptureFacts,
  values: readonly string[] = [],
  own?: OwnLine,
): boolean {
  const label = speakerLabelOf(subject, facts);
  if (label === null) return false;
  const others = facts.speakers.filter((one) => !one.owner);
  if (remote && cited.channel === "output" && others.length === 1) return others[0]?.label !== label;
  if (
    label === cited.speaker &&
    facts.speakers.some((one) => one.owner && one.label === label) &&
    ownLine(cited, facts, own)
  )
    return false;
  const firstNames = facts.speakers.flatMap((one) => {
    const first = one.mention?.name?.trim().split(/\s+/u)[0];
    return first === undefined || first === "" ? [] : [first.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")];
  });
  if (firstNames.length === 0) return true;
  const named = new RegExp(`(?<![\\p{L}\\p{N}])(?:${firstNames.join("|")})(?![\\p{L}\\p{N}])`, "u");
  const want = new Set(values.flatMap(tieWords));
  // A claim with no text field (a relationship) is tied by a name anywhere in its passage.
  if (want.size === 0) return !named.test(cited.text);
  const sentences = (cited.text.match(/[^.!?]+[.!?]*/gu) ?? [cited.text]).map((text) => ({
    text,
    score: new Set(tieWords(text).filter((word) => want.has(word))).size,
  }));
  const best = Math.max(0, ...sentences.map((one) => one.score));
  return best === 0 || !sentences.some((one) => one.score === best && named.test(one.text));
}

const meetingGrounding =
  (labels: ReadonlySet<string>): GroundingHook =>
  (mention, segment) =>
    mention.key.kind === "source_id" && mention.key.value.startsWith(SPEAKER)
      ? labels.has(mention.key.value.slice(SPEAKER.length))
      : personalGrounding(mention, segment);

// A narrowing that withholds on any group ends the whole meeting before any check, unless the owner
// released it, and no later group is sent.
export async function askMeeting(
  plan: MeetingPlan,
  port: CallPort,
  override: boolean,
): Promise<
  | { withheld: "quarantine" | "sensitive" }
  | { answers: { output: InterpreterOutput; inputHash: string; group: MeetingGroup }[] }
> {
  const answers: { output: InterpreterOutput; inputHash: string; group: MeetingGroup }[] = [];
  for (const group of plan.groups) {
    const { output, inputHash } = await interpret(plan.prompt, group.data, plan.parsed, plan.read, port);
    const withheld = withheldBy(output.narrowing);
    if (withheld !== undefined && !override) return { withheld };
    answers.push({ output, inputHash, group });
  }
  return { answers };
}

// Name mentions no one resolved are filed, a speaker known by name alone among them. Each
// candidate's outcome is counted. From version 3: runs also where the labels are unreliable, within
// TURN_RUN; the durable grounding; the credit by the labels' reliability; and, since windows
// overlap, a claim with the fact key of one already kept whose cited range overlaps that one's is a
// `duplicate`. Each window's outcomes are counted on their own too (`windows`), and the kept claims
// whose explicit_self the unreliable labels narrowed (`inferred`), which is no outcome.
type MeetingChecked = Found & {
  mentions: FiledMention[];
  tally: CaptureTally;
  windows: CaptureTally[];
  inferred: number;
};
export async function checkMeeting(
  answers: { output: InterpreterOutput; inputHash: string; group: MeetingGroup }[],
  plan: MeetingPlan,
  opened: OpenedCapture,
  due: DueCapture,
  generation: number,
  identity: ReturnType<typeof meetingIdentity>,
  // When given, each candidate's own code, in order, for the evaluation's `--detail`.
  outcomes?: string[],
  fingerprint?: FilingOptions["fingerprint"],
): Promise<MeetingChecked> {
  const found: MeetingChecked = {
    claims: [],
    unmapped: [],
    unresolved: 0,
    mentions: [],
    tally: {},
    windows: [],
    inferred: 0,
  };
  const labels = new Set(opened.capture.facts.speakers.map((speaker) => speaker.label));
  const ownWord = ownWordMeeting(opened);
  const names = notingUnresolved(identity.port);
  const v3 = plan.labels !== null;
  const reliable = plan.labels?.reliable !== false;
  const room = opened.capture.facts.mode === "room";
  const runs = (room && versionDoes("meeting", plan.prompt.version, "roomRuns")) || !reliable;
  const bounds = v3 ? TURN_RUN : SEGMENT_RUN;
  const ontology = ontologyFor("meeting", plan.prompt.version);
  const seen = new Set<string>();
  const kept: { factKey: string; text: string; from: number; to: number }[] = [];
  const asked: { candidate: ClaimCandidate; parsed: Parsed; credit: Credit | null }[] = [];
  for (const { output, inputHash, group } of answers) {
    const window: CaptureTally = {};
    found.windows.push(window);
    const count = (code: string): void => {
      found.tally[code] = (found.tally[code] ?? 0) + 1;
      window[code] = (window[code] ?? 0) + 1;
      if (code !== "candidates") outcomes?.push(code);
    };
    const narrowing = due.override ? "none" : output.narrowing;
    for (const raw of strip(output.claims)) {
      count("candidates");
      const cited = citedPassage(raw.span, group.passages, runs, bounds);
      const run = raw.span.includes("..");
      // Where the labels are unreliable, a claim about a speaker stands only on a passage that
      // ties it to one, by code: a remote-marked passage, for the one speaker not the owner, the
      // owner's own line on the input channel, for the owner, or a passage that names a listed
      // speaker by first name. Model output only narrows.
      // Tested before the shared check, so a refused subject files no mention.
      // From version 7 a room is not refused: people in a room seldom say each
      // other's names, so its subjects are the model's from context, credited to nobody as before.
      if (
        tiesFrom(plan.prompt) &&
        !reliable &&
        !(room && roomContextFrom(plan.prompt)) &&
        cited !== undefined &&
        untied(raw.subject, cited, plan.remote, opened.capture.facts, textValuesOf(raw.type, raw.fields), {
          channels: plan.channels,
          segments: opened.item.segments,
        })
      ) {
        count("untied_subject");
        continue;
      }
      // A span that cites nothing is marked unlisted, which no segment holds, so the check refuses
      // it (`bad_span`). A run is a segment of its own, its passages' texts joined, for this
      // candidate alone.
      const candidate = { ...raw, span: cited?.chars ?? `unlisted:${raw.span}` };
      const extra = cited !== undefined && run;
      const parsed: Parsed = extra
        ? {
            ...plan.parsed,
            segments: [...plan.parsed.segments, { span: cited.chars, quoted: false, text: cited.text }],
          }
        : plan.parsed;
      const one: (typeof asked)[number] = { candidate, parsed, credit: null };
      asked.push(one);
      const recorded = recordingAnswers(names.identity);
      const whole = wholeNames([candidate], parsed);
      const { found: result, unresolved } = await checkClaims(
        whole,
        // `document`: a passage has no author for the shared checker; the lane credits a claim itself.
        { parsed, read: plan.read, narrowing, changeKind: "live", inputHash, document: true },
        { generation, ontology, identity: recorded.identity, grounded: meetingGrounding(labels) },
        async () => {
          const speaker =
            cited === undefined || cited.speaker === null ? null : await identity.speakerWho(cited.speaker);
          const credit: MeetingCredit = { reliable, run, durable: v3 };
          one.credit =
            cited === undefined
              ? null
              : meetingCredit(opened, cited, raw, speaker, ownWord, credit, identity.speakerKey);
          return {
            parsed,
            due,
            lane: "meeting",
            passages: extra ? new Set([...group.spans, cited.chars]) : group.spans,
            promptVersion: plan.prompt.version,
            capture: {
              ownerEntity: opened.context.ownerEntity,
              kindOf: identity.kindOf,
              startedAt: opened.capture.startedAt,
              captureKey: opened.capture.key,
              durable: v3,
              ownerPresent:
                opened.capture.facts.speakers.some((one) => one.owner) ||
                opened.capture.facts.linked?.ownerBacked === true,
              attribute: (claim) =>
                cited === undefined
                  ? "bad_speaker"
                  : attributeMeeting(opened, cited, raw, claim, speaker, ownWord, credit),
            },
          };
        },
      );
      found.unresolved += unresolved;
      const [record] = result.claims;
      const [refused] = result.unmapped;
      if (record !== undefined && cited !== undefined) {
        // The same fact key, the same stored words and overlapping evidence, so two
        // promises of one turn, which share a key that holds no text, stay two.
        const text = textValues(record.claim);
        const again = kept.some(
          (one) => one.factKey === record.factKey && one.text === text && one.from < cited.to && cited.from < one.to,
        );
        if (seen.has(record.claim.id) || again) count("duplicate");
        else {
          seen.add(record.claim.id);
          kept.push({ factKey: record.factKey, text, from: cited.from, to: cited.to });
          found.claims.push(citedAs(record, cited.span));
          count("kept");
          if (!reliable && raw.basis === "explicit_self") found.inferred += 1;
        }
      } else count(dropCode(refused, raw.type, whole[0]?.subject ?? raw.subject, recorded.answered));
      for (const one of withSharedDetail(result.unmapped, whole, (type) => ontology.get(type)))
        if (!found.unmapped.some((other) => other.id === one.id)) found.unmapped.push(one);
    }
  }
  const filed = asked.flatMap(({ candidate, parsed, credit }) =>
    fileable([candidate], parsed, names.unresolved, { document: true, fingerprint, credit: () => credit }),
  );
  found.mentions = [
    ...filed,
    ...(await speakerNames(
      asked.map((one) => one.candidate),
      identity,
    )),
  ];
  return found;
}

// A kept claim's stored text values, by field, in a normal form: what dedupe compares.
function textValues(claim: Claim): string {
  const type = personalType(claim.content.type);
  return JSON.stringify(
    (type?.fields ?? [])
      .filter((spec) => spec.kind === "text")
      .map((spec) => normal(String(claim.content.fields[spec.name] ?? "")).text.trim()),
  );
}

// A count of zero is left out but the shape's.
export function meetingShape(plan: MeetingPlan, checked: Pick<MeetingChecked, "windows" | "inferred">): CaptureTally {
  const shape: CaptureTally = { windows: plan.groups.length, left_out: plan.leftOut };
  if (plan.labels !== null) {
    Object.assign(shape, {
      turns: plan.passages.length,
      segments: plan.labels.segments,
      fragments: plan.labels.fragments,
      sentences: plan.labels.sentences,
      mixed_sentences: plan.labels.mixed,
      labels_unreliable: plan.labels.reliable ? 0 : 1,
    });
  }
  // A call's channel measure, its label and channel disagreements, and the
  // passages the slot marked remote.
  if (plan.channels !== null) {
    Object.assign(shape, {
      channel_sentences: plan.channels.sentences,
      channel_mixed_sentences: plan.channels.mixed,
      channel_label_disagree: plan.channels.disagree,
      remote_hint: plan.remote ? 1 : 0,
    });
    if (plan.remote) shape.remote_passages = plan.passages.filter((one) => one.channel === "output").length;
  }
  if (checked.inferred > 0) shape.inferred_credit = checked.inferred;
  checked.windows.forEach((window, n) => {
    for (const [code, value] of Object.entries(window)) shape[`window_${n}_${code}`] = value;
  });
  return shape;
}
