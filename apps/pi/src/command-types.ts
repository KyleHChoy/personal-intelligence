import type { ParseArgsOptionsConfig } from "node:util";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { ExtractDeps } from "@intelligence/personal-extract";
import type { GoogleDeps } from "@intelligence/personal-google";
import type { Env, Role } from "./env.ts";
import type { SwitchName } from "./switches.ts";

// What a command is and what it runs with: the table's modules read these, and the shell reads the tables.

// `stdinIsTTY`: whether the input is a terminal, where a command reads an answer from it (`lens
// browsing NAME deny`); main sets it, and a test that leaves it out answers as one.
// `clock`: the time each log line carries with its level, main's on the box.
export type Io = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdoutIsTTY: boolean;
  stdinIsTTY?: boolean;
  clock?: () => Date;
};

// `google` is handed to every Google call, and `listenTimeoutMs` to `listenForCode`. `model`
// replaces the OpenRouter client of `pi extract` and `pi extract check` whole, and `modelFetch`
// is the `fetch` the real client is given: a test passes one or the other, so no test calls
// OpenRouter. `decideModel` replaces the decide-model client of both the same way. `keyFetch` is the `fetch` of
// both commands' spend-cap check, its one request to the key endpoint; a test passes one.
// `now` is the clock of a run.
export type RunDeps = {
  google?: GoogleDeps;
  listenTimeoutMs?: number;
  // The standing check's calls to the agent API, for a test.
  canaryFetch?: typeof fetch;
  importTimeoutMs?: number;
  model?: ExtractDeps["model"];
  decideModel?: ExtractDeps["model"];
  modelFetch?: typeof fetch;
  keyFetch?: typeof fetch;
  now?: () => Date;
};

// What a command's body is given. Its arguments are parsed, and still unchecked: a body throws
// `refusal("usage")` for a value it does not accept.
export type CommandContext = {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
  env: Env;
  io: Io;
  log: PersonalLogger;
  deps: RunDeps;
};

// A body returns its exit code (3 only from `web serve` ended by `web stop`, which the box's
// supervisor does not restart), and throws an error that carries a `code` for a refusal or a
// failure.
export type Body = (context: CommandContext) => Promise<0 | 1 | 3>;

// A command's row. `args`, `options`, `positionals` and `terminalOnly` default to none: no
// arguments shown, no options, no positionals, and output to anything.
export type Command = {
  // The arguments, as `--help` shows them.
  args?: string;
  role: Role;
  requires: readonly SwitchName[];
  // Database URLs it takes when set and goes on without: a set one is checked as a required one is.
  optionalUrls?: readonly SwitchName[];
  // It may hold the model key in its environment: only the import does.
  modelKey?: boolean;
  // Its result is printed to a terminal and to nothing else.
  terminalOnly?: boolean;
  // The hint line of its `not_a_terminal` refusal, where it has one.
  terminalHint?: string;
  options?: ParseArgsOptionsConfig;
  // How many positionals it takes: a count, or the counts it accepts.
  positionals?: number | readonly number[];
  // A check of the parsed arguments that throws `refusal("usage")`, run before any connection.
  check?: (parsed: Pick<CommandContext, "values" | "positionals">) => void;
  body: Body;
  // The hint lines of refusals only this command raises, by code. `run` prints one with the code; a
  // hint is pi's own text, never evidence or a secret.
  hints?: Readonly<Record<string, string>>;
  // A script of the box reads this command's exact output: which, and what. A change to that output
  // breaks the script, in a built image and nowhere else. command-scripts.test.ts holds the list.
  scriptReads?: string;
};

// A section of the command table: rows by command name.
export type Rows = Readonly<Record<string, Command>>;
