import { type CardId, type ClaimRecord, KEY_FIELDS, type RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  rowsOf,
  cardStateOf as stateOf,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";

// An about-you card's Edit. The owner's confirm with their corrected value: the agent's claim is rejected
// and the owner's value kept as their own words, under the agent fact's whole label, in one transaction;
// nothing of the agent's is released; one lift undoes the confirm and the correction and the card waits
// again; a later proposal of the agent's never outranks the owner's version. Delete is the owner's reject.
// Synthetic words only.

const FIELD = KEY_FIELDS.preference.phrase;
const HIS = "canary-his aisle seats near the front";

let written = 0;
async function proposal(world: AgentWorld): Promise<{ evidence: string }> {
  written += 1;
  const body = JSON.stringify({
    fields: { polarity: "prefers", what: `window seats, number ${written}` },
    kind: "preference",
    quote: `I like window seats, number ${written}`,
    scope: "all",
  });
  const id = outcomeValue(
    await world.reader.record(await world.token("alpha"), {
      kind: "note",
      body: "a proposal to be",
      requestId: `edit-proposal-${String(written).padStart(6, "0")}`,
    }),
  ).recordId;
  const { compartments } = one(
    await queryAs<{ compartments: string[] }>(
      world.db.urls.admin,
      "select compartments from ledger.agent_writes where id = $1",
      [id],
    ),
  );
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("alter table ledger.agent_writes no force row level security");
    try {
      await query(
        "update ledger.agent_writes set kind = 'proposal', tool = 'propose_about_you', proposal_scope = 'all', body_enc = $2, content_fp = $3 where id = $1",
        [
          id,
          sealUnder(world.db.keys, compartments, { table: "ledger.agent_writes", id, column: "body_enc" }, body),
          fingerprint(world.db.keys, "content_hash", sha256Hex(body)),
        ],
      );
    } finally {
      await query("alter table ledger.agent_writes force row level security");
    }
  });
  await world.writer.takeRecords();
  const row = one(
    await queryAs<{ evidence_id: string | null }>(
      world.db.urls.admin,
      "select evidence_id from ledger.agent_writes where id = $1",
      [id],
    ),
  );
  if (row.evidence_id === null) throw new Error("the proposal was not taken in");
  return { evidence: row.evidence_id };
}

// A proposal committed with its claim, and its about_you card.
async function proposed(
  world: AgentWorld,
): Promise<{ evidence: string; claim: ClaimRecord; card: CardId; label: string[] }> {
  const made = await proposal(world);
  const label = one(
    await rowsOf<{ compartments: string[] }>(world.db, "select compartments from vault.evidence_items where id = $1", [
      made.evidence,
    ]),
  ).compartments;
  const claim = claimRecord(made.evidence, label, world.owner, {
    type: "preference",
    origin: "agent_record",
    basis: "third_party",
  });
  expect(await world.pipeline.commit(batchOf(made.evidence, [claim], { lane: "agent" }))).toBe("committed");
  const [card] = await rowsOf<{ id: CardId }>(
    world.db,
    "select id from ledger.cards where kind = 'about_you' and target_id = $1",
    [fingerprint(world.db.keys, "claim", claim.claim.id)],
  );
  return { ...made, claim, card: card?.id as CardId, label };
}

// The claims given to the build, by their evidence's source kind.
const built = async (world: AgentWorld): Promise<{ kind: string; evidence: string; label: string[] }[]> => {
  const claims = (await world.pipeline.beliefClaims()).flatMap((group) => group.claims.map((x) => x.claim));
  const rows = await rowsOf<{ id: string; source_kind: string }>(
    world.db,
    "select id, source_kind from vault.evidence_items where id = any ($1)",
    [claims.map((x) => x.primaryEvidenceId)],
  );
  return claims.map((x) => ({
    kind: rows.find((row) => row.id === x.primaryEvidenceId)?.source_kind ?? "",
    evidence: x.primaryEvidenceId,
    label: x.label.compartments,
  }));
};

describe("about-you Edit", { timeout: DB_TEST_TIMEOUT }, () => {
  it("keeps the owner's corrected words under the agent fact's label, releases nothing, and one lift undoes both", () =>
    withAgents(async (world) => {
      const first = await proposed(world);
      const [answer] = await world.admin.cards.decide({
        cards: [first.card],
        answer: "confirm",
        correct: { [FIELD]: HIS },
        requestId: testId("req").slice(4),
      });
      expect(await stateOf(world, first.card)).toBe("decided");
      // Nothing of the agent's is released; its claim is rejected; the owner's claim is an owner_command
      // claim under the agent fact's whole label, given to the build.
      expect(await rowsOf(world.db, "select ruling_id from knowledge.claim_releases")).toEqual([]);
      expect(
        await rowsOf(world.db, "select verdict, lifted_at is null as standing from knowledge.belief_rulings"),
      ).toEqual([{ verdict: "reject", standing: true }]);
      const after = await built(world);
      expect(after.filter((x) => x.evidence === first.evidence)).toEqual([]);
      expect(after.filter((x) => x.kind === "owner_command")).toEqual([
        expect.objectContaining({ label: first.label }),
      ]);
      // The owner's words reach no decision row.
      expect(JSON.stringify(await rowsOf(world.db, "select * from knowledge.owner_decisions"))).not.toContain(
        "canary-his",
      );

      // A later proposal of the agent's, even confirmed, never takes the owner's version's place.
      const later = await proposed(world);
      await world.admin.cards.decide({ cards: [later.card], answer: "confirm", requestId: testId("req").slice(4) });
      const both = await built(world);
      expect(both.filter((x) => x.kind === "owner_command")).toHaveLength(1);
      expect(both.filter((x) => x.evidence === first.evidence)).toEqual([]);

      // One lift: the confirm and the correction, and the card waits for the owner again.
      expect(
        await world.admin.facts.liftRuling(answer?.ruling as RulingId, { requestId: testId("req").slice(4) }),
      ).toBe(true);
      expect(await stateOf(world, first.card)).toBe("pending");
      const lifted = await built(world);
      expect(lifted.filter((x) => x.kind === "owner_command")).toEqual([]);
      expect(
        await rowsOf(
          world.db,
          "select verdict, lifted_at is null as standing from knowledge.belief_rulings order by created_at",
        ),
      ).toEqual([
        { verdict: "reject", standing: false },
        { verdict: "reject", standing: true },
      ]);
    }));

  it("lifting the correction alone lifts the confirm too: the agent's words never stand as the owner's", () =>
    withAgents(async (world) => {
      const first = await proposed(world);
      await world.admin.cards.decide({
        cards: [first.card],
        answer: "confirm",
        correct: { [FIELD]: HIS },
        requestId: testId("req").slice(4),
      });
      const [correction] = await rowsOf<{ ruling_id: RulingId }>(
        world.db,
        "select ruling_id from knowledge.belief_rulings where verdict = 'reject' and lifted_at is null",
      );
      expect(
        await world.admin.facts.liftRuling(correction?.ruling_id as RulingId, { requestId: testId("req").slice(4) }),
      ).toBe(true);
      expect(await stateOf(world, first.card)).toBe("pending");
      const after = await built(world);
      expect(after.filter((x) => x.evidence === first.evidence)).toEqual([]);
      expect(after.filter((x) => x.kind === "owner_command")).toEqual([]);
      expect(
        await rowsOf(world.db, "select kind from knowledge.owner_decisions where kind = 'confirmation_lift'"),
      ).toEqual([{ kind: "confirmation_lift" }]);
    }));

  it("refuses a correction on another kind, with another answer, or in a value its field refuses, and writes nothing", () =>
    withAgents(async (world) => {
      const first = await proposed(world);
      await expect(
        world.admin.cards.decide({
          cards: [first.card],
          answer: "reject",
          correct: { [FIELD]: HIS },
          requestId: testId("req").slice(4),
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        world.admin.cards.decide({
          cards: [first.card],
          answer: "confirm",
          correct: { nothing: HIS },
          requestId: testId("req").slice(4),
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        world.admin.cards.decide({
          cards: [first.card],
          answer: "confirm",
          correct: { [FIELD]: "   " },
          requestId: testId("req").slice(4),
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await stateOf(world, first.card)).toBe("pending");
      expect(await rowsOf(world.db, "select ruling_id from knowledge.belief_rulings")).toEqual([]);
      // Delete is the owner's reject: nothing counts.
      await world.admin.cards.decide({ cards: [first.card], answer: "reject", requestId: testId("req").slice(4) });
      expect((await built(world)).filter((x) => x.evidence === first.evidence)).toEqual([]);
    }));
});
