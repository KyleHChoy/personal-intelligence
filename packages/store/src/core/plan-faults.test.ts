import { describe, expect, it } from "vitest";
import { type Known, type PlanNode, planFaults } from "../test-support/hidden-rows-measure.ts";

// The plan-shape rule of I3, on plans written by hand: each kind of fault, and each kind of scan that is
// none.

const known: Known = {
  labelled: new Set(["knowledge.messages", "knowledge.event_participants", "knowledge.entities"]),
  lookups: new Map([
    ["messages_pkey", ["id"]],
    ["event_participants_pkey", ["event_id", "entity_id"]],
    ["entities_pkey", ["id"]],
    ["entities_one_owner", ["kind"]],
  ]),
};
const scan = (type: string, relation: string, index?: string, cond?: string, plans?: PlanNode[]): PlanNode => ({
  "Node Type": type,
  "Relation Name": relation.split(".")[1] ?? relation,
  Schema: relation.split(".")[0] ?? "",
  ...(index === undefined ? {} : { "Index Name": index }),
  ...(cond === undefined ? {} : { "Index Cond": cond }),
  ...(plans === undefined ? {} : { Plans: plans }),
});
const KEY = "(policy.label_key(m.compartments) = ANY ((InitPlan 1).col1))";

describe("planFaults", () => {
  it("passes a scan by the key, a lookup of every column of a primary key, and the owner's index", () => {
    expect(planFaults(scan("Index Scan", "knowledge.messages", "messages_key_sent", KEY), known)).toEqual([]);
    expect(planFaults(scan("Index Scan", "knowledge.messages", "messages_pkey", "(m.id = $1)"), known)).toEqual([]);
    expect(
      planFaults(scan("Index Only Scan", "knowledge.entities", "entities_pkey", "(e.id = ANY ($1))"), known),
    ).toEqual([]);
    expect(
      planFaults(
        scan(
          "Index Scan",
          "knowledge.event_participants",
          "event_participants_pkey",
          "((p.event_id = $1) AND (p.entity_id = $2))",
        ),
        known,
      ),
    ).toEqual([]);
    expect(
      planFaults(scan("Index Scan", "knowledge.entities", "entities_one_owner", "(e.kind = 'owner'::text)"), known),
    ).toEqual([]);
    expect(planFaults(scan("Index Scan", "knowledge.entities", "entities_one_owner"), known)).toEqual([]);
    expect(
      planFaults(
        scan("Bitmap Heap Scan", "knowledge.messages", undefined, undefined, [
          { "Node Type": "Bitmap Index Scan", "Index Name": "messages_key_sender", "Index Cond": KEY },
        ]),
        known,
      ),
    ).toEqual([]);
    // A table the key does not serve is not judged.
    expect(planFaults(scan("Seq Scan", "policy.clients"), known)).toEqual([]);
  });

  it("names a sequential scan, a scan by an index without the key, a prefix of a primary key, a range, and a bitmap scan with one child without the key", () => {
    expect(planFaults(scan("Seq Scan", "knowledge.messages"), known)).toHaveLength(1);
    expect(
      planFaults(scan("Index Scan", "knowledge.messages", "messages_sent", "(m.sent_at <= $1)"), known),
    ).toHaveLength(1);
    expect(planFaults(scan("Index Scan", "knowledge.messages", "messages_pkey"), known)).toHaveLength(1);
    expect(planFaults(scan("Index Scan", "knowledge.messages", "messages_pkey", "(m.id > $1)"), known)).toHaveLength(1);
    expect(
      planFaults(
        scan("Index Scan", "knowledge.event_participants", "event_participants_pkey", "(p.event_id = ANY ($1))"),
        known,
      ),
    ).toHaveLength(1);
    expect(planFaults(scan("Index Only Scan", "knowledge.entities", "entities_pkey"), known)).toHaveLength(1);
    const and = {
      "Node Type": "BitmapAnd",
      Plans: [
        { "Node Type": "Bitmap Index Scan", "Index Name": "messages_key_sender", "Index Cond": KEY },
        { "Node Type": "Bitmap Index Scan", "Index Name": "messages_sender", "Index Cond": "(m.sender_fp = $1)" },
      ],
    };
    expect(planFaults(scan("Bitmap Heap Scan", "knowledge.messages", undefined, undefined, [and]), known)).toHaveLength(
      1,
    );
    expect(planFaults(scan("Tid Scan", "knowledge.messages"), known)).toHaveLength(1);
    // The owner's index with no condition only on the entities.
    expect(planFaults(scan("Index Scan", "knowledge.messages", "entities_one_owner"), known)).toHaveLength(1);
    // Under any other node, at any depth.
    expect(
      planFaults(
        { "Node Type": "Limit", Plans: [{ "Node Type": "Sort", Plans: [scan("Seq Scan", "knowledge.entities")] }] },
        known,
      ),
    ).toHaveLength(1);
  });
});
