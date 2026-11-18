import type { DreamStore, RelationStore, SourceCheckStore } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { runDreamPass } from "./dream-pass.ts";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// A subject's claims in the sweep's order, read 1 at a time past where the last batch left off:
// `total` claims the pass judges, after `stuck` it never can (restricted, or failing to open).
function store(total: number, stuck = 0) {
  const locks: number[] = [];
  // What the pass asked of its stores, in order.
  const order: string[] = [];
  const marked: string[][] = [];
  const all = [
    ...Array.from({ length: stuck }, (_, n) => `stuck-${String(n).padStart(3, "0")}`),
    ...Array.from({ length: total }, (_, n) => `claim-${String(n).padStart(3, "0")}`),
  ];
  const job = (key: string) => ({ claim: { key, id: key, compartments: ["own"] }, candidates: [], unjudged: false });
  const relations = {
    ownerClearance: async () => ["own"],
    sweep: async (_judge: string, _now: string, budget: { limit: number; after?: { at: string; id: string } }) => {
      order.push("sweep");
      const from = budget.after === undefined ? 0 : all.indexOf(budget.after.id) + 1;
      const read = all.slice(from, from + budget.limit);
      const last = read.at(-1);
      return {
        jobs: read.filter((key) => key.startsWith("claim-")).map(job),
        checked: new Set<string>(),
        claims: read.length,
        last: last === undefined ? null : { at: "2026-09-01T00:00:00.000000Z", id: last },
      };
    },
    save: async () => ({ relations: 0, checks: 0, marks: 0 }),
  } as unknown as RelationStore;
  const dream = {
    subjects: async () => [["subject-a"], [], [], []],
    linesLive: async () => false,
    censusCases: async () => {
      order.push("census");
      return [];
    },
    markDreamed: async (ids: string[]) => {
      marked.push(ids);
    },
    fileFindings: async () => 0,
    identityPairs: async () => [],
    identityCensusCases: async () => [],
  } as unknown as DreamStore;
  return { relations, dream, locks, marked, order };
}

const run = (fake: ReturnType<typeof store>, checked = false) => {
  let locks = 0;
  return runDreamPass({
    pass: "weekly",
    relations: fake.relations,
    checks: {} as SourceCheckStore,
    dream: fake.dream,
    pipeline: { noteExposure: async () => 0 },
    lock: async (work) => {
      locks += 1;
      fake.locks.push(locks);
      return work();
    },
    judge: { model: {} as never, modelId: "test/opus" },
    screen: null,
    checker: checked ? { model: {} as never, modelId: "test/sonnet" } : null,
    caps: { usd: null, calls: null },
    calls: () => 0,
    spent: () => 0,
    deadline: null,
    log: quiet as never,
    now: () => new Date(),
  });
};

describe("a subject with many claims", () => {
  it("goes on in chunks of its own, one batch each, and is reviewed once its last batch is done", async () => {
    const fake = store(2);
    const counts = await run(fake);
    expect(counts.stopped).toBe("ok");
    // 1, 1 and an empty read: three chunks, each its own lock, plus the identity stage's one.
    expect(counts.chunks).toBe(3);
    // Each batch a hold of the extract lock of its own, beside the census's and the filing's.
    expect(fake.locks.length).toBeGreaterThan(3);
    expect(fake.marked.filter((ids) => ids.length > 0)).toEqual([["subject-a"]]);
  });

  it("reads past claims it can never mark, so they hide none of the subject's later claims", async () => {
    const fake = store(1, 1);
    const counts = await run(fake);
    expect(counts.stopped).toBe("ok");
    // 1 stuck, then the claim, then an empty read: three chunks, and the subject reviewed.
    expect(counts.chunks).toBe(3);
    expect(fake.marked.filter((ids) => ids.length > 0)).toEqual([["subject-a"]]);
  });

  it("checks the findings already waiting before it sweeps for more", async () => {
    const fake = store(1);
    const counts = await run(fake, true);
    expect(counts.stopped).toBe("ok");
    expect(fake.order[0]).toBe("census");
    expect(fake.order).toContain("sweep");
  });
});
