import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi } from "../test-support/extract-fixtures.ts";

// `pi learn silences` through `run`, on a database of its own. Silences are written as the learning
// store's tests write them, as pi_admin. Made-up values only.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

async function owner(silences: number): Promise<{ db: TestDatabase; env: Record<string, string> }> {
  const db = await createTestDatabase();
  databases.push(db);
  for (let n = 0; n < silences; n += 1) {
    await queryAs(
      db.urls.admin,
      `insert into ledger.silences (request_id, created_at, created_by, compartments, reason, wake_source, wake_key, day)
       values ($1, now() - interval '1 day', 'system:work', '{own}', 'nothing_to_do', 'daily_sweep', $2, current_date)`,
      [`silence-req-${n}`, `sweep:learn-${n}`],
    );
  }
  return { db, env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile } };
}

const count = async (db: TestDatabase, table: string): Promise<number> =>
  (await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`))[0]?.n ?? -1;
const verdicts = (db: TestDatabase) =>
  queryAs<{ answer: string; details: { hurried: boolean }; card_id: string | null }>(
    db.urls.admin,
    "select answer, details, card_id from knowledge.owner_decisions where kind = 'silence_verdict' order by decided_at, id",
  );

describe("pi learn silences", () => {
  it("the command prints nothing to a pipe, and draws nothing", async () => {
    const { db, env } = await owner(2);
    const result = await pi(["learn", "silences"], env);
    expect(result).toMatchObject({ exit: 1, stdout: "" });
    expect(await count(db, "ledger.silence_samples")).toBe(0);
  });

  it("the samples are stored before the first is shown: an input that ends at once keeps them all, pending", async () => {
    const { db, env } = await owner(3);
    const result = await pi(["learn", "silences", "--sample", "3"], env, { tty: true, stdin: [] });
    expect(result.exit).toBe(0);
    expect(await count(db, "ledger.silence_samples")).toBe(3);
    // One shown, its view written, and no answer.
    expect(await count(db, "ledger.owner_views")).toBe(1);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)?.replace(/^.*: /, "") ?? "{}")).toEqual({
      answered: 0,
      skipped: 0,
    });
    expect(result.stdout).toContain("reason: nothing_to_do");
    expect(result.stdout).toContain("wake: daily_sweep sweep:learn-");
  });

  it("each answer is a verdict with hurried, a skip stores nothing, and --pending shows the skipped one again", async () => {
    const { db, env } = await owner(3);
    // A word that is no answer, even one every object inherits, is asked again.
    const first = await pi(["learn", "silences"], env, { tty: true, stdin: ["constructor\n", "y\n", "s\n", "n\n"] });
    expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout.trim().split("\n").at(-1)?.replace(/^.*: /, "") ?? "{}")).toEqual({
      answered: 2,
      skipped: 1,
    });
    // Answered at once, so each is stored hurried.
    expect(await verdicts(db)).toEqual([
      { answer: "missed", details: { hurried: true }, card_id: null },
      { answer: "fine", details: { hurried: true }, card_id: null },
    ]);
    expect(await count(db, "ledger.owner_views")).toBe(3);

    const again = await pi(["learn", "silences", "--pending"], env, { tty: true, stdin: ["n\n"] });
    expect(again.exit).toBe(0);
    expect(again.stdout.split("Should the system have done something?").length - 1).toBe(1);
    expect(await count(db, "ledger.silence_samples")).toBe(3);
    expect((await verdicts(db)).length).toBe(3);
    // Nothing is left open, and every silence was sampled: a new draw finds none.
    const none = await pi(["learn", "silences", "--pending"], env, { tty: true, stdin: [] });
    expect(JSON.parse(none.stdout.trim())).toEqual({ answered: 0, skipped: 0 });
  });
});
