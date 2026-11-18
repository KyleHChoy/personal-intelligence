import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ClientName, HypothesisId } from "./ids.ts";
import type { PersonalWorkTool } from "./tools.ts";
import { UntrustedString } from "./tools-args.ts";

// The idea ledger: problems and ideas the owner's agents and the planner filed, each an `idea`
// hypothesis with its evidence as it grows. No shape here has a key for a label, a compartment, a
// reader or a client: the provider sets each, and every list is of rows the reader can see.

const IDEAS_LISTED = 50;
export const OWNER_IDEAS_LISTED = 200;
const IDEA_EVIDENCE_LISTED = 20;

// What an idea's state may be: open, tested by record_test, or as the planner's idea card leaves it.
export const IdeaStatus = z.enum([
  "open",
  "supported",
  "refuted",
  "asked",
  "confirmed",
  "pursued",
  "not_now",
  "rejected",
  "expired",
  "withdrawn",
]);
export type IdeaStatus = z.infer<typeof IdeaStatus>;

// One cited item, by its kind and when it was added to the idea (null for evidence filed before
// the ledger kept the time), newest first. Never its id: the owner reads kinds and times, and an
// agent reads the idea it may add to.
const refKind = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const IdeaEvidence = z.strictObject({ kind: refKind, at: Timestamp.nullable() });

const count = z.number().int().nonnegative();
// What both reads say of one idea: when it was filed and when its newest evidence came, its state, its
// newest evidence and how many items it rests on in all.
const ideaParts = {
  filedAt: Timestamp,
  latestAt: Timestamp,
  status: IdeaStatus,
  evidence: z.array(IdeaEvidence).max(IDEA_EVIDENCE_LISTED),
  cited: count,
};

// list_ideas: the ideas the caller can see, newest evidence first, so an agent adds to one with
// propose_hypothesis (kind idea, idea: its id) rather than filing it again. `filedBy`: `you`, another
// `agent` or the `planner`. `idea` is the filer's text, null when the caller holds no key to it.
export const ListIdeasArgs = z.strictObject({
  limit: z.number().int().min(1).max(IDEAS_LISTED).optional(),
});
export type ListIdeasArgs = z.infer<typeof ListIdeasArgs>;
export const ListIdeasResult = z.strictObject({
  ideas: z
    .array(
      z.strictObject({
        id: HypothesisId,
        idea: UntrustedString.nullable(),
        filedBy: z.enum(["you", "agent", "planner"]),
        ...ideaParts,
      }),
    )
    .max(IDEAS_LISTED),
});
export type ListIdeasResult = z.infer<typeof ListIdeasResult>;

export const IDEA_ARGS = Object.freeze({ list_ideas: ListIdeasArgs } satisfies Partial<
  Record<PersonalWorkTool, z.ZodType>
>);
export const IDEA_RESULTS = Object.freeze({ list_ideas: ListIdeasResult } satisfies Partial<
  Record<PersonalWorkTool, z.ZodType>
>);

// The owner's ledger (the Work room's Ideas panel): every idea, newest evidence first. `summary` is
// the filer's text, which `pi web` puts in the owner's words; `by`, the agent that filed it by name,
// or null for the planner. `filedThisWeek`: ideas filed since Monday (UTC), the ledger's measure.
export const OwnerIdea = z.strictObject({
  id: HypothesisId,
  summary: z.string().nullable(),
  by: ClientName.nullable(),
  ...ideaParts,
});
export type OwnerIdea = z.infer<typeof OwnerIdea>;
export const OwnerIdeas = z.strictObject({
  at: Timestamp,
  filedThisWeek: count,
  ideas: z.array(OwnerIdea).max(OWNER_IDEAS_LISTED),
});
export type OwnerIdeas = z.infer<typeof OwnerIdeas>;
