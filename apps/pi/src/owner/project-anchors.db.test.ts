import { createTestDatabase, queryAs, seedCapture, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type PiOptions, refusedWithHint as refused, pi as runPi } from "../test-support/run-pi.ts";

// lensN3.2: `pi project anchor`'s device flags and `pi project list`'s anchors, through `run`, on
// one database built once with an `own` project, an `employer:example` project and a closed one.
// Synthetic values only.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PAN = /^pan_[0-9A-HJKMNP-TV-Z]{26}\n$/;

let db: TestDatabase;
let env: Env;
let own: string;
let work: string;
let closed: string;

const pi = (argv: string[], options: PiOptions = {}) => runPi(argv, env, options);

// commands.ts's one hint for the code: a thread's or a meeting's compartments beside the project's.
const MISMATCH =
  "the compartments differ: the label's accounts and --compartment, the person and the item, the thread or the meeting and the project";
const count = async (table: string): Promise<number> =>
  (await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`))[0]?.n ?? -1;
const counts = async () => ({
  decisions: await count("knowledge.owner_decisions"),
  anchors: await count("knowledge.project_anchors"),
});
const added = async (name: string, compartment?: string): Promise<string> => {
  const result = await pi(["project", "add", ...(compartment === undefined ? [] : ["--compartment", compartment])], {
    stdin: `${name}\n`,
  });
  expect(result).toMatchObject({ exit: 0, stderr: "" });
  return result.stdout.trim();
};

beforeAll(async () => {
  db = await createTestDatabase();
  env = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile };
  own = await added("Heron survey");
  work = await added("Employer survey", "employer:example");
  closed = await added("Finished survey");
  expect(await pi(["project", "close", closed])).toEqual({ exit: 0, stdout: "", stderr: "" });
});

afterAll(async () => {
  await db?.drop();
});

describe("pi project anchor, the device kinds", () => {
  it("project anchor prints the anchor's id for each flag", async () => {
    const before = await counts();
    const flags = [
      ["--app", "test.example.notes"],
      ["--host", "plans.example.com"],
      ["--url", "https://wiki.example.org/teams/alpha"],
      ["--repo", "git.example.org/owner/name"],
      ["--document", "~/test/alpha/notes"],
    ] as const;
    for (const [flag, value] of flags) {
      const result = await pi(["project", "anchor", own, flag, value]);
      expect(result, flag).toMatchObject({ exit: 0, stderr: "" });
      expect(result.stdout, flag).toMatch(PAN);
    }
    expect(await counts()).toEqual({
      decisions: before.decisions + flags.length,
      anchors: before.anchors + flags.length,
    });
  });

  // The captures: an `own` meeting with a calendar UID, one with none, and an `employer:example`
  // meeting with a UID.
  it("project anchor --series-of prints the anchor's id, and refuses no_series and compartment_mismatch", async () => {
    const meeting = await seedCapture(db, ["own"], "meeting", "series-heron@example.com");
    expect((await pi(["project", "anchor", own, "--series-of", meeting])).stdout).toMatch(PAN);
    const before = await counts();
    expect(await pi(["project", "anchor", own, "--series-of", await seedCapture(db, ["own"], "meeting")])).toEqual(
      refused("no_series"),
    );
    const employer = await seedCapture(db, ["employer:example"], "meeting", "series-employer@example.com");
    expect(await pi(["project", "anchor", own, "--series-of", employer])).toEqual(
      refused("compartment_mismatch", MISMATCH),
    );
    expect(await counts()).toEqual(before);
    expect((await pi(["project", "anchor", work, "--series-of", employer])).stdout).toMatch(PAN);
  });

  it("two flags at once are usage", async () => {
    const before = await counts();
    for (const flags of [
      ["--app", "test.example.twice", "--host", "twice.example.org"],
      ["--host", "twice.example.org", "--url", "https://twice.example.org/a"],
      ["--repo", "git.example.org/owner/twice", "--document", "~/test/twice"],
      ["--thread", `msg_${"0".repeat(26)}`, "--host", "twice.example.org"],
      ["--series-of", `cap_${"0".repeat(26)}`, "--app", "test.example.twice"],
      [],
    ]) {
      expect(await pi(["project", "anchor", own, ...flags]), flags.join(" ")).toEqual(refused("usage", undefined, 2));
    }
    expect(await counts()).toEqual(before);
    // The control: one of them alone is taken.
    expect((await pi(["project", "anchor", own, "--host", "twice.example.org"])).stdout).toMatch(PAN);
  });

  it("project list prints each anchor's kind and value, to a terminal only, and refuses any other stdout", async () => {
    const app = (await pi(["project", "anchor", work, "--app", "test.Example.Listed"])).stdout.trim();
    const host = (await pi(["project", "anchor", work, "--host", "Listed.Example.org."])).stdout.trim();
    const listed = await pi(["project", "list"], { tty: true });
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    const projects = JSON.parse(listed.stdout) as {
      id: string;
      anchors: { id: string; kind: string; value: string | null }[];
    }[];
    const anchors = projects.find((project) => project.id === work)?.anchors ?? [];
    // Each at its normal form, without its prefix.
    expect(anchors.find((one) => one.id === app)).toMatchObject({ kind: "app", value: "test.example.listed" });
    expect(anchors.find((one) => one.id === host)).toMatchObject({ kind: "host", value: "listed.example.org" });
    // The values are the owner's: any stdout but a terminal is refused, and nothing is printed.
    expect(await pi(["project", "list"])).toEqual(refused("not_a_terminal"));
  });

  it("each refusal prints its code and writes nothing", async () => {
    expect((await pi(["project", "anchor", own, "--host", "refusals.example.org"])).stdout).toMatch(PAN);
    const before = await counts();
    for (const [argv, code] of [
      [["--host", "github.com"], "generic_anchor"],
      [["--app", "com.google.Chrome"], "generic_anchor"],
      [["--url", "https://docs.google.com/document/d"], "generic_anchor"],
      [["--repo", "git.example.org/owner"], "generic_anchor"],
      [["--document", "~/Documents"], "generic_anchor"],
      [["--host", "192.0.2.10"], "bad_anchor"],
      [["--url", "ftp://plans.example.com/a"], "bad_anchor"],
      [["--host", "refusals.example.org"], "anchor_taken"],
    ] as const) {
      expect(await pi(["project", "anchor", work, ...argv]), argv.join(" ")).toEqual(refused(code));
    }
    expect(await pi(["project", "anchor", closed, "--host", "closed.example.org"])).toEqual(refused("not_found"));
    expect(await counts()).toEqual(before);
    // The control: a value that is no product, on the active project, is taken.
    expect((await pi(["project", "anchor", work, "--host", "closed.example.org"])).stdout).toMatch(PAN);
    expect(await counts()).toEqual({ decisions: before.decisions + 1, anchors: before.anchors + 1 });
  });
});
