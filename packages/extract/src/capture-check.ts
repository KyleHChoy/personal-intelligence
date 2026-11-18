import type { ClaimCandidate, IdentityResolver, LocalEntityId, Mention } from "@intelligence/contracts";
import { type ClaimRecord, FactType, type FiledMention, MENTION_FIELD } from "@intelligence/contracts/personal";
import { personalType } from "@intelligence/personal-beliefs";
import { strictAddress } from "@intelligence/personal-core";
import type { PersonalUnmapped } from "./check.ts";

// What the two capture lanes, meeting and moment, share of checking a candidate. Each lane's own
// credit and attribution stay in its own file: a meeting's rest on how reliable its labels are, a
// moment's on whether Lens marked a line the owner's.

// A speaker mention's prefix: `speaker:<label>`.
export const SPEAKER = "speaker:";

// The identity port a capture's check is given: a speaker mention through `speakerWho` by its
// label, an address that is not one strict addr-spec as no person, and any other mention through
// `others`.
export const speakerPort = (
  speakerWho: (label: string) => Promise<{ entity: LocalEntityId } | { name: string } | null>,
  others: IdentityResolver["resolve"],
): IdentityResolver => ({
  async resolve(mention, store, requestId, from) {
    if (mention.key.kind === "source_id" && mention.key.value.startsWith(SPEAKER)) {
      const who = await speakerWho(mention.key.value.slice(SPEAKER.length));
      return who !== null && "entity" in who
        ? { outcome: "linked", entity: who.entity, epoch: 0 }
        : { outcome: "not_a_person" };
    }
    if (mention.key.kind === "address" && !strictAddress(mention.key.value)) return { outcome: "not_a_person" };
    return others(mention, store, requestId, from);
  },
});

// The stored span is the `seg:` form of what the claim cites: the passage the model was shown, or a
// run's whole range.
export const citedAs = (record: ClaimRecord, span: string): ClaimRecord => {
  const [cited, ...rest] = record.claim.evidence;
  return cited === undefined
    ? record
    : { ...record, claim: { ...record.claim, evidence: [{ ...cited, span }, ...rest] } };
};

// A count of zero is left out.
export type CaptureTally = Record<string, number>;
const mentionKey = (mention: Mention): string =>
  JSON.stringify([
    mention.key.kind,
    mention.key.kind === "address" ? mention.key.value.toLowerCase() : mention.key.value,
  ]);

export function recordingAnswers(identity: IdentityResolver): {
  identity: IdentityResolver;
  answered: Map<string, string>;
} {
  const answered = new Map<string, string>();
  return {
    answered,
    identity: {
      async resolve(mention, store, requestId, from) {
        const resolution = await identity.resolve(mention, store, requestId, from);
        answered.set(mentionKey(mention), resolution.outcome);
        return resolution;
      },
    },
  };
}

export function dropCode(
  refused: PersonalUnmapped | undefined,
  type: string,
  subject: Mention,
  answered: ReadonlyMap<string, string>,
): string {
  if (refused !== undefined)
    return refused.reason === "unknown_type" && personalType(type) !== undefined ? "type_not_in_lane" : refused.reason;
  if ([...answered.values()].includes("candidate")) return "held_for_review";
  return answered.get(mentionKey(subject)) !== "linked" ? "unresolved_subject" : "unresolved_field";
}

// A speaker known by a name alone, named by a candidate of a known type: filed as a name mention
// is, so the owner can bind it. The moment lane's participants too, by its own `speakerWho`.
export async function speakerNames(
  candidates: ClaimCandidate[],
  identity: { speakerWho(label: string): Promise<{ name: string } | { entity: LocalEntityId } | null> },
): Promise<FiledMention[]> {
  const filed: FiledMention[] = [];
  for (const candidate of candidates) {
    const type = personalType(candidate.type);
    const known = FactType.safeParse(candidate.type);
    if (type === undefined || !known.success) continue;
    const mentions: [string, unknown][] = [
      [MENTION_FIELD, candidate.subject],
      ...type.fields
        .filter((spec) => spec.kind === "entity")
        .map((spec): [string, unknown] => [spec.name, candidate.fields[spec.name]]),
    ];
    for (const [field, mention] of mentions) {
      const key = (mention as { key?: { kind?: unknown; value?: unknown } } | undefined)?.key;
      if (key?.kind !== "source_id" || typeof key.value !== "string" || !key.value.startsWith(SPEAKER)) continue;
      const who = await identity.speakerWho(key.value.slice(SPEAKER.length));
      if (who !== null && "name" in who) filed.push({ name: who.name.slice(0, 200), type: known.data, field });
    }
  }
  return filed;
}
