import {
  type EntityId,
  ExploreLacks,
  GAP_MISSING,
  type GapTrigger,
  type GoalId,
  gapAsk,
  type HypothesisId,
  type IdeaStatus,
  nextStageOf,
  OPEN_STATUSES,
  type OpportunityId,
  type OpportunityKind,
  type OpportunityStatus,
  type OpportunityView,
  type RoleName,
  type Stage,
  type UntrustedString,
  type WorkTier,
} from "@intelligence/contracts/personal";
import { byText, stamp, stampOrNull } from "./db.ts";
import { type Ctx, servedOrNull, Unavailable } from "./read-ctx.ts";
import { latestEvent, moveStatus, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "./statements.ts";
import { goalIds, storedAbout, storedBasisRef } from "./work-refs.ts";

// OpportunityView, built under the caller's token: only rows the reader's policies return, so every
// list, count and order here is over rows the caller can see. Its status is its latest status
// event, its next stage the first stage of its kind's plan with no move `done`, its lease the
// caller's own and live (the lease policy returns no other's; one that ran out is no lease), and
// its summary opened under its own label and wrapped as untrusted.

// The opportunities named, not tainted, with their latest status and the caller's lease; the
// tier, and the route: the role of the latest hand-off (or none it handed to), else the role at
// proposal.
const OPPORTUNITIES = `
  select o.id, o.kind, o.about_kind, o.about_id, o.hypothesis_id, o.goal_id, o.due_at, o.compartments, o.body_enc, o.gap_trigger, o.gap_subject, o.gap_missing, o.tier,
    o.parent_id,
    (select p.id from knowledge.projects p where p.id = o.project_id) as project_id,
    (select par.id from ledger.opportunities par where par.id = o.parent_id and par.tainted_at is null) as parent_seen,
    case when exists (${OPPORTUNITY_ROUTED})
      then (${ROUTED_ROLE})
      else o.role end as role,
    (${latestEvent("opportunity", "o.id")}) as status,
    (select l.lease_until from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= now()) as lease_until
  from ledger.opportunities o
  where o.id = any($1) and o.tainted_at is null
  order by o.id`;
// Each one's refs, in the order they were written.
const BASIS = `
  select b.row_id, b.ref_kind, b.ref_id, b.evidence_id from ledger.basis b
  where b.row_kind = 'opportunity' and b.row_id = any($1)
  order by b.row_id, b.id`;
// The stages each one has a move `done` for: a move's status is its latest event but a report.
const DONE = `
  select m.opportunity_id, m.stage from ledger.moves m
  where m.opportunity_id = any($1)
    and (${moveStatus()}) = 'done'
  order by m.opportunity_id, m.id`;
// The open work each one waits on, as ledger.claimable_by reads it: a dependency whose blocker's
// latest status is an open one, and that no deletion tainted (tainted work is closed: nobody can
// finish it). A dependency carries its work's label and names only work within it, so the caller
// that sees the work sees these too.
const OPEN_BLOCKERS = `
  select d.opportunity_id, d.blocked_by from ledger.work_dependencies d
  where d.opportunity_id = any($1)
    and exists (select 1 from ledger.opportunities b where b.id = d.blocked_by and b.tainted_at is null)
    and (${latestEvent("opportunity", "d.blocked_by")}) = any($2)
  order by d.opportunity_id, d.blocked_by`;
// The evidence of a message or an event an opportunity is about, where the caller sees it.
const ABOUT_EVIDENCE = `
  select m.id, m.evidence_id from knowledge.messages m where m.id = any($1)
  union all
  select v.id, v.evidence_id from knowledge.events v where v.id = any($1)
  order by 1`;

type Row = {
  id: string;
  kind: OpportunityKind;
  about_kind: string;
  about_id: string | null;
  hypothesis_id: string | null;
  goal_id: string | null;
  due_at: Date | null;
  compartments: string[];
  body_enc: unknown;
  gap_trigger: GapTrigger | null;
  gap_subject: string | null;
  gap_missing: string[] | null;
  status: OpportunityStatus | null;
  lease_until: Date | null;
  tier: WorkTier;
  role: RoleName | null;
  // The project, where the caller's token returns it; the parent, where it returns that work.
  project_id: string | null;
  parent_id: string | null;
  parent_seen: string | null;
};

// A view, with the evidence ids of the message and event refs it returns (`shown`) and the ids of
// the agent records among them, and the goal ids it returns.
export type Built = { view: OpportunityView; shown: string[]; goals: string[] };

// A sealed summary, opened under every compartment of its row. One whose compartment key the
// call was not given (a key file that lacks it) is served as null; one that does not open with
// the keys it has is a fault.
export function opportunitySummary(
  ctx: Ctx,
  row: Pick<Row, "id" | "compartments" | "body_enc">,
): UntrustedString | null {
  return servedOrNull(
    ctx.keys,
    row.compartments,
    { table: "ledger.opportunities", id: row.id, column: "body_enc" },
    row.body_enc,
  );
}

// What a gap flag finds missing; for a commitment_due task, its commitment's fact, the first part
// of its subject (the fact key and the due's date); for a close_no_tie task, what it asks; for an
// explore task, its own list of what its node lacks, `lacks`; for a defect's task, what it asks
// names the defect by id.
const gapOf = (
  trigger: GapTrigger,
  subject: string | null,
  missing: string[] | null,
): NonNullable<OpportunityView["gap"]> => {
  const ask = gapAsk(trigger, subject);
  const gap =
    trigger === "commitment_due" && subject !== null
      ? { trigger, missing: GAP_MISSING[trigger], fact: subject.slice(0, 64) }
      : { trigger, missing: GAP_MISSING[trigger] };
  const lacks = trigger === "explore" && missing !== null ? { lacks: ExploreLacks.parse(missing) } : {};
  return ask === undefined ? { ...gap, ...lacks } : { ...gap, ask, ...lacks };
};

// The agent records among a basis that the caller's own row policy returns (label, the writer's
// views, flag): a record ref is shown only to one who could read the record (invariant 6).
const VISIBLE_RECORDS = "select w.id from ledger.agent_writes w where w.id = any($1::text[])";

// The views of the ids named that the caller can see, by id. The same five statements run
// whatever is found. `summaries`: open only these ids' summaries, the rest served as null (the
// board opens only the caller's own); all when not given.
export async function opportunityViews(
  ctx: Ctx,
  ids: readonly string[],
  summaries?: ReadonlySet<string>,
): Promise<Map<string, Built>> {
  const rows = await ctx.run<Row>(OPPORTUNITIES, [ids]);
  const found = rows.map((row) => row.id);
  const basis = await ctx.run<{ row_id: string; ref_kind: string; ref_id: string; evidence_id: string | null }>(BASIS, [
    found,
  ]);
  const done = await ctx.run<{ opportunity_id: string; stage: Stage }>(DONE, [found]);
  const abouts = rows
    .filter((row) => row.about_kind === "message" || row.about_kind === "event")
    .map((row) => row.about_id as string);
  const aboutEvidence = new Map(
    (await ctx.run<{ id: string; evidence_id: string }>(ABOUT_EVIDENCE, [abouts])).map((row) => [
      row.id,
      row.evidence_id,
    ]),
  );
  // An owner_request is an agent record too, its relaying agent's note.
  const isRecord = (kind: string): boolean => kind === "agent_record" || kind === "owner_request";
  const records = basis.filter((one) => isRecord(one.ref_kind)).map((one) => one.ref_id);
  const visible = new Set((await ctx.run<{ id: string }>(VISIBLE_RECORDS, [records])).map((row) => row.id));
  const waits = new Map<string, OpportunityId[]>();
  for (const one of await ctx.run<{ opportunity_id: string; blocked_by: string }>(OPEN_BLOCKERS, [
    found,
    [...OPEN_STATUSES],
  ]))
    waits.set(one.opportunity_id, [...(waits.get(one.opportunity_id) ?? []), one.blocked_by as OpportunityId]);

  const views = new Map<string, Built>();
  for (const row of rows) {
    // A row with no status event is no opportunity yet; it cannot be served.
    if (row.status === null) throw new Unavailable();
    const refs = basis.filter((one) => one.row_id === row.id && (!isRecord(one.ref_kind) || visible.has(one.ref_id)));
    const stages = new Set(done.filter((one) => one.opportunity_id === row.id).map((one) => one.stage));
    const shown = refs.flatMap((one) =>
      one.evidence_id !== null && (one.ref_kind === "message" || one.ref_kind === "event") ? [one.evidence_id] : [],
    );
    const about = row.about_id === null ? undefined : aboutEvidence.get(row.about_id);
    if (about !== undefined) shown.push(about);
    shown.push(...refs.flatMap((one) => (isRecord(one.ref_kind) ? [one.ref_id] : [])));
    const view: OpportunityView = {
      id: row.id as OpportunityId,
      kind: row.kind,
      status: row.status,
      about: storedAbout(row.about_kind, row.about_id),
      summary: summaries === undefined || summaries.has(row.id) ? opportunitySummary(ctx, row) : null,
      basis: refs.map((one) => storedBasisRef(one.ref_kind, one.ref_id)),
      hypothesis: row.hypothesis_id as HypothesisId | null,
      goal: row.goal_id as GoalId | null,
      stage: nextStageOf(row.kind, stages),
      dueAt: stampOrNull(row.due_at),
      leaseUntil: row.lease_until === null ? null : stamp(row.lease_until),
      tier: row.tier,
      role: row.role,
      ...(row.gap_trigger === null ? {} : { gap: gapOf(row.gap_trigger, row.gap_subject, row.gap_missing) }),
      // A project or a parent the caller's token does not return is left out, as an absent one.
      ...(row.project_id === null ? {} : { project: row.project_id as EntityId }),
      ...(row.parent_seen === null ? {} : { parent: row.parent_seen as OpportunityId }),
      ...(waits.has(row.id) ? { blockedBy: waits.get(row.id) } : {}),
    };
    views.set(row.id, {
      view,
      shown: [...new Set(shown)].sort(byText),
      goals: goalIds([view.goal === null ? null : { kind: "goal", id: view.goal }, view.about, ...view.basis]),
    });
  }
  return views;
}

// Soonest `dueAt` first, one with none last, then by id.
export const bySoonest = (a: OpportunityView, b: OpportunityView): number =>
  a.dueAt === b.dueAt
    ? byText(a.id, b.id)
    : a.dueAt === null
      ? 1
      : b.dueAt === null
        ? -1
        : byText(a.dueAt, b.dueAt) || byText(a.id, b.id);

// An idea as list_ideas and the owner's `pi ideas` read it.
export type IdeaRow = {
  id: string;
  filed_by: "you" | "agent" | "planner";
  created_at: Date;
  latest_at: Date;
  status: IdeaStatus;
  compartments: string[];
  body_enc: unknown;
  cited: number;
  evidence_kinds: string[];
  evidence_at: (Date | null)[];
};

// The kinds and times of an idea's newest evidence, as both reads give them.
export const evidenceOf = (row: Pick<IdeaRow, "evidence_kinds" | "evidence_at">) =>
  row.evidence_kinds.map((kind, n) => {
    const at = row.evidence_at[n];
    return { kind, at: at === null || at === undefined ? null : stamp(at) };
  });
