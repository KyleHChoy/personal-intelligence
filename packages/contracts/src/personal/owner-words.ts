import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RoleName } from "./clients.ts";
import { CommitmentEnding } from "./commitment-close.ts";
import { PersonalCompartment } from "./compartments.ts";
import { GOAL_STATEMENT_MOST } from "./goal-proposals.ts";
import { CardId, EntityId, GoalId, MessageId, MoveId, OpportunityId, OwnerListId, RequestId, RulingId } from "./ids.ts";
import { LifeDomain } from "./knowledge-model.ts";
import { CardLabel, GoalKey } from "./owner.ts";
import { CardCorrection, isDeclineAnswer, OwnerNote } from "./owner-decide.ts";
import { DeclineReason, FactKeyFp } from "./primitives.ts";
import { FactId, GoalState } from "./tools-args.ts";
import { Tier } from "./warmth.ts";

// What the owner writes from their dashboard: the body of each `POST /api/<write>`. One request is
// one owner decision: no body names two cards, facts or people to rule on. Free text travels in the
// body alone, is sealed by the store and is never logged. `requestId` makes a retried request
// return the first result, as every owner write does.

const word = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
// Every control character but line feed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
// Free text of 1 to `most` code points, not only spaces, with no control character but a newline.
// The length in UTF-16 units bounds the work before the text is read code point by code point.
const words = (most: number) =>
  z
    .string()
    .max(most * 2)
    .refine((text) => {
      const length = [...text].length;
      return length >= 1 && length <= most && text.trim() !== "" && !CONTROL.test(text);
    }, `1 to ${most} code points of text`);

// The refusal of a request the "Never in a browser" list names, by route or by a forged request.
export const OwnerWebRefusal = z.enum(["not_here"]);
export type OwnerWebRefusal = z.infer<typeof OwnerWebRefusal>;

// The writes that exist (each equals one `pi` command; web-routes.ts names it).

// `pi decide`, one card: the page answers one card a request, and gives no expectation. A reason
// only on a no, as DecideArgs refuses one on any other answer.
export const DecideCardBody = z
  .strictObject({
    card: CardId,
    answer: word,
    labels: z.array(CardLabel).optional(),
    note: OwnerNote.optional(),
    reason: DeclineReason.optional(),
    compartment: PersonalCompartment.optional(),
    // An about-you card's Edit, the owner's corrected value with their confirm.
    correct: CardCorrection.optional(),
    requestId: RequestId,
  })
  .refine((body) => body.reason === undefined || isDeclineAnswer(body.answer), {
    message: "a reason on a no only",
    path: ["reason"],
  })
  .refine((body) => body.correct === undefined || body.answer === "confirm", {
    message: "a correction with a confirm only",
    path: ["correct"],
  });
export type DecideCardBody = z.infer<typeof DecideCardBody>;
// `reason`: from the closed list, the owner's alone, only on a Not useful.
export const JudgeResultBody = z
  .strictObject({
    move: MoveId,
    answer: z.enum(["keep", "not_useful", "none"]),
    reason: DeclineReason.optional(),
    requestId: RequestId,
  })
  .refine((body) => body.reason === undefined || body.answer === "not_useful", {
    message: "a reason only on a not_useful",
    path: ["reason"],
  });
export type JudgeResultBody = z.infer<typeof JudgeResultBody>;

export const CloseCommitmentBody = z.strictObject({ fact: FactId, ending: CommitmentEnding, requestId: RequestId });
export type CloseCommitmentBody = z.infer<typeof CloseCommitmentBody>;
export const FactBody = z.strictObject({ fact: FactId, requestId: RequestId });
export type FactBody = z.infer<typeof FactBody>;
export const RulingBody = z.strictObject({ ruling: RulingId, requestId: RequestId });
export type RulingBody = z.infer<typeof RulingBody>;
export const PersonBody = z.strictObject({ person: EntityId, requestId: RequestId });
export type PersonBody = z.infer<typeof PersonBody>;

export const AddGoalBody = z.strictObject({
  statement: words(GOAL_STATEMENT_MOST),
  domain: LifeDomain,
  compartment: PersonalCompartment.optional(),
  requestId: RequestId,
});
export type AddGoalBody = z.infer<typeof AddGoalBody>;
export const GoalStatusBody = z.strictObject({ goal: GoalId, status: GoalState, requestId: RequestId });
export type GoalStatusBody = z.infer<typeof GoalStatusBody>;
export const GoalTargetBody = z.strictObject({ goal: GoalId, entity: EntityId.nullable(), requestId: RequestId });
export type GoalTargetBody = z.infer<typeof GoalTargetBody>;
// `pi goal edit`: the owner's goal's statement in their new words, a `goal_reword`; undone by editing again.
export const EditGoalBody = z.strictObject({
  goal: GoalId,
  statement: words(GOAL_STATEMENT_MOST),
  requestId: RequestId,
});
export type EditGoalBody = z.infer<typeof EditGoalBody>;
// `pi goal rank`: the owner's goal placed right after another goal of theirs in its life domain, or
// first (`after` null), a `goal_rank`; undone by ranking again.
// `after` is any goal of the domain by its key, the owner's or one stated in a source.
export const RankGoalBody = z
  .strictObject({ goal: GoalId, after: GoalKey.nullable(), requestId: RequestId })
  .refine((body) => body.after !== body.goal, { message: "after another goal", path: ["after"] });
export type RankGoalBody = z.infer<typeof RankGoalBody>;
// `pi goal adopt`: a goal stated in a source, by its fact key, made the owner's own goal with one
// change: their words, a status, a target (null, none) or a place in its life domain (`after`, null first).
// Undone by `GoalBody` (`pi goal unadopt`).
export const AdoptChange = z.union([
  z.strictObject({ statement: words(GOAL_STATEMENT_MOST) }),
  z.strictObject({ status: GoalState }),
  z.strictObject({ entity: EntityId.nullable() }),
  z.strictObject({ after: GoalKey.nullable() }),
]);
export type AdoptChange = z.infer<typeof AdoptChange>;
export const AdoptGoalBody = z
  .strictObject({ fact: FactKeyFp, change: AdoptChange, requestId: RequestId })
  .refine((body) => !("after" in body.change) || body.change.after !== body.fact, {
    message: "after another goal",
    path: ["change"],
  });
export type AdoptGoalBody = z.infer<typeof AdoptGoalBody>;
export const GoalBody = z.strictObject({ goal: GoalId, requestId: RequestId });
export type GoalBody = z.infer<typeof GoalBody>;
// `pi goal hide` and `pi goal unhide`: a goal stated in a source removed from the owner's goals, and back.
export const SourceGoalBody = z.strictObject({ fact: FactKeyFp, requestId: RequestId });
export type SourceGoalBody = z.infer<typeof SourceGoalBody>;

// `one-way` is never a drop target: it is the score's word for no two-way contact.
export const RuledTier = Tier.exclude(["one-way"]);
export type RuledTier = z.infer<typeof RuledTier>;
export const SetTierBody = z.strictObject({ person: EntityId, tier: RuledTier, requestId: RequestId });
export type SetTierBody = z.infer<typeof SetTierBody>;

export const PeoplePairBody = z
  .strictObject({ a: EntityId, b: EntityId, requestId: RequestId })
  .refine((body) => body.a !== body.b, { message: "two people", path: ["b"] });
export type PeoplePairBody = z.infer<typeof PeoplePairBody>;

export const FactDomainBody = z.strictObject({ fact: FactId, domain: LifeDomain, requestId: RequestId });
export type FactDomainBody = z.infer<typeof FactDomainBody>;

// `pi facts kind`, the kind every claim of a fact's key is built under. Only an owner-side kind or
// a view, so a situation the owner reads as their opinion moves there; never a preference, whose polarity no
// ruling gives (the store's `rulable`), nor a status or a visit, whose organization, state or place
// no ruling gives.
export const RULABLE_KINDS = Object.freeze(["goal", "need", "capability", "constraint", "situation", "view"] as const);
export const FactKindBody = z.strictObject({ fact: FactId, kind: z.enum(RULABLE_KINDS), requestId: RequestId });
export type FactKindBody = z.infer<typeof FactKindBody>;

// `pi org name`: the Admin's own rule, 1 to 200 characters and no control character.
export const OrganizationNameBody = z.strictObject({
  organization: EntityId,
  name: z.string().regex(/^[^\p{Cc}]{1,200}$/u),
  requestId: RequestId,
});
export type OrganizationNameBody = z.infer<typeof OrganizationNameBody>;

export const PersonNameBody = z.strictObject({
  person: EntityId,
  name: z
    .string()
    .regex(/^[^\p{Cc}]{1,200}$/u)
    .nullable(),
  requestId: RequestId,
});
export type PersonNameBody = z.infer<typeof PersonNameBody>;

// The owner's words. The page lists none of them until the command it equals exists.

export const OWNER_WORDS_MOST = 2000;

export const OwnerNoteRole = z.enum(["note", "bio"]);
export type OwnerNoteRole = z.infer<typeof OwnerNoteRole>;
// `replaces`: an edit, the new note and the retire of the one it names, of the same person, in one
// transaction.
export const NoteAddBody = z.strictObject({
  person: EntityId,
  role: OwnerNoteRole,
  text: words(OWNER_WORDS_MOST),
  compartment: PersonalCompartment.optional(),
  replaces: FactId.optional(),
  requestId: RequestId,
});
export type NoteAddBody = z.infer<typeof NoteAddBody>;
// A note is its claim, by its key.
export const NoteRetireBody = z.strictObject({ note: FactId, requestId: RequestId });
export type NoteRetireBody = z.infer<typeof NoteRetireBody>;
// The owner's own read of a person's notes in force (`pia note list`), in the owner's words.
export const OwnerNoteView = z.strictObject({
  note: FactId,
  role: OwnerNoteRole,
  text: z.string(),
  compartments: z.array(PersonalCompartment),
  at: Timestamp,
});
export type OwnerNoteView = z.infer<typeof OwnerNoteView>;

// The store parses `value` by the fact's type's field schema before anything is written; a type with none
// takes no value. The owner's correction's claim is an `owner_command` claim of this pipeline version,
// which `settle` ranks above every claim of its fact key that states something else.
export const CORRECTION_PIPELINE = "owner_correction@1";
export const CorrectValueBody = z.strictObject({
  fact: FactId,
  value: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.unknown()),
  requestId: RequestId,
});
export type CorrectValueBody = z.infer<typeof CorrectValueBody>;

// A name is sealed and never logged.
export const OWNER_LIST_NAME_MOST = 100;
const listName = words(OWNER_LIST_NAME_MOST).refine((text) => !text.includes("\n"), { message: "one line" });
export const ListCreateBody = z.strictObject({ name: listName, requestId: RequestId });
export type ListCreateBody = z.infer<typeof ListCreateBody>;
export const ListRenameBody = z.strictObject({ list: OwnerListId, name: listName, requestId: RequestId });
export type ListRenameBody = z.infer<typeof ListRenameBody>;
export const ListMemberBody = z.strictObject({ list: OwnerListId, person: EntityId, requestId: RequestId });
export type ListMemberBody = z.infer<typeof ListMemberBody>;
export const ListBody = z.strictObject({ list: OwnerListId, requestId: RequestId });
export type ListBody = z.infer<typeof ListBody>;

// Its brief is built by code from a fixed template, these refs and the owner's note, marked as the
// owner's.
export const OwnerTaskKind = z.enum(["research", "investigate", "meeting_prep", "goal_step", "life_admin"]);
export type OwnerTaskKind = z.infer<typeof OwnerTaskKind>;
export const OwnerTaskRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), id: EntityId }),
  z.strictObject({ kind: z.literal("goal"), id: GoalId }),
  z.strictObject({ kind: z.literal("message"), id: MessageId }),
  z.strictObject({ kind: z.literal("fact"), id: FactId }),
]);
export type OwnerTaskRef = z.infer<typeof OwnerTaskRef>;
export const OwnerTaskBody = z.strictObject({
  role: RoleName,
  kind: OwnerTaskKind,
  about: z.array(OwnerTaskRef).max(10),
  note: words(OWNER_WORDS_MOST),
  requestId: RequestId,
});
export type OwnerTaskBody = z.infer<typeof OwnerTaskBody>;
export const OwnerTaskWithdrawBody = z.strictObject({ task: OpportunityId, requestId: RequestId });
export type OwnerTaskWithdrawBody = z.infer<typeof OwnerTaskWithdrawBody>;
