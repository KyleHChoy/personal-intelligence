import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { FOLD_SETUP } from "@intelligence/personal-core/testing";
import { MCP_AT_ONCE } from "./mcp-fixtures.ts";

// The real `pi` process, for the tests that run it as the box does.

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

export type Env = Record<string, string>;
export type Run = { exit: number | null; stdout: string; stderr: string };
export type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string };
export type Reply = {
  jsonrpc: "2.0";
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

// One run of the real process, with an explicit environment: PATH and what the step needs.
export function spawnPi(argv: string[], env: Env): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
  });
}

// What a tools/call reply says: the result's data, or the error's code.
export function outcomeOf(reply: Reply): Outcome {
  if (reply.error !== undefined) return { ok: false, code: reply.error.message };
  const result = reply.result ?? {};
  if (result.isError === true) return { ok: false, code: (result.content as { text: string }[])[0]?.text ?? "" };
  return { ok: true, value: result.structuredContent as Record<string, unknown> };
}

// One `pi mcp`, given its requests at once: its exit, the replies it wrote and its stderr.
export function mcpBatch(
  env: Env,
  requests: { method: string; params?: unknown }[],
): Promise<{ exit: number | null; replies: Reply[]; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, "mcp"], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) =>
      resolve({
        exit,
        replies: stdout
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Reply),
        stderr,
      }),
    );
    // A process that refuses to start closes its input first.
    child.stdin.on("error", () => {});
    for (const [index, request] of requests.entries())
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })}\n`);
    child.stdin.end();
  });
}

// A port nothing listens on at the moment it is returned.
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The value of a successful tool call.
export function value(outcome: Outcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`the call answered ${outcome.code}`);
  return outcome.value;
}

// A running `pi mcp`: one message in on its stdin, one reply out on its stdout. With `atOnce`, the
// stand-in of mcp-fixtures.ts: the same agent API and log, with no reply deadline waits.
export type Session = {
  child: ChildProcessWithoutNullStreams;
  call(method: string, params?: unknown): Promise<Reply>;
  tool(name: string, args?: Record<string, unknown>): Promise<Outcome>;
  end(): Promise<Run>;
};
export function mcpSession(env: Env, atOnce = false): Session {
  const child = spawn(process.execPath, ["--import", FOLD_SETUP, ...(atOnce ? [MCP_AT_ONCE] : [MAIN, "mcp"])], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buffer = "";
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  // A process that ends with a call unanswered fails that call rather than hanging it.
  void closed.then(() =>
    waiting.splice(0).forEach((next) => {
      next('{"error":{"code":0,"message":"the process ended"}}');
    }),
  );
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<Reply> => {
    id += 1;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    const line = lines.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)));
    return JSON.parse(line) as Reply;
  };
  return {
    child,
    call,
    tool: async (name, args = {}) => outcomeOf(await call("tools/call", { name, arguments: args })),
    async end() {
      child.stdin.end();
      return { exit: await closed, stdout, stderr };
    },
  };
}

// A running `pi mcp` for a test that needs only its exit code at the end: its tool names, and
// `kill` to stop it with calls unanswered.
export function mcpProcess(env: Env) {
  const session = mcpSession(env);
  return {
    call: session.call,
    tool: session.tool,
    listed: async (): Promise<string[]> =>
      ((await session.call("tools/list")).result!.tools as { name: string }[]).map((one) => one.name).sort(),
    end: async (): Promise<number | null> => (await session.end()).exit,
    kill: () => session.child.kill(),
  };
}
