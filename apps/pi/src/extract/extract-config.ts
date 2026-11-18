import { createHmac } from "node:crypto";
import type { ModelUsageEvent, SwitchedLane } from "@intelligence/contracts/personal";
import { PersonalCompartment } from "@intelligence/contracts/personal";
import {
  CALLED_PROMPTS,
  CLAIM_RELATIONS_PROMPT,
  DECIDE_RECORD,
  DECIDE_RECOVERY,
  DECIDE_SAID,
  DECIDE_SAME_FACT,
  DECIDE_SCREEN,
  DECIDE_STANDALONE,
  DOCUMENT_DAYS,
  EXTRACT_SAME_FACT,
  type ExtractDeps,
  exposing,
  FACT_KIND_LANES,
  type FactKindLane,
  OUTCOME_JUDGE_PROMPT,
  OWN_LINES_DAY_MICRO_USD,
  RECALL_AUDIT_PROMPT,
  SAME_PERSON_PROMPT,
  SOURCE_CHECK_PROMPT,
  TIME_PROPOSAL_PROMPT,
} from "@intelligence/personal-extract";
import {
  type AnthropicEffort,
  anthropicKey,
  anthropicModelId,
  anthropicPriced,
  checkSpendCap,
  createAnthropicExtractClient,
  createDecideClient,
  createOpenRouterClient,
  createPseudonymiser,
  DECIDE_MODELS,
  isAnthropicEffort,
  keyEndpointOf,
  microUsdOf,
  type Pseudonymiser,
  type SpendCap,
  spendCapEvent,
  withBudget,
} from "@intelligence/personal-models";
import { createPipeline, journalPath, type Keys, loadKeys, type Pipeline } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import type { Env } from "../env.ts";
import { refusal } from "../env.ts";

// What every extraction command reads before any connection: the run's settings, the extraction,
// moment-lane and judge models and the vendor that answers them, then the pipeline it opens, the
// model and the decide model clients, and the spend-cap check. The model id is the owner's configuration and
// none is in code; the key is read only from its sealed copy in the store.

const MODEL_KEY = "openrouter/key";

export type ModelClient = ExtractDeps["model"];

// The settings of a run, read before any connection: each malformed value is a usage error.
export type ExtractSettings = {
  runMicroUsd: number;
  dayMicroUsd: number;
  maxCalls: number;
  compartments: string[] | undefined;
  keyCapMicroUsd: number;
  keyUrl: string | undefined;
  documents: { days: number } | undefined;
  meetings: boolean;
  moments: boolean;
  momentsContinuous: boolean;
  ownLines: { dayMicroUsd: number } | undefined;
  time: boolean;
  secondDegree: boolean;
  factKinds: readonly FactKindLane[];
  repair: boolean;
  reask: boolean;
};

// Dollars as whole micro-dollars (microUsdOf); unset or empty is the fallback.
function microUsd(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const micro = microUsdOf(value);
  if (micro === null) throw refusal("usage");
  return micro;
}

export function count(value: string | boolean | undefined | (string | boolean)[], fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^[1-9]\d{0,5}$/.test(value)) throw refusal("usage");
  return Number(value);
}

// No restricted compartment exists in this build, so one in the setting is
// refused.
function compartmentsOf(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const names = value.split(",");
  if (!names.every((name) => PersonalCompartment.safeParse(name).success && !name.startsWith("restricted:")))
    throw refusal("usage");
  return names;
}

// A switch the owner sets: `1` or unset. Any other value is a usage error, so a typo is never off.
function onOf(value: string | undefined): boolean {
  if (value !== undefined && value !== "" && value !== "1") throw refusal("usage");
  return value === "1";
}

// Documents are taken only when PI_EXTRACT_DOCUMENTS is `1`,
// set by the owner once the document evaluation passes; PI_EXTRACT_DOCUMENT_DAYS is the days a
// document stays in the lane after its last edit. Each is checked whether documents are on or not.
function documentsOf(env: Env): { days: number } | undefined {
  const on = onOf(env.PI_EXTRACT_DOCUMENTS);
  const days = env.PI_EXTRACT_DOCUMENT_DAYS ?? "";
  if (days !== "" && !/^[1-9]\d{0,4}$/.test(days)) throw refusal("usage");
  return on ? { days: days === "" ? DOCUMENT_DAYS : Number(days) } : undefined;
}

// Meetings are sent to a model only when PI_EXTRACT_MEETINGS is `1`,
// set by the owner once the meeting evaluation passes. Unset, each meeting is still committed,
// `not_extracted`, with its participants. Any other value is a usage error.
function meetingsOf(env: Env): boolean {
  return onOf(env.PI_EXTRACT_MEETINGS);
}

// Moments are sent to a model only when PI_EXTRACT_MOMENTS is `1`,
// set by the owner once the moment evaluation passes. Unset, each moment is still committed,
// `not_extracted`. Any other value is a usage error.
function momentsOf(env: Env): boolean {
  return onOf(env.PI_EXTRACT_MOMENTS);
}

// The daily time proposals run only when PI_EXTRACT_TIME is `1`, set by
// the owner. Any other value is a usage error.
function timeOf(env: Env): boolean {
  return onOf(env.PI_EXTRACT_TIME);
}

// The moment lane runs batched by default, at 00:00 and 12:00 on the owner's clock, one request
// per thread per run, which costs less; PI_EXTRACT_MOMENTS_MODE=continuous keeps the groups,
// each due two hours after its latest moment. Any other value is a usage error.
function momentsContinuousOf(env: Env): boolean {
  const mode = env.PI_EXTRACT_MOMENTS_MODE ?? "";
  if (mode !== "" && mode !== "batched" && mode !== "continuous") throw refusal("usage");
  return mode === "continuous";
}

// With PI_EXTRACT_OWN_LINES `1`, set by the owner after `pi extract trial
// --own-lines`, an agent app's moment holding lines Lens marks theirs is asked those lines alone. It
// is on the moment lane's budget, so it needs that lane on. PI_EXTRACT_OWN_LINES_DAY_USD is its own
// line, in dollars a day. Any other value is a usage error.
function ownLinesOf(env: Env): { dayMicroUsd: number } | undefined {
  const on = onOf(env.PI_EXTRACT_OWN_LINES);
  const dayMicroUsd = microUsd(env.PI_EXTRACT_OWN_LINES_DAY_USD, OWN_LINES_DAY_MICRO_USD);
  if (!on) return undefined;
  if (!momentsOf(env)) throw refusal("usage");
  return { dayMicroUsd };
}

// An item whose call of the current version is saved keeps it, so no item already done is asked
// again. Unset, every lane asks its current version. Any other value is a usage error.
function secondDegreeOf(env: Env): boolean {
  const on = env.PI_EXTRACT_SECOND_DEGREE ?? "";
  if (on !== "" && on !== "1") throw refusal("usage");
  return on === "1";
}

// PI_EXTRACT_FACT_KINDS, the lanes, comma-separated, whose new
// items are asked their fact-kind version (view, status, visited), each named by the owner after
// its trial (`pi extract trial --lane L --fact-kinds`): correspondence, transaction,
// agent, meeting, moment. An item whose call of the current or second-degree version is saved
// keeps it. Unset or empty, no lane. An unknown or repeated lane is a usage error.
function factKindsOf(env: Env): FactKindLane[] {
  const value = env.PI_EXTRACT_FACT_KINDS ?? "";
  if (value === "") return [];
  const lanes = value.split(",");
  if (
    new Set(lanes).size !== lanes.length ||
    lanes.some((lane) => !(FACT_KIND_LANES as readonly string[]).includes(lane))
  )
    throw refusal("usage");
  return lanes as FactKindLane[];
}

export function extractSettings(env: Env, values: CommandContext["values"]): ExtractSettings {
  return {
    runMicroUsd: microUsd(env.PI_EXTRACT_RUN_USD, 1_000_000),
    dayMicroUsd: microUsd(env.PI_EXTRACT_DAY_USD, 3_000_000),
    // The flag, for a run started by hand, over the setting.
    maxCalls: count(values["max-calls"] ?? env.PI_EXTRACT_MAX_CALLS, 500),
    compartments: compartmentsOf(env.PI_EXTRACT_COMPARTMENTS),
    keyCapMicroUsd: keyCapOf(env),
    keyUrl: keyUrlOf(env),
    documents: documentsOf(env),
    meetings: meetingsOf(env),
    moments: momentsOf(env),
    momentsContinuous: momentsContinuousOf(env),
    ownLines: ownLinesOf(env),
    time: timeOf(env),
    secondDegree: secondDegreeOf(env),
    factKinds: factKindsOf(env),
    repair: onOf(env.PI_EXTRACT_REPAIR),
    reask: onOf(env.PI_EXTRACT_REASK),
  };
}

// The most the key may spend in a month: 20 dollars unless
// PI_EXTRACT_KEY_CAP_USD says otherwise, parsed as the budgets are (provisional, its Q5).
export const keyCapOf = (env: Env): number => microUsd(env.PI_EXTRACT_KEY_CAP_USD, 20_000_000);

// The key endpoint's override, which only the box's smoke test sets, to a fake endpoint on the
// box's loopback (packages/models, keyEndpointOf). Any other value is refused before any
// connection; unset is OpenRouter's endpoint.
export function keyUrlOf(env: Env): string | undefined {
  const value = env.PI_OPENROUTER_KEY_URL;
  if (keyEndpointOf(value) === null) throw refusal("bad_env", "set PI_OPENROUTER_KEY_URL");
  return value;
}

// The key's limit, read from the vendor before the first model call.
// Only `ok` lets a command go on; checkSpendCap never throws, so every failure is
// spend_cap_unknown.
const spendCap = (
  { deps }: CommandContext,
  apiKey: string,
  ceilingMicroUsd: number,
  keyUrl: string | undefined,
): Promise<SpendCap> => checkSpendCap({ apiKey, fetch: deps.keyFetch ?? fetch, ceilingMicroUsd, keyUrl });

// `PI_DECIDE_MODEL`, read by `pi extract` and `pi extract check` alone, before any
// connection. Unset or empty: no decide-model call. The pinned decide-model id: the decide model screens each item. Anything
// else, the alias included, is refused.
export function decideModelOf(env: Env): string | undefined {
  const value = env.PI_DECIDE_MODEL ?? "";
  if (value === "") return undefined;
  if (!DECIDE_MODELS.includes(value)) throw refusal("bad_env");
  return value;
}

// `PI_EXTRACT_MODEL`, read before any connection. Every
// call is noted in the exposure record under it, and the record takes a model id of this form
// only, so an id off it would fail every note and leave every item waiting: refused here.
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9.:_-]*$/;
export const modelIdOk = (value: string): boolean => value.length <= 100 && MODEL_ID.test(value);
export function extractModelOf(env: Env): string {
  const value = env.PI_EXTRACT_MODEL ?? "";
  if (!modelIdOk(value)) throw refusal("bad_env");
  return value;
}

// `PI_JUDGE_MODEL`, the model of every judgment that is not extraction: the relation step, the
// outcome judge and the dream pass (its sweeps and the source check). Read before any connection,
// on the run's vendor and key. Unset or empty: the extraction model. A bare Anthropic id
// (`claude-opus-5-5`, as the box sets it) is read as `anthropic/claude-opus-5-5`, the form the
// exposure record and the judge strings take. On Anthropic's key it must be an Anthropic model on
// the price list, as the moment lane's must. A judge change is a new judge string
// (`model:<id>@<prompt>@<version>`): its relations and checks start in shadow under the switches
// that turn model judgments on.
export function judgeModelOf(env: Env, vendor: ExtractVendor, modelId: string): string {
  return modelNamed(env, vendor, "PI_JUDGE_MODEL") ?? modelId;
}

// The second model that checks every finding of the dream pass and its
// cheap screen, as the owner stored them (`pia dream model`), each read as PI_JUDGE_MODEL is; none, null.
export const dreamModelOf = (vendor: ExtractVendor, stored: string | null): string | null =>
  stored === null ? null : modelRead(vendor, stored, "dream model");

function modelNamed(env: Env, vendor: ExtractVendor, name: string): string | null {
  const raw = env[name] ?? "";
  return raw === "" ? null : modelRead(vendor, raw, `set ${name}`);
}

function modelRead(vendor: ExtractVendor, raw: string, hint: string): string {
  const value = /^claude-/.test(raw) ? `anthropic/${raw}` : raw;
  if (!modelIdOk(value)) throw refusal("bad_env", hint);
  if (vendor.kind === "anthropic" && (!isAnthropicModel(value) || !anthropicPriced(anthropicModelId(value) ?? "")))
    throw refusal("bad_env", hint);
  return value;
}

// The lanes whose switch is not `1`, recorded in the row of a
// scheduled run (`pi extract`, and the wake's `--agent-records`) for `pia status --coverage`,
// which does not load this environment; a run of one capture and `pi extract age` record none.
// A value the settings refuse is still off here; the command that reads the settings refuses it.
type LanesOff = SwitchedLane[];
export const lanesOffOf = (env: Env): LanesOff =>
  (
    [
      ["document", env.PI_EXTRACT_DOCUMENTS],
      ["meeting", env.PI_EXTRACT_MEETINGS],
      ["moment", env.PI_EXTRACT_MOMENTS],
    ] as const
  ).flatMap(([lane, value]) => (value === "1" ? [] : [lane]));

// Each vendor client behind its exposure note, then the budget, always in that order
//: `exposing` is innermost, so an item's exposure is committed before
// its request leaves, and a call the replay answers notes nothing. Exposure is noted before the budget
// check: the moment lane notes every moment of a group outside this wrapping, before the request
// reaches the budget, so a group the budget then refuses is noted all the same, which over-notes and
// never under-notes.
export const guardedClient = (
  client: ModelClient,
  store: Parameters<typeof exposing>[1],
  modelId: string,
  budget: Parameters<typeof withBudget>[1],
): ModelClient => withBudget(exposing(client, store, modelId), budget);

// The pipeline, closed when the command ends. Then the model key is read through it, unless `noKey`
// (`pi extract age`); with no key stored the command ends `no_model_key`, and no call is made.
export async function withPipeline<T>(
  { env, log }: CommandContext,
  fn: (store: Pipeline, apiKey: string, compartments: string[], keys: Keys) => Promise<T>,
  options: { noKey?: true; lanesOff?: LanesOff } = {},
): Promise<T> {
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile);
  const store = createPipeline({
    url: env.PI_DATABASE_URL_PIPELINE ?? "",
    keys,
    log,
    journal: journalPath(keyFile),
    lanesOff: options.lanesOff ?? null,
  });
  running.set(env, createPseudonymiser({ key: async () => pseudonymKey(keys), known: () => store.knownIdentities() }));
  try {
    if ((await store.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    const apiKey = options.noKey === true ? "" : await store.secret(MODEL_KEY);
    if (apiKey === null || (apiKey === "" && options.noKey !== true)) throw refusal("no_model_key");
    return await fn(store, apiKey, [...keys.compartments.keys()], keys);
  } finally {
    running.delete(env);
    await store.close();
  }
}

// The vendor of every structured call, read before any connection, as the reasoner's key picks
// its API. PI_EXTRACT_ANTHROPIC_KEY set: Anthropic's Messages API,
// with PI_EXTRACT_MODEL an Anthropic model and PI_EXTRACT_EFFORT; unset or empty: OpenRouter,
// and an effort is refused, since that body sends none.
export type ExtractVendor =
  | { kind: "openrouter" }
  | { kind: "anthropic"; apiKey: string; effort: AnthropicEffort | undefined };

export const isAnthropicModel = (modelId: string): boolean =>
  modelId.startsWith("anthropic/") && anthropicModelId(modelId) !== null;

export function extractVendorOf(env: Env, modelId: string): ExtractVendor {
  const apiKey = env.PI_EXTRACT_ANTHROPIC_KEY ?? "";
  const effort = env.PI_EXTRACT_EFFORT ?? "";
  if (apiKey === "") {
    if (effort !== "") throw refusal("bad_env", "set PI_EXTRACT_EFFORT");
    return { kind: "openrouter" };
  }
  if (!anthropicKey(apiKey)) throw refusal("bad_env", "set PI_EXTRACT_ANTHROPIC_KEY");
  if (!isAnthropicModel(modelId)) throw refusal("bad_env", "set PI_EXTRACT_MODEL");
  if (effort !== "" && !isAnthropicEffort(effort)) throw refusal("bad_env", "set PI_EXTRACT_EFFORT");
  return { kind: "anthropic", apiKey, effort: effort === "" ? undefined : effort };
}

// The moment lane's own model and effort, read before any connection. Each of
// PI_EXTRACT_MOMENT_MODEL (an Anthropic model, `anthropic/claude-...`) and PI_EXTRACT_MOMENT_EFFORT
// replaces PI_EXTRACT_MODEL or PI_EXTRACT_EFFORT for moment groups alone, on the same Anthropic
// key; the one left unset is the run's. Either set without the Anthropic key, or malformed, is
// `bad_env`. Both unset: undefined, and the moment lane asks what every lane asks.
export type LaneModel = { vendor: ExtractVendor; modelId: string };

// The pair as configured, each checked for its form, undefined where unset. The model must also
// be on the price list: an unpriced moment model would pass every check and then stop every
// lane's run with `cost_missing` at its first moment group.
export function momentPairOf(env: Env): { model: string | undefined; effort: AnthropicEffort | undefined } {
  const model = env.PI_EXTRACT_MOMENT_MODEL ?? "";
  const effort = env.PI_EXTRACT_MOMENT_EFFORT ?? "";
  if (
    model !== "" &&
    (!modelIdOk(model) || !isAnthropicModel(model) || !anthropicPriced(anthropicModelId(model) ?? ""))
  )
    throw refusal("bad_env", "set PI_EXTRACT_MOMENT_MODEL");
  if (effort !== "" && !isAnthropicEffort(effort)) throw refusal("bad_env", "set PI_EXTRACT_MOMENT_EFFORT");
  return { model: model === "" ? undefined : model, effort: effort === "" ? undefined : effort };
}

export function momentModelOf(env: Env, vendor: ExtractVendor, modelId: string): LaneModel | undefined {
  const pair = momentPairOf(env);
  if (pair.model === undefined && pair.effort === undefined) return undefined;
  if (vendor.kind !== "anthropic")
    throw refusal("bad_env", pair.model === undefined ? "set PI_EXTRACT_MOMENT_EFFORT" : "set PI_EXTRACT_MOMENT_MODEL");
  return { vendor: { ...vendor, effort: pair.effort ?? vendor.effort }, modelId: pair.model ?? modelId };
}

// `PI_PSEUDONYMISE`: `1` pseudonymises every model request of this process, extraction's, the
// decide model's and the identity sweep's, before it leaves (models' `createPseudonymiser`): known
// and found names, addresses and phone numbers become tokens keyed by a key derived from the box's
// fingerprint key, and the answer's tokens are restored. Unset or empty: off. Any other value is a
// usage error. Off until `pi extract check --world --pseudonymise` shows the lanes keep their scores.
// Inside `withPipeline` it also replaces the people's names, addresses and handles the store holds
// under the owner's clearance (policy.known_identities), read once, at the command's first call.
const PSEUDONYM_LABEL = "personal/pseudonymise/v1";
const pseudonymKey = (keys: Keys): Buffer => createHmac("sha256", keys.fingerprintKey).update(PSEUDONYM_LABEL).digest();
// The pseudonymiser of the pipeline command running under each environment, one for all its clients.
const running = new WeakMap<Env, Pseudonymiser>();
export function pseudonymiserOf(env: Env): Pseudonymiser | undefined {
  return onOf(env.PI_PSEUDONYMISE) ? pseudonymiserFrom(env) : undefined;
}
// The pseudonymiser whatever the switch says, for the evaluation that compares the two: the
// pipeline command's, with the store's names, or one on the key file alone (the identity sweep).
export const pseudonymiserFrom = (env: Env): Pseudonymiser =>
  running.get(env) ?? createPseudonymiser({ key: async () => pseudonymKey(await loadKeys(env.PI_KEY_FILE ?? "")) });
// The deps that carry it, for a client this process builds.
export const pseudonymised = (env: Env): { pseudonymiser?: Pseudonymiser } => {
  const pseudonymiser = pseudonymiserOf(env);
  return pseudonymiser === undefined ? {} : { pseudonymiser };
};

// The real client, or the test's. `onUsage` records each answer's usage under the id its event
// names: the id the client called, in its route's form, set by the client from the configured id
// (OpenRouter's `vendor/model`, or Anthropic's `claude-...`), so the route reads from the id
//. The model string is never read from the answer. On OpenRouter `apiKey` is the
// stored key; on Anthropic the vendor carries its own.
// `pseudonymiser`, when given, takes the place of the one `PI_PSEUDONYMISE` would give, and null is
// none whatever the switch says.
export function clientOf(
  { deps, env = {} }: Pick<CommandContext, "deps"> & { env?: Env },
  vendor: ExtractVendor,
  apiKey: string,
  modelId: string,
  onUsage: (event: ModelUsageEvent) => Promise<void>,
  fetchOf: (base: typeof fetch) => typeof fetch = (base) => base,
  pseudonymiser: Pseudonymiser | null = pseudonymiserOf(env) ?? null,
): ModelClient {
  if (deps.model !== undefined) return deps.model;
  // Also the extract model's same-fact prompt, asked by the sweep after the rebuild; the relation step's
  // prompt; and the outcome judge's and the source check's, which the judge client asks.
  const registry = [
    ...CALLED_PROMPTS,
    EXTRACT_SAME_FACT,
    CLAIM_RELATIONS_PROMPT,
    OUTCOME_JUDGE_PROMPT,
    SOURCE_CHECK_PROMPT,
    RECALL_AUDIT_PROMPT,
    TIME_PROPOSAL_PROMPT,
    SAME_PERSON_PROMPT,
  ];
  const sending = {
    fetch: fetchOf(deps.modelFetch ?? fetch),
    ...(pseudonymiser === null ? {} : { pseudonymiser }),
  };
  if (vendor.kind === "anthropic") {
    return createAnthropicExtractClient({
      apiKey: vendor.apiKey,
      model: modelId,
      ...(vendor.effort === undefined ? {} : { effort: vendor.effort }),
      registry,
      onUsage,
      deps: sending,
    });
  }
  return createOpenRouterClient({ apiKey, model: modelId, registry, onUsage, deps: sending });
}

// A refusal ends the command with its code.
const ANTHROPIC_CONSOLE = { event: "spend_cap", code: "anthropic_console" } as const;
export const readsOpenRouter = (vendor: ExtractVendor, decideOn: boolean): boolean =>
  vendor.kind === "openrouter" || decideOn;

export async function checkCaps(
  context: CommandContext,
  vendor: ExtractVendor,
  openRouter: boolean,
  apiKey: string,
  ceilingMicroUsd: number,
  keyUrl: string | undefined,
  print?: (line: string) => void,
): Promise<void> {
  if (openRouter) {
    const cap = await spendCap(context, apiKey, ceilingMicroUsd, keyUrl);
    if (print === undefined) context.log.info(spendCapEvent(cap));
    else
      print(
        cap.code === "ok"
          ? `spend_cap: ok limit_micro_usd=${cap.limitMicroUsd} remaining_micro_usd=${cap.remainingMicroUsd}`
          : `spend_cap: ${cap.code}`,
      );
    if (cap.code !== "ok") throw refusal(cap.code);
  }
  if (vendor.kind === "anthropic") {
    if (print === undefined) context.log.info(ANTHROPIC_CONSOLE);
    else print(`spend_cap: ${ANTHROPIC_CONSOLE.code}`);
  }
}

// `PI_DECIDE_ALLOW_RETAINED`, the owner's setting: `1` lets a decide-model request that no
// zero-retention endpoint serves be sent once more without zero retention, data collection still
// denied, and logs `decide_model_retained` each time. Unset or any other value: that refusal is
// final.
export const retainedResendOf = ({ env, log }: CommandContext): { onRetainedResend?: () => void } =>
  env.PI_DECIDE_ALLOW_RETAINED === "1"
    ? { onRetainedResend: () => log.warn({ event: "decide_model_retained", code: "no_zdr_endpoint" }) }
    : {};

// The real decide-model client on the same key, or the test's, with the prompts of its two further screens
// and the same-fact question.
export function decideClientOf(
  context: CommandContext,
  apiKey: string,
  modelId: string,
  onUsage: (event: ModelUsageEvent) => Promise<void>,
): ModelClient {
  const { deps } = context;
  if (deps.decideModel !== undefined) return deps.decideModel;
  return createDecideClient({
    apiKey,
    model: modelId,
    registry: [DECIDE_SCREEN, DECIDE_RECOVERY, DECIDE_RECORD, DECIDE_SAME_FACT, DECIDE_STANDALONE, DECIDE_SAID],
    onUsage,
    ...retainedResendOf(context),
    deps: { ...(deps.modelFetch === undefined ? {} : { fetch: deps.modelFetch }), ...pseudonymised(context.env) },
  });
}
