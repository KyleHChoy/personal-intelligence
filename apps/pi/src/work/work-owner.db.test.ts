import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi, refused } from "../test-support/run-pi.ts";

// The owner commands of durable work through `run`, on a database of their own.

type Env = Record<string, string>;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

async function owner(): Promise<{
  db: TestDatabase;
  env: Env;
  rows: <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<Row[]>;
}> {
  const db = await createTestDatabase();
  databases.push(db);
  return {
    db,
    env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile },
    rows: (text, values) => queryAs(db.urls.admin, text, values),
  };
}

const REASONER_TOOLS = "get_self,search,next_run,append_step,finish_run";
const addReasoner = (env: Env, name = "thinker", more: string[] = []) =>
  pi(["clients", "add", name, "--kind", "reasoner", "--views", "self,work", "--tools", REASONER_TOOLS, ...more], env);
const addWorker = (env: Env, name = "worker") =>
  pi(
    [
      "clients",
      "add",
      name,
      "--broad",
      "--views",
      "self,work",
      "--tools",
      "get_self,list_opportunities,claim_opportunity,plan_move,report_move",
    ],
    env,
  );

describe("pi goal, intent, work and clients add --kind", () => {
  it("goal add reads stdin and prints only the id", async () => {
    const { db, env } = await owner();
    const added = await pi(["goal", "add", "--domain", "interests"], env, { stdin: "Canary goal: the heron survey\n" });
    expect(added.exit).toBe(0);
    expect(added.stdout).toMatch(/^gol_[0-9A-HJKMNP-TV-Z]{26}\n$/);
    expect(added.stderr).toBe("");
    const listed = await pi(["goal", "list"], env, { tty: true });
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { id: added.stdout.trim(), status: "active", statement: "Canary goal: the heron survey" },
    ]);
    // An empty statement and one over 1 000 code points are usage errors and write nothing.
    expect(await pi(["goal", "add", "--domain", "interests"], env, { stdin: " \n" })).toEqual(refused("usage", 2));
    expect(await pi(["goal", "add", "--domain", "interests"], env, { stdin: "é".repeat(1001) })).toEqual(
      refused("usage", 2),
    );
    expect((await pi(["goal", "add", "--domain", "interests"], env, { stdin: "é".repeat(1000) })).exit).toBe(0);
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from projections.goal_state")).toEqual([{ n: 2 }]);
    // Each is a goal claim with its mapping row, on a fresh box too.
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.goal_ids")).toEqual([{ n: 2 }]);
    // goal set changes the status, and an unknown goal is not_found.
    expect(await pi(["goal", "set", added.stdout.trim(), "--status", "paused"], env)).toEqual({
      exit: 0,
      stdout: "",
      stderr: "",
    });
    expect(await pi(["goal", "set", added.stdout.trim(), "--status", "sleeping"], env)).toEqual(refused("usage", 2));
    expect(await pi(["goal", "set", `gol_${"0".repeat(26)}`, "--status", "done"], env)).toEqual(refused("not_found"));
  });

  it("a goal given as an argument is a usage error", async () => {
    const { db, env } = await owner();
    expect(await pi(["goal", "add", "Canary goal as an argument"], env)).toEqual(refused("usage", 2));
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from knowledge.owner_decisions")).toEqual([
      { n: 0 },
    ]);
  });

  it("goal list prints nothing when stdout is not a terminal", async () => {
    const { env } = await owner();
    await pi(["goal", "add", "--domain", "interests"], env, { stdin: "Canary goal" });
    expect(await pi(["goal", "list"], env)).toEqual(refused("not_a_terminal"));
    expect(await pi(["work", "show", `run_${"0".repeat(26)}`], env)).toEqual(refused("not_a_terminal"));
  });

  it("intent add defaults to the owner deciding and five open", async () => {
    const { env } = await owner();
    expect((await addWorker(env)).exit).toBe(0);
    const added = await pi(["intent", "add", "--kinds", "investigate,meeting_prep", "--clients", "worker"], env);
    expect(added.exit).toBe(0);
    const { intent } = JSON.parse(added.stdout) as { intent: string };
    expect(JSON.parse((await pi(["intent", "list"], env)).stdout)).toMatchObject([
      { id: intent, kinds: ["investigate", "meeting_prep"], clients: ["worker"], mode: "owner_decides", maxOpen: 5 },
    ]);
    expect(
      (
        await pi(
          ["intent", "add", "--kinds", "life_admin", "--clients", "worker", "--mode", "policy", "--max-open", "2"],
          env,
        )
      ).exit,
    ).toBe(0);
    expect(JSON.parse((await pi(["intent", "list"], env)).stdout)).toMatchObject([
      { mode: "owner_decides" },
      { mode: "policy_decides", maxOpen: 2 },
    ]);
    expect(await pi(["intent", "add", "--kinds", "chores", "--clients", "worker"], env)).toEqual(refused("usage", 2));
    expect(await pi(["intent", "add", "--kinds", "investigate", "--clients", "nobody"], env)).toEqual(
      refused("not_found"),
    );
    expect(await pi(["intent", "revoke", intent], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await pi(["intent", "revoke", intent], env)).toEqual(refused("not_found"));
    // A harness mode for an internal stage, and one for a stage that leaves the system.
    expect(
      JSON.parse(
        (await pi(["harness", "grant", "worker", "--kind", "investigate", "--stage", "investigate"], env)).stdout,
      ),
    ).toMatchObject({ harness: expect.stringMatching(/^hrn_/) });
    expect(await pi(["harness", "grant", "worker", "--kind", "reply", "--stage", "send"], env)).toEqual(
      refused("not_built"),
    );
  });

  it("work stop then work status shows the switch on", async () => {
    const { env } = await owner();
    expect(await pi(["work", "stop"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(JSON.parse((await pi(["work", "status"], env)).stdout)).toMatchObject({ killSwitch: "on" });
    expect(await pi(["work", "start"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(JSON.parse((await pi(["work", "status"], env)).stdout)).toMatchObject({ killSwitch: "off" });
  });

  it("work run with today's spend at the ceiling prints silenced budget, writes one silence and no run, and queues the run after the ceiling is raised", async () => {
    const { env, rows } = await owner();
    expect((await addReasoner(env)).exit).toBe(0);
    expect(await pi(["work", "budget", "--usd", "0"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await pi(["work", "run"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ silenced: "budget" })}\n`,
      stderr: "",
    });
    expect(await rows("select reason, wake_source from ledger.silences")).toEqual([
      { reason: "budget", wake_source: "owner_request" },
    ]);
    expect(await rows("select count(*)::int as n from ledger.runs")).toEqual([{ n: 0 }]);
    expect(await rows("select point, output, effect, rung from ledger.decision_point_calls")).toEqual([
      { point: "wake_worth_run", output: "skip", effect: "record_silence", rung: 0 },
    ]);
    expect((await pi(["work", "budget", "--usd", "5"], env)).exit).toBe(0);
    const queued = await pi(["work", "run"], env);
    expect(queued.exit).toBe(0);
    const { run: id } = JSON.parse(queued.stdout) as { run: string };
    expect(id).toMatch(/^run_/);
    expect(await rows("select id, wake_source from ledger.runs")).toEqual([{ id, wake_source: "owner_request" }]);
    expect(await rows("select count(*)::int as n from ledger.silences")).toEqual([{ n: 1 }]);
    const shown = await pi(["work", "show", id], env, { tty: true });
    expect(JSON.parse(shown.stdout)).toMatchObject({
      kind: "run",
      id,
      source: "owner_request",
      events: [{ event: "queued", by: "owner" }],
      steps: [],
    });
  });

  it("work budget --output-tokens sets one model call's output tokens and leaves the rest", async () => {
    const { env, rows } = await owner();
    const before = await rows(
      "select max_runs_per_day, max_microusd_per_day, max_output_tokens from policy.work_settings",
    );
    expect(before).toEqual([expect.objectContaining({ max_output_tokens: 4000 })]);
    expect(await pi(["work", "budget", "--output-tokens", "16000"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(
      await rows("select max_runs_per_day, max_microusd_per_day, max_output_tokens from policy.work_settings"),
    ).toEqual([{ ...before[0], max_output_tokens: 16000 }]);
    expect((await pi(["work", "budget", "--output-tokens", "40000"], env)).exit).toBe(2);
    expect(await rows("select max_output_tokens from policy.work_settings")).toEqual([{ max_output_tokens: 16000 }]);
  });

  // The owner moves the daily sweep without SQL; the column keeps its older name.
  it("work budget --sweep-hour sets the daily sweep's hour and leaves the rest", async () => {
    const { env, rows } = await owner();
    const before = await rows(
      "select max_runs_per_day, max_microusd_per_day, sweep_hour_utc from policy.work_settings",
    );
    expect(await pi(["work", "budget", "--sweep-hour", "21"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(
      await rows("select max_runs_per_day, max_microusd_per_day, sweep_hour_utc from policy.work_settings"),
    ).toEqual([{ ...before[0], sweep_hour_utc: 21 }]);
    expect(await pi(["work", "budget", "--sweep-hour", "0"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await rows("select sweep_hour_utc from policy.work_settings")).toEqual([{ sweep_hour_utc: 0 }]);
    expect((await pi(["work", "budget", "--sweep-hour", "24"], env)).exit).toBe(2);
    expect(await rows("select sweep_hour_utc from policy.work_settings")).toEqual([{ sweep_hour_utc: 0 }]);
  });

  it("work run is not stopped by the backlog or the run count", async () => {
    const { env, rows } = await owner();
    expect((await addReasoner(env)).exit).toBe(0);
    expect((await pi(["work", "budget", "--runs", "0", "--cards", "0"], env)).exit).toBe(0);
    const queued = await pi(["work", "run"], env);
    expect(Object.keys(JSON.parse(queued.stdout) as object)).toEqual(["run"]);
    expect(Object.keys(JSON.parse((await pi(["work", "run"], env)).stdout) as object)).toEqual(["run"]);
    expect(await rows("select count(*)::int as n from ledger.runs")).toEqual([{ n: 2 }]);
  });

  it("work run with the kill switch on is silenced", async () => {
    const { env, rows } = await owner();
    expect((await addReasoner(env)).exit).toBe(0);
    await pi(["work", "stop"], env);
    expect(await pi(["work", "run"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ silenced: "kill_switch" })}\n`,
      stderr: "",
    });
    expect(await rows("select count(*)::int as n from ledger.runs")).toEqual([{ n: 0 }]);
    // With no reasoner registered, the request is silenced too.
    const bare = await owner();
    expect(await pi(["work", "run"], bare.env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ silenced: "no_reasoner" })}\n`,
      stderr: "",
    });
    // --goal and --entity together are a usage error.
    expect(
      await pi(["work", "run", "--goal", `gol_${"0".repeat(26)}`, "--entity", `ent_${"0".repeat(26)}`], env),
    ).toEqual(refused("usage", 2));
  });

  it("veto add with a kind that is no opportunity kind is a usage error and writes nothing", async () => {
    const { env, rows } = await owner();
    // A card kind, never an opportunity's (`introduction` is an opportunity kind, so not this one).
    expect(await pi(["veto", "add", "--kind", "same_fact"], env)).toEqual(refused("usage", 2));
    expect(await rows("select count(*)::int as n from knowledge.vetoes")).toEqual([{ n: 0 }]);
    // The positive controls: an OpportunityKind, and a proposal.
    expect((await pi(["veto", "add", "--kind", "reply"], env)).exit).toBe(0);
    expect((await pi(["veto", "add", "--kind", "proposal"], env)).exit).toBe(0);
    expect(await rows("select work_kind from knowledge.vetoes order by created_at, ruling_id")).toEqual([
      { work_kind: "reply" },
      { work_kind: "proposal" },
    ]);
  });

  it("clients add --kind reasoner refuses a work tool, the record tool and a restricted compartment, and takes agent compartments", async () => {
    const { env, rows } = await owner();
    const reasoner = (tools: string, more: string[] = [], name = "thinker") =>
      pi(["clients", "add", name, "--kind", "reasoner", "--views", "self,work", "--tools", tools, ...more], env);
    expect(await reasoner(`${REASONER_TOOLS},claim_opportunity`)).toEqual(refused("invalid_registration"));
    expect(await reasoner(`${REASONER_TOOLS},record`)).toEqual(refused("invalid_registration"));
    expect(await reasoner(REASONER_TOOLS, ["--compartments", "own,restricted:health"])).toEqual(
      refused("invalid_registration"),
    );
    expect(await reasoner(REASONER_TOOLS, ["--compartments", "own,agent:alpha,restricted:health"])).toEqual(
      refused("invalid_registration"),
    );
    // An agent may not hold a run tool.
    expect(
      await pi(["clients", "add", "worker", "--broad", "--views", "self", "--tools", "get_self,next_run"], env),
    ).toEqual(refused("invalid_registration"));
    expect(await rows("select count(*)::int as n from policy.clients")).toEqual([{ n: 0 }]);
    // The positive control: stored with its kind, and listed with it.
    const added = await reasoner(REASONER_TOOLS);
    expect(added.exit).toBe(0);
    expect(added.stdout).toMatch(/^pit_/);
    expect(await rows("select name, kind, tools from policy.clients")).toEqual([
      { name: "thinker", kind: "reasoner", tools: REASONER_TOOLS.split(",") },
    ]);
    expect(JSON.parse((await pi(["clients", "list"], env)).stdout)).toMatchObject([
      { name: "thinker", kind: "reasoner" },
    ]);
    // A reasoner registered with the agents' compartments, under a new name once the first is
    // revoked, holds them.
    expect((await pi(["clients", "revoke", "thinker"], env)).exit).toBe(0);
    expect((await reasoner(REASONER_TOOLS, ["--compartments", "own,agent:alpha,agent:beta"], "thinker2")).exit).toBe(0);
    expect(await rows("select compartments from policy.clients where name = 'thinker2'")).toEqual([
      { compartments: ["own", "agent:alpha", "agent:beta"] },
    ]);
  });

  it("a second reasoner is refused", async () => {
    const { env, rows } = await owner();
    expect((await addReasoner(env, "thinker")).exit).toBe(0);
    expect(await addReasoner(env, "second")).toEqual(refused("invalid_registration"));
    expect(await rows("select name from policy.clients")).toEqual([{ name: "thinker" }]);
    // Once the first is revoked, a second may be registered.
    expect((await pi(["clients", "revoke", "thinker"], env)).exit).toBe(0);
    expect((await addReasoner(env, "second")).exit).toBe(0);
  });
});

describe("pi work lesson", () => {
  it("lesson add takes --kind and --role, each repeatable, sorted and once; retire writes the owner's retired with their note, and --lift their confirmed", async () => {
    const { env, rows } = await owner();
    const selectors = (id: string) =>
      rows("select applies_kinds, applies_roles from ledger.hypotheses where id = $1", [id]);
    const latest = (id: string) =>
      rows<{ event: string; by: string; noted: boolean }>(
        "select event, by, body_enc is not null as noted from ledger.record_events where row_kind = 'hypothesis' and row_id = $1 order by id desc limit 1",
        [id],
      );

    const scoped = await pi(
      ["work", "lesson", "add", "--kind", "reply", "--kind", "follow_up", "--kind", "reply", "--role", "scout"],
      env,
      { stdin: "Short replies to people he knows\n" },
    );
    expect(scoped.exit).toBe(0);
    expect(scoped.stdout).toMatch(/^hyp_[0-9A-HJKMNP-TV-Z]{26}\n$/);
    const lesson = scoped.stdout.trim();
    expect(await selectors(lesson)).toEqual([{ applies_kinds: ["follow_up", "reply"], applies_roles: ["scout"] }]);
    // None given is for all: no selector at all.
    const plain = (
      await pi(["work", "lesson", "add"], env, { stdin: "Named introductions over cold mail\n" })
    ).stdout.trim();
    expect(await selectors(plain)).toEqual([{ applies_kinds: null, applies_roles: null }]);
    // A kind that is no opportunity kind, or a role off the form, is a usage error and writes nothing.
    expect(await pi(["work", "lesson", "add", "--kind", "nonsense"], env, { stdin: "x\n" })).toEqual(
      refused("usage", 2),
    );
    expect(await pi(["work", "lesson", "add", "--role", "Scout"], env, { stdin: "x\n" })).toEqual(refused("usage", 2));
    expect(await rows("select count(*)::int as n from ledger.hypotheses where kind = 'lesson'")).toEqual([{ n: 2 }]);

    expect(await pi(["work", "lesson", "retire", lesson, "--note", "too narrow now"], env)).toEqual({
      exit: 0,
      stdout: "",
      stderr: "",
    });
    expect(await latest(lesson)).toEqual([{ event: "retired", by: "owner", noted: true }]);
    expect(await latest(plain)).toEqual([{ event: "confirmed", by: "owner", noted: false }]);
    expect(await pi(["work", "lesson", "retire", lesson, "--lift"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await latest(lesson)).toEqual([{ event: "confirmed", by: "owner", noted: false }]);
    // An id that names no lesson is not found; a selector on retire is a usage error.
    expect(await pi(["work", "lesson", "retire", `hyp_${"0".repeat(26)}`], env)).toEqual(refused("not_found"));
    expect(await pi(["work", "lesson", "retire", lesson, "--kind", "reply"], env)).toEqual(refused("usage", 2));
    expect(await latest(lesson)).toEqual([{ event: "confirmed", by: "owner", noted: false }]);
  });
});
