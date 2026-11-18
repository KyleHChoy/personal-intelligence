import {
  type ClientName,
  type ClientView,
  OPEN_STATUSES,
  type OpportunityView,
  type QuestionTried,
  type RoleName,
  type WorkStateRefusal,
  type WorkTier,
} from "@intelligence/contracts/personal";
import { GAP_VALUE_WINDOW_DAYS } from "@intelligence/personal-core/planner";
import { stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { latestEvent, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "../core/statements.ts";
import { type Held, heldByCaller } from "../core/work-held.ts";
import { progressOf } from "../core/work-progress.ts";
import {
  type Args,
  answered,
  type Briefed,
  type Done,
  invalidAs,
  isRefused,
  type Result,
  refused,
  refusedAs,
  value,
  type WorkCall,
} from "../core/work-refs.ts";
import { unreportedOf } from "../core/work-unreported.ts";
import { type Built, opportunityViews } from "../core/work-views.ts";
import { type Ctx, Unavailable } from "../read/read-ctx.ts";
import { samePersonLeft } from "./same-person-report.ts";
import { briefsOf, CURRENT_ROLES } from "./work-brief.ts";
import { closedBoard } from "./work-closed.ts";
import { payQuestion, unpaid } from "./work-questions.ts";
import { byStanding, standingRows } from "./work-standing.ts";

// Reading and holding the board: list_opportunities (scope closed: work-closed.ts), claim_opportunity,
// release_opportunity and hand_off, the work Work's call path runs for each.

// The most of the caller's own work scope `mine` reads before its page is cut.
const MINE_READ = 200;

// The statements, one for each function, with every argument typed.
const SQL = {
  grants: "select intent_id, opportunity_kind, stage, harness_mode_id, for_tasks from ledger.work_grants()",
  // Another client's check-back holds these for its 24 hours: the reader cannot see that lease row,
  // so the database answers the one boolean.
  blocked: "select opportunity_id from ledger.check_back_blocked($1::text[]) where blocked",
  // Another client's lapsed lease holds these for its 24 hours, the same one boolean.
  lapseHeld: "select opportunity_id from ledger.lapse_held($1::text[]) where held",
  declined: "select opportunity_id from ledger.declined_by_caller($1::text[])",
  candidates: `
    select o.id from ledger.opportunities o
    where o.tainted_at is null and o.kind = any($1)
      and (${latestEvent("opportunity", "o.id")}) = 'go'
    order by o.id`,
  // The board, of what the reader's policies return: the caller's own open opportunities, and every other one only once
  // decided and being worked: go or claimed. Soonest due first, then by id, paged here, before any view is built or
  // opened. The project filter ($6) reads the project through the caller's token, so a project it does not return files
  // nothing, as an absent one. The area filter reads the project's area the same way: work is in its project's area,
  // and an area the token does not return holds nothing. The tier and role filters ($4, $5, each null for any) apply
  // before the page is cut, the route as work-views.ts reads it (the latest hand-off's role, else the role at
  // proposal).
  board: `
    select b.id from (
      select o.id, o.due_at, o.created_by, o.tier,
        (select p.id from knowledge.projects p where p.id = o.project_id) as project_id,
        (select a.key from knowledge.projects p join knowledge.areas a on a.id = p.area_id where p.id = o.project_id) as area_key,
        case when exists (${OPPORTUNITY_ROUTED})
          then (${ROUTED_ROLE})
          else o.role end as role,
        (${latestEvent("opportunity", "o.id")}) as status
      from ledger.opportunities o
      where o.tainted_at is null
    ) b
    where ((b.created_by = $1 and b.status = any ($2)) or b.status in ('go', 'claimed'))
      and ($4::text is null or b.tier = $4) and ($5::text is null or b.role is not distinct from $5)
      and ($6::text is null or b.project_id = $6)
      and ($7::text is null or b.area_key = $7)
    order by b.due_at nulls last, b.id collate "C"
    limit $3`,
  holders: "select opportunity_id, holder from ledger.board_holders($1::text[])",
  authored: "select o.id from ledger.opportunities o where o.id = any ($1) and o.created_by = $2 order by o.id",
  stopped: "select ledger.work_stopped() as stopped",
  claim: "select ledger.claim($1::text, $2::text, $3::text, $4::text) as until",
  // Release with its reason and record; hand_off; the caller's roles.
  release: "select ledger.release($1::text, $2::text, $3::text, $4::text, $5::text) as released",
  handOff: "select ledger.hand_off($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) as handed",
  roles: CURRENT_ROLES,
} as const;

export async function listOpportunities(
  call: WorkCall,
  valid: Args<"list_opportunities">,
  now: () => Date,
): Promise<Briefed<Result<"list_opportunities">>> {
  const { ctx, fn } = call;
  if (valid.scope === "closed") {
    if (valid.project !== undefined || valid.area !== undefined) return refused("invalid_request");
    return closedBoard(call, valid.limit ?? 25, { tier: valid.tier ?? null, role: valid.role ?? null }, valid.after);
  }
  if (valid.after !== undefined) return refused("invalid_request");
  // The caller's roles route tasks, and the board shows them.
  const roles = await fn<{ mine: RoleName[]; all_roles: RoleName[] }>(SQL.roles, []);
  if (isRefused(roles)) return refused(roles);
  const { mine: myRoles, all_roles: every } = roles[0] ?? { mine: [], all_roles: [] };
  const wanted = (view: OpportunityView): boolean =>
    (valid.tier === undefined || view.tier === valid.tier) && (valid.role === undefined || view.role === valid.role);
  if (valid.scope === "board")
    return board(
      call,
      valid.limit ?? 25,
      { tier: valid.tier ?? null, role: valid.role ?? null, project: valid.project ?? null, area: valid.area ?? null },
      wanted,
      { mine: myRoles, all: every },
    );
  // The project and area filters are the board's.
  if (valid.project !== undefined || valid.area !== undefined) return refused("invalid_request");
  const grants = await fn<{ opportunity_kind: string; stage: string; for_tasks: boolean }>(SQL.grants, []);
  if (isRefused(grants)) return refused(grants);
  const kinds = [...new Set(grants.map((grant) => grant.opportunity_kind))];
  const mine = valid.scope === "mine";
  // Mine (A8): what the caller holds under a live lease, what a check-back of its own holds to a
  // date, and what is its alone to claim again: a lease that lapsed in the last 24 hours, or a
  // check-back of its own that came due.
  const own = mine ? await heldByCaller(ctx, kinds, MINE_READ) : new Map<string, Held>();
  const found = mine ? [...own.keys()] : (await ctx.run<{ id: string }>(SQL.candidates, [kinds])).map((row) => row.id);
  // Open: none that another client's check-back holds.
  const blocked = mine ? [] : await fn<{ opportunity_id: string }>(SQL.blocked, [found]);
  if (isRefused(blocked)) return refused(blocked);
  const held = new Set(blocked.map((row) => row.opportunity_id));
  // Open: none that a lapsed lease still holds for the client that held it.
  const lapsed = mine ? [] : await fn<{ opportunity_id: string }>(SQL.lapseHeld, [found]);
  if (isRefused(lapsed)) return refused(lapsed);
  for (const row of lapsed) held.add(row.opportunity_id);
  // Asked for: none the caller released or declined, whose decline is still in force.
  const declined =
    !mine && valid.excludeDeclined === true ? await fn<{ opportunity_id: string }>(SQL.declined, [found]) : [];
  if (isRefused(declined)) return refused(declined);
  for (const row of declined) held.add(row.opportunity_id);
  const ids = found.filter((id) => !held.has(id));
  const built = [...(await opportunityViews(ctx, ids)).values()].filter(
    ({ view }) =>
      wanted(view) &&
      // Open: the caller's grants cover its kind and its next stage, and a task's route is one of
      // its roles or none; and it waits on no open work, which no agent could claim. Mine: the
      // caller holds it or held it (A8), and its kind is still granted (none is while the kill
      // switch is on).
      (mine
        ? own.has(view.id)
        : view.blockedBy === undefined &&
          grants.some(
            (grant) =>
              grant.opportunity_kind === view.kind &&
              grant.stage === view.stage &&
              grant.for_tasks === (view.tier === "task"),
          ) &&
          (view.tier !== "task" ||
            view.role === null ||
            myRoles.includes(view.role) ||
            view.role === call.client.name)),
  );
  // Open: no same-person task whose every pair the caller has answered, which ledger.claimable_by does
  // not offer it.
  const isSamePerson = ({ view }: Built): boolean => view.gap?.trigger === "same_person";
  const left = mine
    ? new Set<string>()
    : await samePersonLeft(
        ctx,
        built.filter(isSamePerson).map(({ view }) => view.id),
      );
  const open = mine ? built : built.filter((one) => !isSamePerson(one) || left.has(one.view.id));
  // Open to take: by what each trigger's work was worth, as this caller can see it.
  const standing = mine
    ? []
    : await standingRows(ctx, new Date(now().getTime() - GAP_VALUE_WINDOW_DAYS * 86_400_000).toISOString());
  const order = byStanding(standing);
  const page = open.sort((a, b) => order(a.view, b.view)).slice(0, valid.limit ?? 25);
  const briefed = mine
    ? await briefsOf(
        call,
        page.map(({ view }) => view),
        now(),
      )
    : { briefs: new Map(), shown: [], bound: [], goals: [], lessons: [] };
  // Work the caller holds carries its latest progress, as its brief does.
  const opportunities = page.map(({ view }) => {
    const brief = briefed.briefs.get(view.id);
    const held = own.get(view.id)?.state;
    const stated = held === undefined ? view : { ...view, held };
    if (brief === undefined) return stated;
    return brief.progress === undefined ? { ...stated, brief } : { ...stated, progress: brief.progress, brief };
  });
  const unreported = mine ? await unreportedOf(ctx) : [];
  return {
    outcome: { ok: true, value: { opportunities, ...(unreported.length === 0 ? {} : { unreported }) } },
    rows: page.length,
    shown: [...new Set([...page.flatMap(({ shown }) => shown), ...briefed.shown])],
    bound: briefed.bound,
    goals: [...new Set([...page.flatMap(({ goals }) => goals), ...briefed.goals])],
    lessons: briefed.lessons,
  };
}

// The work board, whatever the kind, each item with the client holding a live lease on it. A
// summary only on the caller's own items: another client's was written under views the caller
// may lack. No brief: a brief is for the work the caller holds. With the tier and role filters,
// and the roles.
async function board(
  call: WorkCall,
  limit: number,
  filter: { tier: WorkTier | null; role: RoleName | null; project: string | null; area?: string | null },
  wanted: (view: OpportunityView) => boolean,
  roles: { mine: RoleName[]; all: RoleName[] },
): Promise<Done<Result<"list_opportunities">>> {
  const rows = await boardRows(call, limit, filter, wanted);
  if (!Array.isArray(rows)) return rows;
  return {
    outcome: { ok: true, value: { opportunities: rows.map(({ view }) => view), roles } },
    rows: rows.length,
    shown: [...new Set(rows.flatMap(({ shown }) => shown))],
    goals: [...new Set(rows.flatMap(({ goals }) => goals))],
  };
}

// The board's rows: each open item the caller can see, soonest due first, with the client holding a
// live lease on it and its latest progress report. With a project, only that project's work, and
// none for a project the caller cannot see. get_project lists a project's open work by it.
export async function boardRows(
  call: WorkCall,
  limit: number,
  filter: { tier: WorkTier | null; role: RoleName | null; project: string | null; area?: string | null },
  wanted: (view: OpportunityView) => boolean = () => true,
): Promise<Built[] | Done<never>> {
  const { client, ctx, fn } = call;
  const author = `client:${client.id}`;
  const found = await ctx.run<{ id: string }>(SQL.board, [
    author,
    [...OPEN_STATUSES],
    limit,
    filter.tier,
    filter.role,
    filter.project,
    filter.area ?? null,
  ]);
  const ids = found.map((row) => row.id);
  const owned = new Set((await ctx.run<{ id: string }>(SQL.authored, [ids, author])).map((row) => row.id));
  const built = await opportunityViews(ctx, ids, owned);
  const page = ids.flatMap((id) => built.get(id) ?? []).filter(({ view }) => wanted(view));
  const shownIds = page.map(({ view }) => view.id);
  const holders = await fn<{ opportunity_id: string; holder: ClientName }>(SQL.holders, [shownIds]);
  if (isRefused(holders)) return refused(holders);
  const holderOf = new Map(holders.map((row) => [row.opportunity_id, row.holder]));
  const progress = await progressOf(ctx, shownIds);
  return page.map((one) => {
    const holder = holderOf.get(one.view.id);
    const latest = progress.get(one.view.id);
    return {
      ...one,
      view: {
        ...one.view,
        ...(holder === undefined ? {} : { holder }),
        ...(latest === undefined ? {} : { progress: latest }),
      },
    };
  });
}

export async function claimOpportunity(
  call: WorkCall,
  valid: Args<"claim_opportunity">,
  now: () => Date,
): Promise<Briefed<Result<"claim_opportunity">>> {
  const { ctx, session, fn } = call;
  const rows = await fn<{ until: Date | null }>(SQL.claim, [valid.id, newId("asg"), valid.requestId, await session()]);
  if (isRefused(rows)) return refused(rows);
  const until = value(rows, "until");
  if (until === null) {
    // Work the caller sees says why, from what its view shows; any other stays a plain not_found.
    const seen = (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view;
    // The owner's stop of all agent work refuses every claim and renewal, of work the caller sees as of work it holds: said so, since the stop is the
    // owner's control over every agent.
    if (seen !== undefined && OPEN_STATUSES.includes(seen.status)) {
      const stopped = await fn<{ stopped: boolean }>(SQL.stopped, []);
      if (!isRefused(stopped) && stopped[0]?.stopped === true) return refusedAs("kill_switch");
    }
    if (seen?.status === "claimed" && seen.leaseUntil === null) return refusedAs("work_held");
    // Back on the board, and its last holder's alone for 24 hours after its lease lapsed.
    if (seen?.status === "go") {
      const lapsed = await fn<{ opportunity_id: string }>(SQL.lapseHeld, [[valid.id]]);
      if (!isRefused(lapsed) && lapsed.length > 0) return refusedAs("work_held");
      // Or its holder's alone for the 24 hours after a check-back of that holder's came due.
      const preferred = await fn<{ opportunity_id: string }>(SQL.blocked, [[valid.id]]);
      if (!isRefused(preferred) && preferred.length > 0) return refusedAs("work_held");
    }
    if (seen === undefined) return refused("not_found");
    if (!OPEN_STATUSES.includes(seen.status)) return refusedAs("work_closed");
    // Open work the caller sees and cannot take, by what its view shows: it waits on the owner, on
    // other work, or on a role the caller does not hold, or it is of a kind the caller is not cleared
    // for at its next stage. Any other cause (a veto) is not the caller's to see, and stays a plain
    // not_found.
    if (seen.status !== "go" && seen.status !== "claimed") return refusedAs("not_go");
    if (seen.blockedBy !== undefined) return refusedAs("work_blocked");
    if (seen.tier === "task" && seen.role !== null) {
      const roles = await fn<{ mine: RoleName[] }>(SQL.roles, []);
      if (!isRefused(roles) && seen.role !== call.client.name && !(roles[0]?.mine ?? []).includes(seen.role))
        return refusedAs("work_for_other_role");
    }
    // A same-person batch whose every pair the caller has answered is not its to take: it waits for
    // another agent.
    if (seen.gap?.trigger === "same_person" && !(await samePersonLeft(ctx, [valid.id])).has(valid.id))
      return refusedAs("work_held");
    // Not cleared: no grant of the caller's own, as scope open filters by them, for its kind at its
    // next stage (for a task, under the task intent; none at all while the owner's permission is
    // off). A grant that is there and still not enough (a veto, a mode, another intent's decision)
    // stays a plain not_found.
    const grants = await fn<{ opportunity_kind: string; stage: string; for_tasks: boolean }>(SQL.grants, []);
    const cleared = (grant: { opportunity_kind: string; stage: string; for_tasks: boolean }): boolean =>
      grant.opportunity_kind === seen.kind && grant.stage === seen.stage && (seen.tier !== "task" || grant.for_tasks);
    if (!isRefused(grants) && seen.stage !== null && !grants.some(cleared)) return refusedAs("no_harness_mode");
    return refused("not_found");
  }
  const built = (await opportunityViews(ctx, [valid.id])).get(valid.id);
  if (built === undefined) throw new Unavailable();
  const { briefs, shown, bound, goals, lessons } = await briefsOf(call, [built.view], now());
  const brief = briefs.get(built.view.id);
  return {
    ...answered(
      {
        opportunity: brief?.progress === undefined ? built.view : { ...built.view, progress: brief.progress },
        leaseUntil: stamp(until),
        brief,
      },
      [...new Set([...built.shown, ...shown])],
      [...new Set([...built.goals, ...goals])],
    ),
    bound,
    lessons,
  };
}

// The caller's own handoff record as its token returns it: its kind, its writer, whether it was
// removed since (no body), whether the writer has taken it in (it has its evidence id), and whether
// its label is wider than the work's, which ledger.add_basis refuses. The work's label is read under
// the caller's own policies, so for work it cannot see `wider` is null and nothing is told; the
// record's label is within the caller's clearance, or the record is not returned at all.
const HANDOFF_RECORD = `
  select w.kind, w.client_name, w.body_enc is null as removed, w.evidence_id is not null as taken_in,
    (select not (w.compartments <@ o.compartments) from ledger.opportunities o where o.id = $2) as wider
  from ledger.agent_writes w where w.id = $1`;

// Why a record cited on a release or a hand-off was not taken: none of the caller's own handoffs,
// one removed since, one the work's label cannot hold (a record's label is its writer's whole
// clearance, so writing it again would not help, and this is told before intake), or one the
// writer has not taken in yet. Null when the record itself is in order.
async function recordFault(
  ctx: Ctx,
  client: ClientView,
  record: string,
  work: string,
): Promise<WorkStateRefusal | null> {
  const [row] = await ctx.run<{
    kind: string;
    client_name: string;
    removed: boolean;
    taken_in: boolean;
    wider: boolean | null;
  }>(HANDOFF_RECORD, [record, work]);
  if (row === undefined || row.kind !== "handoff" || row.client_name !== client.name) return "record_not_your_handoff";
  if (row.removed) return "record_removed";
  if (row.wider === true) return "record_label_wider";
  return row.taken_in ? null : "record_not_taken_in";
}

export async function releaseOpportunity(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"release_opportunity">,
): Promise<Done<Result<"release_opportunity">>> {
  const rows = await fn<{ released: "released" | "declined" | null }>(SQL.release, [
    valid.id,
    valid.requestId,
    await session(),
    valid.reason ?? null,
    valid.record ?? null,
  ]);
  // The function refuses an argument only on work the caller sees, so naming which tells nothing
  // of work it does not: a task released with no reason, or a record that is not in order.
  if (rows === "invalid_request") {
    const seen = (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view;
    if (valid.reason === undefined && seen?.tier === "task") return invalidAs("release_needs_reason");
    const fault = valid.record === undefined ? null : await recordFault(ctx, client, valid.record, valid.id);
    return fault === null ? refused(rows) : invalidAs(fault);
  }
  if (isRefused(rows)) return refused(rows);
  // A release of work the caller could take and does not hold declines it.
  const answer = value(rows, "released");
  if (answer === "released") return answered({ released: true as const });
  if (answer === "declined") return answered({ declined: true as const });
  // Work the caller sees, neither held by it nor offered to it: nothing to release.
  const seen = (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view;
  if (seen === undefined) return refused("not_found");
  return refusedAs(OPEN_STATUSES.includes(seen.status) ? "work_not_held" : "work_closed");
}

// Work the caller holds, or held within 24 hours, to another role, to none, or to the owner.
export async function handOff(
  { client, ctx, session, fn }: WorkCall,
  valid: Args<"hand_off">,
): Promise<Done<Result<"hand_off">>> {
  // To the owner, a question pays up front: checked before anything is handed, and written on the
  // work once it is. Work the caller cannot see is the plain not_found, as every other refusal on
  // it is.
  const tried = valid.role === "owner" ? (valid.tried ?? null) : undefined;
  if (tried === null)
    return (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view === undefined
      ? refused("not_found")
      : unpaid();
  const call = { client, ctx, session, fn };
  const first = tried === undefined ? null : await payQuestion(call, valid.id, tried, false);
  if (first !== null) return first;
  // The hand-off and its mark are one unit: a mark refused after the hand-off undoes both. Only
  // the mark refuses question_unpaid there.
  await ctx.run(HAND_OFF_SAVEPOINT, []);
  const done = await handOffMarked(call, valid, tried);
  const undo = !done.outcome.ok && done.outcome.refusal === "question_unpaid";
  await ctx.run(undo ? HAND_OFF_ROLLBACK : HAND_OFF_RELEASE, []);
  return done;
}

const HAND_OFF_SAVEPOINT = "savepoint hand_off_paid";
const HAND_OFF_RELEASE = "release savepoint hand_off_paid";
const HAND_OFF_ROLLBACK = "rollback to savepoint hand_off_paid";

async function handOffMarked(
  call: WorkCall,
  valid: Args<"hand_off">,
  tried: QuestionTried | undefined,
): Promise<Done<Result<"hand_off">>> {
  const { client, ctx, session, fn } = call;
  const rows = await fn<{ handed: boolean | null }>(SQL.handOff, [
    valid.id,
    valid.requestId,
    await session(),
    valid.role ?? null,
    valid.reason,
    valid.record ?? null,
  ]);
  // Refused as an argument only on work the caller holds or held: to the owner with no note, a
  // task to the owner, or a record that is not in order.
  if (rows === "invalid_request") {
    if (valid.role === "owner" && valid.record === undefined) return invalidAs("owner_needs_record");
    const seen = (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view;
    if (valid.role === "owner" && seen?.tier === "task") return invalidAs("task_not_to_owner");
    const fault = valid.record === undefined ? null : await recordFault(ctx, client, valid.record, valid.id);
    return fault === null ? refused(rows) : invalidAs(fault);
  }
  if (isRefused(rows)) return refused(rows);
  if (value(rows, "handed") === true) {
    const marked = tried === undefined ? null : await payQuestion(call, valid.id, tried, true);
    return marked ?? answered({ handedOff: true as const });
  }
  const seen = (await opportunityViews(ctx, [valid.id])).get(valid.id)?.view;
  if (seen === undefined) return refused("not_found");
  return refusedAs(OPEN_STATUSES.includes(seen.status) ? "work_not_held" : "work_closed");
}
