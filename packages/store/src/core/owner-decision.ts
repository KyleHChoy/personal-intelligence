import { randomBytes } from "node:crypto";
import { type LedgerRef, ownLabel, type RulingId } from "@intelligence/contracts/personal";
import { AdminError } from "./admin-error.ts";
import type { Query } from "./db.ts";
import { newId } from "./ids.ts";
import { type Decision, writeDecision } from "./queue.ts";

// An owner decision with no card, the one way an owner command writes one. Its kind is given, and
// so is what differs from the default: a request id of its own, no target, answer, card or
// supersede, not a batch, no labels or details, and the owner's own label.
export type OwnerDecision = Pick<Decision, "kind"> & Partial<Omit<Decision, "kind">>;

export const ownerDecision = (query: Query, decision: OwnerDecision, now: Date): Promise<RulingId> =>
  writeDecision(
    query,
    {
      id: newId("rul") as RulingId,
      requestId: randomBytes(16).toString("base64url"),
      target: null,
      answer: null,
      card: null,
      supersedes: null,
      batch: false,
      labels: [],
      details: {},
      compartments: ownLabel(),
      ...decision,
    },
    { now },
  );

// `repeated` is the target of the decision a repeated request id already wrote, which the caller
// returns in place of writing its row again; null when this call wrote it. A repeat of another kind
// is `invalid_argument`.
export async function grantDecision(
  query: Query,
  grant: {
    kind: "intent_confirm" | "intent_revoke" | "harness_grant" | "harness_revoke" | "combining_grant";
    target: LedgerRef;
    details?: Decision["details"];
    requestId?: string | undefined;
  },
  now: Date,
): Promise<{ ruling: RulingId; repeated: string | null }> {
  const id = newId("rul") as RulingId;
  const { requestId, ...decision } = grant;
  const ruling = await ownerDecision(
    query,
    { ...decision, id, ...(requestId === undefined ? {} : { requestId }) },
    now,
  );
  if (ruling === id) return { ruling, repeated: null };
  const [first] = await query<{ kind: string; target_id: string }>(
    "select kind, target_id from knowledge.owner_decisions where id = $1",
    [ruling],
  );
  if (first?.kind !== grant.kind) throw new AdminError("invalid_argument");
  return { ruling, repeated: first.target_id };
}
