import { LocalEntityId } from "@intelligence/contracts";
import type { ClaimRecord, RestatementCandidate } from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import {
  candidateState,
  checkRestatement,
  heldFactKeys,
  type JudgedCandidate,
  restatementAnswer,
  statementOf,
} from "./restatement.ts";

// The statement of a claim and rung 0's answer, pure. Each refusal has its positive control.

const owner = LocalEntityId.parse("ent_00000000000000000000000001");
const rhea = LocalEntityId.parse("ent_00000000000000000000000002");
const alder = LocalEntityId.parse("ent_00000000000000000000000003");
const fp = (n: number): string => n.toString(16).padStart(64, "0");

type Options = {
  id?: string;
  type?: string;
  subject?: string;
  fields?: Record<string, unknown>;
  assertedBy?: string;
  basis?: string;
  evidence?: string;
  validFrom?: string;
  compartments?: string[];
  origin?: "source" | "agent_record";
};

// A claim record as the check gives one; only what a statement reads is varied.
function record(options: Options = {}): ClaimRecord {
  const evidence = options.evidence ?? "a".repeat(64);
  return {
    claim: {
      id: options.id ?? "claim-1",
      content: {
        type: options.type ?? "commitment",
        subject: options.subject ?? owner,
        fields: options.fields ?? { counterparty: rhea, what: "I will send the plans.", due: "2026-10-09" },
      },
      statementKind: "stated_fact",
      basis: options.basis ?? "explicit_self",
      ...(options.assertedBy === undefined ? {} : { assertedBy: options.assertedBy }),
      validFrom: options.validFrom ?? "2026-10-01T09:00:00.000Z",
      evidence: [{ evidenceId: evidence, span: "s:1" }],
      primaryEvidenceId: evidence,
      label: { compartments: options.compartments ?? ["own"], readers: ["m-owner"] },
      destination: "personal",
      pipelineVersion: "1",
      extractorGeneration: 1,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind: "owner",
    disclosure: [],
    factKey: "key",
    lane: "correspondence",
    fieldKinds: {},
    entities: [],
    origin: options.origin ?? "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

const judged = (
  one: ClaimRecord,
  state: "current" | "superseded",
  reached: "read" | "held" = "read",
  n = 1,
): JudgedCandidate => ({ record: one, factKeyFp: fp(n), reached, state });

describe("the statement", () => {
  it("two claims that differ only in speaker, basis, evidence, thread, time or compartments have one statement", () => {
    const base = record();
    const others = [
      record({ assertedBy: rhea }),
      record({ basis: "third_party" }),
      record({ evidence: "b".repeat(64) }),
      record({ validFrom: "2026-10-03T09:00:00.000Z" }),
      record({ compartments: ["own", "agent:alpha"] }),
      record({ id: "claim-2", origin: "agent_record" }),
    ];
    for (const other of others) expect(statementOf(other)).toBe(statementOf(base));
    // The thread is no part of a claim: it is in the fact key, which the statement leaves out.
    expect(statementOf({ ...base, factKey: "another key" })).toBe(statementOf(base));
    // Controls: the type, the subject and a field each make another statement.
    expect(
      statementOf(
        record({ type: "plan", fields: { counterparty: rhea, what: "I will send the plans.", when: "2026-10-09" } }),
      ),
    ).not.toBe(statementOf(base));
    expect(statementOf(record({ subject: rhea }))).not.toBe(statementOf(base));
    expect(
      statementOf(record({ fields: { counterparty: alder, what: "I will send the plans.", due: "2026-10-09" } })),
    ).not.toBe(statementOf(base));
    expect(
      statementOf(record({ fields: { counterparty: rhea, what: "I will send the plans.", due: "2026-10-10" } })),
    ).not.toBe(statementOf(base));
  });

  it("a text field differing only in white space and case has one statement; differing in a word, two", () => {
    const fields = (what: string) => ({ counterparty: rhea, what, due: "2026-10-09" });
    expect(statementOf(record({ fields: fields("I  will SEND the\nplans. ") }))).toBe(statementOf(record()));
    expect(statementOf(record({ fields: fields("I will send the drawings.") }))).not.toBe(statementOf(record()));
  });

  it("the statement is canonical JSON of the type, the subject and the declared fields in name order", () => {
    expect(
      statementOf(record({ fields: { what: "I will send the plans.", due: "2026-10-09", counterparty: rhea } })),
    ).toBe(
      JSON.stringify({
        fields: { counterparty: rhea, due: "2026-10-09", what: "i will send the plans." },
        subject: owner,
        type: "commitment",
      }),
    );
    // A field the type does not declare is no part of it.
    expect(
      statementOf(
        record({ fields: { counterparty: rhea, what: "I will send the plans.", due: "2026-10-09", extra: "x" } }),
      ),
    ).toBe(statementOf(record()));
  });
});

describe("rung 0's answer", () => {
  const a = record({ id: "finding", origin: "agent_record" });
  const equal = record({ id: "source" });
  const other = record({
    id: "other",
    fields: { counterparty: rhea, what: "I will call on Monday.", due: "2026-10-09" },
  });

  it("one current equal candidate gives echo", () => {
    expect(restatementAnswer(a, [judged(equal, "current", "read", 7)])).toEqual({
      answer: "echo",
      reached: "read",
      matchedFactKeyFp: fp(7),
    });
    // With a superseded one beside it, still echo, matched by the current one; the superseded
    // one was read, so an equal claim was reached by path 1.
    expect(
      restatementAnswer(a, [
        judged(equal, "superseded", "read", 2),
        judged(record({ id: "source-2" }), "current", "held", 3),
      ]),
    ).toEqual({ answer: "echo", reached: "read", matchedFactKeyFp: fp(3) });
    expect(
      restatementAnswer(a, [
        judged(equal, "superseded", "held", 2),
        judged(record({ id: "source-2" }), "current", "held", 3),
      ]),
    ).toEqual({ answer: "echo", reached: "held", matchedFactKeyFp: fp(3) });
  });

  it("equal candidates all superseded gives stale", () => {
    expect(restatementAnswer(a, [judged(equal, "superseded", "read", 4), judged(other, "current", "read", 5)])).toEqual(
      { answer: "stale", reached: "read", matchedFactKeyFp: fp(4) },
    );
  });

  it("a candidate of the same type and subject with another statement gives undecided", () => {
    expect(restatementAnswer(a, [judged(other, "current", "read", 5)])).toEqual({
      answer: "undecided",
      reached: "held",
      matchedFactKeyFp: null,
    });
  });

  it("no candidate gives new", () => {
    expect(restatementAnswer(a, [])).toEqual({ answer: "new", reached: null, matchedFactKeyFp: null });
  });

  it("reached is read when a read candidate is equal, held otherwise", () => {
    expect(restatementAnswer(a, [judged(equal, "current", "held", 1)]).reached).toBe("held");
    expect(
      restatementAnswer(a, [
        judged(equal, "current", "held", 1),
        judged(record({ id: "source-2" }), "current", "read", 2),
      ]),
    ).toEqual({ answer: "echo", reached: "read", matchedFactKeyFp: fp(2) });
    // A read candidate with another statement does not make an equal held one read.
    expect(
      restatementAnswer(a, [judged(equal, "current", "held", 1), judged(other, "current", "read", 2)]).reached,
    ).toBe("held");
  });

  it("A itself is never its own candidate", () => {
    expect(restatementAnswer(a, [judged(a, "current", "read", 1)])).toEqual({
      answer: "new",
      reached: null,
      matchedFactKeyFp: null,
    });
  });
});

describe("current and superseded", () => {
  const s = record({ id: "s" });
  const candidate = (belief: RestatementCandidate["belief"], rejected = false): RestatementCandidate => ({
    record: s,
    factKeyFp: fp(1),
    reached: "read",
    belief,
    rejected,
  });

  it("no belief is current; an open belief whose latest supporting claim has S's statement is current", () => {
    expect(candidateState(candidate(null))).toBe("current");
    for (const status of ["active", "stale", "dormant"] as const)
      expect(candidateState(candidate({ status, latest: record({ id: "later", evidence: "c".repeat(64) }) }))).toBe(
        "current",
      );
  });

  it("an expired or closed belief, a latest supporting claim with another statement, and a rejected claim are superseded", () => {
    for (const status of ["expired", "closed"] as const)
      expect(candidateState(candidate({ status, latest: s }))).toBe("superseded");
    expect(
      candidateState(
        candidate({
          status: "active",
          latest: record({
            id: "later",
            fields: { counterparty: rhea, what: "I will not send the plans.", due: "2026-10-09" },
          }),
        }),
      ),
    ).toBe("superseded");
    expect(candidateState(candidate({ status: "active", latest: null }))).toBe("superseded");
    expect(candidateState(candidate(null, true))).toBe("superseded");
  });

  it("checkRestatement judges each candidate and answers", () => {
    const a = record({ id: "finding", origin: "agent_record" });
    expect(checkRestatement(a, [candidate({ status: "closed", latest: s })])).toEqual({
      answer: "stale",
      reached: "read",
      matchedFactKeyFp: fp(1),
    });
    expect(checkRestatement(a, [candidate({ status: "active", latest: s })])).toEqual({
      answer: "echo",
      reached: "read",
      matchedFactKeyFp: fp(1),
    });
  });
});

describe("the held keys", () => {
  const role = record({
    type: "role",
    fields: { title: "Head of Finance", organization: alder },
    compartments: ["agent:alpha", "employer:example", "own"],
  });

  it("a global type's held keys are its fact key as a message of each source compartment of the label would have it", () => {
    const keys = heldFactKeys(role, ["agent:alpha", "employer:example", "own"]);
    expect(keys).toEqual(
      [
        personalFactKey(role.claim.content, "", ["employer:example"]),
        personalFactKey(role.claim.content, "", ["own"]),
      ].sort(),
    );
    // The record's own key, under its whole label, is not one of them.
    expect(keys).not.toContain(personalFactKey(role.claim.content, "", ["agent:alpha", "employer:example", "own"]));
    expect(heldFactKeys(role, ["agent:alpha"])).toEqual([]);
  });

  it("a thread-scoped type has no held keys", () => {
    expect(heldFactKeys(record(), ["agent:alpha", "own"])).toEqual([]);
  });

  // At the key version of A's generation. A version 4 goal of generation 5 has no thread scope,
  // so it has held keys, at version 2; the same goal of an earlier generation has none.
  it("a version 4 owner-side claim of the go's generation has held keys at fact key version 2", () => {
    const goal = record({
      type: "goal",
      fields: { objective: "raise a seed round", domain: "ventures" },
      compartments: ["agent:alpha", "own"],
    });
    const after = { ...goal, claim: { ...goal.claim, extractorGeneration: 5 } } as ClaimRecord;
    expect(heldFactKeys(goal, ["agent:alpha", "own"])).toEqual([]);
    expect(heldFactKeys(after, ["agent:alpha", "own"])).toEqual([
      personalFactKey(after.claim.content, "", ["own"], undefined, 2),
    ]);
    // A role's held keys take its title from generation 5 on.
    const titled = { ...role, claim: { ...role.claim, extractorGeneration: 5 } } as ClaimRecord;
    expect(heldFactKeys(titled, ["own"])).toEqual([personalFactKey(role.claim.content, "", ["own"], undefined, 2)]);
    expect(heldFactKeys(role, ["own"])).toEqual([personalFactKey(role.claim.content, "", ["own"])]);
  });
});
