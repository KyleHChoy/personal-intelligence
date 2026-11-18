import { describe, expect, it } from "vitest";
import type { ModelClientError } from "./client/errors.ts";
import { createOpenRouterClient } from "./openrouter.ts";
import {
  client,
  KEY,
  MODEL,
  OUTPUT,
  REGISTRY,
  request,
  scriptedFetch,
  thrown,
  timeout,
} from "./test-support/support.ts";

const code = (error: unknown): string => (error as ModelClientError).code;

describe("timeouts, retries and refusals", () => {
  it("a 429 is retried and a 402 is not", async () => {
    const retried = client([{ status: 429, body: { error: { code: 429 } } }, {}]);
    expect((await retried.model.complete(request())).output).toEqual(OUTPUT);
    expect(retried.sent).toHaveLength(2);
    expect(retried.waits).toEqual([2_000]);

    const refused = client([{ status: 402, body: { error: { code: 402 } } }, {}]);
    expect(code(await thrown(refused.model.complete(request())))).toBe("refused");
    expect(refused.sent).toHaveLength(1);
    expect(refused.waits).toEqual([]);
  });

  it("408 and every 5xx are retried, and every other 4xx is refused at once", async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const { model, sent } = client([{ status }, {}]);
      expect((await model.complete(request())).output).toEqual(OUTPUT);
      expect(sent).toHaveLength(2);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const { model, sent } = client([{ status }, {}]);
      expect(code(await thrown(model.complete(request())))).toBe("refused");
      expect(sent).toHaveLength(1);
    }
  });

  it("an HTTP refusal or outage carries its status as a fixed code, and never the body", async () => {
    const status = (error: unknown): unknown => (error as { status?: unknown }).status;
    for (const one of [400, 401, 402, 404, 422]) {
      const error = await thrown(
        client([{ status: one, body: { error: { code: one, message: "secret detail" } } }]).model.complete(request()),
      );
      expect([code(error), status(error)]).toEqual(["refused", `http_${one}`]);
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain("secret detail");
    }
    // The last answer's status, when every attempt was answered with one.
    const exhausted = await thrown(
      client([{ status: 500 }, { status: 502 }, { status: 503 }]).model.complete(request()),
    );
    expect([code(exhausted), status(exhausted)]).toEqual(["unavailable", "http_503"]);
    const tooLong = await thrown(
      client([{ status: 429, headers: { "retry-after": "3600" } }]).model.complete(request()),
    );
    expect([code(tooLong), status(tooLong)]).toEqual(["unavailable", "http_429"]);
    // No status when none came.
    expect(status(await thrown(client([timeout()]).model.complete(request())))).toBeUndefined();
  });

  it("a timed-out attempt is not sent again", async () => {
    const { model, sent, waits } = client([timeout(), {}]);
    expect(code(await thrown(model.complete(request())))).toBe("unavailable");
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("every attempt has its own deadline", async () => {
    const { model, sent } = client([{ status: 500 }, {}]);
    await model.complete(request());
    const signals = sent.map((one) => one.init.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("a transport failure is tried three times and then unavailable", async () => {
    const failed = new TypeError("fetch failed");
    const { model, sent, waits } = client([failed, failed, failed, {}]);
    expect(code(await thrown(model.complete(request())))).toBe("unavailable");
    expect(sent).toHaveLength(3);
    expect(waits).toEqual([2_000, 8_000]);
    // The positive control: a transport failure and then an answer is an output.
    const recovered = client([failed, {}]);
    expect((await recovered.model.complete(request())).output).toEqual(OUTPUT);
  });

  it("the waits carry jitter", async () => {
    const { fetch } = scriptedFetch([{ status: 500 }, { status: 500 }, {}]);
    const waits: number[] = [];
    const model = createOpenRouterClient({
      apiKey: KEY,
      model: MODEL,
      registry: REGISTRY,
      onUsage: async () => {},
      deps: { fetch, sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
    });
    await model.complete(request());
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(2_000);
    expect(waits[1]).toBeGreaterThan(8_000);
  });

  it("a failed call is not sent again without the retention fields", async () => {
    const { model, sent } = client([{ status: 500 }, new TypeError("fetch failed"), {}]);
    await model.complete(request());
    expect(sent).toHaveLength(3);
    const [first, ...rest] = sent;
    for (const one of rest) {
      expect(one.body).toBe(first?.body);
      expect(one.url).toBe(first?.url);
      expect(one.init.redirect).toBe("error");
      expect(Object.fromEntries(new Headers(one.init.headers))).toEqual(
        Object.fromEntries(new Headers(first?.init.headers)),
      );
    }
    expect((JSON.parse(first?.body ?? "") as { provider: unknown }).provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
    });
  });

  it("a Retry-After over thirty seconds is not waited for", async () => {
    for (const after of ["31", "Sat, 03 Oct 2026 12:00:31 GMT"]) {
      const { model, sent, waits } = client([{ status: 429, headers: { "retry-after": after } }, {}]);
      expect(code(await thrown(model.complete(request())))).toBe("unavailable");
      expect(sent).toHaveLength(1);
      expect(waits).toEqual([]);
    }
    // The positive control: thirty seconds is waited for, in either form.
    for (const after of ["30", "Sat, 03 Oct 2026 12:00:30 GMT"]) {
      const { model, waits } = client([{ status: 429, headers: { "retry-after": after } }, {}]);
      expect((await model.complete(request())).output).toEqual(OUTPUT);
      expect(waits).toEqual([30_000]);
    }
  });

  it("a 503 with Retry-After is retried and then unavailable", async () => {
    const busy = {
      status: 503,
      headers: { "retry-after": "1" },
      body: { error: { code: 503, message: "no provider" } },
    };
    const { model, sent, waits } = client([busy, busy, busy, {}]);
    expect(code(await thrown(model.complete(request())))).toBe("unavailable");
    expect(sent).toHaveLength(3);
    expect(waits).toEqual([1_000, 1_000]);
  });
});
