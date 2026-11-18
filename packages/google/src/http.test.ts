import { inspect } from "node:util";
import type { HttpRequest } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import {
  apiGet,
  createGoogleHttp,
  GOOGLE_SCOPES,
  type GoogleDeps,
  GoogleError,
  grantedScopesFor,
  MAX_ANSWER_BYTES,
  MAX_DOCUMENT_ANSWER_BYTES,
  MAX_PAGE_BYTES,
  scopesFor,
  type TokenSource,
} from "./http.ts";

// Every value here is made up. No test reaches the network: each port gets a fake fetch.

const URL_ = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

type Answer = { status: number; body?: string | ReadableStream<Uint8Array>; headers?: Record<string, string> } | Error;
type Call = { url: string; init: RequestInit };

function fake(answers: Answer[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error("the fake has no answer left");
    if (answer instanceof Error) throw answer;
    return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers ?? {} });
  };
  const deps: GoogleDeps = {
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => Date.parse("2026-03-10T12:00:00.000Z"),
    random: () => 0.5,
    // A request's own deadline is used, never this one.
    timeoutMs: 60_000,
  };
  return { calls, sleeps, deps };
}

function fakeTokens() {
  const state = { issued: 0, invalidated: 0 };
  const tokens: TokenSource = {
    accessToken: async () => `fake-access-token-${(state.issued += 1)}`,
    invalidate: () => void (state.invalidated += 1),
  };
  return { state, tokens };
}

const read: HttpRequest = { method: "GET", url: URL_, headers: {}, timeoutMs: 1000, kind: "read" };
const write: HttpRequest = {
  method: "POST",
  url: "https://oauth2.googleapis.com/token",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=refresh_token&refresh_token=fake",
  timeoutMs: 1000,
  kind: "write",
};
const ok: Answer = { status: 200, body: '{"emailAddress":"owner@example.org"}' };
const MIB = 1024 * 1024;

// A body that shows its length only as it arrives: `total` bytes, 64 KiB to a read, counting
// what was handed over and whether the read was cancelled.
function counted(total: number) {
  const seen = { read: 0, cancelled: false };
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.read >= total) return controller.close();
        const next = chunk.subarray(0, Math.min(chunk.length, total - seen.read));
        seen.read += next.length;
        controller.enqueue(next);
      },
      cancel: () => void (seen.cancelled = true),
    },
    // Nothing is handed over before it is asked for.
    { highWaterMark: 0 },
  );
  return { body, seen };
}
const authorization = (call: Call | undefined): string | undefined =>
  (call?.init.headers as Record<string, string> | undefined)?.Authorization;

async function failure(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

describe("the Google HTTP port", () => {
  it("a 200 returns the parsed body after one call", async () => {
    const { calls, sleeps, deps } = fake([{ ...ok, headers: { "X-Fake": "1" } }]);
    const response = await createGoogleHttp({ tokens: null, deps }).send(read);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ emailAddress: "owner@example.org" });
    expect(response.headers["x-fake"]).toBe("1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(sleeps).toEqual([]);
  });

  it("the port adds the bearer token, and a port without tokens adds none", async () => {
    const withTokens = fake([ok]);
    const { tokens } = fakeTokens();
    await createGoogleHttp({ tokens, deps: withTokens.deps }).send({
      ...read,
      headers: { Accept: "application/json" },
    });
    expect(withTokens.calls[0]?.init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer fake-access-token-1",
    });

    const without = fake([ok]);
    await createGoogleHttp({ tokens: null, deps: without.deps }).send(read);
    expect(without.calls[0]?.init.headers).toEqual({});
  });

  it("a request that carries auth or its own Authorization is refused with bad_request before any call", async () => {
    const { calls, deps } = fake([ok, ok, ok, ok]);
    const { tokens } = fakeTokens();
    const http = createGoogleHttp({ tokens, deps });
    // The positive control: the same request without either is sent.
    await http.send(read);
    expect(calls).toHaveLength(1);

    for (const headers of [{ Authorization: "Bearer fake" }, { authorization: "Bearer fake" }]) {
      const error = await failure(http.send({ ...read, headers }));
      expect(error.code).toBe("bad_request");
      expect(error.status).toBeUndefined();
    }
    const auth = { kind: "job_scope" } as unknown as NonNullable<HttpRequest["auth"]>;
    expect((await failure(http.send({ ...read, auth }))).code).toBe("bad_request");
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 five times in all, waiting 1, 2, 4 and 8 s scaled by jitter, then fails rate_limited", async () => {
    const { calls, sleeps, deps } = fake(Array.from({ length: 6 }, () => ({ status: 429 })));
    const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(calls).toHaveLength(5);
    // random() is 0.5, so each wait is scaled by 0.75.
    expect(sleeps).toEqual([750, 1500, 3000, 6000]);

    const full = fake([{ status: 429 }, { status: 429 }, ok]);
    await createGoogleHttp({ tokens: null, deps: { ...full.deps, random: () => 1 } }).send(read);
    expect(full.sleeps).toEqual([1000, 2000]);
    const least = fake([{ status: 429 }, ok]);
    await createGoogleHttp({ tokens: null, deps: { ...least.deps, random: () => 0 } }).send(read);
    expect(least.sleeps).toEqual([500]);
  });

  it("honours Retry-After in seconds and as a date, capped at 60 s", async () => {
    const { calls, sleeps, deps } = fake([
      { status: 429, headers: { "Retry-After": "7" } },
      // Twenty seconds after the injected clock.
      { status: 503, headers: { "Retry-After": "Tue, 10 Mar 2026 12:00:20 GMT" } },
      { status: 429, headers: { "Retry-After": "3600" } },
      { status: 429, headers: { "Retry-After": "Wed, 11 Mar 2026 12:00:00 GMT" } },
      ok,
    ]);
    const response = await createGoogleHttp({ tokens: null, deps }).send(read);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([7000, 20_000, 60_000, 60_000]);
  });

  it("a 503 five times fails unavailable", async () => {
    const { calls, sleeps, deps } = fake(Array.from({ length: 6 }, () => ({ status: 503 })));
    const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
    expect(error.code).toBe("unavailable");
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(5);
    expect(sleeps).toHaveLength(4);
  });

  it("a timeout and a network error are retried, then fail unavailable", async () => {
    const network = fake(Array.from({ length: 6 }, () => new Error("socket hang up")));
    const refused = await failure(createGoogleHttp({ tokens: null, deps: network.deps }).send(read));
    expect(refused.code).toBe("unavailable");
    expect(refused.status).toBeUndefined();
    expect(network.calls).toHaveLength(5);

    // A fetch that answers only when its signal aborts: the deadline is the request's own 5 ms.
    let hung = 0;
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        hung += 1;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const slow = fake([]);
    const late = await failure(
      createGoogleHttp({ tokens: null, deps: { ...slow.deps, fetch: hang } }).send({ ...read, timeoutMs: 5 }),
    );
    expect(late.code).toBe("unavailable");
    expect(late.status).toBeUndefined();
    expect(hung).toBe(5);
    expect(slow.sleeps).toHaveLength(4);

    // The positive control: one network error, then an answer.
    const once = fake([new Error("socket hang up"), ok]);
    expect((await createGoogleHttp({ tokens: null, deps: once.deps }).send(read)).status).toBe(200);
    expect(once.calls).toHaveLength(2);
  });

  it("a 403 rateLimitExceeded is retried; a plain 403 fails forbidden after one call", async () => {
    const limited = (reason: string): Answer => ({
      status: 403,
      body: JSON.stringify({ error: { code: 403, errors: [{ domain: "usageLimits", reason }] } }),
    });
    // A rate limit and a quota alike: each is retried as a 429 is.
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]) {
      const retried = fake([limited(reason), ok]);
      expect((await createGoogleHttp({ tokens: null, deps: retried.deps }).send(read)).status, reason).toBe(200);
      expect(retried.calls, reason).toHaveLength(2);
      expect(retried.sleeps).toEqual([750]);

      const spent = fake(Array.from({ length: 6 }, () => limited(reason)));
      const quota = await failure(createGoogleHttp({ tokens: null, deps: spent.deps }).send(read));
      expect(quota.code, reason).toBe("rate_limited");
      expect(spent.calls, reason).toHaveLength(5);
    }

    const always = fake(Array.from({ length: 6 }, () => limited("userRateLimitExceeded")));
    const exhausted = await failure(createGoogleHttp({ tokens: null, deps: always.deps }).send(read));
    expect(exhausted.code).toBe("rate_limited");
    expect(exhausted.status).toBe(403);
    expect(always.calls).toHaveLength(5);

    for (const answer of [limited("insufficientPermissions"), { status: 403 }, { status: 403, body: "not json" }]) {
      const plain = fake([answer, ok]);
      const error = await failure(createGoogleHttp({ tokens: null, deps: plain.deps }).send(read));
      expect(error.code).toBe("forbidden");
      expect(error.status).toBe(403);
      expect(plain.calls).toHaveLength(1);
      expect(plain.sleeps).toEqual([]);
    }
  });

  it("a rate limit carries Google's reason as a fixed code, and nothing of the answer", async () => {
    const reasonOf = async (answer: Answer): Promise<GoogleError> =>
      failure(createGoogleHttp({ tokens: null, deps: fake(Array.from({ length: 5 }, () => answer)).deps }).send(read));
    const body = (status: number, error: Record<string, unknown>): Answer => ({
      status,
      body: JSON.stringify({ error: { code: status, ...error } }),
    });
    const cases: [Answer, string][] = [
      [body(403, { errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] }), "rate_limit_exceeded"],
      [body(403, { errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }] }), "user_rate_limit_exceeded"],
      [body(403, { errors: [{ domain: "usageLimits", reason: "dailyLimitExceeded" }] }), "daily_limit_exceeded"],
      [body(403, { errors: [{ domain: "usageLimits", reason: "quotaExceeded" }] }), "quota_exceeded"],
      [body(429, { errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] }), "rate_limit_exceeded"],
      // Google's answer to too many requests at once for one user: the same reason, told apart
      // by its message, which is read for this and never kept.
      [
        body(429, {
          message: "Too many concurrent requests for user.",
          errors: [{ reason: "rateLimitExceeded", message: "Too many concurrent requests for user." }],
        }),
        "concurrent_requests",
      ],
      // The newer shape: an ErrorInfo detail, with no errors list.
      [
        body(429, {
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }],
        }),
        "rate_limit_exceeded",
      ],
      // A 429 that names no reason this port knows, or carries no body at all.
      [body(429, { errors: [{ reason: "somethingNew" }] }), "too_many_requests"],
      [{ status: 429 }, "too_many_requests"],
      [{ status: 429, body: "not json" }, "too_many_requests"],
    ];
    for (const [answer, reason] of cases) {
      const error = await reasonOf(answer);
      expect([error.code, error.reason], reason).toEqual(["rate_limited", reason]);
      expect(JSON.stringify(error)).not.toContain("concurrent requests");
    }
    // Any other failure has no reason.
    expect((await reasonOf({ status: 503 })).reason).toBeUndefined();
    expect((await reasonOf({ status: 403 })).reason).toBeUndefined();
  });

  it("a 400 fails bad_response after one call", async () => {
    const { calls, sleeps, deps } = fake([{ status: 400, body: '{"error":{"message":"Invalid value"}}' }, ok]);
    const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
    expect(error.code).toBe("bad_response");
    expect(error.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("404 and 410 fail not_found with their status", async () => {
    for (const status of [404, 410]) {
      const { calls, deps } = fake([{ status }, ok]);
      const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
      expect(error.code).toBe("not_found");
      expect(error.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
    // Every error made from an answer carries that answer's status.
    const { tokens } = fakeTokens();
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [409, "bad_response"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [302, "bad_response"],
    ] as const) {
      const { deps } = fake(Array.from({ length: 6 }, () => ({ status })));
      const error = await failure(createGoogleHttp({ tokens, deps }).send(read));
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  it("refreshes once on 401, then fails unauthorized", async () => {
    const twice = fake([{ status: 401 }, { status: 401 }, ok]);
    const first = fakeTokens();
    const error = await failure(createGoogleHttp({ tokens: first.tokens, deps: twice.deps }).send(read));
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(twice.calls).toHaveLength(2);
    expect(first.state.invalidated).toBe(1);
    expect(twice.calls.map(authorization)).toEqual(["Bearer fake-access-token-1", "Bearer fake-access-token-2"]);
    expect(twice.sleeps).toEqual([]);

    // The positive control: the retry with the new token is answered.
    const once = fake([{ status: 401 }, ok]);
    const second = fakeTokens();
    expect((await createGoogleHttp({ tokens: second.tokens, deps: once.deps }).send(read)).status).toBe(200);
    expect(once.calls).toHaveLength(2);
    expect(second.state.invalidated).toBe(1);
  });

  it("the 401 retry is outside the count: a 401 then four 429s is six sends", async () => {
    const answered = fake([
      { status: 401 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
      ok,
      ok,
    ]);
    const first = fakeTokens();
    expect((await createGoogleHttp({ tokens: first.tokens, deps: answered.deps }).send(read)).status).toBe(200);
    expect(answered.calls).toHaveLength(6);
    expect(answered.sleeps).toEqual([750, 1500, 3000, 6000]);
    expect(first.state.invalidated).toBe(1);

    // Five backoff attempts after the one refresh, and no more.
    const limited = fake([{ status: 401 }, ...Array.from({ length: 6 }, () => ({ status: 429 }))]);
    const error = await failure(createGoogleHttp({ tokens: fakeTokens().tokens, deps: limited.deps }).send(read));
    expect(error.code).toBe("rate_limited");
    expect(limited.calls).toHaveLength(6);

    // A 401 in the middle of the backoff is still the one refresh.
    const late = fake([{ status: 429 }, { status: 401 }, { status: 429 }, ok]);
    expect((await createGoogleHttp({ tokens: fakeTokens().tokens, deps: late.deps }).send(read)).status).toBe(200);
    expect(late.calls).toHaveLength(4);
    expect(late.sleeps).toEqual([750, 1500]);
  });

  it("a write answered 401 is unauthorized after the one send, with tokens or without", async () => {
    const tokenWrite = { ...write, url: "https://www.googleapis.com/fake/write" };
    const withTokens = fake([{ status: 401 }, { status: 200, body: "{}" }]);
    const error = await failure(
      createGoogleHttp({ tokens: fakeTokens().tokens, deps: withTokens.deps }).send(tokenWrite),
    );
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(withTokens.calls).toHaveLength(1);

    const without = fake([{ status: 401 }, { status: 200, body: "{}" }]);
    expect((await failure(createGoogleHttp({ tokens: null, deps: without.deps }).send(tokenWrite))).code).toBe(
      "unauthorized",
    );
    expect(without.calls).toHaveLength(1);

    // The positive control: the same 401 on a read is retried once.
    const retried = fake([{ status: 401 }, ok]);
    expect((await createGoogleHttp({ tokens: fakeTokens().tokens, deps: retried.deps }).send(read)).status).toBe(200);
    expect(retried.calls).toHaveLength(2);
  });

  it("a token the port cannot get is that error with no status, and nothing is sent", async () => {
    for (const [code, status] of [
      ["forbidden", 403],
      ["not_found", 404],
      ["not_found", 410],
      ["oauth_failed", 400],
      ["unavailable", 503],
    ] as const) {
      const { calls, sleeps, deps } = fake([ok, ok]);
      const asked = { times: 0 };
      const tokens: TokenSource = {
        accessToken: async () => {
          asked.times += 1;
          throw new GoogleError(code, status);
        },
        invalidate: () => {},
      };
      const error = await failure(createGoogleHttp({ tokens, deps }).send(read));
      expect(error.code).toBe(code);
      // The request was never sent, so the error is not the API's own answer.
      expect(error.status).toBeUndefined();
      expect("status" in error).toBe(false);
      expect(calls).toHaveLength(0);
      expect(sleeps).toEqual([]);
      expect(asked.times).toBe(1);
    }

    // The same when the token asked for after a 401 cannot be had.
    const { calls, deps } = fake([{ status: 401 }, ok]);
    const asked = { times: 0 };
    const tokens: TokenSource = {
      accessToken: async () => {
        asked.times += 1;
        if (asked.times > 1) throw new GoogleError("forbidden", 403);
        return "fake-access-token-1";
      },
      invalidate: () => {},
    };
    const error = await failure(createGoogleHttp({ tokens, deps }).send(read));
    expect(error.code).toBe("forbidden");
    expect(error.status).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(asked.times).toBe(2);

    // An error that is not a GoogleError passes through as it is.
    const other = new Error("fake token source failure");
    const broken: TokenSource = { accessToken: async () => Promise.reject(other), invalidate: () => {} };
    await expect(createGoogleHttp({ tokens: broken, deps: fake([ok]).deps }).send(read)).rejects.toBe(other);
  });

  it("never follows a redirect: every request is sent with redirect manual", async () => {
    const reads = fake([{ status: 503 }, { status: 401 }, { status: 429 }, ok]);
    await createGoogleHttp({ tokens: fakeTokens().tokens, deps: reads.deps }).send(read);
    const writes = fake([{ status: 200, body: "{}" }]);
    await createGoogleHttp({ tokens: null, deps: writes.deps }).send(write);
    const sent = [...reads.calls, ...writes.calls];
    expect(sent).toHaveLength(5);
    for (const call of sent) expect(call.init.redirect).toBe("manual");
  });

  it("a port without tokens never refreshes", async () => {
    const { calls, sleeps, deps } = fake([{ status: 401 }, ok]);
    const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a body that is not JSON fails bad_response", async () => {
    for (const body of ["<html>busy</html>", ""]) {
      const { calls, deps } = fake([{ status: 200, body }, ok]);
      const error = await failure(createGoogleHttp({ tokens: null, deps }).send(read));
      expect(error.code).toBe("bad_response");
      expect(error.status).toBe(200);
      expect(calls).toHaveLength(1);
    }
  });

  it("an answer over the bound is not read to its end and fails too_large", async () => {
    expect(MAX_ANSWER_BYTES).toBe(4 * MIB);

    // By Content-Length: nothing of the body is read.
    const stated = counted(8 * MIB);
    const byLength = fake([
      { status: 200, body: stated.body, headers: { "Content-Length": String(MAX_ANSWER_BYTES + 1) } },
      ok,
    ]);
    const first = await failure(createGoogleHttp({ tokens: null, deps: byLength.deps }).send(read));
    expect(first.code).toBe("too_large");
    expect(stated.seen).toEqual({ read: 0, cancelled: true });
    expect(byLength.calls).toHaveLength(1);
    expect(byLength.sleeps).toEqual([]);

    // By a body that only shows its length as it arrives: the read stops at the bound.
    const arriving = counted(8 * MIB);
    const byCount = fake([{ status: 200, body: arriving.body }, ok]);
    const second = await failure(createGoogleHttp({ tokens: null, deps: byCount.deps }).send(read));
    expect(second.code).toBe("too_large");
    expect(arriving.seen).toEqual({ read: MAX_ANSWER_BYTES + 64 * 1024, cancelled: true });
    expect(byCount.calls).toHaveLength(1);
    expect(byCount.sleeps).toEqual([]);

    // A Content-Length under the bound is not taken on trust: the body is still counted.
    const lying = counted(8 * MIB);
    const understated = fake([{ status: 200, body: lying.body, headers: { "Content-Length": "2" } }, ok]);
    expect((await failure(createGoogleHttp({ tokens: null, deps: understated.deps }).send(read))).code).toBe(
      "too_large",
    );
    expect(lying.seen.read).toBeLessThan(8 * MIB);
    expect(lying.seen.cancelled).toBe(true);

    // One byte over is over, as a body JSON would parse.
    const over = fake([{ status: 200, body: `"${"a".repeat(MAX_ANSWER_BYTES - 1)}"` }, ok]);
    expect((await failure(createGoogleHttp({ tokens: null, deps: over.deps }).send(read))).code).toBe("too_large");
    expect(over.calls).toHaveLength(1);
  });

  it("an answer of exactly the bound is read", async () => {
    const text = "a".repeat(MAX_ANSWER_BYTES - 2);
    for (const headers of [{}, { "Content-Length": String(MAX_ANSWER_BYTES) }]) {
      const { calls, deps } = fake([{ status: 200, body: `"${text}"`, headers }]);
      const response = await createGoogleHttp({ tokens: null, deps }).send(read);
      expect(response.status).toBe(200);
      expect(response.body === text).toBe(true);
      expect(calls).toHaveLength(1);
    }

    // The bound counts bytes, not characters: 2 MiB of two-byte letters is under it, whole.
    const letters = "é".repeat(MAX_ANSWER_BYTES / 2 - 1);
    const wide = fake([{ status: 200, body: `"${letters}"` }]);
    expect((await createGoogleHttp({ tokens: null, deps: wide.deps }).send(read)).body === letters).toBe(true);

    // A letter that arrives in two pieces is still one letter.
    const bytes = new TextEncoder().encode('{"name":"é"}');
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10));
        controller.close();
      },
    });
    const halves = fake([{ status: 200, body: split }]);
    expect((await createGoogleHttp({ tokens: null, deps: halves.deps }).send(read)).body).toEqual({ name: "é" });
  });

  it("too_large carries its status and nothing of the answer", async () => {
    const holds = (error: GoogleError): string =>
      [
        error.message,
        error.stack ?? "",
        String(error.cause),
        JSON.stringify(error),
        inspect(error, { depth: 5, showHidden: true }),
      ].join("\n");
    const large = (words: string): string =>
      JSON.stringify({
        error: { message: words, errors: [{ reason: "rateLimitExceeded" }] },
        filler: "a".repeat(MAX_ANSWER_BYTES),
      });

    // Any status: one a read would retry, one that would get a new token, and a 2xx alike are
    // final after one call, and nothing of the answer is parsed.
    for (const status of [200, 401, 403, 404, 429, 503]) {
      const { calls, sleeps, deps } = fake([
        { status, body: large("fake-words-of-the-answer"), headers: { "X-Fake": "fake-header-value" } },
        ok,
        ok,
      ]);
      const { state, tokens } = fakeTokens();
      const error = await failure(createGoogleHttp({ tokens, deps }).send(read));
      expect(error.code, String(status)).toBe("too_large");
      expect(error.status).toBe(status);
      expect(calls, String(status)).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(state.invalidated).toBe(0);
      expect(error.cause).toBeUndefined();
      for (const word of ["fake-words-of-the-answer", "fake-header-value", "fake-access-token", "googleapis", "aaaa"])
        expect(holds(error)).not.toContain(word);
      expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "GoogleError", code: "too_large", status });
    }

    // A write too.
    const written = fake([{ status: 200, body: large("fake") }]);
    const error = await failure(createGoogleHttp({ tokens: null, deps: written.deps }).send(write));
    expect([error.code, error.status]).toEqual(["too_large", 200]);

    // The positive control: the same 403 under the bound is read, and retried as a rate limit.
    const small = fake([
      { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }) },
      ok,
    ]);
    expect((await createGoogleHttp({ tokens: null, deps: small.deps }).send(read)).status).toBe(200);
    expect(small.calls).toHaveLength(2);
  });

  it("an error holds no URL or token", async () => {
    const secretUrl = `${URL_}?pageToken=fake-page-token`;
    const holds = (error: GoogleError): string =>
      [
        error.message,
        error.stack ?? "",
        String(error.cause),
        JSON.stringify(error),
        inspect(error, { depth: 5, showHidden: true }),
      ].join("\n");
    const { tokens } = fakeTokens();

    const thrown = fake(
      Array.from(
        { length: 5 },
        () =>
          new Error(`request to ${secretUrl} failed with Bearer fake-access-token-1`, { cause: new Error(secretUrl) }),
      ),
    );
    const network = await failure(createGoogleHttp({ tokens, deps: thrown.deps }).send({ ...read, url: secretUrl }));
    expect(network.code).toBe("unavailable");
    expect(network.cause).toBeUndefined();
    expect(holds(network)).not.toContain("fake-page-token");
    expect(holds(network)).not.toContain("fake-access-token");
    expect(holds(network)).not.toContain("googleapis");
    expect(JSON.parse(JSON.stringify(network))).toEqual({ name: "GoogleError", code: "unavailable" });

    // An answer's own words are not carried either.
    const answered = fake([
      {
        status: 403,
        body: `{"error":{"message":"Denied for ${secretUrl} with fake-access-token-1"}}`,
        headers: { "X-Fake": "fake-header-value" },
      },
    ]);
    const forbidden = await failure(
      createGoogleHttp({ tokens, deps: answered.deps }).send({ ...read, url: secretUrl }),
    );
    expect(forbidden.code).toBe("forbidden");
    expect(forbidden.cause).toBeUndefined();
    for (const word of ["fake-page-token", "fake-access-token", "googleapis", "Denied", "fake-header-value"])
      expect(holds(forbidden)).not.toContain(word);
    expect(JSON.parse(JSON.stringify(forbidden))).toEqual({ name: "GoogleError", code: "forbidden", status: 403 });
  });

  it("a write is sent once with its string body unchanged, whatever the answer", async () => {
    const sent = fake([{ status: 200, body: '{"access_token":"fake"}' }]);
    await createGoogleHttp({ tokens: null, deps: sent.deps }).send(write);
    expect(sent.calls[0]?.init.method).toBe("POST");
    expect(sent.calls[0]?.init.body).toBe("grant_type=refresh_token&refresh_token=fake");
    expect(sent.calls[0]?.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });

    for (const [answer, code] of [
      [{ status: 429 }, "rate_limited"],
      [{ status: 503 }, "unavailable"],
      [new Error("socket hang up"), "unavailable"],
    ] as const) {
      const { calls, sleeps, deps } = fake([answer, { status: 200, body: "{}" }]);
      expect((await failure(createGoogleHttp({ tokens: null, deps }).send(write))).code).toBe(code);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }

    const { calls, deps } = fake([{ status: 200, body: "{}" }]);
    expect(
      (
        await failure(
          createGoogleHttp({ tokens: null, deps }).send({ ...write, body: { grant_type: "refresh_token" } }),
        )
      ).code,
    ).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });

  it("an API read is a GET with no body, kind read and the timeout from deps", async () => {
    const seen: HttpRequest[] = [];
    const http = {
      send: async (req: HttpRequest) => {
        seen.push(req);
        return { status: 200, headers: {}, body: {} };
      },
    };
    await apiGet(http, URL_, { timeoutMs: 1234 });
    await apiGet(http, URL_);
    expect(seen).toEqual([
      { method: "GET", url: URL_, headers: {}, timeoutMs: 1234, kind: "read" },
      { method: "GET", url: URL_, headers: {}, timeoutMs: 30_000, kind: "read" },
    ]);
  });

  it("a port built with a bound reads an answer up to it and fails too_large past it", async () => {
    expect(MAX_DOCUMENT_ANSWER_BYTES).toBe(8 * MIB);
    expect(MAX_PAGE_BYTES).toBe(32 * MIB);
    // An answer over the default bound and under the document bound is read whole.
    const body = `"${"a".repeat(6 * MIB)}"`;
    const wide = fake([{ status: 200, body }]);
    const read6 = await createGoogleHttp({
      tokens: null,
      deps: wide.deps,
      maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES,
    }).send(read);
    expect((read6.body as string).length).toBe(6 * MIB);
    // The control: the default port refuses the same answer.
    const narrow = fake([{ status: 200, body }]);
    expect((await failure(createGoogleHttp({ tokens: null, deps: narrow.deps }).send(read))).code).toBe("too_large");
    // Past the document bound, by count and by Content-Length.
    const arriving = counted(12 * MIB);
    const over = fake([{ status: 200, body: arriving.body }]);
    expect(
      (
        await failure(
          createGoogleHttp({ tokens: null, deps: over.deps, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES }).send(read),
        )
      ).code,
    ).toBe("too_large");
    expect(arriving.seen).toEqual({ read: MAX_DOCUMENT_ANSWER_BYTES + 64 * 1024, cancelled: true });
    const stated = fake([
      { status: 200, body: "{}", headers: { "Content-Length": String(MAX_DOCUMENT_ANSWER_BYTES + 1) } },
    ]);
    expect(
      (
        await failure(
          createGoogleHttp({ tokens: null, deps: stated.deps, maxAnswerBytes: MAX_DOCUMENT_ANSWER_BYTES }).send(read),
        )
      ).code,
    ).toBe("too_large");
  });

  it("scopesFor('drive') and grantedScopesFor('drive') are the two read-only Drive scopes", () => {
    const drive = [
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ];
    expect(scopesFor("drive")).toEqual(drive);
    expect(grantedScopesFor("drive")).toEqual(drive);
  });

  it("the scopes are the two read-only ones", () => {
    expect(GOOGLE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ]);
  });

  it("scopesFor('mail') equals GOOGLE_SCOPES, and grantedScopesFor('send') is gmail.send, openid and userinfo.email", () => {
    expect(scopesFor("mail")).toEqual(GOOGLE_SCOPES);
    expect(grantedScopesFor("mail")).toEqual(GOOGLE_SCOPES);
    expect(scopesFor("send")).toEqual(["https://www.googleapis.com/auth/gmail.send", "openid", "email"]);
    expect(grantedScopesFor("send")).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });
});
