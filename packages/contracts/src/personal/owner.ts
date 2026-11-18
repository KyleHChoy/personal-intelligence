import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { AboutYouKind } from "./about-you.ts";
import { CardLine, LineSource } from "./card-line.ts";
import { RoleName } from "./clients.ts";
import { PersonalCompartment, RestrictedCategory } from "./compartments.ts";
import { FactsCleanDetails, LearningSwitchDetails } from "./confirm-rates.ts";
import {
  CaptureId,
  CardId,
  ClientId,
  DocumentId,
  EntityId,
  EventId,
  GoalId,
  type IdPrefix,
  MessageId,
  PageId,
  RequestId,
  RulingId,
  ULID_PATTERN,
} from "./ids.ts";
import { HarmKind } from "./learning.ts";
import { OpenItemCloseDetails, OpenItemReopenDetails } from "./open-items.ts";
import { days, word } from "./owner-fields.ts";
import { FactKeyFp, Hex64 } from "./primitives.ts";
import { ResearchDecisionDetails, ResearchSettingsPatch } from "./research.ts";
import { POLICY_ATTRIBUTION } from "./same-person.ts";
import { FactId } from "./tools-args.ts";

// The owner surface: the queue of cards, the owner's decisions, vetoes and erasure. Ids,
// kinds and times only: a card's text is sealed and printed to a terminal, never carried here.

const codePoints = (text: string): number => [...text].length;

export const PersonalRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), id: MessageId }),
  z.strictObject({ kind: z.literal("event"), id: EventId }),
  z.strictObject({ kind: z.literal("entity"), id: EntityId }),
  z.strictObject({ kind: z.literal("document"), id: DocumentId }),
  z.strictObject({ kind: z.literal("page"), id: PageId }),
  // Lens: a stored capture item.
  z.strictObject({ kind: z.literal("capture"), id: CaptureId }),
]);
export type PersonalRef = z.infer<typeof PersonalRef>;

// A ledger row: a kind that is a word, and an id of three letters, an underscore and a ULID. Never
// a one-time handle: the owner's shapes hold real ids only.
export const LedgerRef = z.strictObject({
  kind: word,
  id: z.string().regex(new RegExp(`^(?!hdl_)[a-z]{3}_${ULID_PATTERN}$`)),
});
export type LedgerRef = z.infer<typeof LedgerRef>;

// Every kind of decision the owner makes. A kind's details schema is in DECISION_DETAILS; a kind
// with none takes the empty object.
export const OwnerDecisionKind = z.enum([
  "answer",
  "veto",
  "veto_lift",
  "release",
  "erase",
  "erase_lift",
  "goal_set",
  "goal_status",
  // The owner's new words for a goal, from their accept of an agent's proposal, or `pi goal edit`.
  "goal_reword",
  // The owner's order of their goals within a life domain, `pi goal rank`. Its target
  // is the goal they placed; its details the goal it follows and the domain's whole new order.
  "goal_rank",
  // The owner's first edit, drag or retarget of a goal stated in a source makes it their own
  // goal (its target the new goal; its details the source goal's key and what they changed), and its
  // undo; the owner's removal of a goal stated in a source, hidden from their goals (its target the source
  // goal's key), and its lift. Never a belief ruling: nothing else reads them.
  "goal_adopt",
  "goal_adopt_undo",
  "goal_hide",
  "goal_hide_lift",
  "send",
  "send_settle",
  "identity",
  "identity_lift",
  "correction",
  "correction_lift",
  "fact_veto",
  "fact_veto_lift",
  "declassify",
  "declassify_revoke",
  "threshold_grant",
  "threshold_revoke",
  "threshold_target",
  "rung_resume",
  "record_release",
  "card_label",
  "silence_verdict",
  "harm",
  "harm_lift",
  "intent_confirm",
  "intent_revoke",
  "harness_grant",
  "harness_revoke",
  "combining_grant",
  "seal",
  "seal_lift",
  "retention_rule",
  "retention_forget",
  "research",
  "research_settings",
  "restriction_lift",
  "restatement_clear",
  "mention_bind",
  "mention_unbind",
  "project_add",
  "project_anchor",
  "project_unanchor",
  "project_close",
  "time_ruling",
  "time_unruling",
  "time_veto",
  "owner_address",
  // The owner's ignore list, and its lift.
  "ignore",
  "ignore_lift",
  // The answer from the owner to an owner_question opportunity, relayed verbatim by the agent that held it.
  // Written by the store with the answer; its target is the opportunity.
  "owner_answer",
  // `pi self retire`, a fact true until restated, and its lift.
  "fact_retire",
  "fact_retire_lift",
  // The owner's correction of a fact's life domain or its kind, and their lifts.
  "fact_domain",
  "fact_domain_lift",
  "fact_kind",
  "fact_kind_lift",
  // The owner's name for an organization, `pi org name`. Its target is the organization; the name
  // is in knowledge.organization_names, sealed.
  "organization_name",
  // The owner's join and split of two fact keys, `pi facts join` and `split` or a same_fact card's
  // answer, and the lift of either.
  "fact_join",
  "fact_split",
  "fact_ruling_lift",
  // The lift of the owner's confirmation of an about_you card, `pi correct lift`
  // on the confirm's ruling. It supersedes the confirm and ends the release it made.
  "confirmation_lift",
  "relay_lift",
  // The person or organization a goal is after, `pi goal target`, or none. Its
  // target is the goal; the entity is in its details.
  "goal_target",
  // A client's roles, the task tier on or off, and a gap trigger's route. Their targets are the
  // client, the task intent, and none.
  "client_roles",
  "task_tier",
  "gap_route",
  // The owner's cancel of one task; its target is the task.
  "task_cancel",
  "work_free",
  // An agent's work-notice address set or removed; its target is the client. The address is in
  // policy.client_webhooks, never in the details.
  "webhook_set",
  "webhook_removed",
  // A same-person merge the identity sweep made by the owner's standing rule,
  // written only by ledger.policy_merge. The policy's, never the owner's: nothing reads it as their answer.
  "identity_policy",
  // The role a task proposed with no role, and a gap flag whose trigger has no
  // route, go to; or none. No target.
  "default_task_role",
  "question_role",
  "title_role",
  "ping_settings",
  "auto_settings",
  "defect_role",
  // The owner's close of a commitment at their terminal (its answer the ending), their
  // reopening of a commitment, and their standing release that lets an agent's close show under the
  // commitment's own label (its answer `on` or `off`). No target.
  "commitment_close",
  "open_item_close",
  "open_item_reopen",
  "commitment_reopen",
  "close_release",
  // The owner's tier for a person (`pia people tier`; its answer the tier, the person's
  // fingerprints in knowledge.tier_rulings), and its lift (`--clear`, or a new ruling replacing
  // it). No target.
  "warmth_tier",
  "warmth_tier_lift",
  // A ruling of the owner's re-attached by code to the one claim that replaced
  // its claim at a generation raise, `pia extract carry-over --reattach`. Its details name the
  // ruling it carries and the claim. The carry's, never the owner's: nothing reads it as their answer.
  "ruling_carry",
  // A task the owner opens for their agents, and their withdrawal of it before any agent claimed
  // it. Their target is the task.
  "task_add",
  "task_withdraw",
  // The owner's note or bio about a person, `pia note add`; its target is the person, its answer
  // the note's role. The owner's words are in the note's owner_command item and claim, never in the
  // decision. A retire is a `fact_retire`.
  "note_add",
  // The owner's lists of people, `pia lists`: a list made, renamed and deleted (their target none;
  // the list's row names the decision), and a person added and removed (the person's fingerprints
  // in knowledge.owner_list_members).
  "list_create",
  "list_rename",
  "list_delete",
  "list_add",
  "list_remove",
  // The owner's Keep or Not useful on a finished task's result in the Results
  // feed, with no card; its target the move that reported, its answer `keep`, `not_useful` or
  // `none` (their Undo). A later one supersedes the last.
  "result_eval",
  // The owner's name for a person, `pia person name`: its target is the person, the name in
  // knowledge.person_names, sealed. A clear and the Undo of a name are `person_name_lift`, whose target is
  // the person and which supersedes the ruling it undid.
  "person_name",
  "person_name_lift",
  // The owner's standing release of one agent's quoted facts of one kind about them, `pia facts grant`, kept
  // without a card at the granted-release tier; its details the client and the kind, no target.
  // `release_grant_lift` (`pia facts grant-lift`) supersedes it and ends every release made under
  // it.
  "release_grant",
  "release_grant_lift",
  // The cleanup's apply, `pia facts clean --apply` (confirm rates count only answers after its first),
  // and the owner's switch for learning from one agent's proposals, its details the client and on or off.
  "facts_clean",
  "learning_switch",
]);
export type OwnerDecisionKind = z.infer<typeof OwnerDecisionKind>;

// What a retention rule is for, fixed by code from clear columns. `pi retain set` refuses
// `not_supported` every class whose expiry is not built; Lens's three capture classes are built.
export const RetentionClass = z.enum([
  "mail_held",
  "mail_sent",
  "mail_automated",
  "mail_automated_facts",
  "mail_correspondence",
  "calendar_event",
  "web_page",
  "ledger_read_log",
  "document",
  "contact",
  "agent_record",
  "capture_transcript",
  "capture_moment",
  "capture_block",
  // A Lens task, kept until the owner sets a rule. Its expiry is not built, so `pi retain set`
  // refuses it.
  "capture_task",
]);
export type RetentionClass = z.infer<typeof RetentionClass>;

// What a seal matches. Its value is kept only as a keyed fingerprint.
export const SealKind = z.enum(["address", "domain", "gmail_label", "account"]);
export type SealKind = z.infer<typeof SealKind>;

// A rule's days: a whole number from 1, or null for "kept".

const SealDecisionDetails = z.strictObject({ kind: SealKind });

const RetentionRuleDecisionDetails = z.strictObject({ class: RetentionClass, days });

// A send: the owner's two flags and the claim ids they released with --reveal, ids only.
// `releasedContacts`: the contact fields they released, by contact id, field and index, never a
// value; written only when at least one field is released, so a send that releases none has the
// shape without it.
const ReleasedContactField = z.strictObject({
  contact: z.string().regex(new RegExp(`^con_${ULID_PATTERN}$`)),
  // The fields ledger.begin_send's check accepts in a released contact ref; keep the two in step.
  field: z.enum(["phone", "organization", "title", "birthday", "link"]),
  index: z.number().int().nonnegative().nullable(),
});
const SendDecisionDetails = z.strictObject({
  firstContact: z.boolean(),
  newThread: z.boolean(),
  released: z.array(FactId),
  releasedContacts: z.array(ReleasedContactField).min(1).optional(),
});

// owner_address: the keyed fingerprint of an address the owner declares theirs in every
// compartment. Never the address.
const OwnerAddressDetails = z.strictObject({ addressFp: Hex64 });

// goal_target: the entity a goal is after, or null to clear it, and the goal's fact key when it has one, so
// the ruling is on it. `pia goal target ID --name`, when nobody holds the name, sets a target pending on
// it: `entity` null, and `named`, the owner_command item holding the name and the name's fingerprint. The
// goal's target is whoever that item's name is bound to, by the writer's next sync or by the owner's own
// `pi identity bind`; nobody while it is bound to no one.
const GoalTargetDetails = z
  .strictObject({
    entity: EntityId.nullable(),
    fact: Hex64.optional(),
    named: z.strictObject({ item: Hex64, name: Hex64 }).optional(),
  })
  .refine((one) => one.named === undefined || one.entity === null, {
    message: "a target pending on a name names no entity",
    path: ["named"],
  });

// `pi goal rank`: the goal the placed one now follows (null, first), and the domain's goals in
// their new order, first first, each once, so the order is rebuilt from the decisions alone. A goal
// is ranked by its key, the owner's own goal's id or a source goal's fact key, so a goal stated in a
// source keeps its place among the owner's without being made theirs.
export const GOAL_RANK_MOST = 1000;
export const GoalKey = z.union([GoalId, FactKeyFp]);
export type GoalKey = z.infer<typeof GoalKey>;
const GoalRankDetails = z.strictObject({
  after: GoalKey.nullable(),
  order: z
    .array(GoalKey)
    .min(1)
    .max(GOAL_RANK_MOST)
    .refine((order) => new Set(order).size === order.length, { message: "each goal once" }),
});

// The source goal a goal_adopt made the owner's, what they changed, and the goal the source
// goal followed in its life domain before (null, first), where its undo puts it back. A goal_hide
// names the source goal by its target alone.
const ADOPT_CHANGES = ["words", "status", "target", "rank"] as const;
const GoalAdoptDetails = z.strictObject({
  fact: FactKeyFp,
  change: z.enum(ADOPT_CHANGES),
  was: GoalKey.nullable(),
});

// A client's roles, sorted, each once; the task tier's switch; a gap trigger and
// the role its flags route to, or none.
export const ClientRolesDetails = z.strictObject({
  roles: z
    .array(RoleName)
    .max(16)
    .refine((list) => list.every((one, i) => i === 0 || (list[i - 1] as string) < one), {
      message: "sorted, each once",
    }),
});
export type ClientRolesDetails = z.infer<typeof ClientRolesDetails>;
const TaskTierDetails = z.strictObject({ tasks: z.enum(["on", "off"]) });
export const GapRouteDetails = z.strictObject({ trigger: word, role: RoleName.nullable() });
export type GapRouteDetails = z.infer<typeof GapRouteDetails>;
const DefaultTaskRoleDetails = z.strictObject({ role: RoleName.nullable() });

// The claim a correction rejects or a declassification admits, the fact key a fact veto closes (`via` `cleanup` when `pia facts clean --apply`
// wrote it, never learned from), and every client that may have read a revoked declassification: no cap, which would let one more client block a revocation.
const ClaimDetails = z.strictObject({ claim: FactId });
const FactVetoDetails = z.strictObject({ factKey: FactKeyFp, via: z.literal("cleanup").optional() });
// The two fact keys a join or a split names, sorted.
const FactPairDetails = z
  .strictObject({ a: FactKeyFp, b: FactKeyFp, via: z.literal("cleanup").optional() })
  .refine((pair) => pair.a < pair.b, { message: "two fact keys, sorted" });
const DeclassifyRevokeDetails = z.strictObject({
  exposed: z
    .array(ClientId)
    .refine((clients) => new Set(clients).size === clients.length, { message: "a client named twice" }),
});

// The threshold decisions' details: a point, a version, a threshold's name and value, and ids.
// Words and numbers only; the point and the name are words here, since the ladder's enums import
// this file.
const pointVersion = { point: word, version: z.number().int().positive() };
const share = z.number().min(0).max(1);
const ledgerId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${ULID_PATTERN}$`));
export const ThresholdGrantDetails = z.strictObject({
  ...pointVersion,
  name: word,
  value: share,
  source: z.enum(["proposal", "set"]),
  threshold: ledgerId("thr"),
  proposal: ledgerId("tpr").nullable(),
});
export type ThresholdGrantDetails = z.infer<typeof ThresholdGrantDetails>;
export const ThresholdRevokeDetails = z.strictObject({ threshold: ledgerId("thr") });
export type ThresholdRevokeDetails = z.infer<typeof ThresholdRevokeDetails>;
export const ThresholdTargetDetails = z.strictObject({
  ...pointVersion,
  recall: share.nullable(),
  miss: share.nullable(),
  precision: share.nullable(),
});
export type ThresholdTargetDetails = z.infer<typeof ThresholdTargetDetails>;
export const RungResumeDetails = z.strictObject({ ...pointVersion, suspension: ledgerId("rsp") });
export type RungResumeDetails = z.infer<typeof RungResumeDetails>;

// The learning decisions' details: whether a silence verdict came under 2 seconds after the sample
// was shown, the kind of a harm mark, the client's set_intent proposal an intent confirmation
// accepted, if any, and the reasoner's clearance a combining grant sets, sorted, each once.
const SilenceVerdictDetails = z.strictObject({ hurried: z.boolean() });
const HarmDetails = z.strictObject({ kind: HarmKind });
const IntentConfirmDetails = z.strictObject({
  proposal: z
    .string()
    .regex(new RegExp(`^prp_${ULID_PATTERN}$`))
    .optional(),
});
const CombiningGrantDetails = z.strictObject({
  compartments: z
    .array(PersonalCompartment)
    .min(1)
    .refine((list) => list.every((one, i) => i === 0 || (list[i - 1] as string) < one), {
      message: "sorted, each once",
    }),
});

// restriction_lift: the one category `pi restricted lift` takes off one item.
const RestrictionLiftDetails = z.strictObject({ category: RestrictedCategory });

// The basis of a same-person pair, and the details of an `identity_policy` decision.
export const IdentityBasis = z.enum(["contact", "phone", "name", "local_part"]);
export type IdentityBasis = z.infer<typeof IdentityBasis>;
// A policy merge's basis: the sweep's three and a research fill's identifier
// (`research_identifier`), which the sweep never proposes.
const MergeBasis = z.enum([...IdentityBasis.options, "research_identifier", "agent", "rule"]);
const IdentityPolicyDetails = z.strictObject({ basis: MergeBasis, ...POLICY_ATTRIBUTION });
// The client a standing release names, by its id, and the kind of fact it keeps.
const ReleaseGrantDetails = z.strictObject({ client: ClientId, kind: AboutYouKind });

// The commitment by its fact key fingerprint; for the owner's close, the retire ruling that
// closes it, and the time they say it ended.
const CommitmentCloseDetails = z.strictObject({
  factKey: Hex64,
  retire: z.string().regex(new RegExp(`^rul_${ULID_PATTERN}$`)),
  at: z.string().min(1),
});
const CommitmentReopenDetails = z.strictObject({ factKey: Hex64 });

// The ruling a carry re-attaches, and the claim it now names.
const RulingCarryDetails = z.strictObject({ from: RulingId, claim: FactId });

// The owner's `same` on two people rulings already join names the rulings between the two it affirms and,
// in `inPlaceOf`, the one on exactly the two addresses named.
const Affirmed = z.array(RulingId).min(1).max(1000);
const IdentityAffirmDetails = z.strictObject({ affirms: Affirmed, inPlaceOf: RulingId.optional() });

// The details of the owner's Not useful on a finished task.
export const ResultEvalDetails = z.strictObject({
  reason: z
    .enum(["not_worth_it", "wrong_timing", "already_handled", "wrong_person", "missing_context", "other"])
    .optional(),
});
export type ResultEvalDetails = z.infer<typeof ResultEvalDetails>;
// The details of a change to a card kind's automatic answers, a setting that no longer exists: kept
// so the decisions that set it still read.
export const AutoSettingsDetails = z.object({ kind: z.string() });
export type AutoSettingsDetails = z.infer<typeof AutoSettingsDetails>;

// Each kind's details schema. A kind with no entry takes the empty object and nothing else:
// the lifts among them, and record_release (its target is the agent record).
export const DECISION_DETAILS: Readonly<Partial<Record<OwnerDecisionKind, z.ZodType>>> = Object.freeze({
  send: SendDecisionDetails,
  result_eval: ResultEvalDetails,
  auto_settings: AutoSettingsDetails,
  correction: ClaimDetails,
  fact_veto: FactVetoDetails,
  fact_retire: FactVetoDetails,
  fact_domain: FactVetoDetails,
  fact_kind: FactVetoDetails,
  fact_join: FactPairDetails,
  fact_split: FactPairDetails,
  declassify: ClaimDetails,
  declassify_revoke: DeclassifyRevokeDetails,
  threshold_grant: ThresholdGrantDetails,
  threshold_revoke: ThresholdRevokeDetails,
  threshold_target: ThresholdTargetDetails,
  rung_resume: RungResumeDetails,
  silence_verdict: SilenceVerdictDetails,
  harm: HarmDetails,
  intent_confirm: IntentConfirmDetails,
  combining_grant: CombiningGrantDetails,
  seal: SealDecisionDetails,
  retention_rule: RetentionRuleDecisionDetails,
  research: ResearchDecisionDetails,
  research_settings: ResearchSettingsPatch,
  restriction_lift: RestrictionLiftDetails,
  owner_address: OwnerAddressDetails,
  goal_target: GoalTargetDetails,
  goal_rank: GoalRankDetails,
  goal_adopt: GoalAdoptDetails,
  client_roles: ClientRolesDetails,
  task_tier: TaskTierDetails,
  gap_route: GapRouteDetails,
  identity_policy: IdentityPolicyDetails,
  release_grant: ReleaseGrantDetails,
  learning_switch: LearningSwitchDetails,
  default_task_role: DefaultTaskRoleDetails,
  defect_role: DefaultTaskRoleDetails,
  question_role: DefaultTaskRoleDetails,
  title_role: DefaultTaskRoleDetails,
  ping_settings: z.strictObject({
    order: z
      .array(z.string().regex(/^(role|client):[a-z][a-z0-9-]{1,39}$/))
      .max(8)
      .optional(),
    datedMinutes: z.number().int().optional(),
    otherMinutes: z.number().int().optional(),
    batchHour: z.number().int().optional(),
    signalRole: z.strictObject({ kind: z.string(), role: RoleName.nullable() }).optional(),
  }),
  commitment_close: CommitmentCloseDetails,
  commitment_reopen: CommitmentReopenDetails,
  open_item_close: OpenItemCloseDetails,
  open_item_reopen: OpenItemReopenDetails,
  ruling_carry: RulingCarryDetails,
  facts_clean: FactsCleanDetails,
  identity: z.union([z.strictObject({}), IdentityAffirmDetails]),
});

// Clear, kind-specific fields: never text a person, a model or an agent wrote.
export const OwnerDecisionDetails = z.union([
  SendDecisionDetails,
  ResultEvalDetails,
  AutoSettingsDetails,
  ClaimDetails,
  FactVetoDetails,
  FactPairDetails,
  DeclassifyRevokeDetails,
  ThresholdGrantDetails,
  ThresholdRevokeDetails,
  ThresholdTargetDetails,
  RungResumeDetails,
  SilenceVerdictDetails,
  HarmDetails,
  IntentConfirmDetails,
  CombiningGrantDetails,
  SealDecisionDetails,
  RetentionRuleDecisionDetails,
  ResearchDecisionDetails,
  ResearchSettingsPatch,
  RestrictionLiftDetails,
  OwnerAddressDetails,
  GoalTargetDetails,
  GoalRankDetails,
  GoalAdoptDetails,
  ClientRolesDetails,
  TaskTierDetails,
  GapRouteDetails,
  IdentityPolicyDetails,
  DefaultTaskRoleDetails,
  CommitmentCloseDetails,
  CommitmentReopenDetails,
  OpenItemCloseDetails,
  OpenItemReopenDetails,
  RulingCarryDetails,
  IdentityAffirmDetails,
  ReleaseGrantDetails,
  FactsCleanDetails,
  LearningSwitchDetails,
  z.strictObject({}),
]);
export type OwnerDecisionDetails = z.infer<typeof OwnerDecisionDetails>;

// The owner's ruling on two addresses, or on one. `role` (a mailbox for a function, never a
// person) and `person` (one person's, whatever its shape) decide over the pinned list of
// addressKind.
export const IdentityVerdict = z.enum(["same", "different", "shared", "single", "role", "person"]);
export type IdentityVerdict = z.infer<typeof IdentityVerdict>;

// The verdicts on one address. Each is a mark of its address, and an address has one at a time.
export const ADDRESS_MARKS = ["shared", "single", "role", "person"] as const satisfies readonly IdentityVerdict[];
export type AddressMark = (typeof ADDRESS_MARKS)[number];

// What an account is. `email` is a person's address; `role`, `shared` and `bulk`
// are no person's, and make no person and no organization.
export const AccountKind = z.enum(["email", "role", "shared", "bulk"]);
export type AccountKind = z.infer<typeof AccountKind>;

// `a` and `b` are the people that hold the ruling's addresses now, or null; `b` is always null for
// a ruling on one address. Ids and times only. `by` is `policy` for a merge the sweep made by the
// owner's standing rule, with its basis; `owner` for every ruling of the owner's, with none.
export const IdentityRulingView = z
  .strictObject({
    id: RulingId,
    verdict: IdentityVerdict,
    a: EntityId.nullable(),
    b: EntityId.nullable(),
    at: Timestamp,
    liftedAt: Timestamp.nullable(),
    by: z.enum(["owner", "policy"]).default("owner"),
    basis: MergeBasis.optional(),
  })
  .refine((view) => !(ADDRESS_MARKS as readonly string[]).includes(view.verdict) || view.b === null, {
    message: "a ruling on one address names one person",
    path: ["b"],
  })
  .refine(
    (view) => (view.by === "policy") === (view.basis !== undefined) && (view.by === "owner" || view.verdict === "same"),
    {
      message: "a policy's ruling is a same with its basis, and only a policy's has a basis",
      path: ["basis"],
    },
  );
export type IdentityRulingView = z.infer<typeof IdentityRulingView>;

// What code did with an agent's proposal or finding of a fact the owner already
// answered, or whose card is open. Ids, codes and times only: the claim key, the card whose answer
// settled it or on which it waits, the answer, when, and when the owner reopened it.
export const FactSettlementId = z.string().regex(new RegExp(`^fst_${ULID_PATTERN}$`));
export type FactSettlementId = z.infer<typeof FactSettlementId>;
export const FactSettlementAnswer = z.enum(["confirmed", "rejected", "vetoed", "waiting"]);
export type FactSettlementAnswer = z.infer<typeof FactSettlementAnswer>;
export const FactSettlement = z.strictObject({
  id: FactSettlementId,
  claimKey: Hex64,
  card: CardId,
  answer: FactSettlementAnswer,
  createdAt: Timestamp,
  reopenedAt: Timestamp.nullable(),
});
export type FactSettlement = z.infer<typeof FactSettlement>;

// Why ledger.policy_merge refused a pair, writing nothing.
export const PolicyMergeRefusal = z.enum([
  "merges_off",
  "basis_absent",
  "not_established",
  "excepted",
  "suppressed",
  "owner_address",
  "not_a_person",
  "already_settled",
]);
export type PolicyMergeRefusal = z.infer<typeof PolicyMergeRefusal>;

// Why the sweep cards a same-person pair instead of merging it.
export const IdentityException = z.enum(["ruled_different", "lifted_before", "common_name", "unestablished"]);
export type IdentityException = z.infer<typeof IdentityException>;

// What an ignore ruling names, as the owner gave it, and what it is stored as: the keyed
// fingerprints of addresses, or of domains. An entity is stored as its people's addresses or its
// organization's domains, so the ruling outlives a re-derive's new ids.
export const IgnoreTarget = z.enum(["account", "entity", "domain"]);
export type IgnoreTarget = z.infer<typeof IgnoreTarget>;
export const IgnoreSubject = z.enum(["address", "domain"]);
export type IgnoreSubject = z.infer<typeof IgnoreSubject>;

// Ids, counts and times only: never an address or a domain.
export const IgnoreRulingView = z.strictObject({
  id: RulingId,
  target: IgnoreTarget,
  subject: IgnoreSubject,
  values: z.number().int().min(1),
  at: Timestamp,
  liftedAt: Timestamp.nullable(),
});
export type IgnoreRulingView = z.infer<typeof IgnoreRulingView>;

// What `pi identity reclassify` changes, as counts. `hidden`
// and `shown` are people that leave or come back to the readers; `claims` the claims that name
// them, which are never edited.
export const ReclassifyCounts = z.strictObject({
  accounts: z.number().int().min(0),
  hidden: z.number().int().min(0),
  shown: z.number().int().min(0),
  claims: z.number().int().min(0),
  committed: z.boolean(),
});
export type ReclassifyCounts = z.infer<typeof ReclassifyCounts>;

// A word, not a list: the kinds that exist are the keys of the store's CARD_KINDS.
export const CardKind = word;
export type CardKind = z.infer<typeof CardKind>;

export const CardState = z.enum(["pending", "deferred", "decided", "expired", "withdrawn"]);
export type CardState = z.infer<typeof CardState>;

export const CardLabel = z.enum(["correct", "novel", "would_act", "acted"]);
export type CardLabel = z.infer<typeof CardLabel>;

// Set by code, never taken from a client. Every run counts as the one author reasoner.
export const CardAuthor = z
  .string()
  .refine(
    (value) =>
      value === "owner" ||
      value === "reasoner" ||
      /^system:[a-z][a-z0-9_]*$/.test(value) ||
      (value.startsWith("client:") && ClientId.safeParse(value.slice(7)).success),
    {
      message: "not a card author",
    },
  );
export type CardAuthor = z.infer<typeof CardAuthor>;

// A claim, as an agent_claim card's target only. Never a PersonalRef: refs, a work tool's refs and
// a draft's basis refuse it by type.
export const ClaimRef = z.strictObject({ kind: z.literal("claim"), id: FactId });
export type ClaimRef = z.infer<typeof ClaimRef>;

const target = z.union([PersonalRef, LedgerRef, ClaimRef]).nullable();

export const NewCard = z
  .strictObject({
    id: CardId,
    requestId: RequestId,
    kind: CardKind,
    author: CardAuthor,
    options: z.array(word).min(1).max(6),
    target,
    refs: z.array(PersonalRef).max(20),
    compartments: z
      .array(PersonalCompartment)
      .min(1)
      .refine((list) => list.every((one, i) => i === 0 || (list[i - 1] as string) < one), {
        message: "sorted, each once",
      }),
    expiresAt: Timestamp.nullable(),
    // Counted from the moment the card becomes pending.
    expiresAfterDays: z.number().int().min(1).max(90).nullable(),
    caseKey: z.string().max(64).nullable(),
    run: z.string().nullable(),
    body: z
      .string()
      .refine((body) => codePoints(body) <= 2000, { message: "at most 2 000 code points" })
      .nullable(),
    bodyFrom: LineSource.nullable(),
  })
  .refine((card) => (card.body === null) === (card.bodyFrom === null), {
    message: "bodyFrom is set exactly when body is",
    path: ["bodyFrom"],
  })
  .refine((card) => card.expiresAt === null || card.expiresAfterDays === null, {
    message: "one expiry at most",
    path: ["expiresAfterDays"],
  });
export type NewCard = z.infer<typeof NewCard>;

const view = {
  id: CardId,
  kind: CardKind,
  state: CardState,
  author: CardAuthor,
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  options: z.array(word),
  target,
  refs: z.array(PersonalRef),
};

export const CardView = z.strictObject(view);
export type CardView = z.infer<typeof CardView>;

// An id an agent wrote into text the owner reads, which they should see as a name, not an id. A row
// id of these prefixes, or a fact's 64 hex characters, standing alone as a word. `pi web` puts the
// owner's words in place of each.
const NAMED_ID_PREFIXES = [
  "ent",
  "rec",
  "opp",
  "msg",
  "mov",
  "doc",
  "evt",
  "gol",
  "hdl",
  "crd",
  "rul",
] as const satisfies readonly IdPrefix[];
type NamedIdPrefix = (typeof NAMED_ID_PREFIXES)[number];
export const ID_TOKEN = new RegExp(`\\b(?:(?:${NAMED_ID_PREFIXES.join("|")})_${ULID_PATTERN}|[0-9a-f]{64})\\b`, "g");
// The words for an id the owner cannot see, or that has no name: the same for both, so they say nothing of
// which it was (invariant 6). By the id's form alone, which the text already showed.
export const NEUTRAL_WORDS: Readonly<Record<NamedIdPrefix | "fact", string>> = Object.freeze({
  ent: "someone",
  rec: "a record",
  opp: "a piece of work",
  mov: "a piece of work",
  msg: "a message",
  doc: "a document",
  evt: "a meeting",
  gol: "a goal",
  hdl: "something",
  crd: "a question",
  rul: "a ruling",
  fact: "a fact",
});
export const neutralWords = (token: string): string =>
  NEUTRAL_WORDS[(token.length === 64 ? "fact" : token.slice(0, 3)) as NamedIdPrefix | "fact"] ?? "something";
// What a named id opens on the page, where the page already opens that kind: a person's page, a
// fact, a message or a meeting. Its words are the same words the text now holds.
export const NamedOpen = z.strictObject({
  kind: z.enum(["person", "fact", "message", "meeting"]),
  id: z.string().min(1).max(80),
});
export type NamedOpen = z.infer<typeof NamedOpen>;
// The most mentions a card carries.
export const CARD_MENTIONS_MOST = 20;
export const CardMention = z.strictObject({ words: z.string().min(1), open: NamedOpen });
export type CardMention = z.infer<typeof CardMention>;

// The card as code renders it, for a terminal only. `mentions`: what its lines named by id that the owner
// can see and the page opens, set by `pi web` only.
export const CardDetail = z.strictObject({
  ...view,
  lines: z.array(CardLine),
  mentions: z.array(CardMention).max(CARD_MENTIONS_MOST).optional(),
});
export type CardDetail = z.infer<typeof CardDetail>;
