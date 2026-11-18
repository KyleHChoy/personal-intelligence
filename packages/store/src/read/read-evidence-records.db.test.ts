import type { ClaimRecord, PersonalView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { ALL_VIEWS } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  evidenceLabelOf as labelOf,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { Reader } from "./read.ts";

// get_evidence_span for a finding's fact. Its source is the agent record the finding was taken in
// from, which the caller's token returns only when the record's row policy does (the whole label,
// the writer's views, no flag): the same test find_facts' second branch makes. A fact the caller
// cannot see answers not_found with the statements an absent id sends.

const BODY = "Rhea will send the owner the plans by Friday.";
const NOT_FOUND = { ok: false, code: "not_found" };

// A finding's claim citing `span` of its record's body, committed as the agent lane commits one.
async function findingFact(
  world: AgentWorld,
  span: string,
): Promise<{ fact: string; record: string; label: string[] }> {
  const { record, evidence } = await world.record("alpha", { body: BODY });
  const label = await labelOf(world, evidence);
  const made = claimRecord(evidence, label, world.owner, {
    origin: "agent_record",
    basis: "third_party",
    factKey: "k-finding-span",
  });
  const claim = { ...made, claim: { ...made.claim, evidence: [{ evidenceId: evidence, span }] } } as ClaimRecord;
  expect(await world.pipeline.commit(batchOf(evidence, [claim], { lane: "agent" }))).toBe("committed");
  // The fact's id is the stored claim id, the claim id's `claim` fingerprint.
  return { fact: fingerprint(world.db.keys, "claim", claim.claim.id), record, label };
}

async function spanClient(
  world: AgentWorld,
  name: string,
  clearance: string[],
  views: PersonalView[] = ALL_VIEWS as PersonalView[],
): Promise<{ token: string; id: string }> {
  const { token } = await world.admin.clients.addClient(
    registration(name, clearance, { tools: ["get_evidence_span"], views }),
  );
  const id = (await world.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id };
}

describe("get_evidence_span for a finding's fact", { timeout: DB_TEST_TIMEOUT }, () => {
  it("serves the agent record's body as the passage, shows the record and binds nothing", () =>
    withAgents(async (world) => {
      const { fact, record, label } = await findingFact(world, "chars:0-4");
      const reader = await spanClient(world, "span-reader", label);
      const value = outcomeValue(await world.reader.getEvidenceSpan(reader.token, { fact: fact as never }));
      expect(value).toEqual({
        fact,
        source: { kind: "record", id: record },
        passage: { untrusted: BODY },
        chars: BODY.length,
        cut: false,
      });
      // No bound entry is ever an agent record's: the record is shown.
      expect(
        await queryAs(
          world.db.urls.admin,
          "select tool, bound, shown, cardinality(fact_key_fps) as keys from ledger.read_log where client_id = $1",
          [reader.id],
        ),
      ).toEqual([{ tool: "get_evidence_span", bound: [], shown: [record], keys: 1 }]);
      expect(
        await queryAs(
          world.db.urls.admin,
          "select outcome, rows, chars::int as chars from policy.calls where client_id = $1",
          [reader.id],
        ),
      ).toEqual([{ outcome: "ok", rows: 1, chars: BODY.length }]);
    }));

  it("a client the record's row policy hides it from gets not_found, with an absent id's statements", () =>
    withAgents(async (world) => {
      const { fact, record, label } = await findingFact(world, "chars:0-4");
      // The positive control: cleared for the whole label, with every view, it is served.
      const cleared = await spanClient(world, "span-cleared", label);
      expect((await world.reader.getEvidenceSpan(cleared.token, { fact: fact as never })).ok).toBe(true);
      // Short of the agent compartment; and short of the writer's work view.
      const outside = await spanClient(
        world,
        "span-outside",
        label.filter((one) => !one.startsWith("agent:")),
      );
      const narrow = await spanClient(world, "span-narrow", label, ["self", "people"]);
      const recorded = recordingPool(world.store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: world.db.keys, log: world.store.log });
      const statementsOf = async (token: string, id: string): Promise<{ answer: unknown; statements: string[] }> => {
        recorded.statements.length = 0;
        const answer = await reader.getEvidenceSpan(token, { fact: id as never });
        return { answer, statements: [...recorded.statements] };
      };
      const absent = await statementsOf(outside.token, "f".repeat(64));
      expect(absent.answer).toEqual(NOT_FOUND);
      for (const token of [outside.token, narrow.token]) {
        const hidden = await statementsOf(token, fact);
        expect(hidden.answer).toEqual(NOT_FOUND);
        expect(hidden.statements).toEqual(absent.statements);
      }
      // A flagged record is hidden too. The pipeline is the one role that sets a flag.
      await queryAs(world.db.urls.pipeline, "update ledger.agent_writes set flagged_at = now() where id = $1", [
        record,
      ]);
      expect(await world.reader.getEvidenceSpan(cleared.token, { fact: fact as never })).toEqual(NOT_FOUND);
    }));
});
