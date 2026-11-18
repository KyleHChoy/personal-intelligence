import { spawn } from "node:child_process";
import { PersonalToolError, type ReadOutcome } from "@intelligence/contracts/personal";
import { refusal } from "../env.ts";

// The memory adapter's client of the agent API: it
// starts the bridge the configuration names, with no shell, and speaks newline-delimited JSON-RPC
// on its stdin and stdout, one request at a time. It holds no token: the box picks one by the
// Unix user that started pi-mcp. The child's stderr goes where the adapter's goes and is never
// read into any output. A line that is not a reply, a reply over 1 MiB, the child's exit and a
// timeout each end the run with bridge_failed.

export type AgentApiClient = {
  call(name: string, args: unknown): Promise<ReadOutcome<unknown>>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
};

const MAX_REPLY_BYTES = 1024 * 1024;
const REPLY_MS = 60_000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The parent's environment less every PI_ variable: the bridge's ssh needs the owner's own
// settings, and nothing of pi's.
const childEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_")));

export async function startAgentApi(
  argv: readonly string[],
  options: { replyMs?: number } = {},
): Promise<AgentApiClient> {
  const [file, ...args] = argv;
  if (file === undefined) throw refusal("bridge_failed");
  const replyMs = options.replyMs ?? REPLY_MS;
  const child = spawn(file, args, { env: childEnv(), stdio: ["pipe", "pipe", "inherit"], shell: false });

  let ended = false;
  let nextId = 1;
  let pending: { id: number; settle: (reply: Json | null) => void; timer: NodeJS.Timeout } | undefined;
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;

  // Ends the client: the request in flight and every later one fail.
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
      current.settle(null);
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
    if (
      current === undefined ||
      !isRecord(message) ||
      message.jsonrpc !== "2.0" ||
      message.id !== current.id ||
      !("result" in message || "error" in message)
    ) {
      end();
      return;
    }
    pending = undefined;
    clearTimeout(current.timer);
    current.settle(message);
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

  const request = async (method: string, params: Json): Promise<Json> => {
    if (ended || pending !== undefined) throw refusal("bridge_failed");
    const id = nextId++;
    const reply = await new Promise<Json | null>((settle) => {
      pending = { id, settle, timer: setTimeout(end, replyMs) };
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    if (reply === null) throw refusal("bridge_failed");
    return reply;
  };

  const close = async (): Promise<void> => {
    if (!ended) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      const timer = setTimeout(end, 5_000);
      await exited;
      clearTimeout(timer);
    }
    end();
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-adapter", version: "0" },
    });
    if (!("result" in init)) throw refusal("bridge_failed");
  } catch (error) {
    end();
    throw error;
  }

  return {
    async tools() {
      // A program sharing an agent's token asks for the program tools too.
      const reply = await request("tools/list", { programs: true });
      const tools = isRecord(reply.result) ? reply.result.tools : undefined;
      if (!Array.isArray(tools)) throw refusal("bridge_failed");
      return tools
        .filter((tool): tool is Json => isRecord(tool) && typeof tool.name === "string")
        .map((tool) => tool.name as string);
    },
    async call(name, args) {
      const reply = await request("tools/call", { name, arguments: args });
      if ("error" in reply) {
        const error = reply.error;
        return { ok: false, code: isRecord(error) && error.code === -32001 ? "unauthorized" : "unavailable" };
      }
      const result = reply.result;
      if (!isRecord(result)) throw refusal("bridge_failed");
      if (result.isError === true) {
        const content = Array.isArray(result.content) ? result.content[0] : undefined;
        const code = PersonalToolError.safeParse(isRecord(content) ? content.text : undefined);
        return { ok: false, code: code.success ? code.data : "unavailable" };
      }
      if (!("structuredContent" in result)) throw refusal("bridge_failed");
      return { ok: true, value: result.structuredContent };
    },
    close,
  };
}
