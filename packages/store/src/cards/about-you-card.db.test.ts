import { type CardId, type ClaimRecord, QUOTED_PROPOSAL_PIPELINE } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { asWords } from "../test-support/card-lines.ts";
import { testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  countOf,
  evidenceLabelOf as labelOf,
  proposalRecord,
  rowsOf,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// A proposal about the owner committed by the agent lane, its about_you card and a client-scoped preference's
// client_preference card. A proposal is written as a record and made one by the table's owner before intake,
// as policy.propose_about_you would leave its row, so these tests stand apart from the reader's call.

let written = 0;
function proposal(
  world: AgentWorld,
  scope: "all" | "this_client",
  options: { cites?: string[] } = {},
): Promise<{ record: string; evidence: string }> {
  written += 1;
  const body = JSON.stringify({
    fields: { polarity: "prefers", what: `window seats, number ${written}` },
    kind: "preference",
    quote: `I like window seats, number ${written}`,
    scope,
  });
  return proposalRecord(world, scope, body, `proposal-request-${String(written).padStart(6, "0")}`, options.cites);
}

const proposalClaim = async (world: AgentWorld, evidence: string): Promise<ClaimRecord> =>
  claimRecord(evidence, await labelOf(world, evidence), world.owner, {
    type: "preference",
    origin: "agent_record",
    basis: "third_party",
  });
const cardsOf = (world: AgentWorld, kind: string) =>
  rowsOf<{ id: CardId; request_id: string; target_kind: string; target_id: string; compartments: string[] }>(
    world.db,
    "select id, request_id, target_kind, target_id, compartments from ledger.cards where kind = $1 order by created_at, id",
    [kind],
  );
const keyOf = (world: AgentWorld, evidence: string, factKey: string): string =>
  fingerprint(world.db.keys, "agent_claim", `${evidence}\n${fingerprint(world.db.keys, "fact", factKey)}`);
const decide = (world: AgentWorld, card: CardId, answer: "confirm" | "reject") =>
  world.admin.cards.decide({ cards: [card], answer, requestId: testId("req").slice(4) });
const commitClaims = (
  world: AgentWorld,
  evidence: string,
  claims: ClaimRecord[],
  more: Record<string, unknown> = {},
  generation = 1,
) => world.pipeline.commit(batchOf(evidence, claims, { lane: "agent", generation, ...more }));
const scoped = (world: AgentWorld, evidence: string, generation = 1) =>
  world.pipeline.commit(batchOf(evidence, [], { lane: "agent", status: "skipped", code: "client_scoped", generation }));

// Moves a card this many days into the past, as pi_owner, to stand for time passing.
async function age(world: AgentWorld, card: string, days: number): Promise<void> {
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      "update ledger.record_events set at = at - make_interval(days => $2) where row_kind = 'card' and row_id = $1",
      [card, days],
    );
    await query("alter table ledger.cards no force row level security");
    try {
      await query("update ledger.cards set created_at = created_at - make_interval(days => $2) where id = $1", [
        card,
        days,
      ]);
    } finally {
      await query("alter table ledger.cards force row level security");
    }
  });
}

describe("the about_you card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a scope-all proposal's claim raises one about_you card, its request id the claim key, its target the claim, and no agent_claim card", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      const claim = await proposalClaim(world, made.evidence);
      expect(await commitClaims(world, made.evidence, [claim])).toBe("committed");
      const [card, ...rest] = await cardsOf(world, "about_you");
      expect(rest).toEqual([]);
      expect(card).toMatchObject({
        request_id: keyOf(world, made.evidence, claim.factKey),
        target_kind: "claim",
        target_id: fingerprint(world.db.keys, "claim", claim.claim.id),
        compartments: await labelOf(world, made.evidence),
      });
      expect(await cardsOf(world, "agent_claim")).toEqual([]);
    }));

  it("confirm lets the claim count, reject never, expiry leaves it held", () =>
    withAgents(async (world) => {
      const confirmed = await proposal(world, "all");
      const rejected = await proposal(world, "all");
      const unanswered = await proposal(world, "all");
      for (const made of [confirmed, rejected, unanswered])
        await commitClaims(world, made.evidence, [await proposalClaim(world, made.evidence)]);
      const byKey = new Map((await cardsOf(world, "about_you")).map((card) => [card.request_id, card.id]));
      const cardOf = (made: { evidence: string }) =>
        byKey.get(keyOf(world, made.evidence, `fact ${made.evidence} 1`)) as CardId;
      // Before any answer, none counts.
      expect(await world.pipeline.beliefClaims()).toEqual([]);
      await decide(world, cardOf(confirmed), "confirm");
      await decide(world, cardOf(rejected), "reject");
      await age(world, cardOf(unanswered), 31);
      // The next agent record's commit runs the lane's expiry.
      const next = await proposal(world, "this_client");
      await scoped(world, next.evidence);
      const [expired] = await rowsOf<{ event: string }>(
        world.db,
        "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
        [cardOf(unanswered)],
      );
      expect(expired?.event).toBe("expired");
      const kept = (await world.pipeline.beliefClaims()).flatMap((group) =>
        group.claims.map((one) => one.claim.primaryEvidenceId),
      );
      expect(kept).toEqual([confirmed.evidence]);
      // Held, not removed: the unanswered and the rejected proposal's claims stay stored.
      expect(
        await countOf(world.db, "knowledge.claims", "evidence_id = any ($1)", [
          [rejected.evidence, unanswered.evidence],
        ]),
      ).toBe(2);
    }));

  it("a proposal restating an owner preference from the owner's own mail is marked echo and raises no card", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      const claim = await proposalClaim(world, made.evidence);
      const matched = fingerprint(world.db.keys, "fact", "the owner's own preference");
      await commitClaims(world, made.evidence, [claim], {
        restatements: [{ claimId: claim.claim.id, answer: "echo", reached: "read", matchedFactKeyFp: matched }],
      });
      expect(await cardsOf(world, "about_you")).toEqual([]);
      const [mark] = await rowsOf<{ answer: string }>(
        world.db,
        "select answer from ledger.restatement_checks where claim_key = $1",
        [keyOf(world, made.evidence, claim.factKey)],
      );
      expect(mark?.answer).toBe("echo");
    }));

  it("a retry raises no second card", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      const claim = await proposalClaim(world, made.evidence);
      await commitClaims(world, made.evidence, [claim]);
      await commitClaims(world, made.evidence, [claim]);
      const raised = {
        ...claim,
        claim: { ...claim.claim, id: `${claim.claim.id.slice(0, 60)}0002`, extractorGeneration: 2 },
      } as ClaimRecord;
      await commitClaims(world, made.evidence, [raised], {}, 2);
      expect((await cardsOf(world, "about_you")).length).toBe(1);

      const preference = await proposal(world, "this_client");
      await scoped(world, preference.evidence);
      await scoped(world, preference.evidence, 2);
      expect((await cardsOf(world, "client_preference")).length).toBe(1);
    }));

  it("no agent line is marked code or source, and a quoted proposal's card says in code what confirming does", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      const claim = await proposalClaim(world, made.evidence);
      await commitClaims(world, made.evidence, [
        { ...claim, claim: { ...claim.claim, pipelineVersion: QUOTED_PROPOSAL_PIPELINE } } as ClaimRecord,
      ]);
      const [card] = await cardsOf(world, "about_you");
      const lines = (await world.admin.cards.card(card?.id as CardId))?.lines ?? [];
      // The line it will be stored as, the quote and what confirming does lead.
      expect(lines.slice(0, 3).map((line) => line.from)).toEqual(["agent", "agent", "code"]);
      expect(lines[0]?.text).toBe("Preference: Statement number 1.");
      expect(lines[1]?.text).toMatch(/^you told alpha: I like window seats, number \d+$/);
      expect(lines[2]?.text).toBe("confirming makes this your own fact, shared with every agent cleared for own");
      expect(lines.slice(3, 6).map((line) => line.from)).toEqual(["code", "code", "code"]);
      expect(lines.some((line) => line.from === "source")).toBe(false);
      expect(
        lines.filter((line) => /what:|type:|you told/.test(line.text)).every((line) => line.from === "agent"),
      ).toBe(true);
      // The client is read by the admin from the record's row, never from the agent's words.
      expect(lines.at(-1)).toEqual({
        text: "confirm records the quote as your own words, given through alpha",
        from: "code",
        key: "confirm_records",
        value: [
          { kind: "code", code: "quote" },
          { kind: "text", text: "alpha" },
        ],
      });
    }));
});

describe("the client_preference card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a this_client proposal raises one client_preference card and no claim", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "this_client");
      expect(await scoped(world, made.evidence)).toBe("committed");
      const [card, ...rest] = await cardsOf(world, "client_preference");
      expect(rest).toEqual([]);
      expect(card).toMatchObject({
        request_id: made.record,
        target_kind: "agent_record",
        target_id: made.record,
        compartments: await labelOf(world, made.evidence),
      });
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [made.evidence])).toBe(0);
      expect(await cardsOf(world, "about_you")).toEqual([]);
    }));

  it("the card of a removed record renders record_removed, and a confirm on it is decided", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "this_client");
      await scoped(world, made.evidence);
      const [card] = await cardsOf(world, "client_preference");
      const before = (await world.admin.cards.card(card?.id as CardId))?.lines ?? [];
      expect(
        before
          .filter((line) => /what:|polarity:|the agent says/.test(line.text))
          .every((line) => line.from === "agent"),
      ).toBe(true);
      await world.admin.agents.removeRecord(made.record);
      const after = (await world.admin.cards.card(card?.id as CardId))?.lines ?? [];
      expect(asWords(after).at(-1)).toEqual({ text: "record_removed", from: "code" });
      await decide(world, card?.id as CardId, "confirm");
    }));

  it("a finding's commit with client_scoped raises no client_preference card", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await scoped(world, finding.evidence);
      expect(await cardsOf(world, "client_preference")).toEqual([]);
    }));
});
