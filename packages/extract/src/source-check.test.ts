import { type RelationAnswer, SourceCheckAnswer } from "@intelligence/contracts/personal";
import { relationRules } from "@intelligence/personal-core/views";
import { promptTextHash } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { SOURCE_CHECK_POINT } from "./decision-points.ts";
import { SOURCE_CHECK_PROMPT } from "./question-prompts.ts";
import { type AskRelation, type RelationJob, type RelationSide, relateClaims } from "./relations.ts";
import {
  type AskSource,
  type CheckPassage,
  checkSources,
  pickAudits,
  refusedShape,
  type SourceCase,
  sourceCheckJudge,
  sourceSlot,
  stratifiedSample,
  sweepOrder,
  verifySourceCites,
} from "./source-check.ts";

// The source check's rules and the dream pass's order, sample and audit, over stub calls. Invented
// statements and passages; no model is called.

const key = (n: number): string => n.toString(16).padStart(64, "c");
const passage = (n: number, text: string | null): CheckPassage => ({
  claimKey: key(n),
  evidenceId: `item-${n}`,
  text,
  at: "2026-06-01T09:00:00.000Z",
});
const belief = (passages: CheckPassage[], kind = "role"): SourceCase => ({
  target: "belief",
  kind,
  targetKey: key(90),
  relationId: null,
  relationJudge: null,
  statement: { kind: "fact", type: kind, phrase: "partner at Northstar" },
  passages,
  onCited: true,
  subject: `facts:${key(90)}:${key(91)}`,
  compartments: ["own"],
});
const answer = (output: SourceCheckAnswer): AskSource & { calls: number } => {
  const ask = Object.assign(
    async (): Promise<{ output: SourceCheckAnswer }> => {
      ask.calls += 1;
      return { output };
    },
    { calls: 0 },
  ) satisfies AskSource & { calls: number };
  return ask;
};

describe("the prompt and the point", () => {
  it("personal_source_check@4 is pinned by its hash, answers SourceCheckAnswer and takes one case slot, with no tools", () => {
    expect(SOURCE_CHECK_PROMPT.textHash).toBe(promptTextHash(SOURCE_CHECK_PROMPT));
    expect(SOURCE_CHECK_PROMPT.outputSchema).toBe(SourceCheckAnswer);
    expect(SOURCE_CHECK_PROMPT.slots).toEqual(["case"]);
    expect(SOURCE_CHECK_PROMPT.tools).toBe("none");
    expect(SOURCE_CHECK_POINT).toMatchObject({
      id: "source_check",
      version: 1,
      rungs: [2],
      prompt: { id: "personal_source_check", version: "4", textHash: SOURCE_CHECK_PROMPT.textHash },
    });
    const examples = SOURCE_CHECK_PROMPT.instructions
      .split("\n")
      .filter((line) => line.startsWith("Example output"))
      .map((line) => line.slice(line.indexOf("{")));
    expect(examples).toHaveLength(2);
    for (const example of examples) expect(SourceCheckAnswer.safeParse(JSON.parse(example)).success).toBe(true);
    expect(sourceCheckJudge("anthropic/claude-opus-5-5")).toBe(
      "model:anthropic/claude-opus-5-5@personal_source_check@4",
    );
  });

  it("the slot holds the statement and the numbered passages kept, nothing else", () => {
    const slot = JSON.parse(
      sourceSlot(
        belief([
          passage(1, "I am a partner at Northstar now."),
          passage(2, null),
          passage(3, "Northstar named two partners."),
        ]),
      ),
    ) as {
      statement: object;
      passages: { n: number; text: string; said: string }[];
    };
    expect(Object.keys(slot).sort()).toEqual(["passages", "statement"]);
    expect(slot.passages.map((one) => one.n)).toEqual([1, 2]);
    expect(slot.passages[1]?.text).toBe("Northstar named two partners.");
    expect(Object.keys(slot.passages[0] ?? {}).sort()).toEqual(["n", "said", "text"]);
  });

  it("a relation's sides each name the passage they were taken from, numbered among those shown", () => {
    const relation = (passages: CheckPassage[]): Pick<SourceCase, "statement" | "passages"> => ({
      statement: {
        kind: "relation",
        relation: "same_fact",
        from: { type: "affiliation", phrase: "relation: employee" },
        to: { type: "affiliation", phrase: "relation: employee" },
      },
      passages,
    });
    type Sides = { statement: { from: { passage: number | null }; to: { passage: number | null } } };
    const both = JSON.parse(
      sourceSlot(relation([passage(1, "I joined Northstar in May."), passage(2, "She works at Northstar.")])),
    ) as Sides;
    expect([both.statement.from.passage, both.statement.to.passage]).toEqual([1, 2]);
    const second = JSON.parse(sourceSlot(relation([passage(1, null), passage(2, "She works at Northstar.")]))) as Sides;
    expect([second.statement.from.passage, second.statement.to.passage]).toEqual([null, 1]);
  });
});

describe("a relation's check", () => {
  const relationCase = (passages: CheckPassage[]): SourceCase => ({
    ...belief(passages),
    target: "relation",
    kind: "same_fact",
    relationId: "7",
    relationJudge: "model:test/judge@personal_claim_relations@1",
    statement: {
      kind: "relation",
      relation: "same_fact",
      from: { type: "affiliation", phrase: "relation: employee" },
      to: { type: "affiliation", phrase: "relation: employee" },
    },
  });

  it("a relation missing either side's passage is no_passage, with no call", async () => {
    const ask = answer({ verdict: "supported", cites: [{ passage: 1, text: "She works at Northstar" }] });
    const run = await checkSources([relationCase([passage(1, null), passage(2, "She works at Northstar.")])], ask, {
      calls: 5,
    });
    expect(ask.calls).toBe(0);
    expect(run.rows[0]?.code).toBe("no_passage");
  });

  it("a supported relation must cite both sides' passages", async () => {
    const passages = [passage(1, "I joined Northstar in May."), passage(2, "She works at Northstar now.")];
    const one = await checkSources(
      [relationCase(passages)],
      answer({ verdict: "supported", cites: [{ passage: 1, text: "I joined Northstar in May" }] }),
      { calls: 5 },
    );
    expect(one.rows[0]?.code).toBe("uncited");
    const both = await checkSources(
      [relationCase(passages)],
      answer({
        verdict: "supported",
        cites: [
          { passage: 1, text: "I joined Northstar in May" },
          { passage: 2, text: "She works at Northstar now" },
        ],
      }),
      { calls: 5 },
    );
    expect(both.rows[0]?.verdict).toBe("supported");
    const wrong = await checkSources(
      [relationCase(passages)],
      answer({ verdict: "wrong", cites: [{ passage: 2, text: "She works at Northstar now" }] }),
      { calls: 5 },
    );
    expect(wrong.rows[0]?.code).toBe("uncited");
  });
});

describe("the source check's cite verification", () => {
  const passages = [
    passage(1, "I am a partner at Northstar now."),
    passage(2, null),
    passage(3, "Northstar named two new partners this spring."),
  ];

  it("a cite must be found in the passage it names, numbered among the passages shown", () => {
    expect(
      verifySourceCites({ verdict: "supported", cites: [{ passage: 1, text: "a partner at Northstar" }] }, passages),
    ).toEqual({ ok: true, cited: 1 });
    // Passage 2 is the third given: the second has no text and is not shown.
    expect(
      verifySourceCites({ verdict: "supported", cites: [{ passage: 2, text: "named two new partners" }] }, passages),
    ).toEqual({ ok: true, cited: 2 });
    expect(
      verifySourceCites({ verdict: "supported", cites: [{ passage: 1, text: "named two new partners" }] }, passages).ok,
    ).toBe(false);
    expect(
      verifySourceCites({ verdict: "supported", cites: [{ passage: 3, text: "a partner at Northstar" }] }, passages).ok,
    ).toBe(false);
  });

  it("supported and wrong need a cite, unsupported needs none, and a weak cite fails", () => {
    expect(verifySourceCites({ verdict: "supported", cites: [] }, passages).ok).toBe(false);
    expect(verifySourceCites({ verdict: "wrong", cites: [] }, passages).ok).toBe(false);
    expect(verifySourceCites({ verdict: "unsupported", cites: [] }, passages)).toEqual({ ok: true, cited: null });
    expect(verifySourceCites({ verdict: "supported", cites: [{ passage: 1, text: "at" }] }, passages).ok).toBe(false);
    expect(
      verifySourceCites({ verdict: "wrong", cites: [{ passage: 1, text: "left Northstar last year" }] }, passages).ok,
    ).toBe(false);
  });

  it("checkSources records a verdict only for a verified answer, and calls nothing for a case with no passage", async () => {
    const good = answer({ verdict: "supported", cites: [{ passage: 1, text: "a partner at Northstar" }] });
    const run = await checkSources([belief(passages), belief([passage(4, null)])], good, { calls: 10 });
    expect(good.calls).toBe(1);
    expect(run.rows.map((row) => [row.verdict, row.code, row.cited])).toEqual([
      ["supported", null, 1],
      [null, "no_passage", null],
    ]);
    expect(run.rows[0]).toMatchObject({
      claimKeys: [key(1), key(2), key(3)],
      evidenceIds: ["item-1", "item-2", "item-3"],
      compartments: ["own"],
      onCited: true,
    });
    expect(run.rows[1]?.onCited).toBe(false);
    const uncited = await checkSources(
      [belief(passages)],
      answer({ verdict: "supported", cites: [{ passage: 1, text: "an invented phrase here" }] }),
      { calls: 10 },
    );
    expect(uncited.rows[0]).toMatchObject({ verdict: null, code: "uncited" });
    expect(uncited.counts).toMatchObject({ calls: 1, uncited: 1, supported: 0 });
  });

  it("stops at its call budget and on an outage, writing nothing for a case not reached", async () => {
    const good = answer({ verdict: "unsupported", cites: [] });
    const run = await checkSources([belief(passages), belief(passages), belief(passages)], good, { calls: 2 });
    expect(run.stopped).toBe("budget");
    expect(run.rows).toHaveLength(2);
    const away = await checkSources([belief(passages)], async () => "unavailable", { calls: 2 });
    expect(away).toMatchObject({ stopped: "unavailable", rows: [] });
    // A budget the asker reached (the night's dollars) stops it as `budget`.
    const spent = await checkSources([belief(passages)], async () => "budget", { calls: 2 });
    expect(spent).toMatchObject({ stopped: "budget", rows: [] });
  });

  it("a hot case's row says why it was chosen, a no-passage one too, and a sample's says nothing", async () => {
    const good = answer({ verdict: "supported", cites: [{ passage: 1, text: "a partner at Northstar" }] });
    const run = await checkSources(
      [
        { ...belief(passages), hot: "served" },
        { ...belief([passage(4, null)]), hot: "new_evidence" },
        belief(passages),
      ],
      good,
      { calls: 10 },
    );
    expect(run.rows.map((row) => row.hot)).toEqual(["served", "new_evidence", undefined]);
    expect("hot" in (run.rows[2] ?? {})).toBe(false);
  });
});

describe("the night's sample", () => {
  // A fixed sequence for the shuffle, so the test pins the rule, not a random draw.
  const fixed = (): (() => number) => {
    let n = 0;
    return () => ((n += 1) * 0.37) % 1;
  };

  it("takes one from each stratum in turn, up to the total, every stratum reached", () => {
    const strata = new Map<string, string[]>([
      ["role", ["r1", "r2", "r3", "r4", "r5", "r6"]],
      ["commitment", ["c1", "c2"]],
      ["supersedes", ["s1", "s2", "s3"]],
    ]);
    const sample = stratifiedSample(strata, 7, fixed());
    expect(sample).toHaveLength(7);
    // Each of the first three is from a different stratum, in stratum order.
    expect(sample.slice(0, 3).map((one) => one[0])).toEqual(["c", "r", "s"]);
    // The small stratum gives all it has; the rest is shared.
    expect(sample.filter((one) => one.startsWith("c")).sort()).toEqual(["c1", "c2"]);
    expect(new Set(sample).size).toBe(7);
    expect(stratifiedSample(strata, 50, fixed())).toHaveLength(11);
    expect(stratifiedSample(new Map(), 50, fixed())).toEqual([]);
  });
});

describe("the relation audit", () => {
  const relations = Array.from({ length: 40 }, (_, n) => ({ id: `rel-${n}`, selector: n / 40, audited: false }));

  it("raises a card for the relations in the share, at most the day's cap less those raised today", () => {
    expect(pickAudits(relations, { share: 0.1, perDay: 5, raisedToday: 0 })).toEqual([
      "rel-0",
      "rel-1",
      "rel-2",
      "rel-3",
    ]);
    const many = Array.from({ length: 200 }, (_, n) => ({ id: `rel-${n}`, selector: (n % 10) / 10, audited: false }));
    expect(pickAudits(many, { share: 0.1, perDay: 5, raisedToday: 0 })).toHaveLength(5);
    expect(pickAudits(many, { share: 0.1, perDay: 5, raisedToday: 3 })).toHaveLength(2);
    expect(pickAudits(many, { share: 0.1, perDay: 5, raisedToday: 7 })).toEqual([]);
  });

  it("passes over a relation already audited", () => {
    const audited = relations.map((one) => (one.id === "rel-0" ? { ...one, audited: true } : one));
    expect(pickAudits(audited, { share: 0.1, perDay: 5, raisedToday: 0 })).toEqual(["rel-1", "rel-2", "rel-3"]);
  });
});

describe("the relations sweep", () => {
  const side = (n: number, subject: string, at: string): RelationSide & { subject: string } => ({
    key: key(n),
    id: `claim-${n}`,
    type: "role",
    phrase: `the promised report number ${n} was sent`,
    passage: `In this message: the promised report number ${n} was sent.`,
    evidenceId: `item-${n}`,
    at,
    compartments: ["own"],
    subject,
  });

  it("takes the oldest claims first, one subject at a time", () => {
    const claims = [
      side(1, "nora", "2026-03-05T00:00:00Z"),
      side(2, "theo", "2026-01-01T00:00:00Z"),
      side(3, "nora", "2026-02-01T00:00:00Z"),
      side(4, "theo", "2026-04-01T00:00:00Z"),
      side(5, "ada", "2026-01-15T00:00:00Z"),
    ];
    expect(sweepOrder(claims).map((one) => one.key)).toEqual([key(2), key(4), key(5), key(3), key(1)]);
  });

  it("stops at the dream budget: no pair starts unless both its calls fit", async () => {
    const jobs: RelationJob[] = [1, 2, 3].map((n) => ({
      claim: side(n, "nora", "2026-01-01T00:00:00Z"),
      candidates: [10, 11].map((m) => ({ other: side(n * 10 + m, "nora", "2026-01-01T00:00:00Z"), mayPrevail: false })),
      unjudged: false,
    }));
    let calls = 0;
    const ask: AskRelation = async () => {
      calls += 1;
      return {
        output: { relation: "unrelated", from: "first", cites: [] } satisfies RelationAnswer,
        savedCall: `dcc_${calls}`,
      };
    };
    const run = await relateClaims(jobs, ask, { candidates: relationRules().budget.candidatesPerSubject, calls: 5 });
    expect(calls).toBe(4);
    expect(run.stopped).toBe("budget");
    expect(run.marks.filter((mark) => mark.state === "judged").map((mark) => mark.claimKey)).toEqual([key(1)]);
  });

  it("the fulfilled-commitments sweep offers fulfils alone: another agreed kind is not written", async () => {
    const commitment = side(1, "owner", "2026-01-01T00:00:00Z");
    const later = side(2, "nora", "2026-02-01T00:00:00Z");
    const agreeing =
      (relation: RelationAnswer["relation"]): AskRelation =>
      async ({ first, second }) => ({
        output: {
          relation,
          from: first.key === later.key ? "first" : "second",
          cites: [
            { slot: "first", text: first.phrase },
            { slot: "second", text: second.phrase },
          ],
        },
        savedCall: "dcc_1",
      });
    const budget = { candidates: 40, calls: 20 };
    const job = [{ claim: commitment, candidates: [{ other: later, mayPrevail: false }], unjudged: false }];
    const fulfilled = await relateClaims(job, agreeing("fulfils"), budget, new Set(), { only: "fulfils" });
    expect(fulfilled.relations).toEqual([
      { from: later.key, to: commitment.key, kind: "fulfils", compartments: ["own"] },
    ]);
    const other = await relateClaims(job, agreeing("supersedes"), budget, new Set(), { only: "fulfils" });
    expect(other.relations).toEqual([]);
    expect(other.checks[0]).toMatchObject({ agreed: true, written: null, code: "not_offered" });
  });
});

describe("why the schema refused an answer", () => {
  it("names the shape, never the text", () => {
    expect(refusedShape("rejected:length")).toBe("length");
    expect(refusedShape('rejected:not_by_schema {"verdict":"supported","cites":[]}')).toBe("not_by_schema");
    expect(refusedShape("The passages agree.")).toBe("not_json");
    expect(refusedShape('Here it is: {"verdict":"supported","cites":[]}')).toBe("prose_and_json");
    expect(refusedShape("[1]")).toBe("not_object");
    expect(refusedShape('{"verdict":"supported","cites":[],"reason":"x"}')).toBe("extra_key");
    expect(refusedShape('{"verdict":"refines","cites":[]}')).toBe("verdict");
    expect(
      refusedShape(`{"verdict":"supported","cites":${JSON.stringify(Array(7).fill({ passage: 1, text: "a b c" }))}}`),
    ).toBe("too_many_cites");
    expect(refusedShape('{"verdict":"supported","cites":[{"passage":1,"text":"a b c","side":"from"}]}')).toBe(
      "cite_keys",
    );
    expect(refusedShape('{"verdict":"supported","cites":[{"passage":0,"text":"a b c"}]}')).toBe("cite_passage");
    expect(refusedShape(`{"verdict":"supported","cites":[{"passage":1,"text":"${"x".repeat(301)}"}]}`)).toBe(
      "cite_text",
    );
    expect(refusedShape('```json\n{"verdict":"supported","cites":[]}\n```')).toBe("other");
  });
});
