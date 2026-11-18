import { createHash, randomInt } from "node:crypto";
import { DreamPass, isCoded, type ModelUsageEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import {
  checkSources,
  type ExtractDeps,
  pickAudits,
  type RelationCounts,
  relateClaims,
  relationJudge,
  type SourceCheckCounts,
  snake,
  sourceCheckJudge,
  stratifiedSample,
  sweepOrder,
} from "@intelligence/personal-extract";
import { microUsdOf, withBudget } from "@intelligence/personal-models";
import {
  type AuditSummary,
  createDreamStore,
  createRecallStore,
  createRelationStore,
  createSourceCheckStore,
  type Pipeline,
  type RecallStore,
  type RelationStore,
  type SourceCheckStore,
  type SwitchPassSummary,
} from "@intelligence/personal-store";
import { boxFacts } from "../agents/box-facts.ts";
import type { DreamStage } from "../command-args.ts";
import type { CommandContext } from "../command-types.ts";
import { type Env, refusal } from "../env.ts";
import { SECOND_CHECK_POINT, sourceAsker } from "./dream-askers.ts";
import { runDreamPass } from "./dream-pass.ts";
import { type RecallNight, recallAuditOn, runRecallAudit } from "./dream-recall.ts";
import {
  checkCaps,
  clientOf,
  count,
  dreamModelOf,
  extractModelOf,
  extractSettings,
  extractVendorOf,
  judgeModelOf,
  readsOpenRouter,
  withPipeline,
} from "./extract-config.ts";
import { relationAsker } from "./relations.ts";

// `pi dream`, the nightly review of stored knowledge, as pi_pipeline under the extract lock. On
// the judge model (PI_JUDGE_MODEL, else the extraction model), on the run's vendor and key, under
// its own budget a night (ontology/relations.json `dream`, over the owner's day in their zone, in the dream lane of
// vault.model_usage: `nightClient`), apart from extraction's run and day lines and from the run
// and day caps new arrivals keep in the relation step. In order:
//   0. the recall audit, only when PI_RECALL_AUDIT=1 (dream-recall.ts), first so a full night still does it;
//   1. the fulfilled-commitments sweep: each open commitment against the later items of its
//      counterparty, offered for `fulfils` alone;
//   2. the relations sweep: belief-type claims no relation run has judged, oldest first, one
//      subject at a time, with the relation step's candidate rule, both orders each pair;
//   3. the source check: the night's stratified sample of beliefs and model relations under the
//      owner's clearance, each reread against the passages its claims cite; then the hot slice,
//      beliefs code picks by what agents were served and by new evidence, never counted in a precision;
//   4. the relation switching job, which also weighs the source check's results;
//   5. the audit cards for the switched-on kinds.
// Everything it writes is in shadow or is a measure: relations under the existing switches, check
// rows, and cards the owner answers. It writes no claim, value, label, ruling or status. Each pair and
// each check is saved as it is made, so a pass cut short keeps what it did. Counts and codes in its
// log lines, one `dream_progress` after each chunk and one `dream_pass` at the end, and on stdout.

type ModelClient = ExtractDeps["model"];

export type DreamCounts = {
  sweep: RelationCounts & { claims: number; relations: number; checks: number; marks: number };
  fulfils: RelationCounts & { commitments: number; relations: number; checks: number };
  sourceCheck: SourceCheckCounts & { strata: number; passedOver: number; saved: number };
  // The hot slice's checks: its counts, how many of each list it took, and each list's candidates
  // before the cut.
  hotCheck: SourceCheckCounts & {
    served: number;
    newEvidence: number;
    candidates: { served: number; newEvidence: number };
    passedOver: number;
    saved: number;
  };
  switches: SwitchPassSummary;
  audits: AuditSummary;
  recall: RecallNight | "off";
  // imp_01M6ST6JZ4PW9BWNWVN61DHHMR (d): the claims the relations sweep still has to read after the
  // night, and what each stage spent of the night's dollars, as whole micro-dollars.
  backlog: number;
  // Of the backlog, the claims no weekly subject reaches: linked to no entity, or only to a project.
  backlogBy: { unlinked: number; otherKinds: number };
  stageMicroUsd: Record<DreamStage, number>;
  spentMicroUsd: number;
  stopped: "ok" | "budget" | "unavailable";
};

// The dollars a night as whole micro-dollars.
const micro = (usd: number): number => Math.round(usd * 1_000_000);

// `--max-calls` and `--usd`, each unset meaning no cap, for the hand-run trial.
export const dreamMaxCalls = (env: Env, values: CommandContext["values"]): number | null => {
  const raw = values["max-calls"] ?? env.PI_DREAM_MAX_CALLS;
  return raw === undefined || raw === "" ? null : count(raw, 0);
};
export const dreamUsd = (values: CommandContext["values"]): number | null => {
  const raw = values.usd;
  if (raw === undefined || raw === "") return null;
  const micro = typeof raw === "string" ? microUsdOf(raw) : null;
  if (micro === null || micro <= 0) throw refusal("usage");
  return micro / 1_000_000;
};

export async function runDream(deps: {
  relations: RelationStore;
  checks: SourceCheckStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: { model: ModelClient; modelId: string };
  calls: () => number;
  // The night's spend so far, in micro-dollars: each stage's share is what it adds.
  spent: () => number;
  maxCalls?: number | null;
  log: PersonalLogger;
  now: () => Date;
  random?: () => number;
  // Present only when the owner turned the recall audit on.
  recall?: RecallStore;
  // The second model that checks the sample and the hot slice, never the
  // judge's; with none, neither runs. `sweep` false when the night's subjects were swept in chunks.
  checker: { model: ModelClient; modelId: string } | null;
  // Whether the owner trusts that model now: a check it makes while not decides nothing.
  live: boolean;
  sweep?: boolean;
}): Promise<Omit<DreamCounts, "spentMicroUsd">> {
  const { relations, checks, pipeline, client, log } = deps;
  const rules = relationRules();
  const judge = relationJudge(client.modelId);
  // No cap set is no cap.
  const max = deps.maxCalls === undefined ? rules.dream.callsPerNight : deps.maxCalls;
  const left = (): number => (max === null ? Number.MAX_SAFE_INTEGER : Math.max(0, max - deps.calls()));
  // The source check's share of the night is kept from the sweeps, so a night the sweep would fill
  // still checks its sample and its hot slice; without checks no relation kind ever switches on.
  let stopped: DreamCounts["stopped"] = "ok";
  const kept = rules.dream.sourceChecksPerNight + rules.dream.hotChecksPerNight;
  const forRelations = (): number => (stopped === "unavailable" ? 0 : Math.max(0, left() - kept));
  const ask = relationAsker({ relations, pipeline, client, log });
  const now = deps.now().toISOString();
  const random = deps.random ?? (() => randomInt(0, 2 ** 32) / 2 ** 32);
  let mark = deps.spent();
  const stage = (): number => {
    const was = mark;
    mark = deps.spent();
    return mark - was;
  };

  // 0. What the closed filters lost. Its own budget stops it alone; an outage stops the night.
  const recall =
    deps.recall === undefined
      ? null
      : await runRecallAudit({
          store: deps.recall,
          pipeline,
          client,
          clearance: await relations.ownerClearance(),
          log,
          now: deps.now,
          random,
        });
  if (recall?.stopped === "unavailable") stopped = "unavailable";
  const recallSpent = stage();

  // 1. The fulfilled-commitments sweep first, a commitment's few pairs, so a full relations sweep
  // never skips it: no mark at all, since a commitment's own relation run is the
  // relation step's, not this one's.
  const fulfilJobs = await relations.fulfilJobs(judge, now, {
    calls: forRelations(),
    candidates: rules.budget.candidatesPerSubject,
  });
  // Each pair saved as it is asked (imp_01M6ST6KKR50FH9BHDKKNV89HX): a pass its time limit or a
  // deploy kills keeps every pair it asked, and the next night asks only what is left.
  // One part saved and added to its stage's counts; a part with nothing left to save opens no
  // transaction.
  const saving = async (
    total: { relations: number; checks: number; marks: number },
    part: Parameters<RelationStore["save"]>[0],
  ): Promise<void> => {
    if (part.relations.length + part.checks.length + part.marks.length === 0) return;
    addTo(total, await relations.save(part, judge, { dream: true }));
  };
  const fulfilSaved = { relations: 0, checks: 0, marks: 0 };
  const fulfilled = await relateClaims(
    fulfilJobs.jobs,
    ask,
    { candidates: rules.budget.candidatesPerSubject, calls: forRelations() },
    fulfilJobs.checked,
    {
      only: "fulfils",
      each: (part) => saving(fulfilSaved, { ...part, marks: [] }),
    },
  );
  if (stopped === "ok" && fulfilled.stopped !== "ok") stopped = fulfilled.stopped;
  const fulfilSpent = stage();

  // 2. The relations sweep, on what the fulfilment sweep left of its share. A sweep marks a claim
  // judged when it asked every candidate; a claim it left is not marked unjudged, which would put it
  // ahead of new arrivals: the next night takes it.
  const sweepJobs =
    stopped === "unavailable" || deps.sweep === false
      ? { jobs: [], checked: new Set<string>(), claims: 0 }
      : await relations.sweep(
          judge,
          now,
          { calls: forRelations(), candidates: rules.budget.candidatesPerSubject, limit: SWEEP_CLAIMS },
          sweepOrder,
        );
  const sweepSaved = { relations: 0, checks: 0, marks: 0 };
  const swept = await relateClaims(
    sweepJobs.jobs,
    ask,
    { candidates: rules.budget.candidatesPerSubject, calls: forRelations() },
    sweepJobs.checked,
    { each: (part) => saving(sweepSaved, { ...part, marks: part.marks.filter((mark) => mark.state === "judged") }) },
  );
  if (stopped === "ok" && swept.stopped !== "ok") stopped = swept.stopped;
  const sweepSpent = stage();

  // 3. The source check, under the owner's clearance, on its kept share even when a sweep stopped at
  // its own; not when the model was unavailable, and only on a second model.
  const checker = deps.checker;
  const checkJudge = sourceCheckJudge(checker?.modelId ?? client.modelId);
  const sample =
    stopped !== "unavailable" && checker !== null
      ? await checks.cases(
          await relations.ownerClearance(),
          checkJudge,
          now,
          rules.dream.sourceChecksPerNight,
          (strata, total) => stratifiedSample(strata, total, random),
          { size: rules.dream.hotChecksPerNight },
        )
      : { cases: [], strata: 0, passedOver: 0, hot: [], hotPassedOver: 0, candidates: { served: 0, newEvidence: 0 } };
  // The second model's checks under their own point, so no answer of the judge's is replayed as its.
  const asker = sourceAsker({ checks, pipeline, client: checker ?? client, log, point: SECOND_CHECK_POINT });
  // Each check saved as it is made, as each pair is.
  let saved = 0;
  const checked = await checkSources(sample.cases, asker, { calls: left() }, async (row) => {
    saved += await checks.save([row], checkJudge, deps.live);
  });
  if (stopped === "ok" && checked.stopped !== "ok") stopped = checked.stopped;
  const checkSpent = stage();
  // The hot slice after the sample, on what the night has left; not after an outage.
  let hotSaved = 0;
  const hot = await checkSources(stopped === "unavailable" ? [] : sample.hot, asker, { calls: left() }, async (row) => {
    hotSaved += await checks.save([row], checkJudge, deps.live);
  });
  if (stopped === "ok" && hot.stopped !== "ok") stopped = hot.stopped;
  const hotSpent = stage();

  // 4. The switching job, then 5. the audit, whatever the budget left: neither calls a model.
  const switches = await relations.switchPass(judge);
  const audits = await relations.audit(judge, {
    share: rules.dream.auditShare,
    perDay: rules.dream.auditsPerDay,
    pick: pickAudits,
  });

  return {
    sweep: { ...swept.counts, claims: sweepJobs.claims, ...sweepSaved },
    fulfils: {
      ...fulfilled.counts,
      commitments: fulfilJobs.commitments,
      relations: fulfilSaved.relations,
      checks: fulfilSaved.checks,
    },
    sourceCheck: { ...checked.counts, strata: sample.strata, passedOver: sample.passedOver, saved },
    hotCheck: {
      ...hot.counts,
      served: hot.rows.filter((row) => row.hot === "served").length,
      newEvidence: hot.rows.filter((row) => row.hot === "new_evidence").length,
      candidates: sample.candidates,
      passedOver: sample.hotPassedOver,
      saved: hotSaved,
    },
    switches,
    audits,
    recall: recall === null ? "off" : recall.night,
    ...(await relations.sweepBacklog(judge).then(({ total, ...by }) => ({ backlog: total, backlogBy: by }))),
    stageMicroUsd: {
      recall: recallSpent,
      fulfils: fulfilSpent,
      sweep: sweepSpent,
      sourceCheck: checkSpent,
      hotCheck: hotSpent,
    },
    stopped,
  };
}

// The oldest claims the relations sweep reads a night, before the budget picks those it asks.
const SWEEP_CLAIMS = 500;

// One save's counts added to a stage's.
const addTo = (
  total: { relations: number; checks: number; marks: number },
  one: { relations: number; checks: number; marks: number },
): void => {
  total.relations += one.relations;
  total.checks += one.checks;
  total.marks += one.marks;
};

// A pass's budget, in the dream lane of vault.model_usage, apart from extraction's day. As `pi dream`
// builds it (`perPass`), each pass, and each retried try, has its own budget: its calls and dollars
// count from zero, so a retried night can spend up to twice its cap. Without `perPass`, its dollars and
// calls start from what the lane holds for the owner's day and stop at the day's limits. Either way a
// `cost_missing` answer in the lane today stops it before its first call, as one stops a run.
// Built under the extract lock, so the count read is not one a run beside it changes.
// `clientWith` builds the judge client that reports each answer's usage.
export async function nightClient(
  store: Pick<Pipeline, "recordUsage" | "dreamSpentToday">,
  clientWith: (onUsage: (event: ModelUsageEvent) => Promise<void>) => ModelClient,
  maxCalls: number | null = relationRules().dream.callsPerNight,
  usd: number | null = relationRules().dream.usdPerNight,
  // Each pass its own budget: its calls and dollars count from zero, whatever another pass spent today.
  perPass = false,
): Promise<{
  model: ModelClient;
  // Another model of the same night (the screen and the second model), on the same
  // calls, dollars and stops.
  also(clientWith: (onUsage: (event: ModelUsageEvent) => Promise<void>) => ModelClient): ModelClient;
  calls: { made: number };
  spent(): number;
}> {
  // An unset cap is none: the trial's first night runs uncapped and watched.
  const limit = usd === null ? Number.POSITIVE_INFINITY : micro(usd);
  let spent = 0;
  const today = await store.dreamSpentToday();
  let costMissing = today.costMissing;
  const onUsage = async (event: ModelUsageEvent): Promise<void> => {
    spent += event.costMicroUsd;
    if (event.outcome === "cost_missing") costMissing = true;
    await store.recordUsage(event, "dream");
  };
  const calls = { made: perPass ? 0 : today.calls };
  const also = (made: typeof clientWith): ModelClient =>
    withBudget(made(onUsage), {
      calls,
      spentRun: () => spent,
      spentDay: async () => (await store.dreamSpentToday()).microUsd,
      costMissing: () => costMissing,
      runMicroUsd: limit,
      dayMicroUsd: perPass ? Number.POSITIVE_INFINITY : limit,
      maxCalls: maxCalls ?? Number.POSITIVE_INFINITY,
    });
  return { model: also(clientWith), also, calls, spent: () => spent };
}

// Whether the pass stops before its tail: its chunks were held, or the pass lock's connection, and the
// lock with it, is gone.
export const tailHeld = (stopped: string, lost: () => boolean): boolean => stopped === "held" || lost();

// `pi dream [--pass nightly|weekly] [--max-calls N] [--usd D] [--seconds S]`: one pass.
// Its chunks take the extract lock in turn and let it go between them, so extraction runs beside a
// long pass; one that finds the lock held at the start prints `busy` and exits 0, as `pi extract`
// does. No cap set is none: the trial's first night runs uncapped and watched. `--seconds` ends the
// pass between chunks once it has run that long. The judge is PI_JUDGE_MODEL; the second model, which
// checks every finding, and the cheap screen are the owner's (`pia dream model check|screen`): with no
// second model nothing is checked, so nothing takes effect; with no screen the judge asks every pair.
export async function dreamCommand(context: CommandContext): Promise<0> {
  const { env, values, log, deps } = context;
  const settings = extractSettings(env, values);
  const caps = { calls: dreamMaxCalls(env, values), usd: dreamUsd(values) };
  const pass = DreamPass.safeParse(values.pass ?? "nightly");
  if (!pass.success) throw refusal("usage");
  const seconds = values.seconds === undefined ? null : count(values.seconds, 0);
  const modelId = extractModelOf(env);
  const vendor = extractVendorOf(env, modelId);
  const judgeModel = judgeModelOf(env, vendor, modelId);
  const openRouter = readsOpenRouter(vendor, false);
  const now = deps.now ?? (() => new Date());
  const started = now();
  const busy = (): 0 => {
    log.info({ event: "already_running" });
    context.io.stdout.write("busy\n");
    return 0;
  };
  return withPipeline(
    context,
    async (store, apiKey, _held, keys): Promise<0> => {
      if (!(await store.extractLockFree())) return busy();
      await checkCaps(context, vendor, openRouter, apiKey, settings.keyCapMicroUsd, settings.keyUrl);
      const url = env.PI_DATABASE_URL_PIPELINE ?? "";
      const relations = createRelationStore({ url, keys, log });
      const checks = createSourceCheckStore({ url, keys, log });
      const dream = createDreamStore({ url, keys, log });
      const recall = recallAuditOn(env) ? createRecallStore({ url, keys, log }) : undefined;
      try {
        // The second model and the screen, as the owner stored them (`pia dream model`).
        const stored = await dream.models();
        const checkModel = dreamModelOf(vendor, stored.check);
        const screenModel = dreamModelOf(vendor, stored.screen);
        // The night's own lines, its dollars and its calls, never extraction's, shared by its three
        // models: read once the lock is held, and the day's spend read again at every call.
        const night = await store.withExtractLock(() =>
          nightClient(
            store,
            (onUsage) => clientOf(context, vendor, apiKey, judgeModel, onUsage),
            caps.calls,
            caps.usd,
            true,
          ),
        );
        if (night === "already_running") return busy();
        const { model, calls, spent } = night;
        const before = calls.made;
        // The screen and the checker spend through the same night: each answer reported in the dream lane.
        const other = (id: string | null) =>
          id === null
            ? null
            : { model: night.also((onUsage) => clientOf(context, vendor, apiKey, id, onUsage)), modelId: id };
        const checker = checkModel === null || checkModel === judgeModel ? null : other(checkModel);
        const lock = <T>(work: () => Promise<T>) => store.withExtractLock(work);
        // One pass at a time: a second, by hand or by the timer, finds this one running and prints `busy`.
        const whole = await dream.withPassLock(async (lost) => {
          const chunks = await runDreamPass({
            pass: pass.data,
            relations,
            checks,
            dream,
            pipeline: store,
            lock,
            judge: { model, modelId: judgeModel },
            screen: other(screenModel),
            checker,
            caps,
            calls: () => calls.made,
            spent,
            deadline: seconds === null ? null : started.getTime() + seconds * 1000,
            // A sync or read hold, or the owner's pause, set since the pass began stops it between chunks.
            // Or the pass lock's connection gone, and the lock with it.
            held: () =>
              lost() ||
              boxFacts().holds.some((one) => one === "sync_hold" || one === "read_hold" || one === "dream_hold"),
            log,
            now,
            selector: (pair) =>
              Number.parseInt(createHash("sha256").update(pair).digest("hex").slice(0, 8), 16) / 2 ** 32,
            progress: (so, dreamed, lockMs) =>
              log.info({
                event: "dream_progress",
                counts: snake({
                  chunks: so.chunks,
                  subjects: so.subjects,
                  dreamed,
                  sweepPairs: so.judge.pairs,
                  sweepWritten: so.judge.written,
                  censusChecked: so.census.checked,
                  censusHeld: so.census.held,
                  identityPairs: so.identity.pairs,
                  calls: calls.made - before,
                  spentMicroUsd: spent(),
                  lockMs,
                }),
              }),
          });
          // A hold set during the chunks stops the pass whole: the tail calls models too. So does the
          // pass lock lost after the last chunk, so a second pass cannot run beside the tail.
          if (tailHeld(chunks.stopped, lost)) return { chunks, tail: "held" as const };
          const tail = await lock(async () =>
            runDream({
              relations,
              checks,
              pipeline: store,
              client: { model, modelId: judgeModel },
              calls: () => calls.made,
              spent,
              maxCalls: caps.calls,
              log,
              now,
              checker,
              live: await dream.linesLive(),
              sweep: false,
              ...(recall === undefined ? {} : { recall }),
            }),
          );
          return { chunks, tail };
        });
        if (whole === "already_running") return busy();
        const { chunks, tail } = whole;
        if (tail === "already_running") return busy();
        if (tail === "held") {
          // A held pass is a night too: what its chunks did and spent is recorded, not lost. A lost
          // lock may mean the database itself is gone; then the night goes unrecorded and the pass
          // still ends as held, as it always has.
          try {
            await dream.saveNight({
              pass: pass.data,
              judge: relationJudge(judgeModel),
              stopped: "held",
              startedAt: started.toISOString(),
              endedAt: now().toISOString(),
              counts: { chunks, calls: calls.made - before },
              microUsd: spent(),
            });
          } catch (error) {
            log.warn({ event: "dream_night_not_saved", code: isCoded(error) ? error.code : "unknown" });
          }
          log.info({ event: "dream_pass", code: "held" });
          context.io.stdout.write(`${JSON.stringify({ chunks, stopped: "unavailable" })}\n`);
          return 0;
        }
        const counts: DreamCounts = { ...tail, spentMicroUsd: spent() };
        const stopped = chunks.stopped === "ok" ? counts.stopped : chunks.stopped;
        await dream.saveNight({
          pass: pass.data,
          judge: relationJudge(judgeModel),
          stopped,
          startedAt: started.toISOString(),
          endedAt: now().toISOString(),
          counts: {
            chunks,
            tail: {
              sweep: counts.sweep,
              fulfils: counts.fulfils,
              sourceCheck: counts.sourceCheck,
              hotCheck: counts.hotCheck,
              switches: counts.switches,
              audits: counts.audits,
            },
            calls: calls.made - before,
          },
          microUsd: spent(),
        });
        log.info({
          event: "dream_pass",
          code: stopped,
          counts: snake({
            subjects: chunks.subjects,
            chunks: chunks.chunks,
            screened: chunks.screen.pairs,
            screenFlagged: chunks.screen.flagged,
            sweepPairs: chunks.judge.pairs,
            sweepWritten: chunks.judge.written,
            censusChecked: chunks.census.checked,
            censusHeld: chunks.census.held,
            findings: chunks.findings,
            identityPairs: chunks.identity.pairs,
            identitySame: chunks.identity.same,
            fulfilPairs: counts.fulfils.pairs,
            fulfilWritten: counts.fulfils.written,
            sourceChecks: counts.sourceCheck.saved,
            supported: counts.sourceCheck.supported,
            hotChecks: counts.hotCheck.saved,
            switched: counts.switches.switched,
            auditsRaised: counts.audits.raised,
            backlog: counts.backlog,
            calls: calls.made - before,
            spentMicroUsd: spent(),
          }),
        });
        // `stopped` the timer reads: `time` and `busy` mid-pass end the day's pass as a budget does; a
        // hold set meanwhile ends it as an outage, so the day is tried again.
        const shown =
          stopped === "time" || stopped === "busy" ? "budget" : stopped === "held" ? "unavailable" : stopped;
        context.io.stdout.write(`${JSON.stringify({ ...counts, chunks, stopped: shown })}\n`);
        return 0;
      } finally {
        await relations.close();
        await checks.close();
        await dream.close();
        await recall?.close();
      }
    },
    openRouter ? {} : { noKey: true },
  );
}
