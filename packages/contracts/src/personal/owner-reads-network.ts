import { z } from "zod";
import { DateOnly } from "../ids.ts";
import { IntroOffer } from "./fact-vocabulary.ts";
import { EntityId } from "./ids.ts";
import { queryInt } from "./owner-reads-paging.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { TIERS, Tier } from "./warmth.ts";

// Ids, names, tiers, weights, kinds and fact keys only, never claim text. An edge's `fact` opens
// its claim through the person panel's own reads.
export const NetworkNode = z.strictObject({
  id: EntityId,
  kind: z.enum(["owner", "person", "organization"]),
  name: UntrustedString.nullable(),
  // An organization's first domain within the owner's audience, which calls it when it has no name.
  address: UntrustedString.optional(),
  tier: Tier.nullable(),
  dormant: z.boolean(),
  warmth: z.number().min(0).nullable(),
  // A person or an organization known by a name alone, named by someone the owner knows; and the
  // target of an active goal of the owner's.
  nameOnly: z.literal(true).optional(),
  goal: z.literal(true).optional(),
});
export type NetworkNode = z.infer<typeof NetworkNode>;
// `fact` is the claim a click opens: an observed edge has none.
const NETWORK_EDGE_KINDS = Object.freeze([
  "tie",
  "relationship",
  "acquaintance",
  "intro_offer",
  "connection",
  "affiliation",
  "reported",
  "researched",
  "shared_thread",
  "same_domain",
  "met_together",
] as const);
export const NetworkEdgeKind = z.enum(NETWORK_EDGE_KINDS);
export type NetworkEdgeKind = z.infer<typeof NetworkEdgeKind>;
export const NetworkEdge = z.strictObject({
  from: EntityId,
  to: EntityId,
  kind: NetworkEdgeKind,
  offer: IntroOffer.optional(),
  weight: z.number().min(0),
  fact: FactId.nullable(),
});
export type NetworkEdge = z.infer<typeof NetworkEdge>;
export const NETWORK_FIRST_MOST = 300;
export const NetworkArgs = z.strictObject({
  tiers: z
    .string()
    .transform((text) => text.split(","))
    .pipe(z.array(Tier).min(1).max(TIERS.length))
    .optional(),
  since: DateOnly.optional(),
  limit: queryInt(1, NETWORK_FIRST_MOST).optional(),
});
export type NetworkArgs = z.infer<typeof NetworkArgs>;
export const NetworkView = z.strictObject({
  nodes: z.array(NetworkNode).max(NETWORK_FIRST_MOST),
  edges: z.array(NetworkEdge),
  more: z.boolean(),
});
export type NetworkView = z.infer<typeof NetworkView>;
export const NetworkExpandArgs = z.strictObject({ node: EntityId });
export type NetworkExpandArgs = z.infer<typeof NetworkExpandArgs>;
export const NetworkNeighbours = z.strictObject({
  nodes: z.array(NetworkNode).max(NETWORK_FIRST_MOST),
  edges: z.array(NetworkEdge).max(NETWORK_FIRST_MOST * 4),
});
export type NetworkNeighbours = z.infer<typeof NetworkNeighbours>;
export const PathsArgs = z.strictObject({ target: EntityId, source: EntityId.optional() });
export type PathsArgs = z.infer<typeof PathsArgs>;
export const OwnerPaths = z.strictObject({
  paths: z.array(
    z.strictObject({
      nodes: z.array(NetworkNode).min(2),
      edges: z.array(NetworkEdge).min(1),
      weakest: z.number().min(0),
    }),
  ),
});
export type OwnerPaths = z.infer<typeof OwnerPaths>;
