import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { SubjectRef } from "./about.ts";
import {
  AffiliationRelation,
  AGENT_PROJECT_STATUSES,
  CONSENT_SUBJECTS,
  CONTACT_CHANNELS,
  CONTACT_RULES,
  PreferencePolarity,
  RELATIONSHIP_RELATIONS,
} from "./fact-vocabulary.ts";
import {
  AgentRecordId,
  ClientName,
  EntityId,
  EventId,
  Handle,
  MessageId,
  PersonalEvidenceId,
  RequestId,
  SessionId,
  TurnId,
} from "./ids.ts";
import { LifeDomain } from "./knowledge-model.ts";
import { Hex64 } from "./primitives.ts";
import { ClaimRefusal } from "./tool-errors.ts";
import { FIND_RECORDS_MOST, UntrustedString } from "./tools-args.ts";

// Agent records: what a client writes with the record tool. Nothing here lets a client name
// a label, a compartment, a client, a session, a subject, an origin, a view or a provenance:
// the provider sets each, and the strict arguments refuse a call that carries one.

// The kinds `record` writes, which record_reads lists too. Besides a note, a finding and a handoff:
// a lesson, what an agent learned about doing the work, and a capability, what it learned about
// its tools.
export const AgentRecordKind = z.enum(["note", "finding", "handoff", "lesson", "capability"]);
export type AgentRecordKind = z.infer<typeof AgentRecordKind>;

// Every kind of row the agent lane holds: the three record writes, a proposal about the owner
// (propose_about_you), a change to an agent's own memory (import_memory), the owner's reply to a question
// the system asked (answer_owner_question) and an agent's close of a commitment (close_commitment). The
// record tool still takes the three.
export const AgentWriteKind = z.enum([
  ...AgentRecordKind.options,
  "proposal",
  "memory_change",
  "answer",
  "close",
  "fill",
]);
export type AgentWriteKind = z.infer<typeof AgentWriteKind>;

const codePoints = (text: string): number => [...text].length;

// `body` is 1 to 8 000 code points with no NUL; `cites` at most 20 ids or handles, none twice. `supersedes`:
// one earlier note or finding of the caller's own, of the same kind, that this one replaces. The earlier row
// is never changed, and one with a live correction the caller can read is not superseded again. Like every
// field that names a stored row, it takes the id or a handle, and a handle that resolves to nothing answers
// not_found, as an unknown id does.

const text = (most: number) =>
  z
    .string()
    .refine((value) => codePoints(value) >= 1 && codePoints(value) <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });
// A key phrase, which must be a slice of the quote when one is given, as `what` had to be.
const phrase = text(500);

// Each kind's life domain and key fields, then its value fields, strict. The key phrase is the
// kind's own field (KEY_FIELDS' `phrase`), which renders the fact; there is no `what`.
// propose_about_you takes these (about-you.ts), and so does a typed claim on a record finding,
// about any subject: a type not here, or a field outside its type's, is refused.
export const TYPED_FIELDS = Object.freeze({
  goal: z.strictObject({ domain: LifeDomain, objective: phrase, by: DateOnly.optional() }),
  need: z.strictObject({ domain: LifeDomain, object: phrase, by: DateOnly.optional() }),
  capability: z.strictObject({ domain: LifeDomain, object: phrase }),
  preference: z.strictObject({ domain: LifeDomain, object: phrase, polarity: PreferencePolarity }),
  constraint: z.strictObject({ domain: LifeDomain, rule: phrase, until: DateOnly.optional() }),
  situation: z.strictObject({
    domain: LifeDomain,
    state: phrase,
    until: DateOnly.optional(),
    momentary: z.boolean().optional(),
  }),
  // A view, its topic and the view itself; an organization's process and its current state, the
  // organization by name; a place visited, on a day when known.
  view: z.strictObject({ domain: LifeDomain, topic: phrase, view: phrase }),
  status: z.strictObject({
    domain: LifeDomain,
    organization_name: phrase,
    process: phrase,
    state: phrase,
    since: DateOnly.optional(),
  }),
  visited: z.strictObject({ domain: LifeDomain, place: phrase, when: DateOnly.optional() }),
  // No life domain; a role's organization is optional, an affiliation's is not, and each is by name: the
  // fields mail's role and affiliation claims key by.
  role: z.strictObject({ title: phrase, organization_name: phrase.optional() }),
  affiliation: z.strictObject({ relation: AffiliationRelation, organization_name: phrase }),
  // Every other belief kind the ontology keys, so a finding about a person can be typed. Each is
  // the ontology's fields for its type (personal-beliefs' ontology.ts), an entity field by its
  // entity id, and a test there holds the two to the same names and required fields, so they cannot
  // drift.
  commitment: z.strictObject({ counterparty: EntityId, what: text(1000), due: DateOnly.optional() }),
  relationship: z.strictObject({ counterparty: EntityId, relation: z.enum(RELATIONSHIP_RELATIONS) }),
  consent: z.strictObject({ about: z.enum(CONSENT_SUBJECTS), to: EntityId.optional(), what: text(1000) }),
  contact_rule: z.strictObject({
    rule: z.enum(CONTACT_RULES),
    channel: z.enum(CONTACT_CHANNELS),
    what: text(1000),
    until: DateOnly.optional(),
  }),
});
// A project's own facts, typed only on a finding filed under that project, which is their one
// subject: where it stands, in the words an agent sets a status with; one thing to do next, who is
// to do it by entity id; a decision made. Kept apart from TYPED_FIELDS, the kind registry's typed
// kinds of people and organizations: these are the ontology's project types, by their type ids.
const PROJECT_TYPED_FIELDS = Object.freeze({
  "project.status": z.strictObject({ status: z.enum(AGENT_PROJECT_STATUSES), what: text(1000).optional() }),
  "project.next_step": z.strictObject({ what: text(1000), who: EntityId, due: DateOnly.optional() }),
  "project.decision": z.strictObject({ what: text(1000) }),
});
const ProjectTypedType = z.enum(["project.status", "project.next_step", "project.decision"]);
type ProjectTypedType = z.infer<typeof ProjectTypedType>;
export const isProjectTyped = (type: string): type is ProjectTypedType => ProjectTypedType.safeParse(type).success;
// A typed claim is never about the owner, so a kind whose only subject is the owner, `status`, is
// no typed kind; propose_about_you keeps its fields.
export const TypedClaimType = z.enum([
  "goal",
  "need",
  "capability",
  "preference",
  "constraint",
  "situation",
  "view",
  "visited",
  "role",
  "affiliation",
  "commitment",
  "relationship",
  "consent",
  "contact_rule",
]);
export type TypedClaimType = z.infer<typeof TypedClaimType>;

// The agent says how it names the subject, by exactly one of an entity id, an address or a name;
// the system resolves it as `about` does and never guesses from one string. A name matching several
// is refused with the candidates (subject_ambiguous).
export const TypedClaimSubject = SubjectRef;
export type TypedClaimSubject = z.infer<typeof TypedClaimSubject>;

// A passage a typed claim rests on: an evidence id and a span in its text, in UTF-16 code units.
const TYPED_CLAIM_CITES = 20;
const TypedClaimCite = z
  .strictObject({
    evidenceId: PersonalEvidenceId,
    span: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }),
  })
  .refine((cite) => cite.span.end > cite.span.start, { message: "a span ends after it starts", path: ["span"] });

// One typed claim: a subject, a type, that type's key fields and value, and 0 to 20 cites. With
// none, it cites its own record and is served at tier agent_inferred. Code sets the label, tier,
// key and id; nothing here names one.
// The shape a finding's claims parse as: the type and fields are checked per claim by its write
// path against TypedClaimArgs, so one claim's wrong type or fields refuses that claim by its index
// with fields_invalid and never the finding with it.
export const TypedClaimShape = z.strictObject({
  subject: TypedClaimSubject,
  type: z.string().min(1).max(64),
  fields: z.record(z.string(), z.unknown()),
  cites: z.array(TypedClaimCite).max(TYPED_CLAIM_CITES),
  requestId: RequestId,
});
export type TypedClaimShape = z.infer<typeof TypedClaimShape>;
export const TypedClaimArgs = TypedClaimShape.extend({ type: TypedClaimType }).refine(
  (claim) => TYPED_FIELDS[claim.type].safeParse(claim.fields).success,
  {
    message: "fields outside the type's key and value fields",
    path: ["fields"],
  },
);
export type TypedClaimArgs = z.infer<typeof TypedClaimArgs>;
// The same check for a project's own kind.
export const ProjectTypedClaimArgs = TypedClaimShape.extend({ type: ProjectTypedType }).refine(
  (claim) => PROJECT_TYPED_FIELDS[claim.type].safeParse(claim.fields).success,
  {
    message: "fields outside the type's fields",
    path: ["fields"],
  },
);
export type ProjectTypedClaimArgs = z.infer<typeof ProjectTypedClaimArgs>;
const TYPED_CLAIMS_PER_FINDING = 20;
// The pipeline version code sets on a typed claim it built from a finding: no model reads an
// agent's write. Not an about-you pipeline: its tier is read as any agent record claim's.
export const TYPED_CLAIM_PIPELINE = "personal-typed-claim-1";

export const AgentRecordArgs = z
  .strictObject({
    kind: AgentRecordKind,
    body: z
      .string()
      .refine((body) => codePoints(body) >= 1 && codePoints(body) <= 8000, { message: "1 to 8 000 code points" })
      .refine((body) => !body.includes("\u0000"), { message: "a NUL" }),
    cites: z
      .array(z.union([MessageId, EventId, Handle]))
      .max(20)
      .refine((cites) => new Set(cites).size === cites.length, { message: "a cite named twice" })
      .optional()
      .describe("Ids as a tool gave them, of messages (msg_) or meetings (evt_), never refs."),
    supersedes: AgentRecordId.or(Handle)
      .describe(
        "An earlier note or finding of your own, of this kind, that this one replaces: readers' packs then show this one in its place.",
      )
      .optional(),
    requestId: RequestId,
    // The project a finding is filed under. Code checks the caller can see it; the claims' label
    // stays the record's.
    project: EntityId.or(Handle)
      .describe(
        "A finding's project, an id from search: its decisions, details and next steps go on the project's page.",
      )
      .optional(),
    // A finding's typed claims, optional, so an untyped finding still parses; the write path
    // refuses one with finding_untyped, never this contract.
    claims: z
      .array(TypedClaimShape)
      .min(1)
      .max(TYPED_CLAIMS_PER_FINDING)
      .describe(
        "A finding's facts about people and organizations other than the owner, typed; no model reads them. Each: subject exactly one of {id}, {address} or {name}, never the owner; type a role, affiliation, need, capability or another of a person's kinds, a commitment, consent, contact_rule, or a relationship between two others (the owner's own ties are propose_person's), with its fields (an entity by id); cites [{evidenceId, span}], none to rest on this finding alone (served, never believed, until the owner confirms). Each stands alone. The reply: duplicates, a fact you can see with the same value, not written again; known, the fact keys you can see per subject; refused, by index with its code (fields_invalid, subject_unknown, subject_ambiguous with candidates, subject_is_owner). With project: also project.status {status}, project.next_step {what, who, due} and project.decision {what}, subject {id} that project.",
      )
      .optional(),
  })
  .refine((args) => args.supersedes === undefined || args.kind !== "handoff", {
    message: "a handoff supersedes nothing",
    path: ["supersedes"],
  })
  .refine((args) => args.claims === undefined || args.kind === "finding", {
    message: "typed claims only on a finding",
    path: ["claims"],
  })
  // An untyped finding's project is read by a model; a typed one's project is the subject of its
  // project claims, which the write path checks claim by claim.
  .refine((args) => args.project === undefined || args.kind === "finding", {
    message: "a project only on a finding",
    path: ["project"],
  });
export type AgentRecordArgs = z.infer<typeof AgentRecordArgs>;

export const WriteAckDuplicate = z.strictObject({ claimKey: Hex64, factKey: Hex64 });
export type WriteAckDuplicate = z.infer<typeof WriteAckDuplicate>;
export const WriteAckKnown = z.strictObject({ subject: EntityId.or(Handle), factKeys: z.array(Hex64).max(200) });
export type WriteAckKnown = z.infer<typeof WriteAckKnown>;
export const WriteAckRefused = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(TYPED_CLAIMS_PER_FINDING - 1),
  code: ClaimRefusal,
  candidates: z.array(EntityId.or(Handle)).max(20).optional(),
});
export type WriteAckRefused = z.infer<typeof WriteAckRefused>;
const WriteAckClaims = {
  duplicates: z.array(WriteAckDuplicate).max(TYPED_CLAIMS_PER_FINDING).optional(),
  known: z.array(WriteAckKnown).max(TYPED_CLAIMS_PER_FINDING).optional(),
  refused: z.array(WriteAckRefused).max(TYPED_CLAIMS_PER_FINDING).optional(),
};

export const AgentRecordAck = z.strictObject({ recordId: AgentRecordId.or(Handle), ...WriteAckClaims });
export type AgentRecordAck = z.infer<typeof AgentRecordAck>;

// Read receipts. Each of the caller's own records with every other client it was shown to, by a
// pack or a tool's result, as the read log has it: the first and last time and how many results
// showed it. Ids, kinds, times and counts only; no body, no label. A receipt is labelled by the
// caller's own record shown, never by the reader's clearance. `supersededBy` is the latest live
// record of the caller's own that replaced it, down the chain of corrections, and `erased` says its
// body was removed. At most RECORD_READS_LISTED records, newest first; `more` says whether more
// matched.
export const RECORD_READS_LISTED = 20;

const RecordReader = z.strictObject({
  client: ClientName,
  firstAt: Timestamp,
  lastAt: Timestamp,
  count: z.number().int().positive(),
});

export const RecordReadsEntry = z.strictObject({
  record: AgentRecordId.or(Handle),
  kind: AgentRecordKind,
  recordedAt: Timestamp,
  supersededBy: AgentRecordId.or(Handle).nullable(),
  erased: z.boolean(),
  readers: z.array(RecordReader),
});
export type RecordReadsEntry = z.infer<typeof RecordReadsEntry>;

export const RecordReads = z.strictObject({
  records: z.array(RecordReadsEntry).max(RECORD_READS_LISTED),
  more: z.boolean(),
});
export type RecordReads = z.infer<typeof RecordReads>;

// Reading records back. `read_record` serves one whole; `find_records` the rows the caller's token
// returns, newest first, each cut to FIND_RECORDS_CHARS, superseded ones left out. `project` is
// served only to a client that holds the work view and sees that project. `kind` is one of
// AgentRecordKind's, or, for a record `read_record` opens because a fact the caller sees rests on it,
// any other kind, its body the stored JSON.
export const FIND_RECORDS_CHARS = 2000;
const count = z.number().int().nonnegative();
export const RecordRead = z
  .strictObject({
    id: AgentRecordId.or(Handle),
    kind: AgentWriteKind,
    client: ClientName,
    at: Timestamp,
    body: UntrustedString.nullable(),
    chars: count,
    cut: z.boolean(),
    removed: z.boolean(),
    masked: count.optional(),
    project: EntityId.or(Handle).optional(),
  })
  .refine((view) => !view.removed || (view.body === null && view.chars === 0 && !view.cut), {
    message: "a removed record has no body",
  });
export type RecordRead = z.infer<typeof RecordRead>;
// `more`: another row matched, or the scan stopped at its bound and more rows remain to look at.
export const RecordFind = z.strictObject({ records: z.array(RecordRead).max(FIND_RECORDS_MOST), more: z.boolean() });
export type RecordFind = z.infer<typeof RecordFind>;

// What an agent record's evidence row keeps, sealed, beside its text. `memory` is present
// exactly for a memory change (an added one: a removed one has no body and no evidence row),
// with the entry time the adapter gave, if it gave one; `turn` only for a proposal whose quote
// matched a turn.
export const AgentRecordItem = z
  .strictObject({
    recordId: AgentRecordId,
    client: ClientName,
    session: SessionId,
    kind: AgentWriteKind,
    recordedAt: Timestamp,
    cites: z.array(PersonalEvidenceId),
    memory: z.strictObject({ entryTime: Timestamp.optional(), change: z.literal("added") }).optional(),
    turn: TurnId.optional(),
    // The project a finding is filed under, as its row holds it: `project:this` resolves to it.
    project: EntityId.optional(),
  })
  .refine((item) => (item.memory !== undefined) === (item.kind === "memory_change"), {
    message: "memory exactly for a memory change",
  })
  .refine((item) => item.project === undefined || item.kind === "finding", { message: "a project only on a finding" })
  .refine((item) => item.turn === undefined || item.kind === "proposal", { message: "a turn only for a proposal" });
export type AgentRecordItem = z.infer<typeof AgentRecordItem>;

// Lens: a Mac's moments and time blocks. A meeting is the shared `transcript`. `owner_task`: the
// owner's Lens tasks. `owner_command`: a vault item holding the owner's own command's words.
export const PersonalSourceKind = z.enum([
  "agent_record",
  "screen_activity",
  "time_block",
  "owner_task",
  "owner_command",
]);
export type PersonalSourceKind = z.infer<typeof PersonalSourceKind>;
