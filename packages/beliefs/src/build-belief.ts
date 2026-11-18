import type {
  BasisType,
  Belief,
  BeliefKind,
  BeliefStatus,
  Claim,
  HumanDecision,
  OntologyView,
  Timestamp,
} from "@intelligence/contracts";
import { combine, DAY_MS } from "@intelligence/personal-core";
import { byBytes, declaredFields, factKey, supportHash } from "./base-fact-key.ts";

// The one implementation of a belief from one audience's claims for one fact, with the lifecycle
// limits it ages by. Deterministic: the same claims always give the same belief.

// How much one claim weighs, by how we know it.
const BASIS_WEIGHT: Record<BasisType, number> = {
  explicit_self: 0.9,
  third_party: 0.6,
  system_observed: 0.5,
  web_derived: 0.4,
};

// When a belief of one kind goes stale with nothing to reconfirm it, and what it becomes
// after that. Days are counted from `lastConfirmedAt`.
type LifecycleRule = { staleAfterDays: number; endAfterDays: number; end: "dormant" | "expired" };
// A kind with no rule stays active until a claim closes it or its `validTo` passes. Every
// caller that builds a belief for one store must use the same limits, or a stored row and
// a belief computed on read would disagree.
export type LifecyclePolicy = Partial<Record<BeliefKind, LifecycleRule>>;

const AGES: LifecycleRule = { staleAfterDays: 180, endAfterDays: 365, end: "dormant" };

// The limits a belief ages by when the caller gives none. A need goes stale 60 days after it was
// last confirmed and expires at 90. The others are provisional: half a year to stale and a year to
// dormant. A consent and a contact rule have no limit: what a person agreed to, or asked not to be
// contacted about, does not lapse by itself. The owner-side kinds age the same, except a situation,
// which is temporal: stale at 60 days and expired at 120. owner-time.ts overrides the owner's own
// situations.
export const DEFAULT_LIFECYCLE: LifecyclePolicy = {
  need: { staleAfterDays: 60, endAfterDays: 90, end: "expired" },
  capability: AGES,
  role: AGES,
  affiliation: AGES,
  relationship: AGES,
  commitment: AGES,
  decision: AGES,
  project_status: AGES,
  goal: AGES,
  preference: AGES,
  constraint: AGES,
  situation: { staleAfterDays: 60, endAfterDays: 120, end: "expired" },
};

// What a caller may add to the base rules. `conflict` is a further test of conflicting
// support over the claims that count (no vetoed, system-originated or not-yet-true claim):
// when it answers true the set is a conflict exactly as a statement and its reversal are.
// It must be pure. `reversalEnds`, off by default, makes a later reversal the fact's end
// rather than a dispute, for commitments. Without either option the function is the base
// one, unchanged.
// `confirmedAt`: when an owner's word confirmed the fact with no claim, which ages it as a claim would.
export type BuildOptions = {
  conflict?: (counted: readonly Claim[]) => boolean;
  reversalEnds?: boolean;
  confirmedAt?: Timestamp;
};

const time = (at: Timestamp): number => Date.parse(at);

const corrects = (claim: Claim): boolean => claim.origin === "member_correction";

// Within a rank the later validFrom wins, and the id breaks a tie, so the order of the
// input never matters.
const later = (a: Claim, b: Claim): boolean =>
  time(a.validFrom) !== time(b.validFrom) ? time(a.validFrom) > time(b.validFrom) : byBytes(a.id, b.id) < 0;

// The decisions made by the date asked for, oldest first. Which decisions a set may read
// at all is the caller's to settle before it calls.
function madeBy(decisions: HumanDecision[], asOf: Timestamp): HumanDecision[] {
  return decisions
    .filter((decision) => time(decision.decidedAt) <= time(asOf))
    .sort((a, b) => time(a.decidedAt) - time(b.decidedAt) || byBytes(a.id, b.id));
}

// Where a belief stands by time alone, and the next moment that would change it.
function aged(
  kind: BeliefKind,
  confirmedAt: number,
  asOf: number,
  lifecycle: LifecyclePolicy,
): { status: BeliefStatus; next?: number } {
  const rule = lifecycle[kind];
  if (rule === undefined) return { status: "active" };
  const stale = confirmedAt + rule.staleAfterDays * DAY_MS;
  const end = confirmedAt + rule.endAfterDays * DAY_MS;
  if (asOf >= end) return { status: rule.end };
  return asOf >= stale ? { status: "stale", next: end } : { status: "active", next: stale };
}

// The one implementation of a belief. Pure: the answer comes from the claims of one audience
// for one fact, the decisions about them, the ontology, the lifecycle limits and the date
// asked for, and from no clock. Nothing outside that set can change it.
//
// `storedFactKey` is the fact key the claims are stored under. A caller that read the
// claims from a store passes it, and then none is computed here. Without it, the key is that
// of the claims' content.
export function buildBelief(
  claims: Claim[],
  decisions: HumanDecision[],
  asOf: Timestamp,
  ontology: OntologyView,
  storedFactKey?: string,
  lifecycle: LifecyclePolicy = DEFAULT_LIFECYCLE,
  options?: BuildOptions,
): Belief | null {
  const [first] = claims;
  if (first === undefined) return null;
  const key = storedFactKey ?? factKey(first.content);
  if (storedFactKey === undefined && claims.some((claim) => factKey(claim.content) !== key))
    throw new Error("mixed_fact_keys");
  const type = ontology.get(first.content.type);
  if (type?.beliefKind === undefined) return null;

  const support = [...new Set(claims.map((claim) => claim.id))].sort(byBytes);
  const hash = supportHash(support);
  // The combined label of the whole set, whether or not a claim counted.
  const label = combine(claims.map((claim) => claim.label));
  const decided = madeBy(decisions, asOf);
  const about = (targetKind: HumanDecision["targetKind"], ids: readonly string[]): HumanDecision[] =>
    decided.filter((decision) => decision.targetKind === targetKind && ids.includes(decision.targetId));

  // A veto outranks everything. A vetoed claim neither decides nor confirms.
  const vetoed = new Set(
    about("claim", support)
      .filter((decision) => decision.kind === "veto")
      .map((decision) => decision.targetId),
  );
  // A claim from evidence the system itself produced never makes a belief and never
  // confirms one. A claim not yet true at the date asked for does neither.
  const counted = claims.filter(
    (claim) => !claim.systemOriginated && time(claim.validFrom) <= time(asOf) && !vetoed.has(claim.id),
  );

  // Conflicting support is a statement of the fact and a reversal of it. It can only
  // be seen in a set that holds both. A person settles it: by a correction in the
  // set, or by a decision on the dispute. A caller's conflict option adds to this test and
  // is settled the same way.
  const side = (claim: Claim): "reversal" | "statement" | undefined =>
    claim.statementKind === "reversal"
      ? "reversal"
      : claim.statementKind === "stated_fact" || claim.statementKind === "decision"
        ? "statement"
        : undefined;
  const sided = counted.filter((claim) => side(claim) !== undefined);
  const opposed = new Set(sided.map(side)).size === 2;
  // With the caller's `reversalEnds`, a reversal is the fact's end, not a dispute: the
  // latest claim that states or reverses it decides, a reversal closing it and a later
  // statement reopening it. A question or a proposal decides nothing. A statement and a
  // reversal true at that same moment are still a dispute: no order says which ended which.
  const ending = options?.reversalEnds === true && sided.length > 0;
  const [head, ...rest] = ending ? sided : counted;
  if (head === undefined) return null;
  // What the claims alone say: a correction outranks inferred claims, and otherwise
  // supersession follows validFrom.
  const stands = rest.reduce(
    (best, claim) =>
      corrects(claim) !== corrects(best) ? (corrects(claim) ? claim : best) : later(claim, best) ? claim : best,
    head,
  );
  const tied = sided.some((claim) => time(claim.validFrom) === time(stands.validFrom) && side(claim) !== side(stands));
  const conflict = (opposed && !(ending && !tied)) || (options?.conflict?.(counted) ?? false);

  // A person's ruling for one claim of a conflict makes that claim the answer, and the
  // latest ruling stands. It is read only in a set that holds both sides, or the caller's
  // conflict: in a set with one side alone there is nothing to rule on, and the row stays
  // as it was. Under `reversalEnds` a ruling on a statement and its reversal binds until a
  // later claim states or reverses it (the later act wins). Without it, `opposed` implies
  // `conflict`, so this is the base rule.
  const rulings =
    opposed || conflict
      ? [
          ...about(
            "claim",
            counted.map((claim) => claim.id),
          ),
          ...about("belief", [key, hash]),
        ].filter((decision) => decision.kind === "ruling" || decision.kind === "dispute")
      : [];
  const ruling = rulings.filter((decision) => decision.targetKind === "claim").at(-1);
  const ruled = ruling === undefined ? undefined : counted.find((claim) => claim.id === ruling.targetId);
  // The order among what people did: a veto outranks everything, and was applied above.
  // Between a ruling and a correction the later act wins. A correction carries no time of
  // its own in the contract, so it is as late as its `validFrom`. Either outranks every
  // inferred claim.
  const preferred =
    ruling !== undefined &&
    ruled !== undefined &&
    !((corrects(stands) || ending) && time(stands.validFrom) > time(ruling.decidedAt))
      ? ruled
      : undefined;
  const winner = preferred ?? stands;
  const disputed = conflict && !counted.some(corrects) && rulings.length === 0;

  const confirmedAt = Math.max(
    ...counted.map((claim) => time(claim.validFrom)),
    ...(options?.confirmedAt === undefined ? [] : [time(options.confirmedAt)]),
  );
  const endsAt = winner.validTo === undefined ? undefined : time(winner.validTo);
  const byAge = aged(type.beliefKind, confirmedAt, time(asOf), lifecycle);
  // A veto on the belief itself closes it, whatever its claims say.
  const closed =
    about("belief", [key, hash]).some((decision) => decision.kind === "veto") || winner.statementKind === "reversal";
  const ended = endsAt !== undefined && endsAt <= time(asOf);
  const status: BeliefStatus = closed ? "closed" : ended ? "expired" : byAge.status;
  // The next moment anything about the belief could change with no new claim: the
  // lifecycle looks again then. That is the next step of its ageing, unless it is closed
  // or has ended, and the dates its claims carry that are still ahead: when a claim of the
  // set becomes true, and when one ends.
  const ahead = (at: Timestamp | undefined): number[] => (at !== undefined && time(at) > time(asOf) ? [time(at)] : []);
  const moments = [
    ...(closed || ended || byAge.next === undefined ? [] : [byAge.next]),
    ...claims.flatMap((claim) =>
      claim.systemOriginated || vetoed.has(claim.id) ? [] : [...ahead(claim.validFrom), ...ahead(claim.validTo)],
    ),
  ];

  return {
    kind: type.beliefKind,
    factKey: key,
    supportHash: hash,
    subject: winner.content.subject,
    type: winner.content.type,
    // The fields the ontology declares as typed. A field of kind "text" is never copied.
    values: declaredFields(winner.content, ontology),
    label,
    status,
    disputed,
    confidence:
      preferred !== undefined || corrects(winner) ? 1 : Math.max(...counted.map((claim) => BASIS_WEIGHT[claim.basis])),
    lastConfirmedAt: new Date(confirmedAt).toISOString(),
    ...(moments.length > 0 && { reviewAfter: new Date(Math.min(...moments)).toISOString() }),
    // A belief whose deciding claim came from backfill or reprocessing is not a live change.
    changeKind: winner.changeKind,
    support,
  };
}
