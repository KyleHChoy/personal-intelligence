import { z } from "zod";
import { BeliefKind } from "../ontology.ts";

// What a personal fact is about. `project`: a project the owner made and anchored. Other kinds,
// such as a place, an asset or an account, are added when unmapped claims show them.
export const SubjectKind = z.enum(["owner", "person", "organization", "project"]);
export type SubjectKind = z.infer<typeof SubjectKind>;

// The three views over the one personal store.
export const PersonalView = z.enum(["self", "people", "work"]);
export type PersonalView = z.infer<typeof PersonalView>;

// Set by code on a claim whose subject, speaker or any entity field is not the owner.
export const DisclosureClass = z.enum(["third_party"]);
export type DisclosureClass = z.infer<typeof DisclosureClass>;

// The belief statuses that still bind: an open commitment, a current line, an attendee's live fact.
export const OPEN_BELIEF_STATUS: ReadonlySet<string> = new Set(["active", "stale"]);

// The belief kinds of Personal Intelligence: the shared list, re-exported, so a kind added there
// arrives here with no edit.
export const PersonalBeliefKind = BeliefKind;
export type PersonalBeliefKind = z.infer<typeof PersonalBeliefKind>;

const frozen = <T>(rows: Record<string, readonly T[]>) =>
  Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, Object.freeze([...list])])));

// The belief kinds each subject kind may have, in a fixed order. A commitment is a person's, not an organization's; a project's commitments are
// those of its anchored threads, compiled with it. A project's confirmed title links are capture_project.
export const BELIEF_KINDS_BY_SUBJECT: Readonly<Record<SubjectKind, readonly PersonalBeliefKind[]>> =
  frozen<PersonalBeliefKind>({
    owner: [
      "goal",
      "preference",
      "need",
      "capability",
      "constraint",
      "commitment",
      "situation",
      "view",
      "status",
      "visited",
    ],
    person: [
      "need",
      "capability",
      "role",
      "affiliation",
      "relationship",
      "goal",
      "constraint",
      "preference",
      "situation",
      "consent",
      "contact_rule",
      "commitment",
      "view",
      "visited",
    ],
    organization: [
      "need",
      "capability",
      "role",
      "affiliation",
      "relationship",
      "goal",
      "constraint",
      "preference",
      "situation",
      "consent",
      "contact_rule",
    ],
    project: ["project_status", "decision", "commitment", "capture_project"],
  }) as Readonly<Record<SubjectKind, readonly PersonalBeliefKind[]>>;

// The view each subject kind is served in (design, "Knowledge, subjects and views").
export const VIEW_OF_SUBJECT: Readonly<Record<SubjectKind, PersonalView>> = Object.freeze({
  owner: "self",
  person: "people",
  organization: "people",
  project: "work",
});
