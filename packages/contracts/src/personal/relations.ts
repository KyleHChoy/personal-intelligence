import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { PersonalEvidenceId, RulingId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";

// Relations between claims, claim to claim, in their own table. A leaf, so about.ts, work.ts and
// ports.ts may import it.

// A claim's key, as the store keys it: 64 hex characters.
export const ClaimKey = Hex64;
export type ClaimKey = z.infer<typeof ClaimKey>;

// A closed set.
export const CLAIM_RELATION_KINDS = Object.freeze([
  "supersedes",
  "contradicts",
  "fulfils",
  "refines",
  "same_fact",
  "prevails",
] as const);
export const ClaimRelationKind = z.enum(CLAIM_RELATION_KINDS);
export type ClaimRelationKind = z.infer<typeof ClaimRelationKind>;

// Who judged a relation: a rule by its id, a model and its prompt version, or one of the owner's
// rulings by its id.
const RULE = /^rule:[a-z][a-z0-9_.-]{0,63}$/;
const MODEL = /^model:[A-Za-z0-9_./:-]{1,100}@[A-Za-z0-9_.-]{1,64}(@[1-9][0-9]{0,3})?$/;
const OWNER = /^owner:(.+)$/;
export const RelationJudge = z
  .string()
  .max(200)
  .refine((judge) => RULE.test(judge) || MODEL.test(judge) || RulingId.safeParse(OWNER.exec(judge)?.[1]).success, {
    message: "rule:<id>, model:<model>@<prompt> or owner:<ruling id>",
  });
export type RelationJudge = z.infer<typeof RelationJudge>;

// A passage a relation cites, in UTF-16 code units of its evidence's text.
const RelationPassage = z
  .strictObject({
    evidenceId: PersonalEvidenceId,
    span: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }),
  })
  .refine((passage) => passage.span.end > passage.span.start, {
    message: "a span ends after it starts",
    path: ["span"],
  });

// One relation: `from` stands in `kind` to `to` (`from` supersedes, contradicts, fulfils, refines,
// is the same fact as, or prevails over `to`). Its label is the union of both claims' labels, set by
// the store, never here. `applied` is false while its kind is in shadow.
export const ClaimRelation = z
  .strictObject({
    from: ClaimKey,
    to: ClaimKey,
    kind: ClaimRelationKind,
    judge: RelationJudge,
    passages: z.array(RelationPassage).max(20),
    applied: z.boolean(),
    judgedAt: Timestamp,
  })
  .refine((relation) => relation.from !== relation.to, { message: "a claim relates to another claim" });
export type ClaimRelation = z.infer<typeof ClaimRelation>;

// The comparisons that settle a same-tier dispute, in the order they apply.
const EVIDENCE_COMPARISONS = Object.freeze([
  "independent_sources",
  "first_hand",
  "authenticated_mail",
  "domain_matches_organization",
  "newer_statement",
] as const);
export const EvidenceComparison = z.enum(EVIDENCE_COMPARISONS);
export type EvidenceComparison = z.infer<typeof EvidenceComparison>;

const rate = z.number().min(0).max(1);
const days = z.number().int().min(1).max(365);

// The rule table, `ontology/relations.json`: data, versioned, the same defaults for every
// deployment. Every value is provisional.
export const RelationRules = z.strictObject({
  version: z.number().int().positive(),
  // When the system switches a model relation kind on and off.
  switch: z.strictObject({
    precisionMin: rate,
    // The kinds that go on with no line of the owner's, by each finding's own second-model check.
    // A kind left out stays off until the owner sets its line.
    checkedEachKinds: z.array(ClaimRelationKind),
    orderAgreementMin: rate,
    orderAgreementDays: days,
    overturnRateMax: rate,
    laterContradictionRateMax: rate,
    rateWindowDays: days,
    // Back on only after both rates stay under this fraction of their bounds for `reenableDays`.
    reenableFraction: rate,
    reenableDays: days,
  }),
  // Each comparison once, in order, and the margins they use.
  evidenceOrder: z
    .array(EvidenceComparison)
    .length(EVIDENCE_COMPARISONS.length)
    .refine((order) => new Set(order).size === order.length, { message: "each comparison once" }),
  margins: z.strictObject({
    independentSourcesWin: z.number().int().min(2),
    independentSourcesLose: z.number().int().min(1),
    newerStatementDays: days,
  }),
  // The relation step's budget per run, and its calls a UTC day (while every model kind is in
  // shadow, its calls buy only measures, never extraction's cap).
  budget: z.strictObject({
    candidatesPerSubject: z.number().int().min(1).max(200),
    callsPerRun: z.number().int().min(1).max(10_000),
    callsPerDay: z.number().int().min(0).max(100_000),
  }),
  // The dream pass's own budget a night, apart from the run and day caps new arrivals keep: its
  // model calls and its dollars (whole dollars and cents, as rule data). The source check's nightly
  // sample, stratified by belief kind and by model relation kind. And the audit: the share of a
  // switched-on kind's relations that raise an audit card to the owner, at most `auditsPerDay` a
  // day.
  dream: z.strictObject({
    callsPerNight: z.number().int().min(0).max(100_000),
    usdPerNight: z.number().min(0).max(1_000),
    sourceChecksPerNight: z.number().int().min(0).max(1_000),
    // The hot slice: beliefs code picks by what agents were served and by new evidence, checked
    // beside the sample and never counted in a kind's precision.
    hotChecksPerNight: z.number().int().min(0).max(100),
    auditShare: rate,
    auditsPerDay: z.number().int().min(0).max(100),
    // The recall audit: how many of what the closed filters dropped a stronger model reads a night,
    // and its own dollars a UTC day, within the night's.
    recallChecksPerNight: z.number().int().min(0).max(1_000),
    recallUsdPerDay: z.number().min(0).max(1_000),
  }),
});
export type RelationRules = z.infer<typeof RelationRules>;

// The relation step's closed answer for one order of a pair, `personal_claim_relations@1`.
// `relation` is a kind or `unrelated`; `from` says which of the two claims shown stands in it to
// the other (ignored for `same_fact` and `contradicts`, which read both ways); `cites` are short
// phrases copied from the passages shown, each naming its slot. Code checks every cite against the
// passages it sent and never reads anything else of the answer.
const RELATION_ANSWERS = Object.freeze([...CLAIM_RELATION_KINDS, "unrelated"] as const);
export const RelationAnswer = z.strictObject({
  relation: z.enum(RELATION_ANSWERS),
  from: z.enum(["first", "second"]),
  cites: z
    .array(
      z.strictObject({
        slot: z.enum(["first", "second"]),
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "at most 300 code points" }),
      }),
    )
    .max(6),
});
export type RelationAnswer = z.infer<typeof RelationAnswer>;

// The source check's closed answer, `personal_source_check@1`. Given a statement (a belief, or a
// model relation between two statements) and the passages its claims cite, numbered from 1:
// `supported` (the passages say it), `unsupported` (they do not say it) or `wrong` (they say
// otherwise). `cites` are short phrases copied from the passages, each naming its passage; a
// `supported` or `wrong` answer cites at least one. Code checks every cite against the passages it
// sent and reads nothing else of the answer.
export const SOURCE_CHECK_VERDICTS = Object.freeze(["supported", "unsupported", "wrong"] as const);
export const SourceCheckVerdict = z.enum(SOURCE_CHECK_VERDICTS);
export type SourceCheckVerdict = z.infer<typeof SourceCheckVerdict>;
export const SourceCheckAnswer = z.strictObject({
  verdict: SourceCheckVerdict,
  cites: z
    .array(
      z.strictObject({
        passage: z.number().int().min(1).max(20),
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "at most 300 code points" }),
      }),
    )
    .max(6),
});
export type SourceCheckAnswer = z.infer<typeof SourceCheckAnswer>;

// What a closed filter drops, by the rule that dropped it: a mailing's line no open item is made of,
// a line of any source no open item is made of, and what the commitment bar refused.
const RECALL_FILTERS = Object.freeze([
  "mail_no_deadline_word",
  "mail_says_done",
  "mail_advertises",
  "mail_restated",
  "says_time_suits",
  "says_conditional",
  "bar_not_a_promise",
  "bar_wrong_direction",
] as const);
export const RecallFilter = z.enum(RECALL_FILTERS);
export type RecallFilter = z.infer<typeof RecallFilter>;

// The recall audit's closed answer, `personal_recall_audit@1`, given numbered passages and a question it
// is not told any filter asked: `found` (the passages say what is asked, and a cite shows where) or `none`.
// Code checks every cite against the passages it sent and reads nothing else of the answer.
const RECALL_VERDICTS = Object.freeze(["found", "none"] as const);
const RecallVerdict = z.enum(RECALL_VERDICTS);
export const RecallAuditAnswer = z.strictObject({
  verdict: RecallVerdict,
  cites: z
    .array(
      z.strictObject({
        passage: z.number().int().min(1).max(20),
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "too long" }),
      }),
    )
    .max(6),
});
export type RecallAuditAnswer = z.infer<typeof RecallAuditAnswer>;

// A stored relation as the belief build reads it, by claim key: its kind, its judge, when it
// was judged and its label. Types only: the store builds them from rows it already checked.
export type BeliefRelation = {
  id: string;
  from: string;
  to: string;
  kind: ClaimRelationKind;
  judge: string;
  judgedAt: string;
  compartments: string[];
};
// One row of `policy.relation_switches`, a model kind's state for one judge (model and
// prompt version) from `at`, set by the system or by the owner's override.
export type RelationSwitchRow = {
  kind: ClaimRelationKind;
  judge: string;
  on: boolean;
  at: string;
  by: "system" | "owner";
};
