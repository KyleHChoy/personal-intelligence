import { ModelClientError } from "./client/errors.ts";
import type { Pseudonymiser } from "./pseudonymise.ts";

// How one request is sent: a deadline for each attempt, at most three attempts on a transport
// failure or a 408, 429 or 5xx, and no retry of a timed-out attempt or of a refusal. Every attempt
// sends the same body. Every vendor request of this package leaves here, so a pseudonymiser given
// here covers each client: the body is pseudonymised once before the first attempt, and an answer's
// text is restored before any client reads it.

const ATTEMPT_MS = 60_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000];
const JITTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

export type Deps = {
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  pseudonymiser?: Pseudonymiser;
};
// The real clock, network and dice, but for what a test gives, and the caller's pseudonymiser.
export const depsOf = (given: Partial<Deps> | undefined): Deps => ({
  fetch: given?.fetch ?? fetch,
  now: given?.now ?? (() => new Date()),
  sleep: given?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  random: given?.random ?? Math.random,
  ...(given?.pseudonymiser === undefined ? {} : { pseudonymiser: given.pseudonymiser }),
});

// The answer's body as text, or a timed-out attempt the vendor may have billed.
export type Sent = { kind: "answer"; text: string } | { kind: "timed_out" };

// A refusal or outage the vendor answered with a status. The status is a fixed code, such as
// http_404, so a caller can name what failed; the body is never read into it.
export class HttpStatusError extends ModelClientError {
  readonly status: `http_${number}`;
  constructor(code: "refused" | "unavailable", status: number) {
    super(code);
    this.status = `http_${status}`;
  }
}

const retried = (status: number): boolean => status === 408 || status === 429 || status >= 500;

const redirected = (error: unknown): boolean =>
  error instanceof TypeError && error.cause instanceof Error && error.cause.message === "unexpected redirect";

// The wait the answer asks for, in milliseconds, as seconds or as a date; undefined for none.
const retryAfter = (header: string | null, now: Date): number | undefined => {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
};

// `attemptMs` is the deadline of each attempt: 60 seconds unless the caller's spec names another.
export async function send(url: string, given: RequestInit, deps: Deps, attemptMs = ATTEMPT_MS): Promise<Sent> {
  const { pseudonymiser } = deps;
  const init =
    pseudonymiser !== undefined && typeof given.body === "string"
      ? { ...given, body: await pseudonymiser.outgoing(given.body) }
      : given;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(attemptMs) });
      if (response.ok) {
        const text = await response.text();
        return { kind: "answer", text: pseudonymiser === undefined ? text : pseudonymiser.incoming(text) };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return { kind: "timed_out" };
      // A body that failed after its status came, or a redirect, is not sent again: the vendor
      // answered. Node's fetch names a redirect under `redirect: "error"` only in its cause.
      if (response !== undefined || redirected(error)) throw new ModelClientError("unavailable");
    }
    if (response !== undefined && !retried(response.status)) {
      throw new HttpStatusError(
        response.status >= 400 && response.status < 500 ? "refused" : "unavailable",
        response.status,
      );
    }
    const unavailable = () =>
      response === undefined
        ? new ModelClientError("unavailable")
        : new HttpStatusError("unavailable", response.status);
    if (attempt === ATTEMPTS) throw unavailable();
    const asked = retryAfter(response?.headers.get("retry-after") ?? null, deps.now());
    if (asked !== undefined && asked > MAX_RETRY_AFTER_MS) throw unavailable();
    await deps.sleep(asked ?? (BACKOFF_MS[attempt - 1] ?? 0) + Math.floor(deps.random() * JITTER_MS));
  }
}
