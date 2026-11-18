import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startAgentApi } from "./memory-api.ts";

// The adapter's client of the agent API.

const FIXTURE = join(import.meta.dirname, "..", "test-support", "memory-api.fixture.ts");
const real = (projection?: unknown) => [
  process.execPath,
  FIXTURE,
  ...(projection === undefined ? [] : [JSON.stringify(projection)]),
];

// A stand-in that misbehaves on request, chosen by its first argument.
const CHILD = String.raw`
const { createInterface } = require("node:readline");
const mode = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  if (mode === "garbage") return process.stdout.write("not json-rpc\n");
  if (mode === "exit") process.exit(0);
  if (mode === "huge") return process.stdout.write("x".repeat(1024 * 1024 + 1) + "\n");
  if (mode === "hang") return;
  const value = mode === "env" ? { names: Object.keys(process.env) } : { argv: process.argv.slice(3) };
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
});
`;
const dir = mkdtempSync(join(tmpdir(), "pi-memory-api-"));
const script = join(dir, "child.cjs");
writeFileSync(script, CHILD);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = (...args: string[]) => [process.execPath, script, ...args];

const failure = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const PROJECTION = {
  template: "active_memory@1",
  asOf: null,
  entries: [],
  corrections: [],
  remove: [`mpr_${"a".repeat(40)}`],
  truncated: false,
  inStep: false,
  hash: "1".repeat(64),
};

describe("the agent API client of the adapter", () => {
  it("a call is answered through a child that runs the real handle with a fake provider", async () => {
    const api = await startAgentApi(real(PROJECTION));
    try {
      expect(await api.tools()).toEqual(["get_self", "sync_memory"]);
      expect(await api.call("sync_memory", { have: [], canDelete: true })).toEqual({ ok: true, value: PROJECTION });
    } finally {
      await api.close();
    }
  });

  it("an error result maps to its PersonalToolError code", async () => {
    const api = await startAgentApi(real());
    try {
      expect(await api.call("sync_memory", { have: [], canDelete: true, extra: 1 })).toEqual({
        ok: false,
        code: "invalid_request",
      });
      expect(await api.call("find_facts", { type: "commitment" })).toEqual({ ok: false, code: "not_permitted" });
      // The control.
      expect((await api.call("sync_memory", { have: [], canDelete: true })).ok).toBe(true);
    } finally {
      await api.close();
    }
  });

  it("a child that prints something that is not JSON-RPC ends the run with bridge_failed", async () => {
    const api = await startAgentApi(fake("garbage"));
    expect(await failure(api.call("sync_memory", {}))).toBe("bridge_failed");
    await api.close();
    const huge = await startAgentApi(fake("huge"));
    expect(await failure(huge.call("sync_memory", {}))).toBe("bridge_failed");
    await huge.close();
  });

  it("a child that exits early ends the run with bridge_failed", async () => {
    const api = await startAgentApi(fake("exit"));
    expect(await failure(api.call("sync_memory", {}))).toBe("bridge_failed");
    await api.close();
    // One that is not there at all, and one that never answers.
    expect(await failure(startAgentApi([join(dir, "no-such-program")]))).toBe("bridge_failed");
    const hung = await startAgentApi(fake("hang"), { replyMs: 200 });
    expect(await failure(hung.call("sync_memory", {}))).toBe("bridge_failed");
    await hung.close();
  });

  it("the child's environment holds no variable whose name starts PI_", async () => {
    process.env.PI_CLIENT_TOKEN = "tok-synthetic";
    process.env.PI_DATABASE_URL_READER = "postgres://synthetic";
    process.env.PI_ADAPTER_CONFIG = "/synthetic";
    try {
      const api = await startAgentApi(fake("env"));
      const answer = (await api.call("env", {})) as { ok: true; value: { names: string[] } };
      await api.close();
      expect(answer.value.names.filter((name) => name.startsWith("PI_"))).toEqual([]);
      // The control: the rest of the environment is passed on, for the bridge's ssh.
      expect(answer.value.names).toContain("PATH");
    } finally {
      delete process.env.PI_CLIENT_TOKEN;
      delete process.env.PI_DATABASE_URL_READER;
      delete process.env.PI_ADAPTER_CONFIG;
    }
  });

  it("the argument list is run with no shell", async () => {
    const api = await startAgentApi(fake("argv", "a; touch /tmp/pi-should-not-exist", "$(whoami)"));
    expect(await api.call("argv", {})).toEqual({
      ok: true,
      value: { argv: ["a; touch /tmp/pi-should-not-exist", "$(whoami)"] },
    });
    await api.close();
  });
});
