import type { Timestamp } from "@intelligence/contracts";
import {
  type ClientName,
  DECISION_DETAILS,
  type EntityId,
  type GoalId,
  type GoalKey,
  HarnessModeGrant,
  type HarnessModeId,
  INTENT_KINDS,
  INTERNAL_STAGES,
  type IntentId,
  type IntentMode,
  type LifeDomain,
  type OpportunityKind,
  RoleName,
  type RulingId,
  type RunId,
  type RunTrial,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { stamp, stampOrNull } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { grantDecision } from "../../core/owner-decision.ts";
import { open, openUnder, type Sealed, sealUnder } from "../../core/seal.ts";
import { LATEST_GOAL_TARGET } from "../../core/stored-forms.ts";
import { ownerWho } from "../admin-owner.ts";
import { goalKeyOf, writeGoalClaim } from "../goals/goal-claims.ts";
import {
  type GoalNameHolder,
  type GoalNameTarget,
  targetGoalByName as targetByName,
} from "../goals/goal-target-names.ts";
import {
  decisionAt,
  goalAt,
  goalDomainOf,
  rankAll,
  writeGoal,
  writeGoalRank,
  writeGoalReword,
  writeGoalStatus,
  writeGoalTarget,
} from "../goals/goal-writes.ts";
import { queueTrial, type TrialRequest } from "./admin-trials.ts";

// The owner's commands of durable work, as pi_admin. Admin holds one of these as `admin.work`.
// Every decision goes through writeDecision, and every method that writes a ledger row begins its
// transaction with lockRows.

export const GOAL_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// What `pia goals backfill` did, counts and ids only.
type GoalBackfillSkip = { goal: GoalId; code: "no_statement" | "no_words_decision" | "erased" };
type GoalsBackfill = {
  goals: number;
  written: number;
  skipped: GoalBackfillSkip[];
  mapped: number;
  withoutDomain: number;
  ids: GoalId[];
};
type GoalView = {
  id: GoalId;
  status: GoalStatus;
  statement: string | null;
  compartments: string[];
  statedAt: Timestamp;
  updatedAt: Timestamp;
  target: EntityId | null;
};

type IntentView = {
  id: IntentId;
  goal: GoalId | null;
  kinds: OpportunityKind[];
  clients: ClientName[];
  // The role whose holders may also take what it releases, or none.
  role: string | null;
  mode: IntentMode;
  maxOpen: number;
  confirmedAt: Timestamp;
  revokedAt: Timestamp | null;
};

type HarnessModeView = {
  id: HarnessModeId;
  client: ClientName;
  kind: OpportunityKind;
  stage: string;
  mode: string;
  grantedAt: Timestamp;
  revokedAt: Timestamp | null;
};

// Each goal's target from its latest goal_target decision; one pending on a name is the person that
// name's live binding in its item names, as the binding trigger keeps it, or the organization its
// name row names.
const TARGETS_REBUILD = `
  update projections.goal_state g set target_entity_id = coalesce(t.entity, (
      select min(a.entity_id) from knowledge.mention_bindings b
      join knowledge.accounts a on a.value_fp = b.address_fp
      join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
      where b.evidence_id = t.details -> 'named' ->> 'item' and b.mention_fp = t.details -> 'named' ->> 'name' and b.lifted_at is null), (
      select min(o.entity_id) from knowledge.org_names o
      where o.evidence_id = t.details -> 'named' ->> 'item' and o.name_fp = t.details -> 'named' ->> 'name'))
  from (${LATEST_GOAL_TARGET}
  ) t
  where t.target_id = g.goal_id`;

type GoalDecision = {
  id: RulingId;
  kind: "goal_set" | "goal_status" | "goal_reword";
  target_id: GoalId;
  answer: string | null;
  decided_at: Date;
  compartments: string[];
  body_enc: Sealed;
};

// -------------------------------------------------------------------------------------------
// Goals
// -------------------------------------------------------------------------------------------

// A goal_set decision with the statement sealed, and the goal's state row, in one
// transaction. A repeated request id returns the first goal and adds none. The same code as the
// owner's accept of an agent's goal proposal (goal-writes.ts). And the goal's owner_command item,
// claim and mapping row, with the life domain the owner gave, so a goal their mail states on the same
// objective is one belief.
export async function addGoal(
  admin: AdminContext,
  statement: string,
  compartment: string,
  options: { requestId: string; domain?: LifeDomain },
): Promise<GoalId> {
  const { keys } = admin;
  const now = admin.now();
  return admin.transaction((query) =>
    writeGoal(query, keys, {
      statement,
      compartment,
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      requestId: options.requestId,
      now,
    }),
  );
}

// `pia goals backfill`: for every goal in projections.goal_state with no mapping row, its
// owner_command item, goal claim and mapping row, from its sealed statement, its compartment and
// the decision its words are from, at the time the owner set it. Idempotent: a goal already mapped is
// left as it is. Ids and counts only.
export async function backfillGoals(admin: AdminContext): Promise<GoalsBackfill> {
  const { keys } = admin;
  return admin.transaction(async (query) => {
    const rows = await query<{
      goal_id: GoalId;
      statement_enc: Sealed;
      compartments: string[];
      stated_at: Date;
      words: RulingId;
    }>(
      `select g.goal_id, g.statement_enc, g.compartments, g.stated_at,
         (select d.id from knowledge.owner_decisions d where d.target_kind = 'goal' and d.target_id = g.goal_id and d.kind in ('goal_set', 'goal_reword')
          order by d.decided_at desc, d.id collate "C" desc limit 1) as words
       from projections.goal_state g order by g.goal_id collate "C"`,
    );
    const written: GoalId[] = [];
    const skipped: GoalBackfillSkip[] = [];
    for (const row of rows) {
      if ((await goalKeyOf(query, row.goal_id)) !== undefined) continue;
      if (row.statement_enc === null) {
        skipped.push({ goal: row.goal_id, code: "no_statement" });
        continue;
      }
      if (row.words === null) {
        skipped.push({ goal: row.goal_id, code: "no_words_decision" });
        continue;
      }
      const statement = openUnder(keys, row.compartments, goalAt(row.goal_id), row.statement_enc);
      // An item already there with no mapping row is an erased one's tombstone: never written again.
      if (
        (
          await writeGoalClaim(query, keys, {
            goal: row.goal_id,
            ruling: row.words,
            statement,
            compartments: row.compartments,
            at: row.stated_at,
          })
        ).written
      )
        written.push(row.goal_id);
      else skipped.push({ goal: row.goal_id, code: "erased" });
    }
    const [mapped] = await query<{ n: number }>("select count(distinct goal_id)::int as n from knowledge.goal_ids");
    // How many goals of goal_state key by their words alone, for want of a life domain (every
    // backfilled one, and any set before `--domain` was required).
    let withoutDomain = 0;
    for (const row of rows)
      if (
        (await goalKeyOf(query, row.goal_id)) !== undefined &&
        (await goalDomainOf(query, keys, row.goal_id)) === undefined
      )
        withoutDomain += 1;
    return {
      goals: rows.length,
      written: written.length,
      skipped,
      mapped: mapped?.n ?? 0,
      withoutDomain,
      ids: written,
    };
  });
}

// A goal_status decision that supersedes the goal's last, and the state row. False for a goal
// that does not exist. A repeated request id writes nothing.
export async function setGoalStatus(
  admin: AdminContext,
  goal: GoalId,
  status: GoalStatus,
  options: { requestId: string },
): Promise<boolean> {
  if (!GOAL_STATUSES.includes(status)) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction((query) => writeGoalStatus(query, { goal, status, requestId: options.requestId, now }));
}

// `pi goal edit`: the owner's goal in their new words, a goal_reword decision, its claim and
// the state row, as the owner's accept of a reword writes them (goal-writes.ts). False for a goal
// that does not exist. A repeated request id writes nothing. Undone by editing again.
export async function editGoal(
  admin: AdminContext,
  goal: GoalId,
  statement: string,
  options: { requestId: string },
): Promise<boolean> {
  const { keys } = admin;
  const now = admin.now();
  return admin.transaction((query) =>
    writeGoalReword(query, keys, { goal, statement, requestId: options.requestId, now }),
  );
}

// `pi goal rank`: the owner's goal placed right after another of theirs in its life domain,
// or first; one goal_rank decision (goal-writes.ts). False for a goal that is not the owner's set
// goal; `invalid_argument` for an `after` outside its domain. Undone by ranking again.
export async function rankGoal(
  admin: AdminContext,
  goal: GoalId,
  after: GoalKey | null,
  options: { requestId: string },
): Promise<boolean> {
  const { keys } = admin;
  const now = admin.now();
  return admin.transaction((query) => writeGoalRank(query, keys, { goal, after, requestId: options.requestId, now }));
}

// Every goal, its statement opened: null where the key file lacks its compartment.
export async function listGoals(admin: AdminContext): Promise<GoalView[]> {
  const rows = await admin.transaction((query) =>
    query<{
      goal_id: GoalId;
      status: GoalStatus;
      statement_enc: Sealed;
      compartments: string[];
      stated_at: Date;
      updated_at: Date;
      target_entity_id: EntityId | null;
    }>(
      `select goal_id, status, statement_enc, compartments, stated_at, updated_at, target_entity_id from projections.goal_state order by stated_at, goal_id collate "C"`,
    ),
  );
  return rows.map((row) => ({
    id: row.goal_id,
    status: row.status,
    statement: open(admin.keys, { ...row, id: row.goal_id }, "projections.goal_state.statement_enc", "withheld"),
    compartments: row.compartments,
    statedAt: stamp(row.stated_at),
    updatedAt: stamp(row.updated_at),
    target: row.target_entity_id,
  }));
}

// The projection deleted and written again from the owner's decisions alone.
export async function rebuildGoalState(admin: AdminContext): Promise<number> {
  const { keys } = admin;
  return admin.transaction(async (query) => {
    const decisions = await query<GoalDecision>(
      `select id, kind, target_id, answer, decided_at, compartments, body_enc from knowledge.owner_decisions
       where kind in ('goal_set', 'goal_status', 'goal_reword') and target_kind = 'goal' and tainted_at is null order by decided_at, id collate "C"`,
    );
    await query("delete from projections.goal_state");
    await query("delete from projections.goal_key_ranks");
    // A goal's words are its latest goal_reword's, else its goal_set's.
    const goals = new Map<GoalId, { set: GoalDecision; words: GoalDecision; last: GoalDecision; status: string }>();
    for (const decision of decisions) {
      const known = goals.get(decision.target_id);
      if (decision.kind === "goal_set") {
        if (known === undefined)
          goals.set(decision.target_id, { set: decision, words: decision, last: decision, status: "active" });
      } else if (known !== undefined && decision.kind === "goal_reword")
        goals.set(decision.target_id, { ...known, words: decision, last: decision });
      else if (known !== undefined)
        goals.set(decision.target_id, { ...known, last: decision, status: decision.answer ?? known.status });
    }
    for (const [goal, { set, words, last, status }] of goals) {
      const statement = openUnder(keys, words.compartments, decisionAt(words.id), words.body_enc);
      await query(
        `insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, statement_enc, compartments)
         values ($1, $2, $3, $4, $5, $6, ledger.label($7))`,
        [
          goal,
          status,
          last.id,
          stamp(set.decided_at),
          stamp(last.decided_at),
          sealUnder(keys, set.compartments, goalAt(goal), statement),
          set.compartments,
        ],
      );
    }
    await query(TARGETS_REBUILD);
    // The owner's order within each life domain, each goal_rank decision's whole order in
    // turn, as `pi goal rank` wrote it.
    const ranks = await query<{ details: { order?: unknown } }>(
      "select details from knowledge.owner_decisions where kind = 'goal_rank' order by decided_at, id collate \"C\"",
    );
    for (const { details } of ranks) if (Array.isArray(details.order)) await rankAll(query, details.order as string[]);
    return goals.size;
  });
}

// The person or organization a goal is after, or none, as a goal_target decision
// and the state row. False for a goal that does not exist, or an entity that is neither a person
// nor an organization. A repeated request id writes nothing.
export async function setGoalTarget(
  admin: AdminContext,
  goal: GoalId,
  entity: EntityId | null,
  options: { requestId: string },
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction((query) => writeGoalTarget(query, { goal, entity, requestId: options.requestId, now }));
}

// Null for a goal that does not exist.
export async function targetGoalByName(
  admin: AdminContext,
  goal: GoalId,
  name: string,
  options: { requestId: string; entity?: EntityId; organization?: boolean },
): Promise<
  | Exclude<GoalNameTarget, { kind: "holders" }>
  | { kind: "holders"; holders: (GoalNameHolder & { name: UntrustedString | null })[] }
  | null
> {
  const { keys } = admin;
  const now = admin.now();
  return admin.transaction(async (query) => {
    const answer = await targetByName(query, keys, {
      goal,
      name,
      requestId: options.requestId,
      now,
      ...(options.entity === undefined ? {} : { entity: options.entity }),
      ...(options.organization === true ? { organization: true } : {}),
    });
    if (answer?.kind !== "holders") return answer;
    // For the owner's terminal: holders share the name, so each is printed with who the page calls them.
    const who = await ownerWho(
      { query, keys },
      answer.holders.map((one) => one.entity),
    );
    return {
      kind: "holders" as const,
      holders: answer.holders.map((one) => ({ ...one, name: who.get(one.entity)?.name ?? null })),
    };
  });
}

// -------------------------------------------------------------------------------------------
// Intents and harness modes
// -------------------------------------------------------------------------------------------

// A confirmed intent: the owner made it. A name that is not an active agent is not_found. Its
// intent_confirm decision is written in the same transaction, holding the client's set_intent
// proposal it accepts when there is one. A repeated request id returns the first intent and writes
// nothing.
export async function addIntent(
  admin: AdminContext,
  args: {
    kinds: string[];
    clients: string[];
    goal?: GoalId;
    mode?: IntentMode;
    maxOpen?: number;
    proposal?: string;
    role?: string;
  },
  options: { requestId?: string } = {},
): Promise<IntentId> {
  const kinds = [...new Set(args.kinds)];
  const maxOpen = args.maxOpen ?? 5;
  // A role beside or instead of the client list.
  if (args.role !== undefined && !RoleName.safeParse(args.role).success) throw new AdminError("invalid_argument");
  if (
    kinds.length === 0 ||
    !kinds.every((kind) => INTENT_KINDS.includes(kind as OpportunityKind)) ||
    (args.clients.length === 0 && args.role === undefined) ||
    !Number.isSafeInteger(maxOpen) ||
    maxOpen < 1
  ) {
    throw new AdminError("invalid_argument");
  }
  const details = args.proposal === undefined ? {} : { proposal: args.proposal };
  if (DECISION_DETAILS.intent_confirm?.safeParse(details).success !== true) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const names = [...new Set(args.clients)];
    const found = await query<{ id: string; name: string }>(
      "select id, name from policy.clients where name = any ($1) and status = 'active' and kind = 'agent'",
      [names],
    );
    if (found.length !== names.length) throw new AdminError("not_found");
    if (
      args.goal !== undefined &&
      (await query("select 1 from projections.goal_state where goal_id = $1", [args.goal])).length === 0
    )
      throw new AdminError("not_found");
    const byName = new Map(found.map((row) => [row.name, row.id]));
    const id = newId("int") as IntentId;
    const ruling = await grantDecision(
      query,
      { kind: "intent_confirm", target: { kind: "intent", id }, details: details, requestId: options.requestId },
      now,
    );
    if (ruling.repeated !== null) return ruling.repeated as IntentId;
    await query(
      `insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at, role)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        args.goal ?? null,
        kinds,
        names.map((name) => byName.get(name)),
        args.mode ?? "owner_decides",
        maxOpen,
        stamp(now),
        args.role ?? null,
      ],
    );
    return id;
  });
}

export async function listIntents(admin: AdminContext): Promise<IntentView[]> {
  const rows = await admin.transaction((query) =>
    query<{
      id: IntentId;
      goal_id: GoalId | null;
      opportunity_kinds: OpportunityKind[];
      names: ClientName[];
      role: string | null;
      mode: IntentMode;
      max_open: number;
      confirmed_at: Date;
      revoked_at: Date | null;
    }>(
      `select i.id, i.goal_id, i.opportunity_kinds, i.role, i.mode, i.max_open, i.confirmed_at, i.revoked_at,
         array(select c.name from unnest(i.client_ids) with ordinality as u (id, n) join policy.clients c on c.id = u.id order by u.n) as names
       from policy.intents i order by i.confirmed_at, i.id collate "C"`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    goal: row.goal_id,
    kinds: row.opportunity_kinds,
    clients: row.names,
    role: row.role,
    mode: row.mode,
    maxOpen: row.max_open,
    confirmedAt: stamp(row.confirmed_at),
    revokedAt: stampOrNull(row.revoked_at),
  }));
}

// An opportunity intent's role set or cleared, with the owner's
// intent_confirm decision. False for an id that is no unrevoked opportunity intent; the same
// role again writes nothing.
export async function setIntentRole(admin: AdminContext, id: IntentId, role: string | null): Promise<boolean> {
  if (role !== null && !RoleName.safeParse(role).success) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const [intent] = await query<{ role: string | null; clients: number }>(
      "select role, cardinality(client_ids)::int as clients from policy.intents where id = $1 and revoked_at is null and not for_tasks for update",
      [id],
    );
    if (intent === undefined) return false;
    if (intent.role === role) return true;
    // An intent with no client list keeps its role: clearing it would leave the intent naming no one.
    if (role === null && intent.clients === 0) throw new AdminError("invalid_argument");
    await grantDecision(query, { kind: "intent_confirm", target: { kind: "intent", id } }, now);
    await query("update policy.intents set role = $2 where id = $1", [id, role]);
    return true;
  });
}

// False for an id that is no intent, or one already revoked. A revoke writes its intent_revoke
// decision in its transaction.
export async function revokeIntent(
  admin: AdminContext,
  id: IntentId,
  options: { requestId?: string } = {},
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const revoked = await query(
      "update policy.intents set revoked_at = $2 where id = $1 and revoked_at is null returning id",
      [id, stamp(now)],
    );
    if (revoked.length === 0) return false;
    // A request id another revoke used is refused, and this revoke rolls back with it.
    if (
      (
        await grantDecision(
          query,
          { kind: "intent_revoke", target: { kind: "intent", id }, requestId: options.requestId },
          now,
        )
      ).repeated !== null
    )
      throw new AdminError("invalid_argument");
    return true;
  });
}

// Mode act on an internal stage; no harness is built for anything else, so it is not_built. A
// name that is not an active agent is not_found.
export async function grantHarnessMode(
  admin: AdminContext,
  grant: HarnessModeGrant,
  options: { requestId?: string } = {},
): Promise<HarnessModeId> {
  const parsed = HarnessModeGrant.safeParse(grant);
  if (!parsed.success) throw new AdminError("invalid_argument");
  if (!INTERNAL_STAGES.includes(parsed.data.stage) || parsed.data.mode !== "act") throw new AdminError("not_built");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const [client] = await query<{ id: string }>(
      "select id from policy.clients where name = $1 and status = 'active' and kind = 'agent'",
      [parsed.data.client],
    );
    if (client === undefined) throw new AdminError("not_found");
    const id = newId("hrn") as HarnessModeId;
    const ruling = await grantDecision(
      query,
      { kind: "harness_grant", target: { kind: "harness_mode", id }, requestId: options.requestId },
      now,
    );
    if (ruling.repeated !== null) return ruling.repeated as HarnessModeId;
    await query(
      "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, $5, $6)",
      [id, client.id, parsed.data.kind, parsed.data.stage, parsed.data.mode, stamp(now)],
    );
    return id;
  });
}

export async function listHarnessModes(admin: AdminContext): Promise<HarnessModeView[]> {
  const rows = await admin.transaction((query) =>
    query<{
      id: HarnessModeId;
      name: ClientName;
      opportunity_kind: OpportunityKind;
      stage: string;
      mode: string;
      granted_at: Date;
      revoked_at: Date | null;
    }>(
      `select h.id, c.name, h.opportunity_kind, h.stage, h.mode, h.granted_at, h.revoked_at
       from policy.harness_modes h join policy.clients c on c.id = h.client_id order by h.granted_at, h.id collate "C"`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    client: row.name,
    kind: row.opportunity_kind,
    stage: row.stage,
    mode: row.mode,
    grantedAt: stamp(row.granted_at),
    revokedAt: stampOrNull(row.revoked_at),
  }));
}

// False for an id that is no harness mode, or one already revoked; a revoke writes its
// harness_revoke decision in its transaction.
export async function revokeHarnessMode(
  admin: AdminContext,
  id: HarnessModeId,
  options: { requestId?: string } = {},
): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const revoked = await query(
      "update policy.harness_modes set revoked_at = $2 where id = $1 and revoked_at is null returning id",
      [id, stamp(now)],
    );
    if (revoked.length === 0) return false;
    if (
      (
        await grantDecision(
          query,
          { kind: "harness_revoke", target: { kind: "harness_mode", id }, requestId: options.requestId },
          now,
        )
      ).repeated !== null
    )
      throw new AdminError("invalid_argument");
    return true;
  });
}

// -------------------------------------------------------------------------------------------
// The switch, the budget and a run on request (admin-work-planner.ts)
// -------------------------------------------------------------------------------------------

// Trial runs: `pi work trial`, `pi work trials` and `pi work trial-show`. Each
// opens what it shows for a terminal only.
// One trial for each model, in one transaction, so they are taken back to back.
export async function queueTrials(
  admin: AdminContext,
  request: Omit<TrialRequest, "trial">,
  trials: readonly RunTrial[],
): Promise<RunId[]> {
  if (trials.length === 0) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const runs: RunId[] = [];
    for (const trial of trials) runs.push(await queueTrial(query, { ...request, trial }, now));
    return runs;
  });
}
