import { spawn } from "node:child_process";
import { ClaimRefusal, CodedError, PersonalToolError } from "@intelligence/contracts/personal";
import type { Env } from "./env.ts";
import type { AgentApi } from "./ports.ts";

// The client of the agent API. It starts pi mcp as a child and speaks JSON-RPC to it, one request
// and one reply per line, one request at a time. It holds no token and passes none: whatever starts
// pi mcp on the other side supplies it. The child's environment is PATH and nothing else.

// A refusal's fixed code, from the JSON of a refused tool result's second text, when it names one.
function refusalOf(content: unknown): { refusal?: ClaimRefusal } {
  const second = Array.isArray(content) ? content[1] : undefined;
  if (!isRecord(second) || typeof second.text !== "string") return {};
  try {
    const details: unknown = JSON.parse(second.text);
    const refusal = ClaimRefusal.safeParse(isRecord(details) ? details.refusal : undefined);
    return refusal.success ? { refusal: refusal.data } : {};
  } catch {
    return {};
  }
}

// The agent API runs as its own user, pimcp, whose sudo rule for the reasoner user is this line.
const DEFAULT_AGENT_API_COMMAND = Object.freeze(["/usr/bin/sudo", "-n", "-u", "pimcp", "/usr/local/bin/pi-mcp"]);

// PI_AGENT_API_COMMAND split on spaces, run with no shell. Only tests set it.
export function agentApiCommand(env: Env): string[] {
  const words = (env.PI_AGENT_API_COMMAND ?? "").split(" ").filter((word) => word !== "");
  return words.length === 0 ? [...DEFAULT_AGENT_API_COMMAND] : words;
}

const MAX_REPLY_BYTES = 4 * 1024 * 1024;
// A tool reply's deadline: generous, so a slow read is not cut short while planner runs are tuned.
const REPLY_MS = 600_000;
const CLOSE_MS = 5_000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Answer = { result: unknown } | { error: "unauthorized" | "unavailable" };

export async function startAgentApi(
  command: readonly string[],
  options: { path: string; replyMs?: number; closeMs?: number },
): Promise<AgentApi> {
  const [file, ...args] = command;
  if (file === undefined) throw new CodedError("unavailable");
  const replyMs = options.replyMs ?? REPLY_MS;
  const closeMs = options.closeMs ?? CLOSE_MS;
  const child = spawn(file, args, { env: { PATH: options.path }, stdio: ["pipe", "pipe", "inherit"], shell: false });

  let ended = false;
  let nextId = 1;
  let pending: { id: number; settle: (answer: Answer) => void; timer: NodeJS.Timeout } | undefined;
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  // On exit, not close: a process the child started (pi-mcp under sudo) may hold the pipes open
  // after the child is gone.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  // Ends the client: the call in flight and every later one answer unavailable. The pipes are
  // destroyed too, so nothing another process holds open keeps this process alive.
  const end = (): void => {
    if (!ended) {
      ended = true;
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
    }
    const current = pending;
    pending = undefined;
    if (current !== undefined) {
      clearTimeout(current.timer);
      current.settle({ error: "unavailable" });
    }
  };
  child.once("error", end);
  child.once("exit", end);
  child.stdin.on("error", end);

  const onLine = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      end();
      return;
    }
    const current = pending;
    if (current === undefined || !isRecord(message) || message.id !== current.id) {
      end();
      return;
    }
    pending = undefined;
    clearTimeout(current.timer);
    if ("result" in message) {
      current.settle({ result: message.result });
      return;
    }
    const error = message.error;
    current.settle({ error: isRecord(error) && error.code === -32001 ? "unauthorized" : "unavailable" });
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (ended) return;
    let start = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, start)) {
      if (bufferedBytes + at - start > MAX_REPLY_BYTES) return end();
      const line = Buffer.concat([...buffered, chunk.subarray(start, at)]).toString("utf8");
      buffered = [];
      bufferedBytes = 0;
      start = at + 1;
      if (line.trim() !== "") onLine(line);
      if (ended) return;
    }
    const rest = chunk.subarray(start);
    bufferedBytes += rest.length;
    if (bufferedBytes > MAX_REPLY_BYTES) return end();
    if (rest.length > 0) buffered.push(rest);
  });

  const request = (method: string, params: Json): Promise<Answer> => {
    if (ended || pending !== undefined) return Promise.resolve({ error: "unavailable" });
    const id = nextId++;
    return new Promise<Answer>((settle) => {
      pending = { id, settle, timer: setTimeout(end, replyMs) };
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const close = async (): Promise<void> => {
    if (!ended) {
      child.stdin.end();
      const timer = setTimeout(end, closeMs);
      await exited;
      clearTimeout(timer);
    }
    end();
  };

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-reasoner", version: "0" },
  });
  if ("error" in init) {
    await close();
    throw new CodedError(init.error);
  }

  return {
    async listTools() {
      const answer = await request("tools/list", {});
      if ("error" in answer) throw new CodedError(answer.error);
      const tools = isRecord(answer.result) ? answer.result.tools : undefined;
      if (!Array.isArray(tools)) throw new CodedError("unavailable");
      return tools
        .filter(
          (tool): tool is Json =>
            isRecord(tool) && typeof tool.name === "string" && typeof tool.description === "string",
        )
        .map((tool) => ({
          name: tool.name as string,
          description: tool.description as string,
          inputSchema: tool.inputSchema,
        }));
    },
    async call(name, args) {
      const answer = await request("tools/call", { name, arguments: args });
      if ("error" in answer) return { ok: false, code: answer.error };
      const result = answer.result;
      if (!isRecord(result)) return { ok: false, code: "unavailable" };
      const content = Array.isArray(result.content) ? result.content[0] : undefined;
      const text = isRecord(content) && typeof content.text === "string" ? content.text : undefined;
      if (result.isError === true) {
        const code = PersonalToolError.safeParse(text);
        return { ok: false, code: code.success ? code.data : "unavailable", ...refusalOf(result.content) };
      }
      if ("structuredContent" in result) return { ok: true, value: result.structuredContent };
      try {
        return text === undefined
          ? { ok: false, code: "unavailable" }
          : { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    },
    close,
  };
}
