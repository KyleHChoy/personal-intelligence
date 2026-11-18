import { z } from "zod";
import { PartyId } from "./ids.ts";

// A store's ledger: playbooks, cases, silences, verifications, cards, releases and outcomes.
// The records that hold a citation, a tool, a decision point, model usage or a campaign goal
// are in runs.ts, which sits above tools.ts and models.ts, because tools.ts reads this file.

export const PlaybookId = z.enum([
  "introduction",
  "gathering",
  "intro_paths",
  "project_next_step",
  "decision_tracking",
]);
export type PlaybookId = z.infer<typeof PlaybookId>;

// What one side of one case is to the case.
export const PartyRole = z.enum(["need_side", "capability_side", "introducer", "invitee", "target", "owner"]);
export type PartyRole = z.infer<typeof PartyRole>;

// A message the reasoner proposes as part of a candidate, verified with the card and sealed like
// it. Never a consent ask: that is the fixed wording of a configured consent template. Outbound
// content, not knowledge.
export const ProposedText = z.object({
  kind: z.enum(["introduction", "invitation"]),
  recipients: z.array(PartyId).min(1),
  text: z.string().min(1),
});
export type ProposedText = z.infer<typeof ProposedText>;

// One side of a card: the claims that come from one member's private knowledge.
export const CardSideKey = z.enum(["a", "b"]);
export type CardSideKey = z.infer<typeof CardSideKey>;

// Why a run made no card.
export const SilenceReason = z.enum([
  "vetoed",
  "grant_refused",
  "no_candidate",
  "below_bar",
  "waiting_is_better",
  "conflict",
  "kill_switch",
]);
export type SilenceReason = z.infer<typeof SilenceReason>;

// A card is created in "verified", or in "held" when the verifier's model call holds it back or
// a conflict list is hit. A card over the weekly limit, and one the member holds, is "deferred".
// A matching-grant card goes to "broker_review"; the broker's approval moves it to
// "release_requested"; a refusal by an asked holder ends it in "refused"; a release of both
// sides moves it to "released", then "in_review" for the member it is addressed to.
export const CardState = z.enum([
  "verified",
  "held",
  "broker_review",
  "release_requested",
  "refused",
  "released",
  "in_review",
  "deferred",
  "approved",
  "edited",
  "rejected",
]);
export type CardState = z.infer<typeof CardState>;

export const CardAction = z.enum(["approve", "edit", "hold", "reject"]);
export type CardAction = z.infer<typeof CardAction>;

// How a member labels a card: at least one of the four.
export const CardLabelInput = z
  .strictObject({
    correct: z.boolean().optional(),
    novel: z.boolean().optional(),
    wouldAct: z.boolean().optional(),
    acted: z.boolean().optional(),
  })
  .refine((labels) => Object.values(labels).some((value) => value !== undefined), { message: "names no label" });
export type CardLabelInput = z.infer<typeof CardLabelInput>;

// --- playbooks and what wakes them ---

// What a case predicts and an outcome job checks.
export const OutcomeCheck = z.enum([
  "consent",
  "first_interaction",
  "second_interaction",
  "reported_value",
  "step_taken",
  "phase_change",
  "invitation_accepted",
  "attendance",
  "follow_on_intro",
  "introducer_agrees",
  "meeting_happens",
  "outcome_vs_expectation",
]);
export type OutcomeCheck = z.infer<typeof OutcomeCheck>;
