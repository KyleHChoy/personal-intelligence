import {
  isOpenStatus,
  type OpportunityId,
  type OpportunityStatus,
  OwnerTaskBody,
  type OwnerTaskRef,
  OwnerTaskWithdrawBody,
  RESTRICTED_PREFIX,
} from "@intelligence/contracts/personal";
import type { TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, sqlstateOf, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { sealUnder } from "../../core/seal.ts";
import { KILL_SWITCH_ALIASED, latestEvent, latestRow } from "../../core/statements.ts";
import { recordEvent, TASK_WITHDRAWN } from "../record-event.ts";

// The owner's tasks for their agents, as pi_admin, each in the caller's transaction and each one
// owner decision. A task is of a read-only kind, routed to a role, and its brief is built here by
// code from a fixed template, the ids the owner picked and their note, marked as the owner's: never
// claim, evidence or agent text. Its label is the union of `own` (the owner's note) and the labels
// of what it names; ledger.owner_task checks every ref is visible under it. Ids, kinds, roles and
// codes only are ever logged.

export type OwnerTaskResult = { task: OpportunityId; status: OpportunityStatus };

// The brief an agent is given, by code. The note is the last part and named as the owner's, so
// nothing the owner wrote can pass for the template.
export function ownerTaskBrief(body: Pick<OwnerTaskBody, "kind" | "role" | "about" | "note">): string {
  const about = body.about.length === 0 ? "nothing named" : body.about.map((ref) => `${ref.kind} ${ref.id}`).join(", ");
  return [
    `A task the owner opened themselves: ${body.kind}, for the ${body.role} role. Read-only: contact no one.`,
    `About: ${about}.`,
    "The owner's note, in their own words:",
    body.note,
  ].join("\n");
}

// A ref's label, and the basis refs it stands for: a fact stands for the message or event its
// claim was read from, so an erasure of that item taints the task. Not found for a ref that names
// nothing, a held message, or a fact read from neither.
async function resolve(
  query: Query,
  ref: OwnerTaskRef,
): Promise<{ label: string[]; basis: { kind: string; id: string }[] }> {
  const one = async (sql: string): Promise<string[] | undefined> =>
    (await query<{ compartments: string[] }>(sql, [ref.id]))[0]?.compartments;
  let label: string[] | undefined;
  let basis = [{ kind: ref.kind as string, id: ref.id as string }];
  if (ref.kind === "message")
    label = await one("select compartments from knowledge.messages where id = $1 and not held");
  else if (ref.kind === "goal") label = await one("select compartments from projections.goal_state where goal_id = $1");
  else if (ref.kind === "entity")
    // The narrowest label an account or a domain of the entity has, but a restricted one.
    label = await one(
      `select x.compartments from (select a.compartments from knowledge.accounts a where a.entity_id = $1 union all select d.compartments from knowledge.domains d where d.entity_id = $1) x
       where not policy.is_restricted(x.compartments) order by cardinality(x.compartments), array_to_string(x.compartments, ',') collate "C" limit 1`,
    );
  else {
    const [claim] = await query<{ compartments: string[]; message: string | null; event: string | null }>(
      `select c.compartments,
         (select m.id from knowledge.messages m where m.evidence_id = c.evidence_id and not m.held and m.compartments <@ c.compartments order by m.id limit 1) as message,
         (select v.id from knowledge.events v where v.evidence_id = c.evidence_id and v.compartments <@ c.compartments order by v.id limit 1) as event
       from knowledge.claims c where c.id = $1`,
      [ref.id],
    );
    if (claim === undefined || (claim.message === null && claim.event === null)) throw new AdminError("not_found");
    label = claim.compartments;
    basis =
      claim.message !== null
        ? [{ kind: "message", id: claim.message }]
        : [{ kind: "event", id: claim.event as string }];
  }
  if (label === undefined) throw new AdminError("not_found");
  return { label, basis };
}

// A repeated request id answers the first task and writes nothing. Refusals: invalid_argument for a
// body that does not parse; not_found for a ref that names nothing the owner can give an agent;
// not_permitted for a restricted label or while the task tier is off or the kill switch is on;
// unknown_role; already_ruled for work a veto of the owner's covers; unknown_compartment for a
// label the key file lacks.
export async function addOwnerTask({ query, keys, now }: TxAt, given: OwnerTaskBody): Promise<OwnerTaskResult> {
  const parsed = OwnerTaskBody.safeParse(given);
  if (!parsed.success) throw new AdminError("invalid_argument");
  const body = parsed.data;
  await lockRows(query, [`owner task ${body.requestId}`]);
  const [repeat] = await query<{ id: OpportunityId }>(
    "select target_id as id from knowledge.owner_decisions where request_id = $1 and kind = 'task_add'",
    [body.requestId],
  );
  if (repeat !== undefined) return { task: repeat.id, status: await statusOf(query, repeat.id) };
  // A request id already spent on another decision would write nothing in writeDecision.
  if ((await query("select 1 from knowledge.owner_decisions where request_id = $1", [body.requestId])).length > 0)
    throw new AdminError("invalid_argument");
  // The refusals the owner meets most, before anything is written; ledger.owner_task holds them too.
  const [state] = await query<{ tier: boolean; stopped: boolean }>(
    `select exists (select 1 from policy.intents where for_tasks and confirmed_at is not null and revoked_at is null) as tier,
       coalesce((${KILL_SWITCH_ALIASED}), 'off') = 'on' as stopped`,
  );
  if (state === undefined || !state.tier || state.stopped) throw new AdminError("not_permitted");
  if (
    (
      await query("select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)", [
        body.role,
      ])
    ).length === 0
  )
    throw new AdminError("unknown_role");

  const resolved: Awaited<ReturnType<typeof resolve>>[] = [];
  for (const ref of body.about) resolved.push(await resolve(query, ref));
  // The owner's note is their own words, so `own` is always in the label, with everything the task names.
  const label = [...new Set(["own", ...resolved.flatMap((one) => one.label)])].sort();
  if (label.some((compartment) => compartment.startsWith(RESTRICTED_PREFIX))) throw new AdminError("not_permitted");
  const seen = new Set<string>();
  const basis = resolved
    .flatMap((one) => one.basis)
    .filter((ref) => !seen.has(`${ref.kind} ${ref.id}`) && seen.add(`${ref.kind} ${ref.id}`));
  // Its subject: the first entity, goal or message the owner named, else the item of the first fact.
  const subject = body.about.find((ref) => ref.kind !== "fact") ?? basis[0];

  const id = newId("opp") as OpportunityId;
  let sealed: unknown;
  try {
    sealed = sealUnder(keys, label, { table: "ledger.opportunities", id, column: "body_enc" }, ownerTaskBrief(body));
  } catch {
    throw new AdminError("unknown_compartment");
  }
  const ruling = await ownerDecision(
    query,
    { requestId: body.requestId, kind: "task_add", target: { kind: "opportunity", id } },
    now,
  );
  try {
    const [row] = await query<{ opportunity_id: OpportunityId; status: OpportunityStatus }>(
      "select opportunity_id, status from ledger.owner_task($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9::text[], $10::text[], $11)",
      [
        id,
        body.requestId,
        body.kind,
        body.role,
        subject?.kind ?? "owner",
        subject?.id ?? null,
        JSON.stringify(sealed),
        basis.map((ref) => ref.kind),
        basis.map((ref) => ref.id),
        label,
        ruling,
      ],
    );
    if (row === undefined) throw new AdminError("invalid_argument");
    return { task: row.opportunity_id, status: row.status };
  } catch (error) {
    throw refusalOf(error);
  }
}

const REFUSALS: Readonly<Record<string, AdminError["code"]>> = {
  "22023": "invalid_argument",
  PIW01: "not_found",
  PIW04: "unknown_role",
  PIT01: "already_ruled",
  "42501": "not_permitted",
};
// The Admin's query wraps a database error as `unavailable` with its SQLSTATE as the cause.
const refusalOf = (error: unknown): unknown => {
  const code = sqlstateOf(error);
  return code !== undefined && code in REFUSALS ? new AdminError(REFUSALS[code] as AdminError["code"]) : error;
};

const statusOf = async (query: Query, id: string): Promise<OpportunityStatus> =>
  (await query<{ event: OpportunityStatus }>(`${latestRow("event", "opportunity", "$1", { alias: "" })}`, [id]))[0]
    ?.event ?? "proposed";

// A repeated request id writes nothing. Not found for an id that is none of the owner's open tasks;
// already_claimed once an agent has claimed it (`work cancel` then).
export async function withdrawOwnerTask({ query, now }: TxAt, given: OwnerTaskWithdrawBody): Promise<void> {
  const parsed = OwnerTaskWithdrawBody.safeParse(given);
  if (!parsed.success) throw new AdminError("invalid_argument");
  const { task: id, requestId } = parsed.data;
  await lockRows(query, [id]);
  const [spent] = await query<{ kind: string; target_id: string | null }>(
    "select kind, target_id from knowledge.owner_decisions where request_id = $1",
    [requestId],
  );
  if (spent !== undefined) {
    if (spent.kind === "task_withdraw" && spent.target_id === id) return;
    throw new AdminError("invalid_argument");
  }
  const [task] = await query<{ compartments: string[]; status: string | null; claimed: boolean }>(
    `select o.compartments, (${latestEvent("opportunity", "o.id")}) as status,
       exists (select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'claimed') as claimed
     from ledger.opportunities o where o.id = $1 and o.created_by = 'owner' and o.tier = 'task' and o.tainted_at is null`,
    [id],
  );
  // Open as cancelTask counts it.
  if (task === undefined || !isOpenStatus(task.status)) throw new AdminError("not_found");
  if (task.claimed) throw new AdminError("already_claimed");
  await ownerDecision(query, { requestId, kind: "task_withdraw", target: { kind: "opportunity", id } }, now);
  await recordEvent(query, TASK_WITHDRAWN, id, stamp(now), task.compartments);
}
