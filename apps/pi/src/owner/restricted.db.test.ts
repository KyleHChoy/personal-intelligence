import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refused as failed, pi } from "../test-support/run-pi.ts";

// The restricted categories' owner commands through `run`: a category's key into the restricted file and
// then its row, `pi restricted list`, and `pi status` over both key files. Key files are written by `pi
// keys init` into a folder of the test's own.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DONE = { exit: 0, stdout: "", stderr: "" };

const folders: string[] = [];
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  for (const database of databases.splice(0)) await database.drop();
});

// A migrated database whose key file `pi keys init` wrote, the path of a restricted file not yet
// made beside it, and the owner's environment with both.
async function ownerDatabase(): Promise<{ db: TestDatabase; env: Env; restrictedFile: string; folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), "pi-restricted-test-"));
  folders.push(folder);
  const keyFile = join(folder, "keys.json");
  expect(await pi(["keys", "init", "--compartments", "own"], { PI_KEY_FILE: keyFile })).toEqual(DONE);
  const db = await createTestDatabase({ keyFile });
  databases.push(db);
  const restrictedFile = join(folder, "restricted-keys.json");
  return {
    db,
    folder,
    restrictedFile,
    env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile, PI_RESTRICTED_KEY_FILE: restrictedFile },
  };
}

const categories = async (db: TestDatabase): Promise<string[]> =>
  (
    await queryAs<{ category: string }>(
      db.urls.admin,
      "select category from policy.restricted_categories order by category",
    )
  ).map((row) => row.category);
const restrictedKeys = async (path: string): Promise<string[]> =>
  Object.keys((JSON.parse(await readFile(path, "utf8")) as { compartments: object }).compartments);

// One owner decision under `label`, as a row that carries a compartment.
const ULID = "0".repeat(25);
const decisionUnder = (db: TestDatabase, n: number, label: string[]): Promise<unknown> =>
  queryAs(
    db.urls.admin,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'answer', 0, now(), $3)",
    [`rul_${ULID}${n}`, `restricted-test-${n}`, label],
  );

describe("pi restricted", () => {
  it("add-compartment restricted:health writes the key before the table row", async () => {
    const { db, env, restrictedFile, folder } = await ownerDatabase();
    // A restricted file that cannot be written leaves no row.
    const unwritable = join(folder, "no-such-folder", "restricted-keys.json");
    expect(
      await pi(["keys", "add-compartment", "restricted:health"], { ...env, PI_RESTRICTED_KEY_FILE: unwritable }),
    ).toEqual(failed("key_file_refused"));
    expect(await categories(db)).toEqual([]);

    // The positive control: the key in the restricted file, then the row.
    expect(await pi(["keys", "add-compartment", "restricted:health"], env)).toEqual(DONE);
    expect(await restrictedKeys(restrictedFile)).toEqual(["restricted:health"]);
    expect(await categories(db)).toEqual(["health"]);
    // Run again, after a stop between the key and the row: the key is there and the row is written.
    await queryAs(db.urls.admin, "delete from policy.restricted_categories");
    expect(await pi(["keys", "add-compartment", "restricted:health"], env)).toEqual(DONE);
    expect(await categories(db)).toEqual(["health"]);
    expect(await restrictedKeys(restrictedFile)).toEqual(["restricted:health"]);
  });

  it("restricted list prints counts and no content", async () => {
    const { db, env } = await ownerDatabase();
    expect(await pi(["restricted", "list"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ categories: [] })}\n`,
      stderr: "",
    });
    expect(await pi(["keys", "add-compartment", "restricted:money"], env)).toEqual(DONE);
    expect(await pi(["keys", "add-compartment", "restricted:health"], env)).toEqual(DONE);
    expect(await categories(db)).toEqual(["health", "money"]);
    expect(await pi(["restricted", "list"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({
        categories: [
          { category: "health", items: 0, pending: 0, lifts: 0 },
          { category: "money", items: 0, pending: 0, lifts: 0 },
        ],
      })}\n`,
      stderr: "",
    });
  });

  it("status names restricted:money when a row carries it and the restricted file lacks it", async () => {
    const { db, env } = await ownerDatabase();
    expect(await pi(["keys", "add-compartment", "restricted:health"], env)).toEqual(DONE);
    await decisionUnder(db, 1, ["own", "restricted:health"]);
    await decisionUnder(db, 2, ["own", "restricted:money"]);
    const missing = async (given: Env): Promise<string[]> => {
      const status = await pi(["status"], given);
      expect(status.exit).toBe(0);
      return (JSON.parse(status.stdout) as { missingKeys: string[] }).missingKeys;
    };
    expect(await missing(env)).toEqual(["restricted:money"]);
    // The control: with the general file alone, both restricted compartments are missing.
    const { PI_RESTRICTED_KEY_FILE: _unused, ...general } = env;
    expect(await missing(general)).toEqual(["restricted:health", "restricted:money"]);
  });
});
