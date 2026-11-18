import type { PersonalLogger, PersonalReads, PersonalWork, PersonalWrites } from "@intelligence/contracts/personal";
import {
  ClientView,
  type CompactReadTool,
  compactResult,
  methodOf,
  PersonalLogEvent,
  type PersonalTool,
  READ_TOOL_WIRE,
  toolView,
  WORK_TOOL_WIRE,
  WRITE_TOOL_WIRE,
} from "@intelligence/contracts/personal";
import type { HandleOptions } from "../handle.ts";
import { handle } from "../handle.ts";
import { serveStdio } from "../stdio.ts";

// For this package's tests only: a local fake provider and logger. Hand-written fixtures,
// reserved domains only, and ids that are valid but mean nothing.

export const TOKEN = "sentinel-token-7f3a91";
export const ulid = (n: number): string => String(n).padStart(26, "0");

// A description without the worked examples that end it (examples.ts).
export const proseOf = (description: string): string => description.split(" Examples (")[0] ?? description;

// Each JSON object in a text, outermost only: a description's worked examples.
export function jsonIn(text: string): unknown[] {
  const found: unknown[] = [];
  for (let at = text.indexOf('{"'); at >= 0; at = text.indexOf('{"', at)) {
    let depth = 0;
    let quoted = false;
    let end = at;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (c === "\\" && quoted) end += 1;
      else if (c === '"') quoted = !quoted;
      else if (!quoted && c === "{") depth += 1;
      else if (!quoted && c === "}" && --depth === 0) break;
    }
    found.push(JSON.parse(text.slice(at, end + 1)));
    at = end + 1;
  }
  return found;
}

// An example with its placeholders filled: each id a different valid one, `<new>` a new requestId.
let filled = 100;
export const fillExample = (example: unknown): unknown =>
  JSON.parse(
    JSON.stringify(example)
      .replace(/"([a-z]{3})_\.\.\."/g, (_all, prefix: string) => `"${prefix}_${ulid((filled += 1))}"`)
      .replaceAll("<new>", () => `example-${(filled += 1)}`),
  );

export const clientView = (
  over: { tools?: string[]; views?: string[]; name?: string; compartments?: string[] } = {},
): ClientView =>
  ClientView.parse({
    id: `cli_${ulid(1)}`,
    name: "test-client",
    compartments: ["own"],
    views: ["self", "people"],
    tools: [],
    ...over,
  });

export type Provider = PersonalReads & PersonalWrites;
export type Call = { method: string; args: unknown[] };

// A call's arguments as recorded: the options the agent API hands every port call (its signal)
// are left out, so a test names the arguments that matter.
export const recorded = (args: unknown[]): unknown[] => {
  const last = args.at(-1);
  return typeof last === "object" && last !== null && "signal" in last && last.signal instanceof AbortSignal
    ? args.slice(0, -1)
    : args;
};

const unexpected = async (): Promise<never> => {
  throw new Error("not this test's");
};

// Each tool of a wire table's port method, answering as `answer` does.
const methodsThat = (wire: object, answer: () => Promise<never>): Record<string, () => Promise<never>> =>
  Object.fromEntries(Object.keys(wire).map((name) => [methodOf(name), answer]));
export const readsThat = (answer: () => Promise<never>): PersonalReads =>
  methodsThat(READ_TOOL_WIRE, answer) as unknown as PersonalReads;

// A tool's code when the agent API refuses it, by the registration, as the store does: a tool or a
// view the client lacks is not_permitted, and otherwise invalid_request.
const refusedCode = (client: ClientView, tool: PersonalTool): "invalid_request" | "not_permitted" => {
  const view = toolView(tool);
  return client.tools.includes(tool) && (view === null || client.views.includes(view))
    ? "invalid_request"
    : "not_permitted";
};

// Every method answers unavailable unless the test says otherwise, and every method reached for
// is recorded.

export function fakeProvider(client: ClientView, over: Partial<Provider> = {}): { provider: Provider; calls: Call[] } {
  const calls: Call[] = [];
  const base: Provider = {
    ...readsThat(unexpected),
    ...(methodsThat(WRITE_TOOL_WIRE, unexpected) as unknown as PersonalWrites),
    client: async () => client,
    fileResearch: unexpected,
    pushCapture: async () => ({ ok: false, code: "unavailable" }),
    syncMirror: async () => ({ ok: false, code: "unavailable" }),
    refused: async (_token, tool) => ({ ok: false, code: refusedCode(client, tool) }),
    ...over,
  };
  const provider = new Proxy(base, {
    get(target, key) {
      const method = Reflect.get(target, key) as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args: recorded(args) });
        return method?.(...args);
      };
    },
  });
  return { provider, calls };
}

// It takes only what the real logger takes, and records it.
export function fakeLog(): { log: PersonalLogger; events: PersonalLogEvent[] } {
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  return { log: { info: record, warn: record, error: record }, events };
}

export const request = (method: string, params?: unknown, id: unknown = 1): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
export const call = (name: string, args?: unknown, id: unknown = 1): string =>
  request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, id);
export const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
// A refusal: its first text is the code, and a second, JSON with the refused arguments (an
// invalid_request's), a claim refusal's code and the fixed hint, and nothing else (handle.ts).
// The details tests assert them where they matter.
const refusalContent = (text: string) => ({
  asymmetricMatch: (actual: unknown): boolean => {
    if (!Array.isArray(actual) || JSON.stringify(actual[0]) !== JSON.stringify({ type: "text", text })) return false;
    if (actual.length === 1) return true;
    if (actual.length !== 2) return false;
    const details = JSON.parse((actual[1] as { text: string }).text) as Record<string, unknown>;
    // Arguments and a claim refusal ride on an invalid_request alone; any other code carries the hint alone.
    const allowed = text === "invalid_request" ? ["arguments", "hint", "refusal"] : ["hint"];
    return Object.keys(details).every((key) => allowed.includes(key));
  },
  toString: () => `a refusal ${text}`,
  toAsymmetricMatcher: () => `a refusal ${text}`,
});
export const toolError = (id: unknown, text: string) => ({
  jsonrpc: "2.0",
  id,
  result: { isError: true, content: refusalContent(text) },
});
// A read tool's value as the agent API sends it: in its wire form (compactResult).
export const readResult = (tool: CompactReadTool, id: unknown, value: unknown) =>
  toolResult(id, compactResult(tool, value));
export const toolResult = (id: unknown, value: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
});

// A work port in the same way: every method answers by throwing unless the test says
// otherwise, and every method reached for is recorded.
export function fakeWork(client: ClientView, over: Partial<PersonalWork> = {}): { work: PersonalWork; calls: Call[] } {
  const calls: Call[] = [];
  const base: PersonalWork = {
    ...(methodsThat(WORK_TOOL_WIRE, unexpected) as unknown as PersonalWork),
    refusedWork: async (_token, tool) => ({ ok: false, code: refusedCode(client, tool) }),
    ...over,
  };
  const work = new Proxy(base, {
    get(target, key) {
      const method = Reflect.get(target, key) as ((...args: unknown[]) => unknown) | undefined;
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args: recorded(args) });
        return method?.(...args);
      };
    },
  });
  return { work, calls };
}

// For the read and record tests: a work port no call may reach.
export const NO_WORK: PersonalWork = fakeWork(clientView()).work;

// For the tests that are not about time: each wait of a reply deadline takes one turn of the
// event loop, after every fake port has answered. deadlines.test.ts keeps the deadlines.
export const AT_ONCE: HandleOptions = { sleep: () => new Promise((resolve) => setImmediate(resolve)) };
export const handleAtOnce = (...args: Parameters<typeof handle>): ReturnType<typeof handle> =>
  handle(args[0], args[1], args[2], args[3], args[4] ?? AT_ONCE);
export const serveAtOnce = (...args: Parameters<typeof serveStdio>): ReturnType<typeof serveStdio> =>
  serveStdio(args[0], args[1], args[2], args[3], args[4], args[5] ?? AT_ONCE);
