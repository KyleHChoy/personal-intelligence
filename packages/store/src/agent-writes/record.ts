import {
  type AgentRecordAck,
  AgentRecordArgs,
  type AgentRecordId,
  type ReadOutcome,
} from "@intelligence/contracts/personal";
import { canonicalJson, sha256 } from "@intelligence/personal-core";
import { findStamps } from "@intelligence/personal-core/views";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { writeTyped } from "./typed-claims.ts";

// Reader.record's steps 3 to 5, run inside the call's one read committed transaction under the client's token, after the shared taint lock. The
// label is the database's: `policy.record_label()` gives it from the token, and `policy.append_record` refuses any other. Nothing here reads a held
// message: the reader's row policy returns no held row, so a held message's id resolves as an unknown one does.

// One fixed query for each table, by `id = any($1)`, ordered by id. Both always run, so the
// statements are the same whether a cite is hidden, held, absent, or there is none.
const CITED_MESSAGES = "select m.id, m.evidence_id from knowledge.messages m where m.id = any($1) order by m.id";
const CITED_EVENTS = "select v.id, v.evidence_id from knowledge.events v where v.id = any($1) order by v.id";
export const RECORD_LABEL = "select policy.record_label() as label";
const APPEND = "select outcome, record_id from policy.append_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)";

export const parseRecordArgs = (args: unknown): AgentRecordArgs | null => {
  const parsed = AgentRecordArgs.safeParse(args);
  return parsed.success ? parsed.data : null;
};

// The outcome of an append, and the rows the call log counts for it.
export type Appended = { outcome: ReadOutcome<AgentRecordAck>; rows: number };

// Steps 3 and 4, shared by record and propose_about_you: every cite to its evidence id through a
// row the token sees, in the order given (null when one is not found); then the session, the
// label, the id, the fingerprints, the sealed body and the stamps.
type Prepared = {
  session: string;
  recordId: string;
  contentFp: string;
  citesFp: string;
  evidence: string[];
  label: string[];
  bodyEnc: unknown;
  stamps: string[];
};

export async function prepareAppend(
  ctx: Ctx,
  body: string,
  cites: string[],
  hashed: string = body,
): Promise<Prepared | null> {
  const messages = await ctx.run<{ id: string; evidence_id: string }>(CITED_MESSAGES, [
    cites.filter((id) => id.startsWith("msg_")),
  ]);
  const events = await ctx.run<{ id: string; evidence_id: string }>(CITED_EVENTS, [
    cites.filter((id) => id.startsWith("evt_")),
  ]);
  const evidenceOf = new Map([...messages, ...events].map((row) => [row.id, row.evidence_id]));
  const evidence = cites.map((id) => evidenceOf.get(id));
  if (evidence.some((id) => id === undefined)) return null;

  const session = await ctx.session();
  const [row] = await ctx.run<{ label: string[] }>(RECORD_LABEL, []);
  const label = row?.label ?? [];
  const recordId = newId("rec");
  const contentFp = fingerprint(ctx.keys, "content_hash", sha256(hashed));
  // A retry is the same request when it sent the same ids, whatever revisions they resolve to now.
  const citesFp = fingerprint(ctx.keys, "cites", [...cites].sort().join("\n"));
  let bodyEnc: unknown;
  try {
    // Under exactly the label's compartments, with only the calling client's keys in hand: a
    // compartment those keys lack is refused before any key is tried.
    bodyEnc = sealUnder(ctx.keys, label, { table: "ledger.agent_writes", id: recordId, column: "body_enc" }, body);
  } catch {
    throw new Unavailable();
  }
  // The function checks them against this client's own projections; any other id is no stamp.
  const stamps = [...new Set(findStamps(body).map((stamp) => stamp.projection))];
  return { session, recordId, contentFp, citesFp, evidence: evidence as string[], label, bodyEnc, stamps };
}

// Step 5's answer, the same for every append function. Anything else, label_mismatch
// included, is unavailable.
export function appended(answer: { outcome: string; record_id: string | null } | undefined): Appended {
  switch (answer?.outcome) {
    case "ok":
    case "replayed":
      return { outcome: { ok: true, value: { recordId: answer.record_id as AgentRecordId } }, rows: 1 };
    // Answered as an unknown cite is.
    case "not_found":
      return { outcome: { ok: false, code: "not_found" }, rows: 0 };
    case "read_removed":
      return { outcome: { ok: false, code: "not_found", refusal: "session_renewed" }, rows: 0 };
    // body_refused: a body that is not a sealed envelope, which this code never sends. superseded:
    // the record named in `supersedes` was superseded already.
    case "request_reused":
    case "superseded":
    case "body_refused":
      return { outcome: { ok: false, code: "invalid_request" }, rows: 0 };
    case "rate_limited":
      return { outcome: { ok: false, code: "rate_limited" }, rows: 0 };
    default:
      throw new Unavailable();
  }
}

export async function appendRecord(ctx: Ctx, args: AgentRecordArgs): Promise<Appended> {
  // A typed finding's fingerprint holds its claims' canonical form beside its body, so a retry
  // with other claims is a reused request, as one with another body is. A typed record is never
  // taken in, so intake never checks it.
  const hashed = args.claims === undefined ? args.body : `${args.body}\n${canonicalJson(args.claims)}`;
  const prepared = await prepareAppend(ctx, args.body, args.cites ?? [], hashed);
  if (prepared === null) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  const { session, recordId, contentFp, citesFp, evidence, label, bodyEnc, stamps } = prepared;
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(APPEND, [
    session,
    recordId,
    args.requestId,
    args.kind,
    contentFp,
    citesFp,
    evidence,
    label,
    bodyEnc,
    stamps,
    args.supersedes ?? null,
    args.project ?? null,
  ]);
  const done = appended(answer);
  // A finding's typed claims, in this transaction, after the finding is written (or, on a retry,
  // the reply its first call stored). An untyped finding goes to intake.
  if (args.claims === undefined || !done.outcome.ok) return done;
  const reply = await writeTyped(ctx, done.outcome.value.recordId, args.body, evidence, args.claims, args.project);
  return { outcome: { ok: true, value: { ...done.outcome.value, ...reply } }, rows: done.rows };
}
