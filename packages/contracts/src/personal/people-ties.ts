import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { AgentRecordId, EntityId } from "./ids.ts";

// The closed lists and the views of what an agent may propose about the people in
// the owner's life (propose_person): how a person is tied to the owner, and a typed link between
// two people or a person and an organization. A leaf, so tools-views.ts and packs.ts both import it.

// What the person is to the owner. Provisional, the owner's to confirm.
export const TIE_RELATIONS = Object.freeze([
  "family",
  "partner",
  "friend",
  "mentor",
  "colleague",
  "classmate",
  "investor",
  "client",
  "other",
] as const);
export const TieRelation = z.enum(TIE_RELATIONS);
export type TieRelation = z.infer<typeof TieRelation>;

// How close: `inner` ranks above any mail-derived tie, `dormant` below every other.
export const CLOSENESS = Object.freeze(["inner", "active", "dormant"] as const);
export const Closeness = z.enum(CLOSENESS);
export type Closeness = z.infer<typeof Closeness>;

// A typed link, read "subject <kind> other": the subject introduced the other to the owner, works
// with, is family or a friend of, invested in, advises, reports to the other. The three symmetric
// kinds are one fact for a pair whichever way they are given; `knows`, the two know each other, is
// symmetric too.
export const CONNECTION_KINDS = Object.freeze([
  "introduced",
  "works_with",
  "family_of",
  "friend_of",
  "invested_in",
  "advises",
  "reports_to",
  "knows",
] as const);
export const ConnectionKind = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof ConnectionKind>;
export const SYMMETRIC_CONNECTIONS: readonly ConnectionKind[] = Object.freeze([
  "works_with",
  "family_of",
  "friend_of",
  "knows",
]);

// The claim types code builds from a proposal (no prompt lists them, and no model makes them): a
// person the owner knows who is not yet in the system (about the owner, so it names no entity
// until the owner confirms it), a person's tie to the owner, and a typed link. None builds a belief.
export const KNOWN_PERSON_TYPE = "known_person";
export const OWNER_TIE_TYPE = "owner_tie";
export const CONNECTION_TYPE = "connection";
export const PERSON_PROPOSAL_TYPES: readonly string[] = Object.freeze([
  KNOWN_PERSON_TYPE,
  OWNER_TIE_TYPE,
  CONNECTION_TYPE,
]);

// get_entity's two parts, from the owner's confirmed facts alone (a released claim in force): the
// person's tie to the owner, and each typed link the person is in, `direction` saying whether the
// person is its subject (`out`), its other (`in`) or either (a symmetric kind, `both`). `record`
// names the agent record the fact came from, when the caller's token reads it; `at` is when it was
// proposed.
export const PERSON_CONNECTIONS = 10;
export const OwnerTieView = z.strictObject({
  relation: TieRelation,
  closeness: Closeness,
  tier: z.literal("owner_confirmed"),
  record: AgentRecordId.nullable(),
  at: Timestamp,
});
export type OwnerTieView = z.infer<typeof OwnerTieView>;
export const ConnectionView = z.strictObject({
  kind: ConnectionKind,
  other: EntityId,
  direction: z.enum(["out", "in", "both"]),
  inferred: z.boolean(),
  tier: z.literal("owner_confirmed"),
  record: AgentRecordId.nullable(),
  at: Timestamp,
});
export type ConnectionView = z.infer<typeof ConnectionView>;
