import { describe, expect, it } from "vitest";
import { canaryApi } from "./api.ts";

// A reply past its deadline on a busy box says nothing of what the store holds, so one such reply
// never makes a red row; a refusal that stays is the hop's result, and is logged by its code.
const TOKENS = { writer: "w", probe: "p", capture: "c" };
const reply = (body: unknown): Response => new Response(JSON.stringify(body));
const UNAVAILABLE = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unavailable" } };
const OK = { jsonrpc: "2.0", id: 1, result: { structuredContent: { found: true } } };

describe("canaryApi", () => {
  it("asks again after `unavailable`, and takes the answer that comes", async () => {
    let asks = 0;
    const api = canaryApi(
      "http://box",
      TOKENS,
      async () => {
        asks += 1;
        return reply(asks === 1 ? UNAVAILABLE : OK);
      },
      { pause: async () => {} },
    );
    expect(await api("probe", "search", {})).toEqual({ ok: true, value: { found: true } });
    expect(asks).toBe(2);
  });

  it("gives up after three asks, tells its code, and does not ask again after another refusal", async () => {
    const told: string[] = [];
    let asks = 0;
    const api = canaryApi(
      "http://box",
      TOKENS,
      async () => {
        asks += 1;
        return reply(UNAVAILABLE);
      },
      { pause: async () => {}, refused: (tool, code) => told.push(`${tool} ${code}`) },
    );
    expect(await api("probe", "search", {})).toEqual({ ok: false, code: "unavailable" });
    expect(asks).toBe(3);
    expect(told).toEqual(["search unavailable"]);

    asks = 0;
    const refusing = canaryApi("http://box", TOKENS, async () => {
      asks += 1;
      return reply({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "not_permitted" } });
    });
    expect(await refusing("probe", "search", {})).toEqual({ ok: false, code: "not_permitted" });
    expect(asks).toBe(1);
  });
});
