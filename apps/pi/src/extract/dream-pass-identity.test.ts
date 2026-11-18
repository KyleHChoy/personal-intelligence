import type { DreamStore, IdentityPairRow, RelationStore, SourceCheckStore } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { runDreamPass } from "./dream-pass.ts";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// An open question none of whose sides has a passage: the judge never asks it and no candidate is saved,
// so the store offers it again on every read.
const unreadable = (n: number): IdentityPairRow => ({
  question: `idq_${n}`,
  aEntity: `ent_a${n}`,
  bEntity: `ent_b${n}`,
  a: [],
  b: [],
  compartments: ["own"],
  subject: `s${n}`,
  bare: n % 5 === 0,
});

describe("the same-person stage", () => {
  it("ends when the store offers only questions the pass already tried, rather than asking for them forever", async () => {
    const open = Array.from({ length: 25 }, (_, n) => unreadable(n));
    let reads = 0;
    const dream = {
      subjects: async () => [],
      linesLive: async () => false,
      markDreamed: async () => {},
      identityPairs: async (_judge: string, limit: number, skip: ReadonlySet<string> = new Set()) => {
        reads += 1;
        if (reads > 50) throw new Error("the stage did not end");
        return open.filter((one) => !skip.has(one.question)).slice(0, limit);
      },
    } as unknown as DreamStore;
    const relations = { ownerClearance: async () => ["own"] } as unknown as RelationStore;
    const counts = await runDreamPass({
      pass: "weekly",
      relations,
      checks: {} as SourceCheckStore,
      dream,
      pipeline: { noteExposure: async () => 0 },
      lock: async (work) => work(),
      judge: { model: {} as never, modelId: "test/opus" },
      screen: null,
      checker: null,
      caps: { usd: null, calls: null },
      calls: () => 0,
      spent: () => 0,
      deadline: null,
      log: quiet as never,
      now: () => new Date(),
    });
    expect(counts.stopped).toBe("ok");
    expect(counts.identity.pairs).toBe(0);
    // Each counted once, by why it could not be asked.
    expect(counts.identity.unreadable).toBe(25);
    expect(counts.identity.bare).toBe(5);
    // Three reads of ten take all 25; a fourth finds nothing new and the stage ends.
    expect(reads).toBeLessThanOrEqual(4);
  });
});
