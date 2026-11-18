import type { Claim, Timestamp } from "@intelligence/contracts";
import { type BeliefClaim, type FactRetirement, keyPhraseOf, type SubjectKind } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { saysShortTime } from "@intelligence/personal-core/views";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "./build-belief.ts";
import { PERSONAL_ONTOLOGY } from "./ontology.ts";

// How time reads the owner's beliefs, decided by code at every belief build from what each claim
// already holds, so it reaches every stored claim at the next rebuild with no model call. Three
// rules: a momentary situation ends a week after it was said; a lasting one the owner holds goes
// stale after a year, not 60 days; and a retire holds until the fact is stated again. A fourth
// picks the owner's questions that may be lasting needs, for the owner to confirm.

// A situation said with a same-day or next-day word (personal-core's SHORT_TIME_WORDS), or whose
// `until` falls within this many days of its time, is momentary.
const MOMENT_DAYS = 7;

const isKind = (claim: Claim, kind: string): boolean => PERSONAL_ONTOLOGY.get(claim.content.type)?.beliefKind === kind;
// The claim's words: a version 4 claim's key phrase (a situation's `state`, a need's `object`),
// else its `what`.
const phrase = (claim: Claim): string => keyPhraseOf(claim.content.type, claim.content.fields) ?? "";
const at = (time: string): number => Date.parse(time);

export function momentary(claim: Claim): boolean {
  if (!isKind(claim, "situation")) return false;
  return (
    claim.content.fields.momentary === true ||
    saysShortTime(phrase(claim)) ||
    (claim.validTo !== undefined && at(claim.validTo) - at(claim.validFrom) <= MOMENT_DAYS * DAY_MS)
  );
}

// The claim as the build is given it: a momentary situation with no `until` ends MOMENT_DAYS after
// its time, so buildBelief expires it then, as it does any claim's `validTo`. An
// `until` the source gave is kept, earlier or later. Every other claim is unchanged.
export function timed(claim: Claim): Claim {
  if (claim.validTo !== undefined || !momentary(claim)) return claim;
  return { ...claim, validTo: new Date(at(claim.validFrom) + MOMENT_DAYS * DAY_MS).toISOString() as Timestamp };
}

// A fact key's counted claims as the build is given them, each `timed`. A situation is one fact per
// subject, so a momentary one that has ended is left out while any other claim remains: "at the dentist
// today" must not hide "living abroad" once its day is past. When every claim has ended, all are given,
// and the belief is expired.
export function currentClaims(kept: readonly BeliefClaim[], asOf: string): BeliefClaim[] {
  const all = kept.map((one) => ({ ...one, claim: timed(one.claim) }));
  const live = all.filter(
    ({ claim }) => !(momentary(claim) && claim.validTo !== undefined && at(claim.validTo) <= at(asOf)),
  );
  return live.length > 0 ? live : all;
}

// A lasting situation of the owner's: stale after a year, and never past that in practice (the
// base rule needs an end: a century). Passed as an override; DEFAULT_LIFECYCLE, which
// every other kind and subject keeps, is unchanged.
export const OWNER_LIFECYCLE: LifecyclePolicy = Object.freeze({
  ...DEFAULT_LIFECYCLE,
  situation: { staleAfterDays: 365, endAfterDays: 36_500, end: "dormant" },
});

export const lifecycleOf = (subjectKind: SubjectKind | undefined): LifecyclePolicy =>
  subjectKind === "owner" ? OWNER_LIFECYCLE : DEFAULT_LIFECYCLE;

// The retire that closes this audience's belief, if any: the latest in force of its fact key
// whose compartments the audience holds, while no counted claim is dated after it and by `asOf`.
// A later statement reopens the belief; the retire stays recorded, and `pi correct lift` lifts it.
export function retiredBy(
  retirements: readonly FactRetirement[],
  factKeyFp: string,
  covers: (compartments: readonly string[]) => boolean,
  counted: readonly Claim[],
  asOf: string,
): FactRetirement | undefined {
  const latest = retirements
    .filter((one) => one.factKeyFp === factKeyFp && covers(one.compartments))
    .reduce<FactRetirement | undefined>(
      (best, one) => (best === undefined || at(one.at) > at(best.at) ? one : best),
      undefined,
    );
  if (latest === undefined) return undefined;
  const restated = counted.some(
    (claim) => !claim.systemOriginated && at(claim.validFrom) > at(latest.at) && at(claim.validFrom) <= at(asOf),
  );
  return restated ? undefined : latest;
}

// The owner's needs asked as questions that they may confirm as lasting: their own words (code resolved
// the owner as the speaker), about themselves, a `need` of statement kind `question`, from a source, not yet
// confirmed, with no same-day or next-day word, and said within a need's stale limit, so a
// confirmed one is active. Their claim ids, the latest first; the store raises their cards up to
// its daily cap.
export function needQuestions(groups: readonly { claims: readonly BeliefClaim[] }[], asOf: string): string[] {
  const window = (DEFAULT_LIFECYCLE.need?.staleAfterDays ?? 60) * DAY_MS;
  const asked = groups
    .flatMap((group) => group.claims)
    .filter(({ claim, origin, subjectKind, ownerSaid, ownerConfirmed }) => {
      const age = at(asOf) - at(claim.validFrom);
      return (
        origin === "source" &&
        subjectKind === "owner" &&
        ownerSaid === true &&
        ownerConfirmed !== true &&
        !claim.systemOriginated &&
        claim.basis === "explicit_self" &&
        claim.statementKind === "question" &&
        isKind(claim, "need") &&
        phrase(claim).trim() !== "" &&
        !saysShortTime(phrase(claim)) &&
        age >= 0 &&
        age <= window
      );
    })
    .map(({ claim }) => claim)
    .sort((a, b) => at(b.validFrom) - at(a.validFrom) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...new Set(asked.map((claim) => claim.id as string))];
}
