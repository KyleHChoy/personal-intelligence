import type { Fill, FillBody } from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { prepareAppend } from "../agent-writes/record.ts";
import { fillDomain, fillIdentity } from "../core/research.ts";
import { derivedId } from "../core/work-refs.ts";
import type { Ctx } from "../read/read-ctx.ts";

// An explore task's fill, appended as its agent's record in report_move's own transaction. The
// identifier and the domain are read strictly here (an address normalized, a LinkedIn profile as
// its profile key; a domain as its organization's registrable domain), and a field that does not
// read is dropped and counted as one outside the flag's list is. The writer keys them the same way
// when it takes the fill in, and keeps their keyed fingerprints on its evidence row in clear, so
// ledger.policy_merge can prove a join without opening it. The node is the task's, which
// policy.append_record sets; the label is the database's.

// The fill with its identifier and domain dropped when they do not read, and how many it dropped.
export function readableFill(fill: Fill): { fill: Fill | null; dropped: number } {
  let dropped = 0;
  const { identity, domain, ...rest } = fill;
  const kept: Record<string, unknown> = { ...rest };
  if (identity !== undefined) {
    if (fillIdentity(fill) === null) dropped += 1;
    else kept.identity = identity;
  }
  if (domain !== undefined) {
    if (fillDomain(fill) === null) dropped += 1;
    else kept.domain = domain;
  }
  return { fill: Object.keys(kept).length === 0 ? null : (kept as Fill), dropped };
}

// The ids a fill names, as the caller's token shows them: every source ref and every entity of its fields. A
// message or an event becomes a cite of the record, an agent record or an entity must be one the token returns;
// a handle or any other ref kind names nothing. Null when one names nothing, so a hidden id is answered as an
// absent one.
const VISIBLE: Readonly<Record<string, string>> = {
  agent_record: "select w.id from ledger.agent_writes w where w.id = any($1)",
  message: "select m.id from knowledge.messages m where m.id = any($1) and not m.held",
  event: "select v.id from knowledge.events v where v.id = any($1)",
  entity: "select e.id from knowledge.entities e where e.id = any($1) and e.kind in ('person', 'organization')",
};
export async function fillRefs(ctx: Ctx, fill: Fill): Promise<{ cites: string[] } | null> {
  const sources = Object.values(fill).flatMap((field) =>
    Array.isArray(field) ? field.flatMap((one) => one.sources) : (field as { sources: unknown[] }).sources,
  ) as (string | { kind: string; id: string })[];
  const refs = sources.flatMap((one) => (typeof one === "string" ? [] : [one]));
  const entities = [
    fill.role?.organization.entity,
    fill.affiliation?.organization.entity,
    ...(fill.relations ?? []).map((one) => one.other.entity),
  ].flatMap((id) => (id === undefined ? [] : [{ kind: "entity", id }]));
  const asked = [...refs, ...entities];
  if (asked.some((one) => one.id.startsWith("hdl_"))) return null;
  const cites = [
    ...new Set(asked.filter((one) => one.kind === "message" || one.kind === "event").map((one) => one.id)),
  ];
  for (const [kind, sql] of Object.entries(VISIBLE)) {
    const ids = [...new Set(asked.filter((one) => one.kind === kind).map((one) => one.id))];
    if (ids.length === 0) continue;
    if ((await ctx.run<{ id: string }>(sql, [ids])).length !== ids.length) return null;
  }
  if (asked.some((one) => !(one.kind in VISIBLE))) return null;
  return { cites };
}

// The function finds the move itself: the explore task's this caller reported done in this
// transaction. Its node is the task's.
const APPEND =
  "select outcome, record_id from policy.append_record($1, $2, $3, 'fill', $4, $5, $6, $7, $8, '{}'::text[], null)";

// The fill's own request id, from the report's, so a retried report replays its fill.
const fillRequestId = (requestId: string): string => `fill_${derivedId(requestId, 40)}`;

// One fill appended, after the move's done report in the same transaction: the record's id, or
// the function's refusal code (not_found, label_wider, rate_limited, request_reused, ...).
export async function appendFill(
  ctx: Ctx,
  args: { node: string; fill: Fill; cites: string[]; requestId: string },
): Promise<{ record: string } | { code: string }> {
  const body: FillBody = { v: 1, node: args.node as FillBody["node"], fill: args.fill };
  const prepared = await prepareAppend(ctx, canonicalJson(body), args.cites);
  if (prepared === null) return { code: "not_found" };
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(APPEND, [
    prepared.session,
    prepared.recordId,
    fillRequestId(args.requestId),
    prepared.contentFp,
    prepared.citesFp,
    prepared.evidence,
    prepared.label,
    prepared.bodyEnc,
  ]);
  if ((answer?.outcome === "ok" || answer?.outcome === "replayed") && answer.record_id !== null)
    return { record: answer.record_id };
  return { code: answer?.outcome ?? "not_found" };
}
