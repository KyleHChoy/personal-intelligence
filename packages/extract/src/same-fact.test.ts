import type { DecisionPointCall, FactRuling } from "@intelligence/contracts/personal";
import { PAIR_CALLS_PER_RUN, PROMPT_PINS, Rung2Output } from "@intelligence/contracts/personal";
import { promptTextHash, renderPrompt } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { cutPassage, PASSAGE_BYTES, strongCite } from "./cite.ts";
import { DECIDE_SAME_FACT, EXTRACT_SAME_FACT } from "./question-prompts.ts";
import {
  candidatePairs,
  checkPair,
  pairSlot,
  rowOf,
  type SameFactBelief,
  type SameFactModels,
  type SameFactPair,
  sameFactKey,
  sameFactRung0,
  sweepSameFact,
  verifyPairCites,
} from "./same-fact.ts";

// The same-fact sweep's pure rules. The climb through the real ladder, with fake the decide model and
// the extract model, is tested in apps/pi (same-fact.test.ts), which may import the ladder.

const fp = (n: number): string => n.toString(16).padStart(64, "0");
const OWNER = "ent_owner";
const AUDIENCE = ["agent:alpha", "own"];

let made = 0;
function belief(
  over: Partial<SameFactBelief> & { phrase?: string; domain?: string | null; polarity?: string } = {},
): SameFactBelief {
  made += 1;
  const { phrase = "lives in portland", domain = "home", polarity, ...rest } = over;
  const type = rest.type ?? "situation";
  const field =
    type === "goal"
      ? "objective"
      : type === "preference" || type === "need" || type === "capability"
        ? "object"
        : type === "constraint"
          ? "rule"
          : "state";
  return {
    fp: fp(made),
    subject: OWNER,
    type,
    compartments: ["own"],
    at: `2026-09-${String(10 + (made % 15)).padStart(2, "0")}T09:00:00.000Z`,
    fields: {
      [field]: phrase,
      ...(domain === null ? {} : { domain }),
      ...(polarity === undefined ? {} : { polarity }),
    },
    passage: `I said ${phrase} in a message.`,
    evidence: `ev_${made}`,
    ...rest,
  };
}

const call = (over: Partial<DecisionPointCall>): DecisionPointCall => ({
  point: "claims_same_fact",
  version: 1,
  definitionHash: "a".repeat(64),
  rung: 1,
  inputHash: "b".repeat(64),
  output: "same",
  effect: "propose_grouping",
  effectClass: "internal_reversible",
  escalated: false,
  ...over,
});

const subjects = (pairs: SameFactPair[]): string[][] => pairs.map((pair) => [pair.a.phrase, pair.b.phrase].sort());

describe("the candidate rule", () => {
  it("pairs two phrasings of one fact, R8's own example, and not two unrelated ones", () => {
    const pairs = candidatePairs(AUDIENCE, [
      belief({ phrase: "lives in Portland" }),
      belief({ phrase: "based in Portland, OR" }),
      belief({ phrase: "training for a marathon" }),
    ]);
    expect(subjects(pairs)).toEqual([["based in portland or", "lives in portland"]]);
    expect(pairs[0]?.subject).toMatch(/^facts:[0-9a-f]{64}:[0-9a-f]{64}$/);
    expect((pairs[0]?.a.fp ?? "") < (pairs[0]?.b.fp ?? "")).toBe(true);
  });

  it("never pairs two domains, two subjects, two kinds or two polarities", () => {
    expect(candidatePairs(AUDIENCE, [belief({ domain: "home" }), belief({ domain: "travel" })])).toEqual([]);
    expect(candidatePairs(AUDIENCE, [belief({}), belief({ subject: "ent_other" })])).toEqual([]);
    expect(
      candidatePairs(AUDIENCE, [
        belief({ type: "goal", phrase: "move to portland" }),
        belief({ type: "need", phrase: "move to portland" }),
      ]),
    ).toEqual([]);
    const prefers = belief({ type: "preference", domain: "admin", phrase: "email", polarity: "prefers" });
    const avoids = belief({ type: "preference", domain: "admin", phrase: "email", polarity: "avoids" });
    expect(candidatePairs(AUDIENCE, [prefers, avoids])).toEqual([]);
    const negated = belief({ type: "preference", domain: "admin", phrase: "no email", polarity: "prefers" });
    expect(subjects(candidatePairs(AUDIENCE, [negated, avoids]))).toEqual([["email", "email"]]);
  });

  it("keys with no domain pair with each other, and never with a key that has one", () => {
    const none = [
      belief({ domain: null, type: "goal", phrase: "raise the seed round" }),
      belief({ domain: null, type: "goal", phrase: "raise a seed round now" }),
    ];
    expect(candidatePairs(AUDIENCE, none)).toHaveLength(1);
    expect(
      candidatePairs(AUDIENCE, [
        none[0] as SameFactBelief,
        belief({ domain: "ventures", type: "goal", phrase: "raise the seed round" }),
      ]),
    ).toEqual([]);
  });

  it("two compartment sets an audience holds are paired", () => {
    const pairs = candidatePairs(AUDIENCE, [
      belief({ compartments: ["own"] }),
      belief({ compartments: ["agent:alpha"], phrase: "based in portland" }),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it("the ten newest keys of a group are paired, and the eleventh is not", () => {
    const keys = Array.from({ length: 11 }, (_, n) =>
      belief({ phrase: "lives in portland", at: `2026-09-${String(n + 1).padStart(2, "0")}T09:00:00.000Z` }),
    );
    const pairs = candidatePairs(AUDIENCE, keys);
    expect(pairs).toHaveLength(45);
    const oldest = keys[0]?.fp;
    expect(pairs.some((pair) => pair.a.fp === oldest || pair.b.fp === oldest)).toBe(false);
  });

  it("a key of another kind, or with no phrase, is never a candidate", () => {
    expect(sameFactKey(belief({ type: "role" }))).toBeNull();
    expect(sameFactKey(belief({ phrase: "!!" }))).toBeNull();
  });
});

describe("rung 0", () => {
  const [a, b] = [belief({ phrase: "lives in portland" }), belief({ phrase: "based in portland" })];
  const pair = candidatePairs(AUDIENCE, [a, b])[0] as SameFactPair;
  const ruling = (verdict: "join" | "split", compartments = ["own"]): FactRuling => ({
    id: "rul_x",
    verdict,
    a: pair.a.fp,
    b: pair.b.fp,
    at: "2026-09-30T00:00:00.000Z",
    compartments,
  });

  it("a split says different, a join same, and equal phrases same; else the ladder decides", () => {
    expect(sameFactRung0(pair, [ruling("split")])).toEqual({ output: "different", reason: "split" });
    expect(sameFactRung0(pair, [ruling("join")])).toEqual({ output: "same", reason: "join" });
    expect(sameFactRung0(pair, [ruling("join"), ruling("split")])).toMatchObject({ output: "different" });
    expect(sameFactRung0(pair, [])).toBe("cannot_decide");
    const equal = candidatePairs(AUDIENCE, [
      belief({ phrase: "Lives in the Portland" }),
      belief({ phrase: "lives in portland" }),
    ])[0] as SameFactPair;
    expect(sameFactRung0(equal, [])).toEqual({ output: "same", reason: "equal_phrase" });
  });

  it("a join in compartments the audience does not hold does not count in it", () => {
    expect(sameFactRung0(pair, [ruling("join", ["employer:example", "own"])])).toBe("cannot_decide");
  });

  it("a split binds every audience, even one that cannot read its label", () => {
    const split = ruling("split", ["employer:example", "own"]);
    expect(sameFactRung0(pair, [split])).toEqual({ output: "different", reason: "split" });
    expect(checkPair(pair, new Set([pair.a.fp, pair.b.fp]), [split])).toBe(false);
  });
});

describe("the slot and Luna's citations", () => {
  const [a, b] = [
    belief({ phrase: "lives in portland", passage: "These days I live in Portland, near the lake." }),
    belief({ phrase: "based in portland", passage: "Our team is based in Portland, OR." }),
  ];
  const pair = candidatePairs(AUDIENCE, [a, b])[0] as SameFactPair;

  it("the slot holds the kind, the two key phrases and the passages, and nothing else of the claims", () => {
    const slot = JSON.parse(pairSlot(pair)) as { type: string; a: Record<string, unknown>; b: Record<string, unknown> };
    expect(slot.type).toBe("situation");
    expect(Object.keys(slot).sort()).toEqual(["a", "b", "type"]);
    expect(slot.a).toEqual({ phrase: "lives in portland", passage: "These days I live in Portland, near the lake." });
    expect(Object.keys(slot.b).sort()).toEqual(["passage", "phrase"]);
    expect(pairSlot(pair)).not.toContain("home");
    expect(pairSlot(pair)).not.toContain(pair.a.fp);
    expect(pairSlot(pair)).not.toContain(OWNER);
  });

  it("a passage is cut to 2 000 bytes, head and tail, between code points", () => {
    const long = `${"é".repeat(1500)}${"z".repeat(1500)}`;
    const cut = cutPassage(long);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(PASSAGE_BYTES);
    expect(cut.startsWith("é")).toBe(true);
    expect(cut.endsWith("z")).toBe(true);
    expect(cutPassage("short")).toBe("short");
  });

  it("a yes is verified only with a citation from each passage, in the normal form", () => {
    const cite = (text: string) => ({ slot: "pair", text });
    expect(
      verifyPairCites({ answer: "yes", cites: [cite("I live in PORTLAND"), cite("based in Portland, OR")] }, pair),
    ).toBe(true);
    expect(verifyPairCites({ answer: "yes", cites: [cite("I live in Portland")] }, pair)).toBe(false);
    expect(verifyPairCites({ answer: "yes", cites: [cite("I live in Portland"), cite("based in Dallas")] }, pair)).toBe(
      false,
    );
    expect(
      verifyPairCites(
        { answer: "yes", cites: [{ slot: "message", text: "I live in Portland" }, cite("based in Portland")] },
        pair,
      ),
    ).toBe(false);
    expect(verifyPairCites({ answer: "no", cites: [] }, pair)).toBe(true);
    expect(verifyPairCites({ answer: "no", cites: [cite("made up")] }, pair)).toBe(false);
  });

  it("a cite of stopwords, or under three words and twelve code points, verifies nothing", () => {
    const cite = (text: string) => ({ slot: "pair", text });
    // Each is in a's passage, and too weak to count for it.
    for (const weak of ["the", "in", "in Portland"]) {
      expect(strongCite(weak), weak).toBe(false);
      expect(verifyPairCites({ answer: "yes", cites: [cite(weak), cite("based in Portland, OR")] }, pair), weak).toBe(
        false,
      );
    }
    expect(strongCite("live in Portland")).toBe(true);
    expect(strongCite("Portland, Oregon")).toBe(true);
    expect(strongCite("in the of a")).toBe(false);
  });
});

describe("code's check and the row", () => {
  const [a, b] = [belief({ phrase: "lives in portland" }), belief({ phrase: "based in portland" })];
  const pair = candidatePairs(AUDIENCE, [a, b])[0] as SameFactPair;
  const held = new Set([a.fp, b.fp]);

  it("checks the audience still holds both keys of one subject, kind, domain and polarity, with no split", () => {
    expect(checkPair(pair, held, [])).toBe(true);
    expect(checkPair(pair, new Set([a.fp]), [])).toBe(false);
    expect(checkPair({ ...pair, b: { ...pair.b, domain: "travel" } }, held, [])).toBe(false);
    expect(checkPair({ ...pair, audience: ["agent:alpha"] }, held, [])).toBe(false);
    expect(
      checkPair(pair, held, [
        {
          id: "rul_x",
          verdict: "split",
          a: pair.a.fp,
          b: pair.b.fp,
          at: "2026-09-30T00:00:00.000Z",
          compartments: ["own"],
        },
      ]),
    ).toBe(false);
  });

  it("an accept is a proposal with a card in shadow and accepted in apply; the middle band a card in both; a reject neither", () => {
    expect(rowOf(pair, call({ rung: 1, band: "accept" }), ["dcc_x"], "shadow", null)).toMatchObject({
      band: "accept",
      state: "proposed",
      card: true,
      rung: 1,
    });
    expect(rowOf(pair, call({ rung: 2, band: "accept" }), [], "apply", null)).toMatchObject({
      band: "accept",
      state: "accepted",
      card: false,
      rung: 2,
    });
    expect(
      rowOf(pair, call({ rung: 4, output: null, effect: null, escalated: true }), [], "apply", null),
    ).toMatchObject({ band: "middle", state: "proposed", card: true });
    expect(rowOf(pair, call({ rung: 1, output: "different", band: "reject" }), [], "shadow", null)).toMatchObject({
      band: "reject",
      state: "rejected",
      card: false,
    });
  });

  it("rung 0: equal phrases accepted with no card in every mode, a join joined, a split split", () => {
    expect(rowOf(pair, call({ rung: 0 }), [], "shadow", "equal_phrase")).toMatchObject({
      band: "accept",
      state: "accepted",
      card: false,
      rung: 0,
    });
    expect(rowOf(pair, call({ rung: 0 }), [], "shadow", "join")).toMatchObject({ state: "joined" });
    expect(rowOf(pair, call({ rung: 0, output: "different" }), [], "apply", "split")).toMatchObject({
      band: "reject",
      state: "split",
    });
  });

  it("a row's label is code's: the sorted audience and the union of the two keys' compartments", () => {
    const wide = candidatePairs(AUDIENCE, [
      belief({ compartments: ["own"] }),
      belief({ compartments: ["agent:alpha"], phrase: "based in portland" }),
    ])[0] as SameFactPair;
    const row = rowOf(wide, call({ rung: 1 }), [], "shadow", null);
    expect(row.audience).toEqual(AUDIENCE);
    expect(row.compartments).toEqual(["agent:alpha", "own"]);
    expect(row.keys).toEqual([wide.a.fp, wide.b.fp]);
  });
});

describe("the sweep", () => {
  const beliefs = [belief({ phrase: "lives in portland" }), belief({ phrase: "based in portland" })];
  const settle = (rung: 0 | 1 | 4) => async () => ({ call: call({ rung }), escalate: rung === 4 });

  it("off runs nothing; a pair asked before is not asked again", async () => {
    const off = await sweepSameFact(
      { mode: "off", audiences: [{ audience: AUDIENCE, beliefs }], rulings: [], asked: new Set() },
      { climb: settle(1) },
    );
    expect(off.rows).toEqual([]);
    const pair = candidatePairs(AUDIENCE, beliefs)[0] as SameFactPair;
    const asked = await sweepSameFact(
      {
        mode: "shadow",
        audiences: [{ audience: AUDIENCE, beliefs }],
        rulings: [],
        asked: new Set([`agent:alpha,own|${pair.subject}`]),
      },
      { climb: settle(1) },
    );
    expect(asked.rows).toEqual([]);
    expect(asked.summary).toMatchObject({ pairs: 1, asked: 0 });
  });

  it("a model's same that code's check refuses groups nothing", async () => {
    // The audience's keys are read again for the check: one held by another audience only.
    const result = await sweepSameFact(
      {
        mode: "apply",
        audiences: [
          {
            audience: ["own"],
            beliefs: [
              belief({ compartments: ["own"] }),
              belief({ compartments: ["agent:alpha"], phrase: "based in portland" }),
            ],
          },
        ],
        rulings: [],
        asked: new Set(),
      },
      { climb: settle(1) },
    );
    expect(result.rows).toEqual([]);
    expect(result.summary.refused).toBe(1);
  });

  it("at most PAIR_CALLS_PER_RUN model calls a run; rung 0 needs none", async () => {
    const many = Array.from({ length: 60 }, (_, n) => belief({ subject: `ent_${n}`, phrase: "lives in portland" }));
    const more = Array.from({ length: 60 }, (_, n) => belief({ subject: `ent_${n}`, phrase: "based in portland" }));
    let asked = 0;
    const result = await sweepSameFact(
      {
        mode: "shadow",
        audiences: [{ audience: AUDIENCE, beliefs: [...many, ...more] }],
        rulings: [],
        asked: new Set(),
      },
      {
        climb: async (input) => {
          const zero = input.rung0(input.facts);
          if (zero !== "cannot_decide") return { call: call({ rung: 0, output: zero.output }), escalate: false };
          await input.rung1();
          await input.rung1();
          return { call: call({ rung: 1 }), escalate: false };
        },
        decideModel: async () => {
          asked += 1;
          return { p: 0.99, savedCall: "dcc_01JABCDEFGHJKMNPQRSTVWXYZ0" };
        },
      },
    );
    expect(result.summary.pairs).toBe(60);
    expect(asked).toBe(PAIR_CALLS_PER_RUN);
    expect(result.summary).toMatchObject({ asked: 50, capped: 10 });
    expect(result.rows.every((row) => row.calls.every((id) => /^dcc_/.test(id)))).toBe(true);
  });

  // Each pair takes one call if it is the first, two after, so the budget is reached at 99.
  const costly = (asked: string[]) => ({
    climb: async (input: Parameters<SameFactModels["climb"]>[0]) => {
      asked.push(input.facts.subject);
      await input.rung1();
      if (asked.length > 1) await input.rung1();
      return { call: call({ rung: 1 }), escalate: false };
    },
    decideModel: async () => ({ p: 0.99, savedCall: "dcc_01JABCDEFGHJKMNPQRSTVWXYZ0" }),
  });
  const pairsOf = (n: number, compartments: string[], tag: string) =>
    Array.from({ length: n }, (_, i) => [
      belief({ subject: `ent_${tag}${i}`, compartments, phrase: "lives in portland" }),
      belief({ subject: `ent_${tag}${i}`, compartments, phrase: "based in portland" }),
    ]).flat();

  it("a pair starts only while both its calls fit the budget, so a run never passes it", async () => {
    const asked: string[] = [];
    const result = await sweepSameFact(
      {
        mode: "shadow",
        audiences: [{ audience: AUDIENCE, beliefs: pairsOf(60, ["own"], "x") }],
        rulings: [],
        asked: new Set(),
      },
      costly(asked),
    );
    expect(result.summary.calls).toBe(99);
    expect(result.summary.calls).toBeLessThanOrEqual(PAIR_CALLS_PER_RUN);
    expect(result.summary).toMatchObject({ asked: 50, capped: 10 });
  });

  it("invariant 6: a wider audience's pairs spend none of a narrower audience's budget", async () => {
    const narrow = { audience: ["own"], beliefs: pairsOf(5, ["own"], "n") };
    const wide = { audience: AUDIENCE, beliefs: pairsOf(80, ["agent:alpha"], "w") };
    const alone: string[] = [];
    await sweepSameFact({ mode: "shadow", audiences: [narrow], rulings: [], asked: new Set() }, costly(alone));
    const beside: string[] = [];
    const both = await sweepSameFact(
      { mode: "shadow", audiences: [wide, narrow], rulings: [], asked: new Set() },
      costly(beside),
    );
    const narrowSubjects = new Set(candidatePairs(narrow.audience, narrow.beliefs).map((pair) => pair.subject));
    expect(beside.filter((subject) => narrowSubjects.has(subject))).toEqual(alone);
    expect(alone).toHaveLength(5);
    expect(both.rows.filter((row) => row.audience.join(",") === "own")).toHaveLength(5);
  });
});

describe('the two prompts (escalation-ladder, "The Jev prompts", R36)', () => {
  it("each text matches its recorded hash and its pin", () => {
    for (const prompt of [DECIDE_SAME_FACT, EXTRACT_SAME_FACT]) {
      const { textHash, ...rest } = prompt;
      expect(promptTextHash(rest), prompt.id).toBe(textHash);
      expect(PROMPT_PINS[`${prompt.id}@${prompt.version}`], prompt.id).toBe(textHash);
    }
  });

  it("Jev's question is fixed word for word; Luna's answers Rung2Output over the same slot", () => {
    expect(JSON.parse(DECIDE_SAME_FACT.instructions)).toEqual({
      same_fact: {
        criteria: {
          false:
            "They say different things, or the same kind of thing with a different value, such as two titles or two organizations.",
          true: "They say the same thing about the same person, organization or project in different words, such as one title at one organization written two ways.",
        },
        instructions: "Do these two statements state the same fact about the same subject?",
        type: "noul",
      },
    });
    expect(EXTRACT_SAME_FACT.slots).toEqual(DECIDE_SAME_FACT.slots);
    expect(EXTRACT_SAME_FACT.outputSchema).toBe(Rung2Output);
    const example = EXTRACT_SAME_FACT.instructions.split("Example output: ")[1] ?? "";
    expect(Rung2Output.safeParse(JSON.parse(example)).success).toBe(true);
    for (const key of ["label", "reader", "compartment", "destination", "store", "grant", "clearance"])
      expect(EXTRACT_SAME_FACT.instructions).toContain(key);
    const rendered = renderPrompt(EXTRACT_SAME_FACT, { pair: '{"a":"</data>"}' }, [EXTRACT_SAME_FACT]).text;
    expect(rendered).toContain("&lt;/data&gt;");
  });
});
