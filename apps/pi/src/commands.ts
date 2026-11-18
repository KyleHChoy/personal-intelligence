import { parseArgs } from "node:util";
import type { HttpStatus } from "@intelligence/contracts/personal";
import { RESTRICTED_KEY_FILE } from "./command-kit.ts";
import type { Command, CommandContext, Io, Rows, RunDeps } from "./command-types.ts";
import { AGENT_RECORDS, CLIENTS, INTENTS, MEMORY, SEND } from "./commands-agents.ts";
import { DASHBOARD, INSPECTION, KEYS_AND_DATABASE, MEASURES, NOTICES, PROCESSES, VERIFIER } from "./commands-box.ts";
import { CANARY } from "./commands-canary.ts";
import { CALIBRATION, EXTRACT, EXTRACT_TRIALS, EXTRACT_UPKEEP } from "./commands-extract.ts";
import {
  BINDINGS_AND_NAMES,
  FACTS_AND_RULINGS,
  LOCAL_NAMES,
  PEOPLE_AND_LISTS,
  REVIEW_AND_IDENTITY,
} from "./commands-rulings.ts";
import { ACCOUNTS, BACKFILLS, CONTACTS, HELD_MESSAGES, LENS } from "./commands-sources.ts";
import { WORK_AND_TIME, WORK_RUNS } from "./commands-work.ts";
import type { Env } from "./env.ts";
import { checkRequired, checkRole, checkUrls, Refusal, refusal } from "./env.ts";
import { createLogger, faultFields } from "./logger.ts";

// The shell of `pi`: it refuses a secret among the arguments, finds the command, checks its
// environment, parses its arguments, and runs its body. Only a command's result goes to stdout;
// every log line goes to stderr.

// The table's sections in the order `pi --help` prints them. The modules that hold them go by
// subject, so a section's place here says nothing about which file it is in.
const SECTIONS: readonly Rows[] = [
  KEYS_AND_DATABASE,
  ACCOUNTS,
  CLIENTS,
  LENS,
  AGENT_RECORDS,
  INSPECTION,
  PEOPLE_AND_LISTS,
  PROCESSES,
  EXTRACT,
  NOTICES,
  EXTRACT_UPKEEP,
  CANARY,
  CALIBRATION,
  VERIFIER,
  SEND,
  HELD_MESSAGES,
  REVIEW_AND_IDENTITY,
  CONTACTS,
  LOCAL_NAMES,
  BACKFILLS,
  BINDINGS_AND_NAMES,
  MEMORY,
  WORK_AND_TIME,
  INTENTS,
  WORK_RUNS,
  MEASURES,
  EXTRACT_TRIALS,
  FACTS_AND_RULINGS,
  DASHBOARD,
];

// Every row, in print order. A name in two sections is a bug.
const COMMANDS: Record<string, Command> = {};
for (const [name, row] of SECTIONS.flatMap(Object.entries)) {
  if (Object.hasOwn(COMMANDS, name)) throw new Error(`two rows for ${name}`);
  COMMANDS[name] = row;
}

// Every command's name, which the dashboard's route registry (web-routes.ts) is checked against.
export const COMMAND_NAMES: readonly string[] = Object.freeze(Object.keys(COMMANDS));

// Every command's arguments, as `--help` shows them, by name (the README's table is checked against it).
export const COMMAND_ARGS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(COMMANDS).map(([name, { args = "" }]) => [name, args])),
);

// The commands a script of the box reads the output of, and what it reads.
export const SCRIPT_READS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMANDS).flatMap(([name, { scriptReads }]) =>
      scriptReads === undefined ? [] : [[name, scriptReads]],
    ),
  ),
);

const help = (): string =>
  [...Object.entries(COMMANDS).map(([name, { args = "" }]) => `pi ${name} ${args}`.trimEnd()), "pi --help", ""].join(
    "\n",
  );

// The fixed hint lines. Never evidence, never a secret. A refusal may carry its own.
const HINTS = new Map([
  ["scope_mismatch", "the consent did not grant exactly the two read-only scopes; connect again and leave both ticked"],
  ["reconnect_google", "run pi google connect again (pia on the box)"],
  ["reconnect_drive", "run pi google connect --account LABEL --drive (pia on the box)"],
  ["account_mismatch", "the Google account that consented is not the label's; sign in with the label's own account"],
  ["storage_ceiling", "the database is at its storage ceiling: Drive takes nothing new"],
  [
    "ties_reserve",
    "the ties backfill stopped at its share of the storage ceiling, which leaves Drive and capture room",
  ],
  ["listing_under_way", "a listing of this account is under way: run it again once sync has finished it"],
  ["restricted_on", "the ties backfill cannot screen by headers: decide on the restricted category first"],
  ["oauth_failed", "run pi google connect again (pia on the box)"],
  ["items_refused", "some items were refused or could not be read; see the item_skipped lines"],
  ["no_model_key", "store the OpenRouter key with pi models set-key (pia on the box)"],
  ["extract_running", "an extract run is in progress; try again when it ends"],
  // A clearance holds at most 32 compartments.
  [
    "too_many_compartments",
    "a client holds at most 32 compartments, own and its own agent compartment counted; past that register the agent with pia clients add NAME --own",
  ],
  // A clearance never narrows in place: a pack's latest handoff and the list of who may have read
  // a declassified copy are read under the clearance a client holds now.
  [
    "would_narrow",
    "a clearance only widens in place; to narrow one, revoke the client and register a new name (pia clients revoke NAME)",
  ],
  // The erasure.
  ["erasure_replay_needed", "run pi erase replay (pia on the box)"],
  ["sync_running", "a sync is running; hold it with the sync-hold file and try again"],
  // A person's erasure reaches capture items under a key the file lacks.
  [
    "keys_missing",
    "the capture item's compartment key is unavailable to this process; leave it pending until an authorized process can open it",
  ],
  ["contacts_connected", "run pi google disconnect LABEL --contacts first (pia on the box)"],
  // One hint per code: google connect's, and a binding or an anchor
  // across compartments.
  [
    "compartment_mismatch",
    "the compartments differ: the label's accounts and --compartment, the person and the item, the thread or the meeting and the project",
  ],
]);

// A token or an OpenRouter key (also as an option's value), a URL that carries a password,
// or an option named for a secret.
const SECRETS = [
  /^(-[^=]*=)?(pit_|sk-or-)/,
  /:\/\/[^\s/@]*:[^\s@]*@/,
  /^--?(token|password|secret|refresh-token|key|api-key)(=|$)/,
];
const isSecret = (argument: string): boolean => SECRETS.some((pattern) => pattern.test(argument));

// A command is its first three words, its first two, or its first.
function find(argv: string[]): { command: Command; rest: string[] } {
  for (const words of [3, 2, 1]) {
    const name = argv.slice(0, words).join(" ");
    // Each word is an argument of its own: "clients list" given as one argument is no command.
    const command =
      argv.length >= words && name.split(" ").length === words && Object.hasOwn(COMMANDS, name)
        ? COMMANDS[name]
        : undefined;
    if (command) return { command, rest: argv.slice(words) };
  }
  throw refusal("usage");
}

function parse(command: Command, args: string[]): Pick<CommandContext, "values" | "positionals"> {
  try {
    const { options = {}, positionals: taken = 0 } = command;
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    const counts: readonly number[] = typeof taken === "number" ? [taken] : taken;
    if (counts.includes(positionals.length)) {
      command.check?.({ values, positionals });
      return { values, positionals };
    }
  } catch {
    // An option the command does not take, or one with no value.
  }
  throw refusal("usage");
}

// What a failure is reported as: its code, and its hint line where it has one. The store's
// refusal of a key file becomes one of pi's two codes, and only a lock has a hint.
async function failureOf(
  error: unknown,
  env: Env,
  command: Command | undefined,
): Promise<{ code: string; hint: string | undefined; status?: HttpStatus; reason?: string }> {
  const hintOf = (code: string): string | undefined => command?.hints?.[code] ?? HINTS.get(code);
  if (error instanceof Refusal)
    return {
      code: error.code,
      hint: error.hint ?? hintOf(error.code),
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  // The memory adapter never loads the store, not even to name a failure: it holds no key file, so
  // its failure is no KeyFileRefused.
  if (command?.role === "adapter") return faultCode(error, hintOf);
  // Anything else came out of a body, which has loaded the store already.
  const { KeyFileRefused } = await import("@intelligence/personal-store");
  if (error instanceof KeyFileRefused) {
    if (error.code === "exists") return { code: "key_file_exists", hint: undefined };
    if (error.code === "restricted_key_file_unset") return { code: error.code, hint: `set ${RESTRICTED_KEY_FILE}` };
    return {
      code: "key_file_refused",
      hint: error.code === "locked" ? `remove ${env.PI_KEY_FILE}.lock if no add is running` : undefined,
    };
  }
  return faultCode(error, hintOf);
}

// A failure that is none of pi's own, by faultFields: its code and reason, never its message.
function faultCode(
  error: unknown,
  hintOf: (code: string) => string | undefined,
): { code: string; hint: string | undefined; reason?: string } {
  const fields = faultFields(error);
  return { ...fields, hint: hintOf(fields.code) };
}

export async function run(argv: string[], env: Env, io: Io, deps: RunDeps = {}): Promise<0 | 1 | 2 | 3> {
  const log = createLogger(io.stderr, io.clock);
  let found: Command | undefined;
  try {
    if (argv.some(isSecret)) throw refusal("secret_in_argument");
    if (argv.length === 1 && argv[0] === "--help") {
      io.stdout.write(help());
      return 0;
    }
    const { command, rest } = find(argv);
    found = command;
    // Every check comes before the body, so before any connection.
    checkRole(command.role, env, { modelKey: command.modelKey === true });
    const parsed = parse(command, rest);
    checkRequired(command.requires, env);
    checkUrls([...command.requires, ...(command.optionalUrls ?? []).filter((name) => (env[name] ?? "") !== "")], env);
    if (command.terminalOnly && !io.stdoutIsTTY) throw refusal("not_a_terminal", command.terminalHint);
    return await command.body({ ...parsed, env, io, log, deps });
  } catch (error) {
    const { code, hint, status, reason } = await failureOf(error, env, found);
    log.error({
      event: "command_failed",
      code,
      ...(reason === undefined ? {} : { reason }),
      ...(status === undefined ? {} : { status }),
    });
    if (hint !== undefined) io.stderr.write(`${hint}\n`);
    return code === "usage" ? 2 : 1;
  }
}
