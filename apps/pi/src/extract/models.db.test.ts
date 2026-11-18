import type { PersonalLogger } from "@intelligence/contracts/personal";
import { createPipeline, loadKeys } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, scanForPlaintext, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

// The model key: `pi models set-key` from standard input, and `pi models import-key` from its own
// environment at the box's start.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Env = Record<string, string>;

const pi = (argv: string[], env: Env, stdin: string[] = []) => runPi(argv, env, { stdin });

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const KEY = "sk-test-sentinel-model-key-7f3a91";
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

async function database(migrations = true): Promise<{ db: TestDatabase; env: Env }> {
  const db = await createTestDatabase({ migrations });
  databases.push(db);
  return { db, env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile } };
}

// The key as the pipeline reads it, through the store.
async function pipelineKey(db: TestDatabase): Promise<string | null> {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: await loadKeys(db.keyFile), log: quiet });
  try {
    return await pipeline.secret("openrouter/key");
  } finally {
    await pipeline.close();
  }
}

const storedAt = async (db: TestDatabase): Promise<unknown[]> =>
  queryAs(db.urls.admin, "select updated_at, xmin::text as version from policy.secrets where name = 'openrouter/key'");

describe("pi models", () => {
  it("the key is stored sealed and found on neither stream", async () => {
    const { db, env } = await database();
    const result = await pi(["models", "set-key"], env, [`${KEY}\n`]);
    expect(result).toEqual({ exit: 0, stdout: "model key stored\n", stderr: "" });
    // Sealed: no column holds it in plaintext.
    expect(await scanForPlaintext(db.urls.admin, [KEY])).toEqual([]);
    expect(await pipelineKey(db)).toBe(KEY);

    // A second key replaces it.
    expect((await pi(["models", "set-key"], env, ["sk-test-second-key\n"])).exit).toBe(0);
    expect(await pipelineKey(db)).toBe("sk-test-second-key");
  });

  it("the pipeline reads it and the writer cannot", async () => {
    const { db, env } = await database();
    expect((await pi(["models", "set-key"], env, [`${KEY}\n`])).exit).toBe(0);
    expect(await pipelineKey(db)).toBe(KEY);
    // pi_writer reads only the secrets under google/: the row is not visible to it.
    expect(await queryAs(db.urls.writer, "select name from policy.secrets where name = 'openrouter/key'")).toEqual([]);
    // The positive control: the admin sees the row.
    expect(await queryAs(db.urls.admin, "select name from policy.secrets where name = 'openrouter/key'")).toEqual([
      { name: "openrouter/key" },
    ]);
  });

  it("import-key stores the key from its environment, and the same value again writes nothing", async () => {
    const { db, env } = await database();
    const first = await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: KEY });
    expect(first).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "model_key_import", code: "stored" })}\n`,
    });
    expect(await pipelineKey(db)).toBe(KEY);
    expect(await scanForPlaintext(db.urls.admin, [KEY])).toEqual([]);
    const written = await storedAt(db);

    const again = await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: KEY });
    expect(again).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "model_key_import", code: "unchanged" })}\n`,
    });
    expect(await storedAt(db)).toEqual(written);

    // The positive control: a different value is written, and the replacement is logged with its
    // own code and never the key.
    const rotated = await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: "sk-test-rotated-key" });
    expect(rotated).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "model_key_import", code: "model_key_replaced" })}\n`,
    });
    expect(await pipelineKey(db)).toBe("sk-test-rotated-key");
  });

  it("import-key over a key the owner rotated with set-key replaces it and says so", async () => {
    const { db, env } = await database();
    expect((await pi(["models", "set-key"], env, ["sk-test-rotated-by-owner\n"])).exit).toBe(0);
    const imported = await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: KEY });
    expect(imported).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "model_key_import", code: "model_key_replaced" })}\n`,
    });
    expect(await pipelineKey(db)).toBe(KEY);
  });

  it("import-key before the migration exits 1 with a code, and imports once the migration has run", async () => {
    const { db, env } = await database(false);
    const early = await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: KEY });
    // The admin's own line, then the command's: codes alone, and never the key.
    expect(early).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${JSON.stringify({ event: "admin_failed", code: "unavailable" })}\n${JSON.stringify({ event: "command_failed", code: "unavailable", reason: "sqlstate_3f000" })}\n`,
    });

    // The next start, after `pi db migrate`.
    const migrate = await pi(["db", "migrate"], {
      PI_DATABASE_URL_BOOTSTRAP: db.urls.bootstrap,
      PI_DATABASE_URL_ADMIN: db.urls.admin,
      PI_DATABASE_URL_WRITER: db.urls.writer,
      PI_DATABASE_URL_READER: db.urls.reader,
      PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
      PI_DATABASE_URL_WORK: db.urls.work,
      PI_DATABASE_URL_RESTRICTED: db.urls.restricted,
    });
    expect(migrate.exit).toBe(0);
    expect((await pi(["models", "import-key"], { ...env, PI_OPENROUTER_KEY: KEY })).exit).toBe(0);
    expect(await pipelineKey(db)).toBe(KEY);
  });
});
