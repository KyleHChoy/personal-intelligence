import type { ClaimRecord, RestatementCandidate, RestatementCheck } from "@intelligence/contracts/personal";
import { keyScope, keyVersionOf, normal, personalFactKey, personalType } from "@intelligence/personal-beliefs";
import { canonicalJson } from "@intelligence/personal-core";

// Echoes and stale reassertions at rung 0: a claim taken from an agent record compared, by code,
// with the claims its writer could see and its session reached. Pure functions: the store finds the
// candidates and the commit writes the answer.

// The speaker, the basis, the origin, the times, the evidence, the thread, the compartments, the fact key, the
// generation and the span are no part of it. A type the ontology does not know declares the fields its record's
// kinds name.
export function statementOf(record: ClaimRecord): string {
  const { type, subject, fields } = record.claim.content;
  const declared =
    personalType(type)?.fields.map((field) => ({ name: field.name, kind: field.kind })) ??
    Object.entries(record.fieldKinds).map(([name, kind]) => ({ name, kind }));
  const values: Record<string, unknown> = {};
  for (const { name, kind } of declared) {
    if (!Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    values[name] = kind === "text" && typeof value === "string" ? normal(value).text.trim() : value;
  }
  return canonicalJson({ type, subject, fields: values });
}

type CandidateState = "current" | "superseded";

// It is superseded when the belief is expired or closed, when its latest supporting claim says otherwise or
// did not open, or when a reject ruling names the candidate.
export function candidateState(candidate: RestatementCandidate): CandidateState {
  if (candidate.rejected) return "superseded";
  const { belief } = candidate;
  if (belief === null) return "current";
  if (belief.status === "expired" || belief.status === "closed") return "superseded";
  return belief.latest !== null && statementOf(belief.latest) === statementOf(candidate.record)
    ? "current"
    : "superseded";
}

export type JudgedCandidate = {
  record: ClaimRecord;
  factKeyFp: string;
  reached: "read" | "held";
  state: CandidateState;
};

type RestatementResult = Omit<RestatementCheck, "claimId">;

// Read reaches first, then the fact key and the claim id in byte order: one answer for one set.
const byReach = (a: JudgedCandidate, b: JudgedCandidate): number =>
  a.reached !== b.reached
    ? a.reached === "read"
      ? -1
      : 1
    : a.factKeyFp !== b.factKeyFp
      ? a.factKeyFp < b.factKeyFp
        ? -1
        : 1
      : a.record.claim.id < b.record.claim.id
        ? -1
        : a.record.claim.id > b.record.claim.id
          ? 1
          : 0;

// `stale` when there is one and every one is superseded; `undecided` when there are candidates and none has it;
// `new` when there are none. The fact key matched is that of a claim that decided the answer (a current equal
// one for an echo, any equal one for a stale reassertion), a read one first. A itself is never its own
// candidate.
export function restatementAnswer(a: ClaimRecord, candidates: JudgedCandidate[]): RestatementResult {
  const others = candidates.filter((one) => one.record.claim.id !== a.claim.id);
  if (others.length === 0) return { answer: "new", reached: null, matchedFactKeyFp: null };
  const statement = statementOf(a);
  const equal = others.filter((one) => statementOf(one.record) === statement);
  const current = equal.filter((one) => one.state === "current");
  const [first] = (current.length > 0 ? current : equal).sort(byReach);
  if (first === undefined) return { answer: "undecided", reached: "held", matchedFactKeyFp: null };
  return {
    answer: current.length > 0 ? "echo" : "stale",
    reached: equal.some((one) => one.reached === "read") ? "read" : "held",
    matchedFactKeyFp: first.factKeyFp,
  };
}

// Each candidate judged, then rung 0's answer.
export const checkRestatement = (a: ClaimRecord, candidates: RestatementCandidate[]): RestatementResult =>
  restatementAnswer(
    a,
    candidates.map((one) => ({
      record: one.record,
      factKeyFp: one.factKeyFp,
      reached: one.reached,
      state: candidateState(one),
    })),
  );

// A thread-scoped type has none. The key is at the key version of A's generation, so A matches what a
// message of that generation holds, an owner-side kind of version 4 among the global ones.
export function heldFactKeys(a: ClaimRecord, label: readonly string[]): string[] {
  const keyVersion = keyVersionOf(a.claim.extractorGeneration);
  if (keyScope(a.claim.content, keyVersion) !== "global") return [];
  const keys = label
    .filter((compartment) => !compartment.startsWith("agent:"))
    .map((compartment) => personalFactKey(a.claim.content, "", [compartment], undefined, keyVersion));
  return [...new Set(keys)].sort();
}
