import { InterpreterOutput } from "@intelligence/contracts";
import type { ModelClient } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { NEGATION_CUT_GENERATION } from "./check.ts";
import { EXTRACT_GENERATION } from "./config.ts";
import { type EvalMessage, openEvalMessage } from "./eval/eval-correspondence.ts";
import { EVAL_OWNER } from "./eval/eval-set.ts";
import { readStored } from "./interpret.ts";
import { SECOND_DEGREE_VERSIONS } from "./lane-versions.ts";
import { PROMPT_VERSIONS } from "./message-prompts.ts";
import { runExtraction } from "./run.ts";
import { answering, changed, processOne, type Setup, setup } from "./test-support/support.ts";
import { runTrial, spanClass, TRIAL_VERSION, TRIAL_WINDOW, trialReportLines } from "./trial.ts";

// `pi extract trial --sample N` on the memory store. It asks prompt version 4 of the newest
// correspondence items done at the current generation, saves each call, and writes no claim, status
// or belief. Counts only. The trial is run before the switch to version 4, so these tests extract
// at generation 4, correspondence version 3 and agent record version 2.

const BEFORE_GO = 4;

async function extractedBeforeGo(): Promise<Setup> {
  const s = await setup();
  s.deps.generation = BEFORE_GO;
  const asked = { ...PROMPT_VERSIONS };
  Object.assign(PROMPT_VERSIONS, { correspondence: "3", agent: "2" });
  try {
    expect(await runExtraction(s.deps)).not.toBe("already_running");
  } finally {
    Object.assign(PROMPT_VERSIONS, asked);
  }
  return s;
}

// The trial says it checks an answer as the lane checks it, so what the lane refuses it counts refused.
describe("a trial checks as the lane does", () => {
  it("a part of a whole name is refused as ungrounded_mention, in the run and in the trial", async () => {
    const s = await setup();
    const id = s.w.handles.nameMentionMessageId;
    const evidence = s.store.evidenceIdOf(id);
    const SEGMENT = "Mira Okafor and Teo will send the deck.";
    const output = structuredClone(s.store.outputs[evidence]) as {
      claims: { subject: { observedAt: string } }[];
      narrowing: string;
    };
    const observedAt = output.claims[0]?.subject.observedAt;
    answering(s, {
      [id]: {
        ...output,
        claims: [
          {
            type: "relationship",
            subject: { key: { kind: "name", value: "Mira" }, observedAt },
            fields: {
              counterparty: { key: { kind: "address", value: "hollis.grey@larch.test" }, observedAt },
              relation: "colleague",
            },
            statementKind: "stated_fact",
            basis: "third_party",
            span: `chars:0-${SEGMENT.length}`,
          },
        ],
      },
    });
    changed(s, id, (message) => {
      message.text = `${SEGMENT}\r\n`;
    });
    expect(await processOne(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    const report = await runTrial(s.deps, 50, { replay: true });
    if (report === "already_running") throw new Error("locked");
    expect(report.unmapped.ungrounded_mention).toBe(1);
  });
});

describe("runTrial --next-generation", () => {
  it("checks a saved answer as the next generation would, and --show-drops says what each refused one said", async () => {
    const s = await setup();
    const id = s.w.handles.planMessageId;
    const evidence = s.store.evidenceIdOf(id);
    changed(s, id, (message) => {
      message.text = "We will not take the Lisbon offer.\r\n";
    });
    const opened = await s.deps.store.open(evidence as never);
    if (opened === null) throw new Error("no item");
    const { parsed } = await readStored(opened, ["own"]);
    const span = parsed.segments.find((one) => one.text.includes("Lisbon"))?.span;
    const answer = structuredClone(s.store.outputs[evidence]) as {
      claims: Record<string, unknown>[];
      narrowing: string;
    };
    const [plan] = answer.claims;
    answering(s, {
      [id]: {
        ...answer,
        claims: [{ ...plan, type: "goal", span, fields: { objective: "take the Lisbon offer", domain: "career" } }],
      },
    });
    await processOne(s, id);
    const before = await runTrial(s.deps, 50, { replay: true });
    if (before === "already_running") throw new Error("locked");
    expect(JSON.stringify(before.drops)).not.toContain("negation_cut");
    expect(before.shownDrops).toBeUndefined();

    const report = await runTrial(s.deps, 50, {
      replay: true,
      checkGeneration: NEGATION_CUT_GENERATION,
      showDrops: true,
    });
    if (report === "already_running") throw new Error("locked");
    expect(report.unmapped.negation_cut).toBe(1);
    expect(report.shownDrops).toHaveLength(1);
    expect(report.shownDrops?.[0]).toContain("take the Lisbon offer");
    expect(report.shownDrops?.[0]).toContain("We will not take");
    expect(trialReportLines(report, 0).filter((one) => one.startsWith("show_drop: "))).toHaveLength(1);
    // Without the flag, counts alone.
    const counts = await runTrial(s.deps, 50, { replay: true, checkGeneration: NEGATION_CUT_GENERATION });
    if (counts === "already_running") throw new Error("locked");
    expect(trialReportLines(counts, 0).join("\n")).not.toContain("Lisbon");
  });
});

describe("runTrial", () => {
  it("looks through the whole backlog for its sample, not a multiple of it: correspondence items sit among many receipts", async () => {
    const s = await setup();
    await runExtraction(s.deps);
    const limits: number[] = [];
    const backlog = s.deps.store.backlog.bind(s.deps.store);
    const store = Object.assign(
      Object.create(Object.getPrototypeOf(s.deps.store) as object) as typeof s.deps.store,
      s.deps.store,
      {
        backlog: (limit: number, ...rest: Parameters<typeof backlog> extends [number, ...infer R] ? R : never) => {
          limits.push(limit);
          return backlog(limit, ...rest);
        },
      },
    );
    await runTrial({ ...s.deps, store }, 5);
    expect(limits).toEqual([TRIAL_WINDOW]);
    expect(TRIAL_WINDOW).toBeGreaterThan(5 * 10);
  });

  it("asks version 4 of the sample through the saved calls, writes nothing else, and does not ask an item twice", async () => {
    const s = await extractedBeforeGo();
    const done = (
      await s.store.backlog(1000, BEFORE_GO, { promptId: "personal_correspondence", promptVersion: TRIAL_VERSION })
    ).filter((one) => one.committedLane === "correspondence");
    expect(done.length).toBeGreaterThan(1);

    const claims = JSON.stringify(s.store.claims());
    const beliefs = JSON.stringify([s.store.beliefs(["own"]), s.store.beliefs(["employer:example", "own"])]);
    const saved = s.store.savedCalls().length;

    const report = await runTrial(s.deps, 1);
    if (report === "already_running") throw new Error("locked");
    expect(report.items).toBe(1);
    expect(report.live).toBe(1);
    expect(report.stopped).toBeNull();
    // Only the saved call is new: no claim, no belief.
    expect(JSON.stringify(s.store.claims())).toBe(claims);
    expect(JSON.stringify([s.store.beliefs(["own"]), s.store.beliefs(["employer:example", "own"])])).toBe(beliefs);
    const added = s.store.savedCalls().slice(saved);
    expect(added.map((one) => [one.record.key.promptId, one.record.key.promptVersion])).toEqual([
      ["personal_correspondence", TRIAL_VERSION],
    ]);
    expect(added[0]?.record.key.evidenceId).toBe(done[0]?.evidenceId);

    // The next trial takes the next item: the first has its version 4 call saved.
    const next = await runTrial(s.deps, 1);
    if (next === "already_running") throw new Error("locked");
    expect(
      s.store
        .savedCalls()
        .slice(saved)
        .map((one) => one.record.key.evidenceId),
    ).toEqual([done[0]?.evidenceId, done[1]?.evidenceId]);

    // Its lines are counts and code words.
    const lines = trialReportLines(report, 0);
    expect(lines[0]).toBe("items: 1 live 1 failed 0 cost_microusd 0");
    expect(lines.at(-1)).toBe("stopped: none");
  });

  // The owner prices the second-degree backfill from a sample.
  it("--second-degree asks the correspondence lane's second-degree version of the sample, saves its call and writes nothing else", async () => {
    const s = await extractedBeforeGo();
    const claims = JSON.stringify(s.store.claims());
    const saved = s.store.savedCalls().length;
    const report = await runTrial(s.deps, 1, { secondDegree: true });
    if (report === "already_running") throw new Error("locked");
    expect(report).toMatchObject({ version: SECOND_DEGREE_VERSIONS.correspondence, items: 1, live: 1, stopped: null });
    expect(JSON.stringify(s.store.claims())).toBe(claims);
    expect(
      s.store
        .savedCalls()
        .slice(saved)
        .map((one) => [one.record.key.promptId, one.record.key.promptVersion]),
    ).toEqual([["personal_correspondence", SECOND_DEGREE_VERSIONS.correspondence]]);
    expect(trialReportLines(report, 0)[1]).toBe(`prompt: correspondence ${SECOND_DEGREE_VERSIONS.correspondence}`);
    // Without the flag, version 4, as before.
    const plain = await runTrial(s.deps, 1);
    if (plain === "already_running") throw new Error("locked");
    expect(plain.version).toBe(TRIAL_VERSION);
  });

  it("counts where each answer's span falls, by code, so a bad_span's cause shows in counts alone", async () => {
    const own = "I am moving to Portland in May.";
    const reply: EvalMessage = {
      id: "trial-span",
      from: EVAL_OWNER,
      to: "lena.park@north.example",
      paragraphs: [own, "On Sun, 1 Mar 2026, lena.park@north.example wrote:\n> We hope to raise a seed round by June."],
      expected: [],
    };
    const { parsed } = await readStored(openEvalMessage(reply), ["own"]);
    const quoted = parsed.segments.find((segment) => segment.quoted)?.span as string;
    const spans = [
      `chars:0-${own.length}`,
      "chars:5-28",
      quoted,
      "subject:chars:0-11",
      `chars:0-${own.length + 8}`,
      "sentence 1",
    ];
    expect(spans.map((span) => spanClass(parsed, span))).toEqual([
      "listed",
      "inside",
      "quoted",
      "subject",
      "unheld",
      "unheld",
    ]);

    // A model that cites a span no segment holds: counted as unheld, and refused as bad_span.
    const s = await extractedBeforeGo();
    const goal = {
      type: "goal",
      subject: { key: { kind: "address", value: EVAL_OWNER }, observedAt: "2026-03-02T09:00:00.000Z" },
      fields: { objective: "raise a seed round", domain: "ventures" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: "chars:900000-900001",
    };
    const model: ModelClient = {
      complete: async (request) => ({
        output: InterpreterOutput.parse({ claims: [goal], narrowing: "none" }),
        label: request.label,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        modelId: "fake",
      }),
      embed: () => Promise.reject(new Error("no embedding")),
    };
    const report = await runTrial({ ...s.deps, model }, 1);
    if (report === "already_running") throw new Error("locked");
    expect(report.spans).toEqual({ listed: 0, inside: 0, quoted: 0, subject: 0, unheld: 1 });
    expect(report.unmapped).toEqual({ bad_span: 1 });
    expect(trialReportLines(report, 0)).toContain("spans: listed 0, inside 0, quoted 0, subject 0, unheld 1");
  });

  it("counts each refused claim by its type, field and issue, so a bad_fields' cause shows in counts alone", async () => {
    const s = await extractedBeforeGo();
    const goal = {
      type: "goal",
      subject: { key: { kind: "address", value: EVAL_OWNER }, observedAt: "2026-03-02T09:00:00.000Z" },
      fields: { objective: "raise a seed round", domain: "not-a-domain" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: "chars:0-10",
    };
    const model: ModelClient = {
      complete: async (request) => ({
        output: InterpreterOutput.parse({ claims: [goal], narrowing: "none" }),
        label: request.label,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        modelId: "fake",
      }),
      embed: () => Promise.reject(new Error("no embedding")),
    };
    const report = await runTrial({ ...s.deps, model }, 1);
    if (report === "already_running") throw new Error("locked");
    expect(Object.values(report.drops).reduce((sum, n) => sum + n, 0)).toBe(
      Object.values(report.unmapped).reduce((sum, n) => sum + (n ?? 0), 0),
    );
    for (const key of Object.keys(report.drops)) expect(key).toMatch(/^[a-z_]+ [a-z_.]+\.[a-z_-]+:[a-z_-]+$/);
    expect(report.drops).toEqual({ "bad_fields goal.domain:not_enum": 1 });
    expect(trialReportLines(report, 0).some((line) => line.startsWith("drops: "))).toBe(true);
  });

  it("replay: takes the items whose version 4 call is saved, makes no live call and reports the same counts", async () => {
    const s = await extractedBeforeGo();
    const first = await runTrial(s.deps, 2);
    if (first === "already_running") throw new Error("locked");
    expect(first.live).toBe(first.items);
    const saved = s.store.savedCalls().length;
    // A model that fails any call: a replay must reach none.
    const refusing: ModelClient = {
      complete: () => Promise.reject(new Error("no live call in a replay")),
      embed: () => Promise.reject(new Error("no embedding")),
    };
    const again = await runTrial({ ...s.deps, model: refusing }, 2, { replay: true });
    if (again === "already_running") throw new Error("locked");
    expect(again.items).toBe(first.items);
    expect(again.live).toBe(0);
    expect(again.failed).toBe(0);
    expect(again.claims).toEqual(first.claims);
    expect(again.unmapped).toEqual(first.unmapped);
    expect(s.store.savedCalls().length).toBe(saved);
  });

  it("stops at a budget and says so", async () => {
    const s = await extractedBeforeGo();
    const refused = Object.assign(new Error("budget_reached"), { code: "budget_reached", reason: "run" });
    const report = await runTrial(
      { ...s.deps, model: { complete: () => Promise.reject(refused), embed: () => Promise.reject(refused) } },
      3,
    );
    if (report === "already_running") throw new Error("locked");
    expect(report).toMatchObject({ items: 1, live: 1, stopped: "budget_reached" });
  });

  it("after the go, every item done at the current generation was asked version 4, so the trial asks nothing", async () => {
    const s = await setup();
    expect(await runExtraction(s.deps)).not.toBe("already_running");
    const saved = s.store.savedCalls().length;
    const report = await runTrial(s.deps, 50);
    if (report === "already_running") throw new Error("locked");
    expect(EXTRACT_GENERATION).toBe(5);
    expect(report).toMatchObject({ items: 0, live: 0, stopped: null });
    expect(s.store.savedCalls().length).toBe(saved);
  });
});

// `--lane transaction` and `--fact-kinds`. The sample is asked the lane's fact-kind version, and
// each item's saved call of the version it was done under is replayed beside it at no cost, so the
// two can be read side by side. Nothing else is written.
describe("runTrial --fact-kinds", () => {
  it("asks the transaction lane's version 4 of its items, replays version 2 beside each, and writes no claim", async () => {
    const s = await setup();
    expect(await runExtraction(s.deps)).not.toBe("already_running");
    const claims = JSON.stringify(s.store.claims());
    const saved = s.store.savedCalls().length;
    const report = await runTrial(s.deps, 50, { lane: "transaction", factKinds: true });
    if (report === "already_running") throw new Error("locked");
    expect(report).toMatchObject({
      lane: "transaction",
      version: "4",
      failed: 0,
      stopped: null,
      before: { missing: 0, failed: 0 },
    });
    expect(report.items).toBeGreaterThan(1);
    expect(report.live).toBe(report.items);
    expect(report.before?.items).toBe(report.items);
    // The fake model answers both versions alike: the receipts are kept by both.
    expect(Object.keys(report.claims)).toContain("transaction.receipt");
    expect(report.before?.claims).toEqual(report.claims);
    expect(JSON.stringify(s.store.claims())).toBe(claims);
    const added = s.store
      .savedCalls()
      .slice(saved)
      .map((one) => `${one.record.key.promptId}@${one.record.key.promptVersion}`);
    expect(new Set(added)).toEqual(new Set(["personal_transaction@4"]));
    expect(added).toHaveLength(report.items);
    const lines = trialReportLines(report, 0);
    expect(lines[1]).toBe("prompt: transaction 4");
    expect(lines).toContain(`before: items ${report.items} missing 0 failed 0`);
  });

  it("--show lists only the items whose claims of the shown types differ between the two versions, and prints both", async () => {
    const s = await setup();
    expect(await runExtraction(s.deps)).not.toBe("already_running");
    const report = await runTrial(s.deps, 50, { lane: "transaction", factKinds: true, show: ["transaction.receipt"] });
    if (report === "already_running") throw new Error("locked");
    // The fake model answers both versions alike, so no item differs.
    expect(report.before?.items).toBeGreaterThan(0);
    expect(report.shown).toEqual([]);
    const lines = trialReportLines(
      { ...report, shown: [{ item: 2, before: ['goal {"objective":"a"}'], after: ['plan {"what":"a"}'] }] },
      0,
    );
    expect(lines.slice(-3)).toEqual(["show: item 2", '  before goal {"objective":"a"}', '  after plan {"what":"a"}']);
    const without = await runTrial(s.deps, 50, { lane: "transaction", factKinds: true, replay: true });
    if (without === "already_running") throw new Error("locked");
    expect(without.shown).toBeUndefined();
  });

  it("--project asks only messages in a project, and the sample counts those", async () => {
    const s = await extractedBeforeGo();
    const none = await runTrial(s.deps, 5, { factKinds: true, project: true });
    if (none === "already_running") throw new Error("locked");
    expect(none).toMatchObject({ items: 0, live: 0 });
    const { store } = s.deps;
    const project = { project: "ent_kiln" as never, name: "Alder Kiln", anchored: true, vetoed: false };
    s.deps.store = {
      ...store,
      async open(evidenceId) {
        const opened = await store.open(evidenceId);
        return opened === null ? null : { ...opened, projects: [project] };
      },
    };
    const some = await runTrial(s.deps, 1, { factKinds: true, project: true });
    if (some === "already_running") throw new Error("locked");
    expect(some).toMatchObject({ items: 1, live: 1 });
  });

  it("asks the correspondence lane's version 11, and counts an item with no saved call of an earlier version as missing", async () => {
    const s = await extractedBeforeGo();
    const report = await runTrial(s.deps, 1, { factKinds: true });
    if (report === "already_running") throw new Error("locked");
    // Done under version 3, before the switch to 4: no saved call of 4 or 5 to replay.
    expect(report).toMatchObject({
      lane: "correspondence",
      version: "11",
      items: 1,
      live: 1,
      before: { items: 0, missing: 1, failed: 0 },
    });
    expect(s.store.savedCalls().at(-1)?.record.key).toMatchObject({
      promptId: "personal_correspondence",
      promptVersion: "11",
    });
  });
});
