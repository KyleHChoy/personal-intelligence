import { createHash } from "node:crypto";
import {
  AGENT_TIME_ROWS,
  AGENT_TIME_SAMPLE,
  type AgentTimeRow,
  type AgentTimeView,
  type ClientName,
  type EntityId,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { weekStartOf } from "../../cards/asked-less.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { REPEATABLE, unrestrictedOf } from "../admin-time-base.ts";

// The owner's view of what agents set on work time: `pia time agents` and the Projects room. Every live
// agent anchor and ruling with the agent and when, newest first; the week's fixed sample of five for
// the owner to mark right or wrong; and the owner's undo, `pia time agents lift --client NAME`, which
// lifts every one an agent made. As pi_admin, over the compartments the owner's reads take
// (`unrestrictedOf`, as `pi time`'s).

// Both tables as one list: an anchor's kind, or `ruling` with its stretch.
const ROWS = `
  select x.* from (
    select a.id, a.kind, a.project_id, c.name as client, null::timestamptz as from_at, null::timestamptz as to_at,
           a.created_at, a.lifted_at, a.owner_mark, a.value_enc, a.compartments
    from knowledge.agent_anchors a join policy.clients c on c.id = a.client_id
    union all
    select r.id, 'ruling', r.project_id, c.name, r.from_at, r.to_at, r.created_at, r.lifted_at, r.owner_mark, null, r.compartments
    from knowledge.agent_time_rulings r join policy.clients c on c.id = r.client_id
  ) x
  where ((x.lifted_at is null and $1::text[] is null) or x.id = any ($1::text[])) and x.compartments <@ $3::text[]
  order by x.created_at desc, x.id desc
  limit $2`;
const WEEK_IDS = `
  select id from knowledge.agent_anchors where created_at >= $1 and created_at < $2 and compartments <@ $3::text[]
  union all
  select id from knowledge.agent_time_rulings where created_at >= $1 and created_at < $2 and compartments <@ $3::text[]`;
const MARKED = `
  select owner_mark as mark, count(*)::int as n from (
    select owner_mark from knowledge.agent_anchors where owner_mark is not null and compartments <@ $1::text[]
    union all
    select owner_mark from knowledge.agent_time_rulings where owner_mark is not null and compartments <@ $1::text[]) m
  group by owner_mark`;

type Row = {
  id: string;
  kind: AgentTimeRow["kind"];
  project_id: string;
  client: string;
  from_at: Date | null;
  to_at: Date | null;
  created_at: Date;
  owner_mark: "right" | "wrong" | null;
  value_enc: Sealed | null;
  compartments: string[];
};

// Monday of the week `now` is in (UTC).
// The week's sample: of the rows agents made in the week before this one, the five whose hash with
// the week comes first. Fixed for the whole week, whatever is lifted or added since.
async function sampleOf(query: Query, week: Date, within: string[]): Promise<string[]> {
  const ids = await query<{ id: string }>(WEEK_IDS, [
    stamp(new Date(week.getTime() - 7 * DAY_MS)),
    stamp(week),
    within,
  ]);
  const rank = (id: string) =>
    createHash("sha256")
      .update(`${stamp(week)}\n${id}`)
      .digest("hex");
  return ids
    .map((one) => one.id)
    .sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))
    .slice(0, AGENT_TIME_SAMPLE);
}

export function agentTime(admin: AdminContext): Promise<AgentTimeView> {
  return admin.transaction(async (query) => {
    await query(REPEATABLE);
    const week = weekStartOf(admin.now());
    const within = unrestrictedOf(admin.keys);
    const sample = await sampleOf(query, week, within);
    const sampled = sample.length === 0 ? [] : await query<Row>(ROWS, [sample, AGENT_TIME_SAMPLE, within]);
    // The live rows beside the sample, so the two together stay within AGENT_TIME_ROWS.
    const room = AGENT_TIME_ROWS - sampled.length;
    const live = (await query<Row>(ROWS, [null, AGENT_TIME_ROWS + 1, within])).filter(
      (row) => !sample.includes(row.id),
    );
    const rows = [...live.slice(0, room), ...sampled];
    // One seal that will not open shows that row's place as unknown; it never fails the whole list.
    const place = (row: Row): string | null => {
      try {
        return open(admin.keys, row, "knowledge.agent_anchors.value_enc", "withheld");
      } catch {
        admin.log.info({ event: "agent_time_unread", code: "unreadable" });
        return null;
      }
    };
    const names = new Map(
      (
        await query<{ id: string; name_enc: Sealed; compartments: string[] }>(
          "select id, name_enc, compartments from knowledge.projects where id = any ($1)",
          [[...new Set(rows.map((row) => row.project_id))]],
        )
      )
        // A project of a compartment the key file does not hold keeps no name here.
        .filter((row) => row.compartments.every((one) => admin.keys.compartments.has(one)))
        .map((row) => [row.id, open(admin.keys, row, "knowledge.projects.name_enc", "throw")]),
    );
    const marked = await query<{ mark: "right" | "wrong"; n: number }>(MARKED, [within]);
    return {
      rows: rows.map((row) => ({
        id: row.id as AgentTimeRow["id"],
        kind: row.kind,
        project: row.project_id as EntityId,
        projectName: names.get(row.project_id) ?? null,
        place: place(row),
        client: row.client as ClientName,
        from: row.from_at === null ? null : stamp(row.from_at),
        to: row.to_at === null ? null : stamp(row.to_at),
        createdAt: stamp(row.created_at),
        mark: row.owner_mark,
      })),
      more: live.length > room,
      week: stamp(week).slice(0, 10),
      sample: sample as AgentTimeView["sample"],
      marked: {
        right: marked.find((one) => one.mark === "right")?.n ?? 0,
        wrong: marked.find((one) => one.mark === "wrong")?.n ?? 0,
      },
    };
  });
}

// `pia time agents lift --client NAME`: every live anchor and ruling one agent made, lifted by the
// owner. not_found for a name no agent has.
export function liftAgentTime(admin: AdminContext, client: string): Promise<{ anchors: number; rulings: number }> {
  return admin.transaction(async (query) => {
    const [found] = await query<{ id: string }>("select id from policy.clients where name = $1 and kind = 'agent'", [
      client,
    ]);
    if (found === undefined) throw new AdminError("not_found");
    const lift = async (table: string): Promise<number> =>
      (
        await query<{ id: string }>(
          `update ${table} set lifted_at = $2, lifted_by = 'owner' where client_id = $1 and lifted_at is null returning id`,
          [found.id, stamp(admin.now())],
        )
      ).length;
    return { anchors: await lift("knowledge.agent_anchors"), rulings: await lift("knowledge.agent_time_rulings") };
  });
}

// The owner's right or wrong on one agent anchor or ruling; a second mark replaces the first.
export function markAgentTime(admin: AdminContext, id: string, mark: "right" | "wrong"): Promise<void> {
  return admin.transaction(async (query) => {
    const table = id.startsWith("aan_") ? "knowledge.agent_anchors" : "knowledge.agent_time_rulings";
    const done = await query<{ id: string }>(
      `update ${table} set owner_mark = $2, marked_at = $3 where id = $1 returning id`,
      [id, mark, stamp(admin.now())],
    );
    if (done.length === 0) throw new AdminError("not_found");
  });
}
