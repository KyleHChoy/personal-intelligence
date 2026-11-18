import { randomBytes } from "node:crypto";
import type { CardId, NewCard, PersonalLogger } from "@intelligence/contracts/personal";
import { createAdmin } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

// The queue's commands through `run`, on a database of their own.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

const pi = (argv: string[], env: Env, tty = false) => runPi(argv, env, { tty });

// A database, its owner environment, and a way to raise a card on it.
async function owner(): Promise<{ db: TestDatabase; env: Env; raise(over: Partial<NewCard>): Promise<CardId> }> {
  const db = await createTestDatabase();
  databases.push(db);
  const env = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
  const raise = async (over: Partial<NewCard>): Promise<CardId> => {
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      const id = `crd_${randomBytes(13).toString("hex").toUpperCase()}` as CardId;
      await admin.cards.raiseCard({
        id,
        requestId: `req-${randomBytes(8).toString("hex")}`,
        kind: "notice",
        author: "system:test",
        options: ["acknowledge"],
        target: null,
        refs: [],
        compartments: ["own"],
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: null,
        run: null,
        body: null,
        bodyFrom: null,
        ...over,
      });
      return id;
    } finally {
      await admin.close();
    }
  };
  return { db, env, raise };
}

describe("pi review, show, decide and veto", () => {
  it("show prefixes a model's line and leaves a code line bare", async () => {
    const { env, raise } = await owner();
    const id = await raise({ body: "canary-model-said", bodyFrom: "model" });
    const shown = await pi(["show", id], env, true);
    expect(shown.exit).toBe(0);
    const lines = shown.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("model: canary-model-said");
    // The kind's own lines are code's, and bare.
    expect(lines).toContain("kind: notice");
    expect(lines.slice(0, -1).every((line) => !/^(source|model|agent|owner): /.test(line))).toBe(true);
    // review lists it, by id and kind and nothing it says.
    const listed = await pi(["review"], env, true);
    expect(listed.exit).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([{ id, kind: "notice", state: "pending" }]);
    expect(listed.stdout).not.toContain("canary");
  });

  it("pi show writes one view row with surface cli, and a second show a second row with the first left the first (learning R8)", async () => {
    const { db, env, raise } = await owner();
    const id = await raise({ compartments: ["employer:example", "own"] });
    const views = () =>
      queryAs<{ target_kind: string; target_id: string; surface: string; shown_at: Date; compartments: string[] }>(
        db.urls.admin,
        "select target_kind, target_id, surface, shown_at, compartments from ledger.owner_views order by id",
      );
    expect((await pi(["show", id], env, true)).exit).toBe(0);
    const [first] = await views();
    expect(first).toMatchObject({
      target_kind: "card",
      target_id: id,
      surface: "cli",
      compartments: ["employer:example", "own"],
    });
    expect((await pi(["show", id], env, true)).exit).toBe(0);
    const both = await views();
    expect(both).toHaveLength(2);
    expect(both[0]).toEqual(first);
    // review lists cards and writes no view: a card is seen when it is shown.
    expect((await pi(["review"], env, true)).exit).toBe(0);
    expect(await views()).toHaveLength(2);
  });

  it("pi learn label labels a decided card afterwards, with no card id, and refuses one not decided (learning R6)", async () => {
    const { db, env, raise } = await owner();
    const id = await raise({});
    expect(await pi(["learn", "label", id, "--labels", "acted"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${JSON.stringify({ event: "command_failed", code: "not_decided" })}\n`,
    });
    expect((await pi(["decide", id, "--answer", "acknowledge"], env)).exit).toBe(0);
    const labelled = await pi(["learn", "label", id, "--labels", "acted,novel"], env);
    expect(labelled.exit).toBe(0);
    const { ruling } = JSON.parse(labelled.stdout) as { ruling: string };
    const cleared = await pi(["learn", "label", id, "--labels="], env);
    expect(cleared.exit).toBe(0);
    expect(
      await queryAs(
        db.urls.admin,
        "select id, card_id, supersedes, labels, batch from knowledge.owner_decisions where kind = 'card_label' order by decided_at, id",
      ),
    ).toEqual([
      { id: ruling, card_id: null, supersedes: null, labels: ["acted", "novel"], batch: false },
      {
        id: (JSON.parse(cleared.stdout) as { ruling: string }).ruling,
        card_id: null,
        supersedes: ruling,
        labels: [],
        batch: false,
      },
    ]);
  });

  it("decide prints each card's ruling id and no content", async () => {
    const { db, env, raise } = await owner();
    const first = await raise({ body: "canary-first", bodyFrom: "model" });
    const second = await raise({ body: "canary-second", bodyFrom: "code" });
    const decided = await pi(["decide", first, second, "--answer", "acknowledge", "--labels", "correct"], env);
    expect(decided.exit).toBe(0);
    const printed = JSON.parse(decided.stdout) as { card: string; ruling: string }[];
    expect(printed.map((one) => one.card)).toEqual([first, second]);
    expect(printed.every((one) => /^rul_[0-9A-HJKMNP-TV-Z]{26}$/.test(one.ruling))).toBe(true);
    expect(decided.stdout).not.toContain("canary");
    expect(
      await queryAs(db.urls.admin, "select batch, labels from knowledge.owner_decisions order by card_id"),
    ).toEqual([
      { batch: true, labels: ["correct"] },
      { batch: true, labels: ["correct"] },
    ]);
    // The same command again makes a new request id, and the decided cards refuse it.
    expect(await pi(["decide", first, "--answer", "acknowledge"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${JSON.stringify({ event: "command_failed", code: "not_pending" })}\n`,
    });
  });

  it("veto add prints the ruling id, list shows it, and lift prints nothing", async () => {
    const { env } = await owner();
    const added = await pi(["veto", "add", "--kind", "follow_up"], env);
    expect(added.exit).toBe(0);
    const { ruling } = JSON.parse(added.stdout) as { ruling: string };
    expect(ruling).toMatch(/^rul_/);
    const listed = await pi(["veto", "list"], env);
    expect(JSON.parse(listed.stdout)).toMatchObject([{ id: ruling, subject: "any", entity: null, kind: "follow_up" }]);
    expect(await pi(["veto", "lift", ruling], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect((await pi(["veto", "lift", ruling], env)).exit).toBe(1);
    expect(JSON.parse((await pi(["veto", "list"], env)).stdout)).toEqual([]);
  });
});
