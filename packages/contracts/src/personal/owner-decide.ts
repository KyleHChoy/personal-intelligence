import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { PersonalCompartment } from "./compartments.ts";
import { CardId, EntityId, OpportunityId, RequestId, RulingId } from "./ids.ts";
import { CardLabel } from "./owner.ts";
import { word } from "./owner-fields.ts";
import { DeclineReason } from "./primitives.ts";

// The most code points of an owner's note on a decision.
const OWNER_NOTE_MOST = 300;
// One line of 1 to 300 code points, with no control character, and not only spaces.
export const OwnerNote = z
  .string()
  .refine(
    (text) =>
      [...text].length >= 1 && [...text].length <= OWNER_NOTE_MOST && text.trim() !== "" && !/\p{Cc}/u.test(text),
    {
      message: "one line of 1 to 300 code points",
    },
  );
export type OwnerNote = z.infer<typeof OwnerNote>;

// The card kinds whose answers take a reason, and those answers: an opportunity's no_go, an idea's
// no and a finding's dismiss, and the owner's reject of a question or of an agent's goal proposal. Every
// other kind and answer refuses one.
export const DECLINE_ANSWERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  opportunity_decision: Object.freeze(["no_go"]),
  idea: Object.freeze(["no"]),
  owner_question: Object.freeze(["reject"]),
  goal_proposal: Object.freeze(["reject"]),
  // The owner's dismiss of a finding on its outcome card, where that dismiss is their no on the opportunity
  // (see declineAnswersOfCard).
  outcome: Object.freeze(["dismiss"]),
});
const DECLINE_WORDS: ReadonlySet<string> = new Set(Object.values(DECLINE_ANSWERS).flat());
// The answers of a card kind that take a reason, none for a kind with none.
export const declineAnswersOf = (kind: string): readonly string[] =>
  Object.hasOwn(DECLINE_ANSWERS, kind) ? (DECLINE_ANSWERS[kind] ?? []) : [];
// The answers of one card that take a reason: what a page or command offers on a card it shows, in
// place of declineAnswersOf, which knows only the kind. An outcome card's dismiss takes one only on
// a handed opportunity, where it writes the owner's no_go and the reason is that event's code; the outcome
// of a move's report writes no status event, so there is nothing to carry a reason.
export const declineAnswersOfCard = (card: { kind: string; target: { kind: string } | null }): readonly string[] =>
  card.kind === "outcome" && card.target?.kind !== "opportunity" ? [] : declineAnswersOf(card.kind);
// Whether an answer of some kind takes a reason: what a command checks before it knows the card's
// kind.
export const isDeclineAnswer = (answer: string): boolean => DECLINE_WORDS.has(answer);

// `expect` is the owner's expectation on a go: from 0 to 1, at most two decimals, on one card only. Which
// answer and card kind take it is the store's rule. An about-you card's Edit, the owner's corrected value
// in the one field its kind takes, given with their confirm. The store parses the value by its field.
export const CardCorrection = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.string())
  .refine((value) => Object.keys(value).length === 1, { message: "one field" });
export type CardCorrection = z.infer<typeof CardCorrection>;

export const DecideArgs = z
  .strictObject({
    cards: z
      .array(CardId)
      .min(1)
      .max(25)
      .refine((cards) => new Set(cards).size === cards.length, { message: "a card named twice" }),
    answer: word,
    labels: z.array(CardLabel).optional(),
    expect: z
      .number()
      .min(0)
      .max(1)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, { message: "at most two decimals" })
      .optional(),
    // The owner's own one-line note on their answer, sealed with the decision, for the planner to
    // learn from.
    note: OwnerNote.optional(),
    // Why the owner said no, a code from the closed list, on a no only.
    reason: DeclineReason.optional(),
    // Where an accepted goal proposal's added goal is sealed, the owner's choice; the store
    // takes it on a goal_proposal card's accept of an add alone.
    compartment: PersonalCompartment.optional(),
    // With a confirm of one about-you card, the owner's corrected value.
    correct: CardCorrection.optional(),
    requestId: RequestId,
  })
  .refine((args) => args.correct === undefined || (args.cards.length === 1 && args.answer === "confirm"), {
    message: "a correction with a confirm of one card",
    path: ["correct"],
  })
  .refine((args) => args.expect === undefined || args.cards.length === 1, {
    message: "an expectation on one card only",
    path: ["expect"],
  })
  .refine((args) => args.reason === undefined || DECLINE_WORDS.has(args.answer), {
    message: "a reason on a no only",
    path: ["reason"],
  })
  .refine((args) => args.compartment === undefined || args.cards.length === 1, {
    message: "a compartment on one card only",
    path: ["compartment"],
  });
export type DecideArgs = z.infer<typeof DecideArgs>;

// The owner's Done (`acknowledge`) or Drop (`dismiss`) on work handed to them, by the work, answered on its
// outcome card, which is raised for it when none is live. A reason with a Drop only.
export const DecideHandedArgs = z
  .strictObject({
    opportunity: OpportunityId,
    answer: z.enum(["acknowledge", "dismiss"]),
    note: OwnerNote.optional(),
    reason: DeclineReason.optional(),
    requestId: RequestId,
  })
  .refine((args) => args.reason === undefined || args.answer === "dismiss", {
    message: "a reason on a drop only",
    path: ["reason"],
  });
export type DecideHandedArgs = z.infer<typeof DecideHandedArgs>;

export const VetoArgs = z
  .strictObject({ entity: EntityId.optional(), kind: word.optional() })
  .refine((args) => args.entity !== undefined || args.kind !== undefined, { message: "an entity or a kind" });
export type VetoArgs = z.infer<typeof VetoArgs>;

// `entity` is the entity that holds one of the veto's fingerprints now, or null.
export const VetoView = z.strictObject({
  id: RulingId,
  subject: z.enum(["person", "organization", "any"]),
  entity: EntityId.nullable(),
  kind: word.nullable(),
  at: Timestamp,
});
export type VetoView = z.infer<typeof VetoView>;
