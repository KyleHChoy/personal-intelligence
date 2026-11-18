import { z } from "zod";
import { BeliefStatus } from "./belief.ts";
import { BasisType, StatementKind } from "./claim.ts";
import { ReferenceKind, SourceKind } from "./evidence.ts";
import {
  CardId,
  CaseId,
  ClaimId,
  DraftId,
  EntityKind,
  EvidenceId,
  Handle,
  MatchRef,
  PageCursor,
  PartyId,
  ReviewId,
  RunId,
  Sha256,
  SilenceId,
  Store,
  Timestamp,
} from "./ids.ts";
import { ReviewKind } from "./knowledge.ts";
import { Label } from "./label.ts";
import {
  CardAction,
  CardLabelInput,
  CardSideKey,
  CardState,
  PartyRole,
  PlaybookId,
  ProposedText,
  SilenceReason,
} from "./ledger.ts";
import { BeliefKind, FieldValue, TypedValue } from "./ontology.ts";
import { ConsentStatus, DraftView } from "./outbound.ts";
import { ThreadEntryRole } from "./work.ts";

// The tools a member's agent, the workbench and the mobile app can call.
export const ReadTool = z.enum([
  "search",
  "get_entity",
  "get_beliefs",
  "get_timeline",
  "get_decision_history",
  "get_document",
  "fetch_template",
  "find_paths",
  "get_evidence_span",
  "read_item",
  "build_context_pack",
  "get_suggestions",
]);
export type ReadTool = z.infer<typeof ReadTool>;

// Served to the app API only.
const WorkbenchReadTool = z.enum(["list_review_queue", "list_consent", "list_drafts", "list_silences"]);
type WorkbenchReadTool = z.infer<typeof WorkbenchReadTool>;

// Served to the reasoner only, under a run token.
export const ReasonerTool = z.enum(["find_matches", "check_conflicts"]);
export type ReasonerTool = z.infer<typeof ReasonerTool>;

const EvalsTool = z.enum(["get_run_history"]);
type EvalsTool = z.infer<typeof EvalsTool>;

// Every tool a context provider serves.
export const ProviderTool = z.enum([
  ...ReadTool.options,
  ...WorkbenchReadTool.options,
  ...ReasonerTool.options,
  ...EvalsTool.options,
]);
export type ProviderTool = z.infer<typeof ProviderTool>;

// --- what the arguments are made of ---

const ContextPackPurpose = z.literal("meeting_prep");
type ContextPackPurpose = z.infer<typeof ContextPackPurpose>;

const SearchKind = z.enum(["person", "organization", "project", "decision_thread", "document", "need", "capability"]);
type SearchKind = z.infer<typeof SearchKind>;

// The side of a match a row is on.
const MatchSide = z.enum(["need", "capability", "role"]);
type MatchSide = z.infer<typeof MatchSide>;

// --- what a tool returns: exact, cited, labelled. Entities are handles ---

const Citation = z.object({
  evidenceId: EvidenceId,
  span: z.string().min(1),
  // Present only when the viewer was a reader on the source.
  quote: z.string().optional(),
});
type Citation = z.infer<typeof Citation>;

const cited = z.array(Citation).min(1);

// A claim as a caller sees it.
const ClaimView = z.object({
  claimId: ClaimId,
  type: z.string().min(1),
  subject: Handle,
  fields: z.record(z.string(), z.union([FieldValue, Handle])),
  statementKind: StatementKind,
  basis: BasisType,
  // Only for a reader on the claim's own label.
  assertedBy: Handle.optional(),
  validFrom: Timestamp,
  validTo: Timestamp.optional(),
  citations: cited,
});
type ClaimView = z.infer<typeof ClaimView>;

// A belief as a caller sees it. No fact key and no support hash.
const BeliefView = z.object({
  kind: BeliefKind,
  type: z.string().min(1),
  subject: Handle,
  values: z.record(z.string(), z.union([TypedValue, Handle])),
  status: BeliefStatus,
  disputed: z.boolean(),
  confidence: z.number().min(0).max(1),
  lastConfirmedAt: Timestamp,
  reviewAfter: Timestamp.optional(),
  citations: cited,
});
type BeliefView = z.infer<typeof BeliefView>;

const SearchHit = z.object({
  kind: SearchKind,
  entity: Handle.optional(),
  document: EvidenceId.optional(),
  matchedBy: z.enum(["name", "type", "structure", "keyword", "vector"]),
  fields: z.record(z.string(), z.union([FieldValue, Handle])),
  citations: cited,
});
type SearchHit = z.infer<typeof SearchHit>;

// A person, organization or project page, rendered at read time and never stored.
const EntityPage = z.object({
  entity: Handle,
  entityKind: EntityKind,
  beliefs: z.array(BeliefView),
  claims: z.array(ClaimView),
  citations: cited,
});
type EntityPage = z.infer<typeof EntityPage>;

const TimelineEntry = z.object({
  at: Timestamp,
  kind: z.enum(["event", "interaction", "claim"]),
  participants: z.array(Handle),
  channel: SourceKind.optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  claim: ClaimView.optional(),
  citations: cited,
});
type TimelineEntry = z.infer<typeof TimelineEntry>;

// A decision with its reasoning, what else was considered and what was expected of it.
const DecisionRecordView = z.object({
  decision: ClaimView,
  reasoning: z.array(Citation),
  alternatives: z.array(ClaimView),
  expectation: ClaimView.optional(),
  owner: Handle.optional(),
  checkBackAt: Timestamp.optional(),
  outcome: z.enum(["pending", "met", "missed"]).optional(),
});
type DecisionRecordView = z.infer<typeof DecisionRecordView>;

// questionType is an ontology type id. The thread's key fields stay in the store.
const DecisionThreadView = z.object({
  questionType: z.string().min(1),
  entries: z.array(
    z.object({ role: ThreadEntryRole, validFrom: Timestamp, claim: ClaimView, team: z.string().min(1).optional() }),
  ),
  record: DecisionRecordView.optional(),
  citations: cited,
});
type DecisionThreadView = z.infer<typeof DecisionThreadView>;

const DocumentView = z.object({
  document: EvidenceId,
  kind: ReferenceKind,
  title: z.string().min(1),
  effectiveFrom: Timestamp.optional(),
  owner: Handle.optional(),
  sourceLink: z.string().min(1),
  sections: z.array(
    z.object({
      ordinal: z.number().int().nonnegative(),
      heading: z.string(),
      body: z.string(),
      guidance: z.string().optional(),
    }),
  ),
  citations: cited,
});
type DocumentView = z.infer<typeof DocumentView>;

const TemplateView = DocumentView.extend({
  placeholders: z.array(
    z.object({ ordinal: z.number().int().nonnegative(), name: z.string().min(1), kind: z.string().min(1) }),
  ),
  // The file itself, as base64.
  file: z.object({ mediaType: z.string().min(1), content: z.base64() }).optional(),
});
type TemplateView = z.infer<typeof TemplateView>;

// A way to reach someone, over ties the viewer can see and public affiliation bridges.
const PathView = z.object({
  target: Handle,
  score: z.number(),
  hops: z.array(
    z.object({
      from: Handle,
      to: Handle,
      via: z.enum(["own_tie", "visible_tie", "affiliation_bridge"]),
      citations: cited,
    }),
  ),
  citations: cited,
});
type PathView = z.infer<typeof PathView>;

// One exact span of one item, for a viewer who was a reader on it.
const SpanView = z.object({
  evidenceId: EvidenceId,
  span: z.string().min(1),
  quote: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  sourceKind: SourceKind,
  observedAt: Timestamp,
});
type SpanView = z.infer<typeof SpanView>;

const ItemView = z.object({
  evidenceId: EvidenceId,
  sourceKind: SourceKind,
  observedAt: Timestamp,
  parts: z.array(z.object({ span: z.string().min(1), author: Handle.optional(), text: z.string() })),
});
type ItemView = z.infer<typeof ItemView>;

// hash is the hash of the pack's content, which the provider records.
const ContextPackView = z.object({
  purpose: ContextPackPurpose,
  hash: Sha256,
  subjects: z.array(Handle),
  beliefs: z.array(BeliefView),
  timeline: z.array(TimelineEntry),
  threads: z.array(DecisionThreadView),
  quotes: z.array(Citation),
});
type ContextPackView = z.infer<typeof ContextPackView>;

const CardParty = z.object({
  party: PartyId,
  role: PartyRole,
  entity: Handle,
  consent: ConsentStatus.optional(),
});
type CardParty = z.infer<typeof CardParty>;

// A card as one viewer sees it. "held" is shown as "held for review" and nothing else.
// "release_request" is what the asked holder of one side sees: their own side only, with no
// field about the other side, its holder, its release state or its timing. "full" is what the
// grantee of the card's grant, a viewer whose access covers both sides and, after both
// releases, the members named in them see.
const CardView = z.discriminatedUnion("form", [
  z.strictObject({ form: z.literal("held"), cardId: CardId }),
  z.strictObject({
    form: z.literal("release_request"),
    cardId: CardId,
    side: CardSideKey,
    claims: z.array(ClaimView),
    citations: cited,
  }),
  z.object({
    form: z.literal("full"),
    cardId: CardId,
    state: CardState.extract(["broker_review", "in_review", "approved", "edited", "rejected", "deferred"]),
    playbook: PlaybookId,
    weekOf: Timestamp,
    parties: z.array(CardParty),
    reasons: z.array(ClaimView),
    path: PathView.optional(),
    texts: z.array(ProposedText),
    drafts: z.array(DraftId),
    citations: cited,
  }),
]);
type CardView = z.infer<typeof CardView>;

const ReviewItemView = z.object({
  reviewId: ReviewId,
  kind: ReviewKind,
  status: z.enum(["open", "decided"]),
  claims: z.array(ClaimView),
  project: Handle.optional(),
});
type ReviewItemView = z.infer<typeof ReviewItemView>;

const ConsentView = z.object({
  caseId: CaseId,
  cardId: CardId,
  parties: z.array(z.object({ party: PartyId, entity: Handle, consent: ConsentStatus })),
});
type ConsentView = z.infer<typeof ConsentView>;

// One sampled silence from the member's own runs. Ids and codes only.
const SilenceView = z.object({
  silenceId: SilenceId,
  runId: RunId,
  playbook: PlaybookId,
  at: Timestamp,
  weekOf: Timestamp,
  reason: z.enum([...SilenceReason.options, "held_for_review"]),
});
type SilenceView = z.infer<typeof SilenceView>;

// A stripped row of the match index: a reference, a side and a type. Never an entity or any text.
const MatchRow = z.strictObject({ match: MatchRef, side: MatchSide, type: z.string().min(1) });
type MatchRow = z.infer<typeof MatchRow>;

// One opened pair, with both of its sides and the spans they cite. The opening and its spans
// are one logged event, returned only after the read log has it. The pair is two different rows
// on different sides: a need, and a capability or a role.
const MatchCandidate = z
  .object({
    pair: z.tuple([MatchRef, MatchRef]),
    sides: z
      .array(
        z.object({
          match: MatchRef,
          side: MatchSide,
          entity: Handle,
          claims: z.array(ClaimView),
          spans: z.array(SpanView),
        }),
      )
      .length(2),
    citations: cited,
  })
  .refine((candidate) => candidate.pair[0] !== candidate.pair[1], { message: "a pair is two different rows" })
  .refine((candidate) => candidate.sides.filter((side) => side.side === "need").length === 1, {
    message: "a pair is a need and a capability or role",
  });
type MatchCandidate = z.infer<typeof MatchCandidate>;

const ConflictCheck = z.object({ party: Handle, hit: z.boolean() });
type ConflictCheck = z.infer<typeof ConflictCheck>;

// One of the token member's own runs: what it cost, and what became of each case.
const RunHistoryItem = z.object({
  runId: RunId,
  playbook: PlaybookId,
  startedAt: Timestamp,
  steps: z.array(z.object({ ordinal: z.number().int().nonnegative(), cost: z.number().nonnegative().nullable() })),
  cases: z.array(
    z.object({
      caseId: CaseId,
      snapshotAt: Timestamp,
      cardId: CardId.optional(),
      state: CardState.optional(),
      action: CardAction.optional(),
      labels: CardLabelInput.optional(),
      // When the card was first opened and when it was decided: review time is the gap.
      openedAt: Timestamp.optional(),
      decidedAt: Timestamp.optional(),
      unwantedAsk: z.boolean(),
      consentFailure: z.boolean(),
    }),
  ),
});
type RunHistoryItem = z.infer<typeof RunHistoryItem>;

// The item schema of each tool. A scan of find_matches returns stripped rows, and an opening
// one candidate. Frozen as the arguments table is.
const TOOL_ITEMS = Object.freeze({
  search: SearchHit,
  get_entity: EntityPage,
  get_beliefs: BeliefView,
  get_timeline: TimelineEntry,
  get_decision_history: DecisionThreadView,
  get_document: DocumentView,
  fetch_template: TemplateView,
  find_paths: PathView,
  get_evidence_span: SpanView,
  read_item: ItemView,
  build_context_pack: ContextPackView,
  get_suggestions: CardView,
  list_review_queue: ReviewItemView,
  list_consent: ConsentView,
  list_drafts: DraftView,
  list_silences: SilenceView,
  find_matches: z.union([MatchRow, MatchCandidate]),
  check_conflicts: ConflictCheck,
  get_run_history: RunHistoryItem,
} satisfies Record<ProviderTool, z.ZodType>);

// --- the envelopes ---

// One tool's result: exact, cited, labelled. Providers never summarize.
const result = <Tool extends ProviderTool>(tool: Tool) =>
  z
    .object({
      store: Store,
      tool: z.literal(tool),
      // Covers every row the plan read, cited or not. Absent exactly when the plan read no row: a
      // label names at least one compartment, and nothing read has none to name.
      label: Label.optional(),
      items: z.array(TOOL_ITEMS[tool]),
      // Paging uses only rows the viewer can see.
      nextPage: PageCursor.optional(),
    })
    .refine((result) => result.label !== undefined || result.items.length === 0, {
      message: "items read under no label",
      path: ["label"],
    });

// Every tool returns this envelope.
export const ToolResult = z.discriminatedUnion("tool", [
  result("search"),
  result("get_entity"),
  result("get_beliefs"),
  result("get_timeline"),
  result("get_decision_history"),
  result("get_document"),
  result("fetch_template"),
  result("find_paths"),
  result("get_evidence_span"),
  result("read_item"),
  result("build_context_pack"),
  result("get_suggestions"),
  result("list_review_queue"),
  result("list_consent"),
  result("list_drafts"),
  result("list_silences"),
  result("find_matches"),
  result("check_conflicts"),
  result("get_run_history"),
]);
export type ToolResult = z.infer<typeof ToolResult>;

// "opening_limit" is the refusal for too many openings in one run.
export const ToolErrorCode = z.enum([
  "invalid_request",
  "not_found",
  "denied",
  "quota",
  "opening_limit",
  "stale_policy",
  "unavailable",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;
