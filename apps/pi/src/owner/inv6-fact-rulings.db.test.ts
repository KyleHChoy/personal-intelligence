import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOTH,
  beliefRows,
  commit,
  type FactGroupWorld,
  factGroupWorld,
  factId,
  goal,
  OWN,
} from "../test-support/fact-group-fixtures.ts";

// Same-fact rulings and groups, invariant 6: a join the client's audience cannot read (one key of
// it under a compartment the client is not cleared for) changes none of its beliefs, groups or
// cites, nor how many there are or their rows.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let world: FactGroupWorld;
beforeAll(async () => {
  world = await factGroupWorld();
});
afterAll(async () => {
  await world?.close();
});

describe("invariant 6: a hidden join", () => {
  it("changes nothing the client sees", async () => {
    const { items } = world;
    const sail = goal(world, items.canary, "own", { n: 1, factKey: "k3b6 sail", objective: "learn to sail" });
    const boat = goal(world, items.solo, "own", {
      n: 1,
      factKey: "k3b6 boat",
      objective: "sail a boat",
      validFrom: "2026-09-03T11:00:00.000Z",
    });
    const crew = goal(world, items.work, "employer:example", {
      n: 1,
      factKey: "k3b6 crew",
      objective: "join a sailing crew",
      validFrom: "2026-09-08T09:00:00.000Z",
    });
    expect(await commit(world, items.canary, [sail])).toBe("committed");
    expect(await commit(world, items.solo, [boat])).toBe("committed");
    expect(await commit(world, items.work, [crew])).toBe("committed");
    const seen = async () => {
      const served = await world.reader.getBeliefs(world.token, { kind: "goal", state: "any" });
      if (!served.ok) throw new Error(`get_beliefs answered ${served.code}`);
      return served.value;
    };
    const before = await seen();
    const rows = await beliefRows(world, OWN);
    // The positive control: the client sees both of its goals.
    expect(before.beliefs).toHaveLength(2);

    // Two joins that each name the hidden key: neither is readable under `own` alone.
    await world.admin.facts.joinFacts(factId(world, sail), factId(world, crew), { requestId: "k3b-inv6-000001" });
    await world.admin.facts.joinFacts(factId(world, boat), factId(world, crew), { requestId: "k3b-inv6-000002" });
    expect(await seen()).toEqual(before);
    // The beliefs `own` computes are exactly as they were.
    expect(await beliefRows(world, OWN)).toEqual(rows);
    expect((await beliefRows(world, OWN)).every((row) => row.group_fp === null)).toBe(true);
    // After review (invariant 4): a clearance of both compartments reads both joins, and still
    // computes the `own`-labelled beliefs as `own` does: sail and boat are joined only through the
    // employer's key.
    const ownLabelled = (await beliefRows(world, BOTH)).filter((row) => row.compartments.join() === "own");
    expect(ownLabelled).toEqual(rows);
  });
});
