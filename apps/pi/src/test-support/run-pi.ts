import { Readable, Writable } from "node:stream";
import type { RunDeps } from "../command-types.ts";
import { run } from "../commands.ts";

// A stream that keeps every chunk written to it, and tells `tell` of each as it is written.
export const collect = (into: Buffer[], tell?: (text: string) => void): Writable =>
  new Writable({
    write(chunk: Buffer, _encoding, done) {
      into.push(chunk);
      tell?.(chunk.toString("utf8"));
      done();
    },
  });

export type PiOptions = {
  // Whether stdout is a terminal.
  tty?: boolean;
  // What the command reads: one entry per chunk, or one string read whole.
  stdin?: string | readonly (string | Buffer)[];
  // Whether the input is a terminal, as main sets it; left out, as a test's.
  stdinTty?: boolean;
  // Replaces the stream that collects stdout.
  stdout?: Writable;
  // Told of each piece of stdout as it is written.
  onStdout?: (text: string) => void;
  deps?: RunDeps | undefined;
};

// What a refused command writes to stderr: its event, then its hint when it has one.
export const failed = (code: string, hint?: string): string =>
  `${JSON.stringify({ event: "command_failed", code })}\n${hint === undefined ? "" : `${hint}\n`}`;

// A refused command's whole result: nothing on stdout and its code on stderr.
export const refused = (code: string, exit = 1) => ({ exit, stdout: "", stderr: failed(code) });
export const refusedWithHint = (code: string, hint?: string, exit = 1) => ({
  exit,
  stdout: "",
  stderr: failed(code, hint),
});

// Runs pi in-process and returns its exit code and what it wrote to each stream.
export async function pi(
  argv: string[],
  env: Record<string, string>,
  { tty = false, stdin = [], stdinTty, stdout, onStdout, deps }: PiOptions = {},
) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const exit = await run(
    argv,
    env,
    {
      stdout: stdout ?? collect(out, onStdout),
      stderr: collect(err),
      stdin: Readable.from(typeof stdin === "string" ? [stdin] : stdin),
      stdoutIsTTY: tty,
      ...(stdinTty === undefined ? {} : { stdinIsTTY: stdinTty }),
    },
    deps,
  );
  return { exit, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}
