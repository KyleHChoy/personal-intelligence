import type { FactGrouping } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOTH,
  beliefRows,
  commit,
  type FactGroupWorld,
  factGroupWorld,
  factId,
  fp,
  goal,
  OWN,
} from "../test-support/fact-group-fixtures.ts";

// The owner's joins and splits, end to end through the belief computed at read: the owner's join
// groups two fact keys for every clearance that sees both and for none that sees one; across labels
// a belief a label, each holding only its own label's keys (invariant 4); a veto of a member closes
// the joined fact at once; a lift splits it again; the canonical claim is cited first. And
// invariant 11: a split holds against an accepted grouping row, and a join against a rejected one.
// The models' grouping rows are handed to the computation here, as the inputs a read takes; the
// joins and splits are the database's.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let world: FactGroupWorld;
let request = 0;
const requestId = (): string => `k3b-groups-${String((request += 1)).padStart(6, "0")}`;
const sorted = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

beforeAll(async () => {
  world = await factGroupWorld();
});
afterAll(async () => {
  await world?.close();
});

describe("the owner's joins in the belief build", () => {
  it("a join builds one belief in every audience that sees both keys; across labels, one a label with its own label's keys", async () => {
    const { items } = world;
    const sail = goal(world, items.canary, "own", {
      n: 1,
      factKey: "k3b sail",
      objective: "learn to sail",
      validFrom: "2026-09-01T09:00:00.000Z",
    });
    const boat = goal(world, items.solo, "own", {
      n: 1,
      factKey: "k3b boat",
      objective: "sail a boat",
      validFrom: "2026-09-03T11:00:00.000Z",
    });
    const crew = goal(world, items.work, "employer:example", {
      n: 1,
      factKey: "k3b crew",
      objective: "join a sailing crew",
      validFrom: "2026-09-08T09:00:00.000Z",
    });
    expect(await commit(world, items.canary, [sail])).toBe("committed");
    expect(await commit(world, items.solo, [boat])).toBe("committed");
    expect(await commit(world, items.work, [crew])).toBe("committed");
    expect((await beliefRows(world, OWN)).map((row) => row.fact_key_fp).sort()).toEqual(
      [fp(world, "k3b sail"), fp(world, "k3b boat")].sort(),
    );

    const join = await world.admin.facts.joinFacts(factId(world, sail), factId(world, boat), {
      requestId: requestId(),
    });
    const members = sorted(fp(world, "k3b sail"), fp(world, "k3b boat"));
    // Under the earliest claim's key, with both keys as members; the newest claim's phrase.
    const [own] = await beliefRows(world, OWN);
    expect(await beliefRows(world, OWN)).toHaveLength(1);
    expect(own).toMatchObject({
      fact_key_fp: fp(world, "k3b sail"),
      members,
      phrase_claim: factId(world, boat),
      status: "active",
    });
    expect(own?.group_fp).toMatch(/^[0-9a-f]{64}$/);
    // The owner's audience sees both keys and the join: one belief of the two there too.
    const owners = await beliefRows(world, BOTH);
    expect(owners.filter((row) => row.group_fp === own?.group_fp).map((row) => row.fact_key_fp)).toEqual([
      fp(world, "k3b sail"),
    ]);

    // The client is served the belief with its group, its canonical claim cited first.
    const served = await world.reader.getBeliefs(world.token, { kind: "goal", state: "any" });
    if (!served.ok) throw new Error(`get_beliefs answered ${served.code}`);
    const [belief] = served.value.beliefs.filter((one) => one.fact === fp(world, "k3b sail"));
    expect(belief?.group).toBe(own?.group_fp);
    expect((belief?.cites[0] as { id?: string } | undefined)?.id).toBe(factId(world, boat));

    // A join across labels: the client's audience cannot read it and keeps its one belief; the
    // owner's builds one belief a label. By invariant 4, each row holds only the keys
    // and joins of its own label: the `own` row is the client's, and the crew's is alone.
    await world.admin.facts.joinFacts(factId(world, sail), factId(world, crew), { requestId: requestId() });
    expect(await beliefRows(world, OWN)).toEqual([own]);
    const across = (await beliefRows(world, BOTH)).filter((row) =>
      [fp(world, "k3b sail"), fp(world, "k3b crew")].includes(row.fact_key_fp),
    );
    expect(across.map((row) => [row.fact_key_fp, row.compartments, row.members, row.group_fp]).sort()).toEqual(
      [
        [fp(world, "k3b sail"), OWN, members, own?.group_fp],
        [fp(world, "k3b crew"), ["employer:example"], null, null],
      ].sort(),
    );

    const veto = await world.admin.facts.vetoFact(factId(world, boat), { requestId: requestId() });
    expect((await beliefRows(world, OWN)).map((row) => row.status)).toEqual(["closed"]);
    await world.admin.facts.liftRuling(veto, { requestId: requestId() });
    expect(await beliefRows(world, OWN)).toEqual([own]);

    // A lift splits the facts again at once.
    expect(await world.admin.facts.liftFactRuling(join, { requestId: requestId() })).toBe(true);
    const apart = await beliefRows(world, OWN);
    expect(apart.map((row) => [row.fact_key_fp, row.group_fp, row.status]).sort()).toEqual(
      [
        [fp(world, "k3b sail"), null, "active"],
        [fp(world, "k3b boat"), null, "active"],
      ].sort(),
    );
  });

  it("invariant 11: a split holds against an accepted grouping, and a join against a rejected one", async () => {
    const { items } = world;
    const rent = goal(world, items.canary, "own", { n: 2, factKey: "k3b rent", objective: "find a flat" });
    const flat = goal(world, items.solo, "own", { n: 2, factKey: "k3b flat", objective: "rent a flat" });
    const lease = goal(world, items.canary, "own", { n: 3, factKey: "k3b lease", objective: "sign a lease" });
    const deed = goal(world, items.solo, "own", { n: 3, factKey: "k3b deed", objective: "sign the lease" });
    expect(
      await commit(world, items.canary, [
        goal(world, items.canary, "own", { n: 1, factKey: "k3b sail", objective: "learn to sail" }),
        rent,
        lease,
      ]),
    ).toBe("committed");
    expect(
      await commit(world, items.solo, [
        goal(world, items.solo, "own", {
          n: 1,
          factKey: "k3b boat",
          objective: "sail a boat",
          validFrom: "2026-09-03T11:00:00.000Z",
        }),
        flat,
        deed,
      ]),
    ).toBe("committed");
    const row = (x: string, y: string, state: FactGrouping["state"], band: FactGrouping["band"]): FactGrouping => ({
      audience: OWN,
      keys: sorted(fp(world, x), fp(world, y)),
      band,
      rung: 1,
      state,
      calls: [],
    });
    // The grouping rows: the models called rent and flat one fact, and lease and deed two.
    const groupings = [
      row("k3b rent", "k3b flat", "accepted", "accept"),
      row("k3b lease", "k3b deed", "rejected", "reject"),
    ];
    const applied = (inputs: Parameters<NonNullable<Parameters<typeof beliefRows>[2]>>[0]) => ({
      ...inputs,
      groupings,
      groupingMode: "apply" as const,
    });

    // Applied, the accepted row joins rent and flat; nothing joins lease and deed.
    const keys = async (): Promise<string[][]> =>
      (await beliefRows(world, OWN, applied))
        .filter((one) => one.members !== null)
        .map((one) => one.members as string[]);
    expect(await keys()).toEqual([sorted(fp(world, "k3b rent"), fp(world, "k3b flat"))]);

    // The owner's split holds against the accepted row, and their join against the rejected one.
    await world.admin.facts.splitFacts(factId(world, rent), factId(world, flat), { requestId: requestId() });
    await world.admin.facts.joinFacts(factId(world, lease), factId(world, deed), { requestId: requestId() });
    expect(await keys()).toEqual([sorted(fp(world, "k3b lease"), fp(world, "k3b deed"))]);
  });
});
