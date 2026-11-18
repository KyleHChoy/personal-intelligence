import { z } from "zod";
import { DateOnly } from "../ids.ts";
import { AgentRecordArgs, TYPED_FIELDS } from "./agent-records.ts";
import { PreferencePolarity } from "./fact-vocabulary.ts";
import { AgentRecordId, Handle, OpportunityId, RequestId } from "./ids.ts";
import type { ClaimTier } from "./knowledge-model.ts";
import { jsonOf, parseJsonBody } from "./primitives.ts";

// What a client proposes about the owner with propose_about_you. There is no subject: the subject is the
// owner, set by code. Nothing here lets a client name a label, a compartment, an origin, a basis, a
// provenance, a channel or a tier, and the strict arguments refuse a call that carries one.

// The owner's kinds, and a role and an affiliation of the owner's, with the typed fields mail
// extraction gives them, the organization by name, so career history is no free-text situation. A body
// stored before typed key fields is one of the first six. The owner's view, an organization's status
// about the owner and a place they have been are each a kind of its own, never a situation. `goal` is
// no about-you kind (the registry's `aboutYou` flag): a goal of the owner's is propose_goal's.
// StoredAboutYouKind, with it, reads what was stored before, and names the kind a call may still give,
// so a goal is refused with its own code rather than as off-shape.
export const AboutYouKind = z.enum([
  "preference",
  "constraint",
  "situation",
  "need",
  "capability",
  "role",
  "affiliation",
  "view",
  "status",
  "visited",
]);
export type AboutYouKind = z.infer<typeof AboutYouKind>;
export const StoredAboutYouKind = z.enum(["goal", ...AboutYouKind.options]);
export type StoredAboutYouKind = z.infer<typeof StoredAboutYouKind>;
export const LegacyAboutYouKind = StoredAboutYouKind.exclude(["role", "affiliation", "view", "status", "visited"]);
export type LegacyAboutYouKind = z.infer<typeof LegacyAboutYouKind>;

const codePoints = (text: string): number => [...text].length;
const text = (most: number) =>
  z
    .string()
    .refine((value) => codePoints(value) >= 1 && codePoints(value) <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });

const what = text(500);

// Read from a stored body, never taken.
const LEGACY_FIELDS = {
  goal: z.strictObject({ what, by: DateOnly.optional() }),
  preference: z.strictObject({ what, polarity: PreferencePolarity }),
  constraint: z.strictObject({ what, until: DateOnly.optional() }),
  situation: z.strictObject({ what, until: DateOnly.optional() }),
  need: z.strictObject({ what, by: DateOnly.optional() }),
  capability: z.strictObject({ what }),
} as const satisfies Record<LegacyAboutYouKind, z.ZodType>;

// Each kind's typed fields, TYPED_FIELDS in agent-records.ts, which a typed claim on record takes
// too.
const FIELDS = TYPED_FIELDS;
const anyFields = z.union([
  FIELDS.goal,
  FIELDS.need,
  FIELDS.capability,
  FIELDS.preference,
  FIELDS.constraint,
  FIELDS.situation,
  FIELDS.role,
  FIELDS.affiliation,
  FIELDS.view,
  FIELDS.status,
  FIELDS.visited,
]);
// A situation's legacy fields are a constraint's and a need's a goal's, so four shapes parse all
// six.
const anyLegacyFields = z.union([
  LEGACY_FIELDS.goal,
  LEGACY_FIELDS.preference,
  LEGACY_FIELDS.constraint,
  LEGACY_FIELDS.capability,
]);
const kindsOwn =
  <K extends StoredAboutYouKind>(fields: Record<K, z.ZodType>) =>
  (one: { kind: K; fields: unknown }): boolean =>
    fields[one.kind].safeParse(one.fields).success;

const scope = z.enum(["all", "this_client"]);
const quote = text(1000).optional();
// An interpretation: the agent's own statement of one fact about the owner, and
// the 1 to 5 verbatim quotes of the owner's it rests on.
const INTERPRETATION_MOST = 600;
const INTERPRETATION_QUOTES_MOST = 5;
const statement = text(INTERPRETATION_MOST).optional();
const quotes = z.array(text(1000)).min(1).max(INTERPRETATION_QUOTES_MOST).optional();
const cites = AgentRecordArgs.shape.cites;

// A typed-fields body: one strict object, `fields` the kind's, and `this_client` only for a
// preference. `quote` is what the agent says the owner said, the owner's exact words; `cites` are
// record's. With `interpretation: true`, a `statement` in the agent's words and its `quotes`, and
// no `quote`; without it, neither. Older bodies of this shape still parse; a new call stores it
// only for a client-scoped preference, which builds no claim.
const TypedProposalBody = z
  .strictObject({
    kind: StoredAboutYouKind,
    fields: anyFields,
    scope,
    quote,
    interpretation: z.literal(true).optional(),
    statement,
    quotes,
    cites,
  })
  .refine(kindsOwn(FIELDS), { message: "the fields of another kind", path: ["fields"] })
  .refine((args) => args.scope === "all" || args.kind === "preference", {
    message: "this_client only with a preference",
    path: ["scope"],
  })
  .refine(
    (args) =>
      (args.interpretation === true) === (args.statement !== undefined) &&
      (args.interpretation === true) === (args.quotes !== undefined),
    {
      message: "statement and quotes with interpretation, and only with it",
      path: ["interpretation"],
    },
  )
  .refine((args) => args.interpretation !== true || args.quote === undefined, {
    message: "quotes, not quote, with interpretation",
    path: ["quote"],
  });
type TypedProposalBody = z.infer<typeof TypedProposalBody>;

// Agents state, the classifier types. A statement proposal is the agent's
// statement of one fact about the owner in its words, the owner's exact words when they said it, and
// cites; the agent lane's model, with the type guide, assigns its kind and fields, and code builds the
// claim. `kind` is the agent's hint, never trusted. Its quote may be up to five of the owner's quotes
// joined, as an interpretation's were.
const STATEMENT_QUOTE_MOST = 6000;
export const StatementProposalBody = z.strictObject({
  statement: text(INTERPRETATION_MOST),
  quote: text(STATEMENT_QUOTE_MOST).optional(),
  cites,
  kind: AboutYouKind.optional(),
});
export type StatementProposalBody = z.infer<typeof StatementProposalBody>;

// What propose_about_you takes: `statement`, `quote` and `cites`. A call in the older shape (`kind`
// and `fields`, `scope`, an interpretation's `quotes`) is still taken. From an agent, the agent API
// rewrites it as a statement call (agentCallOf): its kind a hint, its fields read only to word a
// statement when it gave none. The store still keeps a call with fields and no statement in its
// typed-fields shape, built by code, for the system's own callers and a client-scoped preference.
// One strict object: an agent's tool input schema must be an object.
export const ProposeAboutYouArgs = z
  .strictObject({
    statement: statement.describe("The fact about the owner, in your words, naming the thing and any date: one fact."),
    quote: z
      .string()
      .refine((value) => codePoints(value) >= 1 && codePoints(value) <= STATEMENT_QUOTE_MOST, {
        message: `1 to ${STATEMENT_QUOTE_MOST} code points`,
      })
      .refine((value) => !value.includes("\u0000"), { message: "a NUL" })
      .optional()
      .describe("The owner's exact words, when they said it to you."),
    cites,
    requestId: RequestId,
    kind: StoredAboutYouKind.optional().describe("Optional hint of the fact's kind; the system decides."),
    fields: anyFields.optional().describe("Deprecated: leave out, and send statement."),
    scope: scope.optional().describe("Deprecated: leave out."),
    interpretation: z.literal(true).optional().describe("Deprecated: leave out."),
    quotes: quotes.describe("Deprecated: use quote."),
  })
  .refine((args) => args.statement !== undefined || (args.kind !== undefined && args.fields !== undefined), {
    message: "a statement of the fact in your words",
    path: ["statement"],
  })
  .refine(
    (args) =>
      args.fields === undefined || (args.kind !== undefined && FIELDS[args.kind].safeParse(args.fields).success),
    { message: "the fields of another kind", path: ["fields"] },
  )
  .refine((args) => args.scope !== "this_client" || (args.kind === "preference" && args.fields !== undefined), {
    message: "this_client only with a preference",
    path: ["scope"],
  })
  .refine((args) => args.quotes === undefined || (args.interpretation === true && args.quote === undefined), {
    message: "quotes only with interpretation, and no quote",
    path: ["quotes"],
  })
  .refine(
    (args) =>
      (args.statement !== undefined && args.scope !== "this_client") ||
      args.quote === undefined ||
      codePoints(args.quote) <= 1000,
    { message: "1 to 1000 code points without a statement, or with this_client", path: ["quote"] },
  );
export type ProposeAboutYouArgs = z.infer<typeof ProposeAboutYouArgs>;

// What tools/list publishes for propose_about_you: the statement call
// alone. The deprecated keys (kind, fields, scope, interpretation, quotes) still parse
// (ProposeAboutYouArgs) but are never sent to a model, whose every call carries the schema.
export const ProposeAboutYouPublished = z.strictObject({
  statement: text(INTERPRETATION_MOST).describe(
    "The fact about the owner, in your words, naming the thing and any date: one fact.",
  ),
  quote: ProposeAboutYouArgs.shape.quote,
  cites,
  requestId: RequestId,
});
export type ProposeAboutYouPublished = z.infer<typeof ProposeAboutYouPublished>;

// A statement in words, for a call in the older shape that gave none, from its kind and fields
// alone: the system's own words, read by the classifier as the agent's.
function statementOfFields(kind: StoredAboutYouKind, fields: Readonly<Record<string, unknown>>): string {
  const word = (name: string): string => (typeof fields[name] === "string" ? (fields[name] as string) : "");
  // Its dates and its life domain, so the classifier can keep them.
  const dated = [
    ["by", "by"],
    ["until", "until"],
    ["since", "since"],
  ]
    .flatMap(([name, said]) => (word(name as string) === "" ? [] : [` ${said} ${word(name as string)}`]))
    .join("");
  const domain = word("domain") === "" ? "" : ` (${word("domain")})`;
  return `${phrased(kind, word)}${dated}${domain}`;
}
function phrased(kind: StoredAboutYouKind, word: (name: string) => string): string {
  switch (kind) {
    case "preference":
      return `The owner ${word("polarity")} ${word("object")}`;
    case "role":
      return `The owner is ${word("title")}${word("organization_name") === "" ? "" : ` at ${word("organization_name")}`}`;
    case "affiliation":
      return `The owner's affiliation with ${word("organization_name")}: ${word("relation")}`;
    default:
      return `The owner's ${kind}: ${word(STATEMENT_PHRASES[kind])}`;
  }
}
// Each kind's phrase field, as ontology/kinds.json gives it (a structure test holds the two
// together).
export const STATEMENT_PHRASES: Readonly<
  Record<Exclude<StoredAboutYouKind, "preference" | "role" | "affiliation">, string>
> = {
  goal: "objective",
  need: "object",
  capability: "object",
  constraint: "rule",
  situation: "state",
  view: "view",
  status: "process",
  visited: "place",
};

// An agent's call as the agent API passes it on. A client-scoped preference is kept as it is; every other
// call becomes a statement call, its statement the agent's own or, for an older-shape call that gave none,
// worded from its fields; an interpretation's quotes are its quote; its kind a hint (never a goal's, which is
// refused before this).
export function agentCallOf(args: ProposeAboutYouArgs): ProposeAboutYouArgs {
  if (args.scope === "this_client") return args;
  const said =
    args.statement ??
    statementOfFields(args.kind as StoredAboutYouKind, (args.fields ?? {}) as Record<string, unknown>);
  return { ...statementBody(said, args), requestId: args.requestId };
}

// A statement proposal's body: the statement, an interpretation's quotes joined as its quote, the
// cites, and the kind hint but a goal's. The one construction, for the agent API and the store.
function statementBody(statement: string, args: ProposeAboutYouArgs): StatementProposalBody {
  const quote = args.quote ?? (args.quotes === undefined ? undefined : args.quotes.join("\n\n"));
  return {
    statement: [...statement].slice(0, INTERPRETATION_MOST).join(""),
    ...(quote === undefined ? {} : { quote: [...quote].slice(0, STATEMENT_QUOTE_MOST).join("") }),
    ...(args.cites === undefined ? {} : { cites: args.cites }),
    ...(args.kind === undefined || args.kind === "goal" ? {} : { kind: args.kind }),
  };
}

// The body a call is stored as: a call with a statement is a statement proposal, its fields never read; a
// client-scoped preference and a call with only a kind and its fields keep the typed-fields shape, built by
// code, with no statement.
export function storedBodyOf(args: ProposeAboutYouArgs): ProposalBody {
  const { requestId: _request, ...rest } = args;
  if (args.statement !== undefined && args.scope !== "this_client") return statementBody(args.statement, args);
  if (args.statement === undefined) return rest as TypedProposalBody;
  const { statement: _statement, quotes: _quotes, interpretation: _interpretation, ...scoped } = rest;
  return scoped as TypedProposalBody;
}

// Whether a parsed body is a statement proposal, which no code builds a claim from
// alone: it has no fields.
export const isStatement = (body: ProposalBody): body is StatementProposalBody => !Object.hasOwn(body, "fields");
// A body's scope: a statement proposal's is `all`.
export const proposalScope = (body: ProposalBody): "all" | "this_client" => (isStatement(body) ? "all" : body.scope);

// A body stored before typed key fields, as its arguments were then.
const LegacyProposalBody = z
  .strictObject({ kind: LegacyAboutYouKind, fields: anyLegacyFields, scope, quote, cites })
  .refine(kindsOwn(LEGACY_FIELDS), { message: "the fields of another kind", path: ["fields"] })
  .refine((body) => body.scope === "all" || body.kind === "preference", {
    message: "this_client only with a preference",
    path: ["scope"],
  });
type LegacyProposalBody = z.infer<typeof LegacyProposalBody>;

// A proposal's stored body: the canonical JSON of the arguments without requestId, parsed strictly; null for
// anything else, a body that carries a requestId included. The one parser of a body, for intake, the agent lane,
// the cards and the packs. A body stored before typed key fields parses in its legacy shape, with `what`;
// `isLegacy` tells the two apart. A statement proposal parses too, and `isStatement` tells it apart.
export type ProposalBody = TypedProposalBody | LegacyProposalBody | StatementProposalBody;
export function parseProposalBody(body: string): ProposalBody | null {
  const value = jsonOf(body);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.hasOwn(value, "requestId"))
    return null;
  for (const shape of [StatementProposalBody, TypedProposalBody, LegacyProposalBody] as const) {
    const parsed = shape.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

// Whether a parsed body's or fact's fields are a legacy one's: they hold `what`, which no
// typed-fields shape has.
export const isLegacy = (one: object): boolean =>
  "fields" in one && typeof one.fields === "object" && one.fields !== null && Object.hasOwn(one.fields, "what");

// The same for every scope and route.
export const ProposeAboutYouAck = z.strictObject({ recordId: AgentRecordId.or(Handle) });
export type ProposeAboutYouAck = z.infer<typeof ProposeAboutYouAck>;

// What the owner says in reply to an owner_question opportunity, relayed verbatim by the agent that holds
// it, with answer_owner_question. `quote` is the owner's exact words; each fact is a proposal's kind and
// fields, and each fact's key phrase must be a slice of the quote. `about` is the answer's effect on the
// hypothesis the question tests; left out, it is `neither`. Nothing names a label, a scope, a subject, a
// provenance, a channel or a tier: every fact is about the owner, of scope all, and the owner's own
// statement.
const OwnerAnswerEffect = z.enum(["supports", "refutes", "neither"]);
type OwnerAnswerEffect = z.infer<typeof OwnerAnswerEffect>;

// The owner's reply may state a goal of theirs: only an agent's proposal of a goal is refused.
const OwnerAnswerFact = z
  .strictObject({ kind: StoredAboutYouKind, fields: anyFields })
  .refine(kindsOwn(FIELDS), { message: "the fields of another kind", path: ["fields"] });

// A fact of an answer stored before typed key fields.
const LegacyOwnerAnswerFact = z
  .strictObject({ kind: LegacyAboutYouKind, fields: anyLegacyFields })
  .refine(kindsOwn(LEGACY_FIELDS), { message: "the fields of another kind", path: ["fields"] });

const answer = z.strictObject({
  quote: text(8000),
  facts: z.array(OwnerAnswerFact).max(10).optional(),
  about: OwnerAnswerEffect.optional(),
});

// The agent does not choose an answer's kinds and fields: its quote is
// typed by the agent lane's model, as a statement proposal's is. `facts` still parses, whatever its
// shape, so a client that sends it is not refused, and is dropped before the store (answerOf);
// tools/list publishes the answer without it (AnswerOwnerQuestionPublished).
const sent = z.strictObject({ quote: answer.shape.quote, about: answer.shape.about });
export const AnswerOwnerQuestionArgs = z.strictObject({
  opportunity: OpportunityId.or(Handle),
  answer: sent.extend({ facts: z.unknown().optional() }),
  requestId: RequestId,
});
export type AnswerOwnerQuestionArgs = z.infer<typeof AnswerOwnerQuestionArgs>;
export const AnswerOwnerQuestionPublished = z.strictObject({
  opportunity: OpportunityId.or(Handle),
  answer: sent,
  requestId: RequestId,
});
export type AnswerOwnerQuestionPublished = z.infer<typeof AnswerOwnerQuestionPublished>;
// The answer as it reaches the store: the owner's words and their effect, never the agent's facts.
export const answerOf = (args: AnswerOwnerQuestionArgs): { quote: string; about?: OwnerAnswerEffect } => ({
  quote: args.answer.quote,
  ...(args.answer.about === undefined ? {} : { about: args.answer.about }),
});

export const AnswerOwnerQuestionAck = z.strictObject({ recordId: AgentRecordId.or(Handle) });
export type AnswerOwnerQuestionAck = z.infer<typeof AnswerOwnerQuestionAck>;

// An answer's stored body: the opportunity, the question as the store opened it (null when the
// caller's keys could not), and the answer, as canonical JSON. The one parser of a body, for
// intake and the pipeline; null for anything else. A body stored before typed key fields holds
// legacy facts. `typed`, set by the store on every new answer, says the agent lane's model types
// its quote; an older answer has none, and keeps its facts or builds no claim, so no earlier
// answer gains facts at a re-extraction.
export const OwnerAnswerBody = z.strictObject({
  opportunity: OpportunityId,
  question: z.string().nullable(),
  ...answer.shape,
  facts: z
    .array(z.union([OwnerAnswerFact, LegacyOwnerAnswerFact]))
    .max(10)
    .optional(),
  typed: z.literal(true).optional(),
});
export type OwnerAnswerBody = z.infer<typeof OwnerAnswerBody>;
export const parseOwnerAnswerBody = (body: string): OwnerAnswerBody | null => parseJsonBody(OwnerAnswerBody, body);

// Rung 0's answer for a claim taken from an agent record.
export const RestatementAnswer = z.enum(["echo", "stale", "undecided", "new"]);
export type RestatementAnswer = z.infer<typeof RestatementAnswer>;

// The pipeline versions code sets on the claims it builds from these bodies, so that a claim's tier
// is read from the claim alone. A body stored before typed key fields keeps PROPOSAL_PIPELINE, its
// answer's claims too, so its claim id, fact key and confirmation are as they were; of those, only
// an answer's claim has the basis explicit_self.
export const PROPOSAL_PIPELINE = "personal-proposal-1";
export const QUOTED_PROPOSAL_PIPELINE = "personal-proposal-quoted-1";
export const ANSWER_PIPELINE = "personal-answer-1";
export const ABOUT_YOU_PIPELINES: readonly string[] = Object.freeze([
  PROPOSAL_PIPELINE,
  QUOTED_PROPOSAL_PIPELINE,
  ANSWER_PIPELINE,
]);

// The pipeline version of the activity step, which makes the owner's activity facts by code from
// one capture item. A source claim of it is `observed`; no basis makes any other claim so.
export const ACTIVITY_PIPELINE = "lens-activity-1";
// Its four fact types, each made by code alone.
export const ACTIVITY_TYPES = Object.freeze({
  workedOn: "activity.worked_on",
  researched: "activity.researched",
  messaged: "activity.messaged",
  met: "activity.met",
} as const);
export const ACTIVITY_FACT_TYPES: readonly string[] = Object.freeze(Object.values(ACTIVITY_TYPES));

// `answered`: whether a claim is the answer from the owner to a question an agent asked them. `channelled`:
// whether it is the owner's own words relayed by an agent, a quoted proposal's or an answer's. A legacy
// answer is told by its basis.
export const answered = (claim: { pipelineVersion: string; basis: string }): boolean =>
  claim.pipelineVersion === ANSWER_PIPELINE ||
  (claim.pipelineVersion === PROPOSAL_PIPELINE && claim.basis === "explicit_self");
export const channelled = (claim: { pipelineVersion: string; basis: string }): boolean =>
  claim.pipelineVersion === QUOTED_PROPOSAL_PIPELINE ||
  claim.pipelineVersion === ANSWER_PIPELINE ||
  (claim.pipelineVersion === PROPOSAL_PIPELINE && claim.basis === "explicit_self");

export type TierSignals = {
  ownLine?: boolean;
  origin: "source" | "agent_record" | "agent_close" | "owner_command" | "agent_research";
  pipelineVersion: string;
  basis: string;
  ownerSaid: boolean;
  confirmed: boolean;
  agentConfirmed?: boolean;
  relayed?: boolean;
  notice?: boolean;
  granted?: boolean;
};
export function claimTierOf(signals: TierSignals): ClaimTier {
  if (signals.origin === "owner_command") return "owner";
  if (signals.origin === "agent_close") return "agent_closed";
  if (signals.origin === "agent_research") return "researched";
  // The owner's confirm relayed by an agent on the card, which the store gives only while the owner
  // has not answered it themselves or reopened it: their word, and nothing proves they gave it.
  if (signals.relayed === true) return "owner_relayed";
  if (signals.agentConfirmed === true) return "agent_confirmed";
  if (signals.origin === "agent_record") {
    if (!signals.confirmed) return "agent_inferred";
    // Kept by the owner's standing release, not by their answer: below every source.
    if (signals.granted === true) return "researched";
    // The answer from the owner to an agent's question counts with no card, so it ranks below what they said
    // themselves or confirmed on a card.
    if (answered(signals)) return "owner_relayed";
    return channelled(signals) ? "owner" : "owner_confirmed";
  }
  if (signals.confirmed) return "owner_confirmed";
  if (signals.ownLine === true) return "source";
  if (signals.ownerSaid) return "owner";
  if (signals.pipelineVersion === ACTIVITY_PIPELINE) return "observed";
  return signals.notice === true ? "system_notice" : "source";
}

// The fact types a notice gives in the transaction lane, besides a receipt. An organization's
// process about the owner is a `status` (never the owner's project's `project.status`), and a dated
// appointment a `plan`; a situation is no notice type. `LEGACY_NOTICE_TYPES`: what
// personal_transaction version 2, which offered a notice's status as a situation, still marks, so
// its saved calls replay and its stored notices keep their tier.
export const NOTICE_TYPES: readonly string[] = Object.freeze(["status", "plan"]);
const LEGACY_NOTICE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "2": Object.freeze(["situation"]),
});
export const noticeTypesFor = (promptVersion: string | undefined): readonly string[] => [
  ...NOTICE_TYPES,
  ...(promptVersion === undefined ? [] : (LEGACY_NOTICE_TYPES[promptVersion] ?? [])),
];

// Whether a stored claim is a system notice's: the check's `notice` mark (ClaimRecord), which code sets
// only on a source's statement of a notice type about the owner, in mail triage routed to the transaction
// lane by its own rule, with a parseable sender, never the owner's own word and never mail the system
// sent (check.ts recordOf). No model output and no client argument decides it. The mark alone, so the
// rule has one definition, the check's.
export const isSystemNotice = (record: { notice?: true | undefined }): boolean => record.notice === true;
