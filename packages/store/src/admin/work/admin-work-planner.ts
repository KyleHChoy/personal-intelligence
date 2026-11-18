// The planner's controls and runs on request: the kill switch, the budget, the mission and the
// lessons, a run the owner asks for or one for an idea they pursued, its silence, and the status
// that counts them against the budget.
import type { Timestamp } from "@intelligence/contracts";
import {
  type WakeFacts as ContractWakeFacts,
  type DecisionPointCall,
  type EntityId,
  type GoalId,
  GroupingMode,
  type HypothesisId,
  isCoded,
  type OpportunityKind,
  type RoleName,
  type RunId,
  type SilenceReason,
} from "@intelligence/contracts/personal";
import { codePoints } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId } from "../../core/ids.ts";
import { lockRows, vetoed } from "../../core/queue.ts";
import {
  isPlanner,
  MISSION_AT,
  type Planner,
  plannerOf,
  RETIRED_RUNS,
  runPlanOf,
  stageRuns,
} from "../../core/run-plan.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, sealUnder } from "../../core/seal.ts";
import type { Fixed } from "../../core/sql.ts";
import {
  KILL_SWITCH_STATE,
  LATEST_CARD_EVENT,
  latestEvent,
  latestRow,
  WAKE_CARD_COUNTS,
} from "../../core/statements.ts";
import { gapRoutes, type OpenWorkRow, openWork } from "../admin-tasks.ts";
import { heldDeferred, heldForNames, WAITING } from "../cards/admin-queue.ts";
import { queueTranslate } from "../cards/card-kinds-work.ts";
import { HYPOTHESIS_EVENT, RUN_QUEUED, recordEvent } from "../record-event.ts";
import { type SpendBasis, stepSpendBasis } from "./cost-basis.ts";

// What the dispatcher's `wakeWorthRun` reads, for the owner's request.
export type WakeFacts = ContractWakeFacts & { source: "owner_request" };

// A run on request is about a goal, an entity, or nothing.
export type WorkAnchor = { goal?: GoalId; entity?: EntityId };

// `lessonsEvery`: a lessons run after every N owner answers on ideas and opportunities.
export type WorkBudget = {
  runs?: number;
  usd?: number;
  cards?: number;
  inputChars?: number;
  tokenPrice?: number;
  outputTokens?: number;
  lessonsEvery?: number;
  planner?: Planner;
  // The hour, 0 to 23, the planner's daily sweep is due from: the owner's local hour once their zone
  // is set, UTC's until then. Stored in `sweep_hour_utc`, whose name is older.
  sweepHour?: number;
};

// The owner's own words on what they want from the planner, opened, for a terminal.
export type MissionView = { mission: string | null; setAt: Timestamp | null };
export const MISSION_MOST = 2000;

// Counts, codes and numbers: no statement, summary or name.
export type WorkStatusView = {
  killSwitch: "on" | "off";
  // The planner a wake queues under.
  planner: Planner;
  goals: Record<string, number>;
  hypotheses: Record<string, number>;
  opportunities: Record<string, number>;
  runs: Record<string, number>;
  intentions: Record<string, number>;
  today: {
    runs: number;
    maxRuns: number;
    spentMicroUsd: number;
    maxMicroUsd: number;
  };
  todayBasis: { spent: SpendBasis };
  cards: { pending: number; deferred: number; maxPending: number; waitingForNames: number };
  lastRuns: { id: RunId; outcome: string; code: string | null }[];
  open: OpenWorkRow[];
  tasks: "on" | "off";
  routes: { trigger: string; role: string }[];
  // The role unroled tasks and unrouted flags take, or none.
  defaultRole: string | null;
  // The owner's standing rules as they are now, which Settings' Autonomy shows.
  rules: { merges: "on" | "off"; agentCloses: "on" | "off"; grouping: GroupingMode };
};

const MICRO = 1_000_000;
// A lesson as a lessons run may write one.
const LESSON_MOST = 600;
const today = (now: Date): string => now.toISOString().slice(0, 10);

// A row's status is its latest event.
const LATEST = <K extends string>(kind: Fixed<K>, table: string) =>
  `select coalesce((${latestEvent(kind, "t.id")}), 'none') as state,
     count(*)::int as n from ${table} t group by 1 order by 1`;

const counted = (rows: { state: string; n: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.state, row.n]));

// The owner's standing rules as they are now: their merges switch, their release of commitment
// closes to agents (policy.agent_closes_on) and their grouping setting.
async function standingRules(query: Query): Promise<WorkStatusView["rules"]> {
  const [row] = await query<{ merges: string | null; closes: boolean; grouping: string | null }>(
    `select (select identity_merges from policy.work_settings) as merges, policy.agent_closes_on() as closes,
       (select grouping from policy.owner_settings) as grouping`,
  );
  return {
    merges: row?.merges === "on" ? "on" : "off",
    agentCloses: row?.closes === true ? "on" : "off",
    grouping: GroupingMode.parse(row?.grouping ?? "shadow"),
  };
}

// One row appended; the switch is its latest row.
export async function setKillSwitch(
  context: AdminContext,
  state: "on" | "off",
  options: { requestId: string },
): Promise<void> {
  if (state !== "on" && state !== "off") throw new AdminError("invalid_argument");
  const now = context.now();
  await context.transaction(async (query) => {
    await lockRows(query, []);
    await query(
      `insert into ledger.kill_switch (request_id, created_at, created_by, compartments, state) values ($1, $2, 'owner', '{own}', $3)
       on conflict (created_by, request_id) do nothing`,
      [options.requestId, stamp(now), state],
    );
  });
}

// Dollars as micro-dollars, the input limit as code points, the token price as micro-dollars
// a token, the output limit as tokens per model call. What is not given is left as it was.
export async function setWorkBudget(context: AdminContext, budget: WorkBudget): Promise<void> {
  const whole = (value: number | undefined, least: number): boolean =>
    value === undefined || (Number.isSafeInteger(value) && value >= least);
  const usd = budget.usd === undefined ? undefined : Math.round(budget.usd * MICRO);
  if (
    !whole(budget.runs, 0) ||
    !whole(budget.cards, 0) ||
    !whole(budget.inputChars, 1) ||
    !whole(budget.tokenPrice, 0) ||
    !whole(budget.outputTokens, 1) ||
    !whole(usd, 0) ||
    (budget.usd !== undefined && !(budget.usd >= 0)) ||
    !whole(budget.lessonsEvery, 1) ||
    (budget.lessonsEvery ?? 0) > 1000 ||
    !whole(budget.sweepHour, 0) ||
    (budget.sweepHour ?? 0) > 23 ||
    (budget.planner !== undefined && !isPlanner(budget.planner))
  ) {
    throw new AdminError("invalid_argument");
  }
  const now = context.now();
  await context.transaction(async (query) => {
    await query(
      `update policy.work_settings set
         max_runs_per_day = coalesce($1, max_runs_per_day),
         max_microusd_per_day = coalesce($2, max_microusd_per_day),
         max_pending_cards = coalesce($3, max_pending_cards),
         max_input_code_points = coalesce($4, max_input_code_points),
         ceiling_microusd_per_token = coalesce($5, ceiling_microusd_per_token),
         max_output_tokens = coalesce($6, max_output_tokens),
         lessons_every = coalesce($7, lessons_every),
         planner = coalesce($8, planner),
         sweep_hour_utc = coalesce($9, sweep_hour_utc)`,
      [
        budget.runs ?? null,
        usd ?? null,
        budget.cards ?? null,
        budget.inputChars ?? null,
        budget.tokenPrice ?? null,
        budget.outputTokens ?? null,
        budget.lessonsEvery ?? null,
        budget.planner ?? null,
        budget.sweepHour ?? null,
      ],
    );
    // Setting `research_only` ends every queued run of a stage it does not run,
    // as the kill switch ends runs, so none runs stale the day ideas are turned back on.
    if (budget.planner === "research_only") {
      const runs = await query<{ id: string }>(
        `select x.id from ledger.runs x where ${RETIRED_RUNS} order by x.id collate "C"`,
      );
      await lockRows(
        query,
        runs.map((run) => run.id),
      );
      await query(
        `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
         select 'run', x.id, 'stopped', $2, 'owner', x.compartments, 'planner_research_only' from ledger.runs x where x.id = any($1) and ${RETIRED_RUNS}`,
        [runs.map((run) => run.id), stamp(now)],
      );
    }
  });
}

// The owner's mission: 1 to 2 000 code points, sealed under `own` in its one row,
// which a later set replaces.
export async function setMission(context: AdminContext, text: string): Promise<void> {
  if (codePoints(text.trim()) === 0 || codePoints(text) > MISSION_MOST) throw new AdminError("invalid_argument");
  const { keys } = context;
  if (!keys.compartments.has("own")) throw new AdminError("unknown_compartment");
  const now = context.now();
  await context.transaction((query) =>
    query(
      `insert into projections.planner_mission (one, set_at, compartments, text_enc) values (true, $1, ledger.label($2), $3)
       on conflict (one) do update set set_at = excluded.set_at, text_enc = excluded.text_enc`,
      [stamp(now), ["own"], sealUnder(keys, ["own"], MISSION_AT, text)],
    ),
  );
}

// A planning lesson in the owner's own words: a case and a hypothesis of kind lesson about the
// owner, sealed under `own`, opened and confirmed by the owner at once, so every planner run and
// every agent's brief holds it as a lesson they confirmed on a card. Returns its id; a repeated
// request id returns the first. `kinds` and `roles`, the opportunity kinds and roles it is for;
// none given is for all.
export async function addLesson(
  context: AdminContext,
  text: string,
  options: { requestId: string; kinds?: readonly OpportunityKind[]; roles?: readonly RoleName[] },
): Promise<HypothesisId> {
  if (codePoints(text.trim()) === 0 || codePoints(text) > LESSON_MOST) throw new AdminError("invalid_argument");
  const { keys } = context;
  if (!keys.compartments.has("own")) throw new AdminError("unknown_compartment");
  const id = newId("hyp") as HypothesisId;
  const body = sealUnder(keys, ["own"], { table: "ledger.hypotheses", id, column: "body_enc" }, text);
  return context.transaction(async (query) => {
    const [row] = await query<{ id: HypothesisId }>(
      "select ledger.add_owner_lesson($1, $2, $3::jsonb, $4::text[], $5::text[]) as id",
      [
        id,
        options.requestId,
        JSON.stringify(body),
        options.kinds === undefined ? null : [...options.kinds],
        options.roles === undefined ? null : [...options.roles],
      ],
    );
    if (row === undefined) throw new AdminError("invalid_argument");
    return row.id;
  });
}

// A lesson in force retired, or a retired one lifted; one already so is `unchanged`, with nothing
// written. Any other id, a lesson still waiting for the owner's card among them, is not found.
export async function retireLesson(
  context: AdminContext,
  id: HypothesisId,
  options: { lift?: boolean; note?: string } = {},
): Promise<void> {
  const name = options.lift === true ? "confirmed" : "retired";
  const { keys } = context;
  const now = context.now();
  await context.transaction(async (query) => {
    await lockRows(query, [id]);
    const [row] = await query<{ compartments: string[]; latest: string | null }>(
      `select h.compartments, (${latestEvent("hypothesis", "h.id")}) as latest
       from ledger.hypotheses h where h.id = $1 and h.kind = 'lesson' and h.tainted_at is null`,
      [id],
    );
    if (row === undefined || (row.latest !== "confirmed" && row.latest !== "retired"))
      throw new AdminError("not_found");
    // Already so: nothing is written, the note included, and the owner is told.
    if (row.latest === name) throw new AdminError("unchanged");
    let body: unknown = null;
    if (options.note !== undefined) {
      try {
        body = sealUnder(
          keys,
          row.compartments,
          { table: "ledger.record_events", id: `${id}/${name}`, column: "body_enc" },
          options.note,
        );
      } catch (error) {
        // A compartment the key file lacks; any other fault is not one.
        if (isCoded(error, "unknown_compartment")) throw new AdminError("unknown_compartment");
        throw error;
      }
    }
    await recordEvent(query, HYPOTHESIS_EVENT, id, stamp(now), row.compartments, { event: name, body });
  });
}

export async function mission(context: AdminContext): Promise<MissionView> {
  const [row] = await context.transaction((query) =>
    query<{ set_at: Date; compartments: string[]; text_enc: Sealed }>(
      "select set_at, compartments, text_enc from projections.planner_mission",
    ),
  );
  if (row === undefined) return { mission: null, setAt: null };
  return {
    mission: open(context.keys, { ...row, id: MISSION_AT.id }, "projections.planner_mission.text_enc", "withheld"),
    setAt: stamp(row.set_at),
  };
}

// The facts of a wake from the owner's request, as the dispatcher reads them.
export async function wakeFacts(context: AdminContext, anchor: WorkAnchor = {}): Promise<WakeFacts> {
  const now = context.now();
  return context.transaction((query) => wakeFactsOf(query, anchor, now));
}

// A queued run, its `queued` event, its anchor as its basis and the wake_worth_run call, in one
// transaction. A repeated request id returns the first run.
export async function queueRequestedRun(
  context: AdminContext,
  anchor: WorkAnchor,
  call: DecisionPointCall,
  options: { requestId: string },
): Promise<RunId> {
  if (call.point !== "wake_worth_run" || call.output !== "run") throw new AdminError("invalid_argument");
  const now = context.now();
  const key = `owner:${options.requestId}`;
  return context.transaction(async (query) => {
    await lockRows(query, []);
    const [first] = await query<{ id: RunId }>("select id from ledger.runs where wake_key = $1", [key]);
    if (first !== undefined) return first.id;
    const refs = await anchorRefs(anchor);
    const compartments = await withinReasoner(query, await labelOf(query, anchor));
    const id = newId("run") as RunId;
    const at = stamp(now);
    const plan = runPlanOf("owner_request", await plannerFor(query, "owner_request"));
    await query(
      `insert into ledger.runs (id, request_id, created_at, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
       values ($1, $2, $3, 'owner', ledger.label($4), 'owner_request', $5, 'run_outcome', $6, $7, $8)`,
      [id, options.requestId, at, compartments, key, plan.version, plan.promptId, plan.promptVersion],
    );
    await recordEvent(query, RUN_QUEUED, id, at, compartments);
    if (refs.length > 0) {
      const [basis] = await query<{ ok: boolean }>("select ledger.add_basis('run', $1, $2, $3, $4, null) as ok", [
        id,
        compartments,
        refs.map((ref) => ref.kind),
        refs.map((ref) => ref.id),
      ]);
      if (basis?.ok !== true) throw new AdminError("not_found");
    }
    await callRow(query, call, {
      requestId: options.requestId,
      compartments,
      subjectKind: "run",
      subjectId: id,
      now,
    });
    return id;
  });
}

// `pi work run --idea ID`: a translate run again for an idea the owner already
// pursued, for when its first run's work was lost. An idea not `pursued` is refused. Its key is
// `idea:<id>:<n>`, n one more than the idea's translate runs, so it never meets the first's.
export async function queueIdeaRun(context: AdminContext, idea: HypothesisId): Promise<RunId> {
  const now = context.now();
  return context.transaction(async (query) => {
    await lockRows(query, [idea]);
    const [row] = await query<{ compartments: string[]; status: string | null }>(
      `select h.compartments, (${latestEvent("hypothesis", "h.id")}) as status
       from ledger.hypotheses h where h.id = $1 and h.kind = 'idea' and h.tainted_at is null`,
      [idea],
    );
    if (row === undefined) throw new AdminError("not_found");
    if (row.status !== "pursued") throw new AdminError("invalid_argument");
    await plannerFor(query, "idea_pursued");
    const key = `idea:${idea}`;
    const [runs] = await query<{ n: number }>(
      "select count(*)::int as n from ledger.runs where wake_key = $1 or starts_with(wake_key, $1 || ':')",
      [key],
    );
    const id = await queueTranslate(query, idea, row.compartments, now, `${key}:${(runs?.n ?? 0) + 1}`);
    if (id === null) throw new AdminError("invalid_argument");
    return id as RunId;
  });
}

// The silence of a wake from the owner's request, and its call row.
export async function silenceRequestedRun(
  context: AdminContext,
  anchor: WorkAnchor,
  reason: SilenceReason,
  call: DecisionPointCall,
  options: { requestId: string },
): Promise<void> {
  if (call.point !== "wake_worth_run" || call.output !== "skip") throw new AdminError("invalid_argument");
  const now = context.now();
  const key = `owner:${options.requestId}`;
  await context.transaction(async (query) => {
    await lockRows(query, []);
    await plannerFor(query, "owner_request");
    const compartments = await withinReasoner(query, await labelOf(query, anchor));
    const inserted = await query(
      `insert into ledger.silences (request_id, created_at, created_by, compartments, reason, wake_source, wake_key, day)
       values ($1, $2, 'owner', ledger.label($3), $4, 'owner_request', $5, $6) on conflict do nothing returning id`,
      [options.requestId, stamp(now), compartments, reason, key, today(now)],
    );
    if (inserted.length > 0)
      await callRow(query, call, {
        requestId: options.requestId,
        compartments,
        subjectKind: "wake",
        subjectId: key,
        now,
      });
  });
}

// Counts by state, the switch, today against the budget, the cards, and the last five runs.
export async function workStatus(context: AdminContext): Promise<WorkStatusView> {
  const now = context.now();
  return context.transaction(async (query) => {
    const settings = await workSettings(query);
    // Waiting by the queue's one rule (admin-queue.ts WAITING): pending and not past its expiry,
    // so this count, Today's list and the Ledger's last point agree.
    const [cards] = await query<{ pending: number; deferred: number }>(
      `select (select count(*) ${WAITING("$1")})::int as pending,
         (select count(*) from ledger.cards c
            join lateral (${LATEST_CARD_EVENT}) s on true
          where s.event = 'deferred')::int as deferred`,
      [stamp(now)],
    );
    const held = await heldForNames(query, context.keys, now);
    const heldBack = await heldDeferred(query);
    const last = await query<{ id: RunId; outcome: string; code: string | null }>(
      `select t.id, e.event as outcome, e.code from ledger.runs t
       join lateral (${latestRow("r.event, r.code", "run", "t.id")}) e on true
       order by t.created_at desc, t.id collate "C" desc limit 5`,
    );
    return {
      killSwitch: (await killSwitch(query)) ? "on" : "off",
      planner: settings.planner,
      goals: counted(
        await query("select status as state, count(*)::int as n from projections.goal_state group by 1 order by 1"),
      ),
      hypotheses: counted(await query(LATEST("hypothesis", "ledger.hypotheses"))),
      opportunities: counted(await query(LATEST("opportunity", "ledger.opportunities"))),
      runs: counted(await query(LATEST("run", "ledger.runs"))),
      intentions: counted(await query(LATEST("intention", "ledger.intentions"))),
      today: {
        runs: await runsToday(query, now),
        maxRuns: settings.max_runs_per_day,
        spentMicroUsd: await spentToday(query, now),
        maxMicroUsd: Number(settings.max_microusd_per_day),
      },
      todayBasis: await stepSpendBasis(query, today(now)),
      cards: {
        pending: Math.max(0, (cards?.pending ?? 0) - held.size),
        deferred: Math.max(0, (cards?.deferred ?? 0) - heldBack),
        maxPending: settings.max_pending_cards,
        waitingForNames: held.size + heldBack,
      },
      lastRuns: last,
      open: await openWork(query),
      tasks:
        (await query("select 1 from policy.intents where for_tasks and revoked_at is null")).length > 0 ? "on" : "off",
      routes: await gapRoutes(query),
      defaultRole: settings.default_task_role,
      rules: await standingRules(query),
    };
  });
}

// The planner, when it runs a wake's stage; `research_only` refused otherwise.
async function plannerFor(query: Query, source: "owner_request" | "idea_pursued"): Promise<Planner> {
  const planner = await plannerOf(query);
  if (!stageRuns(source, planner)) throw new AdminError("research_only");
  return planner;
}

function workSettings(query: Query) {
  return query<{
    max_runs_per_day: number;
    max_microusd_per_day: string;
    max_pending_cards: number;
    planner: Planner;
    default_task_role: string | null;
  }>(
    "select max_runs_per_day, max_microusd_per_day, max_pending_cards, planner, default_task_role from policy.work_settings",
  ).then((rows) => {
    const [row] = rows;
    if (row === undefined) throw new Error("policy.work_settings has no row");
    return row;
  });
}

async function killSwitch(query: Query): Promise<boolean> {
  const [row] = await query<{ state: string }>(KILL_SWITCH_STATE);
  return row?.state === "on";
}

async function runsToday(query: Query, now: Date): Promise<number> {
  // A trial is not counted against the day's runs.
  const [row] = await query<{ n: number }>(
    "select count(*)::int as n from ledger.runs where created_at >= ($1::date::timestamp at time zone 'UTC') and created_at < (($1::date + 1)::timestamp at time zone 'UTC') and trial_model is null",
    [today(now)],
  );
  return row?.n ?? 0;
}

// The day's spend, every run's and every agent's.
async function spentToday(query: Query, now: Date): Promise<number> {
  const [row] = await query<{ spent: string }>("select ledger.spend_on($1::date) as spent", [today(now)]);
  return Number(row?.spent ?? 0);
}

async function wakeFactsOf(query: Query, anchor: WorkAnchor, now: Date): Promise<WakeFacts> {
  const settings = await workSettings(query);
  const [reasoner] = await query<{ compartments: string[] }>(
    "select compartments from policy.clients where kind = 'reasoner' and status = 'active'",
  );
  const [cards] = await query<{ deferred: number; pending: number }>(`select ${WAKE_CARD_COUNTS}`, [
    reasoner?.compartments ?? [],
  ]);
  const refs = anchor.entity === undefined ? [] : [{ kind: "entity" as const, id: anchor.entity }];
  return {
    source: "owner_request",
    killSwitch: await killSwitch(query),
    anchorVetoed: refs.length > 0 && (await vetoed(query, { refs })),
    reasonerRegistered: reasoner !== undefined,
    reasonerDeferredCards: cards?.deferred ?? 0,
    pendingCardsInClearance: reasoner === undefined ? 0 : (cards?.pending ?? 0),
    maxPendingCards: settings.max_pending_cards,
    runsToday: await runsToday(query, now),
    maxRunsPerDay: settings.max_runs_per_day,
    spentTodayMicroUsd: await spentToday(query, now),
    maxMicroUsdPerDay: Number(settings.max_microusd_per_day),
  };
}

// The anchor as refs. It reads nothing: a goal or an entity that does not exist is refused as
// not_found by the label read that follows it.
async function anchorRefs(anchor: WorkAnchor): Promise<{ kind: "goal" | "entity"; id: string }[]> {
  if (anchor.goal !== undefined && anchor.entity !== undefined) throw new AdminError("invalid_argument");
  if (anchor.goal !== undefined) return [{ kind: "goal", id: anchor.goal }];
  if (anchor.entity !== undefined) return [{ kind: "entity", id: anchor.entity }];
  return [];
}

// A goal's are its state row's; an entity's are those of its addresses and domains.
async function labelOf(query: Query, anchor: WorkAnchor): Promise<string[]> {
  if (anchor.goal !== undefined && anchor.entity !== undefined) throw new AdminError("invalid_argument");
  if (anchor.goal !== undefined) {
    const [goal] = await query<{ compartments: string[] }>(
      "select compartments from projections.goal_state where goal_id = $1",
      [anchor.goal],
    );
    if (goal === undefined) throw new AdminError("not_found");
    return goal.compartments;
  }
  if (anchor.entity !== undefined) {
    const held = await query<{ compartment: string }>(
      `select distinct one as compartment from (
         select compartments from knowledge.accounts where entity_id = $1 union all select compartments from knowledge.domains where entity_id = $1) h,
       unnest(h.compartments) as one order by 1`,
      [anchor.entity],
    );
    if (held.length === 0) throw new AdminError("not_found");
    return held.map((row) => row.compartment);
  }
  return ["own"];
}

// With no active reasoner, the wake is silenced as no_reasoner.
async function withinReasoner(query: Query, compartments: string[]): Promise<string[]> {
  const [reasoner] = await query<{ compartments: string[] }>(
    "select compartments from policy.clients where kind = 'reasoner' and status = 'active'",
  );
  if (reasoner !== undefined && !compartments.every((one) => reasoner.compartments.includes(one)))
    throw new AdminError("not_found");
  return compartments;
}

async function callRow(
  query: Query,
  call: DecisionPointCall,
  row: { requestId: string; compartments: string[]; subjectKind: string; subjectId: string; now: Date },
): Promise<void> {
  await query(
    `insert into ledger.decision_point_calls (id, request_id, created_at, created_by, compartments, point, version, definition_hash, rung, input_hash, output, effect,
       effect_class, escalated, subject_kind, subject_id)
     values ($1, $2, $3, 'owner', ledger.label($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      newId("dpc"),
      row.requestId,
      stamp(row.now),
      row.compartments,
      call.point,
      call.version,
      call.definitionHash,
      call.rung,
      call.inputHash,
      call.output,
      call.effect,
      call.effectClass,
      call.escalated,
      row.subjectKind,
      row.subjectId,
    ],
  );
}
