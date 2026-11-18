import type { GoalId, GoalList, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { outcomeValue, registration } from "../test-support/values.ts";

// list_goals, the owner's goals to a client that holds the tool and the work view,
// under its clearance, newest set first, by state. Invariant 6: a goal outside the clearance
// changes nothing the client is answered.

const HIDDEN = "employer:example";
const LISTER: { tools: PersonalTool[]; views: PersonalView[] } = { tools: ["list_goals"], views: ["work"] };

const stores: TestStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function opened(): Promise<TestStore> {
  const store = await openStore({ writer: false });
  stores.push(store);
  return store;
}

let serial = 0;
// A goal set by the owner, its time set by the test so the order is the test's.
async function goal(store: TestStore, statement: string, compartment: string, at: string): Promise<GoalId> {
  serial += 1;
  const id = await store.admin.work.addGoal(statement, compartment, { requestId: `req-read-goals-${serial}` });
  await queryAs(store.db.urls.admin, "update projections.goal_state set stated_at = $2 where goal_id = $1", [id, at]);
  return id;
}

const add = async (
  store: TestStore,
  name: string,
  compartments: string[],
  over: Partial<typeof LISTER> = {},
): Promise<string> =>
  (await store.admin.clients.addClient(registration(name, compartments, { ...LISTER, ...over }))).token;

const statements = (list: GoalList): string[] => list.goals.map((one) => one.statement.untrusted);

// What get_self, context and a pack say they leave out, as a client is answered it.
const withheldOf = async (store: TestStore, token: string) => ({
  self: outcomeValue(await store.reader.getSelf(token, {})).withheld,
  context: outcomeValue(await store.reader.context(token, { task: "plan the next round" })).withheld,
  pack: outcomeValue(await store.reader.buildContextPack(token, { purpose: "agent_bootstrap" })).withheld,
});

describe("what a client's registration leaves out", { timeout: 120_000 }, () => {
  const SELF_ONLY = {
    tools: ["get_self", "context", "build_context_pack"] as PersonalTool[],
    views: ["self"] as PersonalView[],
  };
  const WORK_NO_TOOL = { ...SELF_ONLY, views: ["self", "work"] as PersonalView[] };
  const HOLDS = {
    tools: [...SELF_ONLY.tools, "list_goals"] as PersonalTool[],
    views: ["self", "work", "people"] as PersonalView[],
  };

  it("says goals are withheld from a client past the gate, and nothing from one that holds it", async () => {
    const store = await opened();
    await goal(store, "Close the round.", "own", "2026-03-01T00:00:00.000Z");
    const self = await withheldOf(store, await add(store, "self-only", ["own"], SELF_ONLY));
    expect(self.self).toEqual(["goals", "work", "applications"]);
    expect(self.context).toEqual(["people", "evidence", "commitments", "goals"]);
    expect(self.pack).toContain("goals");
    expect(self.pack).toContain("commitments");
    const noTool = await withheldOf(store, await add(store, "work-no-tool", ["own"], WORK_NO_TOOL));
    expect(noTool.self).toEqual(["goals", "applications"]);
    expect(noTool.context).toEqual(["people", "evidence", "goals"]);
    expect(noTool.pack).toContain("goals");
    const holds = await withheldOf(store, await add(store, "holds", ["own"], HOLDS));
    expect(holds).toEqual({ self: undefined, context: undefined, pack: undefined });
  });

  it("invariant 6: the signal is the same whether the owner has a goal, none, or one outside the clearance", async () => {
    const store = await opened();
    const past = await add(store, "past-gate", ["own"], WORK_NO_TOOL);
    const holder = await add(store, "narrow-holder", ["own"], HOLDS);
    const none = { past: await withheldOf(store, past), holder: await withheldOf(store, holder) };
    await goal(store, "Close the round.", "own", "2026-03-01T00:00:00.000Z");
    await goal(store, "A goal under another compartment.", HIDDEN, "2026-03-02T00:00:00.000Z");
    expect(await withheldOf(store, past)).toEqual(none.past);
    // A goal outside the clearance of a client past no gate is simply not there: never `withheld`.
    expect(await withheldOf(store, holder)).toEqual(none.holder);
    expect(none.holder).toEqual({ self: undefined, context: undefined, pack: undefined });
    // No part of the answer past the gate names or counts them.
    const answer = JSON.stringify(outcomeValue(await store.reader.getSelf(past, {})));
    expect(answer).not.toContain("Close the round");
    expect(outcomeValue(await store.reader.getSelf(past, {})).goals).toEqual([]);
  });
});

describe("list_goals", { timeout: 120_000 }, () => {
  it("lists the active goals newest set first, each with its statement, status and time; a status filter and any", async () => {
    const store = await opened();
    const first = await goal(store, "Ship the review.", "own", "2026-01-01T00:00:00.000Z");
    const second = await goal(store, "Hire two operators.", "own", "2026-02-01T00:00:00.000Z");
    const third = await goal(store, "Close the round.", "own", "2026-03-01T00:00:00.000Z");
    expect(await store.admin.work.setGoalStatus(second, "paused", { requestId: "req-read-goals-pause" })).toBe(true);
    const token = await add(store, "lister", ["own"]);

    expect(outcomeValue(await store.reader.listGoals(token, {}))).toEqual({
      goals: [
        {
          id: third,
          statement: { untrusted: "Close the round." },
          status: "active",
          setAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: first,
          statement: { untrusted: "Ship the review." },
          status: "active",
          setAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      more: false,
    });
    expect(statements(outcomeValue(await store.reader.listGoals(token, { status: "paused" })))).toEqual([
      "Hire two operators.",
    ]);
    expect(outcomeValue(await store.reader.listGoals(token, { status: "paused" })).goals[0]?.status).toBe("paused");
    expect(statements(outcomeValue(await store.reader.listGoals(token, { status: "any" })))).toEqual([
      "Close the round.",
      "Hire two operators.",
      "Ship the review.",
    ]);
    expect(outcomeValue(await store.reader.listGoals(token, { status: "done" }))).toEqual({ goals: [], more: false });
    expect(await store.reader.listGoals(token, { status: "open" as never })).toEqual({
      ok: false,
      code: "invalid_request",
    });

    // One call row each, with the goals returned as its rows.
    const calls = await queryAs<{ tool: string; rows: number; outcome: string }>(
      store.db.urls.admin,
      "select tool, rows, outcome from policy.calls order by id",
    );
    expect(calls).toEqual([
      { tool: "list_goals", rows: 2, outcome: "ok" },
      { tool: "list_goals", rows: 1, outcome: "ok" },
      { tool: "list_goals", rows: 1, outcome: "ok" },
      { tool: "list_goals", rows: 3, outcome: "ok" },
      { tool: "list_goals", rows: 0, outcome: "ok" },
      { tool: "list_goals", rows: 0, outcome: "invalid_request" },
    ]);
    // Each ok call's read log row names no evidence, a goal being none, and the goals it returned
    // by their ids, so an audit can follow what the client saw.
    const logged = await queryAs<{ bound: string[]; shown: string[]; goals: string[] }>(
      store.db.urls.admin,
      "select bound, shown, goals from ledger.read_log where tool = 'list_goals' order by id",
    );
    expect(logged).toEqual([
      { bound: [], shown: [], goals: [first, third].sort() },
      { bound: [], shown: [], goals: [second] },
      { bound: [], shown: [], goals: [second] },
      { bound: [], shown: [], goals: [first, second, third].sort() },
      { bound: [], shown: [], goals: [] },
    ]);
  });

  it("at most 50, and more says more matched", async () => {
    const store = await opened();
    for (let n = 0; n < 51; n += 1)
      await goal(store, `Goal ${n}.`, "own", new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString());
    const list = outcomeValue(await store.reader.listGoals(await add(store, "lister", ["own"]), {}));
    expect(list.goals).toHaveLength(50);
    expect(list.more).toBe(true);
    expect(list.goals[0]?.statement.untrusted).toBe("Goal 50.");
  });

  it("invariant 6: a goal outside the clearance is not served and changes nothing the client is answered", async () => {
    const store = await opened();
    await goal(store, "Ship the review.", "own", "2026-01-01T00:00:00.000Z");
    const narrow = await add(store, "narrow", ["own"]);
    const wide = await add(store, "wide", ["own", HIDDEN]);
    const asks = [{}, { status: "any" as const }, { status: "paused" as const }];
    const before = await Promise.all(asks.map(async (ask) => outcomeValue(await store.reader.listGoals(narrow, ask))));
    await goal(store, "A goal of the employer.", HIDDEN, "2026-04-01T00:00:00.000Z");
    const after = await Promise.all(asks.map(async (ask) => outcomeValue(await store.reader.listGoals(narrow, ask))));
    expect(after).toEqual(before);
    // The control: a client cleared for it is served it.
    expect(statements(outcomeValue(await store.reader.listGoals(wide, {})))).toEqual([
      "A goal of the employer.",
      "Ship the review.",
    ]);
  });

  it("a client without the tool or the work view is refused, and the reader's policy shows it no goal; the reasoner's is kept", async () => {
    const store = await opened();
    await goal(store, "Ship the review.", "own", "2026-01-01T00:00:00.000Z");
    const lister = await add(store, "lister", ["own"]);
    const noTool = await add(store, "no-tool", ["own"], { tools: ["get_self"], views: ["self", "work"] });
    const noView = await add(store, "no-view", ["own"], { views: ["self"] });
    const reasoner = (
      await store.admin.clients.addClient(
        registration("thinker", ["own"], { kind: "reasoner", tools: ["get_self"], views: ["self"] }),
      )
    ).token;

    expect(await store.reader.listGoals(noTool, {})).toEqual({ ok: false, code: "not_permitted" });
    expect(await store.reader.listGoals(noView, {})).toEqual({ ok: false, code: "not_permitted" });

    // The database's own rule, under each token as pi_reader.
    const seen = (token: string) =>
      readAs(
        store.db,
        token,
        async (query) => (await query<{ n: number }>("select count(*)::int as n from projections.goal_state"))[0]?.n,
      );
    expect(await seen(lister)).toBe(1);
    expect(await seen(noTool)).toBe(0);
    expect(await seen(noView)).toBe(0);
    expect(await seen(reasoner)).toBe(1);
  });
});
