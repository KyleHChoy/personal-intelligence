import type { EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { hisNames } from "./person-name-rows.ts";

// The owner's name for a person holds the person the owner named, its anchor, and every read
// resolves the anchor's group as the owner's rulings make it then. While two
// people are joined the name names both; after the join is undone it names the anchor's half alone.
// Synthetic people on reserved domains only.

const TIMEOUT = 180_000;
const A = "ana@person-anchor.test";
const C = "cy@person-anchor.test";

// Which of these people the owner's live names name, as every read that names a person reads them.
const namedBy = async (world: IdentityWorld, people: EntityId[]): Promise<string[]> =>
  (
    await world.sql<{ entity_id: string }>(
      `select distinct x.entity_id from (${hisNames("e.id = any ($1::text[])")}) x order by 1`,
      [people],
    )
  ).map((row) => row.entity_id);

// One node of a plan as `explain (format json)` prints it.
type PlanNode = { "Node Type": string; "Actual Loops": number; Plans?: PlanNode[] };

async function two(world: IdentityWorld): Promise<{ a: EntityId; c: EntityId }> {
  await world.save(world.accounts.personalContacts, "a", { names: ["Ana Example"], emails: [A] });
  await world.save(world.accounts.personalContacts, "c", { names: ["Cy Example"], emails: [C] });
  return { a: await world.person(A), c: await world.person(C) };
}

describe("the owner's name holds its anchor", { timeout: TIMEOUT }, () => {
  it("a name written over a joined pair names both while joined, and the anchor's half alone once the join is undone", () =>
    inIdentityWorld(async (world) => {
      const { a, c } = await two(world);
      const join = await world.admin.identity.linkPeople(a, c, "same", { requestId: req() });
      const ruling = await world.admin.identity.namePerson(a, "Ana Given-Name", { requestId: req() });
      expect(
        await world.sql<{ entity_ids: string[] }>(
          "select entity_ids from knowledge.person_names where ruling_id = $1",
          [ruling],
        ),
      ).toEqual([{ entity_ids: [a] }]);
      expect(await namedBy(world, [a, c])).toEqual([a, c].sort());
      await world.admin.identity.liftIdentity(join, { requestId: req() });
      expect(await namedBy(world, [a, c])).toEqual([a]);
    }));

  // The group of a name's addresses depends on the name alone. Walked once for every person asked,
  // it made search read for 13 seconds on a store of a few thousand people.
  it("walks a name's group once, however many people are asked", () =>
    inIdentityWorld(async (world) => {
      const { a } = await two(world);
      for (let i = 0; i < 12; i++) {
        await world.save(world.accounts.personalContacts, `p${i}`, {
          names: [`Person ${i}`],
          emails: [`p${i}@person-anchor.test`],
        });
      }
      await world.admin.identity.namePerson(a, "Ana Given-Name", { requestId: req() });
      const [row] = await world.sql<{ "QUERY PLAN": string | { Plan: PlanNode }[] }>(
        `explain (analyze, format json) select x.entity_id from (${hisNames("e.kind = 'person'")}) x`,
        [],
      );
      const printed = row?.["QUERY PLAN"];
      const plan = (typeof printed === "string" ? JSON.parse(printed) : printed) as { Plan: PlanNode }[];
      const walks: number[] = [];
      const visit = (node: PlanNode): void => {
        if (node["Node Type"] === "Recursive Union") walks.push(node["Actual Loops"]);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan[0]?.Plan as PlanNode);
      expect(walks.length).toBeGreaterThan(0);
      expect(Math.max(...walks)).toBe(1);
      expect(await namedBy(world, [a])).toEqual([a]);
    }));
});
