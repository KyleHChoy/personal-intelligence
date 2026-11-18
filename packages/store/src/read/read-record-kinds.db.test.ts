import { type CardId, type ClaimRecord, RecordRead } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { ALL_VIEWS, testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  evidenceLabelOf as labelOf,
  proposalRecord,
  rowsOf,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { insertPerson } from "../test-support/send-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";

// read_record opens a record of a kind other than the five agent records (a proposal here) only
// when a fact the caller may see rests on it, by find_facts' own rule; one no visible fact rests on
// answers not_found, as an unknown id does, and a fact the caller may not see, one naming a person
// it does not see, opens nothing (invariant 6). A proposal is written as a record and made one by the table's owner
// before intake, as policy.propose_about_you would leave its row. Made-up values only.

let written = 0;
function proposal(world: AgentWorld, scope: "all" | "this_client"): Promise<{ record: string; evidence: string }> {
  written += 1;
  const body = JSON.stringify({
    fields: { polarity: "prefers", what: `aisle seats, number ${written}` },
    kind: "preference",
    quote: `I like aisle seats, number ${written}`,
    scope,
  });
  return proposalRecord(world, scope, body, `kinds-request-${String(written).padStart(6, "0")}`);
}

// The proposal's claim, under its evidence's label and naming `entities`, committed by the agent
// lane, and its about_you card confirmed so that the claim counts.
async function confirmedClaim(
  world: AgentWorld,
  evidence: string,
  label: string[],
  entities: string[] = [],
): Promise<void> {
  const claim: ClaimRecord = claimRecord(evidence, label, world.owner, {
    type: "preference",
    origin: "agent_record",
    basis: "third_party",
    entities,
  });
  expect(await world.pipeline.commit(batchOf(evidence, [claim], { lane: "agent", generation: 1 }))).toBe("committed");
  const key = fingerprint(
    world.db.keys,
    "agent_claim",
    `${evidence}\n${fingerprint(world.db.keys, "fact", claim.factKey)}`,
  );
  const [card] = await rowsOf<{ id: CardId }>(
    world.db,
    "select id from ledger.cards where kind = 'about_you' and request_id = $1",
    [key],
  );
  if (card === undefined) throw new Error("no about_you card");
  await world.admin.cards.decide({ cards: [card.id], answer: "confirm", requestId: testId("req").slice(4) });
}

// A reader registered for read_record and find_facts under `clearance`, with every view.
async function readerToken(world: AgentWorld, name: string, clearance: string[]): Promise<string> {
  const { token } = await world.admin.clients.addClient(
    registration(name, clearance, { tools: ["read_record", "find_facts"], views: ALL_VIEWS as never }),
  );
  return token;
}

const recordLabel = async (world: AgentWorld, record: string): Promise<string[]> =>
  one(
    await queryAs<{ compartments: string[] }>(
      world.db.urls.admin,
      "select compartments from ledger.agent_writes where id = $1",
      [record],
    ),
  ).compartments;

describe("read_record of a record another kind", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a proposal a visible fact rests on is read whole, its body untrusted", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      await confirmedClaim(world, made.evidence, await labelOf(world, made.evidence));
      const token = await readerToken(world, "kinds-reader", await recordLabel(world, made.record));
      const read = RecordRead.parse(
        outcomeValue(await world.reader.readRecord(token, { record: made.record as never })),
      );
      expect(read).toMatchObject({ id: made.record, kind: "proposal", removed: false });
      expect(read.body?.untrusted).toContain("aisle seats");
    }));

  it("a proposal no visible fact rests on answers not_found, as an unknown id does", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "this_client");
      await world.pipeline.commit(
        batchOf(made.evidence, [], { lane: "agent", status: "skipped", code: "client_scoped", generation: 1 }),
      );
      const token = await readerToken(world, "kinds-reader", await recordLabel(world, made.record));
      const unknown = await world.reader.readRecord(token, { record: testId("rec") as never });
      expect(unknown).toEqual({ ok: false, code: "not_found" });
      expect(await world.reader.readRecord(token, { record: made.record as never })).toEqual(unknown);
    }));

  // A claim's label is its evidence's (knowledge.claims_label), so a caller that sees the record sees
  // the label of every claim on it; what hides such a fact is a person it names whom the caller does
  // not see, here one known only from an address under employer:example.
  it("a fact naming a person the caller does not see opens nothing, as a missing record; the control, who sees the person, reads it", () =>
    withAgents(async (world) => {
      const made = await proposal(world, "all");
      const label = await recordLabel(world, made.record);
      const person = await insertPerson(
        { db: world.db, admin: (text, values) => queryAs(world.db.urls.admin, text, values) },
        "kinds-colleague@example.com",
        ["employer:example"],
      );
      await confirmedClaim(world, made.evidence, await labelOf(world, made.evidence), [person]);
      const narrow = await readerToken(
        world,
        "kinds-narrow",
        label.filter((one) => one !== "employer:example"),
      );
      const unknown = await world.reader.readRecord(narrow, { record: testId("rec") as never });
      expect(unknown).toEqual({ ok: false, code: "not_found" });
      expect(await world.reader.readRecord(narrow, { record: made.record as never })).toEqual(unknown);
      const cleared = await readerToken(world, "kinds-wide", [...new Set([...label, "employer:example"])]);
      expect(outcomeValue(await world.reader.readRecord(cleared, { record: made.record as never }))).toMatchObject({
        id: made.record,
        kind: "proposal",
      });
    }));
});
