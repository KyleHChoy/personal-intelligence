import { type Claim, ClaimId, EvidenceId, type StatementKind, type Timestamp } from "@intelligence/contracts";
import type { BeliefClaim, ClaimRecord } from "@intelligence/contracts/personal";
import {
  currentClaims,
  lifecycleOf,
  momentary,
  needQuestions,
  OWNER_LIFECYCLE,
  retiredBy,
  timed,
} from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { world } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import type { ExtractDeps } from "./config.ts";
import { type MemoryPipelineStore, memoryPipelineStore, OWNER_ENTITY } from "./test-support/memory-store.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";

// Momentary and lasting situations, retire until restated, and the owner's needs
// asked as questions. Synthetic claims only.

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T12:00:00.000Z");
const W = world({ now: NOW });
const OWN = ["own"];
const evidence = (n: number) => EvidenceId.parse(n.toString(16).padStart(64, "0"));
const daysAgo = (days: number): Timestamp => new Date(NOW.getTime() - days * DAY).toISOString() as Timestamp;

type Shape = {
  n: number;
  type?: "situation" | "need" | "goal";
  what?: string;
  kind?: StatementKind;
  ago?: number;
  until?: Timestamp;
  factKey?: string;
  ownerSaid?: boolean;
};

function record(shape: Shape): ClaimRecord {
  const evidenceId = evidence(shape.n);
  const claim: Claim = {
    id: ClaimId.parse(`claim-${shape.n}`),
    content: {
      type: shape.type ?? "situation",
      subject: OWNER_ENTITY,
      fields: { what: shape.what ?? "on parental leave" },
    },
    statementKind: shape.kind ?? "stated_fact",
    basis: "explicit_self",
    ...(shape.ownerSaid === false ? {} : { assertedBy: OWNER_ENTITY }),
    validFrom: daysAgo(shape.ago ?? 1),
    ...(shape.until === undefined ? {} : { validTo: shape.until }),
    evidence: [{ evidenceId, span: "chars:0-24" }],
    primaryEvidenceId: evidenceId,
    label: { compartments: ["own"], readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  };
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: shape.factKey ?? `fact-${shape.n}`,
    lane: "correspondence",
    fieldKinds: { what: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  };
}

const put = (store: MemoryPipelineStore, ...shapes: Shape[]): void => {
  for (const shape of shapes) store.putClaims(evidence(shape.n), [record(shape)]);
};

const deps = (store: MemoryPipelineStore, now = NOW): ExtractDeps => ({
  store,
  model: fakeModelClient({}),
  modelId: "test/model",
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => now,
});

const statusOf = (store: MemoryPipelineStore, n: number): string | undefined =>
  store.beliefs(OWN).find((one) => (one.belief.support as string[]).includes(`claim-${n}`))?.belief.status;
const beliefClaim = (shape: Shape, more: Partial<BeliefClaim> = {}): BeliefClaim => ({
  claim: record(shape).claim,
  origin: "source",
  subjectKind: "owner",
  ownerSaid: shape.ownerSaid !== false,
  ...more,
});

describe("momentary situations", () => {
  it("a situation with a same-day or next-day word, or an until within 7 days, is momentary", () => {
    expect(momentary(record({ n: 1, what: "working from the airport today" }).claim)).toBe(true);
    expect(momentary(record({ n: 2, what: "away", until: daysAgo(-3) }).claim)).toBe(true);
    expect(momentary(record({ n: 3, what: "on parental leave" }).claim)).toBe(false);
    expect(momentary(record({ n: 4, what: "on sabbatical", until: daysAgo(-90) }).claim)).toBe(false);
    // Only a situation: a need with the word is no momentary situation.
    expect(momentary(record({ n: 5, type: "need", what: "a ride tomorrow" }).claim)).toBe(false);
  });

  it("a version 4 situation is momentary by its momentary field or by a word in its state", () => {
    const v4 = (fields: Record<string, unknown>) => {
      const claim = record({ n: 1 }).claim;
      return {
        ...claim,
        content: { ...claim.content, fields: { state: "on parental leave", domain: "family", ...fields } },
      };
    };
    expect(momentary(v4({}))).toBe(false);
    expect(momentary(v4({ momentary: true }))).toBe(true);
    expect(momentary(v4({ state: "at the dentist today" }))).toBe(true);
    // The word rule is code's: `momentary: false` does not undo it.
    expect(momentary(v4({ state: "at the dentist today", momentary: false }))).toBe(true);
    expect(timed(v4({ momentary: true })).validTo).toBe(daysAgo(-6));
  });

  it("a momentary one with no until ends 7 days after its time; an until given is kept", () => {
    expect(timed(record({ n: 1, what: "in meetings all day today", ago: 2 }).claim).validTo).toBe(daysAgo(-5));
    expect(timed(record({ n: 2, what: "out tonight", until: daysAgo(-1) }).claim).validTo).toBe(daysAgo(-1));
    const lasting = record({ n: 3 }).claim;
    expect(timed(lasting)).toBe(lasting);
  });

  it("at the rebuild, a momentary situation is expired a week on, and a lasting one of the owner's is still active at 300 days", async () => {
    const store = await memoryPipelineStore(W);
    put(
      store,
      { n: 1, what: "at the dentist this morning", ago: 8 },
      { n: 2, what: "at a conference tomorrow", ago: 3 },
      { n: 3, what: "living abroad", ago: 300 },
    );
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 1)).toBe("expired");
    expect(statusOf(store, 2)).toBe("active");
    expect(statusOf(store, 3)).toBe("active");
  });

  it("an ended momentary situation does not hide the subject's lasting one, which keeps its own age", async () => {
    const kept = [
      beliefClaim({ n: 1, what: "living abroad", ago: 300 }),
      beliefClaim({ n: 2, what: "at the dentist today", ago: 8 }),
    ];
    expect(currentClaims(kept, NOW.toISOString()).map((one) => one.claim.id)).toEqual(["claim-1"]);
    // Within its week the momentary one is kept, and wins as the latest.
    expect(
      currentClaims(
        [kept[0] as BeliefClaim, beliefClaim({ n: 3, what: "at the dentist today", ago: 2 })],
        NOW.toISOString(),
      ).map((one) => one.claim.id),
    ).toEqual(["claim-1", "claim-3"]);
    // All ended: all are given, and the belief is expired.
    expect(currentClaims([kept[1] as BeliefClaim], NOW.toISOString())).toHaveLength(1);

    const store = await memoryPipelineStore(W);
    put(
      store,
      { n: 1, what: "living abroad", ago: 300, factKey: "fact-situation" },
      { n: 2, what: "at the dentist today", ago: 8, factKey: "fact-situation" },
    );
    await rebuildBeliefs(deps(store));
    const [belief] = store.beliefs(OWN);
    expect(belief?.belief.support).toEqual(["claim-1"]);
    expect(belief?.belief.status).toBe("active");
    expect(belief?.belief.lastConfirmedAt).toBe(daysAgo(300));
  });

  it("the owner's lasting situation goes stale after a year, and the shared limits stay for anyone else", async () => {
    expect(lifecycleOf("owner").situation).toEqual({ staleAfterDays: 365, endAfterDays: 36_500, end: "dormant" });
    expect(lifecycleOf("person").situation).toEqual({ staleAfterDays: 60, endAfterDays: 120, end: "expired" });
    expect(OWNER_LIFECYCLE.need).toEqual(lifecycleOf("person").need);
    const store = await memoryPipelineStore(W);
    put(store, { n: 1, what: "living abroad", ago: 400 });
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 1)).toBe("stale");
  });
});

describe("retire until restated", () => {
  const own = (compartments: readonly string[]): boolean => compartments.every((one) => one === "own");

  it("retiredBy answers the latest retire the audience holds, unless a counted claim is dated after it", () => {
    const early = { id: "rul_1", factKeyFp: "fp", at: daysAgo(30), compartments: ["own"] };
    const late = { id: "rul_2", factKeyFp: "fp", at: daysAgo(5), compartments: ["own"] };
    const said = (ago: number): Claim => record({ n: ago, ago }).claim;
    expect(retiredBy([early, late], "fp", own, [said(40)], NOW.toISOString())?.id).toBe("rul_2");
    expect(retiredBy([early], "fp", own, [said(40), said(10)], NOW.toISOString())).toBeUndefined();
    expect(retiredBy([early, late], "fp", own, [said(10)], NOW.toISOString())?.id).toBe("rul_2");
    expect(retiredBy([early], "other", own, [said(40)], NOW.toISOString())).toBeUndefined();
    expect(
      retiredBy([{ ...early, compartments: ["employer:example", "own"] }], "fp", own, [said(40)], NOW.toISOString()),
    ).toBeUndefined();
  });

  it("a retired fact is closed, and the owner stating it again reopens it", async () => {
    const store = await memoryPipelineStore(W);
    put(store, { n: 1, type: "goal", what: "build a venture", ago: 200, factKey: "fact-venture" });
    store.retireFact("fact-venture", ["own"], daysAgo(100));
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 1)).toBe("closed");
    put(store, { n: 2, type: "goal", what: "build a venture", ago: 10, factKey: "fact-venture" });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN).find((one) => (one.belief.support as string[]).includes("claim-2"))?.belief.status).toBe(
      "active",
    );
  });

  it("a claim from before the retire, taken in later, does not reopen it; a lift does", async () => {
    const store = await memoryPipelineStore(W);
    put(store, { n: 1, type: "goal", what: "build a venture", ago: 200, factKey: "fact-venture" });
    const ruling = store.retireFact("fact-venture", ["own"], daysAgo(100));
    put(store, { n: 2, type: "goal", what: "build a venture", ago: 150, factKey: "fact-venture" });
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 2)).toBe("closed");
    store.lift(ruling);
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 2)).not.toBe("closed");
  });
});

describe("needs asked as questions", () => {
  it("picks the owner's own recent need questions with no short-time word, the latest first", () => {
    const groups = [
      {
        claims: [
          beliefClaim({ n: 1, type: "need", kind: "question", what: "a good immigration lawyer", ago: 5 }),
          beliefClaim({ n: 2, type: "need", kind: "question", what: "an accountant for the company", ago: 1 }),
          beliefClaim({ n: 3, type: "need", kind: "question", what: "a parking spot tomorrow", ago: 1 }),
          beliefClaim({ n: 4, type: "need", kind: "question", what: "a mentor in climate", ago: 61 }),
          beliefClaim({ n: 5, type: "need", kind: "stated_fact", what: "a designer", ago: 1 }),
          beliefClaim({ n: 6, type: "need", kind: "question", what: "a co-founder", ago: 1, ownerSaid: false }),
          beliefClaim({ n: 7, type: "goal", kind: "question", what: "raise a round", ago: 1 }),
          beliefClaim(
            { n: 8, type: "need", kind: "question", what: "a tax adviser", ago: 1 },
            { ownerConfirmed: true },
          ),
          beliefClaim({ n: 9, type: "need", kind: "question", what: "a lawyer", ago: 1 }, { origin: "agent_record" }),
          beliefClaim({ n: 10, type: "need", kind: "question", what: "a lawyer", ago: 1 }, { subjectKind: "person" }),
        ],
      },
    ];
    expect(needQuestions(groups, NOW.toISOString())).toEqual(["claim-2", "claim-1"]);
  });

  it("raises a card for every need question found, the latest first, and once a card each", async () => {
    const store = await memoryPipelineStore(W, { now: () => NOW });
    const many = Array.from({ length: 6 }, (_, i) => ({
      n: i + 1,
      type: "need" as const,
      kind: "question" as const,
      what: `a reference for role ${i + 1}`,
      ago: i + 1,
    }));
    put(store, ...many);
    await rebuildBeliefs(deps(store));
    expect(store.questionCards().map((one) => one.claimId)).toEqual(many.map((one) => `claim-${one.n}`));
    // Again the same day: none twice.
    await rebuildBeliefs(deps(store));
    expect(store.questionCards()).toHaveLength(many.length);
  });

  it("a question builds no need until the owner confirms it, and then counts", async () => {
    const store = await memoryPipelineStore(W);
    put(store, { n: 1, type: "need", kind: "question", what: "a good immigration lawyer", ago: 3 });
    await rebuildBeliefs(deps(store));
    expect(store.beliefs(OWN)).toEqual([]);
    store.confirm(evidence(1));
    await rebuildBeliefs(deps(store));
    expect(statusOf(store, 1)).toBe("active");
  });
});
