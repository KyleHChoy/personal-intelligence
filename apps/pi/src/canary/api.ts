import { readFile, rename, writeFile } from "node:fs/promises";
import { isCoded } from "@intelligence/contracts/personal";
import type { CanaryTokens } from "@intelligence/personal-store";
import { refusal } from "../env.ts";

// The real agent API, as an agent meets it: POST /mcp at PI_CANARY_API_URL, one JSON-RPC message, a
// client's bearer token. A stopped `pi http` or a refused token is a read that failed, never a
// fault of the check itself.

export type Reply = { ok: true; value: Record<string, unknown> } | { ok: false; code: string };
export type CanaryApi = (client: keyof CanaryTokens, tool: string, args: Record<string, unknown>) => Promise<Reply>;
type JsonRpc = {
  error?: { message?: string };
  result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
};

const ASKS = 3;
const PAUSE_MS = 2_000;

export function canaryApi(
  url: string,
  tokens: CanaryTokens,
  fetcher: typeof fetch = fetch,
  {
    pause = (ms) => new Promise((done) => setTimeout(done, ms)),
    refused = () => {},
  }: { pause?: (ms: number) => Promise<void>; refused?: (tool: string, code: string) => void } = {},
): CanaryApi {
  let id = 0;
  const once = async (client: keyof CanaryTokens, tool: string, args: Record<string, unknown>): Promise<Reply> => {
    id += 1;
    let body: JsonRpc;
    try {
      const answer = await fetcher(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens[client]}` },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      body = (await answer.json()) as JsonRpc;
    } catch {
      return { ok: false, code: "unreachable" };
    }
    if (body.error !== undefined) return { ok: false, code: body.error.message ?? "refused" };
    const result = body.result ?? {};
    if (result.isError === true) return { ok: false, code: result.content?.[0]?.text ?? "refused" };
    return { ok: true, value: result.structuredContent ?? {} };
  };
  // A reply past its deadline on a busy box says nothing of what the store holds, so it is asked
  // again; every write here carries its request id, so a second ask writes nothing twice. A refusal
  // that stays is the hop's result, told by its code, so a red row can be read.
  return async (client, tool, args) => {
    let reply = await once(client, tool, args);
    for (let ask = 1; ask < ASKS && !reply.ok && reply.code === "unavailable"; ask += 1) {
      await pause(PAUSE_MS);
      reply = await once(client, tool, args);
    }
    if (!reply.ok) refused(tool, reply.code);
    return reply;
  };
}

// Whether a reply carries a word anywhere in it. A value an agent reads is wrapped as `{ untrusted }`
// and a tool's shape differs by tool, so the word is looked for in the reply's text, which is what
// an agent would read.
export const carries = (reply: Reply, word: string): boolean =>
  reply.ok && JSON.stringify(reply.value).toLowerCase().includes(word.toLowerCase());

// The tokens, in a file of pi's alone, mode 0600: each reaches only the check's own compartments.
export async function readTokens(path: string): Promise<CanaryTokens> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isCoded(error, "ENOENT")) throw refusal("canary_not_set_up", "run pia canary setup once");
    throw error;
  }
  return JSON.parse(text) as CanaryTokens;
}

export async function writeTokens(path: string, tokens: CanaryTokens): Promise<void> {
  const fresh = `${path}.new`;
  await writeFile(fresh, `${JSON.stringify(tokens)}\n`, { mode: 0o600 });
  await rename(fresh, path);
}
