import {
  type AgentRecordId,
  AREAS_LISTED,
  type AreaView,
  type ClientName,
  type EntityId,
  type FactView,
  type OpportunityId,
  PROJECT_CHANGE_DAYS,
  PROJECT_CHANGES_LISTED,
  PROJECT_NOTES_LISTED,
  PROJECT_WORK_LISTED,
  type ProjectChange,
  type ProjectNote,
  type ProjectStanding,
  type ProjectStandingValue,
  type ProjectView,
  type Who,
} from "@intelligence/contracts/personal";
import { appendRecord } from "../agent-writes/record.ts";
import { byText, stamp, stampOrNull } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { TAINT_SHARED } from "../core/locks.ts";
import type { Sealed } from "../core/seal.ts";
import { served } from "../core/served.ts";
import { trailOf } from "../core/work-progress.ts";
import {
  type Args,
  answered,
  type Done,
  derivedId,
  invalidAs,
  isRefused,
  type Result,
  refused,
  sealSummary,
  value,
  type WorkCall,
} from "../core/work-refs.ts";
import { type Ctx, untrusted } from "../read/read-ctx.ts";
import {
  type ProjectEventRow as EventRow,
  PROJECT_COLUMNS,
  PROJECT_EVENTS,
  PROJECT_ROW,
  type ProjectRow as Row,
  readProject,
  saidBy,
} from "../read/read-project-status.ts";
import { normalized } from "../read/read-search.ts";
import { boardRows } from "./work-board.ts";

// Projects as agents write and read them: propose_project, update_project, list_projects and
// get_project. A project's row, its events and its claims are read under the caller's token, so
// every list, order and count here is over rows the caller can see; the two writes go through one
// definer function each, which decides the author and the label. A status an agent sets is a typed
// claim on a finding of its own, filed under the project; where the project stands is built at each
// read (personal-beliefs' projectStanding).
//
// Areas (Part C): a project's area, the list of areas and every filter or order by area are read
// from knowledge.areas under the caller's token, so a client not cleared for the owner's own
// compartment is returned no area: each project reads as having none, the list is empty and a key
// finds nothing, as if no area existed (AR3, invariant 6). No statement here serves
// knowledge.projects.area_id itself.

// An area's place in the order by area: a retired one after every active one, none last.
const RETIRED_RANK = 1_000_000;
const NO_AREA_RANK = 2_147_483_647;

const SQL = {
  taintShared: TAINT_SHARED,
  proposeProject:
    "select ledger.propose_project($1::text, $2::text, $3::text, $4::jsonb, $5::text, $6::text, $7::timestamptz, $8::text) as id",
  updateProject:
    "select found, refused from ledger.update_project($1::text, $2::text, $3::jsonb, $4::boolean, $5::text, $6::boolean, $7::text, $8::boolean, $9::timestamptz, $10::boolean, $11::boolean, $12::text)",
  creators: "select project_id, creator from ledger.project_creators($1::text[])",
  project: PROJECT_ROW,
  // The projects the token shows, the most recently changed first, after a page's last one. With
  // an area's key ($4), only the projects of that area, where the token returns the area.
  page: `
    select ${PROJECT_COLUMNS} from knowledge.projects p
    where p.status <> 'merged' and ($1::timestamptz is null or (p.updated_at, p.id) < ($1::timestamptz, $2::text))
      and ($4::text is null or exists (select 1 from knowledge.areas a where a.id = p.area_id and a.key = $4))
    order by p.updated_at desc, p.id desc
    limit $3`,
  // The same projects by the owner's order of the areas (AR7): the active areas by their place,
  // then the retired ones, then the projects with no area the token returns; within one, the most
  // recently changed first. `area_rank` and `area_sort` are the page's cursor.
  pageByArea: `
    select ${PROJECT_COLUMNS}, s.rank as area_rank, s.key as area_sort from knowledge.projects p
    left join lateral (
      select case when a.state = 'retired' then ${RETIRED_RANK} + a.position else a.position end as rank, a.key
      from knowledge.areas a where a.id = p.area_id) x on true
    cross join lateral (select coalesce(x.rank, ${NO_AREA_RANK}) as rank, coalesce(x.key, '~') as key) s
    where p.status <> 'merged'
      and ($4::text is null or x.key = $4)
      and ($1::timestamptz is null or s.rank > $5::integer
           or (s.rank = $5::integer and (s.key collate "C" > $6::text collate "C"
               or (s.key = $6::text and (p.updated_at, p.id) < ($1::timestamptz, $2::text)))))
    order by s.rank, s.key collate "C", p.updated_at desc, p.id desc
    limit $3`,
  // The areas the token shows, in the owner's order, the retired ones last.
  areas: `
    select a.id, a.key, a.name_enc, a.state, a.compartments from knowledge.areas a
    order by (a.state = 'retired'), a.position, a.key collate "C"
    limit $1`,
  // The area of each of these projects, where the token returns it.
  areasOf: `
    select p.id as project_id, a.id, a.key, a.name_enc, a.state, a.compartments
    from knowledge.projects p join knowledge.areas a on a.id = p.area_id
    where p.id = any($1) order by p.id`,
  // An active area by its key, as the token shows it.
  areaByKey: "select a.id from knowledge.areas a where a.key = $1 and a.state = 'active' order by a.id",
  // The active projects the token shows, each name opened to find one already there.
  names: "select p.id, p.compartments, p.name_enc from knowledge.projects p where p.status = 'active' order by p.id",
  events: PROJECT_EVENTS,
  // The steps of a project's work since a time, newest first.
  workEvents: `
    select r.row_id, r.event, r.at from ledger.record_events r
    join ledger.opportunities o on o.id = r.row_id
    where r.row_kind = 'opportunity' and o.project_id = $1 and o.tainted_at is null and r.tainted_at is null and r.at >= $2
    order by r.at desc, r.row_id
    limit $3`,
  goalsSeen: "select g.goal_id from projections.goal_state g where g.goal_id = any($1) order by g.goal_id",
} as const;

type AreaRow = { id: string; key: string; name_enc: Sealed; state: "active" | "retired"; compartments: string[] };
const areaView = (ctx: Ctx, row: AreaRow): AreaView => ({
  key: row.key,
  name: served(ctx, row, "knowledge.areas.name_enc"),
  retired: row.state === "retired",
});

// With a status filter, the most projects one page looks at.
const SCAN = 100;

const nameOf = (ctx: Ctx, row: Pick<Row, "id" | "compartments" | "name_enc">) =>
  untrusted(ctx, "knowledge.projects", "name_enc", {
    id: row.id,
    compartments: row.compartments,
    value_enc: row.name_enc,
  });

const viewOf = (
  ctx: Ctx,
  row: Row,
  standing: ProjectStanding,
  creators: ReadonlyMap<string, ClientName>,
  goals: ReadonlySet<string>,
  areas: ReadonlyMap<string, AreaView>,
): ProjectView => ({
  id: row.id,
  name: nameOf(ctx, row),
  status: standing,
  ownerRole: row.owner_role,
  // A goal the caller's token does not return is served as none.
  goal: row.goal_id !== null && goals.has(row.goal_id) ? row.goal_id : null,
  dueAt: stampOrNull(row.due_at),
  createdAt: stamp(row.created_at),
  updatedAt: stamp(row.updated_at),
  createdBy: row.created_by === "owner" ? "owner" : (creators.get(row.id) ?? null),
  // An area the caller's token does not return is served as none.
  area: areas.get(row.id) ?? null,
});

// What each of these rows needs beside its claims: its creator's name, its events, its goal seen
// and its area seen.
async function around(call: WorkCall, rows: readonly Row[]) {
  const ids = rows.map((row) => row.id);
  const named = await call.fn<{ project_id: string; creator: ClientName }>(SQL.creators, [ids]);
  if (isRefused(named)) return named;
  const events = await call.ctx.run<EventRow>(SQL.events, [ids]);
  const goals = new Set(
    (
      await call.ctx.run<{ goal_id: string }>(SQL.goalsSeen, [
        rows.flatMap((row) => (row.goal_id === null ? [] : [row.goal_id])),
      ])
    ).map((one) => one.goal_id),
  );
  const areas = new Map(
    (await call.ctx.run<AreaRow & { project_id: string }>(SQL.areasOf, [ids])).map((one) => [
      one.project_id,
      areaView(call.ctx, one),
    ]),
  );
  return { creators: new Map(named.map((one) => [one.project_id, one.creator])), events, goals, areas };
}

// A page's cursor: the last project's time of change and id; by area, its area's place first.
type Sorted = Row & { area_rank?: number; area_sort?: string };
type Cursor = { at: string | null; id: string | null; rank: number | null; sort: string | null };
const cursorOf = (row: Sorted): string =>
  Buffer.from(
    `${row.area_rank === undefined ? "" : `a|${row.area_rank}|${row.area_sort}|`}${row.updated_text}|${row.id}`,
  ).toString("base64url");
// Null for a cursor that is not one, or that a page of the other order answered.
export function cursorAt(after: string | undefined, byArea: boolean): Cursor | null {
  if (after === undefined) return { at: null, id: null, rank: null, sort: null };
  let text = Buffer.from(after, "base64url").toString();
  let rank: number | null = null;
  let sort: string | null = null;
  const placed = /^a\|(\d{1,10})\|([a-z][a-z0-9-]{1,31}|~)\|/.exec(text);
  if ((placed !== null) !== byArea) return null;
  if (placed !== null) {
    rank = Number(placed[1]);
    sort = placed[2] as string;
    if (rank > NO_AREA_RANK) return null;
    text = text.slice(placed[0].length);
  }
  const cut = text.lastIndexOf("|");
  const at = text.slice(0, cut);
  const id = text.slice(cut + 1);
  return cut > 0 && !Number.isNaN(Date.parse(at)) && /^ent_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)
    ? { at, id, rank, sort }
    : null;
}

// AR5: an area's key as the caller may name it: the id of the active area the token returns for
// it, else undefined, the same for a key that is absent, retired or outside the caller's clearance.
async function areaNamed(ctx: Ctx, key: string): Promise<string | undefined> {
  return (await ctx.run<{ id: string }>(SQL.areaByKey, [key]))[0]?.id;
}

// B1: a project at once, active, under the caller's clearance. An active project the caller can
// see that already holds the name is answered instead of a second one.
export async function proposeProject(
  call: WorkCall,
  valid: Args<"propose_project">,
): Promise<Done<Result<"propose_project">>> {
  const { client, ctx, session, fn } = call;
  const name = valid.name.trim();
  const wanted = normalized(name);
  const held = (await ctx.run<Pick<Row, "id" | "compartments" | "name_enc">>(SQL.names, []))
    .filter((row) => normalized(nameOf(ctx, row).untrusted) === wanted)
    .map((row) => row.id)
    .sort(byText)[0];
  // The area is checked first: a key that names no area the caller can see is refused, never
  // passed over because a project already holds the name.
  const area = valid.area === undefined ? null : await areaNamed(ctx, valid.area);
  if (area === undefined) return invalidAs("area_unknown");
  if (held !== undefined) return answered({ project: held });
  const id = newId("ent");
  const rows = await fn<{ id: EntityId | null }>(SQL.proposeProject, [
    id,
    valid.requestId,
    await session(),
    sealSummary(ctx, client.compartments, { table: "knowledge.projects", id, column: "name_enc" }, name),
    valid.goal ?? null,
    valid.ownerRole ?? null,
    valid.dueAt ?? null,
    area,
  ]);
  if (isRefused(rows)) return refused(rows);
  const made = value(rows, "id");
  return made === null ? refused("not_found") : answered({ project: made });
}

const derived = (requestId: string, word: string): string => derivedId(`${requestId}\n${word}`, 32);

type Field = "status" | "name" | "ownerRole" | "goal" | "dueAt" | "area" | "note";
type FieldRefusal = { field: Field; code: "owner_set" | "not_active" };

// B2: the fields an agent may set, and its word on where the project stands: a finding of the
// caller's own filed under the project, its status a typed claim, so the record tool is needed
// for a status or a note. The fields and the finding land together or not at all.
export async function updateProject(
  call: WorkCall,
  valid: Args<"update_project">,
): Promise<Done<Result<"update_project">>> {
  const { client, ctx, session, fn } = call;
  const says = valid.status !== undefined || valid.note !== undefined;
  if (says && !client.tools.includes("record")) return refused("invalid_request");
  const [row] = await ctx.run<Row>(SQL.project, [valid.project]);
  if (row === undefined || row.status === "merged") return refused("not_found");
  // A name the project already holds changes nothing, so a repeat writes no second event.
  const rename =
    valid.name !== undefined && normalized(valid.name.trim()) !== normalized(nameOf(ctx, row).untrusted)
      ? valid.name.trim()
      : undefined;
  // After the project was found, so a project the caller cannot see answers not_found whatever
  // area is named.
  const area = valid.area === undefined || valid.area === null ? null : await areaNamed(ctx, valid.area);
  if (area === undefined) return invalidAs("area_unknown");
  const sessionId = await session();
  await ctx.run("savepoint project_update", []);
  const undo = async <T>(done: Done<T>): Promise<Done<T>> => {
    await ctx.run("rollback to savepoint project_update", []);
    return done;
  };
  const rows = await fn<{ found: boolean; refused: string[] }>(SQL.updateProject, [
    valid.project,
    sessionId,
    rename === undefined
      ? null
      : // Under the project's own label, which the row keeps: a caller cleared for more seals no
        // name that the project's other readers could not open.
        sealSummary(ctx, row.compartments, { table: "knowledge.projects", id: row.id, column: "name_enc" }, rename),
    valid.ownerRole !== undefined,
    valid.ownerRole ?? null,
    valid.goal !== undefined,
    valid.goal ?? null,
    valid.dueAt !== undefined,
    valid.dueAt ?? null,
    says,
    valid.area !== undefined,
    area,
  ]);
  if (isRefused(rows)) return undo(refused(rows));
  const [answer] = rows;
  if (answer === undefined || !answer.found) return undo(refused("not_found"));
  const refusedFields = answer.refused.flatMap((one): FieldRefusal[] => {
    const [field, code] = one.split(":") as [Field, "owner_set" | "not_active"];
    // The function says `status` for what the caller says of the project: its status, its note.
    if (field !== "status") return [{ field, code }];
    return [
      ...(valid.status === undefined ? [] : [{ field: "status" as const, code }]),
      ...(valid.note === undefined ? [] : [{ field: "note" as const, code }]),
    ];
  });
  let record: AgentRecordId | undefined;
  if (says && !refusedFields.some((one) => one.field === "status" || one.field === "note")) {
    // The shared taint lock before an append, as the record tool takes it.
    await ctx.run(SQL.taintShared, []);
    const written = await appendRecord(ctx, {
      kind: "finding",
      body: valid.note ?? `Status: ${valid.status}`,
      project: row.id,
      requestId: derived(valid.requestId, "record"),
      ...(valid.status === undefined
        ? {}
        : {
            claims: [
              {
                subject: { id: row.id },
                type: "project.status",
                fields: { status: valid.status },
                cites: [],
                requestId: derived(valid.requestId, "claim"),
              },
            ],
          }),
    });
    if (!written.outcome.ok) return undo({ outcome: written.outcome, rows: 0 });
    // A status the write path would not take is no status said.
    if ((written.outcome.value.refused ?? []).length > 0) return undo(refused("invalid_request"));
    record = written.outcome.value.recordId as AgentRecordId;
  }
  await ctx.run("release savepoint project_update", []);
  const [after] = await ctx.run<Row>(SQL.project, [valid.project]);
  if (after === undefined) return refused("not_found");
  const context = await around(call, [after]);
  if (isRefused(context)) return refused(context);
  const read = await readProject(ctx, after, context.creators, context.events);
  return {
    outcome: {
      ok: true,
      value: {
        project: after.id,
        status: read.standing,
        ...(record === undefined ? {} : { record }),
        ...(refusedFields.length === 0 ? {} : { refused: refusedFields }),
      },
    },
    rows: 1,
    shown: [...new Set([...read.shown, ...(record === undefined ? [] : [record as string])])],
    bound: read.bound,
  };
}

// B7: the projects the caller can see, the most recently changed first. With a status filter the
// page looks at no more than SCAN projects; `next` then continues from the last one looked at.
export async function listProjects(
  call: WorkCall,
  valid: Args<"list_projects">,
): Promise<Done<Result<"list_projects">>> {
  const { ctx } = call;
  const limit = valid.limit ?? 25;
  const byArea = valid.order === "area";
  const cursor = cursorAt(valid.after, byArea);
  if (cursor === null) return refused("invalid_request");
  const reach = valid.status === undefined ? limit : SCAN;
  const rows = await ctx.run<Sorted>(
    byArea ? SQL.pageByArea : SQL.page,
    byArea
      ? [cursor.at, cursor.id, reach + 1, valid.area ?? null, cursor.rank, cursor.sort]
      : [cursor.at, cursor.id, reach + 1, valid.area ?? null],
  );
  const areas = (await ctx.run<AreaRow>(SQL.areas, [AREAS_LISTED])).map((one) => areaView(ctx, one));
  const scanned = rows.slice(0, reach);
  const context = await around(call, scanned);
  if (isRefused(context)) return refused(context);
  const projects: ProjectView[] = [];
  const shown: string[] = [];
  const bound: string[] = [];
  let last: Sorted | undefined;
  for (const row of scanned) {
    if (projects.length === limit) break;
    last = row;
    const read = await readProject(ctx, row, context.creators, context.events);
    if (valid.status !== undefined && !valid.status.includes(read.standing.value)) continue;
    projects.push(viewOf(ctx, row, read.standing, context.creators, context.goals, context.areas));
    shown.push(...read.shown);
    bound.push(...read.bound);
  }
  const more = last !== undefined && rows.indexOf(last) < rows.length - 1;
  return {
    outcome: {
      ok: true,
      value: { projects, areas, ...(more && last !== undefined ? { next: cursorOf(last) } : {}) },
    },
    rows: projects.length,
    shown: [...new Set(shown)],
    bound: [...new Set(bound)],
    goals: [...new Set(projects.flatMap((one) => (one.goal === null ? [] : [one.goal as string])))].sort(byText),
  };
}

const noteOf = (fact: FactView, clients: ReadonlyMap<string, ClientName>): ProjectNote | null => {
  const fields = fact.fields as unknown as { what?: { untrusted: string }; who?: Who; due?: string };
  if (fields.what === undefined) return null;
  return {
    what: fields.what,
    at: fact.at,
    by: saidBy(fact, clients),
    ...(fact.record === undefined ? {} : { record: fact.record }),
    ...(fields.who === undefined ? {} : { who: fields.who }),
    ...(fields.due === undefined ? {} : { due: fields.due }),
  };
};

const FIELD_OF: Readonly<Record<string, Extract<ProjectChange, { kind: "field" }>["field"]>> = {
  name: "name",
  owner_role: "owner_role",
  goal: "goal",
  due_at: "due_at",
};

// B7: one project: its fields, where it stands, its open work by holder with each one's latest
// progress, last reports, latest check-back and latest hand-off, its next steps and decisions, and
// what changed in the last seven days, in one call.
export async function getProject(
  call: WorkCall,
  valid: Args<"get_project">,
  now: () => Date,
): Promise<Done<Result<"get_project">>> {
  const { ctx } = call;
  const [row] = await ctx.run<Row>(SQL.project, [valid.project]);
  if (row === undefined || row.status === "merged") return refused("not_found");
  const context = await around(call, [row]);
  if (isRefused(context)) return refused(context);
  const read = await readProject(ctx, row, context.creators, context.events);
  const open = await boardRows(call, PROJECT_WORK_LISTED + 1, { tier: null, role: null, project: row.id });
  if (!Array.isArray(open)) return open;
  const work = open.slice(0, PROJECT_WORK_LISTED);
  // How each went: its last reports, its latest check-back and its latest hand-off.
  const trails = await trailOf(
    ctx,
    work.map((one) => one.view.id),
  );
  const notes = (type: string): ProjectNote[] =>
    read.facts.flatMap((fact) => (fact.type === type ? (noteOf(fact, read.clients) ?? []) : []));
  const steps = notes("project.next_step");
  const decisions = notes("project.decision");

  const since = new Date(now().getTime() - PROJECT_CHANGE_DAYS * 86_400_000);
  const recent = (at: string | Date): boolean => new Date(at).getTime() >= since.getTime();
  const stepped = await ctx.run<{ row_id: string; event: string; at: Date }>(SQL.workEvents, [
    row.id,
    stamp(since),
    PROJECT_CHANGES_LISTED + 1,
  ]);
  const changes: ProjectChange[] = [
    ...read.facts.flatMap((fact): ProjectChange[] =>
      fact.type === "project.status" && recent(fact.at)
        ? [
            {
              kind: "status",
              at: fact.at,
              value: fact.fields.status as ProjectStandingValue,
              by: saidBy(fact, read.clients),
            },
          ]
        : [],
    ),
    ...context.events.flatMap((event): ProjectChange[] => {
      if (!recent(event.at)) return [];
      const by = event.by === "owner" ? ("owner" as const) : ("agent" as const);
      if (event.event === "closed")
        return [{ kind: "status", at: stamp(event.at), value: "closed", by: { kind: "owner" } }];
      if (event.event === "created") return [{ kind: "field", at: stamp(event.at), field: "created", by }];
      const field = event.code === null ? undefined : FIELD_OF[event.code];
      return field === undefined ? [] : [{ kind: "field", at: stamp(event.at), field, by }];
    }),
    ...stepped.map(
      (step): ProjectChange => ({
        kind: "work",
        at: stamp(step.at),
        opportunity: step.row_id as OpportunityId,
        event: step.event,
      }),
    ),
  ].sort((a, b) => byText(b.at, a.at) || byText(a.kind, b.kind));
  const more =
    open.length > PROJECT_WORK_LISTED ||
    read.moreFacts ||
    steps.length > PROJECT_NOTES_LISTED ||
    decisions.length > PROJECT_NOTES_LISTED ||
    changes.length > PROJECT_CHANGES_LISTED;
  const view = viewOf(ctx, row, read.standing, context.creators, context.goals, context.areas);
  return {
    outcome: {
      ok: true,
      value: {
        ...view,
        work: work.map((one) => ({ ...one.view, ...trails.get(one.view.id) })),
        nextSteps: steps.slice(0, PROJECT_NOTES_LISTED),
        decisions: decisions.slice(0, PROJECT_NOTES_LISTED),
        changes: changes.slice(0, PROJECT_CHANGES_LISTED),
        more,
      },
    },
    rows: 1,
    shown: [...new Set([...read.shown, ...work.flatMap((one) => one.shown)])],
    bound: read.bound,
    goals: [
      ...new Set([...work.flatMap((one) => one.goals), ...(view.goal === null ? [] : [view.goal as string])]),
    ].sort(byText),
  };
}
