import { spawn } from "node:child_process";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { isCoded, type PersonalLogger } from "@intelligence/contracts/personal";
import { journalMarkText, journalPath, readJournal } from "@intelligence/personal-store";
import { narrowKeyText } from "@intelligence/personal-store/keys";
import type { CommandContext } from "../command-types.ts";
import { codeOf, refusal } from "../env.ts";
import { withAdmin } from "../owner/owner-kit.ts";

// The agent endpoint's key file: `pi mcp` and
// `pi http` run as a Unix user of their own and read a copy of the key file narrowed to what any
// client can be served or write. That is `public`, every `agent:` key, and every compartment some
// registered client holds or once held. `own` follows the same rule as an employer's compartment
// or `declassified`: it is in the copy only once a client is cleared for it. Nothing the endpoint
// does needs `own` for a client not cleared for it: a record is sealed under its writer's
// clearance and agent key (`policy.record_label`), a research request under the clearance without
// the agent key, and a read opens only what the clearance covers. The one seal under `own` alone,
// a Lens capture, is made for a device client, which always holds `own`. Restricted keys are in
// another file and never here.
export function agentKeep(held: readonly string[]): (compartment: string) => boolean {
  const named = new Set(held);
  return (compartment) => compartment === "public" || compartment.startsWith("agent:") || named.has(compartment);
}

// The compartments the copy has ever held, beside the key file and pi's alone, one JSON array of
// names. A running `pi http` refuses a key that goes away (`reloadingKeys`), so each name stays in
// the copy for good, even once no client holds it. It is pi's record, never read from the copy,
// which the endpoint's own user can write: a name planted there must not widen the copy.
export const heldPath = (keyFile: string): string => `${keyFile}.agent-held`;

async function heldBefore(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isCoded(error, "ENOENT")) return [];
    throw refusal("key_file_refused");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refusal("key_file_refused");
  }
  if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) throw refusal("key_file_refused");
  return value;
}

// The record written beside its place, mode 0600, synced and renamed over it.
async function recordHeld(path: string, names: readonly string[]): Promise<void> {
  const next = `${path}.new`;
  await rm(next, { force: true });
  const handle = await open(next, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(names)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(next, path);
}

// The names the copy keeps: every one recorded before and every one a client holds now, recorded
// before the copy is printed, so a copy never holds a name its record lacks.
export async function heldCompartments(
  keyFile: string,
  clients: readonly string[],
  record = heldPath(keyFile),
): Promise<string[]> {
  const before = await heldBefore(record);
  const held = [...new Set([...before, ...clients])].sort();
  if (held.length !== before.length) await recordHeld(record, held);
  return held;
}

// The HTTPS endpoint's record, beside the stdio endpoint's: its copy is narrowed to the clients that
// may call over HTTPS, so a compartment only the reasoner holds never enters it.
export const httpHeldPath = (keyFile: string): string => `${keyFile}.http-held`;

// Whether a client's keys go to the HTTPS endpoint's copy: every client but the reasoner, which
// calls the agent API over stdio alone, from the box.
export const servedOverHttp = (client: { kind: string }): boolean => client.kind !== "reasoner";

// `pi keys agent-copy [--http]`: the narrowed key file's text on stdout, for the box's root wrapper
// to hand to the endpoint's user, which writes it. Never to a terminal: it is key material. With
// `--http`, the copy of `pi http`'s own user, narrowed to the clients that may call over HTTPS.
export async function keysAgentCopy(context: CommandContext): Promise<0> {
  if (context.io.stdoutIsTTY) throw refusal("not_a_pipe", "keys agent-copy writes a key file: pipe it");
  const http = context.values.http === true;
  let clients: string[] = [];
  // Only the clients' compartments are read, so it runs while the database is behind the journal,
  // as during a restore: the endpoint's copy follows the key file, whatever the database holds.
  await withAdmin(
    context,
    async (admin) => {
      clients = (await admin.clients.listClients())
        .filter((client) => !http || servedOverHttp(client))
        .flatMap((client) => client.compartments);
    },
    { level: "skip" },
  );
  const keyFile = context.env.PI_KEY_FILE ?? "";
  const held = await heldCompartments(keyFile, clients, http ? httpHeldPath(keyFile) : heldPath(keyFile));
  const whole = await readFile(keyFile, "utf8");
  context.io.stdout.write(narrowKeyText(whole, agentKeep(held)));
  return 0;
}

// `pi keys agent-journal`: the erasure journal's mark (its last sequence number alone) on stdout,
// for the agent endpoint's user, whose reader compares nothing else. The journal must exist.
export async function keysAgentJournal(context: CommandContext): Promise<0> {
  const { seq } = await readJournal(journalPath(context.env.PI_KEY_FILE ?? ""), { mustExist: true });
  context.io.stdout.write(journalMarkText(seq));
  return 0;
}

// The mark handed to the agent endpoint's copy; true when it was written.
export type HandMark = (mark: string) => Promise<boolean>;

// COMMAND ARGS with the mark on its standard input; true when it exited 0 within boundMs. Its
// output and its errors go nowhere, so nothing it writes reaches pi's log; a refusal is its exit
// status alone. Past the bound it is KILLed and the hand is false, whatever it does then: a child
// stopped by a signal (SIGSTOP ignores the TERM Node's own timeout sends) or one that never ends
// holds up no later hand on the chain behind it.
export function handThrough(command: string, args: readonly string[], boundMs: number): HandMark {
  return (mark) =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, boundMs);
      const end = (handed: boolean): void => {
        clearTimeout(timer);
        resolve(handed);
      };
      child.once("error", () => end(false));
      child.once("exit", (code) => end(code === 0));
      child.stdin.on("error", () => undefined);
      child.stdin.end(mark);
    });
}

// The box's way, as its timer hands it: lib/agent-file journal as each endpoint's user, pimcp for
// `pi mcp` and pihttp for `pi http`, through pi's sudo rule for each. sudo's real uid is pi, so pi
// can KILL it; each ended after 10 seconds, as the timer ends it. True when both were written.
const handAs = (user: string): HandMark =>
  handThrough("/usr/bin/sudo", ["-n", "-u", user, "/usr/local/lib/pi/agent-file", "journal"], 10_000);
const handToMcp = handAs("pimcp");
const handToHttp = handAs("pihttp");
const handThroughSudo: HandMark = async (mark) => {
  const [mcp, http] = await Promise.all([handToMcp(mark), handToHttp(mark)]);
  return mcp && http;
};

// `pi web serve --agent-journal` (the box's web-serve): the owner's page writes to the erasure
// journal as pi, a lift of a release among its writes, and root's lib/agent-keys runs only at a
// start and after a pia command. So after each write, whatever its end, once its transaction is
// over, the journal's mark is handed to the agent endpoint's copy when the journal changed since
// the last mark handed. A journal ahead of the database (a transaction that died after its line
// was appended) is handed too: the copy then is ahead of the database, and the endpoint answers
// unavailable until `pia erase replay` brings the database level. One at a time, so marks land
// in order; lib/agent-file refuses a lower mark in any case. A failure is one agent_journal_failed
// line with its code, and the next write, or the timer's next loop, tries again. The page starts
// it and does not wait on it, and each hand is bounded (handThrough), so the chain never stalls.
export function agentJournalRefresh(
  keyFile: string,
  log: PersonalLogger,
  hand: HandMark = handThroughSudo,
): () => Promise<void> {
  const path = journalPath(keyFile);
  let handed: number | null = null;
  let last: Promise<void> = Promise.resolve();
  const once = async (): Promise<void> => {
    const size = await stat(path).then(
      (found) => found.size,
      () => null,
    );
    if (size === null || size === handed) return;
    try {
      const { seq } = await readJournal(path, { mustExist: true });
      if (!(await hand(journalMarkText(seq)))) throw refusal("agent_file_refused");
      handed = size;
    } catch (error) {
      log.warn({ event: "agent_journal_failed", code: codeOf(error) });
    }
  };
  // At most one run waits: it reads the live journal when it starts, so a second would add nothing.
  let waiting = false;
  return () => {
    if (waiting) return last;
    waiting = true;
    last = last.then(() => {
      waiting = false;
      return once();
    });
    return last;
  };
}
