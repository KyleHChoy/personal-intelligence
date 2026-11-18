import type { Belief } from "@intelligence/contracts";
import {
  type ClaimRefusal,
  type CloseBody,
  type CloseCommitmentAck,
  CloseCommitmentArgs,
  type ReadOutcome,
  type ReopenCommitmentAck,
  ReopenCommitmentArgs,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { prepareAppend } from "../agent-writes/record.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { isHex64, reopenId } from "../core/ids.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { OWNER_ENTITY, OWNER_REOPENS, reopenedAtOf } from "../read/read-beliefs.ts";

// An agent's close of a commitment it can see, and the reopening of its own, inside the call's one
// read committed transaction under the client's token, after the shared taint lock.
// This code checks what is sealed (the belief's kind, status and latest time, and how each cited
// item relates to the commitment and when); ledger.close_commitment then checks what is clear under
// the commitment's lock and writes the agent record. Nothing the client sends names a label, a time
// or a writer.

export const parseCloseArgs = (args: unknown): CloseCommitmentArgs | null => {
  const parsed = CloseCommitmentArgs.safeParse(args);
  return parsed.success ? parsed.data : null;
};
export const parseReopenArgs = (args: unknown): ReopenCommitmentArgs | null => {
  const parsed = ReopenCommitmentArgs.safeParse(args);
  return parsed.success ? parsed.data : null;
};

// The cited items as the token returns them, with their evidence id, their time and, for a
// message, its thread. A held message is not returned (the reader's row policy), so it reads as
// one not read. Each table is asked by `id = any($1)`, whatever the ids, so the statements are the
// same whichever are hidden or absent.
const CITED = `
  select m.id, m.evidence_id, m.sent_at as at, m.thread_fp from knowledge.messages m where m.id = any($1) and not m.held
  union all
  select d.id, d.evidence_id, d.modified_at as at, null from knowledge.documents d where d.id = any($1)
  union all
  select k.id, k.evidence_id, k.started_at as at, null from knowledge.captures k where k.id = any($1)
  order by 1`;

// The threads of the commitment's supporting claims the token returns.
const THREADS = `
  select distinct m.thread_fp from knowledge.claims c join knowledge.messages m on m.evidence_id = c.evidence_id
  where c.id = any($1) and m.thread_fp is not null
  order by 1`;

// The cited evidence the other party took part in, as the interaction log records it.
const PARTICIPATED = `
  select distinct i.evidence_id from knowledge.interaction_log i
  where i.evidence_id = any($1) and i.entity_id = $2
  order by 1`;

const REPLAYED = "select record_id, cites_fp from ledger.close_replayed($1)";
// The fact key the commitment names, as the token returns its claims: the one sent, when a claim of
// it is visible, or that of the claim of that id, the claims find_facts and get_beliefs show a
// commitment's by. One statement, whichever it is and whether the claim is hidden: a claim the
// token does not return names nothing (invariant 6).
const FACT = `
  select coalesce(
    (select c.fact_key_fp from knowledge.claims c where c.fact_key_fp = $1 limit 1),
    (select c.fact_key_fp from knowledge.claims c where c.id = $1)) as fact_key_fp,
    exists (select 1 from knowledge.claims c where c.fact_key_fp = $1) as by_fact`;

type Commitment = { fact_key_fp: string; support: string[]; compartments: string[]; belief: Belief };

// The beliefs of these fact keys computed under the caller's clearance as of now, each with its
// support by stored claim id (read/computed-beliefs.ts beliefsAt). The write tool passes it: this
// folder may not import the belief computation.
export type BeliefsOf = (
  ctx: Ctx,
  factKeys: readonly string[],
) => Promise<{ row: { fact_key_fp: string; support: string[]; compartments: string[] }; belief: Belief }[]>;

// The commitment's belief, of the fact key sent, or of a claim's when that claim is in its support,
// which a claim the belief does not cite is not.
async function commitmentOf(ctx: Ctx, id: string, beliefsOf: BeliefsOf): Promise<Commitment | undefined> {
  const [named] = await ctx.run<{ fact_key_fp: string | null; by_fact: boolean }>(FACT, [id]);
  if (named?.fact_key_fp == null) return undefined;
  const fact = named.fact_key_fp;
  const one = (await beliefsOf(ctx, [fact])).find((computed) => computed.row.fact_key_fp === fact);
  const found = one === undefined ? undefined : { ...one.row, belief: one.belief };
  if (found === undefined || (!named.by_fact && !found.support.includes(id))) return undefined;
  return found;
}
// The belief's label and support go with it: ledger.close_commitment checks them against the claims.
const CLOSE =
  "select outcome, record_id from ledger.close_commitment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)";
const REOPEN = "select ledger.reopen_close($1, $2, $3) as outcome";

type Closed = { outcome: ReadOutcome<CloseCommitmentAck>; rows: number };
const refused = (refusal: ClaimRefusal): Closed => ({
  outcome: { ok: false, code: "invalid_request", refusal },
  rows: 0,
});
const notFound: Closed = { outcome: { ok: false, code: "not_found" }, rows: 0 };

export async function closeCommitment(ctx: Ctx, args: CloseCommitmentArgs, beliefsOf: BeliefsOf): Promise<Closed> {
  // No handle is issued in this build, so one resolves to nothing.
  if (!isHex64(args.commitment)) return notFound;
  // The commitment, in the caller's own audience (the reader's row policy), with the owner on one
  // side. What is closed is the belief's fact key, whichever id named it.
  const row = await commitmentOf(ctx, args.commitment, beliefsOf);
  const [owner] = await ctx.run<{ id: string }>(OWNER_ENTITY, []);
  const fact = row?.fact_key_fp ?? args.commitment;
  // A retry of a close this caller already wrote answers it, before any check the close itself
  // has changed since: the same commitment, ending and items, the same close; anything else, a
  // reused id (the items alone would let a reused id with another commitment answer the first
  // close as a success). The commitment is its fact, so a retry that
  // names it by another of its ids is the same close.
  const citesFp = fingerprint(ctx.keys, "cites", [fact, args.ending, ...[...args.evidence].sort()].join("\n"));
  const [earlier] = await ctx.run<{ record_id: string; cites_fp: string }>(REPLAYED, [args.requestId]);
  if (earlier !== undefined) {
    if (earlier.cites_fp !== citesFp) return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
    return {
      outcome: {
        ok: true,
        value: { close: earlier.record_id as CloseCommitmentAck["close"], effective: "next_build" },
      },
      rows: 1,
    };
  }
  if (row === undefined || owner === undefined) return notFound;
  const { belief } = row;
  if (belief.kind !== "commitment") return notFound;
  const counterparty = typeof belief.values.counterparty === "string" ? belief.values.counterparty : null;
  const other = belief.subject === owner.id ? counterparty : counterparty === owner.id ? belief.subject : undefined;
  if (other === undefined) return notFound;
  if (belief.status === "closed") return refused("already_closed");

  // The cited items: each read now under the token, so one the caller cannot see, or a held one,
  // is refused as one it never read (invariant 6).
  const cited = await ctx.run<{ id: string; evidence_id: string; at: Date; thread_fp: string | null }>(CITED, [
    args.evidence,
  ]);
  const found = new Map(cited.map((one) => [one.id, one]));
  if (args.evidence.some((id) => !found.has(id))) return refused("evidence_not_read");
  const evidenceIds = args.evidence.map((id) => (found.get(id) as (typeof cited)[number]).evidence_id);
  // Related: a message in the commitment's thread, or an item the other party took part in. A
  // document is never related.
  const threads = new Set((await ctx.run<{ thread_fp: string }>(THREADS, [row.support])).map((one) => one.thread_fp));
  const took =
    other === null
      ? new Set<string>()
      : new Set(
          (await ctx.run<{ evidence_id: string }>(PARTICIPATED, [evidenceIds, other])).map((one) => one.evidence_id),
        );
  const related = cited.filter(
    (one) =>
      !one.id.startsWith("doc_") &&
      ((one.thread_fp !== null && threads.has(one.thread_fp)) || took.has(one.evidence_id)),
  );
  if (related.length === 0) return refused("evidence_unrelated");
  const relatedAt = new Date(Math.max(...related.map((one) => one.at.getTime())));
  if (relatedAt.getTime() <= Date.parse(belief.lastConfirmedAt)) {
    // The build counts the owner's reopen as confirming, so evidence older than it is refused here,
    // and says whose word it lost to.
    const reopened = reopenedAtOf(await ctx.run<{ fact_fp: string; at: string }>(OWNER_REOPENS, [[fact]])).get(fact);
    return refused(
      reopened !== undefined && relatedAt.getTime() <= Date.parse(reopened) ? "reopened_by_owner" : "evidence_predates",
    );
  }

  const body: CloseBody = {
    commitment: fact,
    ending: args.ending,
    evidence: args.evidence as CloseBody["evidence"],
    evidenceIds: evidenceIds as CloseBody["evidenceIds"],
    relatedAt: relatedAt.toISOString(),
    ...(args.note === undefined ? {} : { note: args.note }),
  };
  const prepared = await prepareAppend(ctx, canonicalJson(body), []);
  if (prepared === null) throw new Unavailable();
  const { session, recordId, contentFp, label, bodyEnc } = prepared;
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(CLOSE, [
    session,
    recordId,
    args.requestId,
    fact,
    args.ending,
    evidenceIds,
    relatedAt.toISOString(),
    contentFp,
    citesFp,
    label,
    bodyEnc,
    row.compartments,
    row.support,
  ]);
  switch (answer?.outcome) {
    case "ok":
    case "replayed":
      return {
        outcome: {
          ok: true,
          value: { close: answer.record_id as CloseCommitmentAck["close"], effective: "next_build" },
        },
        rows: 1,
      };
    case "read_removed":
      return { outcome: { ok: false, code: "not_found", refusal: "session_renewed" }, rows: 0 };
    case "not_found":
    case "unknown_commitment":
      return notFound;
    case "request_reused":
    case "body_refused":
      return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
    case "rate_limited":
      return { outcome: { ok: false, code: "rate_limited" }, rows: 0 };
    case "closes_off":
    case "label_wider":
    case "already_closed":
    case "evidence_not_read":
    case "reopened_by_owner":
      return refused(answer.outcome);
    default:
      throw new Unavailable();
  }
}

export async function reopenCommitment(
  ctx: Ctx,
  args: ReopenCommitmentArgs,
): Promise<{ outcome: ReadOutcome<ReopenCommitmentAck>; rows: number }> {
  const session = await ctx.session();
  const [answer] = await ctx.run<{ outcome: string }>(REOPEN, [session, args.close, reopenId()]);
  if (answer?.outcome === "ok")
    return { outcome: { ok: true, value: { close: args.close, effective: "next_build" } }, rows: 1 };
  if (answer?.outcome === "not_found") return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  throw new Unavailable();
}
