import { SelfView } from "@intelligence/contracts/personal";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  beliefRows,
  commit,
  type FactGroupWorld,
  factGroupWorld,
  goal,
  OWN,
} from "../test-support/fact-group-fixtures.ts";
import { scripted, sweep } from "../test-support/same-fact-fixtures.ts";

// Same-fact proposals, rulings and groups, and the self page, joined end to end on Postgres: two
// phrasings of one goal raise one same_fact card in shadow, and nothing groups; the owner answers
// `same` on the card; at once the self page shows one goal line. Reserved domains and made-up
// phrases only.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let world: FactGroupWorld;
beforeAll(async () => {
  world = await factGroupWorld();
});
afterAll(async () => {
  await world?.close();
});

const goalLines = async (): Promise<string[]> => {
  const served = await world.reader.getSelf(world.token, {});
  if (!served.ok) throw new Error(`get_self answered ${served.code}`);
  return (SelfView.parse(served.value).sections ?? [])
    .flatMap((section) => section.lines)
    .filter((line) => line.kind === "goal")
    .map((line) => line.fact);
};

describe("K3: a same_fact card answered `same` collapses the self page's goal", () => {
  it("shadow raises one card and groups nothing; `same` joins; the self page shows one goal line", async () => {
    const { items } = world;
    const round = goal(world, items.canary, "own", {
      n: 1,
      factKey: "k3 e2e round",
      objective: "raise a seed round",
      validFrom: "2026-09-01T09:00:00.000Z",
    });
    const funding = goal(world, items.solo, "own", {
      n: 1,
      factKey: "k3 e2e funding",
      objective: "raise seed funding",
      validFrom: "2026-09-03T09:00:00.000Z",
    });
    expect(await commit(world, items.canary, [round])).toBe("committed");
    expect(await commit(world, items.solo, [funding])).toBe("committed");
    expect(await beliefRows(world, OWN)).toHaveLength(2);
    expect(await goalLines()).toHaveLength(2);

    // The sweep in shadow (the default mode): the decide model puts the pair in the accept band.
    const decideModel = scripted(() => ({ same_fact: 0.97 }));
    const store = { db: world.db, pipeline: world.pipeline } as never;
    const counts = await sweep(store, decideModel);
    expect(counts).toMatchObject({ raised: 1 });
    const cards = await queryAs<{ id: string; target_kind: string; case_key: string }>(
      world.db.urls.admin,
      "select id, target_kind, case_key from ledger.cards where kind = 'same_fact'",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.target_kind).toBe("claim");
    expect(cards[0]?.case_key).toMatch(/^[0-9a-f]{64}$/);
    // Every judgment of the pair links the one card of its label.
    const rows = await queryAs<{ card_id: string; state: string }>(
      world.db.urls.admin,
      "select card_id, state from knowledge.same_fact_judgments",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.card_id === cards[0]?.id && row.state === "proposed")).toBe(true);
    // The card shows both phrasings, as their claims give them.
    const shown = await world.admin.cards.card(cards[0]?.id as never);
    const text = shown?.lines.map((line) => line.text).join("\n") ?? "";
    expect(text).toContain("raise a seed round");
    expect(text).toContain("raise seed funding");

    // Shadow groups nothing.
    expect(await beliefRows(world, OWN)).toHaveLength(2);

    // The owner answers `same`, which joins the two keys at once.
    await world.admin.cards.decide({ cards: [cards[0]?.id as never], answer: "same", requestId: "k3-e2e-same-0001" });
    expect(await beliefRows(world, OWN)).toHaveLength(1);
    expect(await goalLines()).toHaveLength(1);
  });
});
