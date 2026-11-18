import {
  AREAS_LISTED,
  type AreaKey,
  ClaimTier,
  type ClientName,
  type EntityId,
  type GoalId,
  type OpportunityId,
  OWNER_PROJECTS_LISTED,
  type OwnerArea,
  type OwnerLongWork,
  type OwnerProject,
  type OwnerProjects,
  type PersonalClaimOrigin,
  PROJECT_CHANGE_DAYS,
  PROJECT_CHANGES_LISTED,
  PROJECT_WORK_LISTED,
  type ProjectChange,
  ProjectStandingValue,
  type ProjectStatusTier,
  projectStatusTierOf,
} from "@intelligence/contracts/personal";
import { projectStanding, type StatusWord } from "@intelligence/personal-beliefs";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { byText, stamp, stampOrNull } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { claimRecordOrNull, openedOrNull } from "../../core/tx.ts";
import {
  PROJECT_COLUMNS,
  PROJECT_EVENTS,
  type ProjectEventRow,
  type ProjectRow,
} from "../../read/read-project-status.ts";
import { ownerBeliefs } from "../admin-owner.ts";
import { openLongWork } from "./admin-long-work.ts";

// The dashboard's Projects room, as pi_admin: every project but a merged one, with where it stands,
// its fields, its open work by holder with each piece's latest progress, and what changed in the
// last seven days; and every area in the owner's order, with each project's area by its key (Part
// C). The rows and the events are read with the statements the agents' project tools read them by
// (read-project-status.ts, work-projects.ts); the owner sees every row, so nothing here leans on a
// reader's policy.
//
// Where a project stands is built at each read by the one rule (personal-beliefs'
// projectStanding), from the status claims the owner's own beliefs rest on and the words agents
// filed on their findings:
// - a status claim in the support of one of the owner's beliefs is the owner's word when the
//   owner stated it, or it is an agent's and the belief's tier says the owner confirmed or relayed
//   it; else a source's, an agent's claim a policy's answer confirmed among them;
// - a status claim of an agent's finding that no belief rests on is that agent's word, unless
//   its record is flagged or a deletion reached it.
// A source's speaker is not named here.

const PROJECTS = `
  select ${PROJECT_COLUMNS} from knowledge.projects p
  where p.status <> 'merged'
  order by p.updated_at desc, p.id desc
  limit $1`;
// The agent that made each project, by name.
const CREATORS = `
  select p.id as project_id, k.name as creator from knowledge.projects p
  join policy.clients k on 'client:' || k.id = p.created_by
  where p.id = any ($1::text[])
  order by p.id`;
// Every area in the owner's order, the retired ones last.
const AREAS = `
  select a.id, a.key, a.state, a.name_enc, a.compartments from knowledge.areas a
  order by (a.state = 'retired'), a.position, a.key collate "C"
  limit $1`;
// The area of each of these projects.
const AREAS_OF = `
  select p.id as project_id, a.key from knowledge.projects p
  join knowledge.areas a on a.id = p.area_id
  where p.id = any ($1::text[])
  order by p.id`;
// Each status claim about these projects, newest first, with the agent whose record it was
// written on, where it was written on one that stands.
const STATUS_CLAIMS = `
  select n.entity_id as project_id, c.id, c.fact_key_fp, c.compartments, c.content_enc, c.valid_from,
    w.client_name, w.id is not null and (w.flagged_at is not null or w.tainted_at is not null) as dropped
  from knowledge.claims c
  join knowledge.claim_entities n on n.claim_id = c.id
  left join ledger.agent_writes w on w.evidence_id = c.evidence_id
  where n.entity_id = any ($1::text[]) and c.type = 'project.status'
  order by c.valid_from desc, c.id`;
// The steps of these projects' work since a time, newest first.
const WORK_EVENTS = `
  select o.project_id, r.row_id, r.event, r.at from ledger.record_events r
  join ledger.opportunities o on o.id = r.row_id
  where r.row_kind = 'opportunity' and o.project_id = any ($1::text[]) and o.tainted_at is null
    and r.tainted_at is null and r.at >= $2
  order by r.at desc, r.row_id`;

type ClaimRow = {
  project_id: string;
  id: string;
  fact_key_fp: string;
  compartments: string[];
  content_enc: Sealed;
  valid_from: Date;
  client_name: ClientName | null;
  dropped: boolean;
};

// Which of the three tiers a status claim is, or null for one that is no word on the project.
// `beliefTier`: the tier of the owner's belief that rests on it, null where none does. A claim a
// belief rests on is read as the agents' read serves it (read-project-status.ts, by
// projectStatusTierOf): an agent's claim is the owner's word only where the belief's tier says the
// owner stated, confirmed or relayed it. One a policy's answer confirmed or a standing release let
// through is a source's, never the owner's.
export function statusTierOf(
  origin: PersonalClaimOrigin,
  beliefTier: ClaimTier | null,
  dropped: boolean,
): ProjectStatusTier | null {
  if (origin === "owner_command") return "owner";
  if (beliefTier !== null) return origin === "agent_record" ? projectStatusTierOf(beliefTier) : "source";
  return (origin === "agent_record" || origin === "agent_close") && !dropped ? "agent" : null;
}

// The fields an event's code may name; any other code is no change of a field.
type Field = Extract<ProjectChange, { kind: "field" }>["field"];
const FIELDS: readonly Field[] = ["name", "owner_role", "goal", "due_at"];

// What changed on one project since a time, newest first, as get_project lists it: each status
// said, each field set, each step of its work.
export function projectChanges(
  words: readonly StatusWord[],
  events: readonly ProjectEventRow[],
  steps: readonly { row_id: string; event: string; at: Date }[],
  since: Date,
): ProjectChange[] {
  const recent = (at: string | Date): boolean => new Date(at).getTime() >= since.getTime();
  return [
    ...words.flatMap((word): ProjectChange[] =>
      recent(word.at) ? [{ kind: "status", at: word.at, value: word.value, by: word.by }] : [],
    ),
    ...events.flatMap((event): ProjectChange[] => {
      if (!recent(event.at)) return [];
      const by = event.by === "owner" ? ("owner" as const) : ("agent" as const);
      if (event.event === "closed")
        return [{ kind: "status", at: stamp(event.at), value: "closed", by: { kind: "owner" } }];
      if (event.event === "created") return [{ kind: "field", at: stamp(event.at), field: "created", by }];
      const field = FIELDS.find((one) => one === event.code);
      return field === undefined ? [] : [{ kind: "field", at: stamp(event.at), field, by }];
    }),
    ...steps.map(
      (step): ProjectChange => ({
        kind: "work",
        at: stamp(step.at),
        opportunity: step.row_id as OpportunityId,
        event: step.event,
      }),
    ),
  ].sort((a, b) => byText(b.at, a.at) || byText(a.kind, b.kind));
}

export async function ownerProjects(admin: AdminContext): Promise<OwnerProjects> {
  const now = admin.now();
  const since = new Date(now.getTime() - PROJECT_CHANGE_DAYS * DAY_MS);
  return admin.transaction(async (query) => {
    const found = await query<ProjectRow>(PROJECTS, [OWNER_PROJECTS_LISTED + 1]);
    const rows = found.slice(0, OWNER_PROJECTS_LISTED);
    const ids = rows.map((row) => row.id);
    const creators = new Map(
      (await query<{ project_id: string; creator: ClientName }>(CREATORS, [ids])).map((one) => [
        one.project_id,
        one.creator,
      ]),
    );
    const areas = (
      await query<{ id: string; key: AreaKey; state: string; name_enc: Sealed; compartments: string[] }>(AREAS, [
        AREAS_LISTED,
      ])
    ).map((row): OwnerArea => {
      const name = open(admin.keys, row, "knowledge.areas.name_enc", "null");
      return { key: row.key, name: name === null ? null : { untrusted: name }, retired: row.state === "retired" };
    });
    const areaOf = new Map(
      (await query<{ project_id: string; key: AreaKey }>(AREAS_OF, [ids])).map((one) => [one.project_id, one.key]),
    );
    const events = await query<ProjectEventRow>(PROJECT_EVENTS, [ids]);
    const claims = await query<ClaimRow>(STATUS_CLAIMS, [ids]);
    // Each claim one of the owner's beliefs rests on, with that belief's tier.
    const kept = new Map<string, ClaimTier>();
    for (const belief of await ownerBeliefs({ query, keys: admin.keys }, [
      ...new Set(claims.map((row) => row.fact_key_fp)),
    ])) {
      const tier = ClaimTier.safeParse(belief.tier);
      for (const claim of belief.support) kept.set(claim, tier.success ? tier.data : "source");
    }
    const words = new Map<string, StatusWord[]>();
    for (const row of claims) {
      const record = claimRecordOrNull(admin.keys, row);
      const value = ProjectStandingValue.safeParse(record?.claim.content.fields.status);
      if (record === null || !value.success || value.data === "closed") continue;
      const tier = statusTierOf(record.origin, kept.get(row.id) ?? null, row.dropped);
      if (tier === null) continue;
      words.set(row.project_id, [
        ...(words.get(row.project_id) ?? []),
        {
          tier,
          value: value.data,
          at: stamp(row.valid_from),
          by:
            tier === "owner"
              ? { kind: "owner" }
              : tier === "agent"
                ? { kind: "agent", client: row.client_name }
                : { kind: "source", who: null },
        },
      ]);
    }
    const steps = await query<{ project_id: string; row_id: string; event: string; at: Date }>(WORK_EVENTS, [
      ids,
      stamp(since),
    ]);
    const work = ids.length === 0 ? [] : await openLongWork(query, admin.keys, now, ids);
    const projects = rows.map((row): OwnerProject => {
      const own = events.filter((one) => one.row_id === row.id);
      const said = words.get(row.id) ?? [];
      const closedAt = own.filter((one) => one.event === "closed").at(-1)?.at;
      const name = openedOrNull(
        admin.keys,
        row.compartments,
        { table: "knowledge.projects", id: row.id, column: "name_enc" },
        row.name_enc,
      );
      const longWork: OwnerLongWork[] = work.filter((one) => one.project === row.id);
      const changes = projectChanges(
        said,
        own,
        steps.filter((one) => one.project_id === row.id),
        since,
      );
      return {
        id: row.id as EntityId,
        name: name === null ? null : { untrusted: name },
        status: projectStanding({
          created: {
            at: stamp(row.created_at),
            by:
              row.created_by === "owner" ? { kind: "owner" } : { kind: "agent", client: creators.get(row.id) ?? null },
          },
          ...(row.status === "closed" ? { closed: { at: stamp(closedAt ?? row.updated_at) } } : {}),
          words: said,
        }),
        ownerRole: row.owner_role,
        goal: row.goal_id as GoalId | null,
        dueAt: stampOrNull(row.due_at),
        createdAt: stamp(row.created_at),
        updatedAt: stamp(row.updated_at),
        createdBy: row.created_by === "owner" ? "owner" : (creators.get(row.id) ?? null),
        area: areaOf.get(row.id) ?? null,
        work: longWork.slice(0, PROJECT_WORK_LISTED),
        changes: changes.slice(0, PROJECT_CHANGES_LISTED),
        more: longWork.length > PROJECT_WORK_LISTED || changes.length > PROJECT_CHANGES_LISTED,
      };
    });
    return { at: stamp(now), projects, areas, more: found.length > OWNER_PROJECTS_LISTED };
  });
}
