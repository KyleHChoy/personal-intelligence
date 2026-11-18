import type { ClaimRelationKind, RecallFilter, SourceCheckVerdict } from "./relations.ts";
import type { OutcomePath } from "./work.ts";
// What the night's judged steps and the store that serves them pass across their port: the extract
// package names them and the store fills them, and neither imports the other.

// `owed`: does it say the owner must do something by a date. `promise`: does it say someone promised to
// do something. `line` is the words the filter read, where any are kept: the bar keeps none.
export type RecallCase = {
  filter: RecallFilter;
  targetKey: string;
  evidenceId: string;
  question: "owed" | "promise";
  line: string | null;
  passages: { text: string | null; at: string }[];
  // How many lines the filter dropped when the sample was drawn: what a rate is a rate of.
  population: number;
  subject: string;
  compartments: string[];
};

export type RecallRow = {
  filter: RecallFilter;
  targetKey: string;
  evidenceId: string;
  population: number;
  compartments: string[];
  verdict: "missed" | "rightly_dropped" | null;
  code: "no_passage" | "uncited" | "rejected" | null;
  cited: number | null;
};

// One claim as the step shows it: its claim key, its row id, its type, its key words (from typed
// fields code read), its passage (null when the store keeps none), its item, when it was said, and
// its label.
export type RelationSide = {
  key: string;
  id: string;
  type: string;
  phrase: string;
  passage: string | null;
  evidenceId: string;
  at: string;
  compartments: string[];
};

// A claim to judge, and its candidates. `mayPrevail` is code's answer for the pair: both
// claims state different values of one fact key, a `prevails` may settle that kind, the two sides
// are of one tier and every evidence comparison is equal. `unjudged`: an earlier run's budget left it.
export type RelationJob = {
  claim: RelationSide;
  candidates: { other: RelationSide; mayPrevail: boolean }[];
  unjudged: boolean;
};

// What is checked: a belief, shown by its type and key words; or a model relation, shown by its
// kind and its two statements.
type CheckStatement =
  | { kind: "fact"; type: string; phrase: string }
  | {
      kind: "relation";
      relation: ClaimRelationKind;
      from: { type: string; phrase: string };
      to: { type: string; phrase: string };
    };

// One passage a check reads: the claim it is cited by (its key), its item, its text (null when the
// store keeps none the claim's span names) and when it was said.
export type CheckPassage = { claimKey: string; evidenceId: string; text: string | null; at: string };

// One case of the night's sample, as the store builds it. `kind` is the belief kind or the relation
// kind (the stratum); `targetKey` the store's keyed fingerprint of what is checked; `relationId` and
// `relationJudge` a model relation's row and who wrote it; `onCited` whether the passages read are
// exactly those the target's claims cite (only such checks are scored); `subject` the keyed replay's
// subject; `compartments` the union of the labels of everything it read. `hot`, on a case of the
// night's hot slice alone, why code chose it: a belief agents were served often (`served`) or one
// whose subject gained evidence since its last check (`new_evidence`). Such a check is never part of
// a kind's precision.
export type SourceHot = "served" | "new_evidence";
export type SourceCase = {
  target: "belief" | "relation";
  kind: string;
  targetKey: string;
  relationId: string | null;
  relationJudge: string | null;
  statement: CheckStatement;
  passages: CheckPassage[];
  onCited: boolean;
  subject: string;
  compartments: string[];
  hot?: SourceHot;
};

// One check row: the case's ids, the verdict or the code it has none for, and the passage cited.
export type SourceCheckRow = Omit<SourceCase, "statement" | "passages" | "subject"> & {
  claimKeys: string[];
  evidenceIds: string[];
  verdict: SourceCheckVerdict | null;
  code: string | null;
  cited: number | null;
};

// What a piece of work expects, as the step shows it: its type, its success and failure words
// (opened by the store; null when the type has none, as `answered` has none), and whether it
// depends on a named person (an entity subject that is a person, or whoever the work's sends go to).
export type OutcomeExpectation = {
  id: string;
  opportunityId: string;
  type: string;
  success: string | null;
  failure: string | null;
  person: boolean;
  compartments: string[];
};

// One item that may show the outcome: its passage (the item's text on a watched channel, else the
// claim's passage), when it was said, its label, and what code read of it from clear columns and
// opened claims: whether it is flagged; from the expected person; first-hand about them (a claim
// its subject asserted); a decline (a claim extraction typed as a reversal or an objection, by its
// sender); an inbound reply on a watched thread; and whether it came on the work's own channel
// after the work's move there.
export type OutcomeItem = {
  evidenceId: string;
  claimKey: string | null;
  passage: string | null;
  at: string;
  compartments: string[];
  flagged: boolean;
  fromPerson: boolean;
  firstHand: boolean;
  decline: boolean;
  reply: boolean;
  afterMove: boolean;
  source: EvidenceItem;
};

export type OutcomeCandidate = {
  expectation: OutcomeExpectation;
  item: OutcomeItem;
  path: OutcomePath;
  unjudged: boolean;
};

// One item a side of a dispute rests on, as the store read it from clear columns: its sender's
// domain and its thread (keyed fingerprints, or null), whether it is an agent's record, whether
// the claim's speaker is its subject, whether the mail authenticates (`messages.auth = 'pass'`;
// `unknown` counts as not), whether its sender's domain is a domain of the organization the claim
// names, when it was said, and whether the triage screen flagged it (a withheld item, a flagged
// agent record), which never counts on either side.
export type EvidenceItem = {
  item: string;
  domain: string | null;
  thread: string | null;
  agent: boolean;
  firstHand: boolean;
  authenticated: boolean;
  domainMatches: boolean;
  at: string;
  flagged: boolean;
};
