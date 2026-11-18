import { z } from "zod";

// Branded ids, so one kind of id cannot be passed where another is expected.
const id = <Brand extends string>() => z.string().min(1).brand<Brand>();

// A hash of vault, source account, source item id and revision. Made only by evidenceIdFor.
export const EvidenceId = id<"EvidenceId">();
export type EvidenceId = z.infer<typeof EvidenceId>;

// A deterministic function of evidence id, revision, span, canonical content and extractor generation.
export const ClaimId = id<"ClaimId">();
export type ClaimId = z.infer<typeof ClaimId>;

// The one group in the first version: every member.
export const GroupId = z.literal("all_members").brand<"GroupId">();
export type GroupId = z.infer<typeof GroupId>;

export const ALL_MEMBERS = "all_members" as GroupId;

// Stable id for a member. Never an email address, and never the group's reserved value.
export const MemberId = z
  .string()
  .min(1)
  .refine((value) => value !== ALL_MEMBERS, { message: "reserved for the all-members group" })
  .brand<"MemberId">();
export type MemberId = z.infer<typeof MemberId>;

export const ReaderId = z.union([GroupId, MemberId]);
export type ReaderId = z.infer<typeof ReaderId>;

// For example "org", "people", "deal:<id>", "member:<id>", "public", "source:<account id>".
// Its kind is deployment configuration. Every item carries its source account's compartment.
export const Compartment = z.string().min(1);
export type Compartment = z.infer<typeof Compartment>;

// A store's own id for a person, organization or project. Never shared across stores.
export const LocalEntityId = id<"LocalEntityId">();
export type LocalEntityId = z.infer<typeof LocalEntityId>;

// A handle the identity service issues for one member and one client session. It expires with
// the session and cannot be joined with a handle from another session or member. Callers never
// see stable entity ids.
export const Handle = id<"Handle">();
export type Handle = z.infer<typeof Handle>;

export const EntityKind = z.enum(["person", "organization", "project"]);
export type EntityKind = z.infer<typeof EntityKind>;

// True for a real calendar day written YYYY-MM-DD.
const isCalendarDay = (day: string): boolean => {
  const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === date;
};

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

// ISO 8601 with a date, a time to the second and an explicit zone: "Z" or an offset. Nothing
// else that Date.parse would take: no date alone, no local time, no other format.
export const Timestamp = z
  .string()
  .refine((s) => isCalendarDay(TIMESTAMP.exec(s)?.[1] ?? ""), { message: "not a timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;

// A calendar day, YYYY-MM-DD.
export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDay, { message: "not a date" });
export type DateOnly = z.infer<typeof DateOnly>;

export const Vault = z.enum(["team", "public", "personal"]);
export type Vault = z.infer<typeof Vault>;

export const Store = z.enum(["people", "work", "personal"]);
export type Store = z.infer<typeof Store>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256>;

// A value shaped like an id the system mints, so research can refuse one offered as a name. The
// prefixes are every one the repository mints, in its packages, its apps and the synthetic world,
// followed by a hyphen and an id body; also a bare UUID and a bare hex digest of 16 or more
// characters. A prefix is lower case, so a name such as "Mary-Jane" is not one. The body is one
// the system mints only when it holds a digit, or is six or more lower-case hex characters, or
// sixteen or more base64url characters, so a name such as "al-Ahram" or "t-mobile" is not one.
// A member id keeps any lower-case body (m-ben), the form the synthetic world gives members.
const MINTED_PREFIXES = [
  "acct",
  "al",
  "alias",
  "blob",
  "c",
  "card",
  "case",
  "ce",
  "chat",
  "claim",
  "d",
  "declass",
  "deal",
  "dir",
  "doc",
  "draft",
  "e",
  "el",
  "ent",
  "erasure",
  "ev",
  "evt",
  "fact",
  "finding",
  "folder",
  "fp",
  "g",
  "h",
  "hd",
  "hold",
  "id",
  "il",
  "in",
  "ins",
  "intent",
  "k",
  "key",
  "kr",
  "m",
  "msg",
  "out",
  "post",
  "q",
  "qr",
  "r",
  "rc",
  "ref",
  "req",
  "research",
  "restore",
  "rev",
  "rl",
  "rq",
  "run",
  "rv",
  "s",
  "sc",
  "sealed",
  "sent",
  "ses",
  "sess",
  "session",
  "set",
  "sig",
  "sil",
  "t",
  "tag",
  "thread",
  "tok",
  "u",
  "um",
];
const BODY = "[A-Za-z0-9_-]*\\d[A-Za-z0-9_-]*|[0-9a-f]{6,}|[A-Za-z0-9_-]{16,}";
const MINTED = new RegExp(
  `^(?:(?:${MINTED_PREFIXES.join("|")})-(?:${BODY})|m-[a-z0-9_-]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,})$`,
);
export const MintedId = z.string().regex(MINTED);
export type MintedId = z.infer<typeof MintedId>;

// A keyed hash, compared for equality only.
export const Fingerprint = id<"Fingerprint">();
export type Fingerprint = z.infer<typeof Fingerprint>;

// The reference to one evidence item's data key.
export const KeyRef = id<"KeyRef">();
export type KeyRef = z.infer<typeof KeyRef>;

// The id of a verification key.
export const KeyId = id<"KeyId">();
export type KeyId = z.infer<typeof KeyId>;

// A sign-in session id. For a run, the same string as its RunId.
export const SessionId = id<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const RunId = id<"RunId">();
export type RunId = z.infer<typeof RunId>;

// "workbench", "mobile" and "run" are reserved. Any other value is an approved agent client's id.
export const ClientId = id<"ClientId">();
export type ClientId = z.infer<typeof ClientId>;

export const SourceAccountId = id<"SourceAccountId">();
export type SourceAccountId = z.infer<typeof SourceAccountId>;

// Names one model gateway: one per vault, one per store, one for research.
export const TrustGroupId = id<"TrustGroupId">();
export type TrustGroupId = z.infer<typeof TrustGroupId>;

export const GrantId = id<"GrantId">();
export type GrantId = z.infer<typeof GrantId>;

export const ScopeId = id<"ScopeId">();
export type ScopeId = z.infer<typeof ScopeId>;

export const TokenId = id<"TokenId">();
export type TokenId = z.infer<typeof TokenId>;

export const ReviewId = id<"ReviewId">();
export type ReviewId = z.infer<typeof ReviewId>;

// Chosen by the caller of a write. The receiver stores it under a unique constraint and
// returns the first result when it sees the id again.
export const RequestId = id<"RequestId">();
export type RequestId = z.infer<typeof RequestId>;

export const CaseId = id<"CaseId">();
export type CaseId = z.infer<typeof CaseId>;

export const CardId = id<"CardId">();
export type CardId = z.infer<typeof CardId>;

// Names one side of one case, not a person.
export const PartyId = id<"PartyId">();
export type PartyId = z.infer<typeof PartyId>;

export const DraftId = id<"DraftId">();
export type DraftId = z.infer<typeof DraftId>;

export const GateCheckId = id<"GateCheckId">();
export type GateCheckId = z.infer<typeof GateCheckId>;

export const SilenceId = id<"SilenceId">();
export type SilenceId = z.infer<typeof SilenceId>;

// Checked against the fixed research templates in code.
export const ResearchTemplateId = id<"ResearchTemplateId">();
export type ResearchTemplateId = z.infer<typeof ResearchTemplateId>;

// Names one match index row for one run. Never a claim id, and it ends with the run.
export const MatchRef = id<"MatchRef">();
export type MatchRef = z.infer<typeof MatchRef>;

// Opaque, and bound to the viewer who received it.
export const PageCursor = id<"PageCursor">();
export type PageCursor = z.infer<typeof PageCursor>;
