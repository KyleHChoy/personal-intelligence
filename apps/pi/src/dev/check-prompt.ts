#!/usr/bin/env node
import { Writable } from "node:stream";
import {
  CodedError,
  isCoded,
  type PersonalLogger,
  ReasoningOutput,
  type TurnReply,
} from "@intelligence/contracts/personal";
import { isReasoningEffort, type ReasoningEffort } from "@intelligence/personal-models";
import {
  type AgentApi,
  createTurnModel,
  runOnce,
  startAgentApi,
  type TurnModel,
} from "@intelligence/personal-reasoner";
import { copyHarness, type Harness, workHarness } from "../test-support/work-harness.ts";

// The prompt check. The owner runs it once on their own
// computer, from a checkout with its dev dependencies and a local Postgres, as
// `node apps/pi/src/dev/check-prompt.ts <model id>`, and types the reasoner's key at the
// prompt. It builds what the sequence builds up to the run (the work harness, with no worker),
// queues one run with `pi work run`, and runs the reasoner's runOnce once with the real agent API
// and the live model. It prints, to its terminal only, the parsed output, each refusal, the turns
// and the cost, read from the run's rows, and nothing a tool returned. It keeps nothing: the
// database and the folder go when it ends.
//
// Comparing two models: given two model ids,
// `node apps/pi/src/dev/check-prompt.ts <model a> <model b>`, it builds the sequence once,
// copies its database before any run (copyHarness), and runs each model on its own copy, so both
// read the same RunRequest, the same ids and the same world. One key, typed once, pays for both. It
// prints the two outputs action by action, then each run's report.
//
// Reasoning effort: a model id may end in @low, @medium or @high, sent as the reasoner sends
// PI_REASONER_REASONING_EFFORT, so one model can be compared with itself at two efforts
// (`openai/gpt-6-luna@low openai/gpt-6-luna@high`). A model id with no effort takes
// PI_REASONER_REASONING_EFFORT when it is set, and sends none when it is not.

export type CheckDeps = {
  // One model id, or two to compare, each with an optional @effort.
  modelIds: readonly string[];
  // The key, read when the live model is made and from nowhere else. Not called when models are
  // handed in.
  readKey: () => Promise<string>;
  // One for each model id, in order; a test hands them in.
  models?: readonly TurnModel[];
  // The key endpoint's fetch for the run's spend-cap check; a test passes one with its model.
  // Unset, the check reads OpenRouter with the typed key, as the box does.
  keyFetch?: typeof fetch;
  out: NodeJS.WritableStream & { isTTY?: boolean };
};

export type CheckResult = { code: "ok" | "not_a_terminal"; databases?: string[]; folders?: string[] };

type Step = {
  ordinal: number;
  kind: string;
  status: string | null;
  tool: string | null;
  code: string | null;
  cost: number | null;
};

// The names the key could be handed over by in the environment; the check refuses each.
const KEY_VARIABLES = ["PI_REASONER_MODEL_KEY", "PI_OPENROUTER_KEY", "OPENROUTER_API_KEY"];
// An OpenRouter model id: a vendor and a model, nothing that looks like a key, and an optional
// reasoning effort.
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:@(?:low|medium|high))?$/;
const EFFORT = "PI_REASONER_REASONING_EFFORT";

// A model argument as the model id and its effort, if any.
export function modelArgument(argument: string): { model: string; effort?: ReasoningEffort } {
  const [model = "", effort = ""] = argument.split("@");
  return isReasoningEffort(effort) ? { model, effort } : { model };
}

// Each model argument with PI_REASONER_REASONING_EFFORT added where it names no effort of its own.
export function withEffort(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  const effort = env[EFFORT] ?? "";
  return argv.map((one) => (effort === "" || one.includes("@") ? one : `${one}@${effort}`));
}

// The arguments are one model id, or two to compare, and nothing else, and the environment holds
// no key: a key in either is refused before anything runs. A second argument that is not a model
// id may be a key. Null when they are fine.
export function refusedArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): "usage" | "key_in_argument" | "key_in_environment" | "bad_env" | null {
  if (KEY_VARIABLES.some((name) => (env[name] ?? "") !== "")) return "key_in_environment";
  if ((env[EFFORT] ?? "") !== "" && !isReasoningEffort(env[EFFORT] ?? "")) return "bad_env";
  if (argv.length > 2 || (argv.length === 2 && !argv.every((one) => MODEL_ID.test(one)))) return "key_in_argument";
  if (argv.length === 0 || !MODEL_ID.test(argv[0] ?? "")) return "usage";
  return null;
}

// The key, from standard input: the first line, with the line break dropped. On a terminal it
// is read with echo off.
export async function readKey(
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown },
): Promise<string> {
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  if (raw) input.setRawMode?.(true);
  let text = "";
  try {
    for await (const chunk of input) {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      // Control-C on a terminal in raw mode.
      if (text.includes("\u0003")) throw new CodedError("no_key");
      const end = text.search(/[\r\n]/);
      if (end >= 0) {
        text = text.slice(0, end);
        break;
      }
    }
  } finally {
    if (raw) input.setRawMode?.(false);
  }
  const key = text.trim();
  if (key === "") throw new CodedError("no_key");
  return key;
}

const quiet = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

type Report = {
  model: string;
  spendCap: string | null;
  run: { outcome: string | null; code: string | null };
  output: ReasoningOutput | null;
  checks: { action: number; code: string | null }[];
  refusals: unknown[];
  turns: number;
  costMicroUsd: number;
};

// One reasoner run on a harness with one model, read back from the run's rows.
async function checkOne(
  h: Harness,
  modelId: string,
  apiKey: string,
  live: TurnModel,
  keyFetch: typeof fetch | undefined,
): Promise<Report> {
  // The model's last reply, which is the output when the run finished; and each finish_run the
  // agent API refused.
  let last: TurnReply | undefined;
  const observed: TurnModel = {
    async turn(request) {
      last = await live.turn(request);
      return last;
    },
  };
  const finishes: string[] = [];
  const startApi = async (): Promise<AgentApi> => {
    const api = await startAgentApi([h.wrappers.reasoner ?? ""], { path: "" });
    return {
      ...api,
      async call(name, args) {
        const answered = await api.call(name, args);
        if (name === "finish_run" && !answered.ok) finishes.push(answered.code);
        return answered;
      },
    };
  };
  // The run's spend-cap line and the code checks' refusals, read from its log: the key needs its
  // credit limit at OpenRouter before this check, as the box does.
  let spendCap: string | null = null;
  const checks: Report["checks"] = [];
  const log: PersonalLogger = {
    info(one) {
      if (one.event === "spend_cap") spendCap = one.code ?? null;
      if (one.event === "output_refused") checks.push({ action: one.counts?.action ?? -1, code: one.code ?? null });
    },
    warn() {},
    error() {},
  };
  await runOnce(
    {
      PI_AGENT_API_COMMAND: h.wrappers.reasoner ?? "",
      PI_REASONER_MODEL: modelArgument(modelId).model,
      PI_REASONER_MODEL_KEY: apiKey,
    },
    { model: observed, startApi, log, stderr: quiet(), ...(keyFetch === undefined ? {} : { keyFetch }) },
  );

  const steps = await h.rows<Step>(
    "select ordinal, kind, status, tool, code, cost_microusd::int as cost from ledger.run_steps where run_id = $1 order by attempt, ordinal",
    [h.ids.run],
  );
  const [ended] = await h.rows<{ event: string; code: string | null }>(
    "select event, code from ledger.record_events where row_kind = 'run' and row_id = $1 order by id desc limit 1",
    [h.ids.run],
  );
  let output: ReasoningOutput | null = null;
  try {
    const parsed = ReasoningOutput.safeParse(JSON.parse(last?.text ?? "null"));
    output = parsed.success ? parsed.data : null;
  } catch {
    output = null;
  }
  return {
    model: modelId,
    spendCap,
    run: { outcome: ended?.event ?? null, code: ended?.code ?? null },
    output,
    checks,
    refusals: [
      ...steps
        .filter((one) => one.kind === "tool_call" && one.status !== "ok")
        .map((one) => ({ step: one.ordinal, tool: one.tool, status: one.status, code: one.code })),
      // A model call cut off at the output limit.
      ...steps
        .filter((one) => one.kind === "model_call" && one.code !== null)
        .map((one) => ({ step: one.ordinal, model_call: one.code })),
      ...finishes.map((code) => ({ finish_run: code })),
    ],
    turns: steps.filter((one) => one.kind === "model_call").length,
    costMicroUsd: steps.reduce((sum, one) => sum + (one.cost ?? 0), 0),
  };
}

// Two reports side by side: each action of the two outputs at one index, then each run's report
// without its output.
function compared(reports: readonly Report[]): unknown {
  const [a, b] = reports;
  if (a === undefined || b === undefined) return a;
  const longest = Math.max(a.output?.actions.length ?? 0, b.output?.actions.length ?? 0);
  const bare = ({ output: _, ...rest }: Report) => rest;
  return {
    models: [a.model, b.model],
    actions: Array.from({ length: longest }, (_, index) => ({
      index,
      a: a.output?.actions[index] ?? null,
      b: b.output?.actions[index] ?? null,
    })),
    runs: [bare(a), bare(b)],
  };
}

export async function checkPrompt({ modelIds, readKey: key, models, keyFetch, out }: CheckDeps): Promise<CheckResult> {
  // To a terminal only, and before anything is read or built.
  if (out.isTTY !== true) return { code: "not_a_terminal" };
  // Handed-in models have no key: the spend-cap check is given a placeholder, which only a test's
  // key endpoint reads.
  const apiKey = models === undefined ? await key() : "handed-in-model-has-no-key";
  const lives = modelIds.map((argument, index) => {
    const { model, effort } = modelArgument(argument);
    return (
      models?.[index] ??
      createTurnModel({ model, apiKey, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    );
  });
  const harnesses: Harness[] = [];
  try {
    const template = await workHarness({ worker: false, queue: "request" });
    harnesses.push(template);
    // Every copy before any run, so each model reads the same request.
    if (modelIds.length > 1) {
      await template.release();
      for (let index = 1; index < modelIds.length; index += 1) harnesses.push(await copyHarness(template));
    }
    const reports: Report[] = [];
    for (const [index, modelId] of modelIds.entries()) {
      const h = harnesses[index];
      const live = lives[index];
      if (h === undefined || live === undefined) throw new Error("a harness for each model");
      reports.push(await checkOne(h, modelId, apiKey, live, keyFetch));
    }
    const report = reports.length === 1 ? reports[0] : compared(reports);
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return { code: "ok", databases: harnesses.map((h) => h.db.name), folders: harnesses.map((h) => h.folder) };
  } finally {
    for (const h of harnesses) await h.cleanup();
  }
}

// The entry: one model id or two, the key from standard input, the report to the terminal.
async function main(): Promise<number> {
  const fail = (code: string): number => {
    process.stderr.write(`${JSON.stringify({ event: "check_failed", code })}\n`);
    return code === "usage" ? 2 : 1;
  };
  const argv = process.argv.slice(2);
  const refused = refusedArguments(argv, process.env);
  if (refused !== null) return fail(refused);
  try {
    const result = await checkPrompt({
      modelIds: withEffort(argv, process.env),
      readKey: () => {
        process.stderr.write("the reasoner's OpenRouter key: ");
        return readKey(process.stdin).finally(() => process.stderr.write("\n"));
      },
      out: process.stdout,
    });
    return result.code === "ok" ? 0 : fail(result.code);
  } catch (error) {
    const code = isCoded(error) ? error.code : undefined;
    return fail(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unavailable");
  }
}

if (import.meta.main) process.exitCode = await main();
