import { z } from "zod";
import { AgentRecordArgs } from "./agent-records.ts";
import { AgentRecordId, EntityId, Handle, RequestId } from "./ids.ts";
import { Closeness, ConnectionKind, TieRelation } from "./people-ties.ts";
import { jsonOf } from "./primitives.ts";

// What a client proposes about the people in the owner's life with propose_person,
// inert until the owner confirms it on a card. Nothing here names a label, a compartment, a
// subject kind, an origin, a provenance or a tier, and the strict arguments refuse a call that
// carries one. Entity ids are checked by the store against what the caller's token shows.

const codePoints = (text: string): number => [...text].length;
const text = (most: number) =>
  z
    .string()
    .refine((value) => value.trim() !== "" && codePoints(value) <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });

const ProposePersonKind = z.enum(["person", "relationship", "link"]);
type ProposePersonKind = z.infer<typeof ProposePersonKind>;

// An id as search gave it, or a handle.
const entity = EntityId.or(Handle);

// `person`: someone the owner knows whom the system has not seen, by name, how the owner knows
// them, and at most one of each identifier: an address, a phone number (a contact detail, never an
// identifier) and a LinkedIn profile. `relationship`: what a person the caller sees is to the
// owner, and how close. `link`: a typed link from one person to a person or an organization;
// `inferred` is the agent's word that no source states it.
export const PROPOSE_PERSON_FIELDS = {
  person: z
    .strictObject({
      name: text(200),
      known_how: text(200),
      email: text(320).optional(),
      phone: text(40).optional(),
      linkedin: text(500).optional(),
    })
    .meta({ title: "fields of kind person" }),
  relationship: z
    .strictObject({ person: entity, relation: TieRelation, closeness: Closeness })
    .meta({ title: "fields of kind relationship" }),
  link: z
    .strictObject({ from: entity, kind: ConnectionKind, to: entity, inferred: z.boolean() })
    .refine((fields) => fields.from !== fields.to, { message: "a link names two different entities", path: ["to"] })
    .meta({ title: "fields of kind link" }),
} as const satisfies Record<ProposePersonKind, z.ZodType>;

// `basis` is how the agent knows it (a short text, shown on the card as the agent's words);
// `quote` the owner's exact words, when they said it; `cites` are record's.
const proposal = {
  basis: text(600).describe("How you know it, as one text in your words, at most 600 characters, never refs."),
  quote: text(1000)
    .optional()
    .describe("The owner's exact words, when they said it; a person's name and known_how then use its words in order."),
  cites: AgentRecordArgs.shape.cites,
  requestId: RequestId,
};
// Tagged by `kind`, so a refusal names the field the kind wanted. What is stored is the arguments as
// sent, without requestId, whichever schema parsed them.
export const ProposePersonArgs = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), fields: PROPOSE_PERSON_FIELDS.person, ...proposal }),
  z.strictObject({ kind: z.literal("relationship"), fields: PROPOSE_PERSON_FIELDS.relationship, ...proposal }),
  z.strictObject({ kind: z.literal("link"), fields: PROPOSE_PERSON_FIELDS.link, ...proposal }),
]);
export type ProposePersonArgs = z.infer<typeof ProposePersonArgs>;
// What tools/list publishes: an agent's tool input schema must be an object at its top, so `fields`
// is the union, each branch titled by the kind it goes with.
export const ProposePersonPublished = z.strictObject({
  kind: ProposePersonKind.describe("person, relationship or link: it says which fields go with it."),
  fields: z.union([PROPOSE_PERSON_FIELDS.person, PROPOSE_PERSON_FIELDS.relationship, PROPOSE_PERSON_FIELDS.link]),
  ...proposal,
});
export type ProposePersonPublished = z.infer<typeof ProposePersonPublished>;
export type PersonProposalFields = {
  person: z.infer<typeof PROPOSE_PERSON_FIELDS.person>;
  relationship: z.infer<typeof PROPOSE_PERSON_FIELDS.relationship>;
  link: z.infer<typeof PROPOSE_PERSON_FIELDS.link>;
};

export const ProposePersonAck = z.strictObject({ recordId: AgentRecordId.or(Handle) });
export type ProposePersonAck = z.infer<typeof ProposePersonAck>;

// A propose_person body as the store keeps it: the canonical JSON of the arguments without
// requestId, parsed strictly; null for anything else. The one parser, for intake, the pipeline
// and the card. No propose_about_you body parses here, nor this one there: the kinds differ.
export type PersonProposalBody = Omit<ProposePersonArgs, "requestId">;
export function parsePersonProposalBody(body: string): PersonProposalBody | null {
  const value = jsonOf(body);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.hasOwn(value, "requestId"))
    return null;
  const parsed = ProposePersonArgs.safeParse({ ...value, requestId: "proposal-body" });
  if (!parsed.success) return null;
  const { requestId: _none, ...rest } = parsed.data;
  return rest;
}

// The entities a body names, which the store checks the caller sees and the pipeline checks are
// still a person (or, for a link's other, an organization).
export function namedEntities(body: Pick<PersonProposalBody, "kind" | "fields">): string[] {
  if (body.kind === "relationship") return [(body.fields as PersonProposalFields["relationship"]).person];
  if (body.kind === "link") {
    const { from, to } = body.fields as PersonProposalFields["link"];
    return [from, to];
  }
  return [];
}

// The pipeline version code sets on every claim built from a propose_person body: not one of
// ABOUT_YOU_PIPELINES, so a confirmed one is `owner_confirmed`, never the owner's own words.
export const PERSON_PROPOSAL_PIPELINE = "personal-person-proposal-1";
