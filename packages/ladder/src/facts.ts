import type { IntentId, IntentMode, OpportunityKind, WorkRef } from "@intelligence/contracts/personal";

export type { WakeFacts } from "@intelligence/contracts/personal";

// What the rung 0 functions are handed. Ids, kinds, counts, booleans and opaque fingerprints
// only: no content, so a decision's input hash covers none. The caller reads every count, day
// and boolean; nothing here reads a clock.

// Set by code: source for a message or an event, derived for an entity, owner for a goal, agent
// for a hypothesis or an opportunity, system for a message the system sent or a reply to one.
type SourceClass = "source" | "derived" | "owner" | "agent" | "system";

export type BasisFact = {
  readonly refKind: WorkRef["kind"];
  readonly sourceClass: SourceClass;
  readonly ownerBacked: boolean;
  readonly flagged: boolean;
  readonly tainted: boolean;
  // A message's keyed thread fingerprint, compared for equality and nothing else.
  readonly threadFp: string | null;
  // The ref is what the opportunity is about.
  readonly isAbout: boolean;
};

type IntentFact = {
  readonly id: IntentId;
  readonly mode: IntentMode;
  // Its opportunities in go or claimed.
  readonly open: number;
  readonly maxOpen: number;
  readonly activeClients: number;
};

export type OpportunityFacts = {
  readonly kind: OpportunityKind;
  readonly vetoed: boolean;
  // An undecided card exists on its case.
  readonly cardPending: boolean;
  // A card was ever raised on its case.
  readonly caseEverCarded: boolean;
  readonly proposedByClass: "run" | "client" | "system";
  // The client that proposed it staked one of its bets on it, approving it itself.
  readonly bet?: boolean;
  readonly aboutOwner: boolean;
  readonly restsOnOwnerHypothesis: boolean;
  readonly caseClosed: {
    readonly by: "owner" | "expiry";
    readonly daysSince: number;
    readonly newSourceRef: boolean;
  } | null;
  // The unrevoked intents that list the kind: earliest confirmed first, then lowest id.
  readonly intents: readonly IntentFact[];
  readonly basis: readonly BasisFact[];
};
