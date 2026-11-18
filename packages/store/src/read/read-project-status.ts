import type {
  ClientName,
  EntityId,
  FactView,
  GoalId,
  ProjectStanding,
  ProjectStandingValue,
  ProjectStatusBy,
  RoleName,
} from "@intelligence/contracts/personal";
import { projectStatusTierOf } from "@intelligence/contracts/personal";
import { projectStanding, type StatusWord } from "@intelligence/personal-beliefs";
import { stamp } from "../core/db.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { findFacts } from "./read-facts.ts";

// Where a project stands, built at each read from the
// rows the caller's token returns: the project's own row and events, and its status claims, each
// with the tier code gave it. get_entity serves it for a project; list_projects, get_project and
// update_project serve it too (work-projects.ts). Nothing here is stored.

export const PROJECT_COLUMNS =
  "p.id, p.status, p.name_enc, p.compartments, p.created_at, p.updated_at, p.updated_at::text as updated_text, p.created_by, p.owner_role, p.goal_id, p.due_at";

// One project, as the token shows it.
export const PROJECT_ROW = `select ${PROJECT_COLUMNS} from knowledge.projects p where p.id = $1 order by p.id`;
// A project's own events: made, a field set, the owner's close.
export const PROJECT_EVENTS = `
  select r.row_id, r.event, r.code, r.at, r.by from ledger.record_events r
  where r.row_kind = 'project' and r.row_id = any($1) and r.tainted_at is null
  order by r.row_id, r.at, r.event`;
// The agents whose records the caller's token returns.
const RECORD_CLIENTS =
  "select w.id, w.client_name from ledger.agent_writes w where w.id = any($1::text[]) order by w.id";

export type ProjectRow = {
  id: EntityId;
  status: "active" | "merged" | "closed";
  name_enc: unknown;
  compartments: string[];
  created_at: Date;
  updated_at: Date;
  updated_text: string;
  created_by: string;
  owner_role: RoleName | null;
  goal_id: GoalId | null;
  due_at: Date | null;
};
export type ProjectEventRow = { row_id: string; event: string; code: string | null; at: Date; by: string };

// The most claims of one project each read looks at.
const FACTS_READ = 50;

// Who said a fact, by the tier code gave it: the owner; an agent, by the client of the record the
// caller's token returns; else a source, by its speaker.
export function saidBy(fact: FactView, clients: ReadonlyMap<string, ClientName>): ProjectStatusBy {
  const tier = fact.tier === undefined ? (fact.agentReported ? "agent" : "source") : projectStatusTierOf(fact.tier);
  if (tier === "owner") return { kind: "owner" };
  if (tier === "agent") return { kind: "agent", client: (fact.record && clients.get(fact.record)) || null };
  return { kind: "source", who: fact.statedBy };
}

export type ProjectRead = {
  standing: ProjectStanding;
  facts: FactView[];
  clients: ReadonlyMap<string, ClientName>;
  shown: string[];
  bound: string[];
  moreFacts: boolean;
};

// A project's claims the caller can see, and where it stands by them. `creators` names the agent
// that made it, where the caller was given the name; `events` are the project's own.
export async function readProject(
  ctx: Ctx,
  row: ProjectRow,
  creators: ReadonlyMap<string, ClientName>,
  events: readonly ProjectEventRow[],
): Promise<ProjectRead> {
  const entity = row.id;
  const found = await findFacts(ctx, { type: "project", entity, limit: FACTS_READ });
  // Where it stands is read apart from the project's other facts: the newest status claims of
  // any speaker and, when there are more than one read holds, the newest that no agent record
  // carries. However many times an agent says its word, the owner's and a source's are still
  // read (invariant 11).
  const status = { type: "project.status", entity, limit: FACTS_READ } as const;
  const newest = await findFacts(ctx, status);
  const said = [newest, newest?.value.more === true ? await findFacts(ctx, status, undefined, true) : null];
  const facts = found?.value.facts ?? [];
  const statuses = [...new Map(said.flatMap((one) => one?.value.facts ?? []).map((fact) => [fact.id, fact])).values()];
  const records = [...facts, ...statuses].flatMap((fact) => (fact.record === undefined ? [] : [fact.record as string]));
  const clients = new Map(
    (await ctx.run<{ id: string; client_name: ClientName }>(RECORD_CLIENTS, [[...new Set(records)]])).map((one) => [
      one.id,
      one.client_name,
    ]),
  );
  const words: StatusWord[] = statuses.flatMap((fact) => {
    if (fact.type !== "project.status") return [];
    const by = saidBy(fact, clients);
    return [{ tier: by.kind, value: fact.fields.status as ProjectStandingValue, at: fact.at, by }];
  });
  const closedAt = events.filter((one) => one.row_id === row.id && one.event === "closed").at(-1)?.at;
  const standing = projectStanding({
    created: {
      at: stamp(row.created_at),
      by: row.created_by === "owner" ? { kind: "owner" } : { kind: "agent", client: creators.get(row.id) ?? null },
    },
    ...(row.status === "closed" ? { closed: { at: stamp(closedAt ?? row.updated_at) } } : {}),
    words,
  });
  return {
    standing,
    facts,
    clients,
    shown: [...new Set([found, ...said].flatMap((one) => one?.read.shown ?? []))],
    bound: [...new Set([found, ...said].flatMap((one) => one?.read.bound ?? []))],
    moreFacts: found?.value.more ?? false,
  };
}

// get_entity's: where one project stands, with what the read showed. The agent that made it is
// not named here: that name is the project tools' to give. Null for a project the token does not
// return.
export async function projectStandingOf(
  ctx: Ctx,
  id: string,
): Promise<{ standing: ProjectStanding; shown: string[]; bound: string[] } | null> {
  const [row] = await ctx.run<ProjectRow>(PROJECT_ROW, [id]);
  if (row === undefined) return null;
  const events = await ctx.run<ProjectEventRow>(PROJECT_EVENTS, [[id]]);
  const read = await readProject(ctx, row, new Map(), events);
  return { standing: read.standing, shown: read.shown, bound: read.bound };
}
