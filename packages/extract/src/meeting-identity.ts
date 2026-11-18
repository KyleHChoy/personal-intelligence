// Who a meeting's speakers and mentions are, when a line can be the owner's own word, and whom
// each claim is credited to.
import {
  type Claim,
  type ClaimCandidate,
  type LocalEntityId,
  type Mention,
  RequestId,
  type Timestamp,
} from "@intelligence/contracts";
import type { CaptureMention, OpenedCapture, SubjectKind } from "@intelligence/contracts/personal";
import { groundDurableAt, groundText, personalType } from "@intelligence/personal-beliefs";
import { normalizeAddress, strictAddress } from "@intelligence/personal-core";
import { attendeeAddress, meetingOwner } from "@intelligence/personal-core/items";
import { OWN_WORD_WINDOW_MS } from "@intelligence/personal-core/lens";
import { sha256 } from "./call-failure.ts";
import { SPEAKER, speakerPort } from "./capture-check.ts";
import type { MeetingAttribution } from "./check.ts";
import { claimSpeaker } from "./meeting-plan.ts";
import { type Credit, type MentionKey, sameKey } from "./mentions.ts";
import type { MeetingPassage } from "./turns.ts";

function slicesOf(claim: Claim, text: string, durable: boolean): string[] {
  const type = personalType(claim.content.type);
  if (type === undefined) return [];
  return type.fields.flatMap((spec) => {
    const value = claim.content.fields[spec.name];
    if (spec.kind !== "text" || typeof value !== "string") return [];
    const how = type.grounding[spec.name] ?? "phrase";
    const slice = durable
      ? ((at) => (at === null ? null : text.slice(at.from, at.to)))(groundDurableAt(value, text, how))
      : groundText(value, text, how);
    return slice === null ? [] : [slice];
  });
}

// Who a mention is: an entity, a name alone (filed, never linked), or nobody.
export type Who = { entity: LocalEntityId; kind: SubjectKind } | { name: string } | null;

// The identity step of a meeting: the owner-marked speaker is the owner; a speaker of a linked
// meeting is the participant the drain sealed for it; any other mention with an address is checked as
// one strict addr-spec and linked through the port, which links an address held by exactly one entity
// under the meeting's label; a name alone goes to the port, which links it only through the owner's
// binding, and otherwise is filed. A phone handle links nothing here. Before any of that, a mention
// that is the owner (`meetingOwner`: one of their addresses, or a name the meeting knows the owner
// by) is the owner and nobody else, whatever binding or namesake the name has, so the owner is never
// a participant, never met and never filed.
export function meetingIdentity(opened: OpenedCapture) {
  const { context, capture } = opened;
  const ownAddresses = new Set(context.ownerAddresses.flatMap((one) => normalizeAddress(one) ?? []));
  const isOwner = meetingOwner(capture.facts, (address) => ownAddresses.has(address));
  const kinds = new Map<string, SubjectKind>();
  const observedAt = capture.startedAt;
  let asked = 0;
  const ask = (mention: Mention) =>
    context.identity.resolve(
      mention,
      "personal",
      RequestId.parse(sha256(JSON.stringify([context.evidenceId, context.revision, "meeting", (asked += 1)]))),
    );
  const linked = (entity: LocalEntityId, kind: SubjectKind | undefined): Who => {
    const known = kind ?? opened.kindOf(entity) ?? "person";
    kinds.set(entity, known);
    return { entity, kind: known };
  };

  const mentionWho = async (mention: CaptureMention | null | undefined): Promise<Who> => {
    if (mention === null || mention === undefined) return null;
    if (isOwner(mention)) return linked(context.ownerEntity, "owner");
    if (mention.address !== undefined) {
      if (!strictAddress(mention.address)) return null;
      const resolution = await ask({ key: { kind: "address", value: mention.address }, observedAt });
      return resolution.outcome === "linked" ? linked(resolution.entity, undefined) : null;
    }
    if (mention.name !== undefined) {
      const resolution = await ask({ key: { kind: "name", value: mention.name }, observedAt });
      return resolution.outcome === "linked" ? linked(resolution.entity, undefined) : { name: mention.name };
    }
    return null;
  };

  const byAttendee = (mention: CaptureMention | null): CaptureMention | null => {
    if (mention === null || mention.address !== undefined || mention.name === undefined) return mention;
    const address = attendeeAddress(capture.facts, mention.name);
    return address === null ? mention : { name: mention.name, address };
  };
  const speakers = new Map<string, Promise<Who>>();
  const speakerWho = (label: string): Promise<Who> => {
    let found = speakers.get(label);
    if (found === undefined) {
      const speaker = capture.facts.speakers.find((one) => one.label === label);
      // The participant the drain sealed for the speaker, which may be the owner's entity.
      const sealed = capture.facts.linked?.speakers[label] as LocalEntityId | undefined;
      found =
        speaker === undefined
          ? Promise.resolve(null)
          : speaker.owner
            ? Promise.resolve(linked(context.ownerEntity, "owner"))
            : sealed !== undefined
              ? Promise.resolve(linked(sealed, sealed === context.ownerEntity ? "owner" : "person"))
              : mentionWho(byAttendee(speaker.mention));
      speakers.set(label, found);
    }
    return found;
  };

  // A name mention resolves only by the owner's or the sync's binding: a calendar address never
  // relinks a name the owner unbound (invariant 11).
  const port = speakerPort(speakerWho, async (mention, store, requestId, from) => {
    const resolution = await context.identity.resolve(mention, store, requestId, from);
    if (resolution.outcome === "linked") linked(resolution.entity, undefined);
    return resolution;
  });
  // A sealed participant's is its mention's.
  const speakerKey = (label: string): MentionKey | undefined => {
    const speaker = capture.facts.speakers.find((one) => one.label === label);
    if (speaker === undefined) return undefined;
    if (speaker.owner) {
      const [first] = [...ownAddresses].sort();
      return first === undefined ? undefined : { kind: "address", value: first };
    }
    const mention = byAttendee(speaker.mention);
    if (mention === null || mention === undefined) return undefined;
    if (mention.address !== undefined)
      return strictAddress(mention.address) ? { kind: "address", value: mention.address } : undefined;
    return mention.name === undefined ? undefined : { kind: "name", value: mention.name };
  };
  return {
    port,
    speakerWho,
    mentionWho,
    speakerKey,
    kindOf: (entity: LocalEntityId): SubjectKind | undefined => kinds.get(entity) ?? opened.kindOf(entity),
  };
}

// First-hand when the subject is that speaker, by label or by key.
export function meetingCredit(
  opened: OpenedCapture,
  passage: MeetingPassage,
  candidate: ClaimCandidate,
  speaker: Who,
  ownWord: boolean,
  credit: MeetingCredit,
  keyOfSpeaker: (label: string) => MentionKey | undefined,
): Credit | null {
  const { facts } = opened.capture;
  const label = passage.speaker;
  if (
    !credit.reliable ||
    credit.run ||
    label === null ||
    passage.cut === true ||
    !facts.consent ||
    facts.mode !== "call"
  )
    return null;
  const marked = facts.speakers.find((one) => one.label === label);
  if (marked === undefined) return null;
  if (
    marked.owner
      ? !ownWord || passage.channel !== "input"
      : speaker === null || !("entity" in speaker) || speaker.entity === opened.context.ownerEntity
  )
    return null;
  const key = keyOfSpeaker(label);
  if (key === undefined) return null;
  const subject = candidate.subject.key;
  return {
    speaker: key,
    firstHand: (subject.kind === "source_id" && subject.value === `${SPEAKER}${label}`) || sameKey(subject, key),
  };
}

// The cited segment's own channel is the attribution's to check.
export function ownWordMeeting(opened: OpenedCapture): boolean {
  const { facts, endedAt } = opened.capture;
  const owner = facts.speakers.find((speaker) => speaker.owner);
  if (!facts.consent || facts.mode !== "call" || owner === undefined) return false;
  if (facts.linked === null || !facts.linked.ownerBacked) return false;
  if (facts.pushedAt === undefined || Date.parse(facts.pushedAt) - Date.parse(endedAt) > OWN_WORD_WINDOW_MS)
    return false;
  return opened.item.segments.every((segment) => segment.speaker === owner.label || segment.channel === "output");
}

// A claim the model says its subject states about themselves (basis explicit_self) must have as
// subject the speaker of its passage: its speaker is that passage's, and a claim whose speaker is
// not every cited segment's is `bad_speaker`. Its valid_from is the meeting's start and the
// passage's offset. `run` when the claim cited FIRST..LAST, on which the owner's word never rests;
// a repaired turn of one speaker on one channel is that speaker's line, unless a sentence of it was
// cut across labels (`cut`), when it is nobody's. With the labels unreliable (`reliable` false),
// who said a line is the model's guess from context, never code's knowledge: the claim is credited
// to nobody, basis third_party, and the model's explicit_self is narrowed to that rather than
// refused, since the labels it would be checked against are the unreliable ones.
export type MeetingCredit = { reliable: boolean; run: boolean; durable: boolean };
export function attributeMeeting(
  opened: OpenedCapture,
  passage: MeetingPassage,
  candidate: ClaimCandidate,
  claim: Claim,
  speaker: Who,
  ownWord: boolean,
  credit: MeetingCredit,
): MeetingAttribution {
  const validFrom = new Date(Date.parse(opened.capture.startedAt) + passage.fromMs).toISOString() as Timestamp;
  const nobody: MeetingAttribution = { basis: "third_party", validFrom };
  if (!credit.reliable) return nobody;
  const subject = candidate.subject.key;
  // In a run, the speaker of the claim's own words.
  const label = claimSpeaker(passage, slicesOf(claim, passage.text, credit.durable));
  if (
    candidate.basis === "explicit_self" &&
    !(subject.kind === "source_id" && label !== null && subject.value === `${SPEAKER}${label}`)
  )
    return "bad_speaker";
  const { facts } = opened.capture;
  // A run is cited only in a room, so the owner's word never rests on one.
  if (
    label === null ||
    credit.run ||
    passage.speaker === null ||
    passage.cut === true ||
    !facts.consent ||
    facts.mode !== "call"
  )
    return nobody;
  const marked = facts.speakers.find((one) => one.label === label);
  if (marked === undefined) return nobody;
  const owner = opened.context.ownerEntity;
  if (marked.owner) {
    if (!ownWord || passage.channel !== "input") return nobody;
    return { basis: claim.content.subject === owner ? "explicit_self" : "third_party", assertedBy: owner, validFrom };
  }
  return speaker !== null && "entity" in speaker && speaker.entity !== owner
    ? { basis: "third_party", assertedBy: speaker.entity, validFrom }
    : nobody;
}
