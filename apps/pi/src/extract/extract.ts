import { isCanaryCompartment, type ModelUsageEvent, type RunCode } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import {
  EXTRACT_GENERATION,
  keyVersionOf,
  matchKey,
  NEGATION_CUT_GENERATION,
  ownLinesTrialLines,
  type RunThresholds,
  refusalsReportLines,
  runAgeing,
  runCapture,
  runExtraction,
  runOwnLinesTrial,
  runRefusals,
  runThresholds,
  runTrial,
  trialReportLines,
} from "@intelligence/personal-extract";
import { effectiveThresholds } from "@intelligence/personal-ladder";
import { withBudget } from "@intelligence/personal-models";
import {
  createGapLaneStore,
  createGroupingStore,
  createOutcomeStore,
  createRelationStore,
  createTimePassStore,
  type Pipeline,
} from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { Refusal, refusal } from "../env.ts";
import {
  checkCaps,
  clientOf,
  count,
  decideClientOf,
  decideModelOf,
  extractModelOf,
  extractSettings,
  extractVendorOf,
  guardedClient,
  judgeModelOf,
  lanesOffOf,
  type ModelClient,
  momentModelOf,
  readsOpenRouter,
  withPipeline,
} from "./extract-config.ts";
import { runGapLanes } from "./gap-lanes.ts";
import { runOutcomes } from "./outcomes.ts";
import { runRelations } from "./relations.ts";
import { runSameFact } from "./same-fact.ts";
import { runTimeProposals } from "./time-proposals.ts";

// The extraction run commands, as pi_pipeline: `pi extract` with the relation, outcome and
// same-fact steps after it, `extract trial`, `extract age`, `extract match-backfill` and
// `triggers seed`.

// The run codes that end `pi extract` as a refusal; every other run code ends it cleanly.
const FAILS: ReadonlySet<RunCode> = new Set(["model_refused", "cost_missing", "store_unavailable"]);

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const CANARY_DOCUMENT_DAYS = 90;
const CANARY_LEAST_MICRO_USD = 250_000;

async function thresholdsOf(store: Pipeline): Promise<RunThresholds> {
  const [grants, suspended] = await Promise.all([store.thresholds(), store.suspensions()]);
  return runThresholds(
    effectiveThresholds(grants),
    suspended.map((one) => `${one.point}@${one.version}`),
  );
}

export async function extractCommand(context: CommandContext): Promise<0> {
  const { env, values, log, deps } = context;
  const settings = extractSettings(env, values);
  const decideModelId = decideModelOf(env);
  const modelId = extractModelOf(env);
  const vendor = extractVendorOf(env, modelId);
  const moment = momentModelOf(env, vendor, modelId);
  const judgeModel = judgeModelOf(env, vendor, modelId);
  const openRouter = readsOpenRouter(vendor, decideModelId !== undefined);
  const now = deps.now ?? (() => new Date());
  // `--agent-records`, the proposal wake's run.
  const agentRecords = values["agent-records"] === true;
  // `--capture ID`: one stored meeting or moment alone, by its `cap_` id or capture key.
  const capture = typeof values.capture === "string" ? values.capture : undefined;
  // A run in flight: `already_running`, and `busy` on stdout, which the wake and the timer read.
  const busy = (): 0 => {
    log.info({ event: "already_running" });
    context.io.stdout.write("busy\n");
    return 0;
  };
  return withPipeline(
    context,
    async (store, apiKey, held, keys): Promise<0> => {
      // The lock is asked first, so a run that finds one in flight
      // reads no spend cap from the vendor. The run still takes the lock itself below.
      if (!(await store.extractLockFree())) return busy();
      // The item the owner named, read before the spend cap, so a wrong one reads none.
      const named = capture === undefined ? undefined : await store.captureNamed(capture);
      if (named === null) throw refusal("not_found");
      // One line, the code and the two counts, then a refusal ends the
      // command with that code.
      await checkCaps(context, vendor, openRouter, apiKey, settings.keyCapMicroUsd, settings.keyUrl);
      // The check never takes the last of a day's budget from the owner's own items.
      const canary = values.canary === true;
      if (canary && settings.dayMicroUsd - (await store.spentSince(dayOf(now()))) < CANARY_LEAST_MICRO_USD) {
        log.info({ event: "canary_budget", code: "budget" });
        context.io.stdout.write("budget\n");
        return 0;
      }
      // The run's spend, and whether an answer of it carried no cost.
      // Counted before the row is written, so a failed write never lets a call through.
      let spent = 0;
      let costMissing = false;
      // The decide model's usage counts on the same run and day lines as the extract model's, under its own id
      //.
      const onUsage = async (event: ModelUsageEvent): Promise<void> => {
        spent += event.costMicroUsd;
        if (event.outcome === "cost_missing") costMissing = true;
        await store.recordUsage(event);
      };
      // Each client has its own count of calls, but for the moment lane's, which
      // shares the main client's: a model chosen for one lane does not raise the run's call bound.
      const runCalls = { made: 0 };
      const budgetOf = (calls?: { made: number }): Parameters<typeof guardedClient>[3] => ({
        ...(calls === undefined ? {} : { calls }),
        spentRun: () => spent,
        spentDay: () => store.spentSince(dayOf(now())),
        costMissing: () => costMissing,
        runMicroUsd: settings.runMicroUsd,
        dayMicroUsd: settings.dayMicroUsd,
        maxCalls: settings.maxCalls,
      });
      const budgeted = (client: ModelClient, calls?: { made: number }): ModelClient =>
        withBudget(client, budgetOf(calls));
      // The clients of the model and decide calls, whose exposure is noted.
      const noted = (id: string, client: ModelClient, calls?: { made: number }): ModelClient =>
        guardedClient(client, store, id, budgetOf(calls));
      const model = noted(modelId, clientOf(context, vendor, apiKey, modelId, onUsage), runCalls);
      // The moment lane's own client, under its own id, wrapped as the extract model's is: its
      // usage rows, exposure notes and saved calls name the model that answered. The run's count
      // of calls and its run and day spend.
      const momentModel =
        moment === undefined
          ? undefined
          : {
              model: noted(moment.modelId, clientOf(context, moment.vendor, apiKey, moment.modelId, onUsage), runCalls),
              modelId: moment.modelId,
            };
      const decideModel =
        decideModelId === undefined
          ? undefined
          : {
              model: noted(decideModelId, decideClientOf(context, apiKey, decideModelId, onUsage)),
              modelId: decideModelId,
            };
      const thresholds = decideModel === undefined ? undefined : await thresholdsOf(store);
      // `--canary`, the standing check's run: its compartments alone, every lane on whatever the
      // owner's switches say, no relation step and no sweep, so what it asks of the model is one
      // short item per lane.
      const deps = {
        store,
        model,
        modelId,
        log,
        now,
        compartments: canary ? held.filter(isCanaryCompartment) : (settings.compartments ?? held),
        ...(canary ? { documents: settings.documents ?? { days: CANARY_DOCUMENT_DAYS } } : {}),
        ...(!canary && settings.documents !== undefined ? { documents: settings.documents } : {}),
        ...(settings.meetings || canary ? { meetings: true as const } : {}),
        ...(settings.moments || canary ? { moments: true as const } : {}),
        ...(settings.momentsContinuous || canary ? { momentsContinuous: true as const } : {}),
        ...(!canary && settings.ownLines !== undefined ? { ownLines: settings.ownLines } : {}),
        ...(settings.secondDegree ? { secondDegree: true as const } : {}),
        ...(settings.factKinds.length === 0 ? {} : { factKinds: settings.factKinds }),
        ...(settings.repair ? { repair: true as const } : {}),
        ...(settings.reask ? { reask: true as const } : {}),
        ...(momentModel === undefined ? {} : { moment: momentModel }),
        ...(decideModel === undefined ? {} : { decideModel }),
        ...(thresholds === undefined ? {} : { thresholds }),
        ...(agentRecords ? { agentRecords: true as const } : {}),
        // The relation step, after the rebuild and before
        // the diff, under the run's spend lines, with the model the sweep asks (no `exposing`: the
        // step notes the two claims' items itself). Every model relation it writes is in shadow.
        // The outcome judge after the claim relations, in
        // the same run budget and day cap, with the calls they left. Every model link in shadow.
        // Both on the judge model, PI_JUDGE_MODEL, under the run's spend lines.
        relations: async () => {
          if (canary) return;
          const relations = createRelationStore({ url: env.PI_DATABASE_URL_PIPELINE ?? "", keys, log });
          const outcomes = createOutcomeStore({
            url: env.PI_DATABASE_URL_PIPELINE ?? "",
            keys,
            log,
            judgeGapDefaults: env.PI_JUDGE_GAP_DEFAULTS === "1",
          });
          try {
            const related = await runRelations({
              relations,
              pipeline: store,
              client: { model: budgeted(clientOf(context, vendor, apiKey, judgeModel, onUsage)), modelId: judgeModel },
              log,
              now,
            });
            const callsLeft = relationRules().budget.callsPerRun - related.calls;
            await runOutcomes({
              outcomes,
              pipeline: store,
              client: { model: budgeted(clientOf(context, vendor, apiKey, judgeModel, onUsage)), modelId: judgeModel },
              callsLeft,
              log,
              now,
            });
          } finally {
            await relations.close();
            await outcomes.close();
          }
        },
        // The warmth lanes' gap flags after the day build, as pi_pipeline with the
        // keys; never on the standing check's run, whose compartments rank no one.
        ...(canary
          ? {}
          : {
              gapLanes: async () => {
                const lanes = createGapLaneStore({ url: env.PI_DATABASE_URL_PIPELINE ?? "", keys, log });
                try {
                  await runGapLanes(lanes, now(), log);
                } finally {
                  await lanes.close();
                }
              },
            }),
      };
      const timeProposals = async (): Promise<void> => {
        const pass = createTimePassStore({ url: env.PI_DATABASE_URL_PIPELINE ?? "", keys, log });
        try {
          await runTimeProposals({
            store: pass,
            pipeline: store,
            client: { model: budgeted(clientOf(context, vendor, apiKey, modelId, onUsage), runCalls), modelId },
            compartments: settings.compartments ?? held,
            log,
            now,
          });
        } finally {
          await pass.close();
        }
      };
      const whole = settings.time && named === undefined && !agentRecords && !canary ? { timeProposals } : {};
      const result = named === undefined ? await runExtraction({ ...deps, ...whole }) : await runCapture(deps, named);
      if (result === "already_running") return busy();
      // Only `pi extract retry --capture`, as pi_admin, deletes a saved call and sets an item waiting.
      if (result === "not_due")
        throw refusal("not_due", "run pi extract retry --capture with the same id first (pia on the box)");
      // The run logged its own line with its code; a failure is also the command's, with the
      // refusal's status when a refusal ended it.
      if (FAILS.has(result.code)) throw new Refusal(result.code, undefined, result.status);
      // A run that stopped at its dollar line says so on stdout, as the night's pass does: the timer
      // records `budget` in ledger.job_runs, which an exit 0 alone would read as `ok`, and the check's
      // run tells its script, which tells the check. The wake leaves the sweep to the timer's next run,
      // as one capture's does.
      if (result.code === "budget") context.io.stdout.write("budget\n");
      if (agentRecords || named !== undefined || canary) return 0;
      // The same-fact sweep after the rebuild, unless the owner's mode is `off`, under the
      // run's spend lines. The extract model's client without `exposing`, which takes an item's call key: the
      // sweep notes the two claims' items itself.
      const grouping = createGroupingStore({ url: env.PI_DATABASE_URL_PIPELINE ?? "", keys, log });
      try {
        await runSameFact({
          grouping,
          pipeline: store,
          extractModel: { model: budgeted(clientOf(context, vendor, apiKey, modelId, onUsage)), modelId },
          ...(decideModelId === undefined
            ? {}
            : {
                decideModel: {
                  model: budgeted(decideClientOf(context, apiKey, decideModelId, onUsage)),
                  modelId: decideModelId,
                },
              }),
          log,
        });
      } finally {
        await grouping.close();
      }
      return 0;
    },
    {
      ...(openRouter ? {} : { noKey: true as const }),
      ...(capture === undefined ? { lanesOff: lanesOffOf(env) } : {}),
    },
  );
}

// `pi extract trial --sample N`, as
// pi_pipeline. The N newest correspondence items asked prompt version 4 through the saved calls,
// checked and keyed in memory; it writes only the saved calls, the usage rows and the exposure
// notes. Under the spend cap's check and the run's budget, as `pi extract` is; no decide model. Prints
// counts only.
export async function extractTrial(context: CommandContext): Promise<0> {
  const { env, values, deps } = context;
  const settings = extractSettings(env, values);
  const sample = count(values.sample, 50);
  const modelId = extractModelOf(env);
  const vendor = extractVendorOf(env, modelId);
  const ownLines = values["own-lines"] === true;
  // No decide model in a trial.
  const openRouter = readsOpenRouter(vendor, false);
  const now = deps.now ?? (() => new Date());
  // --show prints source words: to a terminal only, never to a log or a pipe.
  if ((values.show !== undefined || values["show-drops"] === true) && !context.io.stdoutIsTTY)
    throw refusal("not_a_terminal");
  return withPipeline(
    context,
    async (store, apiKey, held): Promise<0> => {
      await checkCaps(context, vendor, openRouter, apiKey, settings.keyCapMicroUsd, settings.keyUrl);
      let spent = 0;
      let costMissing = false;
      const onUsage = async (event: ModelUsageEvent): Promise<void> => {
        spent += event.costMicroUsd;
        if (event.outcome === "cost_missing") costMissing = true;
        await store.recordUsage(event);
      };
      const budgeted = (id: string, client: ReturnType<typeof clientOf>) =>
        guardedClient(client, store, id, {
          spentRun: () => spent,
          spentDay: () => store.spentSince(dayOf(now())),
          costMissing: () => costMissing,
          runMicroUsd: settings.runMicroUsd,
          dayMicroUsd: settings.dayMicroUsd,
          maxCalls: settings.maxCalls,
        });
      const compartments = settings.compartments ?? held;
      // On the moment lane's model. A repeated trial replays its saved calls. A
      // run never does: it takes new moments, and a retry of an old one deletes its call. So a trial's
      // spend is the trial's own, and it counts toward that day's own-lines line.
      if (ownLines) {
        const lane = momentModelOf(env, vendor, modelId);
        const laneId = lane?.modelId ?? modelId;
        const asked = await runOwnLinesTrial(
          {
            store,
            model: budgeted(laneId, clientOf(context, lane?.vendor ?? vendor, apiKey, laneId, onUsage)),
            modelId: laneId,
            compartments,
          },
          sample,
          typeof values.show === "string" ? { show: values.show.split(",") } : {},
        );
        if (asked === "already_running") throw refusal("extract_running");
        for (const line of ownLinesTrialLines(asked, spent)) context.io.stdout.write(`${line}\n`);
        return 0;
      }
      const model = budgeted(modelId, clientOf(context, vendor, apiKey, modelId, onUsage));
      // --second-degree prices the second-degree version's backfill, whether
      // or not PI_EXTRACT_SECOND_DEGREE is set.
      // --lane and --fact-kinds, whether or not PI_EXTRACT_FACT_KINDS names the lane.
      const report = await runTrial({ store, model, modelId, compartments }, sample, {
        replay: values.replay === true,
        project: values.project === true,
        ...(values["next-generation"] === true ? { checkGeneration: NEGATION_CUT_GENERATION } : {}),
        ...(values["show-drops"] === true ? { showDrops: true } : {}),
        secondDegree: values["second-degree"] === true,
        factKinds: values["fact-kinds"] === true,
        ...(values.lane === "transaction" || values.lane === "agent" ? { lane: values.lane } : {}),
        ...(typeof values.show === "string" ? { show: values.show.split(",") } : {}),
      });
      if (report === "already_running") throw refusal("extract_running");
      for (const line of trialReportLines(report, spent)) context.io.stdout.write(`${line}\n`);
      return 0;
    },
    openRouter ? {} : { noKey: true },
  );
}

// `pi extract refusals [--sample N] [--show]`, as pi_pipeline: the newest refused messages' saved
// answers read again through today's check, with the repair off and on. No model, no key, nothing
// written. Counts and code words; --show prints what each said, to a terminal only.
export async function extractRefusals(context: CommandContext): Promise<0> {
  const { env, values } = context;
  const settings = extractSettings(env, values);
  if (values.show === true && !context.io.stdoutIsTTY) throw refusal("not_a_terminal");
  return withPipeline(
    context,
    async (store, _apiKey, held): Promise<0> => {
      const report = await runRefusals(
        { store, modelId: extractModelOf(env), compartments: settings.compartments ?? held },
        count(values.sample, 50),
        { show: values.show === true },
      );
      for (const line of refusalsReportLines(report)) context.io.stdout.write(`${line}\n`);
      return 0;
    },
    { noKey: true },
  );
}

// `pi extract age`, as pi_pipeline: every belief rebuilt as of
// now, and nothing else. It needs no model setting and reads no key, so it runs whether or not
// extraction is on.
export async function extractAge(context: CommandContext): Promise<0> {
  const { log, deps } = context;
  return withPipeline(
    context,
    async (store): Promise<0> => {
      const result = await runAgeing({ store, log, now: deps.now ?? (() => new Date()) });
      if (result === "already_running") {
        log.info({ event: "already_running" });
        return 0;
      }
      if (FAILS.has(result.code)) throw new Refusal(result.code);
      return 0;
    },
    { noKey: true },
  );
}

// `pi extract match-backfill`, as pi_pipeline under the extraction lock: each
// about_you and agent_claim card of system:extract with no match key and whose claim still opens
// gets the key its content takes at the current generation's key version (the one a new card
// takes). Only where none is set, so a second run changes nothing. Counts only.
const BACKFILL_PAGE = 200;
export async function extractMatchBackfill(context: CommandContext): Promise<0> {
  const { log } = context;
  return withPipeline(
    context,
    async (store): Promise<0> => {
      const version = keyVersionOf(EXTRACT_GENERATION);
      const done = await store.withExtractLock(async () => {
        const counts = { filled: 0, thread_scoped: 0, claim_gone: 0, unreadable: 0, not_agent: 0 };
        let after: string | undefined;
        for (;;) {
          const page = await store.unkeyedCards({ size: BACKFILL_PAGE, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          for (const one of page) {
            const { card, content } = one;
            if (content === null) counts[one.reason ?? "claim_gone"] += 1;
            else {
              const key = matchKey(content, version);
              if (key === undefined) counts.thread_scoped += 1;
              else if (await store.setMatchKey(card, key)) counts.filled += 1;
            }
          }
          after = page[page.length - 1]?.card;
        }
        return counts;
      });
      if (done === "already_running") throw refusal("already_running");
      log.info({ event: "match_backfill", counts: done });
      context.io.stdout.write(`${JSON.stringify(done)}\n`);
      return 0;
    },
    { noKey: true },
  );
}

// `pia triggers seed`, as pi_pipeline under the extract lock (held for the whole run, so it runs in
// a quiet window after a deploy): the current state of every fact key under every active clearance
// written as a baseline through the pass's own code, raising nothing. Idempotent. Run once after a
// deploy and after a generation raise. Counts only.
export async function triggersSeed(context: CommandContext): Promise<0> {
  const { log } = context;
  return withPipeline(
    context,
    async (store): Promise<0> => {
      const done = await store.withExtractLock(() => store.triggerSeed());
      if (done === "already_running") throw refusal("already_running");
      log.info({
        event: "triggers_seed",
        counts: { keys: done.keys, written: done.written, failed: done.failed, ms: done.ms },
      });
      context.io.stdout.write(`${JSON.stringify(done)}\n`);
      return 0;
    },
    { noKey: true },
  );
}
