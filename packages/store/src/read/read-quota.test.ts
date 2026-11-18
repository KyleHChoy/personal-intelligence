import { type MessageId, PersonalReadTool, READ_BUDGET } from "@intelligence/contracts/personal";
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_TOOLS } from "../admin/clients/admin-quota.ts";
import { keys, log } from "../test-support/unit.ts";
import { Reader } from "./read.ts";

// read_message's work can be replaced for one test, to stand for a text tool that does not say
// how many code points it served.
const override: { found: unknown } = { found: undefined };
vi.mock("./read-messages.ts", async (original) => {
  const real = await original<typeof import("./read-messages.ts")>();
  const tool = real.READ_MESSAGE_TOOL;
  return {
    ...real,
    READ_MESSAGE_TOOL: {
      ...tool,
      work: (...args: Parameters<typeof tool.work>) =>
        override.found === undefined ? tool.work(...args) : Promise.resolve(override.found),
    },
  };
});
beforeEach(() => {
  override.found = undefined;
});

// On a fake pool, so the order of the reader's statements is checked without a database: after the token, the
// client, the tool and view check and the argument check, one call of policy.read_allowance, before any
// statement of a work function.

const CLIENT = {
  id: "cli_1",
  name: "alpha",
  compartments: ["own"],
  views: ["self", "people", "work"],
  tools: ["get_self", "read_message", "find_messages"],
};
const ALLOWANCE = "select policy.read_allowance($1)";
const MESSAGE = `msg_${"0".repeat(25)}1` as MessageId;

// A pool whose one connection answers the token's client and the given allowance, and records every statement with its
// values. Any other statement answers no row. The shared taint lock, taken before the transaction and given back after it,
// is not recorded: read.test.ts checks it.
function fakePool(answer: string) {
  const sent: { text: string; values: unknown[] }[] = [];
  const query = (text: string, values: unknown[] = []) => {
    if (/pg_advisory_(un)?lock_shared/.test(text)) return Promise.resolve({ rows: [] });
    sent.push({ text, values });
    if (/policy\.current_client\(\)/.test(text)) return Promise.resolve({ rows: [CLIENT] });
    if (text === ALLOWANCE) return Promise.resolve({ rows: [{ read_allowance: answer }] });
    return Promise.resolve({ rows: [] });
  };
  const pool = { connect: () => Promise.resolve({ query, release: () => {} }) } as unknown as pg.Pool;
  return { pool, sent };
}

describe("the reader's allowance", () => {
  it("a spent budget answers rate_limited naming its window, with the allowance, one call row and nothing else", async () => {
    const { pool, sent } = fakePool("rate_limited_day");
    const reader = new Reader({ pool, keys, log });
    expect(await reader.readMessage("pit_token", { id: MESSAGE })).toEqual({
      ok: false,
      code: "rate_limited",
      refusal: "rate_limited_day",
    });
    // The call row is written with why, the window.
    expect(sent.map((one) => one.text).slice(3)).toEqual([
      ALLOWANCE,
      "select policy.log_call($1, $2, $3, $4::text, $5::text)",
      "COMMIT",
    ]);
    expect(sent[3]?.values).toEqual(["text"]);
    expect(sent[4]?.values).toEqual(["read_message", 0, "rate_limited", "rate_limited_day", null]);
    const list = fakePool("rate_limited_minute");
    expect(await new Reader({ pool: list.pool, keys, log }).findMessages("pit_token", {})).toEqual({
      ok: false,
      code: "rate_limited",
      refusal: "rate_limited_minute",
    });
    expect(list.sent[3]).toEqual({ text: ALLOWANCE, values: ["list"] });
    expect(list.sent[4]?.values).toEqual(["find_messages", 0, "rate_limited", "rate_limited_minute", null]);
  });

  it("with budget left the work runs after the allowance, and a text tool logs its code points", async () => {
    const { pool, sent } = fakePool("ok");
    const reader = new Reader({ pool, keys, log });
    // The fake holds no message: not_found, after the allowance and the message's query.
    expect(await reader.readMessage("pit_token", { id: MESSAGE })).toEqual({ ok: false, code: "not_found" });
    const texts = sent.map((one) => one.text);
    expect(texts[3]).toBe(ALLOWANCE);
    expect(texts[4]).toMatch(/from knowledge\.messages/);
    expect(texts.at(-2)).toBe("select policy.log_call($1, $2, $3)");
  });

  it("a refusal by the tool and view check or the argument check asks no allowance", async () => {
    const { pool, sent } = fakePool("ok");
    const reader = new Reader({ pool, keys, log });
    expect(await reader.readMessage("pit_token", { id: "msg_bad" as MessageId })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.search("pit_token", { query: "x" })).toEqual({ ok: false, code: "not_permitted" });
    expect(sent.map((one) => one.text)).not.toContain(ALLOWANCE);
  });

  it("a text tool's answer that does not say its code points fails closed", async () => {
    const value = { id: MESSAGE };
    const read = { bound: [], shown: [], factKeyFps: [] };
    override.found = { value, rows: 1, read };
    const { pool, sent } = fakePool("ok");
    expect(await new Reader({ pool, keys, log }).readMessage("pit_token", { id: MESSAGE })).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(sent.map((one) => one.text).at(-1)).toBe("ROLLBACK");
    // The control: the same answer with its code points is served, and logged with them.
    override.found = { value, rows: 1, read, chars: 7 };
    const control = fakePool("ok");
    expect(await new Reader({ pool: control.pool, keys, log }).readMessage("pit_token", { id: MESSAGE })).toEqual({
      ok: true,
      value,
    });
    expect(control.sent.find((one) => one.text === "select policy.log_call($1, $2, $3, $4)")?.values).toEqual([
      "read_message",
      1,
      "ok",
      7,
    ]);
  });

  it("the text tools Admin.usage counts by are READ_BUDGET's, and the text tools added after it", () => {
    const onMain = new Set<string>(PersonalReadTool.options);
    expect(TEXT_TOOLS.filter((tool) => onMain.has(tool)).sort()).toEqual(
      PersonalReadTool.options.filter((tool) => READ_BUDGET[tool] === "text").sort(),
    );
    expect(TEXT_TOOLS.filter((tool) => !onMain.has(tool)).sort()).toEqual([]);
  });

  it("an allowance answer that is neither ok nor a refusal is unavailable", async () => {
    const { pool, sent } = fakePool("maybe");
    expect(await new Reader({ pool, keys, log }).readMessage("pit_token", { id: MESSAGE })).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(sent.map((one) => one.text).at(-1)).toBe("ROLLBACK");
  });
});
