import {
  type AgentLongWork,
  type ClientName,
  type EntityId,
  LONG_WORK_LISTED,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityKind,
  type OpportunityStatus,
  type OwnerLongWork,
  type RoleName,
  type WorkProgress,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { type Query, stamp, stampOrNull } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { latestEvent, latestRow, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "../../core/statements.ts";
import { openedProgress } from "../../core/work-progress.ts";

// Work that lasts days, as the owner follows it, as pi_admin: each open piece of work with the
// client that has it (under a live lease, or as its last holder while the work is still its alone)
// and since when, its latest progress report, and the holder's soonest waiting check-back that
// holds the work to a date. Work rows are the owner's own ledger; tainted opportunities, moves and
// reports are left out, as the work views leave them. No belief is read. A summary and a progress
// report's lines are the agent's own words, opened and marked { untrusted }; one whose key the key
// file lacks is null.

// Open work, with its route as the board reads it (the latest hand-off's role, else the row's),
// its holder under a live lease at $1, its last holder inside its hold, its latest claim, and the
// holder's soonest check-back still set that holds the work.
// With $3, only the work filed under those projects.
const OPEN_WORK = `
  select o.id, o.kind, o.tier, o.compartments, o.body_enc, o.project_id, o.due_at, s.event as status,
    case when exists (${OPPORTUNITY_ROUTED}) then (${ROUTED_ROLE}) else o.role end as role,
    (select c.name from queue.leases l join policy.clients c on c.id = l.holder
     where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= $1) as holder,
    -- The last holder while the work is still its alone (A2, A5), by the one rule (ledger.work_held):
    -- its lease lapsed under 24 hours ago, a check-back's return still prefers it, or a check-back
    -- of its own holds the work.
    (select c.name from queue.leases l join policy.clients c on c.id = l.holder and c.status = 'active'
     where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until < $1
       and ledger.work_held(o.id, $1)) as last_holder,
    -- When that holder's lease ran out, and until when the work is its alone with no check-back
    -- holding it: the later of its 24 hours and a check-back's return.
    (select l.lease_until from queue.leases l
     where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until < $1) as lapsed_at,
    (select greatest(l.lease_until + interval '24 hours', l.preferred_until) from queue.leases l
     where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until < $1) as theirs_until,
    (select max(r.at) from ledger.record_events r
     where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed') as claimed_at,
    cb.due_at as parked_until, cb.client as parked_by
  from ledger.opportunities o
  join lateral (${latestRow("r.event", "opportunity", "o.id")}) s on true
  left join lateral (
    select i.due_at, (select c.name from policy.clients c where c.id = i.client_id) as client
    from ledger.intentions i
    where i.opportunity_id = o.id and i.kind = 'check_back' and i.tainted_at is null and i.hold
      and i.client_id = (select l.holder from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id)
      and (${latestEvent("intention", "i.id")}) = 'set'
    order by i.due_at, i.id collate "C"
    limit 1) cb on true
  where o.tainted_at is null and s.event = any ($2::text[])
    and ($3::text[] is null or o.project_id = any ($3::text[]))
  order by o.id collate "C"`;

// The latest progress report on each piece of work named, with its reporter's name, as
// ledger.work_progress picks it for an agent.
const PROGRESS = `
  select distinct on (m.opportunity_id) m.opportunity_id, m.id as move_id, r.at, k.name as by_name, r.compartments, r.body_enc
  from ledger.moves m
  join ledger.record_events r on r.row_kind = 'move' and r.row_id = m.id and r.event = 'reported' and r.code = 'progress'
    and r.tainted_at is null and r.body_enc is not null
  join policy.clients k on 'client:' || k.id = r.by
  where m.opportunity_id = any ($1::text[]) and m.tainted_at is null
  order by m.opportunity_id, r.id desc`;

type WorkRow = {
  id: OpportunityId;
  kind: OpportunityKind;
  tier: string;
  compartments: string[];
  body_enc: Sealed;
  project_id: string | null;
  due_at: Date | null;
  status: OpportunityStatus;
  role: RoleName | null;
  holder: ClientName | null;
  last_holder: ClientName | null;
  lapsed_at: Date | null;
  theirs_until: Date | null;
  claimed_at: Date | null;
  parked_until: Date | null;
  parked_by: ClientName | null;
};
type ProgressRow = {
  opportunity_id: string;
  move_id: string;
  at: Date;
  by_name: string;
  compartments: string[];
  body_enc: Sealed;
};

// The open work, of every project or of the ones given, each with its latest progress.
export async function openLongWork(
  query: Query,
  keys: Keys,
  now: Date,
  projects: readonly string[] | null = null,
): Promise<OwnerLongWork[]> {
  const rows = await query<WorkRow>(OPEN_WORK, [stamp(now), [...OPEN_STATUSES], projects]);
  const reports = await query<ProgressRow>(PROGRESS, [rows.map((row) => row.id)]);
  const progress = new Map<string, WorkProgress>();
  for (const report of reports) {
    const text = open(
      keys,
      { ...report, id: `${report.move_id}/reported` },
      "ledger.record_events.body_enc",
      "withheld",
    );
    if (text !== null) progress.set(report.opportunity_id, openedProgress(text, report.at, report.by_name));
  }
  return rows.map((row) => {
    const summary = open(keys, row, "ledger.opportunities.body_enc", "withheld");
    const held = row.status === "claimed" && row.holder !== null;
    // Not under a live lease, and still its last holder's alone.
    const lapsed = !held && (row.status === "claimed" || row.status === "go") && row.last_holder !== null;
    return {
      opportunity: row.id,
      kind: row.kind,
      task: row.tier === "task",
      status: row.status,
      role: row.role,
      holder: held ? row.holder : lapsed ? row.last_holder : null,
      lapsed,
      lapsedAt: lapsed ? stampOrNull(row.lapsed_at) : null,
      theirsUntil: lapsed ? stampOrNull(row.theirs_until) : null,
      since: held || lapsed ? stampOrNull(row.claimed_at) : null,
      project: row.project_id as EntityId | null,
      dueAt: stampOrNull(row.due_at),
      summary: summary === null ? null : { untrusted: summary },
      progress: progress.get(row.id) ?? null,
      parkedBy: row.parked_until === null ? null : row.parked_by,
      parkedUntil: stampOrNull(row.parked_until),
    };
  });
}

// The longest held first, then the parked by when each is due back; work with neither is last.
export function longestHeldFirst(work: readonly OwnerLongWork[]): OwnerLongWork[] {
  const place = (one: OwnerLongWork): string => one.since ?? `~${one.parkedUntil ?? "~"}`;
  return [...work].sort((a, b) =>
    place(a) < place(b) ? -1 : place(a) > place(b) ? 1 : a.opportunity < b.opportunity ? -1 : 1,
  );
}

// The dashboard's read of who is on what: the work an agent holds under a live lease, and the
// work parked for later, the longest held first.
export async function agentLongWork(admin: AdminContext): Promise<AgentLongWork> {
  const now = admin.now();
  const open = await admin.transaction((query) => openLongWork(query, admin.keys, now));
  const followed = longestHeldFirst(open.filter((one) => one.holder !== null || one.parkedUntil !== null));
  return {
    at: stamp(now),
    work: followed.slice(0, LONG_WORK_LISTED),
    more: followed.length > LONG_WORK_LISTED,
  };
}
