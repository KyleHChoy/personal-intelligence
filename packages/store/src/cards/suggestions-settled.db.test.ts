import type { CardId, ClaimRecord, PersonalTool, SuggestionList } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { type AgentWorld, batchOf, claimRecord, rowsOf, withAgents } from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";

// get_suggestions tells an agent which of its own proposals and findings code settled by the
// owner's earlier answer, only where that answer's label is within the agent's clearance
// (invariant 6). Made-up values only.

// Every agent shares every compartment, as the owner set it.
const SHARED = ["own", "agent:alpha", "agent:beta", "agent:gamma"];
const TOOLS: PersonalTool[] = ["get_self", "find_messages", "read_message", "find_facts", "record", "get_suggestions"];

type Made = { record: string; evidence: string };
let n = 0;
async function finding(world: AgentWorld, fact: string, agent: string, clearance: string[] = SHARED): Promise<Made> {
  n += 1;
  const made = await world.record(agent, { body: `Rhea runs on Fridays, statement ${n}.`, clearance });
  const label = one(
    await rowsOf<{ compartments: string[] }>(world.db, "select compartments from vault.evidence_items where id = $1", [
      made.evidence,
    ]),
  ).compartments;
  const claim = {
    ...claimRecord(made.evidence, label, world.owner, { origin: "agent_record", basis: "third_party" }),
    matchKey: fact,
  } as ClaimRecord;
  expect(await world.pipeline.commit(batchOf(made.evidence, [claim], { lane: "agent" }))).toBe("committed");
  return made;
}
const claimKey = (world: AgentWorld, made: Made): string =>
  fingerprint(
    world.db.keys,
    "agent_claim",
    `${made.evidence}\n${fingerprint(world.db.keys, "fact", `fact ${made.evidence} 1`)}`,
  );
const cardOf = async (world: AgentWorld, made: Made): Promise<CardId> =>
  one(
    await rowsOf<{ id: CardId }>(
      world.db,
      "select id from ledger.cards where created_by = 'system:extract' and request_id = $1",
      [claimKey(world, made)],
    ),
  ).id;
const decide = (world: AgentWorld, card: CardId, answer: "confirm" | "reject") =>
  world.admin.cards.decide({ cards: [card], answer, requestId: testId("req").slice(4) });
async function suggestions(
  world: AgentWorld,
  agent: string,
  state: "open" | "closed" | "any" = "closed",
): Promise<SuggestionList> {
  await world.admin.clients.setTools(agent, TOOLS);
  return outcomeValue(await world.reader.getSuggestions(await world.token(agent), { state }));
}

describe("get_suggestions: the agent is told what settled its proposal", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent sees its own finding settled by the owner's earlier confirm, and one settled by the owner's reject", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:told", "alpha");
      await decide(world, await cardOf(world, first), "confirm");
      const told = await finding(world, "fact:told", "beta");
      const rejected = await finding(world, "fact:no", "alpha");
      await decide(world, await cardOf(world, rejected), "reject");
      const again = await finding(world, "fact:no", "beta");
      const listed = await suggestions(world, "beta");
      expect(listed.more).toBe(false);
      expect(listed.items.map((item) => [item.ref, item.what, item.status, item.results]).sort()).toEqual(
        [
          [{ kind: "agent_record", id: told.record }, "finding", "settled_confirmed", []],
          [{ kind: "agent_record", id: again.record }, "finding", "settled_rejected", []],
        ].sort(),
      );
      // A settled record is closed: open lists none.
      expect((await suggestions(world, "beta", "open")).items).toEqual([]);
    }));

  it("another agent's settled finding never appears, nor a claim still waiting", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:mine", "alpha");
      await decide(world, await cardOf(world, first), "confirm");
      const gammas = await finding(world, "fact:mine", "gamma");
      await finding(world, "fact:open", "alpha");
      await finding(world, "fact:open", "beta");
      expect((await suggestions(world, "beta", "any")).items).toEqual([]);
      expect((await suggestions(world, "gamma")).items.map((item) => item.ref.id)).toEqual([gammas.record]);
    }));

  it("told only while it holds: not once the owner reopens it, nor once a veto is in force on the fact; with no state given, every settled record", () =>
    withAgents(async (world) => {
      const first = await finding(world, "fact:holds", "alpha");
      await decide(world, await cardOf(world, first), "confirm");
      const reopened = await finding(world, "fact:holds", "beta");
      const vetoed = await finding(world, "fact:holds", "gamma");
      await world.admin.clients.setTools("beta", TOOLS);
      expect(
        outcomeValue(await world.reader.getSuggestions(await world.token("beta"), {})).items.map((item) => item.ref.id),
      ).toEqual([reopened.record]);
      const [settlement] = await rowsOf<{ id: string }>(
        world.db,
        "select id from ledger.fact_settlements where claim_key = $1",
        [claimKey(world, reopened)],
      );
      await world.admin.facts.reopenSettlement(settlement?.id as never);
      expect((await suggestions(world, "beta")).items).toEqual([]);
      expect((await suggestions(world, "gamma")).items.map((item) => item.ref.id)).toEqual([vetoed.record]);
      const id = testId("rul");
      await rowsOf(
        world.db,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'fact_veto', 0, now(), '{own}')",
        [id, `req-${id.slice(4)}`],
      );
      await rowsOf(
        world.db,
        "insert into knowledge.belief_rulings (ruling_id, verdict, claim_fp, fact_key_fp, created_at, compartments) values ($1, 'veto', $2, $3, now(), '{own}')",
        [id, "0".repeat(64), fingerprint(world.db.keys, "fact", "fact:holds")],
      );
      expect((await suggestions(world, "gamma")).items).toEqual([]);
    }));

  it("invariant 6: an answer whose card is under a label outside the agent's clearance is never told", () =>
    withAgents(async (world) => {
      // A card of the owner's under employer:example, which beta is not cleared for.
      const wide = await finding(world, "fact:wide", "alpha", [...SHARED, "employer:example"]);
      const wideCard = await cardOf(world, wide);
      await decide(world, wideCard, "confirm");
      const narrow = await finding(world, "fact:narrow", "gamma");
      const narrowCard = await cardOf(world, narrow);
      await decide(world, narrowCard, "confirm");
      // Beta's own finding, settled by each card in turn, as only the owner's tables can be made to say.
      const mine = await finding(world, "fact:beta-own", "beta");
      const settle = (card: CardId) =>
        session(world.db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query(
            `insert into ledger.fact_settlements (id, claim_key, card_id, answer, kind, claim_id, evidence_id, match_fp, written_by, created_at, compartments)
             values ($1, $2, $3, 'confirmed', 'agent_claim', $4, $5, $6, 'pipeline', now(), $7)`,
            [
              `fst_${testId("rul").slice(4)}`,
              claimKey(world, mine),
              card,
              fingerprint(world.db.keys, "claim", "x"),
              mine.evidence,
              "a".repeat(64),
              SHARED.slice().sort(),
            ],
          );
        });
      await settle(wideCard);
      expect((await suggestions(world, "beta")).items).toEqual([]);
      // The control: the same record settled by a card within its clearance is told.
      await settle(narrowCard);
      expect((await suggestions(world, "beta")).items.map((item) => item.ref.id)).toEqual([mine.record]);
    }));

  it("a client without the tool, or with it but without the work view, is refused", () =>
    withAgents(async (world) => {
      await finding(world, "fact:refused", "alpha");
      expect(await world.reader.getSuggestions(await world.token("alpha"), { state: "any" })).toEqual({
        ok: false,
        code: "not_permitted",
      });
      const viewless = await world.token("gamma", SHARED, ["self", "people"]);
      await world.admin.clients.setTools("gamma", TOOLS);
      expect(await world.reader.getSuggestions(viewless, { state: "any" })).toEqual({
        ok: false,
        code: "not_permitted",
      });
    }));
});
