import type { PersonalLogEvent } from "@intelligence/contracts/personal";
import { ModelClientError } from "./client/errors.ts";
import { isRecord } from "./completion.ts";
import { type Deps, depsOf, send } from "./retry.ts";

// The spend-cap check. The process that holds an OpenRouter key reads the key's limit before it spends, and refuses
// its run unless the check answers ok. The answer's shape is not verified against OpenRouter: anything this code does
// not recognize throws, and every throw refuses.

const ENDPOINT = "https://openrouter.ai/api/v1/key";

// The override of the key endpoint, PI_OPENROUTER_KEY_URL's value, which only the box's smoke test
// sets, to a fake endpoint on the box's own loopback: production never sets it. Unset or empty is
// OpenRouter's endpoint. Otherwise only plain http to the address 127.0.0.1, with a port, is
// accepted, so no value can send the key anywhere off the box. No name, localhost included: the
// host's own lookup resolves a name, and need not answer loopback. null is a value refused.
const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:\/[A-Za-z0-9._~/-]*)?$/;
export function keyEndpointOf(override: string | undefined): string | null {
  if (override === undefined || override === "") return ENDPOINT;
  const port = LOOPBACK.exec(override)?.[1];
  return port !== undefined && Number(port) <= 65_535 ? override : null;
}

export type KeyReset = "daily" | "weekly" | "monthly";
export type KeyLimit = { limitMicroUsd: number | null; remainingMicroUsd: number | null; reset: KeyReset | null };

const unreadable = (): ModelClientError => new ModelClientError("unavailable");

// Whole micro-dollars from a dollar figure, rounded by `round`: absent or null is null; anything
// but a finite number is unreadable. The figure is first rounded to a millionth of a micro-dollar,
// so binary noise never moves it by one.
const microUsdOf = (value: unknown, round: (n: number) => number): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw unreadable();
  return round(Math.round(value * 1e12) / 1e6);
};

const RESETS: ReadonlySet<unknown> = new Set(["daily", "weekly", "monthly"]);

// One GET of the key endpoint with the key, the client's deadline and retries, and no redirect.
// A refusal carries its status and nothing of the body, as `complete`'s does.
// `keyUrl` is the override above; one it refuses sends nothing and is unreadable.
export async function keyLimit({
  apiKey,
  fetch,
  keyUrl,
  deps,
}: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  keyUrl?: string | undefined;
  deps?: Partial<Omit<Deps, "fetch">>;
}): Promise<KeyLimit> {
  const endpoint = keyEndpointOf(keyUrl);
  if (endpoint === null) throw unreadable();
  const sent = await send(
    endpoint,
    { method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error" },
    depsOf({ ...deps, fetch }),
  );
  if (sent.kind === "timed_out") throw unreadable();
  let answer: unknown;
  try {
    answer = JSON.parse(sent.text);
  } catch {
    throw unreadable();
  }
  const data = isRecord(answer) ? answer.data : undefined;
  if (!isRecord(data)) throw unreadable();
  // The reset must be present: an absent field is a shape this code does not know.
  if (!("limit_reset" in data)) throw unreadable();
  const reset = data.limit_reset;
  if (reset !== null && !RESETS.has(reset)) throw unreadable();
  // The limit is rounded up and the room left down: neither rounds toward letting a run start.
  const limitMicroUsd = microUsdOf(data.limit, Math.ceil);
  if (limitMicroUsd !== null && limitMicroUsd < 0) throw unreadable();
  const remaining = microUsdOf(data.limit_remaining, Math.floor);
  // A key spent past its limit has no room left; a count is never below zero.
  return {
    limitMicroUsd,
    remainingMicroUsd: remaining === null ? null : Math.max(0, remaining),
    reset: reset as KeyReset | null,
  };
}

export type SpendCapCode =
  | "ok"
  | "spend_cap_missing"
  | "spend_cap_too_high"
  | "spend_cap_reached"
  | "spend_cap_unknown";
export type SpendCap = { code: SpendCapCode; limitMicroUsd: number | null; remainingMicroUsd: number | null };

// What a limit allows in a month: a daily limit 31 times, a weekly one 5 times, a monthly one or
// one that never resets once.
const PER_MONTH: Record<KeyReset | "none", number> = { daily: 31, weekly: 5, monthly: 1, none: 1 };

// Only `ok` lets a run start. Every error, of the request or of the answer, is spend_cap_unknown:
// this never throws.
export async function checkSpendCap(options: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  ceilingMicroUsd: number;
  keyUrl?: string | undefined;
  deps?: Partial<Omit<Deps, "fetch">>;
}): Promise<SpendCap> {
  let limit: KeyLimit;
  try {
    limit = await keyLimit(options);
  } catch {
    return { code: "spend_cap_unknown", limitMicroUsd: null, remainingMicroUsd: null };
  }
  const { limitMicroUsd, remainingMicroUsd, reset } = limit;
  const answer = (code: SpendCapCode): SpendCap => ({ code, limitMicroUsd, remainingMicroUsd });
  if (limitMicroUsd === null) return answer("spend_cap_missing");
  if (limitMicroUsd * PER_MONTH[reset ?? "none"] > options.ceilingMicroUsd) return answer("spend_cap_too_high");
  if (remainingMicroUsd === null) return answer("spend_cap_unknown");
  if (remainingMicroUsd <= 0) return answer("spend_cap_reached");
  return answer("ok");
}

// Never the key's label or the key.
export function spendCapEvent({ code, limitMicroUsd, remainingMicroUsd }: SpendCap): PersonalLogEvent {
  const counts = {
    ...(limitMicroUsd === null ? {} : { limit_micro_usd: limitMicroUsd }),
    ...(remainingMicroUsd === null ? {} : { remaining_micro_usd: remainingMicroUsd }),
  };
  return { event: "spend_cap", code, ...(Object.keys(counts).length === 0 ? {} : { counts }) };
}
