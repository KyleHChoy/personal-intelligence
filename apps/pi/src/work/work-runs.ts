import {
  HypothesisId,
  LearningId,
  OpportunityKind,
  OwnerNote,
  PlannerStage,
  RoleName,
  STAGE_PROMPT_IDS,
  TrialEffort,
  TrialModelId,
  ULID_PATTERN,
} from "@intelligence/contracts/personal";
import { ALL_STAGE_PROMPTS, decide, REGISTRY, wakeWorthRun } from "@intelligence/personal-ladder";
import { MISSION_MOST, REPORT_DAYS } from "@intelligence/personal-store";
import { found, refusal } from "../env.ts";
import { list, parsed, print, printJson, requestId, withAdmin } from "../owner/owner-kit.ts";

import { anchorOf, type Body, count, LESSON_MOST, textOf, type Value } from "./work-args.ts";

// The owner's lessons, mission and agents' learnings, the planner's runs and reports, and the
// trials of its stages, as pi_admin, through withAdmin.

// A repeatable option's values, each parsed, sorted and once; none when it is absent.
function sortedOnce<T extends string>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: Value,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw refusal("usage");
  return [...new Set(value.map((one) => parsed(schema, one)))].sort();
}

// `work lesson add [--kind K]... [--role R]...`, the lesson from stdin: a planning lesson in the
// owner's own words, confirmed as the owner adds it, for the opportunity kinds and roles given, or all.
// Prints its id. `work lesson retire ID [--note TEXT] [--lift]`: the owner's `retired` on a lesson, or
// with `--lift` their `confirmed` again, with their one-line note.
export const workLesson: Body = async (context) => {
  const [verb, id] = context.positionals;
  const { values } = context;
  if (verb === "retire") {
    if (values.kind !== undefined || values.role !== undefined) throw refusal("usage");
    const lesson = parsed(HypothesisId, id);
    const { note } = values;
    if (note !== undefined && !OwnerNote.safeParse(note).success) throw refusal("usage");
    const options = { ...(values.lift === true ? { lift: true } : {}), ...(typeof note === "string" ? { note } : {}) };
    return withAdmin(context, async (admin) => {
      await admin.work.retireLesson(lesson, options);
    });
  }
  if (verb !== "add" || id !== undefined || values.note !== undefined || values.lift !== undefined)
    throw refusal("usage");
  const kinds = sortedOnce(OpportunityKind, values.kind);
  const roles = sortedOnce(RoleName, values.role);
  const text = await textOf(context, LESSON_MOST);
  return withAdmin(context, async (admin) => {
    print(
      context,
      await admin.work.addLesson(text, {
        requestId: requestId(),
        ...(kinds.length === 0 ? {} : { kinds }),
        ...(roles.length === 0 ? {} : { roles }),
      }),
    );
  });
};

// `work learnings [--all]`: every learning agents filed, newest
// first, the active ones unless --all, each with its state, filer, words and what it supersedes. It
// prints agents' words, so to a terminal only. `work learning retire ID [--lift]`: the owner's veto of
// one, or its lifting.
export const workLearnings: Body = async (context) =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.work.learnings({ all: context.values.all === true }));
  });

export const workLearning: Body = async (context) => {
  const [verb, id] = context.positionals;
  if (verb !== "retire") throw refusal("usage");
  const learning = parsed(LearningId, id);
  return withAdmin(context, async (admin) => {
    await admin.work.retireLearning(learning, context.values.lift === true ? { lift: true } : {});
  });
};

// `work mission set | show`, the text of `set` from stdin: the owner's own words on what they want
// from the planner, 1 to 2 000 code points, sealed under `own`; `show` prints them. To a terminal
// only.
export const workMission: Body = async (context) => {
  const [verb] = context.positionals;
  if (verb === "show") {
    return withAdmin(context, async (admin) => {
      printJson(context, await admin.work.mission());
    });
  }
  if (verb !== "set") throw refusal("usage");
  // From stdin, never an argument: the mission stays out of shell history and the process list,
  // as a goal's statement does.
  const text = await textOf(context, MISSION_MOST);
  return withAdmin(context, async (admin) => {
    await admin.work.setMission(text);
  });
};

// `work run [--goal ID | --entity ID]`: the wake's facts, rung 0 of wake_worth_run, then the run or
// the silence. Exits 0 either way. `work run --idea ID` queues a translate run again for an idea
// the owner pursued, as their pursue did, with no wake decision.
export const workRun: Body = async (context) => {
  if (context.values.idea !== undefined) {
    if (context.values.goal !== undefined || context.values.entity !== undefined) throw refusal("usage");
    const idea = parsed(HypothesisId, context.values.idea);
    return withAdmin(context, async (admin) => {
      printJson(context, { run: await admin.work.queueIdeaRun(idea) });
    });
  }
  const anchor = anchorOf(context.values);
  return withAdmin(context, async (admin) => {
    const facts = await admin.work.wakeFacts(anchor);
    const call = decide(REGISTRY, "wake_worth_run", facts, wakeWorthRun);
    const verdict = wakeWorthRun(facts);
    const request = { requestId: requestId() };
    // Rung 0 always decides this point: decide has thrown otherwise.
    if (verdict !== "cannot_decide" && verdict.output === "skip") {
      await admin.work.silenceRequestedRun(anchor, verdict.reason, call, request);
      printJson(context, { silenced: verdict.reason });
      return;
    }
    printJson(context, { run: await admin.work.queueRequestedRun(anchor, call, request) });
  });
};

// `work show ID`: one row with its chain, opened, to a terminal only. `work report [--days N]`:
// each run of the last N days (1 to 90, 7 by default), newest first, with its prompt, turns, tool
// calls by tool, refusals, cut-off replies, cost and outcome, and what it proposed with the owner's
// answers and notes, each run's yield (proposed, answered, accepted, used); then the proposals summed
// by prompt version and kind, with the owner's answers and the approval rate; then the yield by UTC
// week and prompt, with the cost of each accepted and each used item; then the report marks counted
// by client and mark; and
// query-time's trigger counts, counts only; and the dream block (the pass's sweep, the relation
// switches, each kind's source checks with their Wilson lower bound, and the audits); and the count
// of the owner's decisions per day by how they teach, counts only. It prints summaries and notes:
// to a terminal only.
export const workReport: Body = async (context) => {
  const days = count(context.values.days) ?? REPORT_DAYS.default;
  if (days < REPORT_DAYS.least || days > REPORT_DAYS.most) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.work.report(days));
  });
};

// `work trial --stage S --model ID[,ID...] --effort E[,E...] [--idea ID]`: one trial run per model,
// queued together so they are taken back to back on the same inputs, their ids printed. One effort
// is every model's; a list gives each its own. `--idea` is translate's, and only translate's. Model
// and effort are the owner's, checked before any connection.
const MOST_TRIALS = 4;
export const workTrial: Body = async (context) => {
  const { values } = context;
  const stage = parsed(PlannerStage, values.stage);
  const models = list(values.model).map((model) => parsed(TrialModelId, model));
  const efforts = list(values.effort).map((effort) => parsed(TrialEffort, effort));
  if (models.length > MOST_TRIALS || (efforts.length !== 1 && efforts.length !== models.length)) throw refusal("usage");
  const trials = models.map((model, at) => ({ model, effort: efforts[efforts.length === 1 ? 0 : at] ?? efforts[0]! }));
  if ((stage === "translate") !== (values.idea !== undefined)) throw refusal("usage");
  // A lessons trial of a registered prompt version run_outcome may not name yet.
  const version = values["prompt-version"];
  const promptVersion = typeof version === "string" ? version : undefined;
  if (
    version !== promptVersion ||
    (promptVersion !== undefined &&
      (stage !== "lessons" ||
        !ALL_STAGE_PROMPTS.some((one) => one.id === STAGE_PROMPT_IDS.lessons && one.version === promptVersion)))
  )
    throw refusal("usage");
  const idea = values.idea === undefined ? undefined : parsed(HypothesisId, values.idea);
  return withAdmin(context, async (admin) => {
    printJson(context, {
      runs: await admin.work.queueTrials(
        {
          stage,
          ...(idea === undefined ? {} : { idea }),
          ...(promptVersion === undefined ? {} : { promptVersion }),
        },
        trials,
      ),
    });
  });
};

// `work trials [--stage S]`: every trial, newest first, with its counts, times and cost. To a
// terminal only.
export const workTrials: Body = async (context) => {
  const stage = context.values.stage === undefined ? undefined : parsed(PlannerStage, context.values.stage);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.work.trials(stage));
  });
};

// `work trial-show RUN`: one trial's stored output, opened. To a terminal only.
export const workTrialShow: Body = async (context) => {
  const id = context.positionals[0] ?? "";
  if (!new RegExp(`^run_${ULID_PATTERN}$`).test(id)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const shown = found(await admin.work.trialShow(id));
    printJson(context, shown);
  });
};

export const workShow: Body = async (context) => {
  const id = context.positionals[0] ?? "";
  if (!new RegExp(`^(run|opp|hyp|mov)_${ULID_PATTERN}$`).test(id)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const shown = found(await admin.work.showWork(id));
    printJson(context, shown);
  });
};
