import type { Claim } from "@intelligence/contracts";
import {
  type BeliefClaim,
  type ClaimTier,
  CORRECTION_PIPELINE,
  isSystemNotice,
  keyPhraseOf,
  type PersonalBeliefKind,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { ownStatement } from "@intelligence/personal-core/views";
import { namesOrganizationEntity } from "./fact-key.ts";
import { normal } from "./grounding.ts";
import { personalType } from "./ontology.ts";
import { claimTier, ownerSideTiers, ranksAbove } from "./tier.ts";

// `counts` says which claims of a fact key reach buildBelief; `conflict` is its `conflict` option,
// read over the claims that counted. A kind with no row builds no belief. Nothing here reads a
// model's words but the slices stored.

// `ownerSaid` says a claim's speaker is the owner, as the store read it (BeliefClaim's ownerSaid):
// a claim cannot say so itself, since its basis is about its subject. A caller builds a belief
// through `settle` (below), which applies the tiers first. `reversalEnds` is buildBelief's option
// of that name: a later reversal ends the belief rather than disputes it. `latest`: the newest
// counted claim supersedes every earlier one that states something else, whoever said either, so
// nothing disputes it: an organization's process takes its latest state. `latestFrom`: the tiers
// below the owner's own word down to this one rank as one for `latest`, so the newest among them
// decides: a status the owner confirmed moves when a later notice states its next state, since the
// confirm was of the state then. A lower tier still never replaces them, and the owner's correction
// and veto still outrank everything.
export type BeliefRule = Readonly<{
  counts(record: BeliefClaim): boolean;
  conflict(counted: readonly Claim[], ownerSaid?: (claim: Claim) => boolean): boolean;
  reversalEnds?: true;
  latest?: true;
  latestFrom?: ClaimTier;
}>;

// The store's beliefClaims gives one only when the owner confirmed it on its agent_claim card or, for a proposal
// about the owner, its about_you card, and the owner's confirmation outranks the tests below, written for claims
// from messages. A claim from a source the owner confirmed on its about_you card (their need asked as a question)
// counts too; the store marks it `ownerConfirmed`. A claim of origin owner_command, what the owner stated through
// their own command (`pi goal add`), is their word, made by code; it counts as a confirmed claim does.
const confirmed = (record: BeliefClaim): boolean =>
  record.origin === "agent_record" || record.origin === "owner_command" || record.ownerConfirmed === true;
// A capture's claim, known by its `seg:` span, which only the meeting and moment lanes write.
// Credited to nobody it counts in no rule, as a document's does: every room line, every unconsented
// one and every moment's.
const CAPTURE_SPAN = /^seg:\d+-\d+$/;
const fromCapture = (claim: Claim): boolean => claim.evidence.some((cited) => CAPTURE_SPAN.test(cited.span));
// Never a claim from mail the system sent, which has origin agent_record and no card, so the store
// never gives one.
const base = (record: BeliefClaim): boolean =>
  !record.claim.systemOriginated &&
  !(fromCapture(record.claim) && record.claim.assertedBy === undefined) &&
  (record.subjectKind !== "owner" || record.claim.basis === "explicit_self");
// A meeting's claim that is not the owner's word, credited to nobody (a room, an unconsented call, labels
// code found unreliable, a cut turn) or to another speaker, counts as a source's statement of what was said
// in the owner's meeting. About a person or an organization it counts as a third party's in mail does.
// About the owner it counts only as a plain statement (no question, proposal, hypothesis or objection, and
// no reversal, which could close the owner's own belief), at the `source` tier its basis gives
// (claimTierOf: not the owner's word, not confirmed). Where the owner's word or confirmation is on the fact
// key, `settle` leaves it out, so the owner's belief stands alone; their vetoes and retires close its fact
// key as any. A moment's claim credited to nobody still counts in no rule.
const heard = (record: BeliefClaim): boolean =>
  record.meeting === true &&
  fromCapture(record.claim) &&
  !record.claim.systemOriginated &&
  record.claim.basis !== "explicit_self" &&
  (record.subjectKind !== "owner" || record.claim.statementKind === "stated_fact");

// Where the owner's word or confirmation states something else on the fact key, `settle` leaves it
// out as of a lower tier, so the owner's belief stands. The mark is isSystemNotice, the one
// definition, which the tier reads too. The check already leaves out a claim whose speaker is the
// owner's entity; the store's `ownerSaid` is that same test after identity resolution, which the
// check cannot see (a speaker later merged into the owner), so it stays here: such a claim counts
// as the owner's or not at all, and claimTierOf puts `ownerSaid` above `notice`, so its tier
// agrees.
const noticed = (record: BeliefClaim): boolean => isSystemNotice(record) && record.ownerSaid !== true;

const reported = (record: BeliefClaim): boolean => confirmed(record) || base(record);
// As `reported`, and about the owner only what they wrote of themselves and stated (personal-core's
// ownStatement): their speaker resolved by code, not the model's basis alone, and no question,
// proposal, objection or hypothesis. Applied at every rebuild, so it reaches every claim already
// stored. A commitment keeps its own rule. And a system notice's claim about the owner, at its own tier.
const ownFact = (record: BeliefClaim): boolean =>
  confirmed(record) ||
  heard(record) ||
  noticed(record) ||
  (base(record) && (record.subjectKind !== "owner" || ownStatement(record.claim, record.ownerSaid === true)));
// A question, a proposal or a hypothesis about the owner still counts for nothing.
const STATING: ReadonlySet<string> = new Set(["stated_fact", "decision", "reversal"]);
const standing = (record: BeliefClaim): boolean =>
  ownFact(record) ||
  (!record.claim.systemOriginated &&
    !fromCapture(record.claim) &&
    record.subjectKind === "owner" &&
    record.claim.basis === "third_party" &&
    STATING.has(record.claim.statementKind));
// An agent's close of a commitment, a reversal code built under the
// commitment's own fact key and label. The store gives one only while no reopen names it. It is
// never the owner's word (its tier is agent_closed) and counts only beside a claim it closes (`settle`).
const isClose = (record: Pick<BeliefClaim, "origin">): boolean => record.origin === "agent_close";
const closing = (record: BeliefClaim): boolean => isClose(record) && record.claim.statementKind === "reversal";
const ownWord = (record: BeliefClaim): boolean =>
  confirmed(record) || closing(record) || (base(record) && record.claim.basis === "explicit_self");
const party = (record: BeliefClaim): boolean => {
  const { assertedBy, content } = record.claim;
  return (
    confirmed(record) ||
    (base(record) &&
      assertedBy !== undefined &&
      (assertedBy === content.subject || assertedBy === content.fields.counterparty))
  );
};

// `what` is read as the claim's key phrase, so a situation in the current shape is compared by its
// `state`, and an older one by its `what`.
export function stated(claim: Claim): string {
  const type = personalType(claim.content.type);
  const entity = namesOrganizationEntity(claim.content.fields);
  const declared = (type?.fields ?? []).filter((spec) => !(entity && spec.name === "organization_name"));
  const fields = declared.map((spec) => {
    const value =
      spec.name === "what" ? keyPhraseOf(claim.content.type, claim.content.fields) : claim.content.fields[spec.name];
    return [spec.name, spec.kind === "text" && typeof value === "string" ? normal(value).text.trim() : (value ?? null)];
  });
  return JSON.stringify(fields);
}

const at = (claim: Claim): number => Date.parse(claim.validFrom);
// An agent record's claim: its label holds its writer's `agent:` compartment, which no message's
// label holds. Used only to narrow a dispute, never to grant anything.
const finding = (claim: Claim): boolean => claim.label.compartments.some((one) => one.startsWith("agent:"));

// Otherwise the later claim wins: a change the subject states, or one more than 30 days after the
// last, supersedes. `supersedes` names a later claim that wins whatever came before it besides: for
// a project's status, the owner's. Between tiers about the owner, `settle` decides first, so two
// claims that differ here are of one tier.
const newestFirst = (counted: readonly Claim[]): Claim[] =>
  [...counted].sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function differs(counted: readonly Claim[], supersedes: (claim: Claim) => boolean = () => false): boolean {
  const ordered = newestFirst(counted);
  const [latest, ...rest] = ordered;
  if (latest === undefined || latest.basis === "explicit_self" || supersedes(latest)) return false;
  const other = rest.find((claim) => stated(claim) !== stated(latest));
  if (other === undefined) return false;
  // A dispute needs two parties. Two findings with no speaker are one party; two message claims
  // whose authors did not resolve are not known to be one, so they stay two. Two claims of one
  // meeting credited to nobody, such as one statement read in two overlapping windows, are one
  // party too.
  const oneMeeting = fromCapture(latest) && fromCapture(other) && latest.primaryEvidenceId === other.primaryEvidenceId;
  const sameSpeaker =
    latest.assertedBy === undefined && other.assertedBy === undefined
      ? (finding(latest) && finding(other)) || oneMeeting
      : latest.assertedBy === other.assertedBy;
  return !sameSpeaker && at(latest) - at(other) <= 30 * DAY_MS;
}

// The fact keys of need, capability, goal, preference and constraint hold no value that can differ:
// their words are left out of the key, and a preference's polarity is in it.
const never = (): boolean => false;

const row = (counts: BeliefRule["counts"], conflict: BeliefRule["conflict"]): BeliefRule =>
  Object.freeze({ counts, conflict });

const disputes: BeliefRule["conflict"] = (counted) => differs(counted);

// A row for every belief kind, so no kind is left without a rule.
export const BELIEF_RULES: Readonly<Record<PersonalBeliefKind, BeliefRule>> = Object.freeze({
  // A commitment's later reversal (its subject's, or an agent's close) is
  // its end, not a dispute.
  commitment: Object.freeze({ ...row(ownWord, never), reversalEnds: true }),
  role: row(standing, disputes),
  affiliation: row(standing, disputes),
  relationship: row(party, disputes),
  need: row(ownFact, never),
  capability: row(ownFact, never),
  // About the owner only their own words; about a person or an organization, their own word and a
  // third party's. A situation is one per subject, so two that differ may conflict. A goal the owner
  // set with `pi goal add` is an owner_command claim on the same key as the goal stated in their mail,
  // so the two are one belief. Nothing here closes a goal: staleness is a mark the reader computes,
  // and only the owner's word closes one.
  goal: row(ownFact, never),
  preference: row(ownFact, never),
  constraint: row(ownFact, never),
  situation: row(ownFact, disputes),
  // A view and a visit, counted as the owner's other kinds are; a visit's
  // key is the place, so no value can differ. A status is keyed by its
  // organization and process, and its latest state supersedes (`latest`), as a notice's does: "in
  // review", then "approved", is one belief whose answer is "approved", never a dispute.
  // A view is keyed by its topic, and the owner's latest word on it is the answer.
  view: Object.freeze({ ...row(ownFact, never), latest: true }),
  visited: row(ownFact, never),
  status: Object.freeze({ ...row(ownFact, never), latest: true, latestFrom: "system_notice" as const }),
  // Its fact key holds what it is about and to whom, so no value can differ: only a reversal closes
  // it, by the shared rule. It never ages. No code reads a consent to decide anything; when the send
  // gate does, it may only hold.
  consent: row(ownWord, never),
  contact_rule: row(ownWord, disputes),
  // A status the owner states supersedes; two people's different statuses within 30 days dispute. A
  // decision's key holds no value that can differ.
  project_status: row(reported, differs),
  decision: row(reported, never),
  // No conflict rule.
  capture_project: row(reported, never),
  // No code infers an interest from the owner's observed activity and no type carries one,
  // so its rule counts nothing (a row for every kind, stated, never a missing one).
  interest: row(never, never),
});

const isCorrection = (record: Pick<BeliefClaim, "origin" | "claim">): boolean =>
  record.origin === "owner_command" && record.claim.pipelineVersion === CORRECTION_PIPELINE;

// What one fact key's counted claims build, for one audience: the claims buildBelief takes and its
// `conflict` option. It neither decides the answer nor disputes it, so it is left out and the
// higher-tier claim is the answer. Claims of one tier keep the kind's rule. A kind whose key holds
// no value that can differ (`never`) has nothing to outrank and keeps every claim, so each still
// confirms its belief.
export function settle(
  rule: BeliefRule,
  given: readonly BeliefClaim[],
): { claims: Claim[]; conflict: (counted: readonly Claim[]) => boolean } {
  // A close counts only where a claim it closes, one that is no close and
  // no later than it, counts too. A close of nothing builds nothing.
  const closed = (one: BeliefClaim): boolean =>
    given.some((other) => !isClose(other) && Date.parse(other.claim.validFrom) <= Date.parse(one.claim.validFrom));
  const kept = given.filter((one) => !isClose(one) || closed(one));
  // What agrees with it still confirms it, and nothing is left to dispute.
  const corrections = kept.filter(isCorrection).map((one) => one.claim);
  const [correction] = newestFirst(corrections);
  if (correction !== undefined) {
    // A claim agrees when it states each field the owner's correction holds; it may hold more.
    const same = (a: unknown, b: unknown): boolean =>
      typeof a === "string" && typeof b === "string" ? normal(a).text.trim() === normal(b).text.trim() : a === b;
    const agrees = (claim: Claim): boolean =>
      Object.entries(correction.content.fields).every(([name, value]) => same(claim.content.fields[name], value));
    const claims = kept
      .map((one) => one.claim)
      .filter((claim) => claim.id === correction.id || (!corrections.includes(claim) && agrees(claim)));
    return { claims, conflict: () => false };
  }
  const owners = new Set(kept.filter((one) => one.ownerSaid === true).map((one) => one.claim.id as string));
  // A later system notice supersedes an earlier one, as a status update replaces the
  // last ("in process", then "mailed"): a fact key whose latest counted claim is a notice is not
  // disputed by an earlier message. One that differs from the owner's own word never gets here: it is
  // outranked below. Claims of the latest notice's own message that state different
  // things (two statuses in one notice) dispute it, so neither silently replaces the other.
  const notices = new Set(kept.filter((one) => noticed(one)).map((one) => one.claim.id as string));
  const ownLines = new Set(kept.filter((one) => one.ownLine === true).map((one) => one.claim.id as string));
  const conflict = (counted: readonly Claim[]): boolean => {
    const [latest] = newestFirst(counted);
    if (latest !== undefined && ownLines.has(latest.id) && rule.conflict !== never)
      return counted.some((claim) => stated(claim) !== stated(latest));
    if (latest === undefined || !notices.has(latest.id)) return rule.conflict(counted, (claim) => owners.has(claim.id));
    return counted.some(
      (claim) => claim.primaryEvidenceId === latest.primaryEvidenceId && stated(claim) !== stated(latest),
    );
  };
  // About the owner, where their word or confirmation is on the fact key, what was only heard
  // in a meeting is left out whatever its kind or values, so it can neither close, dispute nor
  // answer the owner's belief. A notice's tier is not the owner's word, nor the granted-release tier's.
  const his = kept.some(
    (one) =>
      one.subjectKind === "owner" &&
      !["system_notice", "source", "researched", "agent_confirmed", "agent_inferred"].includes(claimTier(one, true)),
  );
  const claims = kept.filter((one) => !(his && one.subjectKind === "owner" && heard(one))).map((one) => one.claim);
  // A status's newest counted claim, and every claim that states the same, is its answer: after
  // the heard claims are left out above, and within the top tier about the owner (the tiers down
  // to `latestFrom` counted as one), so a newer claim of a lower tier, or one only heard, never
  // replaces the owner's state.
  if (rule.latest === true) {
    const tiers = ownerSideTiers(kept);
    const band = rule.latestFrom;
    // The owner's own stated word keeps its rank: only a confirm joins the band.
    const level = (tier: ClaimTier): ClaimTier =>
      band !== undefined && tier !== "owner" && !ranksAbove(band, tier) ? band : tier;
    const ranked =
      tiers === undefined
        ? claims
        : claims.filter((claim) => !claims.some((other) => ranksAbove(level(tiers(other)), level(tiers(claim)))));
    // A notice that repeats a state another claim already moved past is a reminder, not a step
    // back: "in review", then "approved", then a reminder saying "in review" stays approved.
    const notices = new Set(kept.filter(noticed).map((one) => one.claim.id as string));
    const repeat = (claim: Claim): boolean =>
      notices.has(claim.id) &&
      ranked.some(
        (moved) =>
          stated(moved) !== stated(claim) &&
          Date.parse(moved.validFrom) < Date.parse(claim.validFrom) &&
          ranked.some(
            (was) => stated(was) === stated(claim) && Date.parse(was.validFrom) < Date.parse(moved.validFrom),
          ),
      );
    const top = ranked.filter((claim) => !repeat(claim));
    const [newest] = newestFirst(top);
    return {
      claims: claims.filter((claim) => newest !== undefined && stated(claim) === stated(newest)),
      conflict: () => false,
    };
  }
  const tierOf = rule.conflict === never ? undefined : ownerSideTiers(kept);
  if (tierOf === undefined) return { claims, conflict };
  const outranked = (claim: Claim): boolean =>
    claims.some((other) => ranksAbove(tierOf(other), tierOf(claim)) && stated(other) !== stated(claim));
  return { claims: claims.filter((claim) => !outranked(claim)), conflict };
}
