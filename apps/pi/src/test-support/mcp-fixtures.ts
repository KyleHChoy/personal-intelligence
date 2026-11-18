import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { FOLD_SETUP } from "@intelligence/personal-core/testing";
import { serveStdio } from "@intelligence/personal-mcp";
import { createReader, createWork, journalPath, reloadingKeys } from "@intelligence/personal-store";

// For the database tests whose subject is what the agent API answers, not when it answers: the
// agent API as `pi mcp` opens it (the store's reader on the key file, read again when it changes,
// and the work built on it), served over the same newline-delimited JSON-RPC by the real
// `serveStdio` and `handle`. A wait of a reply deadline ends as soon as no call to the store is in
// flight, on a clock that stands still: a run of a hundred calls through `pi mcp` waits a minute
// or more of deadlines and nothing else. The tests of the deadlines, and those of the real
// process, keep them.

// A port whose calls are tracked in `flight` while they run.
function tracked<T extends object>(port: T, flight: Set<Promise<unknown>>): T {
  return new Proxy(port, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key, target);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const result: unknown = member.apply(target, args);
        if (!(result instanceof Promise)) return result;
        flight.add(result);
        const done = (): void => void flight.delete(result);
        result.then(done, done);
        return result;
      };
    },
  });
}

// `pi mcp`'s agent API for the client of this environment, on these streams, with no deadline
// waits. `held` is pi mcp's logger, held from a line's arrival until its reply is written
// (mcp.ts, holdLog).
type Held = { log: PersonalLogger; hold(): void; flush(): void };
export async function serveAtOnce(
  env: Record<string, string | undefined>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  held: Held,
): Promise<void> {
  const { log } = held;
  const keyFile = env.PI_KEY_FILE ?? "";
  const reader = createReader({
    url: env.PI_DATABASE_URL_READER ?? "",
    keys: await reloadingKeys(keyFile),
    log,
    journal: journalPath(keyFile),
  });
  const flight = new Set<Promise<unknown>>();
  const timing = {
    clock: () => 0,
    // Until every call in flight has ended and the turn of the event loop that takes its answer.
    sleep: async () => {
      do {
        await Promise.allSettled([...flight]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (flight.size > 0);
    },
  };
  try {
    const work = createWork({ reader, log });
    await serveStdio(
      { provider: tracked(reader, flight), work: tracked(work, flight) },
      log,
      env.PI_CLIENT_TOKEN || undefined,
      input,
      output,
      { ...timing, logs: held },
    );
  } finally {
    await reader.close();
    held.flush();
  }
}

// The same as a process of its own, for a client that starts its agent API as a child: run with
// `node`, it takes `pi mcp`'s environment and writes pi mcp's log lines to stderr. Unlike pi mcp
// it does not check its environment for other roles' URLs, nor refuse to start while the erasure
// journal is ahead of the database: the tests of those keep pi mcp.
export const MCP_AT_ONCE = fileURLToPath(new URL("./mcp-at-once.fixture.ts", import.meta.url));

// One run of the stand-in with PATH and `env`, given `stdin` whole, as a test runs `pi mcp`.
export function mcpAtOnce(
  env: Record<string, string>,
  stdin: string,
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MCP_AT_ONCE], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
