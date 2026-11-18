import { KEY_FIELDS, LIFE_DOMAINS } from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { statesTwoFacts } from "@intelligence/personal-core";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import {
  checkCorrespondence,
  correspondenceReportLines,
  EVAL_CORRESPONDENCE,
  EVAL_SENT,
  type EvalAtomicFact,
  type EvalMessage,
  evaluateCorrespondence,
  openEvalMessage,
  spanOf,
} from "./eval-correspondence.ts";
import { meetingDetailLines } from "./eval-meetings-report.ts";

// The atomic correspondence evaluation, on the fake model only.

const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: EVAL_SENT });

// What a model that finds a fact answers for it: its phrase as the message writes it, its domain,
// and the span of its sentence.
async function claimFor(message: EvalMessage, fact: EvalAtomicFact, fields: Record<string, unknown> = {}) {
  return {
    type: fact.type,
    subject: mention(fact.subject),
    fields: {
      [KEY_FIELDS[fact.type].phrase]: fact.phrase,
      domain: fact.domain,
      ...(fact.type === "preference" ? { polarity: fact.polarity ?? "prefers" } : {}),
      ...(fact.momentary === undefined ? {} : { momentary: fact.momentary }),
      ...(fact.until === undefined ? {} : { until: fact.until }),
      ...fields,
    },
    statementKind: "stated_fact",
    basis: "explicit_self",
    span: await spanOf(message, fact.sentence),
  };
}

async function outputs(extra: Record<string, unknown[]> = {}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const message of EVAL_CORRESPONDENCE) {
    const claims = await Promise.all(message.expected.map((fact) => claimFor(message, fact)));
    out[openEvalMessage(message).context.evidenceId] = {
      claims: [...claims, ...(extra[message.id] ?? [])],
      narrowing: "none",
    };
  }
  return out;
}

describe("the atomic correspondence evaluation", () => {
  it("holds synthetic messages on reserved domains, each expected phrase one fact in its own sentence, and a sentence of two facts as two", () => {
    for (const message of EVAL_CORRESPONDENCE) {
      for (const address of [message.from, message.to]) expect(address).toMatch(/\.example$/);
      for (const fact of message.expected) {
        expect(message.paragraphs).toContain(fact.sentence);
        expect(fact.sentence).toContain(fact.phrase);
        expect(statesTwoFacts(fact.phrase), fact.phrase).toBe(false);
        expect(LIFE_DOMAINS).toContain(fact.domain);
      }
    }
    const sentences = EVAL_CORRESPONDENCE.flatMap((message) => message.expected.map((fact) => fact.sentence));
    expect(sentences.some((sentence, n) => sentences.indexOf(sentence) !== n)).toBe(true);
    expect(EVAL_CORRESPONDENCE.some((message) => message.expected.length === 0)).toBe(true);
  });

  it("through a fake model, every claim is one fact and every owner-side claim has a domain", async () => {
    const calls: string[] = [];
    const report = await evaluateCorrespondence({ model: fakeModelClient(await outputs(), calls) });
    expect(report).toMatchObject({
      messages: EVAL_CORRESPONDENCE.length,
      extra: 0,
      missingDomain: 0,
      unmapped: {},
      failed: [],
      passed: true,
    });
    expect(report.found).toBe(report.expected);
    expect(calls.length).toBe(EVAL_CORRESPONDENCE.length);
    expect(correspondenceReportLines(report).at(-1)).toBe("result: ok");
  });

  it("a bundled phrase is refused as multi_fact and counted; an extra fact fails its message", async () => {
    const [raise, dashes] = EVAL_CORRESPONDENCE as [EvalMessage, EvalMessage];
    const bundled = await claimFor(raise, raise.expected[0] as EvalAtomicFact, {
      objective: "raise a seed round by June and hire two engineers",
    });
    const report = await evaluateCorrespondence({
      model: fakeModelClient(await outputs({ "corr-01": [bundled] }), []),
    });
    expect(report.unmapped).toEqual({ multi_fact: 1 });
    expect(report.passed).toBe(true);
    expect(correspondenceReportLines(report)).toContain("unmapped: multi_fact 1");
    // Another phrase is another fact: "em dashes in anything" is not the expected one. ("anything
    // you send me" would be refused by the claim intake, not counted extra: "me" names nobody.)
    const extra = await claimFor(dashes, dashes.expected[0] as EvalAtomicFact, {
      object: "em dashes in anything",
      polarity: "avoids",
    });
    const failing = await evaluateCorrespondence({ model: fakeModelClient(await outputs({ "corr-02": [extra] }), []) });
    expect(failing).toMatchObject({ extra: 1, failed: ["corr-02"], passed: false });
  });

  // The claim intake's refusal rate on this set: 1 of 9 expected facts when the model gives "at the
  // dentist today" no date (not_standalone), 0 of 9 with it.
  it("a relative time word with no date is refused not_standalone, and with its until is kept", async () => {
    const dentist = EVAL_CORRESPONDENCE.find((message) => message.id === "corr-06") as EvalMessage;
    const fact = dentist.expected[0] as EvalAtomicFact;
    const { until: _until, ...undated } = fact;
    const out = await outputs();
    out[openEvalMessage(dentist).context.evidenceId] = {
      claims: [await claimFor(dentist, undated)],
      narrowing: "none",
    };
    const report = await evaluateCorrespondence({ model: fakeModelClient(out, []) });
    expect(report).toMatchObject({
      expected: 9,
      found: 8,
      unmapped: { not_standalone: 1 },
      failed: ["corr-06"],
      passed: false,
    });
  });

  it("the check prints each type the set expects or a fact was found of, then the counts, the failed ids and the result, and no text", async () => {
    const [, dashes] = EVAL_CORRESPONDENCE as [EvalMessage, EvalMessage];
    const extra = await claimFor(dashes, dashes.expected[0] as EvalAtomicFact, {
      object: "em dashes in anything",
      polarity: "avoids",
    });
    const report = await evaluateCorrespondence({ model: fakeModelClient(await outputs({ "corr-02": [extra] }), []) });
    const lines = correspondenceReportLines(report);
    expect(lines.slice(0, 6)).toEqual([
      "need: expected 1 found 1 extra 0",
      "capability: expected 1 found 1 extra 0",
      "goal: expected 2 found 2 extra 0",
      "preference: expected 1 found 1 extra 1",
      "constraint: expected 1 found 1 extra 0",
      "situation: expected 3 found 3 extra 0",
    ]);
    expect(lines.slice(6)).toEqual([
      "messages: 8 expected 9 found 9 extra 1 missing_domain 0",
      "unmapped: none",
      "failed: corr-02",
      "withheld: none",
      "result: failed",
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain("@");
    for (const message of EVAL_CORRESPONDENCE)
      for (const paragraph of message.paragraphs) expect(text).not.toContain(paragraph);
  });

  it("a message the model withholds is scored on its claims, as before, and listed as withheld", async () => {
    const portland = EVAL_CORRESPONDENCE.find((message) => message.id === "corr-03") as EvalMessage;
    const out = await outputs();
    out[openEvalMessage(portland).context.evidenceId] = {
      claims: await Promise.all(portland.expected.map((fact) => claimFor(portland, fact))),
      narrowing: "special_category",
    };
    const report = await evaluateCorrespondence({ model: fakeModelClient(out, []) });
    expect(report).toMatchObject({ found: 9, failed: [], withheld: ["corr-03"], passed: true });
    expect(correspondenceReportLines(report)).toContain("withheld: corr-03");
  });

  it("--detail: one line per message, its missed and extra facts by type and role, its call's latency and cost, then the totals", async () => {
    const [raise, dashes] = EVAL_CORRESPONDENCE as [EvalMessage, EvalMessage];
    const lena = EVAL_CORRESPONDENCE.find((message) => message.id === "corr-04") as EvalMessage;
    const extra = await claimFor(dashes, dashes.expected[0] as EvalAtomicFact, {
      object: "em dashes in anything",
      polarity: "avoids",
    });
    const out = await outputs({ "corr-02": [extra] });
    out[openEvalMessage(raise).context.evidenceId] = {
      claims: [await claimFor(raise, raise.expected[0] as EvalAtomicFact)],
      narrowing: "none",
    };
    out[openEvalMessage(lena).context.evidenceId] = { claims: [], narrowing: "quarantine" };
    const report = await evaluateCorrespondence({ model: fakeModelClient(out, []) });
    const stats = new Map([
      [openEvalMessage(raise).context.evidenceId, { ms: 812, microUsd: 1450 }],
      [openEvalMessage(dashes).context.evidenceId, { ms: 640, microUsd: 1200 }],
    ]);
    const lines = meetingDetailLines(report, stats, 9100);
    expect(lines).toHaveLength(EVAL_CORRESPONDENCE.length + 1);
    expect(lines).toContain(
      "corr-01: expected 2 matched 1 missed goal/owner>none/due=none extra none ms 812 micro_usd 1450",
    );
    expect(lines).toContain(
      "corr-02: expected 1 matched 1 missed none extra preference/owner>none/due=none ms 640 micro_usd 1200",
    );
    expect(lines).toContain("corr-08: expected 0 matched 0 missed none extra none ms 0 micro_usd 0");
    expect(lines).toContain(
      "corr-04: expected 1 matched 0 missed need/other>none/due=none extra none ms 0 micro_usd 0",
    );
    expect(lines.at(-1)).toBe("total: wall_ms 9100 micro_usd 2650");
    expect(report.failed).toEqual(["corr-01", "corr-02", "corr-04"]);
    expect(report.withheld).toEqual(["corr-04"]);
    const text = lines.join("\n");
    expect(text).not.toContain("@");
    for (const message of EVAL_CORRESPONDENCE)
      for (const paragraph of message.paragraphs) expect(text).not.toContain(paragraph);
  });
});

describe("saved calls across ontology versions", () => {
  it("E14: a version 3 saved call still checks under version 3's types, and version 4's output under version 4's", async () => {
    const sentence = "We hope to raise a seed round by June.";
    const message: EvalMessage = {
      id: "k2a-02",
      from: "sam@harbor.example",
      to: "lena.park@north.example",
      paragraphs: [sentence],
      expected: [],
    };
    const span = await spanOf(message, sentence);
    const claim = (fields: Record<string, unknown>) => ({
      type: "goal",
      subject: { key: { kind: "address", value: "sam@harbor.example" }, observedAt: "2026-03-02T09:00:00.000Z" },
      fields,
      statementKind: "stated_fact",
      basis: "explicit_self",
      span,
    });
    const v3 = { claims: [claim({ what: sentence, by: "2026-06-30" })], narrowing: "none" } as never;
    const v4 = {
      claims: [claim({ objective: "raise a seed round", domain: "ventures", by: "2026-06-30" })],
      narrowing: "none",
    } as never;
    const today = await checkCorrespondence(message, v3, "3");
    expect(today.claims.length).toBe(1);
    const thread = openEvalMessage(message).raw.threadId as string;
    expect(today.claims[0]?.factKey).toBe(personalFactKey(today.claims[0]?.claim.content as never, thread, ["own"]));
    expect((await checkCorrespondence(message, v4, "3")).claims).toEqual([]);
    expect((await checkCorrespondence(message, v3, "4")).claims).toEqual([]);
    expect((await checkCorrespondence(message, v4, "4")).claims.length).toBe(1);
  });
});
