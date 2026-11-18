import { describe, expect, it } from "vitest";
import type { GoogleDeps } from "./http.ts";
import { revokeSendToken } from "./send-oauth.ts";

// Every value here is made up. The revoke endpoint is a fake fetch.

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
type Call = { url: string; init: RequestInit };

function fake(answer: { status: number; body?: string } | Error) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body ?? null, { status: answer.status });
  };
  const deps: GoogleDeps = { fetch, sleep: async () => {}, now: () => 0, random: () => 0.5, timeoutMs: 1000 };
  return { calls, deps };
}

describe("revokeSendToken", () => {
  it("makes one POST to the revoke URL with the token in its form body, is true for a 200, and false for a 400, a 500 and a network error, without throwing", async () => {
    const answers: [{ status: number; body?: string } | Error, boolean][] = [
      [{ status: 200, body: "{}" }, true],
      // Google may answer a revoke with no body: still a 200.
      [{ status: 200 }, true],
      [{ status: 400, body: '{"error":"invalid_token"}' }, false],
      [{ status: 401 }, false],
      [{ status: 302 }, false],
      [{ status: 500 }, false],
      [{ status: 503 }, false],
      [new Error("socket hang up"), false],
    ];
    for (const [answer, expected] of answers) {
      const { calls, deps } = fake(answer);
      expect(
        await revokeSendToken("fake-refresh-token/1+2", deps),
        String(answer instanceof Error ? answer.message : answer.status),
      ).toBe(expected);
      // One request, never retried, the 500 included.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(REVOKE_URL);
      expect(calls[0]?.init.method).toBe("POST");
      expect(calls[0]?.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)))).toEqual({
        token: "fake-refresh-token/1+2",
      });
    }
  });

  it("a revoke that outlasts its deadline is false", { timeout: 2000 }, async () => {
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await revokeSendToken("fake-refresh-token", { fetch: hang, timeoutMs: 5 })).toBe(false);
  });
});
