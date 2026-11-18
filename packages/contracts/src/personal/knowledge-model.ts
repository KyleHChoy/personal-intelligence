import { z } from "zod";
import { PersonalCompartment } from "./compartments.ts";
import { ULID_PATTERN } from "./ids.ts";
import { Hex64 } from "./primitives.ts";

// Code sets every one of them; a model may propose a domain, and code checks it is on this list.

// Changing it means another re-extraction.
export const LIFE_DOMAINS = Object.freeze([
  "career",
  "ventures",
  "education",
  "money",
  "health",
  "family",
  "relationships",
  "faith",
  "home",
  "travel",
  "interests",
  "admin",
] as const);
export const LifeDomain = z.enum(LIFE_DOMAINS);
export type LifeDomain = z.infer<typeof LifeDomain>;

// `value` names a field this table adds that is not in the key; the kinds' other value fields stay
// as the ontology has them.
type KeyFields = { readonly phrase: string; readonly key: readonly string[]; readonly value?: readonly string[] };
export const KEY_FIELDS = Object.freeze({
  goal: { phrase: "objective", key: ["domain", "objective"] },
  need: { phrase: "object", key: ["domain", "object"] },
  capability: { phrase: "object", key: ["domain", "object"] },
  preference: { phrase: "object", key: ["domain", "object", "polarity"] },
  constraint: { phrase: "rule", key: ["domain", "rule"] },
  situation: { phrase: "state", key: ["domain", "state"], value: ["momentary"] },
  // A status's and a visit's domain is a value: one read as admin and one as travel are one fact. A key field
  // that is text and not the phrase (a status's organization) is normalized into the key as the phrase is.
  view: { phrase: "view", key: ["domain", "topic"], value: ["view"] },
  status: { phrase: "process", key: ["organization_name", "process"], value: ["domain", "state", "since"] },
  visited: { phrase: "place", key: ["place"], value: ["domain", "when"] },
} as const satisfies Record<string, KeyFields>);
export type OwnerSideKind = keyof typeof KEY_FIELDS;

// `agent_inferred` is never in a belief, so a belief's tier, its best supporting claim's, is never it. `owner_relayed`:
// the answer from the owner to a question, relayed by the agent that asked them: nothing proves they spoke, so it ranks
// below what they confirmed on a card and above everything that is not their word. `observed`: what the owner's own
// capture shows they did, made by code. `system_notice`: what an automated notice in the owner's own mail says of them
// (a status or an appointment), below every tier of their own word and above another's statement. `researched`: a fact
// an explore task's fill wrote, released by the owner's standing release: below every source, so any source outranks it,
// and it can be a belief's tier. It is the one granted-release tier, the grant kept as metadata: a fact an agent quoted
// the owner on and their standing release kept without a card takes it too, never `owner`; no further tier for a
// release. `agent_closed`: an agent's close of a commitment, below every source and above an unconfirmed agent claim:
// never the owner's word. A belief's tier is never it, since a close counts only beside the claim it closes, whose tier
// ranks above. `agent_confirmed`: an agent's claim a second agent confirmed on its card and the owner has not answered:
// the lowest tier a belief can take, below every source and every release, and never the owner's word. Their own answer
// on the card, or their reopen, lifts it.
export const ClaimTier = z.enum([
  "owner",
  "owner_confirmed",
  "owner_relayed",
  "observed",
  "system_notice",
  "source",
  "researched",
  "agent_confirmed",
  "agent_closed",
  "agent_inferred",
]);
export type ClaimTier = z.infer<typeof ClaimTier>;
export const BeliefTier = ClaimTier.exclude(["agent_inferred", "agent_closed"]);
export type BeliefTier = z.infer<typeof BeliefTier>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// Pure: the phrase that renders a claim's fact, from its type and typed fields. An owner-side
// kind's key phrase when it has one, else the legacy `what` (a claim made before key fields, or a
// type with no key phrase), else undefined.
export function keyPhraseOf(type: string, fields: Readonly<Record<string, unknown>>): string | undefined {
  const kind = Object.hasOwn(KEY_FIELDS, type) ? KEY_FIELDS[type as OwnerSideKind] : undefined;
  return (kind === undefined ? undefined : text(fields[kind.phrase])) ?? text(fields.what);
}

// A `join` groups them in every audience that sees both, whatever any model says; a `split` keeps
// them apart and vetoes the model's pairing.
export const FactRulingVerdict = z.enum(["join", "split"]);
export type FactRulingVerdict = z.infer<typeof FactRulingVerdict>;

// `off` runs no sweep; `shadow` raises a card for every pair and groups nothing without the owner's
// ruling; `apply` groups a pair in the accept band with no card.
export const GroupingMode = z.enum(["off", "shadow", "apply"]);
export type GroupingMode = z.infer<typeof GroupingMode>;

// `joined` and `split` are the owner's rulings on the pair, which outrank the band.
export const GroupingBand = z.enum(["accept", "middle", "reject"]);
export type GroupingBand = z.infer<typeof GroupingBand>;
export const GroupingState = z.enum(["proposed", "accepted", "rejected", "joined", "split"]);
export type GroupingState = z.infer<typeof GroupingState>;

const sortedOnce = (list: readonly string[]): boolean =>
  list.every((one, i) => i === 0 || (list[i - 1] as string) < one);

// `audience` is the sorted compartments of the audience that sees both keys; `keys` the two fact key fingerprints,
// sorted; `rung` the rung that answered (0 code, 1 the decide model, 2 the extract model, 4 the owner's card); `calls`
// the saved model calls it rests on (`vault.decision_calls` ids), none for rung 0. Ids, fingerprints and closed words
// only: no phrase.
export const FactGrouping = z.strictObject({
  audience: z.array(PersonalCompartment).min(1).refine(sortedOnce, { message: "sorted, each once" }),
  keys: z.tuple([Hex64, Hex64]).refine(([a, b]) => a < b, { message: "two keys, sorted" }),
  band: GroupingBand,
  rung: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
  state: GroupingState,
  calls: z.array(z.string().regex(new RegExp(`^dcc_${ULID_PATTERN}$`))).max(4),
});
export type FactGrouping = z.infer<typeof FactGrouping>;

export const FACT_GROUP_MAX = 5;
export const PAIR_KEYS = 10;
export const PAIR_CALLS_PER_RUN = 100;
export const SAME_FACT_CARDS_PER_DAY = 5;

export const SectionDomain = z.union([LifeDomain, z.literal("unsorted")]);
export type SectionDomain = z.infer<typeof SectionDomain>;

// Five people a section.
export const SELF_SECTION_LINES = 10;
export const SELF_SECTION_PEOPLE = 5;
