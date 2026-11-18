import { describe, expect, it } from "vitest";
import { ReasonerOutput } from "./index.ts";
import { refusesUnknownKeys } from "./test-checks.ts";
import { at, citation, label, later, runToken } from "./test-samples.ts";

// The playbooks, what wakes a run, what a run appends, and the card with what hangs off it.

const gatewayScope = {
  kind: "job_scope",
  payload: { id: "sc-2", role: "reasoner", gateway: "tg-people", expiresAt: later },
  keyId: "k-token-1",
  signature: "sig",
};
const signedRunToken = { kind: "run_token", token: runToken, keyId: "k-token-1", signature: "sig" };

const caseRecord = {
  id: "case-1",
  runId: "r-1",
  playbook: "introduction",
  generator: "gen-1",
  snapshotAt: at,
  inputs: ["c-1"],
  prediction: { check: "first_interaction", probability: 0.4 },
  versusWaiting: { probabilityIfWaiting: 0.1, choice: "act" },
  label,
};
const candidate = {
  id: "cand-1",
  caseId: "case-1",
  playbook: "introduction",
  parties: [{ party: "party-1", role: "need_side", entity: "h-1", side: "a" }],
  support: [
    {
      claimId: "c-1",
      citation: { ...citation, quote: "We need a head of finance." },
      expected: "need.hiring",
      side: "a",
    },
  ],
  texts: [{ kind: "introduction", recipients: ["party-1"], text: "An introduction, as the reasoner proposed it." }],
};
const silence = {
  id: "sil-1",
  runId: "r-1",
  member: "m-ben",
  playbook: "introduction",
  reason: "below_bar",
  label,
  at,
};
const verification = {
  id: "ver-1",
  targetKind: "candidate",
  targetId: "cand-1",
  quotes: [{ claimId: "c-1", passed: true }],
  outcome: { outcome: "verified", label, reason: "ok" },
};
const decisionRecord = {
  id: "dr-1",
  runId: "r-1",
  project: "h-7",
  threadId: "th-1",
  decision: "c-4",
  reasoning: [citation],
  alternatives: ["c-5"],
  expectation: "c-6",
  owner: "h-3",
  checkBackAt: later,
  label,
};
const runStep = {
  runId: "r-1",
  ordinal: 0,
  kind: "model_call",
  decision: "candidate_set",
  status: "ok",
  usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
  cost: 0.01,
  at,
};
const toolCall = { runId: "r-1", stepOrdinal: 1, tool: "find_matches", status: "refused", code: "denied", at };
const window = { from: at, to: later };
const replay = { rule: "aggregate-weekly", window, decisions: 10, agree: 8, differ: 2 };

describe("the reasoner's output (proposed)", () => {
  const candidate = {
    parties: [{ entity: "h-1", role: "need_side" }],
    support: [{ claimId: "c-1", evidenceId: "ev-1", span: "chars:0-5" }],
    prediction: { check: "consent", probability: 0.6 },
    probabilityIfWaiting: 0.2,
    texts: [{ kind: "introduction", recipients: [0], text: "An introduction." }],
  };
  const record = {
    project: "h-p",
    threadId: "t-1",
    decision: "c-1",
    reasoning: [{ evidenceId: "ev-1", span: "chars:0-5" }],
    alternatives: [],
  };

  it("takes a proposal, decision records, a silence or null, and nothing a model may not set", () => {
    expect(ReasonerOutput.safeParse({ decision: "propose", candidates: [candidate] }).success).toBe(true);
    expect(ReasonerOutput.safeParse({ decision: "record_decisions", records: [record] }).success).toBe(true);
    expect(ReasonerOutput.safeParse(null).success).toBe(true);
    refusesUnknownKeys(ReasonerOutput, { decision: "propose", candidates: [candidate] });
    expect(
      ReasonerOutput.safeParse({
        decision: "propose",
        candidates: [{ ...candidate, label: { compartments: [], readers: [] } }],
      }).success,
    ).toBe(false);
    expect(
      ReasonerOutput.safeParse({
        decision: "propose",
        candidates: [{ ...candidate, parties: [{ entity: "h-1", role: "need_side", side: "a" }] }],
      }).success,
    ).toBe(false);
    expect(
      ReasonerOutput.safeParse({
        decision: "propose",
        candidates: [{ ...candidate, support: [{ ...candidate.support[0], quote: "Mine." }] }],
      }).success,
    ).toBe(false);
    expect(
      ReasonerOutput.safeParse({
        decision: "record_decisions",
        records: [{ ...record, label: { compartments: [], readers: [] } }],
      }).success,
    ).toBe(false);
  });
});
