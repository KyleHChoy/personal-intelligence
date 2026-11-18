import type { ClaimCandidate, IdentityResolver, Mention } from "@intelligence/contracts";
import { FactType, type FiledMention, MENTION_FIELD } from "@intelligence/contracts/personal";
import { groundName, groundText, personalType } from "@intelligence/personal-beliefs";
import { type Parsed, segmentAt } from "@intelligence/personal-core";
import { OWNER_THIS, type OwnerKeys, ownerNamedWhole } from "./check.ts";

// Filed name mentions. A `name` mention links nobody: the identity port resolves it only through the
// owner's binding, and a candidate one of whose name mentions resolves nobody is no claim. Such a
// candidate is filed with its item's commit, one row for each name mention in it, so the owner can list
// it against people by name and bind it. A project mention is a source id, never a name, so it is never
// filed. Only wholeNames changes what the check decides: a partial name is unmapped
// `ungrounded_mention`, not `unresolved`.

// The port as the check uses it, noting each name it answered nobody for.
export function notingUnresolved(port: IdentityResolver): {
  identity: IdentityResolver;
  unresolved: ReadonlySet<string>;
} {
  const unresolved = new Set<string>();
  return {
    unresolved,
    identity: {
      async resolve(mention, store, requestId, from) {
        const resolution = await port.resolve(mention, store, requestId, from);
        if (mention.key.kind === "name" && resolution.outcome !== "linked") unresolved.add(mention.key.value);
        return resolution;
      },
    },
  };
}

const isMention = (value: unknown): value is Mention =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { key?: { kind?: unknown; value?: unknown } }).key?.value === "string";

const partial = (mention: unknown, text: string): mention is Mention =>
  isMention(mention) &&
  mention.key.kind === "name" &&
  groundText(mention.key.value, text, "phrase") !== null &&
  groundName(mention.key.value, text) === null;

// A source id that is neither a mention code resolves nor a domain, which no grounding rule accepts.
const UNGROUNDED = { kind: "source_id", value: "partial-name" } as const;

// Before the shared check: each partial name is replaced by UNGROUNDED, so the check refuses its
// candidate as `ungrounded_mention` before any mention is resolved, bound or not.
// A name the segment does not hold at all is left to the port. Only the subject and an entity
// field hold a mention: a text value is a string.
export function wholeNames(candidates: readonly ClaimCandidate[], parsed: Parsed): ClaimCandidate[] {
  return candidates.map((candidate) => {
    const text = segmentAt(parsed, candidate.span)?.text;
    if (text === undefined) return candidate;
    const swap = <T>(value: T): T | Mention => (partial(value, text) ? { ...value, key: UNGROUNDED } : value);
    return {
      ...candidate,
      subject: swap(candidate.subject),
      fields: Object.fromEntries(Object.entries(candidate.fields).map(([name, value]) => [name, swap(value)])),
    };
  });
}

// Before the shared check, a finding's: `owner:this` in an entity field (a next step's `who`) needs the
// owner named whole in the segment it cites, since no card follows a fact about a project; anything less
// is replaced by UNGROUNDED, so the claim is refused. The subject is the hook's, a card following.
export function ownerInFields(
  candidates: readonly ClaimCandidate[],
  parsed: Parsed,
  owner: OwnerKeys,
): ClaimCandidate[] {
  return candidates.map((candidate) => {
    const text = segmentAt(parsed, candidate.span)?.text ?? "";
    return {
      ...candidate,
      fields: Object.fromEntries(
        Object.entries(candidate.fields).map(([name, value]) => [
          name,
          isMention(value) && value.key.value === OWNER_THIS && !ownerNamedWhole(owner, text)
            ? { ...value, key: UNGROUNDED }
            : value,
        ]),
      ),
    };
  });
}

// The most an item files: ExtractionCommit's cap.
const MAX_FILED = 200;

// A candidate the shared check refuses before resolving a mention is never filed, though another of
// the same name is: one with a partial name, one of an unknown type, with a field its type does not
// declare or without one it requires, whose span names no segment, or (but in a document, as the
// agent lane's records are read) whose segment has no author. A quoted segment is never the
// sender's own words, so its candidate could never be a claim, bound or not. The name is kept as
// the model wrote it, so a replay of the same saved call finds the binding by its fingerprint. At
// most MAX_FILED, in the candidates' order.
//
// A message's speaker is its segment's author, by address, unless the message is automated, as the
// shared check credits it; first-hand when the subject's address is the author's. A meeting or a
// chat gives `credit`, the participant the lane credits the cited line to. An agent record's lines
// and a line credited to nobody have no speaker and are never first-hand.
export type MentionKey = { kind: "address" | "name"; value: string };
export type Credit = { speaker: MentionKey; firstHand: boolean };
export type FilingOptions = {
  document: boolean;
  fingerprint?: ((key: MentionKey) => string | null) | undefined;
  credit?: (candidate: ClaimCandidate) => Credit | null;
};

const keyOf = (key: { kind: string; value: string }): MentionKey | undefined =>
  key.kind === "address" || key.kind === "name" ? { kind: key.kind, value: key.value } : undefined;
const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
// Whether a subject's key is the speaker's own: the same address, in any case, or the same name.
export const sameKey = (subject: { kind: string; value: string }, speaker: MentionKey): boolean =>
  subject.kind === speaker.kind &&
  (speaker.kind === "address" ? sameAddress(subject.value, speaker.value) : subject.value === speaker.value);

// A message's credit: its segment's author, as the shared check's speaker for an unquoted segment.
const authorCredit = (candidate: ClaimCandidate, author: Mention | undefined, automated: boolean): Credit | null => {
  if (author === undefined || automated || author.key.kind !== "address") return null;
  const speaker: MentionKey = { kind: "address", value: author.key.value };
  return { speaker, firstHand: sameKey(candidate.subject.key, speaker) };
};

export function fileable(
  candidates: readonly ClaimCandidate[],
  parsed: Parsed,
  unresolved: ReadonlySet<string>,
  options: FilingOptions = { document: false },
): FiledMention[] {
  if (unresolved.size === 0) return [];
  const fp = (key: MentionKey | undefined): string | undefined =>
    key === undefined ? undefined : (options.fingerprint?.(key) ?? undefined);
  const filed = candidates.flatMap((candidate) => {
    const type = personalType(candidate.type);
    const known = FactType.safeParse(candidate.type);
    const segment = segmentAt(parsed, candidate.span);
    if (type === undefined || !known.success || segment === undefined || segment.quoted) return [];
    if (Object.keys(candidate.fields).some((name) => !type.fields.some((spec) => spec.name === name))) return [];
    if (type.fields.some((spec) => spec.required && !Object.hasOwn(candidate.fields, spec.name))) return [];
    if (segment.author === undefined && !options.document) return [];
    const mentions: [string, unknown][] = [
      [MENTION_FIELD, candidate.subject],
      ...type.fields
        .filter((spec) => spec.kind === "entity")
        .map((spec): [string, unknown] => [spec.name, candidate.fields[spec.name]]),
    ];
    // A candidate with a partial name is refused (wholeNames): none of its names is filed.
    if (mentions.some(([, mention]) => partial(mention, segment.text))) return [];
    const credit =
      options.credit !== undefined
        ? options.credit(candidate)
        : options.document
          ? null
          : authorCredit(candidate, segment.author, parsed.automated);
    const speakerFp = fp(credit?.speaker);
    // A subject that is the credited speaker by label (`speaker:S2`) has the speaker's key.
    const firstHand = speakerFp !== undefined && credit?.firstHand === true;
    const subjectFp = fp(keyOf(candidate.subject.key)) ?? (firstHand ? speakerFp : undefined);
    const carries = {
      firstHand,
      ...(subjectFp === undefined ? {} : { subjectFp }),
      ...(speakerFp === undefined ? {} : { speakerFp }),
    };
    return mentions.flatMap(([field, mention]): FiledMention[] => {
      if (!isMention(mention) || mention.key.kind !== "name" || !unresolved.has(mention.key.value)) return [];
      const name = mention.key.value;
      if (name.length > 200 || groundText(name, segment.text, "phrase") === null) return [];
      return [{ name, type: known.data, field, ...carries }];
    });
  });
  return filed.slice(0, MAX_FILED);
}
