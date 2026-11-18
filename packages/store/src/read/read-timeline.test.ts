import { FactView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { collapseAnchorRuns } from "./read-timeline.ts";

// Consecutive capture.anchor facts of one project and one item kind are one
// entry. The pure step over a timeline's items, already newest first; synthetic ids only.

const ULID = "01JTRRWN000000000000000000";
const capture = (n: number): string => `cap_${ULID.slice(0, -2)}${String(n).padStart(2, "0")}`;
const project = (n: number) => ({
  id: `ent_${ULID.slice(0, -2)}${String(n).padStart(2, "0")}`,
  kind: "project" as const,
  name: { untrusted: `Project ${n}` },
  address: null,
});
const at = (minute: number): Date => new Date(Date.UTC(2026, 2, 16, 9, minute));

// A capture.anchor fact of capture item `item`, about project `of`, at `minute`.
function anchorFact(item: number, minute: number, of = 1): { at: Date; id: string; fact: FactView } {
  const fact = FactView.parse({
    id: String(item).padStart(64, "a"),
    subject: project(of),
    statedBy: null,
    basis: "third_party",
    statementKind: "stated_fact",
    at: at(minute).toISOString(),
    message: null,
    document: null,
    passage: null,
    page: null,
    capture: capture(item),
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
    type: "capture.anchor",
    fields: { anchor: `pan_${ULID}` },
  });
  return { at: at(minute), id: fact.id, fact };
}
const task = (minute: number) => ({ at: at(minute), id: `task ${minute}` });

// What each item became, in order: a run's span and count, or the item's id.
const shape = (
  items: readonly ({ id: string } | { id: string; run: { first: Date; count: number; item: string } })[],
) =>
  items.map((one) =>
    "run" in one ? `run ${one.run.item} ${one.run.count} from ${one.run.first.toISOString().slice(11, 16)}` : one.id,
  );

describe("collapseAnchorRuns", () => {
  const moments = new Map([1, 2, 3, 4, 5, 6].map((n) => [capture(n), "moment" as const]));

  it("consecutive anchor facts of one project and one item kind are one run: its newest time, its first, its count and its facts", () => {
    const items = [anchorFact(3, 30), anchorFact(2, 20), anchorFact(1, 10)];
    const [run, ...rest] = collapseAnchorRuns(items, moments);
    expect(rest).toEqual([]);
    expect(run).toEqual({
      at: at(30),
      id: items[0]?.id,
      run: { first: at(10), count: 3, item: "moment", facts: items.map((one) => one.fact) },
    });
  });

  it("a lone anchor fact stays a fact, and anything between two facts ends the run", () => {
    const items = [anchorFact(4, 40), anchorFact(3, 30), task(25), anchorFact(2, 20), task(15), anchorFact(1, 10)];
    expect(shape(collapseAnchorRuns(items, moments))).toEqual([
      "run moment 2 from 09:30",
      "task 25",
      items[3]?.id,
      "task 15",
      items[5]?.id,
    ]);
  });

  it("a run holds one item kind and one project: a meeting's link or another project's ends it", () => {
    const kinds = new Map([...moments, [capture(3), "meeting" as const], [capture(4), "meeting" as const]]);
    const items = [
      anchorFact(6, 60),
      anchorFact(5, 50),
      anchorFact(4, 40),
      anchorFact(3, 30),
      anchorFact(2, 20, 2),
      anchorFact(1, 10, 2),
    ];
    expect(shape(collapseAnchorRuns(items, kinds))).toEqual([
      "run moment 2 from 09:50",
      "run meeting 2 from 09:30",
      "run moment 2 from 09:10",
    ]);
  });

  it("an anchor fact whose item the caller's read did not return as a meeting or a moment is never folded", () => {
    const items = [anchorFact(2, 20), anchorFact(1, 10)];
    expect(shape(collapseAnchorRuns(items, new Map([[capture(1), "moment" as const]])))).toEqual(
      items.map((one) => one.id),
    );
  });
});
