import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import type { KeyedCallKey, PersonalLogger } from "@intelligence/contracts/personal";
import type { SameFactBelief } from "@intelligence/personal-extract";
import { fakeKeyedCallStore } from "@intelligence/personal-models/testing";
import type { GroupingRow, GroupingStore } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.ts";
import { runSameFact, type SameFactDeps } from "./same-fact.ts";

// The same-fact sweep through the real ladder (the registry's claims_same_fact@2 and its pinned thresholds), with scripted
// the decide model and the extract model through the keyed replay, on an in-memory grouping store. Each rung's outcome, the
// replay, the exposure note and invariant 5's half that needs no database: no model answer sets a row's keys, audience or
// label. The rows and cards in Postgres are same-fact.db.test.ts's.

const fp = (n: number): string => n.toString(16).padStart(64, "0");
const AUDIENCE = ["own"];
const quiet: PersonalLogger = { info: () => {}, warn: () => {}, error: () => {} } as never;

const belief = (n: number, phrase: string, passage: string, over: Partial<SameFactBelief> = {}): SameFactBelief => ({
  fp: fp(n),
  subject: "ent_owner",
  type: "situation",
  compartments: ["own"],
  at: `2026-09-${String(10 + n).padStart(2, "0")}T09:00:00.000Z`,
  fields: { state: phrase, domain: "home" },
  passage,
  evidence: `${"e".repeat(63)}${n}`,
  ...over,
});
const LIVES = belief(1, "lives in portland", "These days I live in Portland, near the lake.");
const BASED = belief(2, "based in portland or", "Our team is based in Portland, OR.");

// A client that answers every request by `answer(request)`. An answer the prompt's closed schema
// refuses is a rejection, which the keyed replay saves and replays as one.
function scripted(answer: (request: ModelRequest) => unknown) {
  const sent: ModelRequest[] = [];
  const model = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      sent.push(request);
      return {
        output: answer(request),
        label: request.label,
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        modelId: "fake",
      } as ModelResponse;
    },
    async embed() {
      throw Object.assign(new Error("bad_purpose"), { code: "bad_purpose" });
    },
  };
  return { model, sent };
}

// The grouping store, in memory: one saved-call store shared by every call, and the rows saved.
function memoryGrouping(beliefs: SameFactBelief[], mode: "off" | "shadow" | "apply" = "shadow") {
  const calls = fakeKeyedCallStore();
  const rows: GroupingRow[] = [];
  const same = (a: KeyedCallKey, b: KeyedCallKey) =>
    a.promptId === b.promptId && a.subject === b.subject && a.inputHash === b.inputHash;
  const store: GroupingStore = {
    mode: async () => mode,
    audiences: async () => [{ audience: AUDIENCE, beliefs }],
    asked: async () => new Set(),
    calls() {
      let last: KeyedCallKey | null = null;
      return {
        store: {
          find: (key) => {
            last = key;
            return calls.find(key);
          },
          save: (record) => {
            last = record.key;
            return calls.save(record);
          },
        },
        async lastId() {
          const at = calls.records().findIndex((record) => last !== null && same(record.key, last));
          return at < 0 ? null : `dcc_${String(at).padStart(26, "0")}`;
        },
      };
    },
    async save(given) {
      rows.push(...given);
      return { saved: given.length, gone: 0 };
    },
    raiseCards: async () => ({ raised: rows.filter((row) => row.card).length, capped: 0, held: 0 }),
    close: async () => {},
  };
  return { store, rows, saved: () => calls.records() };
}

function deps(
  grouping: GroupingStore,
  decideModel?: ReturnType<typeof scripted>,
  extractModel?: ReturnType<typeof scripted>,
  noted: string[][] = [],
): SameFactDeps {
  return {
    grouping,
    pipeline: {
      beliefDecisions: async () => ({ mark: 0, decisions: [], retirements: [], reclassifications: [], goAt: null }),
      thresholds: async () => [],
      suspensions: async () => [],
      sweepBeliefs: async () => [{ audience: AUDIENCE, records: [] }],
      noteExposure: async (_model, _prompt, ids) => {
        noted.push([...ids]);
        return ids.length;
      },
    },
    ...(decideModel === undefined
      ? {}
      : { decideModel: { model: decideModel.model as never, modelId: "typesafe/jev-1.13" } }),
    ...(extractModel === undefined
      ? {}
      : { extractModel: { model: extractModel.model as never, modelId: "test/luna" } }),
    log: quiet,
  };
}

const yes = {
  answer: "yes",
  cites: [
    { slot: "pair", text: "I live in Portland" },
    { slot: "pair", text: "based in Portland, OR" },
  ],
};

describe("the same-fact sweep through the ladder", () => {
  it("rung 1: Jev at or above 0.95 is a proposal with a card in shadow, accepted with none in apply; Luna is not asked", async () => {
    for (const mode of ["shadow", "apply"] as const) {
      const memory = memoryGrouping([LIVES, BASED], mode);
      const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.97 })), scripted(() => yes)];
      const counts = await runSameFact(deps(memory.store, decideModel, extractModel));
      expect(memory.rows, mode).toEqual([
        {
          audience: AUDIENCE,
          keys: [LIVES.fp, BASED.fp],
          band: "accept",
          rung: 1,
          state: mode === "shadow" ? "proposed" : "accepted",
          card: mode === "shadow",
          calls: ["dcc_00000000000000000000000000"],
          compartments: ["own"],
          at: BASED.at,
        },
      ]);
      expect(extractModel.sent).toHaveLength(0);
      expect(counts).toMatchObject({ pairs: 1, asked: 1, accept: 1, calls: 1, saved: 1 });
    }
  });

  // The logger refuses a key that is not snake case, so the line carries the counts as extract_run's does.
  it("the sweep's log line is accepted by the logger: its counts under snake-case keys", async () => {
    const written: string[] = [];
    const log = createLogger({ write: (line: string) => written.push(line) } as never);
    const memory = memoryGrouping([LIVES, BASED]);
    const counts = await runSameFact({
      ...deps(
        memory.store,
        scripted(() => ({ same_fact: 0.97 })),
      ),
      log,
    });
    expect(written.map((line) => JSON.parse(line))).toEqual([
      {
        event: "same_fact_sweep",
        counts: expect.objectContaining({
          pairs: 1,
          asked: 1,
          accept: 1,
          saved: 1,
          raised: counts.raised,
          cards_capped: counts.cardsCapped,
          cards_held: counts.cardsHeld,
        }),
      },
    ]);
  });

  it("rung 1: Jev at or below 0.2 is rejected, with no card and no Luna", async () => {
    const memory = memoryGrouping([LIVES, BASED]);
    const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.1 })), scripted(() => yes)];
    await runSameFact(deps(memory.store, decideModel, extractModel));
    expect(memory.rows[0]).toMatchObject({ band: "reject", rung: 1, state: "rejected", card: false });
    expect(extractModel.sent).toHaveLength(0);
  });

  it("rung 2: Jev's middle band goes to Luna; a verified yes accepts, a verified no rejects", async () => {
    for (const [answer, band] of [
      [yes, "accept"],
      [{ answer: "no", cites: [{ slot: "pair", text: "near the lake" }] }, "reject"],
    ] as const) {
      const memory = memoryGrouping([LIVES, BASED]);
      const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.6 })), scripted(() => answer)];
      await runSameFact(deps(memory.store, decideModel, extractModel));
      expect(memory.rows[0]).toMatchObject({ band, rung: 2 });
      expect(memory.rows[0]?.calls).toHaveLength(2);
      expect(extractModel.sent).toHaveLength(1);
    }
  });

  it("an unverified, unsure or refused Luna answer escalates to the owner's card, in apply too", async () => {
    for (const answer of [
      { answer: "yes", cites: [{ slot: "pair", text: "I live in Portland" }] },
      {
        answer: "yes",
        cites: [
          { slot: "pair", text: "I live in Dallas" },
          { slot: "pair", text: "based in Portland" },
        ],
      },
      { answer: "unsure", cites: [] },
      // A model that tries to name a label or a fact key is refused by the closed schema.
      { answer: "yes", cites: [], label: { compartments: ["employer:example"] } },
      { answer: "maybe", cites: [] },
    ]) {
      const memory = memoryGrouping([LIVES, BASED], "apply");
      const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.6 })), scripted(() => answer)];
      await runSameFact(deps(memory.store, decideModel, extractModel));
      expect(memory.rows[0], JSON.stringify(answer)).toMatchObject({
        band: "middle",
        rung: 4,
        state: "proposed",
        card: true,
      });
    }
  });

  it("with no Jev configured, Luna answers first; a refused Jev answer is passed to Luna", async () => {
    const alone = memoryGrouping([LIVES, BASED]);
    await runSameFact(
      deps(
        alone.store,
        undefined,
        scripted(() => yes),
      ),
    );
    expect(alone.rows[0]).toMatchObject({ band: "accept", rung: 2 });
    const refused = memoryGrouping([LIVES, BASED]);
    await runSameFact(
      deps(
        refused.store,
        scripted(() => ({ nope: 1 })),
        scripted(() => yes),
      ),
    );
    expect(refused.rows[0]).toMatchObject({ band: "accept", rung: 2 });
  });

  it("equal key phrases are one fact by code at rung 0, with no model call and no card", async () => {
    const memory = memoryGrouping([LIVES, belief(3, "Lives in the Portland", "I live in Portland.")]);
    const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.1 })), scripted(() => yes)];
    await runSameFact(deps(memory.store, decideModel, extractModel));
    expect(memory.rows[0]).toMatchObject({ band: "accept", rung: 0, state: "accepted", card: false, calls: [] });
    expect(decideModel.sent.length + extractModel.sent.length).toBe(0);
  });

  it("a pair asked again replays its saved calls and sends nothing; a live call is noted as exposing its two items first", async () => {
    const memory = memoryGrouping([LIVES, BASED]);
    const noted: string[][] = [];
    const [decideModel, extractModel] = [scripted(() => ({ same_fact: 0.6 })), scripted(() => yes)];
    await runSameFact(deps(memory.store, decideModel, extractModel, noted));
    expect(noted).toEqual([[LIVES.evidence, BASED.evidence].sort(), [LIVES.evidence, BASED.evidence].sort()]);
    await runSameFact(deps(memory.store, decideModel, extractModel, noted));
    expect(decideModel.sent).toHaveLength(1);
    expect(extractModel.sent).toHaveLength(1);
    expect(noted).toHaveLength(2);
    expect(memory.rows[1]).toEqual({ ...memory.rows[0] });
    // The saved calls are keyed by the pair's subject alone: no phrase, name or id of a person.
    for (const record of memory.saved()) {
      expect(record.key.subject).toBe(`facts:${LIVES.fp}:${BASED.fp}`);
      expect(record.compartments).toEqual(["own"]);
    }
  });

  it("invariant 5: whatever Jev and Luna answer, a row's keys, audience and label are code's", async () => {
    const outputs = [{ same_fact: 1 }, { same_fact: 0 }, { same_fact: 0.5 }];
    const extractAnswers = [
      yes,
      { answer: "no", cites: [] },
      { answer: "yes", cites: [], compartments: ["employer:example"], factKey: fp(99), tier: "owner" },
    ];
    for (const output of outputs) {
      for (const answer of extractAnswers) {
        const memory = memoryGrouping([LIVES, BASED], "apply");
        await runSameFact(
          deps(
            memory.store,
            scripted(() => output),
            scripted(() => answer),
          ),
        );
        for (const row of memory.rows) {
          expect(row.keys).toEqual([LIVES.fp, BASED.fp]);
          expect(row.audience).toEqual(AUDIENCE);
          expect(row.compartments).toEqual(["own"]);
          expect(Object.keys(row).sort()).toEqual([
            "at",
            "audience",
            "band",
            "calls",
            "card",
            "compartments",
            "keys",
            "rung",
            "state",
          ]);
        }
      }
    }
  });

  it("off asks nothing", async () => {
    const memory = memoryGrouping([LIVES, BASED], "off");
    const decideModel = scripted(() => ({ same_fact: 1 }));
    expect(await runSameFact(deps(memory.store, decideModel))).toMatchObject({ pairs: 0, asked: 0 });
    expect(decideModel.sent).toHaveLength(0);
  });
});
