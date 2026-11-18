import { z } from "zod";
import { BeliefStatus } from "../belief.ts";
import { Timestamp } from "../ids.ts";
import { BeliefKind } from "../ontology.ts";
import { PersonalCompartment } from "./compartments.ts";
import { EntityId, Handle } from "./ids.ts";
import { BeliefTier, ClaimTier, LifeDomain } from "./knowledge-model.ts";
import { Hex64 } from "./primitives.ts";
import { RelationId } from "./relation-reports.ts";
import { ClaimKey, ClaimRelationKind, RelationJudge } from "./relations.ts";
import { SubjectKind } from "./subjects.ts";

// The belief computed when asked, the `about` read's arguments and parts and the key of a saved
// value. A leaf: agent-records.ts, work.ts and about-view.ts import it, and it imports nothing of the tools. The read's
// result, `AboutView`, is in about-view.ts, which imports the shapes of packs.ts and the tools it holds.

const codePoints = (text: string): number => [...text].length;
const count = z.number().int().min(0);

// A subject named by exactly one of an entity id, an address or a name: never
// guessed from one string. `about` and a typed claim (agent-records.ts) take it alike.
export const SubjectRef = z.union([
  z.strictObject({ id: EntityId.or(Handle) }),
  z.strictObject({
    address: z
      .string()
      .min(3)
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/, { message: "an address" }),
  }),
  z.strictObject({
    name: z
      .string()
      .refine((name) => codePoints(name) >= 1 && codePoints(name) <= 200, { message: "1 to 200 code points" })
      .refine((name) => !name.includes("\u0000"), { message: "a NUL" }),
  }),
]);
export type SubjectRef = z.infer<typeof SubjectRef>;

// The areas, named groups of belief kinds and life domains. They narrow and never unlock.
// Their contents are data, `ontology/areas.json` (AreaTable); their names are closed here.
export const AREAS = Object.freeze(["self", "work", "needs", "ties", "rules", "activity"] as const);
export const Area = z.enum(AREAS);
export type Area = z.infer<typeof Area>;

export const AreaTable = z
  .strictObject({
    version: z.number().int().positive(),
    areas: z.record(
      Area,
      z.strictObject({ kinds: z.array(BeliefKind).min(1), domains: z.array(LifeDomain).min(1).optional() }),
    ),
  })
  .refine((table) => AREAS.every((area) => Object.hasOwn(table.areas, area)), { message: "every area once" })
  .refine((table) => Object.values(table.areas).every((one) => new Set(one.kinds).size === one.kinds.length), {
    message: "a kind named twice in an area",
  });
export type AreaTable = z.infer<typeof AreaTable>;

export const AboutArgs = z.strictObject({
  subject: SubjectRef.describe("Who: exactly one of { id } as search gave it, { address } or { name }."),
  areas: z
    .array(Area)
    .min(1)
    .max(AREAS.length)
    .refine((areas) => new Set(areas).size === areas.length, { message: "each area once" })
    .describe("Narrow to these areas; default all.")
    .optional(),
  asOf: Timestamp.describe("Answer as of this instant; default now.").optional(),
  after: z
    .string()
    .min(1)
    .max(200)
    .describe("The `next` token a page answered, for more supporting claims.")
    .optional(),
});
export type AboutArgs = z.infer<typeof AboutArgs>;

// Text from evidence is data inside { untrusted }, the shape of tools-args.ts' UntrustedString.
const untrusted = z.strictObject({ untrusted: z.string() });
// Provenance's values, as tools-views.ts has them.
const provenance = z.enum(["source", "agent_reported", "corroborated", "owner"]);

// One claim cited: its id (`fact`, what get_evidence_span takes, which expands it to its evidence and
// passage), who said it, when, the span it rests on, its tier. `type` and `fields` are its own for a
// claim that builds no belief; a supporting claim's value is its belief's. One id per claim, which
// handles translate for a session client: no claim key and no evidence id, which no handle kind stands
// for.
export const CitedClaim = z.strictObject({
  fact: Hex64.or(Handle),
  speaker: EntityId.or(Handle).nullable(),
  at: Timestamp,
  span: z.strictObject({ start: count, end: count }).nullable(),
  tier: ClaimTier,
});
export type CitedClaim = z.infer<typeof CitedClaim>;

// A relation that applied, by its id (what report_wrong_relation takes), between two claims by their
// ids (`fact`), as their citations name them: one of the belief's own, and one the caller may be cited.
export const AppliedRelation = z.strictObject({
  id: RelationId,
  from: Hex64.or(Handle),
  to: Hex64.or(Handle),
  kind: ClaimRelationKind,
  judge: RelationJudge,
});
export type AppliedRelation = z.infer<typeof AppliedRelation>;

// One fact key's belief, with its dispute marks, under the caller's clearance as of
// `asOf`. `settledBy` names how an applied `prevails` chose the value (null with none); `disputed`
// stays true when one did. `support` is inline up to SUPPORT_INLINE, `supportCount` counts the
// visible supporting claims.
export const SUPPORT_INLINE = 200;
export const BeliefAt = z.strictObject({
  kind: BeliefKind,
  factKey: Hex64.or(Handle),
  value: z.record(z.string(), z.unknown()),
  status: BeliefStatus,
  tier: BeliefTier,
  provenance,
  disputed: z.boolean(),
  settledBy: z.enum(["rule", "model", "agent"]).nullable(),
  // A source check found this belief's own passages do not support it.
  unsupported: z.literal(true).optional(),
  independentSources: count,
  // The canonical claim, by its id (`fact`), as its citation names it.
  canonical: Hex64.or(Handle),
  support: z.array(CitedClaim).max(SUPPORT_INLINE),
  supportCount: count,
  relations: z.array(AppliedRelation),
  asOf: Timestamp,
});
export type BeliefAt = z.infer<typeof BeliefAt>;

// A claim that builds no belief (an unbelieved kind, or tier agent_inferred), cited alike.
export const UnbelievedClaim = CitedClaim.extend({
  type: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
});
export type UnbelievedClaim = z.infer<typeof UnbelievedClaim>;

// A name matching several within the caller's clearance answers the candidates and why each
// matched, and builds nothing: by the name it is served by, by another alias of its own, or by an
// address several people hold.
export const AboutCandidate = z.strictObject({
  id: EntityId.or(Handle),
  kind: SubjectKind,
  name: untrusted.nullable(),
  matched: z.enum(["name", "alias", "address"]),
});
export type AboutCandidate = z.infer<typeof AboutCandidate>;

// The key of a saved derived value, which is never served when any part differs.
export const InputKey = z.strictObject({
  clearance: z
    .array(PersonalCompartment)
    .min(1)
    .refine((list) => list.every((one, index) => index === 0 || list[index - 1]! < one), {
      message: "sorted, each once",
    }),
  claimKeys: z.array(ClaimKey).refine((list) => list.every((one, index) => index === 0 || list[index - 1]! < one), {
    message: "sorted, each once",
  }),
  generation: count,
  rulingSeq: count,
  erasureSeq: count,
  rulesVersion: z.number().int().positive(),
  model: z.strictObject({ model: z.string().min(1).max(100), prompt: z.string().min(1).max(64) }).optional(),
});
export type InputKey = z.infer<typeof InputKey>;
