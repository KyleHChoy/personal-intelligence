import type { HttpPort, HttpRequest, HttpResponse } from "@intelligence/contracts";

// The one place a request to Google is sent. This package logs nothing: a failure surfaces
// only as a GoogleError code.

// The only scopes the read grant requests, and the only ones a connector's credential may hold.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

// One grant per source family, each its own consent and its own refresh token.
export type GrantKind = "mail" | "send" | "drive" | "contacts";

const SEND = "https://www.googleapis.com/auth/gmail.send";
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
const USERINFO = "https://www.googleapis.com/auth/userinfo.email";
// Drive's metadata and the content of Google Docs, both read-only. Google refuses the bytes
// of every other file under these two.
const DRIVE = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];
// What a consent requests, and the same set in the forms a token answer names them. `send` is the
// one scope that touches mail and reads nothing, and the two that say which account gave it.
// `contacts` reads saved contacts and nothing else, with the same two for the account check.
const REQUESTED: Readonly<Record<GrantKind, readonly string[]>> = {
  mail: GOOGLE_SCOPES,
  send: [SEND, "openid", "email"],
  drive: DRIVE,
  contacts: [CONTACTS, "openid", "email"],
};
const GRANTED: Readonly<Record<GrantKind, readonly string[]>> = {
  mail: GOOGLE_SCOPES,
  send: [SEND, "openid", USERINFO],
  drive: DRIVE,
  contacts: ["openid", USERINFO, CONTACTS],
};

export const scopesFor = (grant: GrantKind): readonly string[] => REQUESTED[grant];
export const grantedScopesFor = (grant: GrantKind): readonly string[] => GRANTED[grant];

export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export const MAX_DOCUMENT_ANSWER_BYTES = 8 * 1024 * 1024;

// Read by both connectors; exported inside the package and not from its root.
export const MAX_PAGE_BYTES = 32 * 1024 * 1024;

// Each missing field defaults to the global fetch, a real timer, Date.now, Math.random, 30 000 ms
// and nothing. Tests inject all six. `onRateLimit` hears each rate limit a Gmail connector meets
// past the port's retries: its reason, and how long it pauses, 0 when it gives up. It is how a
// caller logs one; this package logs nothing.
export type GoogleDeps = {
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  random?(): number;
  timeoutMs?: number;
  onRateLimit?(reason: RateLimitReason, pausedMs: number): void;
};

export type TokenSource = { accessToken(): Promise<string>; invalidate(): void };

export type GoogleErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "bad_response"
  | "bad_request"
  | "bad_cursor"
  | "oauth_failed"
  | "off_allowlist"
  | "too_large"
  | "scope_mismatch"
  | "wrong_account"
  // A 400 whose ErrorInfo reason is EXPIRED_SYNC_TOKEN (the People API's): a code, never the
  // answer's text.
  | "sync_token_expired"
  | "too_many_folders";

// Why Google refused a request as a rate limit, as a fixed code of this package: the `reason`
// Google's answer names, `concurrent_requests` for its answer to too many requests at once for one
// user, and `too_many_requests` for a 429 that names no reason known here.
export type RateLimitReason =
  | "rate_limit_exceeded"
  | "user_rate_limit_exceeded"
  | "daily_limit_exceeded"
  | "quota_exceeded"
  | "concurrent_requests"
  | "too_many_requests";

// No message from Google, no URL, no token, no header value and no cause.
export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  // Set only on an error made from an HTTP answer.
  declare readonly status?: number;
  // Set only on a `rate_limited` made from an HTTP answer.
  declare readonly reason?: RateLimitReason;

  constructor(code: GoogleErrorCode, status?: number, reason?: RateLimitReason) {
    super(code);
    this.name = "GoogleError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;
// A 403 with one of these reasons is a rate limit or a spent quota, never a refusal.
const RATE_LIMIT_REASONS: Readonly<Record<string, RateLimitReason>> = {
  rateLimitExceeded: "rate_limit_exceeded",
  userRateLimitExceeded: "user_rate_limit_exceeded",
  dailyLimitExceeded: "daily_limit_exceeded",
  quotaExceeded: "quota_exceeded",
};

export function withDefaults(deps: GoogleDeps = {}): Required<GoogleDeps> {
  return {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onRateLimit: deps.onRateLimit ?? (() => {}),
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The readers every connector checks an answer's shape with: anything not of the shape is a
// `bad_response`.
export const bad = (): GoogleError => new GoogleError("bad_response");
export const text = (value: unknown): value is string => typeof value === "string" && value !== "";

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw bad();
  return value;
}

export function optionalToken(value: unknown): string | undefined {
  if (value !== undefined && !text(value)) throw bad();
  return value;
}

// Whether an error is the GoogleError with this code, and this status when one is given.
export const failed = (error: unknown, code: string, status?: number): boolean =>
  error instanceof GoogleError && error.code === code && (status === undefined || error.status === status);

// Every Google API request: a GET with no body, sent as a read, with its builder's deadline.
export const apiGet = (http: HttpPort, url: string, deps: GoogleDeps = {}): Promise<HttpResponse> =>
  http.send({ method: "GET", url, headers: {}, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, kind: "read" });

type Answer = { status: number; headers: Record<string, string>; text: string };
// An answer over the bound: its status, and nothing of it.
type TooLarge = { status: number; tooLarge: true };

// One whose Content-Length is over the bound is not read at all; any other is counted as it
// arrives, and the read stops at the bound.
async function boundedText(response: Response, most: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const over = async (): Promise<null> => {
    await reader.cancel().catch(() => {});
    return null;
  };
  if (Number(response.headers.get("content-length")) > most) return over();
  const decoder = new TextDecoder();
  let text = "";
  for (let read = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    read += value.byteLength;
    if (read > most) return over();
    text += decoder.decode(value, { stream: true });
  }
}

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

// The rate limit an answer names, by Google's error reasons, or `null` for none. Google tells
// too many requests at once from too many in a while only by its message, which is read here
// for that and kept nowhere. Any 403 that names none is a refusal.
function rateLimitOf(text: string): RateLimitReason | null {
  const parsed = parseJson(text)?.value;
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  const errors = Array.isArray(error.errors) ? error.errors.filter(isRecord) : [];
  const named = errors.map((one) => RATE_LIMIT_REASONS[String(one.reason)]).find((reason) => reason !== undefined);
  const words = [error.message, ...errors.map((one) => one.message)].filter((one) => typeof one === "string");
  if (named !== undefined && words.some((one) => /concurrent/i.test(one))) return "concurrent_requests";
  if (named !== undefined) return named;
  const details = Array.isArray(error.details) ? error.details.filter(isRecord) : [];
  return details.some((one) => one.reason === "RATE_LIMIT_EXCEEDED") ? "rate_limit_exceeded" : null;
}

// A 400 that says a sync token expired, by Google's ErrorInfo reason.
function isExpiredSyncToken(text: string): boolean {
  const error = parseJson(text)?.value;
  const details = isRecord(error) && isRecord(error.error) ? error.error.details : undefined;
  return Array.isArray(details) && details.some((one) => isRecord(one) && one.reason === "EXPIRED_SYNC_TOKEN");
}

// The answer table, for anything but a 2xx. `null` is a network error or a missed deadline.
function failureOf(answer: Answer | null): { code: GoogleErrorCode; retried: boolean; reason?: RateLimitReason } {
  if (answer === null) return { code: "unavailable", retried: true };
  const { status } = answer;
  const limit = status === 429 || status === 403 ? rateLimitOf(answer.text) : null;
  if (status === 429 || limit !== null)
    return { code: "rate_limited", retried: true, reason: limit ?? "too_many_requests" };
  if (status >= 500) return { code: "unavailable", retried: true };
  if (status === 401) return { code: "unauthorized", retried: false };
  if (status === 403) return { code: "forbidden", retried: false };
  if (status === 404 || status === 410) return { code: "not_found", retried: false };
  if (status === 400 && isExpiredSyncToken(answer.text)) return { code: "sync_token_expired", retried: false };
  return { code: "bad_response", retried: false };
}

// Retry-After as milliseconds from now: whole seconds, or an HTTP date.
function retryAfterMs(value: string, now: number): number | null {
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createGoogleHttp({
  tokens,
  deps,
  maxAnswerBytes = MAX_ANSWER_BYTES,
}: {
  tokens: TokenSource | null;
  deps?: GoogleDeps;
  maxAnswerBytes?: number;
}): HttpPort {
  const { fetch: send, sleep, now, random } = withDefaults(deps);

  // A token that cannot be had: the request is never sent, so the failure leaves with no
  // status, and no caller reads it as the API's own 403, 404 or 410.
  async function bearer(): Promise<Record<string, string>> {
    if (tokens === null) return {};
    try {
      return { Authorization: `Bearer ${await tokens.accessToken()}` };
    } catch (error) {
      throw error instanceof GoogleError ? new GoogleError(error.code) : error;
    }
  }

  // One attempt, within the request's own deadline. Whatever fetch throws is dropped here, so
  // nothing it says can reach an error.
  async function attempt(req: HttpRequest, body: string | undefined): Promise<Answer | TooLarge | null> {
    const headers = { ...req.headers, ...(await bearer()) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // A redirect is never followed: it comes back as its 3xx, which is a bad response.
      const response = await send(req.url, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });
      const text = await boundedText(response, maxAnswerBytes);
      if (text === null) return { status: response.status, tooLarge: true };
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function waitMs(answer: Answer | null, n: number): number {
    const hint = answer?.headers["retry-after"];
    const after = hint === undefined ? null : retryAfterMs(hint, now());
    return after === null ? 1000 * 2 ** (n - 1) * (0.5 + random() / 2) : Math.min(after, MAX_RETRY_AFTER_MS);
  }

  return {
    async send(req) {
      // No caller sets an auth header: the port adds the bearer token itself.
      if (req.auth !== undefined || Object.keys(req.headers).some((name) => name.toLowerCase() === "authorization"))
        throw new GoogleError("bad_request");
      const { body } = req;
      if (body !== undefined && typeof body !== "string") throw new GoogleError("bad_request");

      let refreshed = false;
      for (let attempts = 1; ; ) {
        const answer = await attempt(req, body);
        if (answer !== null && "tooLarge" in answer) throw new GoogleError("too_large", answer.status);
        if (answer !== null && answer.status >= 200 && answer.status < 300) {
          const parsed = parseJson(answer.text);
          if (parsed === null) throw new GoogleError("bad_response", answer.status);
          return { status: answer.status, headers: answer.headers, body: parsed.value };
        }
        // A read gets one new token and one more attempt, outside the backoff count. A write
        // is sent once.
        if (answer?.status === 401 && tokens !== null && req.kind === "read" && !refreshed) {
          refreshed = true;
          tokens.invalidate();
          continue;
        }
        const failure = failureOf(answer);
        if (!failure.retried || req.kind !== "read" || attempts === MAX_ATTEMPTS)
          throw new GoogleError(failure.code, answer?.status, failure.reason);
        await sleep(waitMs(answer, attempts));
        attempts += 1;
      }
    },
  };
}
