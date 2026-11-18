import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fingerprint, generateKeyFile, loadKeys } from "@intelligence/personal-store";
import { afterEach, describe, expect, it } from "vitest";
import { sendKeys } from "./send-keys.ts";

// The send wrapper's narrowing entry: the key file's bytes on its standard input, one argument, the
// output path, and nothing printed. Its run is tested in-process, with the input as a stream; the
// last test runs it as the box runs it, a process of its own from an empty environment, for what
// only the process shows: that it starts, and prints nothing.

const ENTRY = fileURLToPath(new URL("./send-keys.ts", import.meta.url));

const folders: string[] = [];
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "pi-send-keys-"));
  folders.push(made);
  return made;
}
afterEach(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

// The entry's run in-process: its exit code.
const run = (args: string[], input: string): Promise<0 | 1> =>
  sendKeys(args, Readable.from(input === "" ? [] : [Buffer.from(input, "utf8")]));

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

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("send-keys", () => {
  it("send-keys writes the fingerprint key, own and every agent: key and no other, mode 0600", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path, ["own", "public", "employer:example", "agent:one", "agent:two"]);
    const out = join(dir, "copy.json");
    expect(await run([out], await readFile(path, "utf8"))).toBe(0);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const whole = await loadKeys(path);
    const copy = await loadKeys(out);
    expect([...copy.compartments.keys()].sort()).toEqual(["agent:one", "agent:two", "own"]);
    for (const [name, key] of copy.compartments) expect(key).toBe(whole.compartments.get(name));
    expect(fingerprint(copy, "address", "a@example.com")).toBe(fingerprint(whole, "address", "a@example.com"));
  });

  it("send-keys refuses an existing output, empty input and input that is not a key file, and writes nothing", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path, ["own", "agent:one"]);
    const whole = await readFile(path, "utf8");
    // An existing output is left as it was.
    const existing = join(dir, "existing.json");
    await writeFile(existing, "kept", { mode: 0o600 });
    expect(await run([existing], whole)).toBe(1);
    expect(await readFile(existing, "utf8")).toBe("kept");
    // A key whose check fails is not a key file.
    const other = join(dir, "other.json");
    await generateKeyFile(other, ["own", "agent:one"]);
    const swapped = JSON.parse(whole) as { compartments: Record<string, unknown> };
    swapped.compartments.own = (
      JSON.parse(await readFile(other, "utf8")) as { compartments: Record<string, unknown> }
    ).compartments.own;
    for (const input of ["", "not a key file", "{}", JSON.stringify(swapped)]) {
      const out = join(dir, "copy.json");
      expect(await run([out], input), JSON.stringify(input.slice(0, 20))).toBe(1);
      expect(await exists(out)).toBe(false);
    }
    // No folder to write into.
    expect(await run([join(dir, "missing", "copy.json")], whole)).toBe(1);
  });

  it("send-keys refuses no argument and two arguments", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path, ["own"]);
    const whole = await readFile(path, "utf8");
    expect(await run([], whole)).toBe(1);
    const [one, two] = [join(dir, "one.json"), join(dir, "two.json")];
    expect(await run([one, two], whole)).toBe(1);
    expect(await exists(one)).toBe(false);
    expect(await exists(two)).toBe(false);
  });

  // The one process test: the entry starts from an empty environment, writes its file, and prints
  // nothing to stdout or stderr, on success or failure. A cold start of node is slow on a busy
  // machine, so not the 5 s default.
  it("send-keys, run as a process, writes the key file and prints nothing to stdout or stderr", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path, ["own", "agent:one"]);
    const whole = await readFile(path, "utf8");
    const out = join(dir, "one.json");
    expect(await entry([out], whole)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect([...(await loadKeys(out)).compartments.keys()].sort()).toEqual(["agent:one", "own"]);
    expect(await entry([out], whole)).toEqual({ code: 1, stdout: "", stderr: "" });
    expect(await entry([join(dir, "two.json")], "{")).toEqual({ code: 1, stdout: "", stderr: "" });
  }, 30_000);
});
