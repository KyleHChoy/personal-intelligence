import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { HandleOptions } from "./handle.ts";
import { handle, logCall } from "./handle.ts";
import type { JsonRpcResponse } from "./jsonrpc.ts";
import { failure } from "./jsonrpc.ts";
import { SessionTaint } from "./session-taint.ts";
import type { Ports } from "./tools.ts";

// Newline-delimited JSON-RPC: one message per line, handled one at a time, in order. Only
// replies are written to the output, and every log line goes through the logger. A call's reply
// is written at its deadline (`handle`), so a second call sent at once is answered at the first's
// deadline plus its own.

// `handle`'s clock and wait, and `logs`: held from the moment a line is complete, and flushed
// once its reply is written whole, or when it has none. `pi mcp` passes its logger's hold, so
// nothing reaches stderr between a call's arrival and its reply.
// No `tally`: a client's process reads this stderr, and `tool_work` is the time the deadline hides.
export type StdioOptions = Omit<HandleOptions, "tally"> & { logs?: { hold(): void; flush(): void } };

const MAX_LINE = 1024 * 1024;
const NEWLINE = 0x0a;
// Strict: an invalid byte is an error, never replaced and passed on.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export async function serveStdio(
  ports: Ports,
  log: PersonalLogger,
  token: string | undefined,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: StdioOptions = {},
): Promise<void> {
  const { logs, ...given } = options;
  // One process's input is one session: its labels are this serve's own.
  const timing = { ...given, taint: given.taint ?? new SessionTaint() };
  // The line being read: its bytes so far and their count. Past the limit nothing is kept.
  let parts: Buffer[] = [];
  let size = 0;

  // A reply is written whole before the next message is read.
  const send = (reply: JsonRpcResponse): Promise<void> =>
    new Promise((resolve, reject) => {
      output.write(`${JSON.stringify(reply)}\n`, (error) => (error ? reject(error) : resolve()));
    });

  const endLine = async (): Promise<void> => {
    logs?.hold();
    try {
      await answer();
    } finally {
      logs?.flush();
    }
  };

  const answer = async (): Promise<void> => {
    const tooLong = size > MAX_LINE;
    const bytes = Buffer.concat(parts);
    parts = [];
    size = 0;
    // A line refused here was never a message: it is logged as a call, and answered with no id.
    const refuse = (error: "invalid_request" | "parse_error"): Promise<void> => {
      logCall(log, error, 0);
      return send(failure(null, error));
    };
    if (tooLong) return refuse("invalid_request");
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      return refuse("parse_error");
    }
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (line.trim() === "") return;
    const reply = await handle(ports, log, token, line, timing);
    if (reply !== null) await send(reply);
  };

  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let from = 0;
    while (true) {
      const newline = bytes.indexOf(NEWLINE, from);
      const piece = bytes.subarray(from, newline === -1 ? bytes.length : newline);
      size += piece.length;
      if (size > MAX_LINE) parts = [];
      else parts.push(piece);
      if (newline === -1) break;
      await endLine();
      from = newline + 1;
    }
  }
  if (size > 0) await endLine();
}
