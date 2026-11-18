import {
  AGENT_TIME_ROWS,
  type AgentAnchorId,
  type AgentRulingId,
  type EntityId,
  type GetWorkTimeArgs,
  type GetWorkTimeResult,
  JUDGED_STRETCHES,
  type JudgeTimeProposalArgs,
  type JudgeTimeProposalResult,
  type LiftAnchorArgs,
  type LiftedResult,
  type LiftTimeRulingArgs,
  type RuleTimeArgs,
  type RuleTimeResult,
  type SetAnchorArgs,
  type SetAnchorResult,
  type TimeProposalId,
} from "@intelligence/contracts/personal";
import { deviceAnchorKey } from "@intelligence/personal-core/lens";
import { stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { answered, type Done, invalidAs, isRefused, refused, sealSummary, type WorkCall } from "../core/work-refs.ts";
import { workViews } from "../core/work-time-read.ts";
import { supportsOf } from "../read/computed-beliefs.ts";
import { sortTitles } from "./work-time-titles.ts";

// Agents read work time by place and sort it into projects, as pi_reader. The read is work time's
// own gathering under the caller's token, with the caller's own live anchors and rulings. Each
// write is one definer function, which gates the caller, computes the label and decides every
// refusal from rows the caller can see.

const SQL = {
  anchors: `
    select a.id, a.project_id, a.kind, a.created_at from knowledge.agent_anchors a
    where a.client_id = $1 and a.lifted_at is null
    order by a.created_at desc, a.id desc limit $2`,
  rulings: `
    select r.id, r.project_id, r.from_at, r.to_at, r.proposal_id, r.created_at from knowledge.agent_time_rulings r
    where r.client_id = $1 and r.lifted_at is null and r.to_at > $2 and r.from_at < $3
    order by r.from_at, r.id limit $4`,
  stretches: `
    select count(*)::int as n from knowledge.time_rulings t
    where t.proposal_id = $1 and t.source = 'system' and t.lifted_at is null and t.pending_card is null`,
  setAnchor: "select code, anchor_id from ledger.set_anchor($1, $2, $3, $4, $5, $6, $7::jsonb)",
  project: "select p.compartments from knowledge.projects p where p.id = $1",
  liftAnchor: "select ledger.lift_anchor($1, $2, $3) as code",
  ruleTime: "select code, ruling_id from ledger.rule_time($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)",
  liftRuling: "select ledger.lift_time_ruling($1, $2, $3) as code",
  judge: "select code, ruling_ids from ledger.judge_time_proposal($1::text[], $2, $3, $4, $5)",
} as const;

export async function getWorkTime(call: WorkCall, valid: GetWorkTimeArgs, now: Date): Promise<Done<GetWorkTimeResult>> {
  const { ctx, client } = call;
  const views = await workViews(
    ctx,
    { view: "sort", from: valid.from, to: valid.to },
    now,
    [],
    (rows) => sortTitles(call, rows),
    supportsOf(ctx),
  );
  const sort = views.sort;
  if (sort === undefined) return refused("not_found");
  const anchors = await ctx.run<{
    id: AgentAnchorId;
    project_id: EntityId;
    kind: SetAnchorArgs["kind"];
    created_at: Date;
  }>(SQL.anchors, [client.id, AGENT_TIME_ROWS + 1]);
  const rulings = await ctx.run<{
    id: AgentRulingId;
    project_id: EntityId;
    from_at: Date;
    to_at: Date;
    proposal_id: TimeProposalId | null;
    created_at: Date;
  }>(SQL.rulings, [client.id, sort.from, sort.to, AGENT_TIME_ROWS + 1]);
  return answered(
    {
      ...sort,
      anchors: anchors.slice(0, AGENT_TIME_ROWS).map((row) => ({
        anchor: row.id,
        project: row.project_id,
        kind: row.kind,
        createdAt: stamp(row.created_at),
      })),
      rulings: rulings.slice(0, AGENT_TIME_ROWS).map((row) => ({
        ruling: row.id,
        project: row.project_id,
        from: stamp(row.from_at),
        to: stamp(row.to_at),
        proposal: row.proposal_id,
        createdAt: stamp(row.created_at),
      })),
      more: sort.more || anchors.length > AGENT_TIME_ROWS || rulings.length > AGENT_TIME_ROWS,
    },
    views.shown,
  );
}

// A place's key at its normal form, fingerprinted as an owner's anchor's is. A generic place is
// not_found, as a project the caller cannot see is, so neither tells it more; an unparsable one is
// invalid_request.
export async function setAnchor(call: WorkCall, valid: SetAnchorArgs): Promise<Done<SetAnchorResult>> {
  const answer = deviceAnchorKey(valid.kind, valid.value);
  if ("refused" in answer) return refused(answer.refused === "generic_anchor" ? "not_found" : "invalid_request");
  // The place at its normal form, sealed under the project's label, which the row takes: for the
  // owner's list alone, as an owner's anchor keeps its value.
  const [project] = await call.ctx.run<{ compartments: string[] }>(SQL.project, [valid.project]);
  if (project === undefined) return refused("not_found");
  const id = newId("aan");
  const rows = await call.fn<{ code: string; anchor_id: AgentAnchorId | null }>(SQL.setAnchor, [
    id,
    valid.requestId,
    await call.session(),
    valid.project,
    valid.kind,
    fingerprint(call.ctx.keys, "anchor", answer.key),
    sealSummary(
      call.ctx,
      project.compartments,
      { table: "knowledge.agent_anchors", id, column: "value_enc" },
      answer.key.slice(answer.key.indexOf(":") + 1),
    ),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row?.code === "ok" && row.anchor_id !== null) return answered({ anchor: row.anchor_id });
  if (row?.code === "anchor_taken") return invalidAs("anchor_taken");
  return refused("not_found");
}

const lifted = async (call: WorkCall, text: string, id: string, requestId: string): Promise<Done<LiftedResult>> => {
  const rows = await call.fn<{ code: string }>(text, [id, requestId, await call.session()]);
  if (isRefused(rows)) return refused(rows);
  return rows[0]?.code === "ok" ? answered({ lifted: true }) : refused("not_found");
};

export const liftAnchor = (call: WorkCall, valid: LiftAnchorArgs): Promise<Done<LiftedResult>> =>
  lifted(call, SQL.liftAnchor, valid.anchor, valid.requestId);

export const liftTimeRuling = (call: WorkCall, valid: LiftTimeRulingArgs): Promise<Done<LiftedResult>> =>
  lifted(call, SQL.liftRuling, valid.ruling, valid.requestId);

export async function ruleTime(call: WorkCall, valid: RuleTimeArgs): Promise<Done<RuleTimeResult>> {
  const rows = await call.fn<{ code: string; ruling_id: AgentRulingId | null }>(SQL.ruleTime, [
    newId("atr"),
    valid.requestId,
    await call.session(),
    valid.project,
    valid.from,
    valid.to,
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  return row?.code === "ok" && row.ruling_id !== null ? answered({ ruling: row.ruling_id }) : refused("not_found");
}

// One minted id per live stretch of the proposal the caller can see, at least one so a repeat finds
// its first answer; the function writes one ruling per stretch.
export async function judgeTimeProposal(
  call: WorkCall,
  valid: JudgeTimeProposalArgs,
): Promise<Done<JudgeTimeProposalResult>> {
  const [count] = await call.ctx.run<{ n: number }>(SQL.stretches, [valid.proposal]);
  const n = Math.min(Math.max(count?.n ?? 0, 1), JUDGED_STRETCHES);
  const rows = await call.fn<{ code: string; ruling_ids: AgentRulingId[] | null }>(SQL.judge, [
    Array.from({ length: n }, () => newId("atr")),
    valid.requestId,
    await call.session(),
    valid.proposal,
    valid.project ?? null,
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  return row?.code === "ok" && row.ruling_ids !== null && row.ruling_ids.length > 0
    ? answered({ rulings: row.ruling_ids })
    : refused("not_found");
}
