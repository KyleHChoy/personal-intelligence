import type { EvidenceId } from "@intelligence/contracts";
import { ClaimRecord } from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, personalFactKey } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { processItem } from "./process-item.ts";
import { QUOTED_PROPOSAL_PIPELINE } from "./proposal.ts";
import { recordBody as canonical, type Setup, setup } from "./test-support/support.ts";

// The owner's confirmation of a proposal releases it. Code makes a second claim from
// the confirmed one, under the owner's own label `own`, keyed so that at fact key version 2 it is
// the same fact as the same statement in the owner's own mail. On the memory store; no model is asked.

const RULING = "rul_01JABCDEFGHJKMNPQRSTVWXYZ0";
const QUOTE = "For trips I always watch the delta flash sales.";
const PREFERENCE = {
  kind: "preference",
  fields: { domain: "travel", object: "delta flash sales", polarity: "prefers" },
  quote: QUOTE,
  scope: "all",
};
const LEGACY = { kind: "situation", fields: { what: "between two jobs" }, scope: "all" };

function proposal(s: Setup, body: unknown, clearance?: string[], kind: "proposal" | "answer" = "proposal"): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  return s.store.putRecord({
    client: "hawk",
    kind,
    body: canonical(body),
    recordedAt: at as never,
    ...(clearance === undefined ? {} : { clearance }),
  });
}

const process = async (s: Setup, id: EvidenceId, generation = KEY_V2_GENERATION) => {
  const due = (await s.store.due(1000, generation)).find((one) => one.evidenceId === id);
  if (due?.source !== "agent_record") throw new Error("not due");
  return processItem(due, { ...s.deps, generation });
};
const claimsOf = (s: Setup, id: EvidenceId) => s.store.claims().filter((one) => one.evidenceId === id);
const releasedOf = (s: Setup, id: EvidenceId) => claimsOf(s, id).filter((one) => one.released !== undefined);
const ownOf = (s: Setup, id: EvidenceId) => claimsOf(s, id).filter((one) => one.released === undefined);

describe("a released proposal", () => {
  it("builds nothing more until the owner's release is in force", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(releasedOf(s, id)).toEqual([]);
  });

  it("beside the record's claim, a new claim: same content, evidence and pipeline version, its own id, labelled own, naming the ruling", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    s.store.ownerRelease(id, RULING);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 2, live: false });
    const [own] = ownOf(s, id);
    const [released] = releasedOf(s, id);
    if (own === undefined || released === undefined) throw new Error("no claims");
    const { evidenceId: _evidence, ...record } = released;
    expect(ClaimRecord.safeParse(record).success).toBe(true);
    expect(own.claim.label.compartments).toEqual(["agent:hawk", "own"]);
    expect(released.claim.label).toEqual({ compartments: ["own"], readers: own.claim.label.readers });
    expect(released.released).toEqual({ ruling: RULING });
    expect(released.claim.id).not.toBe(own.claim.id);
    expect(released.claim.content).toEqual(own.claim.content);
    expect(released.claim.evidence).toEqual(own.claim.evidence);
    expect(released.claim.primaryEvidenceId).toBe(id);
    expect(released.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
    expect(released.origin).toBe("agent_record");
    // The restatement check reads the record's own claim alone.
    expect(s.store.record(id)?.restatements?.map((one) => one.claimId)).toEqual([own.claim.id]);
  });

  it("at fact key version 2 its key is the one the same fact from the owner's own mail takes; the record's is not", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    s.store.ownerRelease(id, RULING);
    await process(s, id);
    const [released] = releasedOf(s, id);
    const [own] = ownOf(s, id);
    const mail = personalFactKey(released?.claim.content as never, "a mail thread", ["own"], undefined, 2);
    expect(released?.factKey).toBe(mail);
    expect(own?.factKey).not.toBe(mail);
    // Its version 1 keys are the record's own, so a ruling made on a version 1 key still reaches
    // it.
    expect(released?.legacyFactKey).toBe(own?.legacyFactKey);
  });

  it("a legacy body keeps its finding's key part, so two released situations stay two facts", async () => {
    const s = await setup();
    const a = proposal(s, LEGACY);
    const b = proposal(s, { ...LEGACY, fields: { what: "on parental leave" } });
    for (const id of [a, b]) {
      s.store.ownerRelease(id, RULING);
      await process(s, id);
    }
    const keys = [...releasedOf(s, a), ...releasedOf(s, b)].map((one) => one.factKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(ownOf(s, a)[0]?.factKey);
  });

  it("a record under any compartment but own and agent ones is never released", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE, ["own", "employer:acme"]);
    s.store.ownerRelease(id, RULING);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(releasedOf(s, id)).toEqual([]);
  });

  it("no body reaches the release: a proposal naming `released` or a label is bad_proposal", async () => {
    const s = await setup();
    for (const extra of [{ released: { ruling: RULING } }, { label: ["own"] }]) {
      const id = proposal(s, { ...PREFERENCE, ...extra });
      expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    }
  });

  it("each claim of the owner's released answer has its released claim", async () => {
    const s = await setup();
    const id = proposal(
      s,
      {
        opportunity: "opp_01JABCDEFGHJKMNPQRSTVWXYZ0",
        question: "What do you plan?",
        quote: "I want to visit the lab in April, and I prefer to meet people in person.",
        facts: [
          { kind: "goal", fields: { domain: "career", objective: "visit the lab in April" } },
          {
            kind: "preference",
            fields: { domain: "relationships", object: "meet people in person", polarity: "prefers" },
          },
        ],
        about: "supports",
      },
      undefined,
      "answer",
    );
    s.store.ownerRelease(id, RULING);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 4 });
    expect(
      releasedOf(s, id)
        .map((one) => one.claim.content.type)
        .sort(),
    ).toEqual(["goal", "preference"]);
  });

  it("train claims: the released claim is made only from a claim that passed the shared key-field check, with its rewrite", async () => {
    const s = await setup();
    const pointer = proposal(s, {
      kind: "goal",
      fields: { domain: "career", objective: "reach out to them" },
      quote: "Remember to reach out to them.",
      scope: "all",
    });
    s.store.ownerRelease(pointer, RULING);
    expect(await process(s, pointer)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    expect(releasedOf(s, pointer)).toEqual([]);
    const negated = proposal(s, {
      kind: "preference",
      fields: { domain: "career", object: "no em dashes", polarity: "prefers" },
      quote: "No em dashes, please.",
      scope: "all",
    });
    s.store.ownerRelease(negated, RULING);
    await process(s, negated);
    expect(releasedOf(s, negated)[0]?.claim.content.fields).toEqual({
      domain: "career",
      object: "em dashes",
      polarity: "avoids",
    });
  });

  it("each commit names the release its run read, or none, refused or built", async () => {
    for (const [released, body] of [
      [undefined, PREFERENCE],
      [RULING, PREFERENCE],
      [RULING, { ...PREFERENCE, fields: { ...PREFERENCE.fields, object: "them" }, quote: "Ask them." }],
    ] as const) {
      const s = await setup();
      const id = proposal(s, body);
      if (released !== undefined) s.store.ownerRelease(id, released);
      const seen: unknown[] = [];
      const commit = s.deps.store.commit.bind(s.deps.store);
      s.deps.store.commit = async (batch) => {
        seen.push(batch.release);
        return commit(batch);
      };
      await process(s, id);
      expect(seen).toEqual([released]);
    }
  });

  it("the belief build counts the released claim in place of the record's own", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    s.store.confirm(id);
    s.store.ownerRelease(id, RULING);
    await process(s, id);
    const given = (await s.store.beliefClaims()).flatMap((group) => group.claims);
    expect(given.map((one) => one.claim.id)).toEqual([releasedOf(s, id)[0]?.claim.id]);
    expect(given[0]?.claim.label.compartments).toEqual(["own"]);
  });
});
