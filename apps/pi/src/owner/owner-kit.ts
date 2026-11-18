import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { PersonalCompartment } from "@intelligence/contracts/personal";
import type { Admin, Keys, RestrictedUnlock } from "@intelligence/personal-store";
import { createAdmin, journalPath, loadKeys, withoutCanary, withUnlock } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import type { Env } from "../env.ts";
import { refusal, restrictedKeyFile } from "../env.ts";

export const variable = (env: Env, name: string): string => env[name] ?? "";

// A fresh request id for one write: `bytes` random bytes, base64url.
export const requestId = (bytes = 16): string => randomBytes(bytes).toString("base64url");

// Whether the deployment lets a client be given record: `PI_RECORD_ENABLED` set to 1, once the
// owner has decided backups.
export const recordEnabled = (env: Env): boolean => env.PI_RECORD_ENABLED === "1";

// A command's result: one line on stdout.
export const print = ({ io }: CommandContext, line: string): void => void io.stdout.write(`${line}\n`);

// Compartment names. One that is no PersonalCompartment is a usage error.
export function compartments(names: string[]): string[] {
  if (!names.every((name) => PersonalCompartment.safeParse(name).success)) throw refusal("usage");
  return names;
}

// An owner command, with the Admin as pi_admin, closed when the command ends. `pi erase replay` and
// `pi status` alone skip it (`level: "skip"`). `timeoutMs` bounds the pool's connection and
// statements. With PI_RESTRICTED_KEY_FILE set it holds both key files' keys (owner commands are
// restricted holders), so `pi status` names a restricted key a row carries and the file lacks. A
// wrapped restricted file gives no key; with `unlock`, the Admin holds the keys an unlock opens
// while its window lasts.
export async function withAdmin(
  { env, log }: CommandContext,
  fn: (admin: Admin, keys: Keys) => Promise<void>,
  options: { level?: "skip"; timeoutMs?: number; poolSize?: number; everyKey?: true; unlock?: RestrictedUnlock } = {},
): Promise<0> {
  const keyFile = variable(env, "PI_KEY_FILE");
  // No owner read holds the standing check's keys, but an erasure's walk and add-address's re-derive.
  const all = await loadKeys(keyFile, restrictedKeyFile(env));
  const read = options.everyKey === true ? all : withoutCanary(all);
  const keys = options.unlock === undefined ? read : withUnlock(read, options.unlock);
  const admin = createAdmin({
    url: variable(env, "PI_DATABASE_URL_ADMIN"),
    keys,
    log,
    recordEnabled: recordEnabled(env),
    journal: journalPath(keyFile),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
  });
  try {
    if (options.level !== "skip" && (await admin.erasure.level()) === "behind") throw refusal("erasure_replay_needed");
    await fn(admin, keys);
    return 0;
  } finally {
    await admin.close();
  }
}

export const printJson = (context: CommandContext, value: unknown): void => print(context, JSON.stringify(value));

// Stdin read to its end. Past `most` bytes, reading stops and the command is refused with `code`.
export async function stdinBytes(
  { io }: CommandContext,
  most = Number.POSITIVE_INFINITY,
  code = "usage",
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of io.stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    bytes += buffer.length;
    if (bytes > most) throw refusal(code);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Bytes decoded as UTF-8, refused with `code` when they are not valid UTF-8.
export function strictUtf8(bytes: Buffer, code = "usage"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refusal(code);
  }
}

type Value = CommandContext["values"][string];

// A string option that parses with the schema, or a usage error.
export function parsed<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: Value,
): T {
  const result = typeof value === "string" ? schema.safeParse(value) : { success: false as const };
  if (!result.success) throw refusal("usage");
  return result.data;
}

// An owner command on the record its first argument names: the id parsed with `schema`, a usage
// error when it does not parse, then `fn` with the Admin, as `withAdmin` runs it.
export async function withNamed<T>(
  context: CommandContext,
  schema: Parameters<typeof parsed<T>>[0],
  fn: (admin: Admin, id: T) => Promise<void>,
): Promise<0> {
  const id = parsed(schema, context.positionals[0]);
  return withAdmin(context, (admin) => fn(admin, id));
}

// The owner's answers at a terminal, one a line from stdin: `ask` writes its prompt until a line is
// y, n or s (the own keys only, so "constructor" is no answer), and gives the answer y or n stands
// for, "skip", or null when stdin ends. `close` ends the reading.
export function yesNoSkip<V>(
  { io }: CommandContext,
  answers: { y: V; n: V },
): { ask(prompt: string): Promise<V | "skip" | null>; close(): void } {
  const words: Record<string, V | "skip"> = { ...answers, s: "skip" };
  const reader = createInterface({ input: io.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  return {
    async ask(prompt) {
      for (;;) {
        io.stdout.write(prompt);
        const next = await lines.next();
        if (next.done === true) return null;
        const word = next.value.trim().toLowerCase();
        if (Object.hasOwn(words, word)) return words[word] as V | "skip";
      }
    },
    close: () => reader.close(),
  };
}

// A list argument: comma-separated, with no spaces and no empty entry.
export function list(value: Value, fallback?: string[]): string[] {
  if (value === undefined && fallback !== undefined) return fallback;
  const entries = typeof value === "string" ? value.split(",") : [];
  if (entries.length === 0 || entries.some((entry) => entry === "" || /\s/.test(entry))) throw refusal("usage");
  return entries;
}
