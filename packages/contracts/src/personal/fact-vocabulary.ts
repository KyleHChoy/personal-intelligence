import { z } from "zod";

// Each is a list here so the contract, the ontology and the check cannot differ.
// RELATIONSHIP_RELATIONS is spliced into the extraction prompts: a change to it moves a pinned
// prompt's hash, and needs a new prompt version.
export const AFFILIATION_RELATIONS = Object.freeze([
  "employee",
  "founder",
  "owner",
  "member",
  "student",
  "alumnus",
  "advisor",
  "investor",
  "board",
  "contractor",
  "volunteer",
  "other",
] as const);
export const AffiliationRelation = z.enum(AFFILIATION_RELATIONS);
export type AffiliationRelation = z.infer<typeof AffiliationRelation>;

export const RELATIONSHIP_RELATIONS = Object.freeze([
  "spouse",
  "partner",
  "parent",
  "child",
  "sibling",
  "family",
  "friend",
  "colleague",
  "manager",
  "report",
  "mentor",
  "mentee",
  "assistant",
  "client",
  "vendor",
  "classmate",
  "neighbor",
  "other",
  "acquaintance",
] as const);
export const RelationshipRelation = z.enum(RELATIONSHIP_RELATIONS);
export type RelationshipRelation = z.infer<typeof RelationshipRelation>;

export const INTRO_OFFERS = Object.freeze(["offered", "suggested"] as const);
export const IntroOffer = z.enum(INTRO_OFFERS);
export type IntroOffer = z.infer<typeof IntroOffer>;

export const PREFERENCE_POLARITIES = Object.freeze(["likes", "dislikes", "prefers", "avoids"] as const);
export const PreferencePolarity = z.enum(PREFERENCE_POLARITIES);
export type PreferencePolarity = z.infer<typeof PreferencePolarity>;

export const CONSENT_SUBJECTS = Object.freeze(["share_details", "introduce", "quote", "contact", "other"] as const);
export const ConsentSubject = z.enum(CONSENT_SUBJECTS);
export type ConsentSubject = z.infer<typeof ConsentSubject>;

export const CONTACT_RULES = Object.freeze([
  "do_not_contact",
  "only_via",
  "prefers_channel",
  "not_before",
  "other",
] as const);
export const ContactRuleKind = z.enum(CONTACT_RULES);
export type ContactRuleKind = z.infer<typeof ContactRuleKind>;

export const CONTACT_CHANNELS = Object.freeze(["email", "phone", "message", "any"] as const);
export const ContactChannel = z.enum(CONTACT_CHANNELS);
export type ContactChannel = z.infer<typeof ContactChannel>;

export const PROJECT_STATUSES = Object.freeze(["active", "paused", "blocked", "done", "cancelled"] as const);
// The words an agent sets a project's status with. What a source states keeps PROJECT_STATUSES, the
// words extraction reads; a status served is either.
export const AGENT_PROJECT_STATUSES = Object.freeze(["planned", "active", "blocked", "waiting", "done"] as const);
export const ProjectStatus = z.enum([...PROJECT_STATUSES, "planned", "waiting"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;
