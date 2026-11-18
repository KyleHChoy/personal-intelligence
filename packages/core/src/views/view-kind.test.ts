import { describe, expect, it } from "vitest";
import { type ViewOntology, viewKindOf } from "./view-kind.ts";

// viewKindOf's answers, pinned in a table: over the personal ontology
// (packages/beliefs/src/ontology.ts, PERSONAL_ONTOLOGY) and over made-up types that take each of
// its branches. The two project types have belief kinds: the first rule, a belief kind that is a
// view, answers `decision` for project.decision.

type Row = { id: string; parent?: string; beliefKind?: string; answer: string | null };

// Every claim type of the personal ontology, with its parents.
const PERSONAL: readonly Row[] = [
  { id: "transaction", answer: null },
  { id: "project", answer: "project" },
  { id: "transaction.receipt", parent: "transaction", answer: null },
  { id: "commitment", beliefKind: "commitment", answer: "commitment" },
  { id: "plan", answer: null },
  { id: "role", beliefKind: "role", answer: "role" },
  { id: "affiliation", beliefKind: "affiliation", answer: "affiliation" },
  { id: "relationship", beliefKind: "relationship", answer: "relationship" },
  { id: "need", beliefKind: "need", answer: "need" },
  { id: "capability", beliefKind: "capability", answer: "capability" },
  { id: "goal", beliefKind: "goal", answer: "goal" },
  { id: "preference", beliefKind: "preference", answer: "preference" },
  { id: "constraint", beliefKind: "constraint", answer: null },
  { id: "situation", beliefKind: "situation", answer: null },
  { id: "consent", beliefKind: "consent", answer: null },
  { id: "contact_rule", beliefKind: "contact_rule", answer: null },
  { id: "project.status", parent: "project", beliefKind: "project_status", answer: "project" },
  { id: "project.decision", parent: "project", beliefKind: "decision", answer: "decision" },
];

// Made-up types: a belief kind that is a view, a line of parents, a line that comes back on
// itself, a parent that is not there, the first part of an id, and a belief kind that is no view.
const SYNTHETIC: readonly Row[] = [
  { id: "need.hiring", parent: "need", answer: "need" },
  { id: "need", beliefKind: "need", answer: "need" },
  { id: "role.position", beliefKind: "role", answer: "role" },
  { id: "deal.stage", parent: "account", answer: "account" },
  { id: "account", answer: "account" },
  { id: "loop.a", parent: "loop.b", answer: null },
  { id: "loop.b", parent: "loop.a", answer: null },
  { id: "decision.made", answer: "decision" },
  { id: "weather.report", answer: null },
  { id: "orphan.child", parent: "missing.parent", answer: null },
  { id: "ownership", beliefKind: "situation", answer: "ownership" },
];

const viewOf = (rows: readonly Row[]): ViewOntology => {
  const types = new Map(rows.map(({ answer: _answer, ...type }) => [type.id, type]));
  return { get: (type) => types.get(type) ?? null };
};

describe("viewKindOf", () => {
  it("core's viewKindOf answers as the shared one for every claim type of the ontology", () => {
    const ontology = viewOf(PERSONAL);
    for (const row of PERSONAL) expect(viewKindOf(row.id, ontology), row.id).toBe(row.answer);
  });

  it("and for made-up types that take each branch, and for a type the ontology does not hold", () => {
    const ontology = viewOf(SYNTHETIC);
    for (const row of SYNTHETIC) expect(viewKindOf(row.id, ontology), row.id).toBe(row.answer);
    expect(viewKindOf("not.in.ontology", ontology)).toBeNull();
  });
});
