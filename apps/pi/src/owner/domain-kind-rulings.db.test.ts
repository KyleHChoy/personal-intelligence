import type { Claim } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type CardId,
  type ClaimRecord,
  type ExtractionCommit,
  type FactId,
  type PersonalTool,
  type PersonalView,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { EXTRACT_GENERATION, type ExtractDeps, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  fingerprint,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { batchOf, claimRecord, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts", "record", "propose_about_you"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const BEFORE = "2026-09-01T09:00:00.000Z";

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let token: string;
let owner: string;
let own: string[];
let work: string;
const captured: ExtractionCommit[] = [];
let request = 0;
const requestId = (): string => `domain-kind-rulings-${String((request += 1)).padStart(6, "0")}`;

const deps = (now = new Date()): ExtractDeps => ({
  store: {
    ...pipeline,
    commit: (batch) => {
      captured.push(batch);
      return pipeline.commit(batch);
    },
  },
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => now,
  generation: EXTRACT_GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const fp = (factKey: string): string => fingerprint(keys, "fact", factKey);
const factId = (record: ClaimRecord): FactId => fingerprint(keys, "claim", record.claim.id) as FactId;

type Shape = {
  n: number;
  type?: string;
  fields: Record<string, unknown>;
  factKey: string;
  legacy?: string;
  legacyAlt?: string;
  validFrom?: string;
  generation?: number;
  compartment?: string;
};

// One claim about the owner in their own words, on a stored item, as a commit would hand it.
function claim(evidenceId: string, shape: Shape): ClaimRecord {
  const base = claimRecord(evidenceId, shape.compartment ?? "own", owner, {
    n: shape.n,
    type: shape.type ?? "situation",
    factKey: shape.factKey,
    validFrom: shape.validFrom ?? BEFORE,
  });
  const generation = shape.generation ?? 4;
  return {
    ...base,
    claim: {
      ...base.claim,
      id: sha256(`k2c ${evidenceId} ${shape.n} ${generation}`),
      assertedBy: owner,
      extractorGeneration: generation,
      content: { ...base.claim.content, fields: shape.fields },
    } as Claim,
    fieldKinds: Object.fromEntries(
      Object.keys(shape.fields).map((name) => [name, name === "domain" || name === "polarity" ? "enum" : "text"]),
    ),
    ...(shape.legacy === undefined ? {} : { legacyFactKey: shape.legacy }),
    ...(shape.legacyAlt === undefined ? {} : { legacyAltFactKey: shape.legacyAlt }),
  } as ClaimRecord;
}
const commit = async (evidenceId: string, records: ClaimRecord[], generation = 4): Promise<void> => {
  expect(await pipeline.commit(batchOf(evidenceId, records, { generation }))).toBe("committed");
};
// The belief of a fact key computed for the owner's audience as of the database's clock, or undefined.
async function ownerBelief(factKey: string) {
  const audience = (await pipeline.ownerAudience()).join();
  return (await pipeline.sweepBeliefs(BELIEF_TYPES))
    .find((one) => one.audience.join() === audience)
    ?.records.find((record) => record.factKeyFp === fp(factKey))?.belief;
}
async function served(kind: "situation" | "goal" | "need" | "preference") {
  const answer = await reader.getBeliefs(token, { kind, state: "any" });
  if (!answer.ok) throw new Error(`get_beliefs answered ${answer.code}`);
  return answer.value.beliefs;
}

beforeAll(async () => {
  s = await syncedWorld();
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:alpha");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  owner = (await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";
  // Not bulk: `pi self review` lists no claim from bulk mail, and evidence ids are keyed
  // fingerprints, so which messages come first changes from run to run.
  own = (
    await rows<{ evidence_id: string }>(
      "select evidence_id from knowledge.messages where compartments = '{own}' and not held and bulk is not true order by evidence_id limit 8",
    )
  ).map((row) => row.evidence_id);
  work =
    (
      await rows<{ evidence_id: string }>(
        "select evidence_id from knowledge.messages where compartments = '{employer:example}' and not held and bulk is not true order by evidence_id limit 1",
      )
    )[0]?.evidence_id ?? "";
  expect(own).toHaveLength(8);
  expect(work).not.toBe("");
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the owner's domain and kind rulings", () => {
  it("a domain ruling moves a fact, holds at every read, and its lift restores it; a kind ruling builds it as the new kind", async () => {
    const flat = claim(own[0] ?? "", { n: 1, fields: { state: "moving flat", domain: "home" }, factKey: "k2c flat" });
    const sail = claim(own[0] ?? "", {
      n: 2,
      type: "goal",
      fields: { objective: "learn to sail", domain: "interests" },
      factKey: "k2c sail",
    });
    await commit(own[0] ?? "", [flat, sail]);
    expect((await ownerBelief("k2c flat"))?.values).toMatchObject({ domain: "home" });

    const domain = await admin.facts.reclassifyFact(factId(flat), "domain", "money", { requestId: requestId() });
    await admin.facts.reclassifyFact(factId(sail), "kind", "need", { requestId: requestId() });
    // The value is sealed: no row holds the word in clear.
    expect(await rows("select 1 from knowledge.belief_rulings where value_enc::text like '%money%'")).toEqual([]);
    expect((await ownerBelief("k2c flat"))?.values).toMatchObject({ domain: "money" });
    expect(await ownerBelief("k2c sail")).toMatchObject({
      kind: "need",
      type: "need",
      values: { domain: "interests" },
    });
    // The client sees the need, not the goal.
    expect((await served("need")).some((belief) => belief.fact === fp("k2c sail"))).toBe(true);
    expect((await served("goal")).some((belief) => belief.fact === fp("k2c sail"))).toBe(false);

    // A value off the list and a kind that is not owner-side are refused.
    await expect(
      admin.facts.reclassifyFact(factId(flat), "domain", "hobbies", { requestId: requestId() }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      admin.facts.reclassifyFact(factId(flat), "kind", "commitment", { requestId: requestId() }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    // `pi correct list` lists it, with no value.
    const listed = (await admin.facts.listRulings()).find((one) => one.id === domain);
    expect(listed).toMatchObject({ verdict: "domain", claimGone: false });
    expect(JSON.stringify(listed)).not.toContain("money");

    // R-W1: a second domain replaces the one in force, in one decision that supersedes it and lifts
    // it, and the beliefs use the new one.
    const decisions = async (): Promise<number> =>
      Number((await rows("select count(*)::int as n from knowledge.owner_decisions"))[0]?.n);
    const before = await decisions();
    const replaced = await admin.facts.reclassifyFact(factId(flat), "domain", "career", { requestId: requestId() });
    expect(await decisions()).toBe(before + 1);
    expect(await rows("select supersedes from knowledge.owner_decisions where id = $1", [replaced])).toEqual([
      { supersedes: domain },
    ]);
    expect(await rows("select lift_ruling_id from knowledge.belief_rulings where ruling_id = $1", [domain])).toEqual([
      { lift_ruling_id: replaced },
    ]);
    expect(
      (await admin.facts.listRulings())
        .filter((one) => one.verdict === "domain" && one.liftedAt === null)
        .map((one) => one.id),
    ).toEqual([replaced]);
    // The same value again is the ruling in force, and writes nothing.
    expect(await admin.facts.reclassifyFact(factId(flat), "domain", "career", { requestId: requestId() })).toBe(
      replaced,
    );
    expect(await decisions()).toBe(before + 1);
    // A kind replaces as a domain does.
    await admin.facts.reclassifyFact(factId(sail), "kind", "capability", { requestId: requestId() });
    expect((await ownerBelief("k2c flat"))?.values).toMatchObject({ domain: "career" });
    expect(await ownerBelief("k2c sail")).toMatchObject({ kind: "capability" });
    // A veto in force is still `already_ruled`: only a domain or a kind replaces.
    const veto = await admin.facts.vetoFact(factId(sail), { requestId: requestId() });
    await expect(admin.facts.vetoFact(factId(sail), { requestId: requestId() })).rejects.toMatchObject({
      code: "already_ruled",
    });
    expect(await admin.facts.liftRuling(veto, { requestId: requestId() })).toBe(true);

    // The page's undo, a lift, restores the claim's own domain.
    expect(await admin.facts.liftRuling(replaced, { requestId: requestId() })).toBe(true);
    expect((await ownerBelief("k2c flat"))?.values).toMatchObject({ domain: "home" });
  });

  it("invariant 6: a domain ruling whose compartments the client cannot see changes nothing it is served; one it can see does", async () => {
    // Fact key `k2c hidden` has a claim in each mailbox, so its ruling's label holds employer:example.
    await commit(own[1] ?? "", [
      claim(own[1] ?? "", { n: 1, fields: { state: "renovating kitchen", domain: "home" }, factKey: "k2c hidden" }),
    ]);
    const workClaim = claim(work, {
      n: 1,
      fields: { state: "renovating kitchen", domain: "home" },
      factKey: "k2c hidden",
      compartment: "employer:example",
    });
    await commit(work, [workClaim]);
    const seenClaim = claim(own[2] ?? "", {
      n: 1,
      fields: { state: "learning piano", domain: "interests" },
      factKey: "k2c seen",
    });
    await commit(own[2] ?? "", [seenClaim]);
    const before = await served("situation");
    const hidden = before.find((belief) => belief.fact === fp("k2c hidden"));
    expect(hidden).toBeDefined();

    await admin.facts.reclassifyFact(factId(workClaim), "domain", "money", { requestId: requestId() });
    await admin.facts.reclassifyFact(factId(seenClaim), "domain", "education", { requestId: requestId() });
    const after = await served("situation");
    expect(after.find((belief) => belief.fact === fp("k2c hidden"))).toEqual(hidden);
    // The control: the ruling the client may read changes what it is served.
    const seen = after.find((belief) => belief.fact === fp("k2c seen"));
    expect(seen?.values).toMatchObject({ domain: "education" });
    expect(seen?.state).not.toBe(before.find((belief) => belief.fact === fp("k2c seen"))?.state);
  });
});

describe("rulings made before the go, carried by their version 1 key", () => {
  let retire: string;
  let veto: string;
  let reject: string;

  beforeAll(async () => {
    const [m3, m4, m5, m6, m7] = own.slice(3);
    // Version 1: one message's situation sentence under the coarse key every situation of the
    // owner shares, a `likes` preference, and a claim the owner rejects.
    const coarse = claim(m3 ?? "", {
      n: 1,
      fields: { what: "moving flat and changing jobs" },
      factKey: "k2c v1 situations",
    });
    const likes = claim(m4 ?? "", {
      n: 1,
      type: "preference",
      fields: { what: "green tea", polarity: "likes" },
      factKey: "k2c v1 likes tea",
    });
    const rejected = claim(m5 ?? "", {
      n: 1,
      type: "goal",
      fields: { what: "ship the survey" },
      factKey: "k2c v1 survey",
    });
    await commit(m3 ?? "", [coarse]);
    await commit(m4 ?? "", [likes]);
    await commit(m5 ?? "", [rejected]);
    // No belief is built first: a veto or a retire records the items of its key's claims.
    retire = await admin.facts.retireFact(factId(coarse), { requestId: requestId() });
    veto = await admin.facts.vetoFact(factId(likes), { requestId: requestId() });
    reject = await admin.facts.rejectClaim(factId(rejected), { requestId: requestId() });

    // The go: each item re-extracted at generation 5, every claim keyed at version 2 with its
    // version 1 keys beside it. A claim of another message under the same coarse key, and claims
    // stated after the go, are no claims the owner ruled on.
    const after = new Date(Date.now() + 5_000).toISOString();
    await commit(
      m3 ?? "",
      [
        claim(m3 ?? "", {
          n: 1,
          generation: 5,
          fields: { state: "moving flat", domain: "home" },
          factKey: "k2c v2 flat",
          legacy: "k2c v1 situations",
        }),
        claim(m3 ?? "", {
          n: 2,
          generation: 5,
          fields: { state: "changing jobs", domain: "career" },
          factKey: "k2c v2 jobs",
          legacy: "k2c v1 situations",
        }),
      ],
      5,
    );
    await commit(
      m6 ?? "",
      [
        claim(m6 ?? "", {
          n: 1,
          generation: 5,
          fields: { state: "renewing visa", domain: "travel" },
          factKey: "k2c v2 visa",
          legacy: "k2c v1 situations",
        }),
      ],
      5,
    );
    const tea = { object: "green tea", polarity: "prefers", domain: "interests" };
    await commit(
      m4 ?? "",
      [
        claim(m4 ?? "", {
          n: 1,
          generation: 5,
          type: "preference",
          fields: tea,
          factKey: "k2c v2 tea",
          legacy: "k2c v1 prefers tea",
          legacyAlt: "k2c v1 likes tea",
        }),
        claim(m4 ?? "", {
          n: 2,
          generation: 5,
          type: "preference",
          fields: tea,
          factKey: "k2c v2 tea",
          legacy: "k2c v1 prefers tea",
          legacyAlt: "k2c v1 likes tea",
          validFrom: after,
        }),
      ],
      5,
    );
    const survey = { objective: "ship the survey", domain: "career" };
    await commit(
      m5 ?? "",
      [
        claim(m5 ?? "", {
          n: 1,
          generation: 5,
          type: "goal",
          fields: survey,
          factKey: "k2c v2 survey",
          legacy: "k2c v1 survey",
        }),
      ],
      5,
    );
    await commit(
      m7 ?? "",
      [
        claim(m7 ?? "", {
          n: 1,
          generation: 5,
          type: "goal",
          fields: survey,
          factKey: "k2c v2 survey",
          legacy: "k2c v1 survey",
        }),
      ],
      5,
    );
    // Read once `after` has passed: every claim stated after the go is true by then.
    const wait = Date.parse(after) + 1_000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  });

  it("a carried retire leaves out the claims of the item the owner ruled on, and not a situation of another message under the same coarse key", async () => {
    expect(await ownerBelief("k2c v2 flat")).toBeUndefined();
    expect(await ownerBelief("k2c v2 jobs")).toBeUndefined();
    expect((await ownerBelief("k2c v2 visa"))?.status).toBe("active");
  });

  it("invariant 11: the owner's version 1 `likes` veto still holds after re-extraction, for the `prefers` fact, and nothing stated after the go", async () => {
    const tea = await ownerBelief("k2c v2 tea");
    const [, second] = (
      await rows<{ id: string }>("select id from knowledge.claims where fact_key_fp = $1 order by valid_from", [
        fp("k2c v2 tea"),
      ])
    ).map((row) => row.id);
    expect(tea?.support).toHaveLength(1);
    expect(tea?.support[0] === undefined ? undefined : fingerprint(keys, "claim", tea.support[0])).toBe(second);
  });

  it("a carried reject holds for its item's re-extracted claim, and not for another item's claim of the same version 1 key", async () => {
    const survey = await ownerBelief("k2c v2 survey");
    expect(survey?.support).toHaveLength(1);
    const [kept] = await rows<{ evidence_id: string }>("select evidence_id from knowledge.claims where id = $1", [
      fingerprint(keys, "claim", survey?.support[0] ?? ""),
    ]);
    expect(kept?.evidence_id).toBe(own[7]);
  });

  it("`pi correct list` marks each ruling carried, not gone; `pi self review` shows the carried rulings, tiers and domains", async () => {
    const listed = await admin.facts.listRulings();
    for (const id of [retire, veto, reject])
      expect(
        listed.find((one) => one.id === id),
        id,
      ).toMatchObject({ claimGone: false, carried: true });
    const review = await admin.self.review();
    const loose = review.filter((row) => row.carried.includes(retire as never));
    expect(loose.length).toBe(2);
    expect(loose.every((row) => row.tier === null && row.domain !== null)).toBe(true);
    const visa = review.find((row) => row.factKey === fp("k2c v2 visa"));
    expect(visa).toMatchObject({ tier: "owner", domain: "travel", carried: [] });
  });

  it("the go is the first claim with a version 1 key beside its own", async () => {
    const { goAt } = await pipeline.beliefDecisions();
    expect(goAt).not.toBeNull();
  });
});

describe("a confirmation carried by its version 1 claim key", () => {
  it("confirms only its own record's re-keyed claim", async () => {
    const PROPOSALS = [
      { kind: "goal", fields: { domain: "health", objective: "run a half marathon" } },
      { kind: "goal", fields: { domain: "interests", objective: "learn to row" } },
    ] as const;
    for (const one of PROPOSALS) {
      const made = await reader.proposeAboutYou(token, { ...one, scope: "all", requestId: requestId() } as never);
      if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
    }
    const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
    try {
      await writer.takeRecords();
    } finally {
      await writer.close();
    }
    captured.length = 0;
    const due = (await pipeline.due(1000, EXTRACT_GENERATION)).filter((one) => one.source === "agent_record");
    expect(due).toHaveLength(PROPOSALS.length);
    for (const one of due) expect(await processItem(one, deps())).toMatchObject({ status: "done", claims: 1 });
    const records = captured.flatMap((batch) =>
      batch.claims.map((record) => ({ evidenceId: batch.evidenceId, record })),
    );
    const [first, second] = records;
    if (first === undefined || second === undefined) throw new Error("no records");
    const [card] = await rows<{ id: CardId }>(
      "select id from ledger.cards where kind = 'about_you' and target_kind = 'claim' and target_id = $1",
      [factId(first.record)],
    );
    if (card === undefined) throw new Error("no card");
    await admin.cards.decide({ cards: [card.id], answer: "confirm", requestId: requestId() });

    // The go, for both records: each claim re-keyed at version 2, both naming the first record's
    // version 1 key. Only the first record's claim key was confirmed.
    const rekeyed = (one: { evidenceId: string; record: ClaimRecord }, n: number): ClaimRecord => ({
      ...one.record,
      claim: { ...one.record.claim, id: sha256(`k2c rekeyed ${n}`), extractorGeneration: 5 } as Claim,
      factKey: `k2c v2 proposal ${n}`,
      legacyFactKey: first.record.factKey,
    });
    for (const [n, one] of [first, second].entries()) {
      expect(
        await pipeline.commit({
          ...batchOf(one.evidenceId, [rekeyed(one, n)], { generation: 5 }),
          lane: "agent",
        } as ExtractionCommit),
      ).toBe("committed");
    }
    const given = (await pipeline.beliefClaims()).map((group) => group.factKeyFp);
    expect(given).toContain(fp("k2c v2 proposal 0"));
    expect(given).not.toContain(fp("k2c v2 proposal 1"));
  });
});
