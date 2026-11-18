import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTENT_KINDS, type PersonalLogger } from "@intelligence/contracts/personal";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import { AGENT_STAGES, createReader, createWriter } from "@intelligence/personal-store";
import { copiesOf, createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../intake/sync.ts";
import { ISOLATED_NOTE } from "../restricted-warning.ts";
import { pi, refused } from "../test-support/run-pi.ts";

// The owner's read quota commands, through `run` on a database of the test's own with the synthetic
// world synced into it.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Env = Record<string, string>;
const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-06-15T12:00:00.000Z");
const DONE = { exit: 0, stdout: "", stderr: "" };

const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.drop();
});

// A database with the world synced into it, and the owner's environment for it. The file syncs
// the world once, and each test gets a copy of that database and its key file (copiesOf).
let builtFolder = "";
const built = copiesOf(async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-clients-quota-"));
  builtFolder = folder;
  const keyFile = join(folder, "keys.json");
  expect(await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).toEqual(DONE);
  const db = await createTestDatabase({ keyFile });
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  try {
    expect(
      (await runSync({ writer, sources: fakeSources(world({ now: NOW })), log: quiet, now: NOW })).outcomes.every(
        (one) => one.outcome === "ok",
      ),
    ).toBe(true);
  } finally {
    await writer.close();
  }
  return db;
});
afterAll(async () => {
  await built.drop();
  await rm(builtFolder, { recursive: true, force: true });
});

async function synced(): Promise<{ db: TestDatabase; env: Env; w: ReturnType<typeof world> }> {
  const db = await built.copy();
  databases.push(db);
  return { db, w: world({ now: NOW }), env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile } };
}

const budgets = (db: TestDatabase, name: string) =>
  queryAs(
    db.urls.admin,
    "select max_items_day, max_chars_day::int as max_chars_day, max_rows_day, max_calls_minute from policy.clients where name = $1",
    [name],
  );

// An agent added with no compartments named is narrow: its own agent compartment and `public`.
// --own adds `own`; --broad adds `own` and every agent compartment the agents that share hold.
describe("pi clients add defaults", () => {
  it("a bare agent gets every view and the agent tools, and only public and its own agent compartment; --broad gives own and the sharing agents'; never a restricted one or a run tool", async () => {
    const { db, env } = await synced();
    const withRecord = { ...env, PI_RECORD_ENABLED: "1" };
    expect(
      (await pi(["clients", "add", "alpha", "--broad", "--views", "self", "--tools", "search,record"], withRecord))
        .exit,
    ).toBe(0);
    expect((await pi(["clients", "add", "beta"], withRecord)).exit).toBe(0);
    const [beta] = await queryAs<{ views: string[]; tools: string[]; compartments: string[] }>(
      db.urls.admin,
      "select views, tools, compartments from policy.clients where name = 'beta'",
    );
    expect(beta?.views.sort()).toEqual(["people", "self", "work"]);
    expect(beta?.compartments.sort()).toEqual(["agent:beta", "public"]);
    for (const tool of [
      "list_goals",
      "get_self",
      "record",
      "propose_about_you",
      "claim_opportunity",
      "report_move",
      "answer_owner_question",
    ])
      expect(beta?.tools).toContain(tool);
    for (const tool of ["next_run", "append_step", "finish_run", "request_research"])
      expect(beta?.tools).not.toContain(tool);
    // A bare agent widens no other: alpha, which shares, is as it was.
    const compartmentsOf = async (name: string): Promise<string[]> =>
      (
        await queryAs<{ compartments: string[] }>(
          db.urls.admin,
          "select compartments from policy.clients where name = $1",
          [name],
        )
      )[0]?.compartments.sort() ?? [];
    expect(await compartmentsOf("alpha")).toEqual(["agent:alpha", "own"]);
    // --broad: own, its own, and the sharing agents' (alpha's), never the bare one's.
    expect((await pi(["clients", "add", "bravo", "--broad"], withRecord)).exit).toBe(0);
    expect(await compartmentsOf("bravo")).toEqual(["agent:alpha", "agent:bravo", "own"]);
    expect(await compartmentsOf("alpha")).toEqual(["agent:alpha", "agent:bravo", "own"]);
    expect(await compartmentsOf("beta")).toEqual(["agent:beta", "public"]);
    for (const name of ["alpha", "bravo", "beta"])
      expect(
        (await compartmentsOf(name)).some((one) => one.startsWith("restricted:") || one.startsWith("employer:")),
      ).toBe(false);
    // Explicit flags win for what they name; with no compartments named, the clearance is narrow.
    expect((await pi(["clients", "add", "gamma", "--views", "self", "--tools", "search"], withRecord)).exit).toBe(0);
    const [gamma] = await queryAs<{ views: string[]; tools: string[]; compartments: string[] }>(
      db.urls.admin,
      "select views, tools, compartments from policy.clients where name = 'gamma'",
    );
    expect(gamma).toEqual({ views: ["self"], tools: ["search"], compartments: ["public"] });
    // --broad is a clearance of its own.
    for (const more of [["--own"], ["--compartments", "own"]])
      expect((await pi(["clients", "add", "delta", "--broad", ...more], withRecord)).exit, more.join(" ")).toBe(2);
  });

  it("with record off the defaults leave out the record family and the add succeeds, cleared for public alone; --own is own", async () => {
    const { db, env } = await synced();
    expect((await pi(["clients", "add", "delta"], env)).exit).toBe(0);
    expect((await pi(["clients", "add", "echo", "--own"], env)).exit).toBe(0);
    const rows = new Map(
      (
        await queryAs<{ name: string; tools: string[]; compartments: string[] }>(
          db.urls.admin,
          "select name, tools, compartments from policy.clients where name in ('delta', 'echo')",
        )
      ).map((row) => [row.name, row]),
    );
    const delta = rows.get("delta");
    for (const tool of ["record", "propose_about_you", "import_memory", "answer_owner_question"])
      expect(delta?.tools).not.toContain(tool);
    expect(delta?.tools).toContain("list_goals");
    expect(delta?.compartments).toEqual(["public"]);
    expect(rows.get("echo")?.compartments).toEqual(["own"]);
  });
});

// A registration with no views or tools named is the whole setup, in one command.
describe("pi clients add, one step", () => {
  type Row = { name: string; compartments: string[]; tools: string[] };
  const clients = async (db: TestDatabase): Promise<Map<string, Row>> =>
    new Map(
      (
        await queryAs<Row>(
          db.urls.admin,
          "select name, compartments, tools from policy.clients where status = 'active'",
        )
      ).map((row) => [row.name, { ...row, compartments: row.compartments.sort() }]),
    );
  const grants = async (db: TestDatabase, name: string): Promise<string[]> =>
    (
      await queryAs<{ grant: string }>(
        db.urls.admin,
        "select h.opportunity_kind || ' ' || h.stage as grant from policy.harness_modes h join policy.clients c on c.id = h.client_id where c.name = $1 and h.revoked_at is null order by 1",
        [name],
      )
    ).map((row) => row.grant);
  const intents = async (
    db: TestDatabase,
    name: string,
  ): Promise<{ goal_id: string | null; kinds: string[]; mode: string }[]> =>
    queryAs(
      db.urls.admin,
      "select i.goal_id, i.opportunity_kinds as kinds, i.mode from policy.intents i join policy.clients c on c.id = any (i.client_ids) where c.name = $1 and i.revoked_at is null",
      [name],
    );
  const STAGES = AGENT_STAGES.map(([kind, stage]) => `${kind} ${stage}`).sort();
  const REASONER = [
    "clients",
    "add",
    "thinker",
    "--kind",
    "reasoner",
    "--views",
    "self,people",
    "--tools",
    "read_message,find_messages",
  ];

  it("a --broad agent gets every clearable grant, a goal-free intent over every kind, and two-way sharing with the sharing agents and the reasoner; a bare or listed one shares with none", async () => {
    const { db, env } = await synced();
    const withRecord = { ...env, PI_RECORD_ENABLED: "1" };
    expect((await pi(REASONER, withRecord)).exit).toBe(0);
    expect((await pi(["clients", "add", "alpha", "--broad"], withRecord)).exit).toBe(0);
    expect((await pi(["clients", "add", "beta", "--broad"], withRecord)).exit).toBe(0);
    let rows = await clients(db);
    expect(rows.get("alpha")?.compartments).toEqual(["agent:alpha", "agent:beta", "own"]);
    expect(rows.get("beta")?.compartments).toEqual(["agent:alpha", "agent:beta", "own"]);
    expect(rows.get("thinker")?.compartments).toEqual(["agent:alpha", "agent:beta", "own"]);
    expect(STAGES).toEqual(
      expect.arrayContaining([
        "goal_step investigate",
        "goal_step prepare",
        "meeting_prep prepare",
        "owner_question investigate",
      ]),
    );
    expect(STAGES.some((one) => one.endsWith(" draft") || one.endsWith(" send"))).toBe(false);
    expect(await grants(db, "beta")).toEqual(STAGES);
    // Every kind an intent may list: every kind but introduction, so no standing
    // mandate decides an introduction before its card reaches the owner.
    expect(await intents(db, "beta")).toEqual([{ goal_id: null, kinds: [...INTENT_KINDS], mode: "owner_decides" }]);
    expect(INTENT_KINDS).not.toContain("introduction");
    // The reasoner gets sharing and no work.
    expect(await grants(db, "thinker")).toEqual([]);

    // A bare agent gets its work and shares with no one; one registered with a list is never widened.
    expect((await pi(["clients", "add", "carol"], withRecord)).exit).toBe(0);
    expect(
      (
        await pi(
          ["clients", "add", "dave", "--views", "self", "--tools", "search", "--compartments", "own"],
          withRecord,
        )
      ).exit,
    ).toBe(0);
    expect((await pi(["clients", "add", "erin", "--broad"], withRecord)).exit).toBe(0);
    rows = await clients(db);
    expect(rows.get("carol")?.compartments).toEqual(["agent:carol", "public"]);
    expect(await grants(db, "carol")).toEqual(STAGES);
    expect(rows.get("dave")?.compartments).toEqual(["own"]);
    expect(rows.get("erin")?.compartments).toEqual(["agent:alpha", "agent:beta", "agent:erin", "own"]);
    for (const name of ["alpha", "beta", "thinker"]) {
      expect(rows.get(name)?.compartments, name).toContain("agent:erin");
      expect(rows.get(name)?.compartments, name).not.toContain("agent:carol");
    }
  });

  it("--no-work skips the grants and the intent, --own shares with none; a custom registration gets neither, and pi clients defaults brings it up, sharing only with --broad, once", async () => {
    const { db, env } = await synced();
    const withRecord = { ...env, PI_RECORD_ENABLED: "1" };
    expect((await pi(["clients", "add", "alpha", "--broad"], withRecord)).exit).toBe(0);
    expect((await pi(["clients", "add", "gamma", "--broad", "--no-work"], withRecord)).exit).toBe(0);
    expect(await grants(db, "gamma")).toEqual([]);
    expect(await intents(db, "gamma")).toEqual([]);
    expect((await pi(["clients", "add", "delta", "--own"], withRecord)).exit).toBe(0);
    let rows = await clients(db);
    expect(rows.get("delta")?.compartments).toEqual(["agent:delta", "own"]);
    expect(rows.get("alpha")?.compartments).not.toContain("agent:delta");
    expect(await grants(db, "delta")).toEqual(STAGES);
    // A custom registration: what it names, and nothing else.
    expect(
      (
        await pi(
          ["clients", "add", "epsilon", "--views", "self", "--tools", "search", "--compartments", "own"],
          withRecord,
        )
      ).exit,
    ).toBe(0);
    expect(await grants(db, "epsilon")).toEqual([]);
    expect(await pi(["clients", "defaults", "epsilon"], withRecord)).toEqual(DONE);
    rows = await clients(db);
    expect(rows.get("epsilon")?.tools).toEqual(
      expect.arrayContaining(["search", "list_goals", "claim_opportunity", "report_move"]),
    );
    expect(rows.get("epsilon")?.compartments).toEqual(["agent:epsilon", "own"]);
    expect(await grants(db, "epsilon")).toEqual(STAGES);
    expect(await intents(db, "epsilon")).toHaveLength(1);
    // With --broad it shares, both ways; again, nothing more.
    expect(await pi(["clients", "defaults", "epsilon", "--broad"], withRecord)).toEqual(DONE);
    expect(await pi(["clients", "defaults", "epsilon", "--broad"], withRecord)).toEqual(DONE);
    rows = await clients(db);
    expect(rows.get("epsilon")?.compartments).toEqual(["agent:alpha", "agent:epsilon", "agent:gamma", "own"]);
    expect(rows.get("alpha")?.compartments).toContain("agent:epsilon");
    expect(rows.get("delta")?.compartments).not.toContain("agent:epsilon");
    expect(await grants(db, "epsilon")).toEqual(STAGES);
    expect(await intents(db, "epsilon")).toHaveLength(1);
    expect(await pi(["clients", "defaults", "nobody"], withRecord)).toEqual(refused("not_found"));
  });

  // A clearance holds at most 32 compartments, which keeps a label key inside a btree index entry.
  // The owner's eleven agents and a reasoner share two ways, each holding own and all eleven agent
  // compartments, and pi clients defaults --broad brings each agent up again, changing nothing.
  // Twenty more agents registered --own and then marked as sharing hold compartments a --broad
  // agent takes, so own, an agent's own and the 30 others fill the cap exactly; one more --broad
  // agent would need 33 and is refused, never cut short.
  it("the owner's eleven agents share two ways and pi clients defaults succeeds for each; past 32 compartments a --broad agent is refused too_many_compartments", async () => {
    const { db, env } = await synced();
    const withRecord = { ...env, PI_RECORD_ENABLED: "1" };
    const names = Array.from({ length: 11 }, (_, index) => `agent-${String(index + 1).padStart(2, "0")}`);
    expect((await pi(REASONER, withRecord)).exit).toBe(0);
    for (const name of names) expect((await pi(["clients", "add", name, "--broad"], withRecord)).exit, name).toBe(0);
    let rows = await clients(db);
    const shared = ["own", ...names.map((name) => `agent:${name}`)].sort();
    for (const name of [...names, "thinker"]) expect(rows.get(name)?.compartments, name).toEqual(shared);
    for (const name of names)
      expect(await pi(["clients", "defaults", name, "--broad"], withRecord), name).toEqual(DONE);
    rows = await clients(db);
    for (const name of [...names, "thinker"]) expect(rows.get(name)?.compartments, name).toEqual(shared);

    const solo = Array.from({ length: 20 }, (_, index) => `solo-${String(index + 1).padStart(2, "0")}`);
    for (const name of solo) expect((await pi(["clients", "add", name, "--own"], withRecord)).exit, name).toBe(0);
    await queryAs(db.urls.admin, "update policy.clients set shares = true where name like 'solo-%'");
    // own, agent-01's own and the 30 other agent compartments: the cap, taken.
    expect(await pi(["clients", "defaults", "agent-01", "--broad"], withRecord)).toEqual(DONE);
    rows = await clients(db);
    expect(rows.get("agent-01")?.compartments).toHaveLength(32);
    // A new --broad agent: own, its own and 31 others, refused and not registered.
    const over = await pi(["clients", "add", "agent-12", "--broad"], withRecord);
    expect(over.exit).toBe(1);
    expect(over.stderr).toContain('"code":"too_many_compartments"');
    rows = await clients(db);
    expect(rows.has("agent-12")).toBe(false);
    // --isolated, the old name of --own, still clears the agent for own, and says it is deprecated.
    const alias = await pi(["clients", "add", "agent-12", "--isolated"], withRecord);
    expect(alias.exit).toBe(0);
    expect(alias.stderr).toContain(ISOLATED_NOTE);
    rows = await clients(db);
    expect(rows.get("agent-12")?.compartments).toEqual(["agent:agent-12", "own"]);
  });
});

describe("pi clients quota and usage", () => {
  it("a client registered as a reasoner gets the reasoner's defaults, and an agent the agent's", async () => {
    const { db, env } = await synced();
    expect(
      (
        await pi(
          [
            "clients",
            "add",
            "thinker",
            "--kind",
            "reasoner",
            "--views",
            "self,people",
            "--tools",
            "read_message,find_messages",
          ],
          env,
        )
      ).exit,
    ).toBe(0);
    expect(
      (await pi(["clients", "add", "helper", "--views", "self,people", "--tools", "read_message,find_messages"], env))
        .exit,
    ).toBe(0);
    expect(await budgets(db, "thinker")).toEqual([
      { max_items_day: 600, max_chars_day: 6_000_000, max_rows_day: 20_000, max_calls_minute: 240 },
    ]);
    expect(await budgets(db, "helper")).toEqual([
      { max_items_day: 300, max_chars_day: 3_000_000, max_rows_day: 5_000, max_calls_minute: 60 },
    ]);
    // pi clients quota changes the budgets it names and keeps the rest.
    expect(await pi(["clients", "quota", "helper", "--items", "2", "--per-minute", "600"], env)).toEqual(DONE);
    expect(await budgets(db, "helper")).toEqual([
      { max_items_day: 2, max_chars_day: 3_000_000, max_rows_day: 5_000, max_calls_minute: 600 },
    ]);
    expect(await pi(["clients", "quota", "nobody", "--items", "2"], env)).toEqual(refused("not_found"));
  });

  it("pi clients usage prints counts and no name, address or text", async () => {
    const { db, env, w } = await synced();
    const added = await pi(
      [
        "clients",
        "add",
        "helper",
        "--compartments",
        "own,employer:example",
        "--views",
        "self,people",
        "--tools",
        "read_message,find_messages",
      ],
      env,
    );
    const token = added.stdout.trim();
    expect(await pi(["clients", "quota", "helper", "--items", "2"], env)).toEqual(DONE);
    const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet, now: () => NOW });
    let served = "";
    try {
      const listed = await reader.findMessages(token, { limit: 50 });
      if (!listed.ok) throw new Error(listed.code);
      for (const message of listed.value.messages.slice(0, 3)) {
        const answer = await reader.readMessage(token, { id: message.id });
        served += JSON.stringify(answer);
      }
      served += JSON.stringify(listed.value);
    } finally {
      await reader.close();
    }
    // The third read was refused.
    expect(served).toContain("rate_limited");
    const usage = await pi(["clients", "usage"], env);
    expect(usage.exit).toBe(0);
    const rows = JSON.parse(usage.stdout) as { client: string; used: Record<string, number>; rateLimitedDay: number }[];
    expect(rows.map((row) => row.client)).toEqual(["helper"]);
    expect(rows[0]?.used.itemsDay).toBe(2);
    expect(rows[0]?.rateLimitedDay).toBe(1);
    expect(rows[0]?.used.charsDay).toBeGreaterThanOrEqual(0);
    // Counts only: nothing the client was served, and no canary, is in what was printed.
    for (const needle of [
      w.canaries.address,
      w.canaries.name,
      w.canaries.subject,
      w.canaries.body,
      w.owner.name,
      ...w.owner.addresses,
    ]) {
      expect(usage.stdout, needle).not.toContain(needle);
    }
    for (const match of served.matchAll(/"untrusted":"([^"]{6,})"/g)) expect(usage.stdout).not.toContain(match[1]);
    expect(usage.stdout).not.toMatch(/msg_|ent_|pit_|@/);
    // One client by name, and an unknown name.
    expect(JSON.parse((await pi(["clients", "usage", "helper"], env)).stdout)).toEqual(rows);
    expect(await pi(["clients", "usage", "nobody"], env)).toEqual(refused("not_found"));
  });
});
