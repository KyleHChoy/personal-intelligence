import { randomUUID } from "node:crypto";
import {
  CodedError,
  createLogger,
  faultOf,
  logClockOf,
  type PersonalLogger,
  PersonalWorkResults,
} from "@intelligence/contracts/personal";
import {
  anthropicKey,
  checkSpendCap,
  keyEndpointOf,
  spendCapEvent,
  type TurnModelOptions,
} from "@intelligence/personal-models";
import { agentApiCommand, startAgentApi } from "./agent-api.ts";
import { assertNoDataAccess, type Env, Refusal, requireEnv, usdCeiling } from "./env.ts";
import { runLoop } from "./loop.ts";
import { turnModelFromEnv } from "./model.ts";
import type { AgentApi, TurnModel } from "./ports.ts";

// One run of pi-reasoner: check the environment, check the key's spend
// cap, start the agent API, take at most one run, reason over
// it, close. Everything a run holds is local to this call: nothing is kept at module level between
// runs.

export type RunDeps = {
  startApi?: () => Promise<AgentApi>;
  model?: TurnModel;
  log?: PersonalLogger;
  stderr?: NodeJS.WritableStream;
  // The fetch of the spend-cap check's one request to the key endpoint. A test passes one, so no
  // test calls OpenRouter.
  keyFetch?: typeof fetch;
  // The model's own deps, for a trial run's model when no `model` is given. A test passes a fetch.
  modelDeps?: TurnModelOptions["deps"];
};

// The most the reasoner's key may spend in a month unless PI_REASONER_KEY_CAP_USD says otherwise
//.
const CEILING_MICRO_USD = 50_000_000;

// The key cap's two settings, refused here, before anything else is started, when they are off.
// The override is the key endpoint's, which only the box's smoke test sets, to a fake endpoint on the
// box's loopback; unset is OpenRouter's endpoint.
export function keyCapSettings(env: Env): { ceilingMicroUsd: number; keyUrl: string | undefined } {
  const ceilingMicroUsd = usdCeiling(env, "PI_REASONER_KEY_CAP_USD", CEILING_MICRO_USD);
  const keyUrl = env.PI_OPENROUTER_KEY_URL;
  if (keyEndpointOf(keyUrl) === null) throw new Refusal("bad_env", "set PI_OPENROUTER_KEY_URL");
  return { ceilingMicroUsd, keyUrl };
}

// The key's limit, read before anything is spent. An Anthropic key has
// no endpoint that reports its spend, so its cap is the workspace's spend limit in Anthropic's
// console, beside the ledger's own budget.
export async function checkKeyCap(
  apiKey: string,
  settings: ReturnType<typeof keyCapSettings>,
  log: PersonalLogger,
  keyFetch: typeof fetch | undefined,
): Promise<void> {
  if (anthropicKey(apiKey)) {
    log.info({ event: "spend_cap", code: "anthropic_console" });
    return;
  }
  const cap = await checkSpendCap({ apiKey, fetch: keyFetch ?? fetch, ...settings });
  log.info(spendCapEvent(cap));
  if (cap.code !== "ok") throw new Refusal(cap.code);
}

// 0 when there was no run, or it finished or was stopped; 1 when it failed, or the agent API or
// the environment did.
export async function runOnce(env: Env, deps: RunDeps = {}): Promise<0 | 1> {
  const stderr = deps.stderr ?? process.stderr;
  const log = deps.log ?? createLogger(stderr, logClockOf(env));
  let api: AgentApi | undefined;
  try {
    assertNoDataAccess(env);
    const settings = keyCapSettings(env);
    const model = deps.model ?? turnModelFromEnv(env, deps.modelDeps);
    const { PI_REASONER_MODEL_KEY: apiKey } = requireEnv(env, ["PI_REASONER_MODEL_KEY"]);
    // Before the agent API starts, so a refused run is never taken.
    await checkKeyCap(apiKey, settings, log, deps.keyFetch);
    api = await (deps.startApi ?? (() => startAgentApi(agentApiCommand(env), { path: env.PATH ?? "" })))();
    const next = await api.call("next_run", { requestId: randomUUID() });
    if (!next.ok) throw new CodedError(next.code);
    const taken = PersonalWorkResults.next_run.safeParse(next.value);
    if (!taken.success) throw new CodedError("unavailable");
    if (taken.data.run === null) return 0;
    // A trial run, which compares models on the same inputs, is reasoned over by the model and
    // effort its request names.
    const { trial } = taken.data.run;
    let runModel = model;
    if (trial !== undefined) {
      try {
        runModel = deps.model ?? turnModelFromEnv(env, deps.modelDeps, trial);
      } catch (error) {
        // A trial model this key cannot run (another vendor's model on an Anthropic key) ends the
        // run as failed, never left running.
        const run = taken.data.run;
        await api.call("finish_run", {
          run: run.id,
          outcome: "failed",
          code: "model_unavailable",
          requestId: `${run.id}-${run.attempt}-finish-model`,
        });
        throw error;
      }
    }
    const result = await runLoop(taken.data.run, { api, model: runModel, log });
    return result.outcome === "failed" ? 1 : 0;
  } catch (error) {
    // A failure's code: a refusal's, the agent API's, `unavailable` for a driver's, a socket's or an
    // abort, or `bug`, with its errno or class as the reason (faultOf). Never a message or a stack.
    const { code, reason } = faultOf(error);
    log.error({ event: "reasoner_failed", code, ...(reason === undefined ? {} : { reason }) });
    if (error instanceof Refusal && error.hint !== undefined) stderr.write(`${error.hint}\n`);
    return 1;
  } finally {
    await api?.close();
  }
}
