import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { createPipeline, createWriter, loadKeys } from "@intelligence/personal-store";
import { createTestDatabase, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run, SCRIPT_READS } from "../commands.ts";

// The exact output of the commands the box's scripts read (SCRIPT_READS in the command table), with
// the real command against a real database. box-scripts.test.ts gives the scripts these same words
// from stubs, so the two together hold both ends of each link.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// `clients webhook set` asks the resolver about its host before it writes; a test asks nobody.
vi.mock("../work/notify.ts", async (original) => ({
  ...(await original<typeof import("../work/notify.ts")>()),
  resolveChecked: async () => "ok",
}));

type Env = Record<string, string>;
const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };

async function pi(argv: string[], env: Env, stdin: string[] = []): Promise<{ exit: number; stdout: string }> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const sink = (into: Buffer[]) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        into.push(chunk);
        done();
      },
    });
  const io = { stdout: sink(out), stderr: sink(err), stdin: Readable.from(stdin), stdoutIsTTY: false };
  const exit = await run(argv, env, io);
  // The stderr lines name a refusal, for the failure's message; no script here reads them.
  if (exit !== 0) throw new Error(`pi ${argv.join(" ")}: ${exit} ${Buffer.concat(err).toString("utf8")}`);
  return { exit, stdout: Buffer.concat(out).toString("utf8") };
}

describe("what the box's scripts read", () => {
  let folder = "";
  let keyFile = "";
  let db: TestDatabase;
  let admin: Env;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-script-outputs-"));
    keyFile = join(folder, "keys.json");
    expect((await pi(["keys", "init"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
    db = await createTestDatabase({ keyFile });
    admin = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile };
  });
  afterAll(async () => {
    await db.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it("names each of these in the table", () => {
    for (const name of [
      "health open",
      "health dream-due",
      "status",
      "clients list",
      "clients revoke",
      "sync",
      "extract",
    ])
      expect(SCRIPT_READS[name], name).toBeDefined();
  });

  it("health open prints one whole number, health dream-due one line the timer can split", async () => {
    expect(await pi(["health", "open"], admin)).toEqual({ exit: 0, stdout: "0\n" });
    const due = await pi(["health", "dream-due"], admin);
    expect(due.exit).toBe(0);
    expect(due.stdout).toMatch(/^(due \d{4}-\d{2}-\d{2}|not_due)\n$/);
  });

  it("status --storage prints one of the timer's four words", async () => {
    const storage = await pi(["status", "--storage"], admin);
    expect(storage.exit).toBe(0);
    expect(storage.stdout).toMatch(/^(ok|warn_70|warn_85|ceiling)\n$/);
  });

  it("the client commands print what pi-admin's key step reads", async () => {
    const added = await pi(["clients", "add", "hooked", "--own"], admin);
    expect(added.exit).toBe(0);
    const rows = JSON.parse((await pi(["clients", "list"], admin)).stdout) as { id: string; name: string }[];
    const id = rows.find((row) => row.name === "hooked")?.id;
    expect(id).toEqual(expect.any(String));

    const set = await pi(["clients", "webhook", "set", "hooked", "https://hooks.example.org/in"], admin);
    expect(set.exit).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ client: id });
    const removed = await pi(["clients", "webhook", "rm", "hooked"], admin);
    expect(removed.exit).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ client: id });

    // Printing anything here would reach the owner's terminal among pia's own lines.
    expect(await pi(["clients", "revoke", "hooked"], admin)).toEqual({ exit: 0, stdout: "" });
  });

  it("a row's own hint prints with its code, whether pi or a package raised it", async () => {
    await expect(pi(["retain", "set", "mail_held", "--days", "30"], admin)).rejects.toThrow(
      "only capture_moment, capture_block and capture_transcript have retention so far",
    );
    await expect(pi(["oauth", "approve", "nobody", "--registration", "ffffffff"], admin)).rejects.toThrow(
      /registration/,
    );
  });

  it("sync --records prints busy and exits 0 while a sync holds the lock", async () => {
    const writer = createWriter({ url: db.urls.writer, keys: await loadKeys(keyFile), log: quiet });
    try {
      const inside = await writer.withSyncLock(() =>
        pi(["sync", "--records"], { PI_DATABASE_URL_WRITER: db.urls.writer, PI_KEY_FILE: keyFile }),
      );
      expect(inside).toEqual({ exit: 0, stdout: "busy\n" });
    } finally {
      await writer.close();
    }
  });

  it("extract and dream print busy and exit 0 while a run holds the extract lock", async () => {
    const env = {
      PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
      PI_KEY_FILE: keyFile,
      PI_EXTRACT_MODEL: "synthetic/not-a-model",
    };
    await pi(["models", "set-key"], admin, ["sk-or-synthetic-key\n"]);
    const store = createPipeline({ url: db.urls.pipeline, keys: await loadKeys(keyFile), log: quiet });
    try {
      const inside = await store.withExtractLock(async () => ({
        extract: await pi(["extract"], env),
        dream: await pi(["dream"], env),
      }));
      expect(inside).toEqual({ extract: { exit: 0, stdout: "busy\n" }, dream: { exit: 0, stdout: "busy\n" } });
    } finally {
      await store.close();
    }
  });
});
