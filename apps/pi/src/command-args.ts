// What a command's arguments may be: the checks that run before any connection, and the parsers a
// body reads its options by. Nothing here loads a body.
import {
  ASKED_LANES,
  CAPTURE_LANES,
  ClaimRelationKind,
  ClientName,
  ClientQuota,
  DocumentId,
  DREAM_FINDINGS_LIMIT,
  FactType,
  HoldName,
  ImprovementId,
  JobName,
  MessageId,
  PersonalBeliefKind,
  SelfStatus,
  SupervisedName,
  Tier,
  TriageLane,
  ULID_PATTERN,
} from "@intelligence/contracts/personal";
import type { CommandContext } from "./command-types.ts";
import { refusal } from "./env.ts";

// The lanes `extract check --world` evaluates, each on its synthetic set: `transaction` is the
// notices and receipts of personal_transaction version 2, `notices` what a notice says is due and what
// must give nothing, and `second-degree` the second-degree
// versions' acquaintance and intro_offer.
export const WORLD_LANES = Object.freeze([
  "document",
  "meeting",
  "moment",
  "correspondence",
  "transaction",
  "notices",
  "second-degree",
] as const);
export type WorldLane = (typeof WORLD_LANES)[number];

export const usage = (): never => {
  throw refusal("usage");
};

// `extract check --world`'s comparison options, on the synthetic world alone: a vendor, openrouter
// or anthropic, over the configured one; a model and an effort for anthropic alone; the detail
// for the meeting, moment and correspondence lanes alone; and, for the meeting and moment lanes
// alone, the number of runs to pool; and the plain and pseudonymised comparison. Each needs --world.
export function checkWorldOptions(values: CommandContext["values"]): void {
  const { vendor, model, effort, detail, runs, pseudonymise } = values;
  if (values.world !== true && [vendor, model, effort, detail, runs, pseudonymise].some((value) => value !== undefined))
    usage();
  // The meeting or moment lane's runs to pool, 1 to 5.
  if (
    runs !== undefined &&
    ((values.lane !== "meeting" && values.lane !== "moment") || !(typeof runs === "string" && /^[1-5]$/.test(runs)))
  )
    usage();
  if (vendor !== undefined && vendor !== "openrouter" && vendor !== "anthropic") usage();
  if (vendor !== "anthropic" && (model !== undefined || effort !== undefined)) usage();
  if (
    model !== undefined &&
    !(typeof model === "string" && /^(anthropic\/)?claude-[a-z0-9][a-z0-9.-]{0,80}$/.test(model))
  )
    usage();
  if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "max") usage();
  if (
    detail !== undefined &&
    values.lane !== "meeting" &&
    values.lane !== "moment" &&
    values.lane !== "correspondence" &&
    values.lane !== "transaction"
  )
    usage();
}

// A whole number written in digits, from 1 to `most`, or a usage error.
const countOf = (value: unknown, most: number): number =>
  typeof value === "string" && /^[1-9]\d*$/.test(value) && Number(value) <= most ? Number(value) : usage();

export const valid = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  value === undefined || schema.safeParse(value).success;

// A fact type, and a sample of 1 to 500.
export function checkReview({ values }: Pick<CommandContext, "values">): void {
  if (!valid(FactType, values.type)) usage();
  if (values.sample !== undefined) countOf(values.sample, 500);
}

// `pi people tiers`' filters, a tier and a count of 1 to 5 000, or `--ruled` alone.
export function checkPeopleTiers({ values }: Pick<CommandContext, "values">): void {
  const limit = values.limit;
  if (!valid(Tier, values.tier)) usage();
  if (limit !== undefined) countOf(limit, 5_000);
  if (values.ruled === true && (values.tier !== undefined || values.dormant !== undefined || limit !== undefined))
    usage();
}

// `pi people tier PERSON TIER`, a ranked tier (never `one-way`), or `PERSON --clear` with no tier.
export function checkPeopleTier({ values, positionals }: Pick<CommandContext, "values" | "positionals">): void {
  if ((positionals[0] ?? "") === "") usage();
  if (
    values.clear === true
      ? positionals.length !== 1
      : positionals.length !== 2 || !Tier.safeParse(positionals[1]).success || positionals[1] === "one-way"
  )
    usage();
}

// `pi self review`'s filters, a belief kind and a row's status.
export function checkSelfReview({ values }: Pick<CommandContext, "values">): void {
  if (!valid(PersonalBeliefKind, values.kind) || !valid(SelfStatus, values.status)) usage();
}
// How many facts one ruling command takes at once.
export const FACTS = Object.freeze(Array.from({ length: 100 }, (_, index) => index + 1));

// The statuses a retry selects by: every final one.
const RETRY_STATUSES = ["failed", "withheld", "skipped", "done"];

// A window of days an owner's report takes: 1 to 90, its own default when unset.
function windowDaysOf(days: CommandContext["values"][string], unset: number): number {
  return days === undefined ? unset : countOf(days, 90);
}

// Exactly one selection; a lane the triage knows, of the item's kind: a document's is `document`
// or `skip`, and `document` is no message's; `page` is a stored page's, `meeting` a meeting's and
// `moment` a moment's, each set by code and never given; and a release only of one message, with
// no lane. `--kind meeting|moment`, alone or with `--status`, and `--capture ID`, one meeting or
// moment by its `cap_` id or capture key; neither takes a lane, since a capture item's lane is
// code's. `--in-lane L`, alone or with `--status`, the items a message lane holds; it sets no lane.
const RETRY_KINDS: readonly string[] = CAPTURE_LANES;
const RETRY_LANES: readonly string[] = ASKED_LANES;
export const CAPTURE_REF = new RegExp(`^(cap_${ULID_PATTERN}|(meeting|moment):${ULID_PATTERN})$`);
export function checkRetry({ values }: Pick<CommandContext, "values">): void {
  const { all, status, message, document, lane, override, kind, capture } = values;
  const inLane = values["in-lane"];
  const chosen = [
    all === true,
    status !== undefined || kind !== undefined || inLane !== undefined,
    message !== undefined,
    document !== undefined,
    capture !== undefined,
  ].filter(Boolean).length;
  if (chosen !== 1) usage();
  if (kind !== undefined && (!RETRY_KINDS.includes(kind as string) || lane !== undefined)) usage();
  if (values["keep-answers"] === true && inLane === undefined) usage();
  if (values["fact-kinds"] !== undefined && values["keep-answers"] !== true) usage();
  if (inLane !== undefined && (!RETRY_LANES.includes(inLane as string) || lane !== undefined || kind !== undefined))
    usage();
  if (capture !== undefined && (typeof capture !== "string" || !CAPTURE_REF.test(capture) || lane !== undefined))
    usage();
  if (status !== undefined && !RETRY_STATUSES.includes(status as string)) usage();
  if (
    !valid(MessageId, message) ||
    !valid(DocumentId, document) ||
    !valid(TriageLane, lane) ||
    lane === "page" ||
    lane === "meeting" ||
    lane === "moment"
  )
    usage();
  if (lane !== undefined && (document === undefined ? lane === "document" : lane !== "document" && lane !== "skip"))
    usage();
  if (override === true && (message === undefined || lane !== undefined)) usage();
}
// A client by name, and a limit of 1 to 500.
export function checkMemory({ values }: Pick<CommandContext, "values">): void {
  const { client, limit } = values;
  if (!valid(ClientName, client)) usage();
  if (limit !== undefined) countOf(limit, 500);
}
// `pia status --coverage [--days N] [--record]`'s options, or null without `--coverage`. `N` is 1
// to 90, 7 when unset; `--days` or `--record` without `--coverage`, or `--coverage` with
// `--storage`, is a usage error.
export function coverageOptionsOf(values: CommandContext["values"]): { days: number; record: boolean } | null {
  const { coverage, days, record, storage } = values;
  if (coverage !== true) {
    if (days !== undefined || record !== undefined) usage();
    return null;
  }
  if (storage === true) usage();
  return { days: windowDaysOf(days, 7), record: record === true };
}

// `pi outcomes --days N`: 1 to 90, 14 when unset.
export const outcomesDaysOf = ({ days }: CommandContext["values"]): number => windowDaysOf(days, 14);
// `pi loops --days N`: 1 to 90, 7 when unset.
export const loopsDaysOf = ({ days }: CommandContext["values"]): number => windowDaysOf(days, 7);
// `pi dream findings [--kind KIND] [--limit N] [--effective]`: a relation kind, and a limit within DREAM_FINDINGS_LIMIT.
export function dreamFindingsOf({ kind, limit, effective }: CommandContext["values"]): {
  kind: string | null;
  limit: number;
  effective: boolean;
} {
  if (kind !== undefined && !ClaimRelationKind.safeParse(kind).success) usage();
  if (
    limit !== undefined &&
    !(typeof limit === "string" && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= DREAM_FINDINGS_LIMIT.most)
  )
    usage();
  return {
    kind: typeof kind === "string" ? kind : null,
    limit: limit === undefined ? DREAM_FINDINGS_LIMIT.unset : Number(limit),
    effective: effective === true,
  };
}
// `pi agents record [--weeks N]`: a whole number of weeks from 1 to 26, 4 unset.
export const agentWeeksOf = ({ weeks }: CommandContext["values"]): number =>
  weeks === undefined ? 4 : countOf(weeks, 26);
// `pi improvements nightly --red N`: a whole count.
export const redOf = ({ red }: CommandContext["values"]): number => {
  if (typeof red !== "string" || !/^\d{1,6}$/.test(red)) usage();
  return Number(red);
};

// `pi improvements close IMPROVEMENT --as wont_do|duplicate [--of IMPROVEMENT]`.
const improvementOf = (value: unknown): string | null =>
  typeof value === "string" && ImprovementId.safeParse(value).success ? value : null;
export function improvementCloseOf({ positionals, values }: Pick<CommandContext, "positionals" | "values">): {
  improvement: string;
  status: "wont_do" | "duplicate";
  duplicateOf: string | null;
} {
  const improvement = improvementOf(positionals[0]);
  const duplicateOf = values.of === undefined ? null : improvementOf(values.of);
  const status = values.as;
  if (improvement === null || (status !== "wont_do" && status !== "duplicate")) return usage();
  if ((values.of !== undefined && duplicateOf === null) || duplicateOf === improvement) return usage();
  if ((status === "duplicate") !== (duplicateOf !== null)) return usage();
  return { improvement, status, duplicateOf };
}

// `pi improvements role IMPROVEMENT ROLE|--none`.
export function improvementRoleOf({ positionals, values }: Pick<CommandContext, "positionals" | "values">): {
  improvement: string;
  role: string | null;
} {
  const improvement = improvementOf(positionals[0]);
  const role = positionals[1];
  if (improvement === null) return usage();
  if (values.none === true) return role === undefined ? { improvement, role: null } : usage();
  return typeof role === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(role) ? { improvement, role } : usage();
}

// `pi improvements default-role ROLE|--none`.
export function defectRoleOf({ positionals, values }: Pick<CommandContext, "positionals" | "values">): string | null {
  const role = positionals[0];
  if (values.none === true) return role === undefined ? null : usage();
  return typeof role === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(role) ? role : usage();
}

// `pi levers set KEY VALUE` and `pi levers undo KEY`: a lever's key in its form, and a value that
// is a number or a code. Whether the key is registered and the value in range is the store's check.
const LEVER_KEY = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,2}$/;
export const leverKeyOf = ({ positionals }: Pick<CommandContext, "positionals">): string => {
  const key = positionals[0];
  return typeof key === "string" && LEVER_KEY.test(key) ? key : usage();
};
export function leverSetOf(context: Pick<CommandContext, "positionals">): { key: string; value: number | string } {
  const key = leverKeyOf(context);
  const value = context.positionals[1];
  if (typeof value !== "string") return usage();
  if (/^\d{1,9}(\.\d{1,6})?$/.test(value)) return { key, value: Number(value) };
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? { key, value } : usage();
}

// The box health commands' arguments (health.ts).
const JOB_CODE = /^[a-z][a-z0-9_]{0,63}$/;

// `pi health job JOB CODE --started EPOCH [--kind full|fast] [--read-hold] [--counts JSON]`'s
// arguments, checked before any connection: a job ledger.job_runs records, a code in the job codes'
// form, the run's start in whole seconds since the epoch, for a sync alone its kind and the read
// hold, and for the night's pass alone the counts it printed.
export function healthJobOf({ values, positionals }: Pick<CommandContext, "values" | "positionals">): {
  job: JobName;
  code: string;
  startedAt: Date;
  syncKind?: "full" | "fast";
  readHold?: boolean;
} & DreamRow {
  const [job, code] = positionals;
  const { started, kind, counts } = values;
  const parsed = JobName.safeParse(job);
  if (!parsed.success || parsed.data === "backup" || !JOB_CODE.test(code ?? "")) usage();
  if (typeof started !== "string" || !/^[1-9]\d{0,10}$/.test(started)) usage();
  const sync = parsed.data === "sync";
  if (!sync && (kind !== undefined || values["read-hold"] !== undefined)) usage();
  if (kind !== undefined && kind !== "full" && kind !== "fast") usage();
  if (counts !== undefined && (parsed.data !== "dream" || typeof counts !== "string")) usage();
  return {
    job: parsed.data as JobName,
    code: code as string,
    startedAt: new Date(Number(started) * 1000),
    ...(sync ? { syncKind: (kind ?? "full") as "full" | "fast", readHold: values["read-hold"] === true } : {}),
    ...(typeof counts === "string" ? dreamRowOf(counts) : {}),
  };
}

// What a night's pass's row keeps of the counts `pi dream` printed (imp_01M6ST6JZ4PW9BWNWVN61DHHMR):
// the relations sweep's backlog, and each stage's spend in micro-dollars under the stage's name in
// the row, each a whole number not below 0, every stage or none. Anything else it printed is not
// kept. Counts that are not the pass's keep neither, and the run is still recorded: a row without
// them says less, never something wrong. The stages, as the pass names them and as the row does.
export const DREAM_STAGES = Object.freeze({
  recall: "recall",
  fulfils: "fulfils",
  sweep: "sweep",
  sourceCheck: "source_check",
  hotCheck: "hot_check",
} as const);
export type DreamStage = keyof typeof DREAM_STAGES;
export type DreamRow = {
  backlog?: number;
  stageMicroUsd?: Record<(typeof DREAM_STAGES)[DreamStage], number>;
};
const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function dreamRowOf(text: string): DreamRow {
  let counts: unknown;
  try {
    counts = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof counts !== "object" || counts === null) return {};
  const { backlog, stageMicroUsd } = counts as Record<string, unknown>;
  const stages =
    typeof stageMicroUsd === "object" && stageMicroUsd !== null ? (stageMicroUsd as Record<string, unknown>) : {};
  const named = Object.entries(DREAM_STAGES);
  return {
    ...(whole(backlog) ? { backlog } : {}),
    ...(named.every(([stage]) => whole(stages[stage]))
      ? {
          stageMicroUsd: Object.fromEntries(named.map(([stage, column]) => [column, stages[stage]])) as Record<
            (typeof DREAM_STAGES)[DreamStage],
            number
          >,
        }
      : {}),
  };
}

export function holdOf({ positionals }: Pick<CommandContext, "positionals">): HoldName {
  const parsed = HoldName.safeParse(positionals[0]);
  return parsed.success ? parsed.data : usage();
}

// A supervised process's name, as lib/supervise names it.
export function supervisedOf({ positionals }: Pick<CommandContext, "positionals">): SupervisedName {
  const parsed = SupervisedName.safeParse(positionals[0]);
  return parsed.success ? parsed.data : usage();
}

// A target's name, as the adapter's configuration names one.
export function checkTarget({ positionals }: Pick<CommandContext, "positionals">): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(positionals[0] ?? "")) usage();
}

// `pi clients quota`'s options: each a whole number within ClientQuota's
// bounds, and at least one; anything else is a usage error, before any connection.
const QUOTA_OPTIONS = {
  items: "maxItemsDay",
  chars: "maxCharsDay",
  rows: "maxRowsDay",
  "per-minute": "maxCallsMinute",
} as const;
export function quotaChanges(values: CommandContext["values"]): Partial<ClientQuota> {
  const changes: Partial<ClientQuota> = {};
  for (const [option, key] of Object.entries(QUOTA_OPTIONS)) {
    const value = values[option];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) usage();
    const number = Number(value);
    if (!ClientQuota.shape[key].safeParse(number).success) usage();
    changes[key] = number;
  }
  if (Object.keys(changes).length === 0) usage();
  return changes;
}
