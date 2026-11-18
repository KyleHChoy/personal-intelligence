import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { EvidenceSource } from "./evidence-reads.ts";
import { ListedGoal } from "./goals.ts";
import { Handle } from "./ids.ts";
import { LifeDomain } from "./knowledge-model.ts";
import { NextMoves } from "./next-moves.ts";
import { ShownOpenItems } from "./open-items.ts";
import { BeliefLine, CommitmentItem, CurrentStanding, NextStep, SelfSection } from "./packs.ts";
import { Hex64 } from "./primitives.ts";
import { FactId } from "./tools-args.ts";
import { MeetingView, Who } from "./tools-views.ts";
import { WarmthLine } from "./warmth.ts";

// What `context` answers. In a file of its own: it holds lines, sections and commitments (packs.ts),
// which the tools files cannot import. Every part is bounded by count here and the whole by
// CONTEXT_CODE_POINTS in the reader, for every client. Every word of a line is code's but its cite's
// phrase; nothing is a model's.

// At most three domains, three people, eight lines a person, five commitments, five goals and six
// evidence passages of 400 code points each; the whole within 32 000 code points of JSON, about
// 8 000 tokens.
export const CONTEXT_DOMAINS = 3;
export const CONTEXT_PEOPLE = 3;
export const CONTEXT_PERSON_LINES = 8;
export const CONTEXT_COMMITMENTS = 5;
export const CONTEXT_GOALS = 5;
export const CONTEXT_EVIDENCE = 6;
export const CONTEXT_PASSAGE = 400;
export const CONTEXT_CODE_POINTS = 32_000;

// A person or organization as `context` serves one: get_entity's card, shorter. `lastAt` is the
// latest mail either way, `more` says lines were cut.
export const ContextPerson = z.strictObject({
  who: Who,
  current: CurrentStanding.optional(),
  warmth: WarmthLine.optional(),
  lastAt: Timestamp.nullable(),
  nextMeeting: MeetingView.nullable(),
  nextStep: NextStep.optional(),
  lines: z.array(BeliefLine).max(CONTEXT_PERSON_LINES),
  more: z.boolean(),
});
export type ContextPerson = z.infer<typeof ContextPerson>;

// The passage a served line's first cite rests on: `fact` is the line's, `claim` the cite's (as
// get_evidence_span takes it), `cut` says the passage goes on past CONTEXT_PASSAGE.
const fingerprintOrHandle = Hex64.or(Handle);
export const ContextEvidence = z.strictObject({
  fact: fingerprintOrHandle,
  claim: FactId.or(Handle),
  source: EvidenceSource,
  passage: z.strictObject({ untrusted: z.string().max(CONTEXT_PASSAGE) }),
  cut: z.boolean(),
  masked: z.number().int().positive().optional(),
});
export type ContextEvidence = z.infer<typeof ContextEvidence>;

// `domains` are the life domains the answer was read for: `domain`'s, else those the task's words
// picked, most words first, none when it picked none (then `sections` are the most recently
// active). `more` says any part was cut.
export const ContextView = z.strictObject({
  // The few moves worth doing now, first.
  next: NextMoves.optional(),
  // What the owner owes and what is overdue.
  openItems: ShownOpenItems.optional(),
  domains: z.array(LifeDomain).max(CONTEXT_DOMAINS),
  sections: z.array(SelfSection).max(CONTEXT_DOMAINS),
  people: z.array(ContextPerson).max(CONTEXT_PEOPLE),
  commitments: z.array(CommitmentItem).max(CONTEXT_COMMITMENTS),
  goals: z.array(ListedGoal).max(CONTEXT_GOALS),
  evidence: z.array(ContextEvidence).max(CONTEXT_EVIDENCE),
  more: z.boolean(),
  // The parts this client's registration leaves out, as get_self's `withheld`: `people` and `evidence`
  // without the People view, `commitments` without the Work view, `goals` past list_goals' gate.
  withheld: z
    .array(z.enum(["people", "commitments", "goals", "evidence"]))
    .min(1)
    .optional(),
});
export type ContextView = z.infer<typeof ContextView>;
