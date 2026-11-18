import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { planDocument } from "../documents.ts";
import { type EvalReport, evaluateDocuments, openEvalDocument, reportLines } from "./eval-documents.ts";
import { EVAL_EXTRAS_PER_ITEM, EVAL_RECALL } from "./eval-rule.ts";
import { EVAL_DOCUMENTS, EVAL_MODIFIED, EVAL_OWNER, type EvalDocument, type EvalFact } from "./eval-set.ts";

// The document evaluation, on the fake model only.

const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: EVAL_MODIFIED });

// What a model that finds a fact answers for it: the span of the passage that holds its sentence.
async function claimFor(doc: EvalDocument, fact: EvalFact, over: Partial<EvalFact> = {}) {
  const plan = await planDocument(openEvalDocument(doc), "own");
  const passage = plan.groups
    .flatMap((group) => group.passages)
    .find((one) => {
      const [start, end] = one.span.slice("chars:".length).split("-").map(Number);
      return (plan.parsed.texts[""] ?? "").slice(start, end).includes(fact.what);
    });
  const given = { ...fact, ...over };
  return {
    type: given.type,
    subject: mention(given.subject),
    fields: {
      counterparty: mention(given.counterparty),
      what: given.what,
      ...(given.due === undefined ? {} : { due: given.due }),
      ...(given.when === undefined ? {} : { when: given.when }),
    },
    statementKind: "stated_fact",
    basis: "third_party",
    span: passage?.span ?? "chars:0-1",
  };
}

// A fake model's outputs for the set: each document's expected facts, but those `drop` leaves out,
// with `extra` claims added.
async function outputs(
  set: readonly EvalDocument[],
  options: { drop?: (fact: EvalFact) => boolean; extra?: Record<string, unknown[]> } = {},
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const doc of set) {
    const claims = [];
    for (const fact of doc.expected) if (options.drop?.(fact) !== true) claims.push(await claimFor(doc, fact));
    out[openEvalDocument(doc).context.evidenceId] = {
      claims: [...claims, ...(options.extra?.[doc.id] ?? [])],
      narrowing: "none",
    };
  }
  return out;
}

const run = async (
  set: readonly EvalDocument[],
  given: Record<string, unknown>,
  calls: string[] = [],
): Promise<EvalReport> => evaluateDocuments({ model: fakeModelClient(given, calls) }, set);
const typeOf = (report: EvalReport, type: string) => report.types.find((one) => one.type === type);

describe("the evaluation set", () => {
  it("holds at least ten expected facts of each type and at least ten documents with none, on reserved domains, each fact's sentence a paragraph of its document", () => {
    const facts = EVAL_DOCUMENTS.flatMap((doc) => doc.expected);
    expect(facts.filter((fact) => fact.type === "commitment").length).toBeGreaterThanOrEqual(10);
    expect(facts.filter((fact) => fact.type === "plan").length).toBeGreaterThanOrEqual(10);
    expect(EVAL_DOCUMENTS.filter((doc) => doc.expected.length === 0).length).toBeGreaterThanOrEqual(10);
    expect(new Set(EVAL_DOCUMENTS.map((doc) => doc.id)).size).toBe(EVAL_DOCUMENTS.length);
    for (const doc of EVAL_DOCUMENTS) {
      for (const fact of doc.expected) {
        expect(doc.paragraphs).toContain(fact.what);
        expect(fact.what).toContain(fact.subject);
        expect(fact.what).toContain(fact.counterparty);
      }
      for (const address of doc.paragraphs.join("\n").match(/[\w.+-]+@[\w.-]+/g) ?? [])
        expect(address).toMatch(/\.example$/);
    }
    expect(EVAL_OWNER).toMatch(/\.example$/);
    expect([EVAL_RECALL, EVAL_EXTRAS_PER_ITEM]).toEqual([0.8, 0.2]);
  });
});

describe("evaluateDocuments", () => {
  it("on the fake model answering the expected facts the check passes, with one call for each document and nothing failed", async () => {
    const calls: string[] = [];
    const report = await run(EVAL_DOCUMENTS, await outputs(EVAL_DOCUMENTS), calls);
    expect(report.passed).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.extras).toBe(0);
    for (const type of ["commitment", "plan"])
      expect(typeOf(report, type)).toMatchObject({
        found: typeOf(report, type)?.expected,
        extra: 0,
        gated: true,
        passed: true,
      });
    expect(calls).toHaveLength(EVAL_DOCUMENTS.length);
  });

  it("with too few facts found it fails: the recall threshold is ceil(0.8 * expected) for each gated type", async () => {
    const commitments = EVAL_DOCUMENTS.flatMap((doc) => doc.expected).filter((fact) => fact.type === "commitment");
    const needed = Math.ceil(EVAL_RECALL * commitments.length);
    const dropping = (n: number) => (fact: EvalFact) => commitments.indexOf(fact) >= 0 && commitments.indexOf(fact) < n;
    const atEdge = await run(
      EVAL_DOCUMENTS,
      await outputs(EVAL_DOCUMENTS, { drop: dropping(commitments.length - needed) }),
    );
    expect(typeOf(atEdge, "commitment")).toMatchObject({ found: needed, passed: true });
    expect(atEdge.passed).toBe(true);
    const under = await run(
      EVAL_DOCUMENTS,
      await outputs(EVAL_DOCUMENTS, { drop: dropping(commitments.length - needed + 1) }),
    );
    expect(typeOf(under, "commitment")).toMatchObject({ found: needed - 1, passed: false });
    expect(under.passed).toBe(false);
    expect(under.failed.length).toBe(commitments.length - needed + 1);
  });

  it("a found fact of the right type and a different fact key counts as an extra, and too many extras fail the set", async () => {
    const [first] = EVAL_DOCUMENTS.filter((doc) => doc.expected.length === 1 && doc.expected[0]?.type === "commitment");
    if (first === undefined) throw new Error("no commitment document");
    const fact = first.expected[0] as EvalFact;
    const wrongDate = await claimFor(first, fact, { due: "2026-03-30" });
    const report = await run(
      EVAL_DOCUMENTS,
      await outputs(EVAL_DOCUMENTS, { drop: (one) => one === fact, extra: { [first.id]: [wrongDate] } }),
    );
    expect(report.extras).toBe(1);
    expect(typeOf(report, "commitment")).toMatchObject({
      found: (typeOf(report, "commitment")?.expected ?? 0) - 1,
      extra: 1,
    });
    expect(report.failed).toEqual([first.id]);
    expect(report.passed).toBe(true);
    // More extras than one in five documents fail the set, whatever the recall.
    const allowed = Math.floor(EVAL_DOCUMENTS.length * EVAL_EXTRAS_PER_ITEM);
    expect(report.extrasAllowed).toBe(allowed);
    // Each of allowed + 1 documents answers its own facts and one more, its first a day later.
    const extra: Record<string, unknown[]> = {};
    for (const doc of EVAL_DOCUMENTS.filter((one) => one.expected.length > 0).slice(0, allowed + 1)) {
      const own = doc.expected[0] as EvalFact;
      extra[doc.id] = [
        await claimFor(doc, own, own.type === "commitment" ? { due: "2026-03-31" } : { when: "2026-03-31" }),
      ];
    }
    const flooded = await run(EVAL_DOCUMENTS, await outputs(EVAL_DOCUMENTS, { extra }));
    expect(flooded.extras).toBe(allowed + 1);
    expect(flooded.types.every((type) => type.found === type.expected)).toBe(true);
    expect(flooded.passed).toBe(false);
  });

  it("a type with 9 expected facts does not gate", async () => {
    const plans = EVAL_DOCUMENTS.filter((doc) => doc.expected.some((fact) => fact.type === "plan")).slice(0, 9);
    const others = EVAL_DOCUMENTS.filter((doc) => !doc.expected.some((fact) => fact.type === "plan"));
    const set = [...others, ...plans];
    const report = await run(set, await outputs(set, { drop: (fact) => fact.type === "plan" }));
    expect(typeOf(report, "plan")).toMatchObject({ expected: 9, found: 0, gated: false, passed: true });
    expect(report.passed).toBe(true);
    // The positive control: with ten it gates, and fails.
    const ten = [
      ...others,
      ...EVAL_DOCUMENTS.filter((doc) => doc.expected.some((fact) => fact.type === "plan")).slice(0, 10),
    ];
    expect(typeOf(await run(ten, await outputs(ten, { drop: (fact) => fact.type === "plan" })), "plan")).toMatchObject({
      expected: 10,
      gated: true,
      passed: false,
    });
  });

  it("a document the model withholds, or answers wrongly, is failed and finds nothing; the model away stops the check", async () => {
    const given = await outputs(EVAL_DOCUMENTS);
    const [one, two] = EVAL_DOCUMENTS.filter((doc) => doc.expected.length > 0);
    given[openEvalDocument(one as EvalDocument).context.evidenceId] = { claims: [], narrowing: "quarantine" };
    given[openEvalDocument(two as EvalDocument).context.evidenceId] = "rejected:length";
    const report = await run(EVAL_DOCUMENTS, given);
    expect(report.failed).toEqual([one?.id, two?.id]);
    await expect(run(EVAL_DOCUMENTS, {})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("the check prints counts and no text", async () => {
    const report = await run(
      EVAL_DOCUMENTS,
      await outputs(EVAL_DOCUMENTS, { drop: (fact) => fact === EVAL_DOCUMENTS[0]?.expected[0] }),
    );
    const lines = reportLines(report);
    expect(lines).toEqual([
      `commitment: expected ${typeOf(report, "commitment")?.expected} found ${typeOf(report, "commitment")?.found} extra 0 gated ok`,
      `plan: expected ${typeOf(report, "plan")?.expected} found ${typeOf(report, "plan")?.found} extra 0 gated ok`,
      `documents: ${EVAL_DOCUMENTS.length} extras 0 of ${report.extrasAllowed} failed ${EVAL_DOCUMENTS[0]?.id}`,
      "result: ok",
    ]);
    const words = EVAL_DOCUMENTS.flatMap((doc) => [doc.title, ...doc.paragraphs])
      .flatMap((text) => text.split(/[^A-Za-z@.]+/))
      .filter((word) => word.length > 5);
    for (const line of lines) for (const word of words) expect(line).not.toContain(word);
  });
});
