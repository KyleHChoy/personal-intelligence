import type { Timestamp } from "@intelligence/contracts";
import {
  type ClientName,
  type DeclineReason,
  GapTrigger,
  type IntentId,
  isOpenStatus,
  OPEN_STATUSES,
  type OpportunityId,
  RoleName,
  type RulingId,
  TASK_KINDS,
  type WorkTier,
} from "@intelligence/contracts/personal";
import type { TxAt } from "../core/admin-context.ts";
import { AdminError } from "../core/admin-error.ts";
import { type Query, stamp, stampOrNull } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { ownerDecision } from "../core/owner-decision.ts";
import { lockRows } from "../core/queue.ts";
import { latestEvent, latestRow, moveStatus, OPPORTUNITY_ROUTED, ROUTED_ROLE } from "../core/statements.ts";
import { recordEvent, TASK_GO, TASK_NO_GO } from "./record-event.ts";

// The owner's commands, as pi_admin, each in the caller's transaction and each writing the owner's
// decision: a client's roles, the task tier on or off, a gap trigger's route, and the cancel of one
// task. Ids, role names, codes and times only.

// The owner's setting of the role defects go to: the owner's decision, as every command here is, so
// the goal's count of the owner's acts sees it.
export const decideDefectRole = (query: Query, role: string | null, now: Date): Promise<RulingId> =>
  ownerDecision(query, { kind: "defect_role", details: { role } }, now);

// Throws not_found for a name that is no active agent, invalid_argument for a role not of the form.
export async function setClientRoles(
  query: Query,
  name: string,
  given: readonly string[],
  now: Date,
): Promise<RoleName[]> {
  const roles = [...new Set(given)].sort();
  if (roles.length > 16 || !roles.every((role) => RoleName.safeParse(role).success))
    throw new AdminError("invalid_argument");
  const [client] = await query<{ id: string; roles: string[] }>(
    "select id, roles from policy.clients where name = $1 and status = 'active' and kind = 'agent' for update",
    [name],
  );
  if (client === undefined) throw new AdminError("not_found");
  if (client.roles.length === roles.length && client.roles.every((role, i) => role === roles[i])) return roles;
  await ownerDecision(
    query,
    { kind: "client_roles", target: { kind: "client", id: client.id }, details: { roles } },
    now,
  );
  await query("update policy.clients set roles = $2 where id = $1", [client.id, roles]);
  return roles;
}

// Its kinds are TASK_KINDS, its mode policy_decides, and it lists no client: tasks are routed by
// role. Answers the intent in force, or null when off. Turning on what is on, or off what is off,
// writes nothing.
export async function setTaskTier(query: Query, on: boolean, now: Date): Promise<IntentId | null> {
  await lockRows(query, ["task intent"]);
  const [active] = await query<{ id: IntentId }>(
    "select id from policy.intents where for_tasks and revoked_at is null",
  );
  if (on && active !== undefined) return active.id;
  if (!on && active === undefined) return null;
  const id = on ? (newId("int") as IntentId) : (active as { id: IntentId }).id;
  await ownerDecision(
    query,
    { kind: "task_tier", target: { kind: "intent", id }, details: { tasks: on ? "on" : "off" } },
    now,
  );
  if (on) {
    await query(
      `insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at, for_tasks)
       values ($1, null, $2, '{}', 'policy_decides', 1, $3, true)`,
      [id, [...TASK_KINDS], stamp(now)],
    );
    return id;
  }
  await query("update policy.intents set revoked_at = $2 where id = $1", [id, stamp(now)]);
  return null;
}

// Who the system's pings go to: the default recipient and who an unclaimed ping falls back to, in
// order, how long it waits, the day's batch and the role that owns each kind of signal. Each place
// must name an active agent or a role one holds, so an order cannot strand a ping. The owner's decision.
export type PingSettings = {
  order?: string[];
  datedMinutes?: number;
  otherMinutes?: number;
  batchHour?: number;
  signalRole?: { kind: string; role: string | null };
};
export type PingSettingsShown = {
  order: string[];
  datedMinutes: number;
  otherMinutes: number;
  batchHour: number;
  signalRoles: Record<string, string>;
};
export async function setPingSettings(query: Query, settings: PingSettings, now: Date): Promise<void> {
  for (const place of settings.order ?? []) {
    const [kind, name] = place.split(":");
    const found = await query(
      kind === "role"
        ? "select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)"
        : "select 1 from policy.clients where status = 'active' and kind = 'agent' and name = $1",
      [name],
    );
    if (found.length === 0) throw new AdminError("unknown_role");
  }
  const { signalRole } = settings;
  if (signalRole !== undefined && signalRole.role !== null) {
    const held = await query(
      "select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)",
      [signalRole.role],
    );
    if (held.length === 0) throw new AdminError("unknown_role");
  }
  const details: Record<string, unknown> = { ...settings };
  await ownerDecision(query, { kind: "ping_settings", details }, now);
  await query(
    `update policy.work_settings set
       ping_order = coalesce($1::text[], ping_order),
       ping_dated_minutes = coalesce($2::integer, ping_dated_minutes),
       ping_other_minutes = coalesce($3::integer, ping_other_minutes),
       ping_batch_hour = coalesce($4::integer, ping_batch_hour),
       signal_roles = case when $5::text is null then signal_roles
                           when $6::text is null then signal_roles - $5::text
                           else signal_roles || jsonb_build_object($5::text, $6::text) end`,
    [
      settings.order ?? null,
      settings.datedMinutes ?? null,
      settings.otherMinutes ?? null,
      settings.batchHour ?? null,
      signalRole?.kind ?? null,
      signalRole?.role ?? null,
    ],
  );
}
export async function pingSettings(query: Query): Promise<PingSettingsShown> {
  const [row] = await query<{
    ping_order: string[];
    ping_dated_minutes: number;
    ping_other_minutes: number;
    ping_batch_hour: number;
    signal_roles: Record<string, string>;
  }>(
    "select ping_order, ping_dated_minutes, ping_other_minutes, ping_batch_hour, signal_roles from policy.work_settings",
  );
  return {
    order: row?.ping_order ?? [],
    datedMinutes: row?.ping_dated_minutes ?? 120,
    otherMinutes: row?.ping_other_minutes ?? 1440,
    batchHour: row?.ping_batch_hour ?? 13,
    signalRoles: row?.signal_roles ?? {},
  };
}

export async function setGapRoute(query: Query, trigger: string, role: string | null, now: Date): Promise<void> {
  // A card asked through an agent takes no route: its role is the question role (setQuestionRole).
  // Nor does a system defect's task: its role is the defect's, the role the owner gave defects to.
  // A route stored before may still be removed.
  if (
    !GapTrigger.safeParse(trigger).success ||
    trigger === "card_relay" ||
    trigger === "owner_queue" ||
    (trigger === "defect" && role !== null) ||
    (role !== null && !RoleName.safeParse(role).success)
  )
    throw new AdminError("invalid_argument");
  const ruling = await ownerDecision(query, { kind: "gap_route", details: { trigger, role } }, now);
  if (role === null) await query("delete from policy.gap_routes where trigger = $1", [trigger]);
  else
    await query(
      `insert into policy.gap_routes (trigger, role, ruling_id) values ($1, $2, $3)
       on conflict (trigger) do update set role = excluded.role, ruling_id = excluded.ruling_id`,
      [trigger, role, ruling],
    );
}

// The role a task proposed with no role, and a gap flag whose trigger has no route, take when
// written, or none. Throws unknown_role for a role no active agent holds, even the value already
// set, so a default whose holder is gone is reported; any other same value again writes nothing.
export async function setDefaultTaskRole(query: Query, role: string | null, now: Date): Promise<void> {
  if (role !== null && !RoleName.safeParse(role).success) throw new AdminError("invalid_argument");
  const [settings] = await query<{ default_task_role: string | null }>(
    "select default_task_role from policy.work_settings for update",
  );
  if (
    role !== null &&
    (
      await query("select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)", [
        role,
      ])
    ).length === 0
  )
    throw new AdminError("unknown_role");
  if (settings?.default_task_role === role) return;
  await ownerDecision(query, { kind: "default_task_role", details: { role } }, now);
  await query("update policy.work_settings set default_task_role = $1", [role]);
}

// As the default task role is set: unknown_role for a role no active agent holds, even the value
// already set; any other same value again writes nothing.
export async function setQuestionRole(query: Query, role: string | null, now: Date): Promise<void> {
  if (role !== null && !RoleName.safeParse(role).success) throw new AdminError("invalid_argument");
  const [settings] = await query<{ question_role: string | null }>(
    "select question_role from policy.work_settings for update",
  );
  if (
    role !== null &&
    (
      await query("select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)", [
        role,
      ])
    ).length === 0
  )
    throw new AdminError("unknown_role");
  if ((settings?.question_role ?? null) === role) return;
  await ownerDecision(query, { kind: "question_role", details: { role } }, now);
  await query("update policy.work_settings set question_role = $1", [role]);
}

// Box configuration, not the owner's decision: no decision row. Null clears it. A value that is not
// a host name is refused; the same value again writes nothing.
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export async function setOwnerPageHost(query: Query, host: string | null): Promise<void> {
  if (host !== null && (host.length > 253 || !HOST.test(host))) throw new AdminError("invalid_argument");
  await query("update policy.work_settings set owner_page_host = $1 where owner_page_host is distinct from $1", [host]);
}

// As the question role is set: unknown_role for a role no active agent holds; any other same value
// again writes nothing.
export async function setTitleRole(query: Query, role: string | null, now: Date): Promise<void> {
  if (role !== null && !RoleName.safeParse(role).success) throw new AdminError("invalid_argument");
  const [settings] = await query<{ title_role: string | null }>(
    "select title_role from policy.work_settings for update",
  );
  if (
    role !== null &&
    (
      await query("select 1 from policy.clients where status = 'active' and kind = 'agent' and $1 = any (roles)", [
        role,
      ])
    ).length === 0
  )
    throw new AdminError("unknown_role");
  if ((settings?.title_role ?? null) === role) return;
  await ownerDecision(query, { kind: "title_role", details: { role } }, now);
  await query("update policy.work_settings set title_role = $1", [role]);
}

export async function gapRoutes(query: Query): Promise<{ trigger: GapTrigger; role: RoleName }[]> {
  return query<{ trigger: GapTrigger; role: RoleName }>(
    'select trigger, role from policy.gap_routes order by trigger collate "C"',
  );
}

// It holds as every no does (task_go's second line). False for an id that is no open task. The
// owner's reason, when they give one, is the no_go's code in place of `cancelled`; the decision
// row's `cancelled` still marks it a cancel. Work an agent approved with a bet is cancelled the
// same way: the owner's no outranks the agent's go, and the bet ends lost.
export async function cancelTask(query: Query, id: OpportunityId, now: Date, reason?: DeclineReason): Promise<boolean> {
  await lockRows(query, [id]);
  const [task] = await query<{ compartments: string[]; status: string | null }>(
    `select o.compartments, (${latestEvent("opportunity", "o.id")}) as status
     from ledger.opportunities o where o.id = $1 and (o.tier = 'task' or o.bet_at is not null) and o.tainted_at is null`,
    [id],
  );
  if (task === undefined || !isOpenStatus(task.status)) return false;
  const ruling = await ownerDecision(query, { kind: "task_cancel", target: { kind: "opportunity", id } }, now);
  await query(
    `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, ruling_id)
     values ($1, $2, 'owner', $3, $4, 'no_go', 'owner', 4, 'cancelled', $5)`,
    [newId("dpc"), stamp(now), task.compartments, id, ruling],
  );
  await recordEvent(query, TASK_NO_GO, id, stamp(now), task.compartments, { code: reason ?? "cancelled" });
  await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [id]);
  await query(
    `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
     select 'intention', i.id, 'cancelled', $2, 'owner', i.compartments from ledger.intentions i
     where i.opportunity_id = $1 and (${latestEvent("intention", "i.id")}) = 'set'`,
    [id, stamp(now)],
  );
  return true;
}

// The work goes back to the board, `go` by the owner with the code `owner_freed`: its lease row
// goes, so no hold of its holder's is left; the holder's waiting check-backs on it are cancelled,
// and no other intention; the moves its holder planned and never reported are closed `failed` with
// the code `abandoned`, as a lapse closes them; and no decline is written, so any agent, its last
// holder among them, may take it. False for work that is not claimed or on the board, or that no
// client holds by the one rule (ledger.work_held): a lease row long run out holds nothing to free.
export const OWNER_FREED = "owner_freed";
export async function freeWork(query: Query, id: OpportunityId, now: Date): Promise<boolean> {
  await lockRows(query, [id]);
  const [work] = await query<{ compartments: string[]; status: string | null; holder: string | null; held: boolean }>(
    `select o.compartments, (${latestEvent("opportunity", "o.id")}) as status,
       (select l.holder from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id) as holder,
       ledger.work_held(o.id, $2) as held
     from ledger.opportunities o where o.id = $1 and o.tainted_at is null`,
    [id, stamp(now)],
  );
  if (work === undefined || work.holder === null || !work.held || (work.status !== "claimed" && work.status !== "go"))
    return false;
  await ownerDecision(query, { kind: "work_free", target: { kind: "opportunity", id } }, now);
  await recordEvent(query, TASK_GO, id, stamp(now), work.compartments, { code: OWNER_FREED });
  await query("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [id]);
  await query(
    `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
     select 'intention', i.id, 'cancelled', $2, 'owner', i.compartments from ledger.intentions i
     where i.opportunity_id = $1 and i.client_id = $3 and i.kind = 'check_back' and (${latestEvent("intention", "i.id")}) = 'set'`,
    [id, stamp(now), work.holder],
  );
  await query(
    `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
     select 'move', m.id, 'failed', $2, 'owner', m.compartments, 'abandoned' from ledger.moves m
     where m.opportunity_id = $1 and (${moveStatus()}) = 'cleared'`,
    [id, stamp(now)],
  );
  return true;
}
export type Coordination = {
  tasks: { proposed: number; go: number; carded: number; done: number; failed: number; cancelled: number };
  duplicates: number;
  writebacks: number;
  leasesExpired: number;
  waitingPastDay: number;
  handOffs: number;
  cardsPerDay: { day: string; kind: string; n: number }[];
};

export async function coordination(query: Query, since: Date): Promise<Coordination> {
  const [tasks] = await query<Coordination["tasks"]>(
    `select count(*)::int as proposed,
       count(*) filter (where exists (select 1 from ledger.opportunity_decisions d where d.opportunity_id = o.id and d.decided_by = 'policy' and d.decision = 'go'))::int as go,
       count(*) filter (where exists (select 1 from ledger.cards c where c.target_id = o.id))::int as carded,
       count(*) filter (where s.event = 'done')::int as done,
       count(*) filter (where s.event = 'withdrawn' and s.code = 'failed')::int as failed,
       count(*) filter (where s.event = 'no_go' and exists (select 1 from ledger.opportunity_decisions d where d.opportunity_id = o.id and d.decided_by = 'owner' and d.reason = 'cancelled'))::int as cancelled
     from ledger.opportunities o
     join lateral (${latestRow("r.event, r.code", "opportunity", "o.id")}) s on true
     where o.tier = 'task' and o.created_at >= $1`,
    [stamp(since)],
  );
  // Two tasks of one kind (investigate and research as one) about one subject, made in the window,
  // the later made before the earlier closed or within 7 days of it.
  const [duplicates] = await query<{ n: number }>(
    `select count(*)::int as n from ledger.opportunities a join ledger.opportunities b
       on b.tier = 'task' and b.id <> a.id and b.created_at > a.created_at and b.about_kind = a.about_kind and b.about_id is not distinct from a.about_id
      and (b.kind = a.kind or (b.kind in ('investigate', 'research') and a.kind in ('investigate', 'research')))
     where a.tier = 'task' and a.created_at >= $1
       and b.created_at <= coalesce((select max(r.at) from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = a.id
                                     and r.event in ('done', 'withdrawn', 'no_go', 'expired')), b.created_at) + interval '7 days'`,
    [stamp(since)],
  );
  // Findings and proposals a client wrote while it held a task.
  const [writebacks] = await query<{ n: number }>(
    `select count(distinct w.id)::int as n from ledger.agent_writes w
     join ledger.record_events c on c.row_kind = 'opportunity' and c.event = 'claimed' and c.by = 'client:' || w.client_id and c.at <= w.created_at
     join ledger.opportunities o on o.id = c.row_id and o.tier = 'task'
     where w.kind in ('finding', 'proposal') and w.created_at >= $1
       and not exists (select 1 from ledger.record_events e where e.row_kind = 'opportunity' and e.row_id = c.row_id and e.id > c.id and e.at <= w.created_at
                       and e.event <> 'claimed')`,
    [stamp(since)],
  );
  const [events] = await query<{ expired: number; handoffs: number }>(
    `select count(*) filter (where r.code = 'lease_expired')::int as expired, count(*) filter (where r.event = 'routed')::int as handoffs
     from ledger.record_events r join ledger.opportunities o on o.id = r.row_id and o.tier = 'task'
     where r.row_kind = 'opportunity' and r.at >= $1`,
    [stamp(since)],
  );
  const [waiting] = await query<{ n: number }>(
    `select count(*)::int as n from ledger.opportunities o
     where o.tier = 'task' and o.tainted_at is null
       and (${latestEvent("opportunity", "o.id")}) = 'go'
       and (select max(r.at) from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id) < now() - interval '24 hours'`,
  );
  const cardsPerDay = await query<{ day: string; kind: string; n: number }>(
    `select to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, c.kind, count(*)::int as n from ledger.cards c
     where c.created_at >= $1 group by 1, 2 order by 1, 2`,
    [stamp(since)],
  );
  return {
    tasks: tasks ?? { proposed: 0, go: 0, carded: 0, done: 0, failed: 0, cancelled: 0 },
    duplicates: duplicates?.n ?? 0,
    writebacks: writebacks?.n ?? 0,
    leasesExpired: events?.expired ?? 0,
    waitingPastDay: waiting?.n ?? 0,
    handOffs: events?.handoffs ?? 0,
    cardsPerDay,
  };
}

// `pia work status`'s open rows: ids, codes, role names and times.
export type OpenWorkRow = {
  id: OpportunityId;
  kind: string;
  tier: WorkTier;
  status: string;
  role: RoleName | null;
  holder: ClientName | null;
  leaseUntil: Timestamp | null;
  dueAt: Timestamp | null;
};

export async function openWork(query: Query): Promise<OpenWorkRow[]> {
  const rows = await query<{
    id: OpportunityId;
    kind: string;
    tier: WorkTier;
    status: string;
    role: RoleName | null;
    holder: ClientName | null;
    lease_until: Date | null;
    due_at: Date | null;
  }>(
    `select x.* from (
       select o.id, o.kind, o.tier, o.due_at,
         (${latestEvent("opportunity", "o.id")}) as status,
         case when exists (${OPPORTUNITY_ROUTED})
           then (${ROUTED_ROLE})
           else o.role end as role,
         (select c.name from queue.leases l join policy.clients c on c.id = l.holder
          where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= now()) as holder,
         (select l.lease_until from queue.leases l where l.resource_kind = 'opportunity' and l.resource_id = o.id and l.lease_until >= now()) as lease_until
       from ledger.opportunities o where o.tainted_at is null
     ) x where x.status in (${OPEN_STATUSES.map((one) => `'${one}'`).join(", ")})
     order by x.due_at nulls last, x.id collate "C"`,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    tier: row.tier,
    status: row.status,
    role: row.role,
    holder: row.holder,
    leaseUntil: stampOrNull(row.lease_until),
    dueAt: stampOrNull(row.due_at),
  }));
}

// With the owner's reason, when they give one.
export const ownerCancelTask = ({ query, now }: TxAt, id: OpportunityId, reason?: DeclineReason): Promise<boolean> =>
  cancelTask(query, id, now, reason);
