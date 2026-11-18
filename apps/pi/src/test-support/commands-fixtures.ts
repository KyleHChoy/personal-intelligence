// Shared setup for the commands-*.test.ts files: pi run in-process, the expectations its
// refusals and positive controls meet, and the commands each group of tests walks.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import { pi } from "./run-pi.ts";

// Hand-written values: a closed port, so nothing here could connect. A refusal test never
// reaches a command's body; a positive control does, with a key file `pi keys init` wrote, and
// ends at the closed port as `unavailable`.
export const url = (role: string): string => `postgres://${role}:local-only@127.0.0.1:1/pi_test`;
export const BOOTSTRAP = { PI_DATABASE_URL_BOOTSTRAP: url("migrator") };
export const ADMIN = { PI_DATABASE_URL_ADMIN: url("pi_admin") };
export const WRITER = { PI_DATABASE_URL_WRITER: url("pi_writer") };
export const READER = { PI_DATABASE_URL_READER: url("pi_reader") };
export const PROXY = { PI_DATABASE_URL_PROXY: url("pi_proxy") };
// The pipeline's and the work roles: the proxy refuses every role URL but its own, by name.
export const PIPELINE = { PI_DATABASE_URL_PIPELINE: url("pi_pipeline") };
export const WORK = { PI_DATABASE_URL_WORK: url("pi_work") };
// The restricted role and its key root: only `db migrate` holds the URL, and `pi extract` refuses
// the key file.
export const RESTRICTED = { PI_DATABASE_URL_RESTRICTED: url("pi_restricted") };
export const RESTRICTED_KEYS = { PI_RESTRICTED_KEY_FILE: "/nonexistent/pirestricted/restricted-keys.json" };
export const KEYS = { PI_KEY_FILE: "/nonexistent/pi/keys.json" };
export const ENTITY = `ent_${"0".repeat(25)}1`;
export const MESSAGE = `msg_${"0".repeat(25)}1`;
export const DOCUMENT = `doc_${"0".repeat(25)}1`;

export type Env = Record<string, string>;

export { pi };

// A key file `pi keys init` wrote, for the tests that reach a command's body, and its folder.
// A test file that needs them calls useRealKeyFile() once at its top level.
export let folder = "";
export const REAL: Env = {};
export function useRealKeyFile(): void {
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-commands-test-"));
    REAL.PI_KEY_FILE = join(folder, "keys.json");
    expect(await pi(["keys", "init", "--compartments", "own,employer:example"], REAL)).toEqual({
      exit: 0,
      stdout: "",
      stderr: "",
    });
  });
  afterAll(() => rm(folder, { recursive: true, force: true }));
}

export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const request = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`;

// Every line a failed command left on stderr is a log event of ids, counts and codes, and the
// last is its one `command_failed` line. No message, no stack, no cause: a fault's reason is its
// SQLSTATE, errno or class, as a code.
export function failureLines(stderr: string): { event: string; code?: string; reason?: string }[] {
  const lines = stderr.split("\n").filter((line) => line !== "");
  const events = lines.map((line) => JSON.parse(line) as { event: string; code?: string; reason?: string });
  for (const event of events) {
    expect(
      Object.keys(event).every((key) => ["event", "code", "reason", "ids", "counts", "durationMs"].includes(key)),
      JSON.stringify(event),
    ).toBe(true);
    if (event.reason !== undefined) expect(event.reason).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  }
  return events;
}

// A command that passed every check, reached its body and failed at the closed port.
export async function expectUnavailable(
  argv: string[],
  env: Env,
  options?: { tty?: boolean; stdin?: string[] },
): Promise<void> {
  const result = await pi(argv, env, options);
  expect({ exit: result.exit, stdout: result.stdout }, `pi ${argv.join(" ")}`).toEqual({ exit: 1, stdout: "" });
  const last = failureLines(result.stderr).at(-1);
  expect({ event: last?.event, code: last?.code }, `pi ${argv.join(" ")}`).toEqual({
    event: "command_failed",
    code: "unavailable",
  });
}

export const failed = (code: string): string => `${JSON.stringify({ event: "command_failed", code })}\n`;

// A refusal: its exit code, nothing on stdout, and on stderr exactly its one log line, then its
// hint line where it has one.
export async function expectRefused(
  argv: string[],
  env: Env,
  code: string,
  exit: 1 | 2 = 1,
  options?: { tty?: boolean; hint?: string; stdin?: string[] },
): Promise<void> {
  const result = await pi(argv, env, options);
  const hint = options?.hint === undefined ? "" : `${options.hint}\n`;
  expect(result, `pi ${argv.join(" ")}`).toEqual({ exit, stdout: "", stderr: `${failed(code)}${hint}` });
}

// The identity commands of contacts and identity, with arguments that parse.
export const OTHER_ENTITY = `ent_${"0".repeat(25)}2`;
export const RULING = `rul_${"0".repeat(25)}1`;
// The ids of a filed mention and a binding.
export const MENTION = `umn_${"0".repeat(25)}1`;
const BINDING = `mbd_${"0".repeat(25)}1`;
export const IDENTITY_COMMANDS: string[][] = [
  ["identity", "link", ENTITY, OTHER_ENTITY],
  ["identity", "differ", ENTITY, OTHER_ENTITY],
  ["identity", "share", ENTITY],
  ["identity", "list"],
  ["identity", "lift", RULING],
  ["identity", "sweep"],
  ["contacts", "remove", "personal"],
  // Contact import: the owner's list and removal.
  ["import", "list"],
  ["import", "remove", "linkedin"],
  // Filed mentions and their bindings.
  ["identity", "mentions"],
  ["identity", "mentions", "--limit", "5"],
  ["identity", "bind", MENTION, ENTITY],
  ["identity", "unbind", BINDING],
  ["identity", "refile"],
  // The owner's name for an organization.
  ["org", "name", ENTITY, "Alder Works"],
];

// Every owner command, with arguments that parse.
export const OWNER_COMMANDS: string[][] = [
  ["google", "connect", "--account", "personal"],
  ["google", "list"],
  ["google", "disconnect", "personal"],
  ["owner", "add-address", "owner@example.com"],
  ["owner", "timezone", "America/Chicago"],
  ["clients", "add", "mine", "--views", "self,people", "--tools", "get_self,search"],
  ["clients", "list"],
  ["clients", "revoke", "mine"],
  ["clients", "quota", "mine", "--items", "5"],
  ["clients", "usage"],
  ["inspect", ENTITY],
  ["status"],
  ["messages", "held"],
  ["messages", "release", "--older-than", "7d"],
  // Contacts and identity.
  ["google", "connect", "--account", "personal", "--contacts"],
  ["google", "disconnect", "personal", "--contacts"],
  ...IDENTITY_COMMANDS,
  ["extract", "status"],
  ["extract", "review", "--type", "commitment", "--sample", "5"],
  ["extract", "retry", "--all", "--yes"],
  ["extract", "retry", "--message", MESSAGE, "--override"],
  // Memory adapters.
  ["memory", "status"],
  ["memory", "status", "--client", "mine"],
  ["memory", "exposures"],
  ["memory", "exposures", "--client", "mine", "--limit", "500"],
  // The ladder's calibration and thresholds.
  ["ladder", "calibrate"],
  ["ladder", "calibrate", "--point", "extract_recovery"],
  ["ladder", "resume", "extract_triage"],
  ["thresholds", "list"],
  ["thresholds", "target", "extract_recovery", "--recall", "0.9"],
  ["thresholds", "grant", `tpr_${"0".repeat(25)}1`],
  ["thresholds", "set", "extract_recovery", "--name", "hold", "--value", "0.6"],
  ["thresholds", "revoke", `thr_${"0".repeat(25)}1`],
  // Learning.
  ["learn", "label", `crd_${"0".repeat(25)}1`, "--labels", "acted,novel"],
  ["learn", "label", `crd_${"0".repeat(25)}1`, "--labels="],
  ["learn", "silences"],
  ["learn", "silences", "--sample", "20"],
  ["learn", "silences", "--pending"],
  ["agent-records", "release", `rec_${"0".repeat(25)}1`],
  ["restricted", "list"],
  // Restatements.
  ["restatements", "list"],
  ["restatements", "list", "--client", "mine", "--answer", "stale", "--limit", "200"],
  ["restatements", "clear", "1"],
  // Lens.
  ["lens", "add", "mac"],
  ["lens", "add", "mac", "--compartments", "own,employer:example", "--views", "self,work"],
  ["lens", "list"],
  ["lens", "rotate", "mac", "--capture"],
  ["lens", "rotate", "mac", "--mirror"],
  ["lens", "revoke", "mac"],
  // The device's Mac contacts' switch and counts.
  ["lens", "contacts", "mac"],
  ["lens", "contacts", "mac", "on"],
  ["lens", "contacts", "mac", "off"],
  ["lens", "scope", "add", "--host", "example.test", "--compartment", "own"],
  [
    "lens",
    "scope",
    "add",
    "--bundle",
    "com.example.app",
    "--account",
    "owner@example.test",
    "--compartment",
    "employer:example",
    "--kinds",
    "moment,block",
  ],
  ["lens", "scope", "list"],
  ["lens", "scope", "list", "--show"],
  ["lens", "scope", "remove", `csr_${"0".repeat(25)}1`],
  // Browsing on a deny-list.
  ["lens", "browsing", "mac"],
  ["lens", "browsing", "mac", "allow"],
  ["lens", "browsing", "mac", "deny"],
  ["lens", "browsing", "exclude", "add", "bank.example.com"],
  ["lens", "browsing", "exclude", "list"],
  ["lens", "browsing", "exclude", "list", "--show"],
  ["lens", "browsing", "exclude", "remove", `cex_${"0".repeat(25)}1`],
  ["lens", "browsing", "account", "add", "owner@example.test", "--compartment", "employer:example"],
  ["lens", "browsing", "account", "list"],
  ["lens", "browsing", "account", "list", "--show"],
  ["lens", "browsing", "account", "remove", `cac_${"0".repeat(25)}1`],
  // Lens: the forgets from a Mac.
  ["erase", "settle"],
  ["erase", "settle", "--limit", "5"],
];

// The two pipeline commands, with the model set: the variable they require besides the URL.
export const MODEL = { PI_EXTRACT_MODEL: "example/model-id" };
export const PIPELINE_COMMANDS: string[][] = [
  ["extract"],
  ["extract", "--max-calls", "5"],
  ["extract", "--capture", "cap_01JMMNTSAA0000000000000001"],
  ["extract", "check"],
];
// Every pi send command, with arguments that parse.
export const DRAFT = `drf_${"0".repeat(25)}1`;
export const SEND = `snt_${"0".repeat(25)}1`;
export const SEND_GOOGLE = {
  PI_SEND_GOOGLE_CLIENT_ID: "sentinel-send-client-id",
  PI_SEND_GOOGLE_CLIENT_SECRET: "sentinel-send-client-secret",
};
export const SEND_COMMANDS: string[][] = [
  ["send", "list"],
  ["send", "show", DRAFT],
  ["send", "draft", DRAFT, "--code", "0123abcd"],
  ["send", "draft", DRAFT, "--code", "0123abcd", "--first-contact", "--new-thread", "--reveal", "89abcdef"],
  ["send", "settle", SEND, "--sent"],
  ["send", "settle", SEND, "--not-sent"],
  ["send", "connect", "--account", "personal", "--port", "8765"],
  ["send", "disconnect", "--account", "personal"],
  ["send", "status"],
];

export const FACT = "c".repeat(64);
export const O4_REST_COMMANDS: string[][] = [
  ["facts", "show", FACT],
  ["correct", "reject", FACT],
  ["correct", "veto", FACT],
  ["correct", "list"],
  ["correct", "lift", RULING],
  ["declassify", "add", FACT],
  ["declassify", "list"],
  ["declassify", "revoke", RULING],
  ["digest"],
  ["web", "serve"],
];
// Past its checks each opens the database, and the closed port answers unavailable.
const BUILT = new Set(["facts", "correct", "declassify", "digest", "web"]);
export const built = (argv: string[]): boolean => BUILT.has(argv[0] ?? "");

// A built command's positive control: it got past every check to the database.
export async function expectReached(argv: string[], env: Env, options?: { tty?: boolean }): Promise<void> {
  const result = await pi(argv, env, options);
  expect({ exit: result.exit, stdout: result.stdout }, `pi ${argv.join(" ")}`).toEqual({ exit: 1, stdout: "" });
  expect(result.stderr.endsWith(failed("unavailable")), `pi ${argv.join(" ")}`).toBe(true);
}
export const expectBodyReached = (argv: string[], env: Env, options?: { tty?: boolean }): Promise<void> =>
  built(argv) ? expectReached(argv, env, options) : expectRefused(argv, env, "not_built", 1, options);
