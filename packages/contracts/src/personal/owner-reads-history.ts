import { z } from "zod";
import { BeliefStatus } from "../belief.ts";
import { Timestamp } from "../ids.ts";
import { BeliefKind, TypedValue } from "../ontology.ts";
import { EntityId, MessageId, RulingId } from "./ids.ts";
import { BeliefTier } from "./knowledge-model.ts";
import { code, next, OWNER_PAGE_DEFAULT, OWNER_PAGE_MOST, OwnerPageArgs } from "./owner-reads-paging.ts";
import { FactKeyFp } from "./primitives.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { FactSource, FactView, Provenance, Who } from "./tools-views.ts";
import { Tier } from "./warmth.ts";

// Neither is what was true then: a belief's own times say that. `fact` is the fact key's fingerprint; a
// belief holds no text (its values are typed: ids, codes, dates, numbers), and `support` names its
// claims by their stored ids, which `factShow` opens. A subject that is the owner is `null`.
const beliefType = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
export const HISTORY_SUPPORT_MOST = 50;
export const HistoryBelief = z.strictObject({
  fact: FactKeyFp,
  kind: BeliefKind,
  type: beliefType,
  status: BeliefStatus,
  disputed: z.boolean(),
  provenance: Provenance,
  tier: BeliefTier,
  // Which kind of source its newest supporting claim still held came from; absent when none is.
  source: FactSource.optional(),
  values: z.record(z.string(), TypedValue),
  confirmedAt: Timestamp,
  support: z.array(FactId).min(1).max(HISTORY_SUPPORT_MOST),
  supportCount: z.number().int().positive(),
});
export type HistoryBelief = z.infer<typeof HistoryBelief>;
export const BeliefsAsOfArgs = OwnerPageArgs.extend({ subject: EntityId, at: Timestamp });
export type BeliefsAsOfArgs = z.infer<typeof BeliefsAsOfArgs>;
export const BeliefsAsOf = z.strictObject({
  subject: Who.nullable(),
  at: Timestamp,
  beliefs: z.array(HistoryBelief).max(OWNER_PAGE_MOST),
  next,
});
export type BeliefsAsOf = z.infer<typeof BeliefsAsOf>;

// `status` is a belief's, `retired` while a retire in force closes it, or `no_belief`; `words` the
// latest claim's text, as its source wrote it; `fact` the latest claim's id and `facts` every claim
// the row rests on, latest first; `domain` the owner's domain ruling in force or else the claim's own
// (null for none); `carried` the rulings that reach its claims by their version 1 key. `owner` is the
// owner's entity id, the `subject` they ask `beliefsAsOf` for.
export const SELF_STATUSES = Object.freeze([
  "active",
  "stale",
  "dormant",
  "expired",
  "closed",
  "retired",
  "no_belief",
] as const);
export const SelfStatus = z.enum(SELF_STATUSES);
export type SelfStatus = z.infer<typeof SelfStatus>;
export const SelfReviewArgs = OwnerPageArgs.extend({ kind: beliefType.optional(), status: SelfStatus.optional() });
export type SelfReviewArgs = z.infer<typeof SelfReviewArgs>;
// From this `use` up a line is too thin to lead, has ended or is a notice (core's useBandOf).
export const SELF_LOW_USE = 3;
export const SelfReviewRow = z.strictObject({
  n: z.number().int().positive(),
  kind: beliefType,
  status: SelfStatus,
  at: Timestamp,
  words: UntrustedString,
  source: FactSource,
  ownWords: z.boolean(),
  fact: FactId,
  facts: z.array(FactId).min(1),
  factKey: FactKeyFp,
  tier: code.nullable(),
  domain: code.nullable(),
  carried: z.array(RulingId),
  use: z.number().int().min(0).max(5),
  rank: z.number().int().positive(),
  notice: z.enum(["current", "older"]).nullable(),
});
export type SelfReviewRow = z.infer<typeof SelfReviewRow>;
export const SelfReviewPage = z.strictObject({
  owner: EntityId.nullable(),
  rows: z.array(SelfReviewRow).max(OWNER_PAGE_MOST),
  next,
});
export type SelfReviewPage = z.infer<typeof SelfReviewPage>;
// An item's `at` is the latest first-known time among its claims since then, to the millisecond;
// `waiting`, whether a card waits on one of its claims; `self`, whether it is about the owner. `subject`
// is null for the owner and for a subject that is no person or organization (a project). `claim` is the
// latest claim its belief rests on, rendered as `factShow` renders a fact, its names those the owner's
// audience sees: the item's statement in words and its subject by name, so the page reads nothing more to
// show it; null where no claim of it can be opened.
export const LearnedSinceArgs = OwnerPageArgs.extend({ at: Timestamp });
export type LearnedSinceArgs = z.infer<typeof LearnedSinceArgs>;
export const LearnedItem = z.strictObject({
  fact: FactKeyFp,
  kind: BeliefKind,
  type: beliefType,
  self: z.boolean(),
  subject: Who.nullable(),
  status: BeliefStatus,
  provenance: Provenance,
  change: z.enum(["new", "changed"]),
  at: Timestamp,
  waiting: z.boolean(),
  claim: FactView.nullable(),
});
export type LearnedItem = z.infer<typeof LearnedItem>;
export const LearnedSince = z.strictObject({
  since: Timestamp,
  items: z.array(LearnedItem).max(OWNER_PAGE_MOST),
  next,
});
export type LearnedSince = z.infer<typeof LearnedSince>;

// The term is in a POST body only, and never logged.
export const SEARCH_TERM_MOST = 100;
export const OwnerSearchArgs = z.strictObject({ term: z.string().min(1).max(SEARCH_TERM_MOST) });
export type OwnerSearchArgs = z.infer<typeof OwnerSearchArgs>;
export const OwnerSearchResult = z.strictObject({
  hits: z
    .array(z.strictObject({ who: Who, tier: Tier.nullable(), match: z.enum(["name", "address", "domain"]) }))
    .max(OWNER_PAGE_DEFAULT),
});
export type OwnerSearchResult = z.infer<typeof OwnerSearchResult>;

// A fact is its latest claim (`factShow` opens it), in the claim's own words; `subject` is null for the
// owner (`self`) and for a subject that is no person or organization. A message is its subject, masked as
// read_message masks it, and its sender's name, else address.
export const SEARCH_GROUP_MOST = 8;
export const OwnerSearchItems = z.strictObject({
  facts: z
    .array(
      z.strictObject({
        fact: FactId,
        type: z.string().min(1).max(64),
        self: z.boolean(),
        subject: Who.nullable(),
        words: UntrustedString,
        at: Timestamp,
      }),
    )
    .max(SEARCH_GROUP_MOST),
  mail: z
    .array(
      z.strictObject({
        message: MessageId,
        at: Timestamp,
        subject: UntrustedString.nullable(),
        from: UntrustedString.nullable(),
        match: z.enum(["subject", "sender"]),
      }),
    )
    .max(SEARCH_GROUP_MOST),
});
export type OwnerSearchItems = z.infer<typeof OwnerSearchItems>;
