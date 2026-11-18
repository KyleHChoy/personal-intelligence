import type { EvidenceId, LocalEntityId } from "@intelligence/contracts";
import { PERSON_PROPOSAL_PIPELINE } from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { releasedClaim } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import { recordBody as canonical, processRecord as process, type Setup, setup } from "./test-support/support.ts";

// A propose_person record in the agent lane, on the memory store. No model is
// ever asked; code builds one claim, or ends it bad_proposal.

function proposal(s: Setup, body: unknown): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  return s.store.putRecord({
    client: "alpha",
    kind: "proposal",
    body: canonical(body),
    recordedAt: at as never,
    cites: [],
  });
}
const claimOf = (s: Setup, id: EvidenceId) => s.store.claims().find((one) => one.evidenceId === id);
const people = (s: Setup): [LocalEntityId, LocalEntityId] => {
  const [a, b] = s.store.entities().people;
  if (a === undefined || b === undefined) throw new Error("the world holds two people");
  return [a, b];
};

describe("a propose_person record in the agent lane", () => {
  it("a person: one known_person claim about the owner, naming no entity, use-only, no model asked", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "person",
      fields: { name: "Dana Reyes", known_how: "rowing club coach", email: "dana@example.org" },
      basis: "The owner said so in chat.",
    });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.requests).toEqual([]);
    const record = claimOf(s, id);
    expect(record).toMatchObject({
      origin: "agent_record",
      subjectKind: "owner",
      disclosure: ["third_party"],
      entities: [],
    });
    expect(record?.claim.content).toEqual({
      type: "known_person",
      subject: OWNER_ENTITY,
      fields: { name: "Dana Reyes", known_how: "rowing club coach", email: "dana@example.org" },
    });
    expect(record?.claim.pipelineVersion).toBe(PERSON_PROPOSAL_PIPELINE);
    expect(record?.claim.label.compartments).toEqual(["agent:alpha", "own"]);
  });

  it("a relationship: an owner_tie of the person, keyed by the person alone, so a new tier is the same fact", async () => {
    const s = await setup();
    const [person] = people(s);
    const inner = proposal(s, {
      kind: "relationship",
      fields: { person, relation: "friend", closeness: "inner" },
      basis: "Texts daily.",
    });
    const dormant = proposal(s, {
      kind: "relationship",
      fields: { person, relation: "friend", closeness: "dormant" },
      basis: "Texts daily.",
    });
    await process(s, inner);
    await process(s, dormant);
    const [a, b] = [claimOf(s, inner), claimOf(s, dormant)];
    expect(a).toMatchObject({ subjectKind: "person", entities: [person], disclosure: ["third_party"] });
    expect(a?.claim.content).toEqual({
      type: "owner_tie",
      subject: person,
      fields: { relation: "friend", closeness: "inner" },
    });
    // Each record's proposal is its own fact until released; released, both take the own key of
    // the person's tie, whatever the closeness.
    const keyOf = (content: NonNullable<typeof a>["claim"]["content"]) => personalFactKey(content, "t", ["own"]);
    expect(keyOf(a!.claim.content)).toBe(keyOf(b!.claim.content));
  });

  it("a link: a connection naming both, a symmetric kind one fact whichever way it is given", async () => {
    const s = await setup();
    const [x, y] = people(s);
    const one = proposal(s, {
      kind: "link",
      fields: { from: x, kind: "friend_of", to: y, inferred: true },
      basis: "Both at the reunion.",
    });
    const two = proposal(s, {
      kind: "link",
      fields: { from: y, kind: "friend_of", to: x, inferred: true },
      basis: "Both at the reunion.",
    });
    const directed = proposal(s, {
      kind: "link",
      fields: { from: y, kind: "introduced", to: x, inferred: false },
      basis: "The intro mail.",
    });
    for (const id of [one, two, directed]) expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    const low = x < y ? x : y;
    const high = x < y ? y : x;
    for (const id of [one, two])
      expect(claimOf(s, id)?.claim.content).toEqual({
        type: "connection",
        subject: low,
        fields: { kind: "friend_of", other: high, inferred: true },
      });
    expect(claimOf(s, directed)?.claim.content).toEqual({
      type: "connection",
      subject: y,
      fields: { kind: "introduced", other: x, inferred: false },
    });
    expect(claimOf(s, one)?.entities).toEqual([low, high]);
    expect(claimOf(s, one)?.fieldKinds).toEqual({ kind: "enum", other: "entity", inferred: "boolean" });
  });

  it("an entity that is not a person now, or a body the intake refuses, is bad_proposal", async () => {
    const s = await setup();
    const [person] = people(s);
    const gone = proposal(s, {
      kind: "relationship",
      fields: { person: "ent_01JZZZZZZZZZZZZZZZZZZZZZZZ", relation: "friend", closeness: "inner" },
      basis: "Texts.",
    });
    const owner = proposal(s, {
      kind: "link",
      fields: { from: OWNER_ENTITY, kind: "advises", to: person, inferred: false },
      basis: "Mail.",
    });
    for (const id of [gone, owner])
      expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    // The store's intake is the one authority; a stored body whose text a stricter rule would
    // refuse is still built, so a confirmed fact stays.
    const pointing = proposal(s, {
      kind: "person",
      fields: { name: "Dana Reyes", known_how: "met him at the club" },
      basis: "Chat.",
    });
    expect(await process(s, pointing)).toMatchObject({ status: "done", claims: 1 });
  });

  it("released, a known person keeps its record's key, and a tie joins the one own fact of its person", async () => {
    const s = await setup();
    const [person] = people(s);
    const known = proposal(s, {
      kind: "person",
      fields: { name: "Dana Reyes", known_how: "rowing club coach" },
      basis: "Chat.",
    });
    const tie = proposal(s, {
      kind: "relationship",
      fields: { person, relation: "mentor", closeness: "active" },
      basis: "Chat.",
    });
    await process(s, known);
    await process(s, tie);
    const ruling = { ruling: "rul_01JABCDEFGHJKMNPQRSTVWXYZ0" as never };
    const record = claimOf(s, known)!;
    const released = releasedClaim(record, ruling, ["agent:alpha", "own"], 4);
    expect(released?.claim.label.compartments).toEqual(["own"]);
    expect(released?.factKey).toBe(record.factKey);
    const tied = claimOf(s, tie)!;
    expect(releasedClaim(tied, ruling, ["agent:alpha", "own"], 4)?.factKey).toBe(
      personalFactKey(tied.claim.content, "t", ["own"]),
    );
    expect(tied.factKey).not.toBe(personalFactKey(tied.claim.content, "t", ["own"]));
    // The record's claim carries that joined key as its alternate key, so a veto on the person's
    // own tie reaches every later proposal of it; a known person carries none.
    expect(tied.legacyAltFactKey).toBe(personalFactKey(tied.claim.content, "t", ["own"]));
    expect(record.legacyAltFactKey).toBeUndefined();
  });
});
