import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@intelligence/personal-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { webhookKeys } from "./webhook-keys.ts";

// The `pia` wrapper's key step. First its entry: its
// run in-process, with the input as a stream and what it prints collected, then once as the box
// runs it, a process of its own from an empty environment, for what only the process shows; then
// the wrapper itself, run by bash with its paths moved under a directory of its own, the terminal
// two files, and `as-pi` a stub that notes its arguments and answers as each test sets.

const ENTRY = fileURLToPath(new URL("./webhook-keys.ts", import.meta.url));
const WRAPPER = join(repoRoot(), "deploy/bin/pi-admin");
const ONE = `cli_${"A".repeat(26)}`;
const TWO = `cli_${"B".repeat(26)}`;
const KEY = "a-routine's-key-0123456789";

const folders: string[] = [];
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "pi-webhook-keys-"));
  folders.push(made);
  return made;
}
afterEach(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

// The entry's run in-process: its exit code and what it printed.
async function run(args: string[], input: string): Promise<{ code: 0 | 1; stdout: string }> {
  let stdout = "";
  const code = await webhookKeys(
    args,
    Readable.from(input === "" ? [] : [Buffer.from(input, "utf8")]),
    (text) => (stdout += text),
  );
  return { code, stdout };
}

// The entry as a process of its own.
function entry(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-sigusr1", ENTRY, ...args], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(input);
  });
}
const quiet = (code: number) => ({ code, stdout: "" });
const keysIn = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

describe("webhook-keys", () => {
  it("set writes the key under the client, mode 0600, and replaces only that client's", async () => {
    const dir = await folder();
    const file = join(dir, "webhooks.json");
    expect(await run(["set", file, ONE], `${KEY}\n`)).toEqual(quiet(0));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await keysIn(file)).toEqual({ [ONE]: KEY });
    expect(await run(["set", file, TWO], "b".repeat(16))).toEqual(quiet(0));
    expect(await run(["set", file, ONE], `${"c".repeat(512)}\n`)).toEqual(quiet(0));
    expect(await keysIn(file)).toEqual({ [ONE]: "c".repeat(512), [TWO]: "b".repeat(16) });
    // The temporary file was renamed over the file: nothing else is left in the folder.
    expect(await readdir(dir)).toEqual(["webhooks.json"]);
  });

  it("rm removes the client's key and keeps the others; with no key or no file it writes nothing", async () => {
    const dir = await folder();
    const file = join(dir, "webhooks.json");
    expect(await run(["rm", file, ONE], "")).toEqual(quiet(0));
    expect(await readdir(dir)).toEqual([]);
    await run(["set", file, ONE], KEY);
    await run(["set", file, TWO], KEY);
    expect(await run(["rm", file, ONE], "")).toEqual(quiet(0));
    expect(await keysIn(file)).toEqual({ [TWO]: KEY });
    const before = (await stat(file)).ino;
    expect(await run(["rm", file, ONE], "")).toEqual(quiet(0));
    expect((await stat(file)).ino).toBe(before);
  });

  it("refuses a key off the format, a client that is no id, a relative path and a file pi notify would refuse, and changes nothing", async () => {
    const dir = await folder();
    const file = join(dir, "webhooks.json");
    await run(["set", file, ONE], KEY);
    const kept = await readFile(file, "utf8");
    for (const key of ["", "short-key", "a".repeat(513), "with a space-in-it", "é".repeat(16), `${KEY}\n\n`]) {
      expect(await run(["set", file, TWO], key), JSON.stringify(key.slice(0, 20))).toEqual(quiet(1));
    }
    expect(await run(["set", file, "cli_short"], KEY)).toEqual(quiet(1));
    expect(await run(["set", "webhooks.json", TWO], KEY)).toEqual(quiet(1));
    expect(await run(["set", file], KEY)).toEqual(quiet(1));
    expect(await readFile(file, "utf8")).toBe(kept);
    await chmod(file, 0o640);
    expect(await run(["set", file, TWO], KEY)).toEqual(quiet(1));
    expect(await run(["rm", file, ONE], "")).toEqual(quiet(1));
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ [ONE]: KEY, own: "x".repeat(44) }));
    expect(await run(["set", file, TWO], KEY)).toEqual(quiet(1));
    expect(await readdir(dir)).toEqual(["webhooks.json"]);
  });

  it("client prints the id from a command's output, or from clients list by name, and nothing else", async () => {
    expect(await run(["client"], `${JSON.stringify({ client: ONE })}\n`)).toEqual({ code: 0, stdout: `${ONE}\n` });
    expect(await run(["client"], JSON.stringify({ client: ONE, removed: true }))).toEqual({
      code: 0,
      stdout: `${ONE}\n`,
    });
    const list = JSON.stringify([
      { id: ONE, name: "chief" },
      { id: TWO, name: "scout" },
    ]);
    expect(await run(["client", "scout"], list)).toEqual({ code: 0, stdout: `${TWO}\n` });
    expect(await run(["client", "nobody"], list)).toEqual(quiet(1));
    expect(await run(["client"], list)).toEqual(quiet(1));
    expect(await run(["client"], JSON.stringify({ client: "cli_short" }))).toEqual(quiet(1));
    expect(await run(["client"], "not json")).toEqual(quiet(1));
  });

  // The one process test of the entry: it starts from an empty environment, prints the client id
  // and nothing else, and prints nothing on a set or a refusal. A cold start of node is slow on a
  // busy machine, so not the 5 s default.
  it("run as a process, client prints the id alone, and set and a refusal print nothing to stdout or stderr", async () => {
    const dir = await folder();
    const file = join(dir, "webhooks.json");
    expect(await entry(["client"], JSON.stringify({ client: ONE }))).toEqual({
      code: 0,
      stdout: `${ONE}\n`,
      stderr: "",
    });
    expect(await entry(["set", file, ONE], `${KEY}\n`)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await keysIn(file)).toEqual({ [ONE]: KEY });
    expect(await entry(["set", file, TWO], "short-key")).toEqual({ code: 1, stdout: "", stderr: "" });
  }, 30_000);
});

// Each step runs bash and, for the key step, a node process: slow on a busy machine, so not the
// 5 s default.
describe("bin/pi-admin's key step", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  const file = (): string => join(root, "data", "webhooks.json");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-admin-"));
    const text = (await readFile(WRAPPER, "utf8"))
      .replaceAll('"$(id -u)" -eq 0', "0 -eq 0")
      .replaceAll("/usr/bin/setpriv --reuid=pinotify --regid=pinotify --init-groups ", "")
      .replaceAll("/usr/local/bin/node", `"${process.execPath}"`)
      .replaceAll("/opt/intelligence/apps/pi/src/work/webhook-keys.ts", `"${ENTRY}"`)
      .replaceAll("/usr/local/lib/pi/as-pi", join(root, "as-pi"))
      .replaceAll("/data/pinotify/", `${root}/data/`)
      .replaceAll("< /dev/tty", `< ${root}/tty-in`)
      .replaceAll("> /dev/tty", `> ${root}/tty-out`)
      // The lock is the box's (flock is util-linux's); here only its file moves.
      .replaceAll("/run/pi-root/", `${root}/`)
      .replaceAll("/usr/bin/flock 9", "true");
    expect(text).not.toMatch(/\/dev\/tty|\/run\/pi-root|\/data\/pinotify|flock 9/);
    script = join(root, "pi-admin");
    await writeFile(script, text);
    await mkdir(join(root, "data"));
    // The stub notes its call, then answers from root's files: `clients list` from list.out, or
    // fails with no list.out; any other command from out and status.
    await writeFile(
      join(root, "as-pi"),
      `#!/bin/sh\necho "$*" >> ${root}/calls\nif [ "$*" = "admin clients list" ]; then cat ${root}/list.out; exit $?; fi\n[ ! -f ${root}/out ] || cat ${root}/out\nexit $(cat ${root}/status 2> /dev/null || echo 0)\n`,
    );
    await chmod(join(root, "as-pi"), 0o755);
    await writeFile(join(root, "list.out"), JSON.stringify([{ id: ONE, name: "chief" }]));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const pia = async (args: string[], answer: { tty?: string; out?: string; status?: number } = {}) => {
    await writeFile(join(root, "tty-in"), answer.tty ?? "");
    await rm(join(root, "tty-out"), { force: true });
    await rm(join(root, "calls"), { force: true });
    await writeFile(join(root, "out"), answer.out ?? "");
    await writeFile(join(root, "status"), String(answer.status ?? 0));
    const ran = spawnSync("bash", [script, ...args], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    const calls = await readFile(join(root, "calls"), "utf8").catch(() => "");
    const shown = await readFile(join(root, "tty-out"), "utf8").catch(() => null);
    return {
      status: ran.status,
      stdout: ran.stdout,
      stderr: ran.stderr,
      calls: calls.split("\n").filter((line) => line !== ""),
      shown,
    };
  };
  const SET = ["clients", "webhook", "set", "chief", "https://agent.example.org/pi-notice"];

  it("set stores the key the owner entered under the client the command printed, and prints it nowhere", async () => {
    await rm(file(), { force: true });
    const ran = await pia(SET, { tty: `${KEY}\n`, out: JSON.stringify({ client: ONE }) });
    expect(ran.stderr).toBe("\n");
    expect(ran.status).toBe(0);
    expect(ran.calls).toEqual([`admin ${SET.join(" ")}`]);
    expect(await keysIn(file())).toEqual({ [ONE]: KEY });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(ran.shown).toBeNull();
    expect(`${ran.stdout}${ran.stderr}`).not.toContain(KEY);
    expect(ran.stdout).toBe(`${JSON.stringify({ client: ONE })}\n`);
  });

  it("set with no key entered makes one, stores it, and shows it once on the terminal alone", async () => {
    await rm(file(), { force: true });
    const ran = await pia(SET, { tty: "\n", out: JSON.stringify({ client: ONE }) });
    expect(ran.status).toBe(0);
    const stored = ((await keysIn(file())) as Record<string, string>)[ONE] ?? "";
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(ran.shown).toBe(`webhook key, shown once: ${stored}\n`);
    expect(`${ran.stdout}${ran.stderr}`).not.toContain(stored);
  });

  it("set refuses a key off the format before it runs anything", async () => {
    await rm(file(), { force: true });
    for (const key of ["short-key", "a".repeat(513), "with a space-in-it", "é".repeat(16)]) {
      const ran = await pia(SET, { tty: `${key}\n`, out: JSON.stringify({ client: ONE }) });
      expect(ran.status, JSON.stringify(key.slice(0, 20))).toBe(1);
      expect(ran.calls).toEqual([]);
      expect(ran.shown).toBeNull();
    }
    await expect(stat(file())).rejects.toThrow();
  });

  it("set writes nothing and prints nothing of its own when the command fails, and refuses other arguments", async () => {
    await rm(file(), { force: true });
    const ran = await pia(SET, { tty: "\n", status: 1 });
    expect(ran.status).toBe(1);
    expect(ran.shown).toBeNull();
    expect(ran.stdout).toBe("");
    await expect(stat(file())).rejects.toThrow();
    const usage = await pia(SET.slice(0, 4), { tty: `${KEY}\n` });
    expect(usage.status).toBe(2);
    expect(usage.calls).toEqual([]);
  });

  it("webhook rm and revoke remove the client's key on success, and leave it on failure", async () => {
    await writeFile(file(), JSON.stringify({ [ONE]: KEY, [TWO]: KEY }), { mode: 0o600 });
    expect(
      (
        await pia(["clients", "webhook", "rm", "chief"], {
          out: JSON.stringify({ client: ONE, removed: true }),
          status: 1,
        })
      ).status,
    ).toBe(1);
    expect(await keysIn(file())).toEqual({ [ONE]: KEY, [TWO]: KEY });
    expect(
      (await pia(["clients", "webhook", "rm", "chief"], { out: JSON.stringify({ client: ONE, removed: true }) }))
        .status,
    ).toBe(0);
    expect(await keysIn(file())).toEqual({ [TWO]: KEY });
    await writeFile(file(), JSON.stringify({ [ONE]: KEY, [TWO]: KEY }), { mode: 0o600 });
    const failed = await pia(["clients", "revoke", "chief"], { status: 1 });
    expect(failed.calls).toEqual(["admin clients list", "admin clients revoke chief"]);
    expect(await keysIn(file())).toEqual({ [ONE]: KEY, [TWO]: KEY });
    expect((await pia(["clients", "revoke", "chief"])).status).toBe(0);
    expect(await keysIn(file())).toEqual({ [TWO]: KEY });
  });

  it("a revoke whose client list failed says the key file was not changed, and exits 1", async () => {
    await writeFile(file(), JSON.stringify({ [ONE]: KEY }), { mode: 0o600 });
    const list = await readFile(join(root, "list.out"), "utf8");
    await rm(join(root, "list.out"));
    const ran = await pia(["clients", "revoke", "chief"]);
    await writeFile(join(root, "list.out"), list);
    expect(ran.status).toBe(1);
    expect(ran.calls).toEqual(["admin clients list", "admin clients revoke chief"]);
    expect(ran.stderr).toContain("the webhook key file was not changed");
    expect(await keysIn(file())).toEqual({ [ONE]: KEY });
  });

  it("every other command is pi's as before, with no key step", async () => {
    const ran = await pia(["status"], { out: "{}" });
    expect(ran).toMatchObject({ status: 0, stdout: "{}", calls: ["admin status"], shown: null });
  });
});
