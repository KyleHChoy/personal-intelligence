import {
  DecideIdentityOutput,
  type DecisionPointDefinition,
  type PointThresholds,
} from "@intelligence/contracts/personal";

// The identity ranking: the prompt, the point's data, the pair's subject and the order within a
// tier. The pair's slot is identity-pair.ts's; the calls and the order are the sweep's
// (identity-sweep.ts, `proposeIdentity`'s `decideModel`); the saved pair calls are
// decision-calls.ts's (admin.calibration.decisionCalls); a same_person card's answer writes the
// verdict (card-kinds-identity.ts). `pi identity sweep` passes a `decideModel` only when
// IDENTITY_DECIDE_ON.

// The question word for word, as canonical JSON. Structurally the shared Prompt, so the store
// takes no dependency on the model client; a test beside this file checks its text hash
// against the contracts' pin.
const QUESTIONS = {
  same_person: {
    criteria: {
      false:
        "They fit two different people, such as two people who share a common name, a person and their assistant, or a person and a shared or role address.",
      true: "The names, addresses and domains fit one person who uses two addresses, such as a personal and a work address, or an old and a new one.",
    },
    instructions: "Are these two email identities the same human being?",
    type: "noul",
  },
};

export const DECIDE_IDENTITY = Object.freeze({
  id: "jev_identity",
  version: "1",
  instructions: JSON.stringify(QUESTIONS),
  slots: Object.freeze(["pair"]) as readonly string[],
  outputSchemaId: "JevIdentityOutput",
  outputSchema: DecideIdentityOutput,
  tools: "none" as const,
  textHash: "617e4ff08ebcefee03b7c4e0a0903fe85f0ef587890a7d88b496c8a624efd936",
});

// One side of a pair, as the `pair` slot holds it: the person's email aliases (never a contact's
// field), the address, its domain, counts from the interaction log and UTC months.
export type IdentitySide = {
  names: string[];
  address: string;
  domain: string;
  sent: number;
  received: number;
  meetings: number;
  // UTC months, `YYYY-MM`, of the first and last interaction; null with none.
  firstSeen: string | null;
  lastSeen: string | null;
};

// identity_rank@1, beside the sweep: the contracts' DECISION_POINTS holds the copy. It has no
// threshold: the probability only orders candidates within a tier.
export const IDENTITY_POINTS = Object.freeze([
  Object.freeze({
    id: "identity_rank",
    version: 1,
    rungs: Object.freeze([0, 1]) as DecisionPointDefinition["rungs"],
    outputs: Object.freeze({ rank: "rank_candidate" }) as DecisionPointDefinition["outputs"],
    prompts: Object.freeze([Object.freeze({ id: "jev_identity", version: "1" })]) as DecisionPointDefinition["prompts"],
    thresholds: Object.freeze({}) as PointThresholds,
  }),
]);

// Wrapping the sweep's client with `exposing` turns this on.
export const IDENTITY_DECIDE_ON = false;

// A candidate pair's call subject: its two keyed address fingerprints, sorted.
export const pairSubject = (a: string, b: string): string => (a < b ? `pair:${a}:${b}` : `pair:${b}:${a}`);

// Nothing is dropped, and no candidate crosses a tier.
export function rankWithinTiers<C>(
  candidates: readonly C[],
  by: {
    tierOf: (candidate: C) => number;
    subjectOf: (candidate: C) => string;
    probability: (subject: string) => number | undefined;
  },
): C[] {
  const keyed = candidates.map((candidate, index) => ({
    candidate,
    index,
    tier: by.tierOf(candidate),
    p: by.probability(by.subjectOf(candidate)),
  }));
  keyed.sort((x, y) => {
    if (x.tier !== y.tier) return x.tier - y.tier;
    if ((x.p === undefined) !== (y.p === undefined)) return x.p === undefined ? 1 : -1;
    if (x.p !== undefined && y.p !== undefined && x.p !== y.p) return y.p - x.p;
    return x.index - y.index;
  });
  return keyed.map(({ candidate }) => candidate);
}
