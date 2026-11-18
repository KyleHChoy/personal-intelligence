import { BELIEF_TYPES, type CardId, type ClaimRecord, type PersonalEvidenceId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { SOLO } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  type AgentWorld,
  batchOf,
  beliefsComputed,
  claimRecord,
  rowsOf,
  stored,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// The candidates of a claim taken from an agent record, from the store, as pi_pipeline. Each refusal has its
// positive control. Written from the spec.

type Written = { record: string; evidence: string; label: string[] };

const fpOf = (world: AgentWorld, key: string): string => fingerprint(world.db.keys, "fact", key);

// A finding by alpha (clearance `own`), taken in, with its label.
async function finding(world: AgentWorld, options: { cites?: string[] } = {}): Promise<Written> {
  const written = await world.record("alpha", options);
  const label = one(
    await rowsOf<{ compartments: string[] }>(world.db, "select compartments from vault.evidence_items where id = $1", [
      written.evidence,
    ]),
  ).compartments;
  return { ...written, label: [...label].sort() };
}

const findingClaim = (
  world: AgentWorld,
  written: Written,
  options: { n?: number; type?: string; factKey?: string; subject?: string } = {},
): ClaimRecord =>
  claimRecord(written.evidence, written.label, options.subject ?? world.owner, {
    n: options.n ?? 1,
    origin: "agent_record",
    basis: "third_party",
    factKey: options.factKey ?? `finding ${written.evidence}`,
    ...(options.type === undefined ? {} : { type: options.type }),
  });

// A read log row of the record's session, `minutes` from the record's time (negative: before it),
// as policy.log_read writes one, by the table's owner.
async function readLog(
  world: AgentWorld,
  written: Written,
  minutes: number,
  given: { bound?: string[]; factKeyFps?: string[] },
): Promise<void> {
  const row = one(
    await rowsOf<{ session_id: string; client_id: string; compartments: string[] }>(
      world.db,
      "select session_id, client_id, compartments from ledger.agent_writes where id = $1",
      [written.record],
    ),
  );
  await session(world.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(
      `insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps)
       select $1, $2, 'find_facts', w.created_at + make_interval(mins => $3), $4, $5, '{}', $6 from ledger.agent_writes w where w.id = $7`,
      [
        row.session_id,
        row.client_id,
        minutes,
        row.compartments,
        given.bound ?? [],
        given.factKeyFps ?? [],
        written.record,
      ],
    );
    await query("commit");
  });
}

// A message's claims committed, each under the message's compartment.
async function sourceClaims(
  world: AgentWorld,
  evidence: string,
  compartment: string,
  claims: {
    n: number;
    factKey: string;
    type?: string;
    subject?: string;
    origin?: "source" | "agent_record";
    validFrom?: string;
  }[],
): Promise<ClaimRecord[]> {
  const records = claims.map((one) =>
    claimRecord(evidence, compartment, one.subject ?? world.owner, {
      n: one.n,
      factKey: one.factKey,
      ...(one.type === undefined ? {} : { type: one.type }),
      ...(one.origin === undefined ? {} : { origin: one.origin }),
      ...(one.validFrom === undefined ? {} : { validFrom: one.validFrom }),
    }),
  );
  expect(await world.pipeline.commit(batchOf(evidence, records))).toBe("committed");
  return records;
}

const ids = (found: { record: ClaimRecord }[]): string[] => found.map((one) => one.record.claim.id).sort();
const candidates = async (world: AgentWorld, written: Written, a: ClaimRecord, held: string[] = []) =>
  one(
    await world.pipeline.restatementCandidates(written.evidence as PersonalEvidenceId, [{ claim: a, heldKeys: held }]),
  );

describe("the candidate set", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a claim outside the label is never a candidate (invariant 6), and one within it is", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const work = await stored(world.writer, world.accounts.workMail, MAIL.workOnly);
      const [inside] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "own key" }]);
      const [outside] = await sourceClaims(world, work, "employer:example", [{ n: 1, factKey: "employer key" }]);
      const written = await finding(world);
      expect(written.label).toEqual(["agent:alpha", "own"]);
      await readLog(world, written, -1, {
        bound: [own, work],
        factKeyFps: [fpOf(world, "own key"), fpOf(world, "employer key")],
      });
      const found = await candidates(world, written, findingClaim(world, written), ["own key", "employer key"]);
      expect(ids(found)).toEqual([inside?.claim.id]);
      expect(found.map((one) => one.reached)).toEqual(["read"]);
      expect(ids(found)).not.toContain(outside?.claim.id);
    }));

  it("a claim from mail the system sent is never a candidate, and a source claim beside it is", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [source, sent] = await sourceClaims(world, own, "own", [
        { n: 1, factKey: "source key" },
        { n: 2, factKey: "sent key", origin: "agent_record" },
      ]);
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "source key"), fpOf(world, "sent key")] });
      const found = await candidates(world, written, findingClaim(world, written));
      expect(ids(found)).toEqual([source?.claim.id]);
      expect(ids(found)).not.toContain(sent?.claim.id);
    }));

  it("a claim read after the record was written is not reached by path 1; one read at or before it is", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const other = await stored(world.writer, world.accounts.personalMail, MAIL.fromQuentin);
      const [late] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "late key" }]);
      const [early] = await sourceClaims(world, other, "own", [{ n: 1, factKey: "early key" }]);
      const written = await finding(world);
      await readLog(world, written, 5, { bound: [own], factKeyFps: [fpOf(world, "late key")] });
      expect(await candidates(world, written, findingClaim(world, written))).toEqual([]);
      // At the record's own time, by fact key; and by an item the session bound.
      await readLog(world, written, 0, { factKeyFps: [fpOf(world, "early key")] });
      expect(ids(await candidates(world, written, findingClaim(world, written)))).toEqual([early?.claim.id]);
      await readLog(world, written, -1, { bound: [own] });
      const found = await candidates(world, written, findingClaim(world, written));
      expect(ids(found)).toEqual([early?.claim.id, late?.claim.id].sort());
      expect(found.every((one) => one.reached === "read")).toBe(true);
    }));

  it("a claim among the record's cites is reached by path 1", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [cited] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "cited key" }]);
      const [message] = await rowsOf<{ id: string }>(
        world.db,
        "select id from knowledge.messages where evidence_id = $1",
        [own],
      );
      const plain = await finding(world);
      expect(await candidates(world, plain, findingClaim(world, plain))).toEqual([]);
      const citing = await finding(world, { cites: [message?.id ?? ""] });
      const found = await candidates(world, citing, findingClaim(world, citing));
      expect(ids(found)).toEqual([cited?.claim.id]);
      expect(found.map((one) => one.reached)).toEqual(["read"]);
    }));

  it("the claims of one record are answered together, in the order asked, each with its own type", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [commitment, role] = await sourceClaims(world, own, "own", [
        { n: 1, factKey: "commitment key" },
        { n: 2, factKey: "role key", type: "role" },
      ]);
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "commitment key"), fpOf(world, "role key")] });
      const found = await world.pipeline.restatementCandidates(written.evidence as PersonalEvidenceId, [
        { claim: findingClaim(world, written, { n: 1, type: "role" }), heldKeys: [] },
        { claim: findingClaim(world, written, { n: 2 }), heldKeys: [] },
      ]);
      expect(found.map(ids)).toEqual([[role?.claim.id], [commitment?.claim.id]]);
    }));

  it("a held key reaches a claim the session never read, as held; with no held key nothing does", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [held] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "held role key", type: "role" }]);
      const written = await finding(world);
      const a = findingClaim(world, written, { type: "role" });
      expect(await candidates(world, written, a)).toEqual([]);
      const found = await candidates(world, written, a, ["held role key"]);
      expect(ids(found)).toEqual([held?.claim.id]);
      expect(found.map((one) => one.reached)).toEqual(["held"]);
      // Read too: path 1 wins.
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "held role key")] });
      expect((await candidates(world, written, a, ["held role key"])).map((one) => one.reached)).toEqual(["read"]);
    }));

  it("a claim of another type or another subject is no candidate, nor is any claim of the record itself", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [person] = await rowsOf<{ id: string }>(
        world.db,
        "select entity_id as id from knowledge.accounts where value_fp = $1",
        [fingerprint(world.db.keys, "address", SOLO.address)],
      );
      const [same] = await sourceClaims(world, own, "own", [
        { n: 1, factKey: "same key" },
        { n: 2, factKey: "plan key", type: "plan" },
        { n: 3, factKey: "subject key", subject: person?.id ?? "" },
      ]);
      const written = await finding(world);
      const a = findingClaim(world, written);
      // The record's own claims, stored by an earlier commit.
      expect(
        await world.pipeline.commit(
          batchOf(written.evidence, [a, findingClaim(world, written, { n: 2 })], { lane: "agent" }),
        ),
      ).toBe("committed");
      await readLog(world, written, -1, {
        bound: [written.record],
        factKeyFps: ["same key", "plan key", "subject key", `finding ${written.evidence}`].map((key) =>
          fpOf(world, key),
        ),
      });
      expect(ids(await candidates(world, written, a))).toEqual([same?.claim.id]);
    }));

  it("an unconfirmed finding's claim is never a candidate, a confirmed one is", () =>
    withAgents(async (world) => {
      const earlier = await finding(world);
      const claim = findingClaim(world, earlier, { factKey: "earlier key" });
      expect(await world.pipeline.commit(batchOf(earlier.evidence, [claim], { lane: "agent" }))).toBe("committed");
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "earlier key")] });
      expect(await candidates(world, written, findingClaim(world, written))).toEqual([]);
      const [card] = await rowsOf<{ id: CardId }>(world.db, "select id from ledger.cards where kind = 'agent_claim'");
      await world.admin.cards.decide({
        cards: [card?.id as CardId],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      expect(ids(await candidates(world, written, findingClaim(world, written)))).toEqual([claim.claim.id]);
    }));

  it("an evidence id of no agent record has no candidates", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await sourceClaims(world, own, "own", [{ n: 1, factKey: "own key" }]);
      const written = await finding(world);
      expect(
        await world.pipeline.restatementCandidates(own as PersonalEvidenceId, [
          { claim: findingClaim(world, written), heldKeys: ["own key"] },
        ]),
      ).toEqual([[]]);
    }));
});

describe("the belief judged", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the belief judged is the one computed under the writing client's audience", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [s] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "judged key" }]);
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "judged key")] });
      expect(one(await candidates(world, written, findingClaim(world, written))).belief).toEqual({
        status: "active",
        latest: s,
      });
    }));

  it("the belief's latest supporting claim is the latest by valid_from, then id, opened", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [s, later] = await sourceClaims(world, own, "own", [
        { n: 1, factKey: "support key", validFrom: "2026-09-01T09:00:00.000Z" },
        { n: 2, factKey: "support key", validFrom: "2026-09-03T09:00:00.000Z" },
      ]);
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "support key")] });
      const found = await candidates(world, written, findingClaim(world, written));
      expect(ids(found)).toEqual([s?.claim.id, later?.claim.id].sort());
      // Both candidates are judged against one belief, whose latest supporting claim is `later`.
      for (const candidate of found) expect(candidate.belief).toEqual({ status: "active", latest: later });
      expect(
        found.every((candidate) => candidate.factKeyFp === fpOf(world, "support key") && !candidate.rejected),
      ).toBe(true);
    }));

  it("the switch to version 2 keys: a claim a pre-switch reject carries by its version 1 key is a rejected candidate, as the belief build leaves it out", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      // Under the old keys: a source claim at its version 1 key, which the owner rejects.
      const before = claimRecord(own, "own", world.owner, { n: 1, factKey: "go v1 key" });
      expect(await world.pipeline.commit(batchOf(own, [before], { generation: 4 }))).toBe("committed");
      await world.admin.facts.rejectClaim(fingerprint(world.db.keys, "claim", before.claim.id) as never, {
        requestId: "request-restatement-go-0001",
      });
      // The item made again at generation 5, its version 2 key with the version 1 key beside it.
      const after = {
        ...claimRecord(own, "own", world.owner, { n: 2, factKey: "go v2 key" }),
        legacyFactKey: "go v1 key",
      } as ClaimRecord;
      expect(await world.pipeline.commit(batchOf(own, [after], { generation: 5 }))).toBe("committed");
      const written = await finding(world);
      await readLog(world, written, -1, { factKeyFps: [fpOf(world, "go v2 key")] });
      const found = await candidates(world, written, findingClaim(world, written));
      expect(ids(found)).toEqual([after.claim.id]);
      expect(found.every((candidate) => candidate.rejected)).toBe(true);
    }));
});

// --------------------------------------------------------------------------------------------- The
// mark in the commit.
// ---------------------------------------------------------------------------------------------

type Answer = "echo" | "stale" | "undecided" | "new";
const MATCHED = "f".repeat(64);
const check = (claim: ClaimRecord, answer: Answer) => ({
  claimId: claim.claim.id,
  answer,
  reached: answer === "new" ? null : ("read" as const),
  matchedFactKeyFp: answer === "echo" || answer === "stale" ? MATCHED : null,
});
const commitChecked = (
  world: AgentWorld,
  written: Written,
  claims: ClaimRecord[],
  answers: Answer[] | undefined,
  generation = 1,
) =>
  world.pipeline.commit(
    batchOf(written.evidence, claims, {
      lane: "agent",
      generation,
      ...(answers === undefined ? {} : { restatements: claims.map((claim, i) => check(claim, answers[i] ?? "new")) }),
    }),
  );
const marks = (world: AgentWorld) =>
  rowsOf<{
    claim_key: string;
    answer: string;
    reached: string | null;
    matched_fact_key_fp: string | null;
    decision_version: number;
    compartments: string[];
    cleared_at: Date | null;
  }>(
    world.db,
    "select claim_key, answer, reached, matched_fact_key_fp, decision_version, compartments, cleared_at from ledger.restatement_checks order by id",
  );
const agentCards = (world: AgentWorld) =>
  rowsOf<{ id: CardId; request_id: string }>(
    world.db,
    "select id, request_id from ledger.cards where kind = 'agent_claim' order by created_at, id",
  );
const keyOf = (world: AgentWorld, evidence: string, factKey: string): string =>
  fingerprint(world.db.keys, "agent_claim", `${evidence}\n${fpOf(world, factKey)}`);
// policy.confirmed_claims, as the pipeline asks it.
const confirmedKeys = async (world: AgentWorld, keys: string[]): Promise<string[]> =>
  (
    await queryAs<{ key: string }>(world.db.urls.pipeline, "select k as key from policy.confirmed_claims($1) as k", [
      keys,
    ])
  ).map((row) => row.key);
// The beliefs the writing client's clearance is given now, computed: each one's fact key, status,
// tier and support.
const beliefState = async (world: AgentWorld) =>
  (await beliefsComputed(world.db, ["agent:alpha", "own"], BELIEF_TYPES, new Date().toISOString())).map((record) => ({
    fact: record.factKeyFp,
    status: record.belief.status,
    tier: record.tier,
    support: [...record.belief.support].sort(),
  }));

describe("the mark in the commit", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the echo finding and the stale one each get one row, no card, and no change to any belief's state or support", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [s] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "restated key" }]);
      const beliefsBefore = await beliefState(world);
      // The positive control: the belief the findings restate is given.
      expect(beliefsBefore.map((one) => one.fact)).toEqual([fpOf(world, "restated key")]);
      const echo = await finding(world);
      const stale = await finding(world);
      const echoed = findingClaim(world, echo);
      const restated = findingClaim(world, stale);
      expect(await commitChecked(world, echo, [echoed], ["echo"])).toBe("committed");
      expect(await commitChecked(world, stale, [restated], ["stale"])).toBe("committed");
      expect(await marks(world)).toEqual([
        {
          claim_key: keyOf(world, echo.evidence, `finding ${echo.evidence}`),
          answer: "echo",
          reached: "read",
          matched_fact_key_fp: MATCHED,
          decision_version: 1,
          compartments: echo.label,
          cleared_at: null,
        },
        {
          claim_key: keyOf(world, stale.evidence, `finding ${stale.evidence}`),
          answer: "stale",
          reached: "read",
          matched_fact_key_fp: MATCHED,
          decision_version: 1,
          compartments: stale.label,
          cleared_at: null,
        },
      ]);
      expect(await agentCards(world)).toEqual([]);
      expect(await beliefState(world)).toEqual(beliefsBefore);
      // Neither claim is in what the belief build reads.
      const built = (await world.pipeline.beliefClaims()).flatMap((group) => group.claims.map((one) => one.claim.id));
      expect(built).toEqual([s?.claim.id]);
    }));

  it("a card raised before the mark and confirmed after it confirms nothing", () =>
    withAgents(async (world) => {
      const written = await finding(world);
      const claim = findingClaim(world, written);
      // Committed with no mark: the card is raised.
      expect(await commitChecked(world, written, [claim], undefined)).toBe("committed");
      const [card] = await agentCards(world);
      // Marked echo at the next generation raise, then confirmed.
      expect(await commitChecked(world, written, [claim], ["echo"], 2)).toBe("committed");
      await world.admin.cards.decide({
        cards: [card?.id as CardId],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      expect(await confirmedKeys(world, [keyOf(world, written.evidence, `finding ${written.evidence}`)])).toEqual([]);
      expect((await world.pipeline.beliefClaims()).flatMap((group) => group.claims)).toEqual([]);
    }));

  it("a retry and a generation raise keep the first answer", () =>
    withAgents(async (world) => {
      const written = await finding(world);
      const claim = findingClaim(world, written);
      expect(await commitChecked(world, written, [claim], ["echo"])).toBe("committed");
      expect(await commitChecked(world, written, [claim], ["new"])).toBe("committed");
      expect(await commitChecked(world, written, [claim], ["new"], 2)).toBe("committed");
      expect((await marks(world)).map((row) => row.answer)).toEqual(["echo"]);
      expect(await agentCards(world)).toEqual([]);
    }));

  it("a finding the owner confirmed earlier, marked echo at the next generation raise, keeps its confirmation and its own belief, and the restated belief is unchanged", () =>
    withAgents(async (world) => {
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [s] = await sourceClaims(world, own, "own", [{ n: 1, factKey: "restated key" }]);
      const written = await finding(world);
      const claim = findingClaim(world, written);
      expect(await commitChecked(world, written, [claim], undefined)).toBe("committed");
      const [card] = await agentCards(world);
      await world.admin.cards.decide({
        cards: [card?.id as CardId],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      expect(await commitChecked(world, written, [claim], ["echo"], 2)).toBe("committed");
      expect((await marks(world)).map((row) => row.answer)).toEqual(["echo"]);
      const key = keyOf(world, written.evidence, `finding ${written.evidence}`);
      expect(await confirmedKeys(world, [key])).toEqual([key]);
      expect((await agentCards(world)).length).toBe(1);
      // Its own belief, under its own fact key; the restated fact's claims are the source's alone.
      const groups = await world.pipeline.beliefClaims();
      expect(
        groups
          .find((group) => group.factKeyFp === fpOf(world, `finding ${written.evidence}`))
          ?.claims.map((one) => one.claim.id),
      ).toEqual([claim.claim.id]);
      expect(
        groups.find((group) => group.factKeyFp === fpOf(world, "restated key"))?.claims.map((one) => one.claim.id),
      ).toEqual([s?.claim.id]);
    }));

  it("a new finding gets its agent_claim card as before, and an undecided claim gets its card in this build", () =>
    withAgents(async (world) => {
      const fresh = await finding(world);
      const unsure = await finding(world);
      expect(await commitChecked(world, fresh, [findingClaim(world, fresh)], ["new"])).toBe("committed");
      expect(await commitChecked(world, unsure, [findingClaim(world, unsure)], ["undecided"])).toBe("committed");
      expect((await agentCards(world)).map((card) => card.request_id).sort()).toEqual(
        [
          keyOf(world, fresh.evidence, `finding ${fresh.evidence}`),
          keyOf(world, unsure.evidence, `finding ${unsure.evidence}`),
        ].sort(),
      );
      expect((await marks(world)).map((row) => [row.answer, row.reached, row.matched_fact_key_fp])).toEqual([
        ["new", null, null],
        ["undecided", "read", null],
      ]);
    }));

  it("two claims under one claim key write one row, the first claim's by id, and hold back one card", () =>
    withAgents(async (world) => {
      const written = await finding(world);
      const claims = [findingClaim(world, written, { n: 1 }), findingClaim(world, written, { n: 2 })].sort((a, b) =>
        fingerprint(world.db.keys, "claim", a.claim.id) < fingerprint(world.db.keys, "claim", b.claim.id) ? -1 : 1,
      );
      expect(await commitChecked(world, written, claims, ["echo", "new"])).toBe("committed");
      expect((await marks(world)).map((row) => row.answer)).toEqual(["echo"]);
      expect(await agentCards(world)).toEqual([]);
    }));

  it("a commit whose answers name a claim it does not hold, or a message's commit with answers, is refused", () =>
    withAgents(async (world) => {
      const written = await finding(world);
      const claim = findingClaim(world, written);
      const stray = { ...check(findingClaim(world, written, { n: 9 }), "echo") };
      await expect(
        world.pipeline.commit(batchOf(written.evidence, [claim], { lane: "agent", restatements: [stray] })),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      const own = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const message = claimRecord(own, "own", world.owner, { n: 1 });
      await expect(
        world.pipeline.commit(batchOf(own, [message], { restatements: [check(message, "new")] })),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await marks(world)).toEqual([]);
      // Controls: the same commits without the stray answer, and without answers.
      expect(
        await world.pipeline.commit(
          batchOf(written.evidence, [claim], { lane: "agent", restatements: [check(claim, "new")] }),
        ),
      ).toBe("committed");
      expect(await world.pipeline.commit(batchOf(own, [message]))).toBe("committed");
    }));
});
