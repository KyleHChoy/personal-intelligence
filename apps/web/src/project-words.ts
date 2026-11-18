import type { OwnerProject, ProjectChange, ProjectStanding, ProjectStatusBy } from "@intelligence/contracts/personal";
import { agentName, ledgerEventWords } from "./agent-words.ts";
import { whenWords } from "./time-words.ts";
import { capital } from "./words.ts";

// The Projects room's words: where a project stands, who said so, what another tier says, and
// each change of the last seven days.

const STATUS_WORDS: Readonly<Record<ProjectStanding["value"], string>> = {
  active: "Active",
  planned: "Planned",
  waiting: "Waiting",
  blocked: "Blocked",
  paused: "Paused",
  done: "Done",
  cancelled: "Cancelled",
  closed: "Closed",
};

// Who said it, to start a line: the owner, an agent by its name, or a source by its speaker's name.
export function saidBy(by: ProjectStatusBy): string {
  if (by.kind === "owner") return "You";
  if (by.kind === "agent") return by.client === null ? "An agent" : agentName(by.client);
  return by.who?.name?.untrusted ?? "Something you received";
}

// "Blocked · Sable said so yesterday 4:10 PM".
export const standingLine = (
  standing: Pick<ProjectStanding, "value" | "asOf" | "by">,
  now: Date = new Date(),
): string => `${STATUS_WORDS[standing.value]} · ${saidBy(standing.by)} said so ${whenWords(standing.asOf, now)}`;

// What another tier says, each on a line of its own: "Sable says Blocked, yesterday 4:10 PM".
export const disputeLines = (standing: ProjectStanding, now: Date = new Date()): string[] =>
  (standing.disputedBy ?? []).map(
    (other) =>
      `${saidBy(other.by)} ${other.by.kind === "owner" ? "say" : "says"} ${STATUS_WORDS[other.value]}, ${whenWords(other.asOf, now)}`,
  );

// The three groups the room lists projects in, by where each stands.
export type ProjectGroup = "In progress" | "Held up" | "Finished";
export const PROJECT_GROUPS: readonly ProjectGroup[] = ["In progress", "Held up", "Finished"];
export function groupOf(value: ProjectStanding["value"]): ProjectGroup {
  if (value === "blocked" || value === "waiting" || value === "paused") return "Held up";
  return value === "done" || value === "cancelled" || value === "closed" ? "Finished" : "In progress";
}

const FIELD_WORDS: Readonly<Record<Extract<ProjectChange, { kind: "field" }>["field"], string>> = {
  created: "made the project",
  name: "renamed it",
  owner_role: "changed whose it is",
  goal: "changed the goal it serves",
  due_at: "changed when it is due",
  note: "added a note",
};

// One change in words. A step of its work names the work, where it is still open.
export function changeWords(change: ProjectChange, project: Pick<OwnerProject, "work">): string {
  if (change.kind === "status") return `${saidBy(change.by)} said: ${STATUS_WORDS[change.value]}`;
  if (change.kind === "field") return `${change.by === "owner" ? "You" : "An agent"} ${FIELD_WORDS[change.field]}`;
  const work = project.work.find((one) => one.opportunity === change.opportunity);
  const step = ledgerEventWords(change.event);
  return work?.summary == null ? `${step}: a piece of its work` : `${step}: ${work.summary.untrusted}`;
}

export const roleWords = (role: string): string => capital(role.replaceAll("-", " ").replaceAll("_", " "));

// A project by its name; one the key file cannot open says so, never an id.
export const projectName = (project: Pick<OwnerProject, "name">): string =>
  project.name?.untrusted ?? "A project whose name this page cannot open";
