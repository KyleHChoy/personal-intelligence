import type { Timestamp } from "@intelligence/contracts";
import {
  type ClientName,
  type LearningId,
  type LearningScope,
  RECENT_LEARNING_DAYS,
  RECENT_LEARNINGS_MOST,
  type RecentLearningRow,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";

// The owner's side of agent learnings, as pi_admin: `pia work learnings`, every learning with its
// words opened, and `pia work learning retire`, the owner's veto through ledger.owner_retire_learning.
// The owner reads every row; nothing here is served to an agent.

export type LearningState = "active" | "superseded" | "retired" | "tainted";
export type LearningView = {
  id: LearningId;
  scope: LearningScope;
  state: LearningState;
  by: string;
  at: Timestamp;
  supersedes: LearningId | null;
  // Null where the key file lacks a compartment of its label, or the learning is tainted.
  statement: string | null;
  rule: string | null;
  evidence: string | null;
};

// A learning's state as the owner sees it, every row read: the veto first, then a learning that supersedes it,
// untainted and not vetoed.
const LEARNINGS = `
  select l.id, l.scope, l.created_at, l.supersedes, l.compartments, l.statement_enc, l.rule_enc, l.evidence_enc,
    c.name as by_name,
    case when l.tainted_at is not null then 'tainted'
         when l.retired_at is not null then 'retired'
         when exists (select 1 from ledger.agent_learnings n
                      where n.supersedes = l.id and n.tainted_at is null and n.retired_at is null) then 'superseded'
         else 'active' end as state
  from ledger.agent_learnings l join policy.clients c on c.id = l.client_id
  order by l.created_at desc, l.id collate "C" desc`;

type Row = {
  id: LearningId;
  scope: LearningScope;
  created_at: Date;
  supersedes: LearningId | null;
  compartments: string[];
  statement_enc: Sealed;
  rule_enc: Sealed;
  evidence_enc: Sealed;
  by_name: string;
  state: LearningState;
};

// Newest first; the active ones alone unless `all`.
export async function learnings(context: AdminContext, options: { all?: boolean } = {}): Promise<LearningView[]> {
  const rows = await context.transaction((query) => query<Row>(LEARNINGS));
  return rows
    .filter((row) => options.all === true || row.state === "active")
    .map((row) => {
      const openColumn = (column: "statement_enc" | "rule_enc" | "evidence_enc"): string | null =>
        row[column] === null ? null : open(context.keys, row, `ledger.agent_learnings.${column}`, "withheld");
      return {
        id: row.id,
        scope: row.scope,
        state: row.state,
        by: row.by_name,
        at: stamp(row.created_at),
        supersedes: row.supersedes,
        statement: openColumn("statement_enc"),
        rule: openColumn("rule_enc"),
        evidence: openColumn("evidence_enc"),
      };
    });
}

// `pia status`'s learnings: the learnings filed in the last RECENT_LEARNING_DAYS that are active as
// the owner sees them, newest first, each with the filer by name and its statement and rule opened,
// as the agent's words. As pi_admin.
export async function recentLearnings(query: Query, keys: Keys, now: Date): Promise<RecentLearningRow[]> {
  const rows = await query<Row>(
    `select * from (${LEARNINGS}) l
     where l.state = 'active' and l.created_at > $1::timestamptz - make_interval(days => $2)
     order by l.created_at desc, l.id collate "C" desc limit $3`,
    [stamp(now), RECENT_LEARNING_DAYS, RECENT_LEARNINGS_MOST],
  );
  return rows.map((row) => {
    const words = (column: "statement_enc" | "rule_enc") => {
      const opened = open(keys, row, `ledger.agent_learnings.${column}`, "withheld");
      return opened === null ? null : { untrusted: opened };
    };
    return {
      learning: row.id,
      scope: row.scope,
      client: row.by_name as ClientName,
      at: stamp(row.created_at),
      statement: words("statement_enc"),
      rule: words("rule_enc"),
    };
  });
}

// The owner's veto of a learning, or with `lift` its lifting. `unchanged` when it is already so; `not_found` for an
// id that is no learning, or a tainted one.
export async function retireLearning(
  context: AdminContext,
  id: LearningId,
  options: { lift?: boolean } = {},
): Promise<void> {
  const [row] = await context.transaction((query) =>
    query<{ code: string | null }>("select ledger.owner_retire_learning($1, $2) as code", [id, options.lift === true]),
  );
  if (row?.code === "unchanged") throw new AdminError("unchanged");
  if (row?.code !== "ok") throw new AdminError("not_found");
}
