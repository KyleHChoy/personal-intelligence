import type { CardId, ClaimRecord, FactSettlementId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import {
  type AgentWorld,
  asOwner,
  batchOf,
  claimRecord,
  rowsOf,
  cardStateOf as stateOf,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// An agent's proposal or finding of a fact the owner already answered raises no card, a second card
// on an open fact waits on the first, and the owner's latest answer governs. Findings stand for both kinds:
// the raise is one path for about_you and agent_claim (raiseAgentClaims). Made-up values only.

// Every agent shares every compartment, as the owner set it.
const SHARED = ["own", "agent:alpha", "agent:beta", "agent:gamma"];
type Made = { record: string; evidence: string; label: string[] };
type Settlement = {
  id: FactSettlementId;
  claim_key: string;
  card_id: string;
  answer: string;
  written_by: string;
  withdrawn_card_id: string | null;
  reopened_at: Date | null;
};

let n = 0;
// A finding written by an agent under its clearance, taken in, and committed with one claim whose
// match key is `fact` (none for a thread-scoped claim).
async function finding(
  world: AgentWorld,
  fact: string | undefined,
  options: { agent?: string; clearance?: string[] } = {},
): Promise<Made> {
  n += 1;
  const made = await world.record(options.agent ?? "alpha", {
    body: `Rhea runs on Fridays, statement ${n}.`,
    clearance: options.clearance ?? SHARED,
  });
  const label = one(
    await rowsOf<{ compartments: string[] }>(world.db, "select compartments from vault.evidence_items where id = $1", [
      made.evidence,
    ]),
  ).compartments;
  const claim = claimRecord(made.evidence, label, world.owner, { origin: "agent_record", basis: "third_party" });
  const keyed: ClaimRecord = fact === undefined ? claim : ({ ...claim, matchKey: fact } as ClaimRecord);
  expect(await world.pipeline.commit(batchOf(made.evidence, [keyed], { lane: "agent" }))).toBe("committed");
  return { ...made, label };
}

const claimKey = (world: AgentWorld, made: Made): string =>
  fingerprint(
    world.db.keys,
    "agent_claim",
    `${made.evidence}\n${fingerprint(world.db.keys, "fact", `fact ${made.evidence} 1`)}`,
  );
const cardOf = async (world: AgentWorld, made: Made): Promise<CardId | undefined> =>
  (
    await rowsOf<{ id: CardId }>(
      world.db,
      "select id from ledger.cards where created_by = 'system:extract' and request_id = $1",
      [claimKey(world, made)],
    )
  )[0]?.id;
const settlements = (world: AgentWorld, made?: Made) =>
  rowsOf<Settlement>(
    world.db,
    `select id, claim_key, card_id, answer, written_by, withdrawn_card_id, reopened_at from ledger.fact_settlements
     where $1::text is null or claim_key = $1 order by created_at, id`,
    [made === undefined ? null : claimKey(world, made)],
  );
const inForce = async (world: AgentWorld, made: Made): Promise<Settlement | undefined> =>
  (await settlements(world, made)).at(-1);
const decide = (world: AgentWorld, cards: CardId[], answer: "confirm" | "reject") =>
  world.admin.cards.decide({ cards, answer, requestId: testId("req").slice(4) });
const decisions = async (world: AgentWorld): Promise<number> =>
  one(await rowsOf<{ n: number }>(world.db, "select count(*)::int as n from knowledge.owner_decisions")).n;

// A belief ruling of the owner's on a fact key (a veto or a retire), as pi_admin writes one.
async function beliefRuling(world: AgentWorld, verdict: "veto" | "retire", fact: string): Promise<void> {
  const id = testId("rul");
  await queryAs(
    world.db.urls.admin,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, $3, 0, now(), '{own}')",
    [id, `req-${id.slice(4)}`, verdict === "veto" ? "fact_veto" : "fact_retire"],
  );
  await queryAs(
    world.db.urls.admin,
    "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, $2, $3, $4, now(), '{own}')",
    [id, verdict, "0".repeat(64), fingerprint(world.db.keys, "fact", fact)],
  );
}

// Moves a card's events this many days into the past, as pi_owner, to stand for time passing.
async function age(world: AgentWorld, card: string, days: number): Promise<void> {
  await asOwner(
    world.db,
    "update ledger.record_events set at = at - make_interval(days => $2) where row_kind = 'card' and row_id = $1",
    [card, days],
  );
}

// A card made before the deploy: raised with no match key, then backfilled as `pi extract
// match-backfill` does.
async function legacy(world: AgentWorld, fact: string): Promise<{ made: Made; card: CardId }> {
  const made = await finding(world, undefined);
  const card = (await cardOf(world, made)) as CardId;
  expect(await world.pipeline.setMatchKey(card, fact)).toBe(true);
  return { made, card };
}

describe("fewer cards: an answered fact is not asked again", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a second agent's finding of a fact the owner confirmed raises no card, writes one settlement, releases nothing and leaves the beliefs as they were", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:rhea-runs");
      const card = (await cardOf(world, first)) as CardId;
      await decide(world, [card], "confirm");
      const before = {
        beliefs: await world.pipeline.beliefClaims(),
        decisions: await decisions(world),
        releases: one(await rowsOf<{ n: number }>(world.db, "select count(*)::int as n from knowledge.claim_releases"))
          .n,
      };
      const second = await finding(world, "fact:rhea-runs", { agent: "beta" });
      expect(await cardOf(world, second)).toBeUndefined();
      expect(await settlements(world, second)).toMatchObject([
        { card_id: card, answer: "confirmed", written_by: "pipeline" },
      ]);
      expect(await world.pipeline.beliefClaims()).toEqual(before.beliefs);
      expect(await decisions(world)).toBe(before.decisions);
      expect(
        one(await rowsOf<{ n: number }>(world.db, "select count(*)::int as n from knowledge.claim_releases")).n,
      ).toBe(before.releases);
    }));

  it("invariant 11: a fact the owner rejected, and one the owner vetoed, raise no card from any agent, and no decision of the owner's is written", () =>
    withAgents(async (world) => {
      const rejected = await finding(world, "fact:rejected");
      await decide(world, [(await cardOf(world, rejected)) as CardId], "reject");
      const vetoed = await finding(world, "fact:vetoed");
      await decide(world, [(await cardOf(world, vetoed)) as CardId], "confirm");
      await beliefRuling(world, "veto", "fact:vetoed");
      const count = await decisions(world);
      for (const agent of ["alpha", "beta", "gamma"]) {
        const again = await finding(world, "fact:rejected", { agent });
        expect(await cardOf(world, again), agent).toBeUndefined();
        expect((await inForce(world, again))?.answer).toBe("rejected");
      }
      const veto = await finding(world, "fact:vetoed", { agent: "beta" });
      expect(await cardOf(world, veto)).toBeUndefined();
      expect((await inForce(world, veto))?.answer).toBe("vetoed");
      expect(await decisions(world)).toBe(count);
    }));

  it("a retired fact is asked again, and a confirm tainted or superseded settles nothing", () =>
    withAgents(async (world) => {
      const retired = await finding(world, "fact:retired");
      await decide(world, [(await cardOf(world, retired)) as CardId], "confirm");
      await beliefRuling(world, "retire", "fact:retired");
      expect(await cardOf(world, await finding(world, "fact:retired"))).toBeDefined();

      const tainted = await finding(world, "fact:tainted");
      const [ruling] = await decide(world, [(await cardOf(world, tainted)) as CardId], "confirm");
      await asOwner(world.db, "update knowledge.owner_decisions set tainted_at = now() where id = $1", [
        ruling?.ruling,
      ]);
      expect(await cardOf(world, await finding(world, "fact:tainted"))).toBeDefined();

      const superseded = await finding(world, "fact:superseded");
      const [confirm] = await decide(world, [(await cardOf(world, superseded)) as CardId], "confirm");
      const lift = testId("rul");
      await queryAs(
        world.db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, supersedes, queue_depth, decided_at, compartments) values ($1, $2, 'confirmation_lift', $3, 0, now(), '{own}')",
        [lift, `req-${lift.slice(4)}`, confirm?.ruling],
      );
      expect(await cardOf(world, await finding(world, "fact:superseded"))).toBeDefined();
    }));

  it("a thread-scoped claim has no match key and is carded whatever was answered", () =>
    withAgents(async (world) => {
      const first = await finding(world, undefined);
      await decide(world, [(await cardOf(world, first)) as CardId], "confirm");
      const second = await finding(world, undefined);
      expect(await cardOf(world, second)).toBeDefined();
      expect(await settlements(world)).toEqual([]);
      expect(
        one(
          await rowsOf<{ n: number }>(
            world.db,
            "select count(*)::int as n from ledger.cards where match_fp is not null",
          ),
        ).n,
      ).toBe(0);
    }));

  it("an answer not written by decide settles nothing, and releases a claim waiting on its card", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:policy");
      const card = (await cardOf(world, first)) as CardId;
      const waiting = await finding(world, "fact:policy", { agent: "beta" });
      expect((await inForce(world, waiting))?.answer).toBe("waiting");
      // An answer another writer made (an automatic answer policy): its event is not the owner's.
      const id = testId("rul");
      await queryAs(
        world.db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, card_id, answer, queue_depth, decided_at, compartments) values ($1, $2, 'answer', $3, 'confirm', 0, now(), '{own}')",
        [id, `req-${id.slice(4)}`, card],
      );
      await asOwner(
        world.db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'system:policy', '{own}')",
        [card],
      );
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 1 });
      expect(await cardOf(world, waiting)).toBeDefined();
      expect(await cardOf(world, await finding(world, "fact:policy", { agent: "gamma" }))).toBeUndefined();
    }));
});

describe("fewer cards: one card a fact", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a second finding of a fact whose card is open waits on it, and the answer from the owner reaches it", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:open");
      const card = (await cardOf(world, first)) as CardId;
      const second = await finding(world, "fact:open", { agent: "beta" });
      expect(await cardOf(world, second)).toBeUndefined();
      expect(await inForce(world, second)).toMatchObject({ card_id: card, answer: "waiting" });
      await decide(world, [card], "reject");
      expect(await inForce(world, second)).toMatchObject({ card_id: card, answer: "rejected", written_by: "decide" });
    }));

  it("when the open card expires, the next run raises one card for the first claim waiting, and the others wait on it", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:expiring");
      const card = (await cardOf(world, first)) as CardId;
      const second = await finding(world, "fact:expiring", { agent: "beta" });
      const third = await finding(world, "fact:expiring", { agent: "gamma" });
      await age(world, card, 31);
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 1 });
      expect(await stateOf(world, card)).toBe("expired");
      const raised = (await cardOf(world, second)) as CardId;
      expect(raised).toBeDefined();
      expect(await cardOf(world, third)).toBeUndefined();
      expect(await inForce(world, third)).toMatchObject({ card_id: raised, answer: "waiting" });
      // Once only.
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 0 });
      // The released card keeps the match key: the answer from the owner on it reaches the third.
      await decide(world, [raised], "confirm");
      expect((await inForce(world, third))?.answer).toBe("confirmed");
    }));

  it("the answer from the owner on one of two duplicates raised before the deploy withdraws the other with a settlement; the withdrawn card cannot then be decided", () =>
    withAgents(async (world) => {
      const a = await legacy(world, "fact:dup");
      const b = await legacy(world, "fact:dup");
      await decide(world, [a.card], "confirm");
      expect(await stateOf(world, b.card)).toBe("withdrawn");
      expect(await inForce(world, b.made)).toMatchObject({
        card_id: a.card,
        answer: "confirmed",
        withdrawn_card_id: b.card,
        written_by: "decide",
      });
      await expect(decide(world, [b.card], "confirm")).rejects.toMatchObject({ code: "not_pending" });
    }));

  it("a batch decide naming both duplicates decides both and withdraws neither", () =>
    withAgents(async (world) => {
      const a = await legacy(world, "fact:batch");
      const b = await legacy(world, "fact:batch");
      expect(await decide(world, [a.card, b.card], "reject")).toHaveLength(2);
      expect([await stateOf(world, a.card), await stateOf(world, b.card)]).toEqual(["decided", "decided"]);
      expect(await settlements(world)).toEqual([]);
    }));

  it("a claim waiting on a pre-deploy duplicate that decide withdraws takes the answer from the owner on the other card", () =>
    withAgents(async (world) => {
      const a = await legacy(world, "fact:chain");
      const b = await legacy(world, "fact:chain");
      const waiting = await finding(world, "fact:chain", { agent: "beta" });
      expect(await inForce(world, waiting)).toMatchObject({ card_id: a.card, answer: "waiting" });
      await decide(world, [b.card], "confirm");
      expect(await stateOf(world, a.card)).toBe("withdrawn");
      expect(await inForce(world, waiting)).toMatchObject({ card_id: b.card, answer: "confirmed" });
      // Nothing waits on a withdrawn card: the run raises none.
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 0 });
    }));

  it("a backfilled card matches a later proposal of the fact; the backfill writes only where null, so a rerun changes nothing", () =>
    withAgents(async (world) => {
      const old = await finding(world, undefined);
      const card = (await cardOf(world, old)) as CardId;
      const unkeyed = await world.pipeline.unkeyedCards({ size: 50 });
      expect(unkeyed.map((one) => one.card)).toEqual([card]);
      expect(unkeyed[0]?.content?.type).toBe("commitment");
      expect(await world.pipeline.setMatchKey(card, "fact:backfilled")).toBe(true);
      expect(await world.pipeline.setMatchKey(card, "fact:other")).toBe(false);
      expect(await world.pipeline.unkeyedCards({ size: 50 })).toEqual([]);
      await decide(world, [card], "confirm");
      expect(await cardOf(world, await finding(world, "fact:backfilled", { agent: "beta" }))).toBeUndefined();
    }));
});

describe("fewer cards: the owner can reopen, and the owner's latest answer wins", { timeout: DB_TEST_TIMEOUT }, () => {
  it("pi cards reopen raises the held-back card once though the earlier answer stands; the owner's new answer governs the next proposal", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:reopen");
      await decide(world, [(await cardOf(world, first)) as CardId], "confirm");
      const second = await finding(world, "fact:reopen", { agent: "beta" });
      const settled = (await inForce(world, second)) as Settlement;
      expect(settled.answer).toBe("confirmed");
      await world.admin.facts.reopenSettlement(settled.id);
      await expect(world.admin.facts.reopenSettlement(settled.id)).rejects.toMatchObject({ code: "already_reopened" });
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 1 });
      expect(await world.pipeline.raiseSettledClaims()).toEqual({ raised: 0 });
      const reopened = (await cardOf(world, second)) as CardId;
      expect(
        one(await rowsOf<{ match_fp: string }>(world.db, "select match_fp from ledger.cards where id = $1", [reopened]))
          .match_fp,
      ).toBe(fingerprint(world.db.keys, "fact", "fact:reopen"));
      await decide(world, [reopened], "reject");
      expect((await inForce(world, await finding(world, "fact:reopen", { agent: "gamma" })))?.answer).toBe("rejected");
    }));

  it("invariant 11: a reopened card on a fact the owner rejected is open; a new proposal waits on it, not settled rejected, and the owner's new answer reaches it", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:reconsider");
      await decide(world, [(await cardOf(world, first)) as CardId], "reject");
      const second = await finding(world, "fact:reconsider", { agent: "beta" });
      await world.admin.facts.reopenSettlement(((await inForce(world, second)) as Settlement).id);
      await world.pipeline.raiseSettledClaims();
      const open = (await cardOf(world, second)) as CardId;
      const third = await finding(world, "fact:reconsider", { agent: "gamma" });
      expect(await inForce(world, third)).toMatchObject({ card_id: open, answer: "waiting" });
      await decide(world, [open], "confirm");
      expect((await inForce(world, third))?.answer).toBe("confirmed");
    }));

  it("a withdrawn duplicate reopened is undecided again", () =>
    withAgents(async (world) => {
      const a = await legacy(world, "fact:back");
      const b = await legacy(world, "fact:back");
      await decide(world, [a.card], "confirm");
      await world.admin.facts.reopenSettlement(((await inForce(world, b.made)) as Settlement).id);
      expect(await stateOf(world, b.card)).toBe("pending");
      await decide(world, [b.card], "reject");
    }));
});

describe("fewer cards: the report", { timeout: DB_TEST_TIMEOUT }, () => {
  it("pia work report's settled block counts each claim once by the answer in force, the withdrawn and the reopened", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:counted");
      const card = (await cardOf(world, first)) as CardId;
      const waiting = await finding(world, "fact:counted", { agent: "beta" });
      await decide(world, [card], "confirm");
      const settled = await finding(world, "fact:counted", { agent: "gamma" });
      const a = await legacy(world, "fact:twice");
      await legacy(world, "fact:twice");
      await decide(world, [a.card], "reject");
      await world.admin.facts.reopenSettlement(((await inForce(world, settled)) as Settlement).id);
      const report = (await world.admin.work.report(7)).settled;
      expect(report.facts.agent_claim).toEqual({
        confirmed: 2,
        rejected: 0,
        vetoed: 0,
        waiting: 0,
        withdrawn: 1,
        reopened: 1,
      });
      expect(report.facts.about_you).toEqual({
        confirmed: 0,
        rejected: 0,
        vetoed: 0,
        waiting: 0,
        withdrawn: 0,
        reopened: 0,
      });
      expect(report.identity).toEqual({ merged: { contact: 0, phone: 0, name: 0, local_part: 0 }, carded: 0 });
      void waiting;
    }));
});

describe("invariant 6: the label guard", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an answer on a card whose label is not within the new claim's settles nothing: the claim's audience sees what it saw with no earlier card", () =>
    withAgents(async (world) => {
      const wide = await finding(world, "fact:guarded", { agent: "beta", clearance: [...SHARED, "employer:example"] });
      expect(wide.label).toContain("employer:example");
      await decide(world, [(await cardOf(world, wide)) as CardId], "reject");
      const narrow = await finding(world, "fact:guarded", { agent: "alpha" });
      expect(narrow.label).not.toContain("employer:example");
      expect(await cardOf(world, narrow)).toBeDefined();
      expect(await settlements(world, narrow)).toEqual([]);
      // The other way, the guard passes: a card within the wider label settles.
      const wider = await finding(world, "fact:guarded", {
        agent: "gamma",
        clearance: [...SHARED, "employer:example"],
      });
      expect((await inForce(world, wider))?.answer).toBeDefined();
    }));

  it("policy.fact_answer answers the same for two worlds that differ only in a card outside the given compartments", () =>
    withAgents(async (world) => {
      const fp = fingerprint(world.db.keys, "fact", "fact:two-worlds");
      const ask = async () =>
        queryAs(world.db.urls.pipeline, "select settling_card, settled_answer from policy.fact_answer($1, $2)", [
          fp,
          ["own"],
        ]);
      const before = await ask();
      const hidden = await finding(world, "fact:two-worlds", {
        agent: "beta",
        clearance: [...SHARED, "employer:example"],
      });
      expect(await ask()).toEqual(before);
      await decide(world, [(await cardOf(world, hidden)) as CardId], "confirm");
      expect(await ask()).toEqual(before);
      expect(before).toEqual([]);
    }));
});
