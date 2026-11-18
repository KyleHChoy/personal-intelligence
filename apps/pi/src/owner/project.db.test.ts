import {
  createTestDatabase,
  MAIL,
  queryAs,
  rowsOf,
  stored,
  type TestDatabase,
  withPipeline,
} from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi, refused } from "../test-support/run-pi.ts";

// The owner's project commands through `run`, on a database of their own.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

async function owner(): Promise<{ db: TestDatabase; env: Env }> {
  const db = await createTestDatabase();
  databases.push(db);
  return { db, env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile } };
}

describe("pi project", () => {
  it("add reads the name from stdin and prints only the id", async () => {
    const { db, env } = await owner();
    const added = await pi(["project", "add"], env, { stdin: "Canary project: the heron survey\n" });
    expect(added).toMatchObject({ exit: 0, stderr: "" });
    expect(added.stdout).toMatch(/^ent_[0-9A-HJKMNP-TV-Z]{26}\n$/);
    // A name given as an argument, an empty one and one over 200 code points are usage errors.
    expect(await pi(["project", "add", "Canary as an argument"], env)).toEqual(refused("usage", 2));
    expect(await pi(["project", "add"], env, { stdin: " \n" })).toEqual(refused("usage", 2));
    expect(await pi(["project", "add"], env, { stdin: "é".repeat(201) })).toEqual(refused("usage", 2));
    expect(await queryAs(db.urls.admin, "select kind from knowledge.owner_decisions")).toEqual([
      { kind: "project_add" },
    ]);
  });

  it("anchor, unanchor, close and list follow it, each one decision", () =>
    withPipeline(async (store) => {
      const { db, writer, accounts } = store;
      const env = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
      const project = (
        await pi(["project", "add"], env, { stdin: "Canary project: the heron survey\n" })
      ).stdout.trim();
      const evidence = await stored(writer, accounts.personalMail, MAIL.canary);
      const message = (
        await rowsOf<{ id: string }>(db, "select id from knowledge.messages where evidence_id = $1", [evidence])
      )[0]?.id as string;
      const anchored = await pi(["project", "anchor", project, "--thread", message], env);
      expect(anchored.exit).toBe(0);
      expect(anchored.stdout).toMatch(/^pan_[0-9A-HJKMNP-TV-Z]{26}\n$/);
      expect(await pi(["project", "anchor", project], env)).toEqual(refused("usage", 2));
      expect(await pi(["project", "anchor", `ent_${"0".repeat(26)}`, "--thread", message], env)).toEqual(
        refused("not_found"),
      );

      const listed = await pi(["project", "list"], env, { tty: true });
      expect(JSON.parse(listed.stdout)).toMatchObject([
        {
          id: project,
          status: "active",
          name: "Canary project: the heron survey",
          anchors: [{ id: anchored.stdout.trim(), kind: "email_thread" }],
        },
      ]);
      // The names are the owner's: the list goes to a terminal only.
      expect(await pi(["project", "list"], env)).toEqual(refused("not_a_terminal"));

      expect(await pi(["project", "unanchor", anchored.stdout.trim()], env)).toEqual({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      expect(await pi(["project", "unanchor", anchored.stdout.trim()], env)).toEqual(refused("not_found"));
      expect(await pi(["project", "close", project], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
      expect(
        await queryAs(db.urls.admin, "select kind from knowledge.owner_decisions order by decided_at, id"),
      ).toEqual([
        { kind: "project_add" },
        { kind: "project_anchor" },
        { kind: "project_unanchor" },
        { kind: "project_close" },
      ]);
    }));
});
