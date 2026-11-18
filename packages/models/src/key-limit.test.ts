import { PersonalLogEvent } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { ModelClientError } from "./client/errors.ts";
import { checkSpendCap, keyEndpointOf, keyLimit, spendCapEvent } from "./key-limit.ts";
import { fakeKeyEndpoint } from "./test-support/fakes.ts";
import { KEY, type Reply, scriptedFetch, thrown, timeout } from "./test-support/support.ts";

// The spend-cap check, on a fake fetch. The shape of OpenRouter's key endpoint is item 11 of the
// README's unverified list.

const ENDPOINT = "https://openrouter.ai/api/v1/key";
const DOLLAR = 1_000_000;

const keyAnswer = (data: Record<string, unknown>): Reply => ({
  body: { data: { label: "owner-named-label", usage: 1.25, is_free_tier: false, ...data } },
});
const limited = (limit: unknown, remaining: unknown, reset: unknown = null): Reply =>
  keyAnswer({ limit, limit_remaining: remaining, limit_reset: reset });

const read = (replies: readonly Reply[]) => {
  const { fetch, sent } = scriptedFetch(replies);
  const waits: number[] = [];
  const deps = {
    now: () => new Date("2026-10-05T12:00:00Z"),
    sleep: async (ms: number) => void waits.push(ms),
    random: () => 0,
  };
  return { limit: () => keyLimit({ apiKey: KEY, fetch, deps }), sent, waits, fetch, deps };
};
const code = (error: unknown): string => (error as ModelClientError).code;

describe("keyLimit", () => {
  it("keyLimit reads the limit and the room left as micro-dollars", async () => {
    expect(await read([limited(20, 12.3456789, "monthly")]).limit()).toEqual({
      limitMicroUsd: 20 * DOLLAR,
      remainingMicroUsd: 12_345_678,
      reset: "monthly",
    });
    // Rounded down, without a dollar figure's binary noise taking one away.
    expect(await read([limited(0.3, 0.1)]).limit()).toEqual({
      limitMicroUsd: 300_000,
      remainingMicroUsd: 100_000,
      reset: null,
    });
  });

  it("keyLimit rounds the limit up and the room left down, so neither rounds toward letting a run start", async () => {
    expect(await read([limited(20.0000009, 20.0000009)]).limit()).toMatchObject({
      limitMicroUsd: 20_000_001,
      remainingMicroUsd: 20_000_000,
    });
  });

  it("keyLimit answers null for an absent or null limit", async () => {
    expect(await read([limited(null, null)]).limit()).toEqual({
      limitMicroUsd: null,
      remainingMicroUsd: null,
      reset: null,
    });
    expect(await read([keyAnswer({ limit_reset: null })]).limit()).toEqual({
      limitMicroUsd: null,
      remainingMicroUsd: null,
      reset: null,
    });
  });

  it("keyLimit counts a room left below zero as none", async () => {
    expect((await read([limited(5, -0.5)]).limit()).remainingMicroUsd).toBe(0);
  });

  it("keyLimit reads limit_reset as daily, weekly, monthly or null and throws for an absent field or another word", async () => {
    for (const reset of ["daily", "weekly", "monthly", null] as const)
      expect((await read([limited(4, 4, reset)]).limit()).reset).toBe(reset);
    for (const reset of ["yearly", "Daily", "", 1, true, {}])
      expect(code(await thrown(read([limited(4, 4, reset)]).limit()))).toBe("unavailable");
    expect(code(await thrown(read([keyAnswer({ limit: 4, limit_remaining: 4 })]).limit()))).toBe("unavailable");
  });

  it("keyLimit throws for a limit or a room left that is not a number of dollars", async () => {
    for (const [limit, remaining] of [
      ["20", 1],
      [20, "1"],
      [-1, 1],
      [true, 1],
      [20, {}],
    ]) {
      expect(code(await thrown(read([limited(limit, remaining)]).limit()))).toBe("unavailable");
    }
    // JSON.parse reads 1e999 as Infinity.
    const infinite = '{"data":{"limit":1e999,"limit_remaining":1,"limit_reset":null}}';
    expect(code(await thrown(read([{ body: infinite }]).limit()))).toBe("unavailable");
  });

  it("keyLimit throws for an answer that does not parse or holds no data object", async () => {
    for (const body of [
      "not json",
      "[]",
      { limit: 20, limit_remaining: 20, limit_reset: null },
      { data: null },
      { data: [] },
    ]) {
      expect(code(await thrown(read([{ body }]).limit()))).toBe("unavailable");
    }
  });

  it("keyLimit sends one GET to the key endpoint with the key and does not follow a redirect", async () => {
    const { limit, sent } = read([limited(20, 20)]);
    await limit();
    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only?.url).toBe(ENDPOINT);
    expect(only?.init.method).toBe("GET");
    expect(only?.init.redirect).toBe("error");
    expect(only?.init.body).toBeUndefined();
    expect(new Headers(only?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(only?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keyLimit retries an outage as the client does, and a redirect is unavailable", async () => {
    const retried = read([{ status: 503 }, limited(20, 20)]);
    expect((await retried.limit()).limitMicroUsd).toBe(20 * DOLLAR);
    expect(retried.sent).toHaveLength(2);
    const redirect = Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    const moved = read([redirect, limited(20, 20)]);
    expect(code(await thrown(moved.limit()))).toBe("unavailable");
    expect(moved.sent).toHaveLength(1);
  });

  it("keyLimit carries a refusal's status and nothing of the body", async () => {
    for (const status of [401, 402, 403, 404]) {
      const error = await thrown(
        read([{ status, body: { error: { code: status, message: "secret detail owner-named-label" } } }]).limit(),
      );
      expect([code(error), (error as { status?: unknown }).status]).toEqual(["refused", `http_${status}`]);
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain("secret detail");
    }
  });

  it("keyLimit's errors and answers hold neither the key nor its label", async () => {
    const answered = await read([limited(20, 20)]).limit();
    const errors = await Promise.all(
      [read([{ status: 401 }]).limit(), read([{ body: "x" }]).limit(), read([timeout()]).limit()].map(thrown),
    );
    const text =
      JSON.stringify(answered) +
      errors.map((error) => `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`).join(" ");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("owner-named-label");
  });
});

describe("checkSpendCap", () => {
  const CEILING_20 = 20 * DOLLAR;
  const CEILING_50 = 50 * DOLLAR;
  const check = (replies: readonly Reply[], ceilingMicroUsd = CEILING_20) => {
    const { fetch, deps } = read(replies);
    return checkSpendCap({ apiKey: KEY, fetch, ceilingMicroUsd, deps });
  };

  it("a key under its ceiling with room left is ok, with the two counts", async () => {
    expect(await check([limited(15, 9.5, "monthly")])).toEqual({
      code: "ok",
      limitMicroUsd: 15 * DOLLAR,
      remainingMicroUsd: 9_500_000,
    });
    expect((await check([limited(20, 20, null)])).code).toBe("ok");
  });

  it("a key with no limit is spend_cap_missing", async () => {
    expect(await check([limited(null, null)])).toEqual({
      code: "spend_cap_missing",
      limitMicroUsd: null,
      remainingMicroUsd: null,
    });
  });

  it("a limit over the ceiling is spend_cap_too_high", async () => {
    expect((await check([limited(20.000001, 20)])).code).toBe("spend_cap_too_high");
  });

  it("a limit a fraction of a micro-dollar over the ceiling is spend_cap_too_high", async () => {
    expect((await check([limited(20.0000009, 20)])).code).toBe("spend_cap_too_high");
  });

  it("a key with no room left is spend_cap_reached", async () => {
    expect((await check([limited(20, 0)])).code).toBe("spend_cap_reached");
    expect((await check([limited(20, -1)])).code).toBe("spend_cap_reached");
  });

  it("a 4-dollar daily limit is refused spend_cap_too_high under a 20-dollar ceiling", async () => {
    expect((await check([limited(4, 4, "daily")])).code).toBe("spend_cap_too_high");
    // 31 days of 0.5 dollars is 15.5: under.
    expect((await check([limited(0.5, 0.5, "daily")])).code).toBe("ok");
  });

  it("a 9-dollar weekly limit is refused under a 20-dollar ceiling", async () => {
    expect((await check([limited(9, 9, "weekly")])).code).toBe("spend_cap_too_high");
    expect((await check([limited(4, 4, "weekly")])).code).toBe("ok");
  });

  it("a 30-dollar monthly limit passes a 50-dollar ceiling", async () => {
    expect((await check([limited(30, 30, "monthly")], CEILING_50)).code).toBe("ok");
    expect((await check([limited(30, 30, "monthly")], CEILING_20)).code).toBe("spend_cap_too_high");
  });

  it("a null room left with a limit set is spend_cap_unknown", async () => {
    expect(await check([limited(10, null)])).toEqual({
      code: "spend_cap_unknown",
      limitMicroUsd: 10 * DOLLAR,
      remainingMicroUsd: null,
    });
    expect((await check([keyAnswer({ limit: 10, limit_reset: null })])).code).toBe("spend_cap_unknown");
  });

  it("a key endpoint that times out, answers 500 or answers text that does not parse is spend_cap_unknown", async () => {
    for (const replies of [
      [timeout()],
      [{ status: 500 }],
      [{ status: 401 }],
      [{ body: "<html>" }],
      [new TypeError("fetch failed")],
      [limited(4, 4, "hourly")],
      [keyAnswer({ limit: 4, limit_remaining: 4 })],
    ] as Reply[][]) {
      expect(await check(replies)).toEqual({ code: "spend_cap_unknown", limitMicroUsd: null, remainingMicroUsd: null });
    }
  });

  it("any error at all is spend_cap_unknown, never a throw", async () => {
    const broken = (async () => {
      throw new RangeError("anything");
    }) as unknown as typeof fetch;
    expect(
      (
        await checkSpendCap({
          apiKey: KEY,
          fetch: broken,
          ceilingMicroUsd: CEILING_20,
          deps: { sleep: async () => {} },
        })
      ).code,
    ).toBe("spend_cap_unknown");
  });

  it("the fake key endpoint answers what it is given", async () => {
    const fake = fakeKeyEndpoint({ limit: 5, remaining: 2, reset: "weekly" });
    expect(await checkSpendCap({ apiKey: KEY, fetch: fake.fetch, ceilingMicroUsd: CEILING_50 })).toEqual({
      code: "ok",
      limitMicroUsd: 5 * DOLLAR,
      remainingMicroUsd: 2 * DOLLAR,
    });
    expect(fake.calls()).toBe(1);
  });
});

describe("the key endpoint's override (PI_OPENROUTER_KEY_URL, for the smoke test alone)", () => {
  const LOOPBACK = "http://127.0.0.1:8787/api/v1/key";

  it("keyEndpointOf answers OpenRouter's endpoint when the override is unset or empty", () => {
    expect(keyEndpointOf(undefined)).toBe(ENDPOINT);
    expect(keyEndpointOf("")).toBe(ENDPOINT);
  });

  it("keyEndpointOf accepts plain http on 127.0.0.1 with a port, and nothing else", () => {
    for (const url of [LOOPBACK, "http://127.0.0.1:9/key", "http://127.0.0.1:65535", "http://127.0.0.1:1/"])
      expect(keyEndpointOf(url), url).toBe(url);
    for (const url of [
      ENDPOINT,
      // A name is resolved by the host's own lookup, which need not answer loopback: refused.
      "http://localhost:8787/key",
      "http://openrouter.ai/api/v1/key",
      "https://127.0.0.1:8787/api/v1/key",
      "http://127.0.0.1/api/v1/key",
      "http://127.0.0.1:0/key",
      "http://127.0.0.1:65536/key",
      "http://127.0.0.2:8787/key",
      "http://127.1:8787/key",
      "http://[::1]:8787/key",
      "http://localhost.example:8787/key",
      "http://127.0.0.1.nip.io:8787/key",
      "http://127.0.0.1:8787@openrouter.ai/key",
      "http://user@127.0.0.1:8787/key",
      "http://127.0.0.1:8787/key?next=https://openrouter.ai",
      "http://127.0.0.1:8787/key#x",
      "http://127.0.0.1:8787/%2e%2e",
      "HTTP://127.0.0.1:8787/key",
      " http://127.0.0.1:8787/key",
      "http://127.0.0.1:8787/key\n",
    ]) {
      expect(keyEndpointOf(url), url).toBeNull();
    }
  });

  it("keyLimit sends its one GET to a loopback override, with the key", async () => {
    const { fetch, sent } = scriptedFetch([limited(20, 20)]);
    expect((await keyLimit({ apiKey: KEY, fetch, keyUrl: LOOPBACK })).limitMicroUsd).toBe(20 * DOLLAR);
    expect(sent.map((one) => one.url)).toEqual([LOOPBACK]);
    expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("keyLimit with an override that is not loopback sends nothing and throws, so the check is spend_cap_unknown", async () => {
    const { fetch, sent } = scriptedFetch([limited(20, 20)]);
    expect(code(await thrown(keyLimit({ apiKey: KEY, fetch, keyUrl: "https://elsewhere.example/key" })))).toBe(
      "unavailable",
    );
    expect(
      (await checkSpendCap({ apiKey: KEY, fetch, ceilingMicroUsd: 50 * DOLLAR, keyUrl: "http://10.0.0.1:80/key" }))
        .code,
    ).toBe("spend_cap_unknown");
    expect(sent).toEqual([]);
  });
});

describe("spendCapEvent", () => {
  it("is one log line: the code and the two counts, and nothing of the key", () => {
    const event = spendCapEvent({ code: "ok", limitMicroUsd: 20 * DOLLAR, remainingMicroUsd: 3 });
    expect(event).toEqual({
      event: "spend_cap",
      code: "ok",
      counts: { limit_micro_usd: 20 * DOLLAR, remaining_micro_usd: 3 },
    });
    expect(PersonalLogEvent.safeParse(event).success).toBe(true);
  });

  it("leaves out a count that is not known", () => {
    const event = spendCapEvent({ code: "spend_cap_missing", limitMicroUsd: null, remainingMicroUsd: null });
    expect(event).toEqual({ event: "spend_cap", code: "spend_cap_missing" });
    expect(PersonalLogEvent.safeParse(event).success).toBe(true);
  });
});
