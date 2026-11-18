import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLIENT, readSecrets, SECRET } from "./notify.ts";

// The `pia` wrapper's key step. Not a `pi` command,
// and not imported by main.ts: the wrapper runs it as `pinotify`, with `node --disable-sigusr1`
// from an empty environment.
//
//   webhook-keys.ts client [NAME]     the client id, from a command's JSON on standard input: the
//                                     `{ "client": ... }` of `clients webhook set|rm`, or, with
//                                     NAME, that client's row of `clients list`
//   webhook-keys.ts set FILE CLIENT   the key, one line on standard input, stored under CLIENT
//   webhook-keys.ts rm FILE CLIENT    CLIENT's key removed
//
// The key is never an argument. The file is read with every check `pi notify` makes, so one it
// would refuse is left as it is; then written whole as a new file, mode 0600, in the same folder,
// and renamed over it. `client` prints the id; nothing else prints anything, and each exits 0 or 1.

async function input(stdin: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function clientOf(text: string, name: string | undefined): string | null {
  const parsed: unknown = JSON.parse(text);
  const found =
    name === undefined
      ? (parsed as { client?: unknown } | null)?.client
      : Array.isArray(parsed)
        ? (parsed.find((row: { name?: unknown }) => row?.name === name) as { id?: unknown } | undefined)?.id
        : undefined;
  return typeof found === "string" && CLIENT.test(found) ? found : null;
}

async function replace(file: string, client: string, key: string | null): Promise<void> {
  const { secrets } = await readSecrets(file, process.getuid?.());
  if (key === null && !secrets.has(client)) return;
  const next = new Map(secrets);
  if (key === null) next.delete(client);
  else next.set(client, key);
  const temporary = join(dirname(file), `.webhooks.${randomBytes(8).toString("hex")}`);
  // "wx": a path that exists, a link among them, is refused and left as it is.
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(Object.fromEntries(next))}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main(args: string[], stdin: AsyncIterable<Buffer>, write: (text: string) => void): Promise<0 | 1> {
  const [mode, first, second] = args;
  if (mode === "client" && args.length <= 2) {
    const client = clientOf(await input(stdin), first);
    if (client === null) return 1;
    write(`${client}\n`);
    return 0;
  }
  if (
    (mode !== "set" && mode !== "rm") ||
    args.length !== 3 ||
    first === undefined ||
    !first.startsWith("/") ||
    second === undefined ||
    !CLIENT.test(second)
  )
    return 1;
  let key: string | null = null;
  if (mode === "set") {
    const text = await input(stdin);
    // One line feed that ends the input is the pipe's, not the key's.
    key = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!SECRET.test(key)) return 1;
  }
  await replace(first, second, key);
  return 0;
}

// The entry's whole run, its exit code from its arguments and input, `write` its one output;
// an error is 1. Exported so its tests run it in-process; the entry runs it only when it is the
// process's main module.
export const webhookKeys = (
  args: string[],
  stdin: AsyncIterable<Buffer>,
  write: (text: string) => void,
): Promise<0 | 1> => main(args, stdin, write).catch(() => 1 as const);

if (import.meta.main)
  process.exitCode = await webhookKeys(process.argv.slice(2), process.stdin, (text) => process.stdout.write(text));
