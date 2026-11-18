import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { EntityId, Handle } from "./ids.ts";

// The warmth tier, a stored projection per audience that replaces tie strength. A leaf, so
// about-view.ts, packs.ts and context.ts may all import it.

// Ranked tiers by rank within the owner's own network, then `one-way` for a person with no
// two-way contact.
export const TIERS = Object.freeze(["inner", "close", "regular", "known", "outer", "one-way"] as const);
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;
// Where a tier sorts, best first; no tier sorts last.
export const tierPlace = (tier: Tier | null): number => (tier === null ? TIERS.length : TIERS.indexOf(tier));

// Whether the owner set the tier (their confirmed closeness, or their tier ruling) or the score did.
export const TierSource = z.enum(["owner", "inferred"]);
export type TierSource = z.infer<typeof TierSource>;

// The channels with two-way contact in 365 days; reported, never scored.
export const WarmthChannel = z.enum(["email", "calendar", "chat"]);
export type WarmthChannel = z.infer<typeof WarmthChannel>;

const score = z.number().nonnegative();
const share = z.number().min(0).max(1);

// One person's warmth as get_entity, context and list_people serve it. `tier` is null,
// and the numbers with it, while the audience is `rebuilding` (a removal emptied it, or it was
// never built) and when the stored row is `stale` after a lift (it holds someone no longer in the
// group the reader computes). After a merge the group is served its best-tiered member row,
// `stale` with its tier.
export const WarmthLine = z.strictObject({
  tier: Tier.nullable(),
  tierSource: TierSource.nullable(),
  dormant: z.boolean(),
  warmth: score.nullable(),
  active: score.nullable(),
  depth: score.nullable(),
  firstTwoWayAt: Timestamp.nullable(),
  lastTwoWayAt: Timestamp.nullable(),
  replyRate: share.nullable(),
  replyHours: score.nullable(),
  theyStart: share.nullable(),
  channels: z.array(WarmthChannel).max(3),
  stale: z.boolean(),
  rebuilding: z.boolean(),
});
export type WarmthLine = z.infer<typeof WarmthLine>;

// list_people: the caller's audience in tier order, then warmth. `after` is the cursor a
// page answered as `next`; a page answers `rebuilding` (and no people) while a removal has emptied
// the audience or it was never built.
export const LIST_PEOPLE_MAX = 50;
export const ListPeopleArgs = z.strictObject({
  tiers: z.array(Tier).min(1).max(TIERS.length).optional(),
  dormant: z.boolean().optional(),
  limit: z.number().int().min(1).max(LIST_PEOPLE_MAX).optional(),
  after: z.string().min(1).max(200).optional(),
});
export type ListPeopleArgs = z.infer<typeof ListPeopleArgs>;

// A name and an address come from evidence: data inside { untrusted }, the shape of tools-args.ts' UntrustedString.
const untrusted = z.strictObject({ untrusted: z.string() });
export const PeopleListEntry = z.strictObject({
  id: EntityId.or(Handle),
  name: untrusted.nullable(),
  address: untrusted.nullable(),
  warmth: WarmthLine,
});
export type PeopleListEntry = z.infer<typeof PeopleListEntry>;

export const PeopleList = z.strictObject({
  people: z.array(PeopleListEntry).max(LIST_PEOPLE_MAX),
  next: z.string().nullable(),
  rebuilding: z.boolean(),
});
export type PeopleList = z.infer<typeof PeopleList>;

// The rule table, `ontology/warmth.json`: data, versioned, the same defaults
// for every deployment and no person, sector or organization in it. Every value is provisional.
const positive = z.number().positive();
export const WarmthRules = z
  .strictObject({
    version: z.number().int().min(1),
    activeHalfLifeDays: positive,
    depthHalfLifeDays: positive,
    depthFactor: z.number().gt(0).max(1),
    oneToOneMeetingWeight: positive,
    meetingWeight: positive,
    meetingMaxAttendees: z.number().int().min(2),
    answeredThreadWeight: z.number().min(0),
    directMaxRecipients: z.number().int().min(1),
    replyWindowDays: positive,
    replyMinRuns: z.number().int().min(1),
    responsivenessWindowDays: positive,
    hysteresisDays: z.number().int().min(0),
    // Cumulative rank cuts for inner, close, regular and known; the rest are outer.
    caps: z.tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)]),
    // The fewest days in the responsiveness window on which
    // the person wrote to the owner or met them, for `inner` and for `close`; a person short of a floor
    // takes the best tier whose floor they meet.
    tierFloors: z.strictObject({ inner: z.number().int().min(0), close: z.number().int().min(0) }),
    // A chat is cut into conversations at a gap of this many
    // minutes or more, for who starts; and the answered starts one day counts, every channel.
    chatConversationGapMinutes: positive,
    answeredStartsPerDayMax: positive,
    dormantDepthRank: z.number().int().min(1),
    dormantActiveRank: z.number().int().min(1),
    pathWeights: z.strictObject({
      inner: score,
      close: score,
      regular: score,
      known: score,
      outer: score,
      "one-way": score,
    }),
  })
  .refine((rules) => rules.caps.every((cap, i) => i === 0 || cap > rules.caps[i - 1]!), {
    message: "caps must increase",
    path: ["caps"],
  })
  .refine((rules) => rules.dormantActiveRank > rules.dormantDepthRank, {
    message: "dormantActiveRank must exceed dormantDepthRank",
    path: ["dormantActiveRank"],
  });
export type WarmthRules = z.infer<typeof WarmthRules>;
