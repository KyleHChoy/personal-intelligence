import { z } from "zod";
import { Compartment, Store } from "./ids.ts";

// The ontology is data each piece loads. These are the shapes of that data once loaded.

// Beliefs exist only for the kinds a consumer depends on.
// Everything else stays as claims and is compiled with citations when read.
export const BeliefKind = z.enum([
  "need",
  "capability",
  "role",
  "affiliation",
  "relationship",
  "commitment",
  "decision",
  "project_status",
  "consent",
  "contact_rule",
  // The owner-side kinds Personal Intelligence keeps. No team type names one.
  "goal",
  "preference",
  "constraint",
  "situation",
  // Personal Intelligence's confirmed project link of a meeting, by its title. No company type
  // names it.
  "capture_project",
  // Personal Intelligence's inferred "looking into X", built only from the owner's observed
  // activity. No company type names it.
  "interest",
  // Personal Intelligence's opinion or thesis of a person, an organization's process about the
  // owner and its current state, and a place the owner has been. No company type names one.
  "view",
  "status",
  "visited",
]);
export type BeliefKind = z.infer<typeof BeliefKind>;

export const FieldKind = z.enum(["entity", "type", "enum", "number", "date", "boolean", "text"]);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldSpec = z.object({
  name: z.string().min(1),
  kind: FieldKind,
  // The closed list for a field of kind "enum".
  values: z.array(z.string()).optional(),
  required: z.boolean(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

export const OntologyType = z.object({
  id: z.string().min(1),
  parent: z.string().min(1).optional(),
  synonyms: z.array(z.string()),
  fields: z.array(FieldSpec),
  // The store its claims are routed to. Model output never names one.
  owner: Store,
  beliefKind: BeliefKind.optional(),
  ceiling: Compartment.optional(),
});
export type OntologyType = z.infer<typeof OntologyType>;

// An id, an enumeration value, a date, a number or a boolean. Never free text.
export const TypedValue = z.union([z.number(), z.boolean(), z.string().regex(/^\S{1,128}$/)]);
export type TypedValue = z.infer<typeof TypedValue>;

// A typed value, or a string for a field of kind "text".
export const FieldValue = z.union([TypedValue, z.string()]);
export type FieldValue = z.infer<typeof FieldValue>;
