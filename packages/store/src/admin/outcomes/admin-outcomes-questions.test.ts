import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Query } from "../../core/db.ts";
import { ownerQuestions, TRIED_FIRST_KINDS } from "./admin-outcomes-questions.ts";

// The share of the owner's questions something tried first, with no database: the arithmetic, and
// which cards the statement counts as tried. The counts are proven in identity-agents.db.test.ts.

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-01-31T00:00:00.000Z";

function fake(rows: object[], full = false): { query: Query; asked: string[] } {
  const asked: string[] = [];
  const query = (async (text: string) => {
    asked.push(text);
    if (text.includes("from policy.migrations")) return [{ full }];
    if (text.includes("as tried")) return rows;
    if (text.includes("as overturned")) return [{ settled: 0, overturned: 0 }];
    return [{ n: 0 }];
  }) as Query;
  return { query, asked };
}

const row = (kind: string, n: number, tried: Partial<Record<"tried" | "agents" | "code" | "attempted", number>>) => ({
  kind,
  week: "2026-01-05",
  n,
  tried: 0,
  agents: 0,
  code: 0,
  repeats: 0,
  stopped: 0,
  settled: 0,
  attempted: 0,
  by_agent: 0,
  waiting: 0,
  ...tried,
});

describe("owner questions something tried first", () => {
  it("counts every way a card was tried, not one kind alone", async () => {
    const { query } = fake([
      row("same_person_batch", 1, { tried: 1, agents: 1 }),
      row("opportunity_decision", 10, { tried: 10, code: 10, attempted: 4 }),
      row("about_you", 6, { tried: 3, attempted: 3 }),
      row("goal_proposal", 3, {}),
    ]);
    const attempted = (await ownerQuestions(query, SINCE, UNTIL, ["own"])).find(
      (one) => one.metric === "owner_questions_attempted",
    );
    expect(attempted).toMatchObject({
      value: 0.7,
      sample: 20,
      state: "ok",
      parts: { agents: 1, code: 10, attempted: 7, untried: 6 },
    });
  });

  it("names the kinds agents or code try first, each a kind that asks, and reads agents' answers", async () => {
    const kinds = [...TRIED_FIRST_KINDS.agents, ...TRIED_FIRST_KINDS.code];
    expect(kinds).toEqual(expect.arrayContaining(["opportunity_decision", "same_person_batch"]));
    for (const kind of kinds) expect(CARD_OPTIONS[kind].length, kind).toBeGreaterThan(1);
    const { query, asked } = fake([]);
    await ownerQuestions(query, SINCE, UNTIL, ["own"]);
    const questions = asked.find((text) => text.includes("as tried")) ?? "";
    expect(questions).toContain("ledger.card_answers");
    for (const kind of kinds) expect(questions).toContain(`'${kind}'`);
  });

  it("leaves out what an agent settled and what waits on one, and counts an agent's answer as a try", async () => {
    const { query, asked } = fake([
      { ...row("reminder", 5, {}), by_agent: 2, waiting: 1 },
      { ...row("same_fact", 4, { tried: 3 }), attempted: 3 },
    ]);
    const metrics = await ownerQuestions(query, SINCE, UNTIL, ["own"]);
    const perWeek = metrics.find((one) => one.metric === "owner_questions_per_week");
    expect(perWeek).toMatchObject({
      sample: 6,
      parts: { reminder: 2, same_fact: 4, settled_by_agent: 2, waiting_on_agent: 1 },
    });
    expect(metrics.find((one) => one.metric === "owner_questions_attempted")).toMatchObject({
      value: 0.5,
      sample: 6,
      parts: { attempted: 3, untried: 3 },
    });
    // An attempt is an answer within the caller's label, given before the owner's own.
    const statement = asked.find((text) => text.includes("as tried")) ?? "";
    expect(statement).toContain("from ledger.card_answers a");
    expect(statement).toContain("a.compartments <@ $3::text[]");
    expect(statement).toContain("s.asked and t.attempted");
  });

  // A window with no question is the goal reached, where the store was there for all of it.
  it("reads 0 and healthy over a full window with no question, and no data on a store younger than the window", async () => {
    const perWeek = async (rows: object[], full: boolean) =>
      (await ownerQuestions(fake(rows, full).query, SINCE, UNTIL, ["own"])).find(
        (one) => one.metric === "owner_questions_per_week",
      );
    expect(await perWeek([], true)).toMatchObject({ value: 0, sample: 0, state: "ok" });
    expect((await perWeek([], true))?.code).toBeUndefined();
    expect(await perWeek([], false)).toMatchObject({
      value: null,
      sample: 0,
      state: "no_data",
      code: "window_not_full",
    });
    // A question asked is judged whatever the store's age.
    expect(await perWeek([row("reminder", 5, {})], false)).toMatchObject({ sample: 5, state: "ok" });
  });
});
