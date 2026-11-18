import {
  DeclineReason,
  GapTrigger,
  JudgeResultBody,
  OpportunityId,
  OWNER_WORDS_MOST,
  OwnerTaskBody,
  OwnerTaskKind,
  OwnerTaskRef,
  type RequestId,
  RoleName,
  SignalKind,
} from "@intelligence/contracts/personal";
import { isPlanner, type WorkBudget } from "@intelligence/personal-store";
import { found, refusal } from "../env.ts";
import { parsed, print, printJson, requestId, withAdmin, withNamed } from "../owner/owner-kit.ts";

import { type Body, count, textOf } from "./work-args.ts";

// The owner commands of durable work, as pi_admin: each a
// thin call into the store's admin.work, through withAdmin. Every argument is checked before the
// key file is read or a connection is made.

// Counts, codes and numbers only.
export const workStatus: Body = (context) =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.work.status());
  });

const killSwitch =
  (state: "on" | "off"): Body =>
  (context) =>
    withAdmin(context, async (admin) => {
      await admin.work.setKillSwitch(state, { requestId: requestId() });
    });
export const workStop: Body = killSwitch("on");
export const workStart: Body = killSwitch("off");

// The task tier on or off. Prints the task intent's id, or nothing when
// off.
export const workTasks: Body = (context) => {
  const state = context.positionals[0];
  if (state !== "on" && state !== "off") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const intent = await admin.work.setTaskTier(state === "on");
    if (intent !== null) print(context, intent);
  });
};

// A gap trigger's flags routed to a role, or to none with --none. With
// --default, the role a task proposed with no role and a flag with no route take, or none;
// unknown_role for one no active agent holds. With --questions, the role the owner's questions go
// through, or none, which is off.
export const workRoute: Body = (context) => {
  const none = context.values.none === true;
  if (context.values.questions === true) {
    const [role, extra] = context.positionals;
    if (extra !== undefined || context.values.default === true || none === (role !== undefined)) throw refusal("usage");
    const chosen = role === undefined ? null : parsed(RoleName, role);
    return withAdmin(context, async (admin) => {
      await admin.work.setQuestionRole(chosen);
    });
  }
  if (context.values.default === true) {
    const [role, extra] = context.positionals;
    if (extra !== undefined || none === (role !== undefined)) throw refusal("usage");
    const chosen = role === undefined ? null : parsed(RoleName, role);
    return withAdmin(context, async (admin) => {
      await admin.work.setDefaultTaskRole(chosen);
    });
  }
  const [trigger, role] = context.positionals;
  if (trigger === undefined || none === (role !== undefined)) throw refusal("usage");
  const routed = role === undefined ? null : parsed(RoleName, role);
  return withAdmin(context, async (admin) => {
    await admin.work.setGapRoute(parsed(GapTrigger, trigger), routed);
  });
};

const PING_PLACE = /^(role|client):[a-z][a-z0-9-]{1,39}$/;
const inRange = (value: unknown, least: number, most: number): number | undefined => {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
  if (!(number >= least && number <= most)) throw refusal("usage");
  return number;
};
// `work pings`: with no option, what is set. Else the default recipient first, then who an unclaimed
// ping falls back to, and its waits.
export const workPings: Body = (context) => {
  const { values } = context;
  const text = values.order;
  if (text !== undefined && (typeof text !== "string" || values["clear-order"] === true)) throw refusal("usage");
  const order = values["clear-order"] === true ? [] : text === undefined ? undefined : (text as string).split(",");
  if (order !== undefined && (order.length > 8 || !order.every((place) => PING_PLACE.test(place))))
    throw refusal("usage");
  const datedMinutes = inRange(values["dated-minutes"], 1, 10_080);
  const otherMinutes = inRange(values["other-minutes"], 1, 43_200);
  const batchHour = inRange(values["batch-hour"], 0, 23);
  const [signalKind, signalTo] = typeof values["signal-role"] === "string" ? values["signal-role"].split("=") : [];
  const signalRole =
    signalKind === undefined
      ? undefined
      : { kind: parsed(SignalKind, signalKind), role: signalTo === "none" ? null : parsed(RoleName, signalTo) };
  return withAdmin(context, async (admin) => {
    if (
      order !== undefined ||
      datedMinutes !== undefined ||
      otherMinutes !== undefined ||
      batchHour !== undefined ||
      signalRole !== undefined
    )
      await admin.box.setPingSettings({
        ...(order === undefined ? {} : { order }),
        ...(datedMinutes === undefined ? {} : { datedMinutes }),
        ...(otherMinutes === undefined ? {} : { otherMinutes }),
        ...(batchHour === undefined ? {} : { batchHour }),
        ...(signalRole === undefined ? {} : { signalRole }),
      });
    printJson(context, await admin.box.pingSettings());
  });
};

// The owner's no_go on one open task, or on work an agent approved with a bet, with their reason
// from the list, if given.
export const workCancel: Body = (context) => {
  const id = parsed(OpportunityId, context.positionals[0]);
  const reason = context.values.reason === undefined ? undefined : parsed(DeclineReason, context.values.reason);
  return withAdmin(context, async (admin) => {
    found(await admin.work.cancelTask(id, reason));
  });
};

// Work an agent holds, freed by the owner: back on the board for
// any agent, with nothing cancelled and no decline.
export const workFree: Body = (context) => {
  return withNamed(context, OpportunityId, async (admin, id) => {
    found(await admin.work.freeWork(id));
    print(context, "freed");
  });
};

// A task the owner opens for their agents, of a read-only kind, routed to a
// role, about the ids the owner names (`ent_`, `gol_`, `msg_`, or a fact's 64 hex), with their note on stdin. Its
// brief is built by the store's code. Prints the task's id and status.
const TASK_REF_KINDS = { ent_: "entity", gol_: "goal", msg_: "message" } as const;
function taskRef(value: string): OwnerTaskRef {
  const prefix = value.slice(0, 4) as keyof typeof TASK_REF_KINDS;
  const ref = OwnerTaskRef.safeParse({
    kind: /^[0-9a-f]{64}$/.test(value) ? "fact" : TASK_REF_KINDS[prefix],
    id: value,
  });
  if (!ref.success) throw refusal("usage");
  return ref.data;
}

export const workTask: Body = async (context) => {
  const role = parsed(RoleName, context.values.role);
  const kind = parsed(OwnerTaskKind, context.values.kind);
  const given = context.values.about ?? [];
  const about = (Array.isArray(given) ? given : [given]).map((value) => taskRef(String(value)));
  const body = OwnerTaskBody.safeParse({
    role,
    kind,
    about,
    note: await textOf(context, OWNER_WORDS_MOST),
    requestId: requestId(),
  });
  if (!body.success) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.work.addTask(body.data));
  });
};

// The owner's withdrawal of a task they opened, while no agent has claimed it.
export const workTaskWithdraw: Body = (context) => {
  return withNamed(context, OpportunityId, async (admin, task) => {
    await admin.work.withdrawTask({ task, requestId: requestId() as RequestId });
  });
};

// The owner's Keep or Not useful on a finished task's result, or `none` to clear it.
// Prints the ruling.
export const workResult: Body = (context) => {
  const body = JudgeResultBody.safeParse({
    move: context.positionals[0],
    answer: context.values.answer,
    ...(context.values.reason === undefined ? {} : { reason: context.values.reason }),
    requestId: requestId(),
  });
  if (!body.success) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    print(context, await admin.cards.judgeResult(body.data));
  });
};

// The bounds of one model call's output tokens, a reasoning model's reasoning included: under
// 1 000 a reasoning model has no room to call a tool, and 32 000 is past any day's need.
const OUTPUT_TOKENS = { least: 1_000, most: 32_000 };

// `work budget`: dollars to six places, and whole numbers for the rest.
export const workBudget: Body = async (context) => {
  const { values } = context;
  const usd = values.usd;
  const dollars = (value: unknown): boolean =>
    value === undefined || (typeof value === "string" && /^\d{1,6}(\.\d{1,6})?$/.test(value));
  if (!dollars(usd)) throw refusal("usage");
  const budget: WorkBudget = {};
  const runs = count(values.runs);
  const cards = count(values.cards);
  const inputChars = count(values["input-chars"]);
  const tokenPrice = count(values["token-price"]);
  const outputTokens = count(values["output-tokens"]);
  const lessonsEvery = count(values["lessons-every"]);
  if (lessonsEvery !== undefined && (lessonsEvery < 1 || lessonsEvery > 1000)) throw refusal("usage");
  // The daily sweep's hour, 0 to 23, the owner's local hour once their zone is set.
  const sweepHour = count(values["sweep-hour"]);
  if (sweepHour !== undefined && sweepHour > 23) throw refusal("usage");
  if (outputTokens !== undefined && (outputTokens < OUTPUT_TOKENS.least || outputTokens > OUTPUT_TOKENS.most))
    throw refusal("usage");
  if (runs !== undefined) budget.runs = runs;
  if (usd !== undefined) budget.usd = Number(usd);
  if (cards !== undefined) budget.cards = cards;
  if (inputChars !== undefined) budget.inputChars = inputChars;
  if (tokenPrice !== undefined) budget.tokenPrice = tokenPrice;
  if (outputTokens !== undefined) budget.outputTokens = outputTokens;
  if (lessonsEvery !== undefined) budget.lessonsEvery = lessonsEvery;
  if (sweepHour !== undefined) budget.sweepHour = sweepHour;
  // `research_only` runs only lessons; `split` and `one_pass` are the ways back to ideas.
  const planner = values.planner;
  if (planner !== undefined && !isPlanner(planner)) throw refusal("usage");
  if (planner !== undefined) budget.planner = planner;
  return withAdmin(context, async (admin) => {
    await admin.work.setWorkBudget(budget);
  });
};
