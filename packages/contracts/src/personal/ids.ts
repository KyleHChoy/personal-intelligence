import { z } from "zod";
import { SourceAccountId as CompanySourceAccountId, EvidenceId } from "../ids.ts";

// A ULID: 26 characters of Crockford base32, upper case. No I, L, O or U.
export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
// Every prefix a row id of the personal database takes. A list of prefixes elsewhere is written in
// this type, so a word that is no prefix fails to compile.
export const ID_PREFIXES = Object.freeze([
  "aan",
  "acc",
  "amg",
  "asg",
  "atr",
  "cac",
  "cap",
  "cas",
  "cex",
  "cin",
  "cli",
  "crd",
  "csr",
  "doc",
  "dpc",
  "drf",
  "ent",
  "ers",
  "evt",
  "gdc",
  "gol",
  "gpr",
  "hdl",
  "hrn",
  "hyp",
  "imp",
  "int",
  "itn",
  "lrn",
  "lst",
  "mbd",
  "mcr",
  "mov",
  "msg",
  "ntc",
  "opp",
  "pag",
  "pan",
  "prp",
  "rec",
  "rft",
  "rsq",
  "rtr",
  "rul",
  "run",
  "sel",
  "ses",
  "snt",
  "tex",
  "tpr",
  "trn",
  "tru",
  "tst",
  "umn",
  "wch",
  "wrq",
] as const);
export type IdPrefix = (typeof ID_PREFIXES)[number];
const pattern = (prefix: IdPrefix): RegExp => new RegExp(`^${prefix}_${ULID_PATTERN}$`);

// A row id of the personal database: a short prefix for its table and a ULID. Opaque: a client
// must not read anything into one.
const id = <Brand extends string>(prefix: IdPrefix) => z.string().regex(pattern(prefix)).brand<Brand>();

// Also the LocalEntityId the personal identity port returns.
export const EntityId = id<"EntityId">("ent");
export type EntityId = z.infer<typeof EntityId>;

export const MessageId = id<"MessageId">("msg");
export type MessageId = z.infer<typeof MessageId>;

export const EventId = id<"EventId">("evt");
export type EventId = z.infer<typeof EventId>;

// Its own brand: the shared contracts have a ClientId too, and one must not compile where the other is
// wanted.
export const ClientId = id<"PersonalClientId">("cli");
export type ClientId = z.infer<typeof ClientId>;

// The shared id, narrowed to the personal form. The brand is the shared one, so a personal
// id is a SourceAccountId wherever a shared shape takes one.
export const SourceAccountId = CompanySourceAccountId.refine((value) => pattern("acc").test(value), {
  message: "not a personal source account id",
});
export type SourceAccountId = z.infer<typeof SourceAccountId>;

// A client's name. Also the form of a source account's label, and of the slug in "agent:<slug>"
// and "employer:<slug>".
export const ClientName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export type ClientName = z.infer<typeof ClientName>;

// An agent record and the session a client wrote it in.
export const AgentRecordId = id<"AgentRecordId">("rec");
export type AgentRecordId = z.infer<typeof AgentRecordId>;

export const SessionId = id<"SessionId">("ses");
export type SessionId = z.infer<typeof SessionId>;

// A turn the owner submitted, attested by the box's hook.
export const TurnId = id<"TurnId">("trn");
export type TurnId = z.infer<typeof TurnId>;

// An owner decision, a card and an erasure.
export const RulingId = id<"RulingId">("rul");
export type RulingId = z.infer<typeof RulingId>;

export const CardId = id<"CardId">("crd");
export type CardId = z.infer<typeof CardId>;

export const ErasureId = id<"ErasureId">("ers");
export type ErasureId = z.infer<typeof ErasureId>;

// The rows of durable work. `int_` and `itn_` differ by one letter.
export const GoalId = id<"GoalId">("gol");
export type GoalId = z.infer<typeof GoalId>;

export const IntentId = id<"IntentId">("int");
export type IntentId = z.infer<typeof IntentId>;

// One work notice, a ledger row of ids, codes and times.
export const WorkNoticeId = id<"WorkNoticeId">("ntc");
export type WorkNoticeId = z.infer<typeof WorkNoticeId>;

// An agent's goal proposal, a ledger row served only by get_suggestions.
export const GoalProposalId = id<"GoalProposalId">("gpr");
export type GoalProposalId = z.infer<typeof GoalProposalId>;

export const HarnessModeId = id<"HarnessModeId">("hrn");
export type HarnessModeId = z.infer<typeof HarnessModeId>;

export const RunId = id<"RunId">("run");
export type RunId = z.infer<typeof RunId>;

export const CaseId = id<"CaseId">("cas");
export type CaseId = z.infer<typeof CaseId>;

export const HypothesisId = id<"HypothesisId">("hyp");
export type HypothesisId = z.infer<typeof HypothesisId>;

export const TestId = id<"TestId">("tst");
export type TestId = z.infer<typeof TestId>;

export const OpportunityId = id<"OpportunityId">("opp");
export type OpportunityId = z.infer<typeof OpportunityId>;

export const MoveId = id<"MoveId">("mov");
export type MoveId = z.infer<typeof MoveId>;

export const IntentionId = id<"IntentionId">("itn");
export type IntentionId = z.infer<typeof IntentionId>;

// A client's work request, its proposal, and the owner's watch. A work request id
// is not a RequestId, which is the client's own id for retrying a write.
export const WorkRequestId = id<"WorkRequestId">("wrq");
export type WorkRequestId = z.infer<typeof WorkRequestId>;

export const ProposalId = id<"ProposalId">("prp");
export type ProposalId = z.infer<typeof ProposalId>;

export const WatchId = id<"WatchId">("wch");
export type WatchId = z.infer<typeof WatchId>;

// A draft, a gate decision and a send.
export const DraftId = id<"DraftId">("drf");
export type DraftId = z.infer<typeof DraftId>;

export const GateDecisionId = id<"GateDecisionId">("gdc");
export type GateDecisionId = z.infer<typeof GateDecisionId>;

export const SentId = id<"SentId">("snt");
export type SentId = z.infer<typeof SentId>;

// A document of the owner's Drive.
export const DocumentId = id<"DocumentId">("doc");
export type DocumentId = z.infer<typeof DocumentId>;
// A seal and a retention rule, the owner's two.
export const SealId = id<"SealId">("sel");
export type SealId = z.infer<typeof SealId>;

export const RetentionRuleId = id<"RetentionRuleId">("rtr");
export type RetentionRuleId = z.infer<typeof RetentionRuleId>;

// A research request, a stored page and one egress of a request.
export const ResearchRequestId = id<"ResearchRequestId">("rsq");
export type ResearchRequestId = z.infer<typeof ResearchRequestId>;

export const PageId = id<"PageId">("pag");
export type PageId = z.infer<typeof PageId>;

export const ResearchFetchId = id<"ResearchFetchId">("rft");
export type ResearchFetchId = z.infer<typeof ResearchFetchId>;

// A filed mention no one resolved, and the owner's binding of one.
export const MentionId = id<"MentionId">("umn");
export type MentionId = z.infer<typeof MentionId>;

export const MentionBindingId = id<"MentionBindingId">("mbd");
export type MentionBindingId = z.infer<typeof MentionBindingId>;

// Lens: a capture item's key, which Lens makes, a ULID after the item's kind, never a hash of
// content; a stored capture item; a mirror projection, made as the memory adapters'
// MemoryProjectionId is; and a mirror cursor the server issued. `contact:` is a Mac contact and
// `contacts:` a listing of them.
export const CaptureKey = z
  .string()
  .regex(new RegExp(`^(meeting|moment|block|task|forget|contact|contacts):${ULID_PATTERN}$`));
export type CaptureKey = z.infer<typeof CaptureKey>;

export const CaptureId = id<"CaptureId">("cap");
export type CaptureId = z.infer<typeof CaptureId>;

// A row of Lens's inbox, as a log line names one.
export const CaptureInboxId = id<"CaptureInboxId">("cin");
export type CaptureInboxId = z.infer<typeof CaptureInboxId>;

export const MirrorEntryId = z
  .string()
  .regex(/^mir_[0-9a-f]{40}$/)
  .brand<"MirrorEntryId">();
export type MirrorEntryId = z.infer<typeof MirrorEntryId>;

export const MirrorCursor = id<"MirrorCursor">("mcr");
export type MirrorCursor = z.infer<typeof MirrorCursor>;

// One row of knowledge.project_anchors: a device anchor. Here rather than in anchors.ts, which imports
// tools-args.ts, so that tools-views.ts' capture.anchor fact can name it.
export const AnchorId = id<"AnchorId">("pan");
export type AnchorId = z.infer<typeof AnchorId>;

// One rule of the owner's capture scope.
export const CaptureScopeRuleId = id<"CaptureScopeRuleId">("csr");
export type CaptureScopeRuleId = z.infer<typeof CaptureScopeRuleId>;

export const TimeProposalId = id<"TimeProposalId">("tpr");
export type TimeProposalId = z.infer<typeof TimeProposalId>;
// One agent's anchor of a place to a project, and one agent's ruling of a stretch.
export const AgentAnchorId = id<"AgentAnchorId">("aan");
export type AgentAnchorId = z.infer<typeof AgentAnchorId>;
export const AgentRulingId = id<"AgentRulingId">("atr");
export type AgentRulingId = z.infer<typeof AgentRulingId>;

export const CaptureExcludeId = id<"CaptureExcludeId">("cex");
export type CaptureExcludeId = z.infer<typeof CaptureExcludeId>;
export const CaptureAccountId = id<"CaptureAccountId">("cac");
export type CaptureAccountId = z.infer<typeof CaptureAccountId>;
// Owner dashboard: one of the owner's lists of people.
export const OwnerListId = id<"OwnerListId">("lst");
export type OwnerListId = z.infer<typeof OwnerListId>;

// What every write a client, a run or the owner makes carries: a repeat returns the first result.
export const RequestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .describe("8 to 64 letters, digits, _ or -, new for each request.");
export type RequestId = z.infer<typeof RequestId>;

// A one-time handle: `hdl_` and 26 random characters, carrying no part of an id or a time. What a
// client in `session` mode is given in place of a stored row's id, a claim id or a fingerprint; it
// resolves only in the session epoch that issued it. Its own brand: a handle is no row id, and a row id
// is no handle.
export const Handle = z.string().regex(pattern("hdl")).brand<"PersonalHandle">();
export type Handle = z.infer<typeof Handle>;

// An evidence id as the personal database stores it: 64 hexadecimal characters. Here, not in
// extraction.ts, so agent-records.ts and extraction.ts can both use it without a cycle.
export const PersonalEvidenceId = EvidenceId.refine((value) => /^[0-9a-f]{64}$/.test(value), {
  message: "not an evidence id",
});
export type PersonalEvidenceId = z.infer<typeof PersonalEvidenceId>;

// Who a card's author, or a ledger event's `by`, names, read from the formats `CardAuthor` and `LedgerEvent`
// check: the owner, the one reasoner, a client or a run by its id, the system by its worker. Any other
// (a lane's bare worker name) is `other`.
type AuthorParts = { kind: "owner" | "reasoner" | "other" } | { kind: "client" | "run" | "system"; rest: string };
export const authorParts = (author: string): AuthorParts => {
  if (author === "owner" || author === "reasoner") return { kind: author };
  for (const kind of ["client", "run", "system"] as const)
    if (author.startsWith(`${kind}:`)) return { kind, rest: author.slice(kind.length + 1) };
  return { kind: "other" };
};
export const isClientAuthor = (author: string | null | undefined): author is string =>
  author != null && authorParts(author).kind === "client";
