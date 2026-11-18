import {
  type CardView,
  type EventId,
  type GoalNextStep,
  type GoalWork,
  type GoalWorkArgs,
  MoveId,
  MoveStatus,
  OPEN_STATUSES,
  OpportunityId,
  OpportunityStatus,
  OWNER_PAGE_MOST,
  type OwnerWorkItem,
  Stage,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { type Query, stamp } from "../../core/db.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { latestRow, moveStatus, ROUTED_ROLE } from "../../core/statements.ts";
import { waitingViews } from "../cards/admin-queue.ts";

// Apart from admin-owner-goals.ts, since reading a goal's waiting proposals (admin-queue.ts) from there
// would close an import cycle through the card kinds.

// An outcome link's goal_id is its opportunity's, copied at insert (ledger.outcome_links' before-insert
// check), so the links name no other work. Newest first, at most OWNER_PAGE_MOST. Untainted, within the
// owner's audience. Each with its status (its latest status event), role (a route's, else its own), holder
// (a live lease's client), latest move with its stage and status, latest applied outcome, and its summary,
// the agent's words, opened and marked as untrusted.
// ---------------------------------------------------------------------------------------------

const GOAL_WORK = `
  select o.id, o.kind, o.tier, o.compartments, o.body_enc, o.created_at, o.about_id,
    (${latestRow("r.event", "opportunity", "o.id", { and: "r.event = any ($3::text[])" })}) as status,
    coalesce((${ROUTED_ROLE}), o.role) as role,
    (select c.name from queue.leases l join policy.clients c on c.id = l.holder
     where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= now()) as holder,
    (${latestRow("r.at", "opportunity", "o.id", { and: "r.event = any ($3::text[])" })}) as status_at,
    o.due_at,
    (select d.starts_at from knowledge.events e join knowledge.event_details d on d.event_id = e.id
     where o.about_kind = 'event' and e.id = o.about_id and not d.cancelled
       and e.compartments <@ $2::text[] and d.compartments <@ $2::text[]
     order by d.starts_at limit 1) as event_at,
    v.id as move_id, v.stage as move_stage, v.created_at as move_at,
    (${moveStatus("v.id")}) as move_status,
    (select l.kind from ledger.outcome_links l where l.opportunity_id = o.id and l.applied and l.tainted_at is null and l.compartments <@ $2::text[] order by l.judged_at desc, l.id desc limit 1) as outcome
  from ledger.opportunities o
  left join lateral (
    select m.id, m.stage, m.created_at from ledger.moves m
    where m.opportunity_id = o.id and m.tainted_at is null and m.compartments <@ $2::text[]
    order by m.created_at desc, m.id collate "C" desc limit 1) v on true
  where o.id in (
      select x.id from ledger.opportunities x where x.goal_id = $1
      union
      select x.id from ledger.opportunities x where x.about_kind = 'goal' and x.about_id = $1 and x.tier = 'task')
    and o.tainted_at is null and o.compartments <@ $2::text[]
  order by o.created_at desc, o.id collate "C" desc
  limit ${OWNER_PAGE_MOST}`;

type WorkRow = {
  id: string;
  kind: OwnerWorkItem["kind"];
  tier: string;
  compartments: string[];
  body_enc: Sealed;
  created_at: Date;
  about_id: string | null;
  status: string | null;
  status_at: Date | null;
  due_at: Date | null;
  event_at: Date | null;
  role: OwnerWorkItem["role"];
  holder: OwnerWorkItem["holder"];
  move_id: string | null;
  move_stage: string | null;
  move_at: Date | null;
  move_status: string | null;
  outcome: OwnerWorkItem["outcome"];
};

// The changes proposed to the goal, whose waiting cards are its proposals beside its work's.
const GOAL_PROPOSALS = `select g.id from ledger.goal_proposals g where g.goal_id = $1 and g.tainted_at is null and g.compartments <@ $2::text[]`;

// The goal's next step (contracts owner-reads.ts GoalNextStep), from what the read already holds: the
// first waiting proposal; else the work handed to the owner longest ago; else the goal's open work by
// the soonest of its due date and the start, still to come, of the meeting it is about.
export type NextStepWork = Pick<WorkRow, "id" | "about_id" | "status" | "status_at" | "due_at" | "event_at">;
export function goalNextStep(
  proposals: readonly CardView[],
  work: readonly NextStepWork[],
  now: Date,
): GoalNextStep | null {
  const [card] = proposals;
  if (card !== undefined) {
    const on = card.target?.kind === "opportunity" ? OpportunityId.safeParse(card.target.id) : null;
    return { kind: "card", at: card.createdAt, opportunity: on?.success ? on.data : null, card: card.id, event: null };
  }
  const step = (kind: GoalNextStep["kind"], row: NextStepWork, at: Date, event: string | null = null) => ({
    kind,
    at: stamp(at),
    opportunity: row.id as OpportunityId,
    card: null,
    event: event as EventId | null,
  });
  const status = (row: NextStepWork): string => row.status ?? "proposed";
  const byTime = (a: { at: string }, b: { at: string }): number => a.at.localeCompare(b.at);
  const [handed] = work
    .flatMap((row) =>
      status(row) === "handed_to_owner" && row.status_at !== null ? [step("handed", row, row.status_at)] : [],
    )
    .sort(byTime);
  if (handed !== undefined) return handed;
  const [dated] = work
    .filter((row) => OPEN_STATUSES.some((open) => open === status(row)))
    .flatMap((row) => [
      ...(row.due_at === null ? [] : [step("due", row, row.due_at)]),
      ...(row.event_at === null || row.event_at < now ? [] : [step("event", row, row.event_at, row.about_id)]),
    ])
    .sort(byTime);
  return dated ?? null;
}

export function goalWork(admin: AdminContext, args: GoalWorkArgs): Promise<GoalWork> {
  return admin.transaction(async (query: Query) => {
    const audience = await ownerAudience(query);
    if (audience.length === 0) return { work: [], next: null, proposals: [] };
    const rows = await query<WorkRow>(GOAL_WORK, [args.goal, audience, OpportunityStatus.options]);
    const changes = (await query<{ id: string }>(GOAL_PROPOSALS, [args.goal, audience])).map((row) => row.id);
    const now = admin.now();
    const proposals = await waitingViews(query, now, null, OWNER_PAGE_MOST, [...changes, ...rows.map((row) => row.id)]);
    return {
      next: goalNextStep(proposals, rows, now),
      proposals,
      work: rows.map((row): OwnerWorkItem => {
        const moveStatus = MoveStatus.safeParse(row.move_status);
        return {
          opportunity: row.id as OwnerWorkItem["opportunity"],
          kind: row.kind,
          task: row.tier === "task",
          // An opportunity with no status event yet is proposed, the first of OPEN_STATUSES.
          status: (row.status ?? OPEN_STATUSES[0]) as OwnerWorkItem["status"],
          role: row.role,
          holder: row.holder,
          move:
            row.move_id === null || row.move_at === null
              ? null
              : {
                  id: MoveId.parse(row.move_id),
                  stage: Stage.parse(row.move_stage),
                  status: moveStatus.success ? moveStatus.data : null,
                  at: stamp(row.move_at),
                },
          outcome: row.outcome,
          summary:
            row.body_enc === null || !row.compartments.every((one) => admin.keys.compartments.has(one))
              ? null
              : {
                  untrusted: open(admin.keys, row, "ledger.opportunities.body_enc", "throw"),
                },
        };
      }),
    };
  });
}
