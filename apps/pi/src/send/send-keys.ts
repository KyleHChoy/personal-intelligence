import { open, rm } from "node:fs/promises";
// The key file's code alone, not the store's index: root loads no database driver for this.
import { forSending, narrowKeyText } from "@intelligence/personal-store/keys";

// The send wrapper's narrowing entry. Not a `pi` command, and not
// imported by main.ts: `pi-send` runs it as root, with `node --disable-sigusr1` from an empty
// environment, on the bytes of the key file a process running as `pi` hands it on a pipe. It
// reads its standard input itself, never `/dev/stdin` as a path, takes one argument, the output
// path, and writes there a new file, mode 0600, holding the fingerprint key and the compartments
// `forSending` names, with every check `loadKeys` runs. So what `pisend` holds is chosen by the
// image's code, never by `pi`. It prints nothing, on success or failure, and exits 0 or 1.

async function main(args: string[], stdin: AsyncIterable<Buffer>): Promise<0 | 1> {
  if (args.length !== 1) return 1;
  const [out = ""] = args;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const narrowed = narrowKeyText(Buffer.concat(chunks).toString("utf8"), forSending);
  // "wx": a path that exists, a link among them, is refused and left as it is.
  const handle = await open(out, "wx", 0o600);
  try {
    await handle.writeFile(narrowed);
    await handle.sync();
  } catch {
    await handle.close();
    await rm(out, { force: true });
    return 1;
  }
  await handle.close();
  return 0;
}

// The entry's whole run, its exit code from its arguments and input; an error is 1. Exported so
// its tests run it in-process; the entry runs it only when it is the process's main module.
export const sendKeys = (args: string[], stdin: AsyncIterable<Buffer>): Promise<0 | 1> =>
  main(args, stdin).catch(() => 1 as const);

if (import.meta.main) process.exitCode = await sendKeys(process.argv.slice(2), process.stdin);
