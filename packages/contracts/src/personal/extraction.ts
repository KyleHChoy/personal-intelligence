import { z } from "zod";
import { Belief } from "../belief.ts";
import { Claim } from "../claim.ts";
import { LocalEntityId, Timestamp } from "../ids.ts";
import { FieldKind } from "../ontology.ts";
import { UnmappedReason } from "../pipeline.ts";
import { AgentWriteKind } from "./agent-records.ts";
import { Compartments, count } from "./extraction-fields.ts";
import { PersonalEvidenceId, RulingId, ULID_PATTERN } from "./ids.ts";
import { BeliefTier, FACT_GROUP_MAX } from "./knowledge-model.ts";
import { PERSON_PROPOSAL_TYPES } from "./people-ties.ts";
import { Hex64 } from "./primitives.ts";
import { DisclosureClass, SubjectKind } from "./subjects.ts";
import { DocumentKind, MessageCategory } from "./tools-args.ts";
import { Provenance } from "./tools-views.ts";

// Extraction: the shapes that cross between the pipeline, its store and its model port.
// Code sets every one of them; nothing here lets a model or a client name a label, a reader or
// a destination.

// An evidence id as the personal database stores it: 64 hexadecimal characters (in ids.ts).
export { PersonalEvidenceId };

// `agent` is an agent record's, set by code from its source kind, never by triage. `document` is a
// Drive document's lane, and `page` a stored web page's, also set by code. `meeting` is Lens's
// meeting lane, and `moment` its moment lane.
export const TriageLane = z.enum([
  "correspondence",
  "transaction",
  "skip",
  "agent",
  "document",
  "page",
  "meeting",
  "moment",
]);
export type TriageLane = z.infer<typeof TriageLane>;
// A message's own lanes, and those a run asks one call of a prompt in by version: a message's, and
// an agent record's.
const MESSAGE_LANES = ["correspondence", "transaction"] as const satisfies readonly TriageLane[];
export type MessageLane = (typeof MESSAGE_LANES)[number];
export const ASKED_LANES = [...MESSAGE_LANES, "agent"] as const satisfies readonly TriageLane[];
export type AskedLane = (typeof ASKED_LANES)[number];
// A capture item's lanes, which a retry may name by kind, and the lanes the owner switches on.
export const CAPTURE_LANES = ["meeting", "moment"] as const satisfies readonly TriageLane[];
export type CaptureLane = (typeof CAPTURE_LANES)[number];
export type SwitchedLane = "document" | CaptureLane;
// The lanes PI_EXTRACT_FACT_KINDS may name.
export const FACT_KIND_LANES = [
  "correspondence",
  "agent",
  "meeting",
  "moment",
  "transaction",
] as const satisfies readonly TriageLane[];
export type FactKindLane = (typeof FACT_KIND_LANES)[number];

// "held" and "flagged" are other things' words: a message kept from every client, and an agent
// record in which the pipeline found instructions.
export const PipelineStatus = z.enum(["waiting", "done", "skipped", "withheld", "failed"]);
export type PipelineStatus = z.infer<typeof PipelineStatus>;

export const PipelineCode = z.enum([
  "bulk",
  "no_text",
  "too_long",
  "sensitive",
  "quarantine",
  "parse_failed",
  "interpret_failed",
  "cut_off",
  "filtered",
  "model_refused_item",
  "check_failed",
  "model_unavailable",
  "commit_failed",
  "not_a_finding",
  // The decide model's screen of an item done before the decide model was on gave it another lane, so it waits for
  // the extract model under the same generation.
  "lane_changed",
  // Placed after the earlier codes so tests that pin those by position hold.
  "too_short",
  "connected_source",
  "not_extracted",
  // A document of a reference root, one the owner neither owns nor last edited, and one
  // last modified before the run's window.
  "reference",
  "not_owners",
  "old",
  "bad_proposal",
  "client_scoped",
  // A page moment, which no model is sent.
  "reading",
  "agent_app",
  "not_chat",
  "no_turns",
  // A close record whose body does not parse, and one whose commitment is no longer
  // stored (erased or re-keyed): it closes nothing.
  "bad_close",
  "orphaned",
  // A fill record whose body does not parse.
  "bad_fill",
]);
export type PipelineCode = z.infer<typeof PipelineCode>;

// The classifier's guards, a fact filed under the wrong kind, each code saying where it belongs (the
// kind registry's `notBelongs`): a dated task, an instruction to the owner's agents, a fact about
// another person. Never the agents' contract: an agent states, and only the classifier decides a
// statement's kind.
export const KIND_REFUSALS = Object.freeze(["dated_task", "agent_instruction", "not_about_owner"] as const);
export const PersonalUnmappedReason = z.enum([
  ...UnmappedReason.options,
  "bad_speaker",
  "multi_fact",
  "negated_object",
  "not_standalone",
  "not_what_was_said",
  "not_first_hand",
  "not_a_promise",
  "wrong_direction",
  "negation_cut",
  ...KIND_REFUSALS,
]);
export type PersonalUnmappedReason = z.infer<typeof PersonalUnmappedReason>;

// Where a claim's words came from. The shared ClaimOrigin has no value for an agent's text.
// `agent_close`, the reversal code builds from an agent's close of a commitment,
// under the commitment's own fact key and label; never an agent_record finding's, never the owner's word.
// `owner_command`, what the owner states through pi and pia, at tier owner.
export const PersonalClaimOrigin = z.enum(["source", "agent_record", "agent_close", "owner_command", "agent_research"]);
export type PersonalClaimOrigin = z.infer<typeof PersonalClaimOrigin>;

export const RunCode = z.enum([
  "ok",
  "budget",
  "model_refused",
  "cost_missing",
  "model_unavailable",
  "store_unavailable",
]);
export type RunCode = z.infer<typeof RunCode>;

export const RunCounts = z.strictObject({
  done: count,
  skipped: count,
  withheld: count,
  failed: count,
  waiting: count,
  claims: count,
  unmapped: count,
  unresolved: count,
  liveCalls: count,
  beliefs: count,
  beliefsChanged: count,
  beliefsMixed: count,
  beliefsFailed: count,
  beliefsRemoved: count,
  rebuildMs: count,
});
export type RunCounts = z.infer<typeof RunCounts>;

// The status a vendor refused with, as a fixed code such as http_402: never anything of a body.
export const HttpStatus = z.string().regex(/^http_\d{3}$/);
export type HttpStatus = z.infer<typeof HttpStatus>;

// `status` is the refusal's that ended a `model_refused` run, for its log line; the run's row keeps
// the code and counts only. For each point version a run read, the value it applied to each
// threshold and where the value came from: `default`, a grant's `thr_` id, or `carried:<thr_ id>`.
// Ids and numbers only.
export const AppliedThreshold = z.strictObject({
  point: z.string().regex(/^[a-z][a-z0-9_]{0,31}@[1-9][0-9]{0,5}$/),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  value: z.number().min(0).max(1),
  source: z.string().regex(new RegExp(`^(default|(carried:)?thr_${ULID_PATTERN})$`)),
});
export type AppliedThreshold = z.infer<typeof AppliedThreshold>;

export const RunSummary = z.strictObject({
  code: RunCode,
  status: HttpStatus.optional(),
  counts: RunCounts,
  thresholds: z.array(AppliedThreshold).optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

// The raw text of a cut-off and of a filtered answer: the client's own words, never model
// output. Neither is JSON, so the shared replay saves each as it is.
// The decide model's answer to the `jev_screen` prompt: the probability of yes for each of its three
// questions. A probability is a number in [0, 1]; any other answer is a rejection.
const probability = z.number().min(0).max(1);
export const DecideScreenOutput = z.strictObject({
  human_written: probability,
  special_category: probability,
  quarantine: probability,
});
export type DecideScreenOutput = z.infer<typeof DecideScreenOutput>;

// The decide model's three further prompts, one question each: `jev_recovery`, `jev_record` and `jev_identity`.
export const DecideRecoveryOutput = z.strictObject({ account_recovery: probability });
export type DecideRecoveryOutput = z.infer<typeof DecideRecoveryOutput>;
export const DecideRecordOutput = z.strictObject({ quarantine: probability });
export type DecideRecordOutput = z.infer<typeof DecideRecordOutput>;
export const DecideIdentityOutput = z.strictObject({ same_person: probability });
export type DecideIdentityOutput = z.infer<typeof DecideIdentityOutput>;
// The claim intake's two questions, each the probability of yes: `jev_standalone`
// over the rendered line alone, and `jev_said` over the line and the quote.
export const DecideStandaloneOutput = z.strictObject({ standalone: probability });
export type DecideStandaloneOutput = z.infer<typeof DecideStandaloneOutput>;
export const DecideSaidOutput = z.strictObject({ said: probability });
export type DecideSaidOutput = z.infer<typeof DecideSaidOutput>;

export const REJECTED_LENGTH = "rejected:length";
export const REJECTED_CONTENT_FILTER = "rejected:content_filter";

// What triage reads of a message: clear columns and two sealed facts. Nothing of a body.
// `knownCorrespondent`, read from clear columns alone, true when the owner has
// written to the sender's person or holds them as a saved contact, under labels within the
// message's own; left out when false.
export const MessageTriageRow = z.strictObject({
  direction: z.enum(["inbound", "outbound"]),
  bulk: z.boolean(),
  category: MessageCategory,
  unreadable: z.boolean(),
  chars: count,
  knownCorrespondent: z.literal(true).optional(),
});
export type MessageTriageRow = z.infer<typeof MessageTriageRow>;

// `lane` is the owner's lane and `override` the owner's release, both from the status row. An agent
// record has no owner's lane: its lane is `agent`. `regenerated`: the item was done under another
// generation and is due again because the generation changed; a run that takes one reports every
// belief change as backfill.
export const RetryAsk = z.strictObject({ lane: TriageLane, version: z.string().min(1) });
export type RetryAsk = z.infer<typeof RetryAsk>;
const due = {
  evidenceId: PersonalEvidenceId,
  compartments: Compartments,
  sentAt: Timestamp,
  attempts: count,
  override: z.boolean(),
  regenerated: z.literal(true).optional(),
};
// `routed` is triage's own decision, set by the run and never stored:
// its rule, with no owner's lane, sent the message to the transaction lane (rung 0's line 7, or
// the decide model's line 5 for mail that is not bulk). The check reads a system notice from it and the
// message's markers: bulk or the Updates category. `ask`: the owner's retry that keeps its answers chose it to be
// asked that version in that lane, from the status row; in another lane it means nothing, and any other item replays.
export const EmailDueItem = z.strictObject({
  source: z.literal("email"),
  ...due,
  lane: TriageLane.optional(),
  triage: MessageTriageRow,
  routed: z.literal("transaction").optional(),
  ask: RetryAsk.optional(),
});
export const DueItem = z.discriminatedUnion("source", [
  EmailDueItem,
  z.strictObject({ source: z.literal("agent_record"), ...due, kind: AgentWriteKind }),
]);
export type DueItem = z.infer<typeof DueItem>;
export type EmailDueItem = z.infer<typeof EmailDueItem>;

// An item the backlog pass screens: committed at the run's generation, not waiting, not
// withheld, done or skipped as bulk, with no saved decide-model call. `committedLane` is the lane its
// status row holds.
// Email items only: the backlog reads messages.
export const BacklogItem = EmailDueItem.extend({ committedLane: TriageLane });
export type BacklogItem = z.infer<typeof BacklogItem>;

// What triage reads of a document: clear columns and two sealed counts. Nothing of its text.
export const DocumentTriageRow = z.strictObject({
  reference: z.boolean(),
  kind: DocumentKind,
  mine: z.boolean(),
  editedByMe: z.boolean(),
  unreadable: z.boolean(),
  chars: count,
  modifiedAt: Timestamp,
});
export type DocumentTriageRow = z.infer<typeof DocumentTriageRow>;

// A document due for extraction, as DueItem is a message. `modifiedAt` is its document row's, which
// a claim from it is dated by.
export const DueDocument = z.strictObject({
  evidenceId: PersonalEvidenceId,
  compartment: z.string().min(1),
  modifiedAt: Timestamp,
  attempts: count,
  lane: TriageLane.optional(),
  override: z.boolean(),
  triage: DocumentTriageRow,
});
export type DueDocument = z.infer<typeof DueDocument>;

// `compartments` is its evidence row's whole label (a linked meeting's holds the event's
// compartments too), `observedAt` its evidence row's, which the due order reads. `lane` is the
// owner's lane and `override` the owner's release, both from the status row.
const dueCapture = {
  evidenceId: PersonalEvidenceId,
  compartments: Compartments,
  observedAt: Timestamp,
  attempts: count,
  lane: TriageLane.optional(),
  override: z.boolean(),
};
export const MOMENT_GROUP_MAX = 12;
// The most moments one group holds in the batched mode, which runs twice a day and makes one
// request per thread per run: extraction's `promptChars` bounds a request well before this does.
export const MOMENT_BATCH_GROUP_MAX = 100;
// DueCapture widens it for a moment group: `moments` lists each moment of the group, with its own
// marks, in observed order, and the group's own fields are its latest moment's. A meeting has none.
export const DueCapture = z.strictObject({
  ...dueCapture,
  moments: z.array(z.strictObject(dueCapture)).min(1).max(MOMENT_BATCH_GROUP_MAX).optional(),
});
export type DueCapture = z.infer<typeof DueCapture>;

// What the store seals for one claim. Code sets every field beside the claim.
// `legacyFactKey`, the claim's fact key at version 1, set
// beside a version 2 `factKey` so that rulings made before the go still find the claim.
export const ClaimRecord = z.strictObject({
  claim: Claim,
  subjectKind: SubjectKind,
  disclosure: z.array(DisclosureClass),
  factKey: z.string().min(1),
  lane: TriageLane,
  fieldKinds: z.record(z.string(), FieldKind),
  entities: z.array(LocalEntityId),
  origin: PersonalClaimOrigin,
  answersSystem: z.boolean(),
  legacyFactKey: z.string().min(1).optional(),
  // A version 4 preference's other version 1 key, its polarity's version 3
  // synonym's (`likes` for `prefers`, `dislikes` for `avoids`), so a ruling on either still finds it.
  legacyAltFactKey: z.string().min(1).optional(),
  // A released claim, the copy code makes of a confirmed proposal's claim (or one
  // of the owner's answers) under the owner's own label, `own`, by the owner's release. `ruling` is the
  // owner decision that released it; the claim's evidence is still the agent record. Set by the
  // pipeline from the store's release row alone, never from a body or a model.
  // `grant` when the owner's standing release made it, not
  // their confirm: the grant as metadata, so the claim's tier is the granted-release tier
  // (`researched`), never `owner`.
  released: z.strictObject({ ruling: RulingId, grant: z.literal(true).optional() }).optional(),
  // Contact import: what the imported row said of how sure it is, carried on each
  // claim code makes from it. Nothing ranks by them yet.
  confidence: z.number().min(0).max(1).optional(),
  standing: z.enum(["verified", "probable"]).optional(),
  // A system notice's claim, set by the check alone (check.ts) when
  // triage gave the message the transaction lane by its own rule, bulk mail of the Updates or
  // Primary category with no owner's lane, from a parseable sender, and the claim is no word of the
  // owner's and no mail the system sent. Never from a body or a model.
  notice: z.literal(true).optional(),
  // The match key of an agent record's claim, the fact key its content
  // takes as a global-scope claim under `own` with no finding part, at the current generation's key
  // version; absent for a thread-scoped claim. Set by the pipeline from the content alone.
  matchKey: z.string().min(1).optional(),
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;

// The one label a release gives, the owner's own compartment, and the labels a
// release may narrow to it: an agent record's, `own` and one or more `agent:` compartments and
// nothing else. A record under an employer's, a restricted or any other compartment is never
// released: dropping that compartment would widen what it holds. The database holds the same
// rule (knowledge.claims_label).
export const RELEASED_LABEL = Object.freeze(["own"] as const);
export const releasableLabel = (compartments: readonly string[]): boolean =>
  compartments.includes("own") &&
  compartments.some((one) => one.startsWith("agent:")) &&
  compartments.every((one) => one === "own" || one.startsWith("agent:"));

// The fact types that build a belief: each type whose belief kind has a row of the extract package's
// BELIEF_RULES. The store reads their claims for the belief build and raises an agent_claim card for
// a finding of any of them. A test in packages/extract holds this list equal to the rules.
export const BELIEF_TYPES = Object.freeze([
  "commitment",
  "role",
  "affiliation",
  "relationship",
  "need",
  "capability",
  "goal",
  "preference",
  "constraint",
  "situation",
  // A view, a status and a visit.
  "view",
  "status",
  "visited",
  "consent",
  "contact_rule",
  "project.status",
  "project.decision",
  "capture.project",
] as const);
// The types an owner can rule on and a claim card can be about: those, and the types built from a
// propose_person body.
export const CARD_CLAIM_TYPES: readonly string[] = Object.freeze([...BELIEF_TYPES, ...PERSON_PROPOSAL_TYPES]);

// A claim as the belief build is given it, with its origin, which the shared Claim lacks, and its subject's
// kind, which the belief rules read. `ownerSaid`: its speaker is the owner, as the store read it, which a
// project status's conflict rule reads. `ownerConfirmed`: a claim from a source that the owner confirmed on
// its about_you card, as the store read it: the owner's need asked as a question. It counts as a confirmed
// proposal does. `carried`: the ids of the fact vetoes and retires in force that reach it only by its
// version 1 fact key, each made on a belief its own item supported. The belief build applies each within
// D8's date bound. Absent when there is none. `meeting` when the claim is the meeting lane's (its record's
// lane), so the belief rules can count a meeting's claim credited to nobody as a source's, apart from a
// moment's. `notice` when the claim is a system notice's (about-you.ts isSystemNotice, by its record's
// lane), so the belief rules count it about the owner at the `system_notice` tier. `keys`, every claim key
// the claim is known by (its own fact key's and each version 1 key's), by which the build finds the
// relations that name it. `granted`, a released claim the owner's standing release made
// (ClaimRecord.released.grant). `relayed`, a claim whose card the owner's confirm, relayed by an agent,
// answered (policy.relayed_claims), at the `owner_relayed` tier.
export type BeliefClaim = {
  claim: Claim;
  origin: PersonalClaimOrigin;
  subjectKind: SubjectKind;
  ownerSaid?: boolean;
  ownLine?: true;
  ownerConfirmed?: boolean;
  agentConfirmed?: boolean;
  relayed?: boolean;
  carried?: string[];
  meeting?: true;
  notice?: true;
  granted?: true;
  keys?: string[];
};

// `group`, the fingerprint of the joined set the belief belongs to, shared by the beliefs of one
// set across labels; `members`, the set's fact key fingerprints, sorted. All optional: a belief
// built before joined sets has none.
export const BeliefRecord = z.strictObject({
  belief: Belief,
  factKeyFp: z.string().min(1),
  compartments: Compartments,
  provenance: Provenance,
  tier: BeliefTier.optional(),
  phraseClaim: z.string().min(1).optional(),
  group: Hex64.optional(),
  members: z.array(Hex64).min(2).max(FACT_GROUP_MAX).optional(),
  // An applied `prevails`, or an agent's settlement (`agent`), settled the dispute. The belief
  // is the winner's value, still disputed; `winner` is the claim that prevailed, `losing` the
  // claims of the side it prevailed over, all cited in `support`; `by` how it was settled; and
  // `sources`, the distinct items that state the winner's value.
  settled: z
    .strictObject({
      by: z.enum(["rule", "model", "agent"]),
      winner: z.string().min(1),
      losing: z.array(z.string().min(1)).min(1).max(200),
      sources: z.number().int().min(1),
    })
    .optional(),
  // A model's source check found the passages of exactly this belief's claims
  // do not support it, under a label this audience holds.
  unsupported: z.literal(true).optional(),
});
export type BeliefRecord = z.infer<typeof BeliefRecord>;

// `reported`, the vendor's own figure; `price_list`, the system's estimate from its price list;
// `assumed`, a ceiling or a guess where the vendor gave none.
export const CostBasis = z.enum(["reported", "price_list", "assumed"]);
export type CostBasis = z.infer<typeof CostBasis>;
