import {
  type CardId,
  type ClaimRecord,
  type PersonalCompartment,
  QUOTED_PROPOSAL_PIPELINE,
  type RulingId,
  rejectedLine,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { writeDecision } from "../../core/queue.ts";
import { sealUnder } from "../../core/seal.ts";
import { heldOut } from "../../pipeline/pipeline-cards.ts";
import { sha256Hex, testId } from "../../test-support/clients.ts";
import { readAs, session } from "../../test-support/connections.ts";
import { cardStateOf as stateOf } from "../../test-support/pipeline-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { type AgentWorld, batchOf, claimRecord, queryAs, rowsOf, withAgents } from "../../testing.ts";

// Learning from the owner's answers: the confirm rate of each agent and kind, computed at read over
// their own answers after the cleanup; the card proposing a standing release at 90% over 30 answers,
// once, and withdrawn when the rate falls back; the holdout still asked under a grant, chosen by
// record id under the store's key; the card proposing the lift when the held-out rate falls or Not
// true passes a tenth of what the grant kept; the agent's brief line at 30% or less, from its own
// counts within its clearance alone; and the owner's switch turning both off. Made-up values only.

let written = 0;

type Taken = { record: string; evidence: string; label: string[] };
// One proposal record of `client`, taken in. A record is written as a note and made a proposal by
// the table's owner before intake, as policy.propose_about_you would leave it.
async function recordOf(world: AgentWorld, client: string, kind: string): Promise<Taken> {
  written += 1;
  const body = JSON.stringify({ kind, statement: `A fact, number ${written}.` });
  const recorded = await world.reader.record(await world.token(client), {
    kind: "note",
    body: "a proposal to be",
    requestId: `rate-request-${String(written).padStart(6, "0")}`,
  });
  if (!recorded.ok) throw new Error(`record answered ${recorded.code}`);
  const id = recorded.value.recordId;
  const [{ compartments } = { compartments: [] }] = await rowsOf<{ compartments: string[] }>(
    world.db,
    "select compartments from ledger.agent_writes where id = $1",
    [id],
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
  const [row] = await rowsOf<{ evidence_id: string }>(
    world.db,
    "select evidence_id from ledger.agent_writes where id = $1",
    [id],
  );
  if (row?.evidence_id == null) throw new Error("the proposal was not taken in");
  const [label] = await rowsOf<{ compartments: string[] }>(
    world.db,
    "select compartments from vault.evidence_items where id = $1",
    [row.evidence_id],
  );
  return { record: id, evidence: row.evidence_id, label: label?.compartments ?? [] };
}

// `count` claims of `kind` of a record taken in, each its own fact, committed by the agent lane: an
// about-you card each, unless quoted under a grant.
async function commitTo(
  world: AgentWorld,
  taken: Taken,
  kind: string,
  count: number,
  options: { quoted?: boolean; matchKey?: string } = {},
): Promise<{ record: string; evidence: string; claims: string[] }> {
  const claims = Array.from({ length: count }, (_, n): ClaimRecord => {
    const made = claimRecord(taken.evidence, taken.label, world.owner, {
      n: n + 1,
      type: kind,
      origin: "agent_record",
      basis: "third_party",
    });
    if (options.quoted === true) (made.claim as { pipelineVersion: string }).pipelineVersion = QUOTED_PROPOSAL_PIPELINE;
    return options.matchKey === undefined ? made : ({ ...made, matchKey: options.matchKey } as ClaimRecord);
  });
  const committed = await world.pipeline.commit(
    batchOf(taken.evidence, claims, { lane: "agent", ...(options.quoted === true ? { ownerQuoted: true } : {}) }),
  );
  if (committed !== "committed") throw new Error(`the commit answered ${committed}`);
  return {
    record: taken.record,
    evidence: taken.evidence,
    claims: claims.map((one) => fingerprint(world.db.keys, "claim", one.claim.id)),
  };
}

const proposal = async (
  world: AgentWorld,
  client: string,
  kind: string,
  count: number,
  options: { quoted?: boolean; matchKey?: string } = {},
) => commitTo(world, await recordOf(world, client, kind), kind, count, options);

const cardsOf = (world: AgentWorld, evidence: string) =>
  rowsOf<{ id: CardId }>(
    world.db,
    `select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id
     where c.kind = 'about_you' and k.evidence_id = $1 order by k.id`,
    [evidence],
  );
const suggestions = (world: AgentWorld, kind: string) =>
  rowsOf<{ id: CardId; case_key: string; compartments: string[] }>(
    world.db,
    "select id, case_key, compartments from ledger.cards where kind = $1 order by created_at, id",
    [kind],
  );
const decide = async (world: AgentWorld, cards: CardId[], answer: "confirm" | "reject"): Promise<void> => {
  for (let at = 0; at < cards.length; at += 25)
    await world.admin.cards.decide({ cards: cards.slice(at, at + 25), answer, requestId: testId("req").slice(4) });
};
// `confirms` confirmed and `rejects` rejected answers on one record's cards of `client` and `kind`.
async function answers(world: AgentWorld, client: string, kind: string, confirms: number, rejects = 0): Promise<void> {
  const made = await proposal(world, client, kind, confirms + rejects);
  const cards = (await cardsOf(world, made.evidence)).map((one) => one.id);
  expect(cards).toHaveLength(confirms + rejects);
  if (confirms > 0) await decide(world, cards.slice(0, confirms), "confirm");
  if (rejects > 0) await decide(world, cards.slice(confirms), "reject");
}
// The cleanup's apply, as `pia facts clean --apply` records it.
const cleanup = (world: AgentWorld): Promise<RulingId> =>
  session(world.db.urls.admin, (query) =>
    writeDecision(
      query,
      {
        id: newId("rul") as RulingId,
        requestId: testId("req").slice(4),
        kind: "facts_clean",
        target: null,
        answer: null,
        card: null,
        supersedes: null,
        batch: false,
        labels: [],
        // The dry run's plan the apply applied (FactsCleanDetails).
        details: { plan: "a".repeat(64) },
        compartments: ["own"] as PersonalCompartment[],
      },
      { now: new Date() },
    ),
  );
const rateOf = async (world: AgentWorld, client: string, kind: string) =>
  (await world.admin.releases.confirmRates()).agents
    .find((one) => one.client === client)
    ?.rates.find((one) => one.kind === kind);
// What an agent's brief reads: its own rows, under its own token.
const briefRows = async (world: AgentWorld, client: string) =>
  readAs(world.db, await world.token(client), (query) =>
    query<{ kind: string; granted: boolean; answers: number; confirmed: number }>(
      "select kind, granted, answers, confirmed from policy.my_confirm_rates($1)",
      [new Date().toISOString()],
    ),
  );
const learning = (world: AgentWorld, client: string, on: boolean) =>
  world.admin.releases.setLearning({ client, on, requestId: testId("req").slice(4) });

describe("confirm rates", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("count only the owner's own answers after the cleanup, raise one card at 90% over 30, tell the agent at 30% or less, and stop both when switched off", () =>
    withAgents(async (world) => {
      // Before the cleanup, nothing is counted, however many answers.
      await answers(world, "alpha", "preference", 31);
      expect((await world.admin.releases.confirmRates()).since).toBeNull();
      expect(await rateOf(world, "alpha", "preference")).toBeUndefined();
      expect(await suggestions(world, "grant_suggestion")).toEqual([]);
      await cleanup(world);
      expect((await world.admin.releases.confirmRates()).since).not.toBeNull();

      // 29 answers: under the floor, still asked, no card.
      await answers(world, "alpha", "preference", 29);
      expect(await rateOf(world, "alpha", "preference")).toEqual({
        kind: "preference",
        answers: 29,
        confirmed: 29,
        kept: 0,
        notTrue: 0,
        state: "learning",
      });
      expect(await suggestions(world, "grant_suggestion")).toEqual([]);

      // The 30th raises one card; the 31st raises no second while it is open.
      await answers(world, "alpha", "preference", 2);
      expect(await rateOf(world, "alpha", "preference")).toMatchObject({ answers: 31, state: "suggested" });
      const [card, ...more] = await suggestions(world, "grant_suggestion");
      expect(more).toEqual([]);
      expect(card?.case_key).toMatch(/^grant:cli_[0-9A-Z]{26}:preference$/);
      // Its label is that of the answers it counted.
      expect(card?.compartments).toEqual(["agent:alpha", "own"]);
      const lines = (await world.admin.cards.card(card?.id as CardId))?.lines.map((one) => one.text) ?? [];
      // Its counts as the pass that raised it read them, at its clock.
      expect(lines).toContain("confirmed: 31 of the last 31");
      expect(lines).toContain("to keep them without asking: pia facts grant alpha preference");

      // A settled duplicate is not an answer of the owner's: deciding the open card counts once.
      const first = await proposal(world, "alpha", "preference", 1, { matchKey: "the same fact" });
      const second = await proposal(world, "alpha", "preference", 1, { matchKey: "the same fact" });
      expect(await cardsOf(world, second.evidence)).toEqual([]);
      await decide(
        world,
        (await cardsOf(world, first.evidence)).map((one) => one.id),
        "confirm",
      );
      expect(await rateOf(world, "alpha", "preference")).toMatchObject({ answers: 32, confirmed: 32 });
      // An answer written by the cleanup is never counted.
      const tagged = await proposal(world, "alpha", "preference", 1);
      const [taggedCard] = await cardsOf(world, tagged.evidence);
      await queryAs(
        world.db.urls.admin,
        `insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, queue_depth, details, decided_at, compartments)
         values ($1, $2, 'answer', 'reject', $3, 0, '{"via": "cleanup"}', now(), '{own}')`,
        [newId("rul"), testId("req").slice(4), taggedCard?.id],
      );
      expect(await rateOf(world, "alpha", "preference")).toMatchObject({ answers: 32, confirmed: 32 });

      // The owner declines it: no other card for alpha and preference for a month, whatever comes.
      await decide(world, [card?.id as CardId], "reject");
      await answers(world, "alpha", "preference", 2);
      expect(await suggestions(world, "grant_suggestion")).toHaveLength(1);

      // 9 of 30 confirmed: beta is told, in its own brief, from its own counts alone.
      await answers(world, "beta", "constraint", 9, 21);
      expect(await rateOf(world, "beta", "constraint")).toMatchObject({ answers: 30, confirmed: 9, state: "told" });
      expect(await briefRows(world, "beta")).toEqual([
        { kind: "constraint", granted: false, answers: 30, confirmed: 9 },
      ]);
      expect(rejectedLine(await briefRows(world, "beta"))).toContain("constraint, 21 of the last 30 rejected");
      // Alpha's brief holds alpha's own counts and says nothing of beta's (invariant 6).
      expect((await briefRows(world, "alpha")).map((one) => one.kind)).toEqual(["preference"]);
      expect(rejectedLine(await briefRows(world, "alpha"))).toBeNull();
      // 10 of 31 is over 30%: not told.
      await answers(world, "beta", "need", 10, 21);
      expect(await rateOf(world, "beta", "need")).toMatchObject({ state: "learning" });
      expect(rejectedLine(await briefRows(world, "beta"))).not.toContain("need");

      // Switched off: beta's brief says nothing; switched on again, it does.
      await learning(world, "beta", false);
      expect(await briefRows(world, "beta")).toEqual([]);
      expect(await rateOf(world, "beta", "constraint")).toMatchObject({ state: "learning" });
      expect((await world.admin.releases.confirmRates()).agents.find((one) => one.client === "beta")?.on).toBe(false);
      await learning(world, "beta", true);
      expect(rejectedLine(await briefRows(world, "beta"))).toContain("constraint");

      // Switched off, gamma's 30 confirms raise no card; switched on, the pass raises one at once.
      await world.token("gamma");
      await learning(world, "gamma", false);
      await answers(world, "gamma", "situation", 30);
      expect(
        (await suggestions(world, "grant_suggestion")).filter((one) => one.case_key.endsWith(":situation")),
      ).toEqual([]);
      await learning(world, "gamma", true);
      const [raised, ...others] = (await suggestions(world, "grant_suggestion")).filter((one) =>
        one.case_key.endsWith(":situation"),
      );
      expect(others).toEqual([]);
      expect(await stateOf(world, raised?.id as string)).toBe("pending");
      // Its reason gone (30 of 34 is under 90%), the next pass withdraws it.
      await answers(world, "gamma", "situation", 0, 4);
      expect(await stateOf(world, raised?.id as string)).toBe("withdrawn");
    }));

  it("still asks the held-out share under a grant, rates it alone, and proposes the lift when it falls below 90% or Not true passes a tenth of what the grant kept", () =>
    withAgents(async (world) => {
      await cleanup(world);
      await world.token("alpha");
      for (const kind of ["preference", "constraint"])
        await world.admin.releases.grantRelease("alpha", kind, { requestId: testId("req").slice(4) });
      // Quoted proposals under each grant until ten were kept and one held out, chosen by the record's
      // id under the store's key: the held-out record's 33 claims are each carded, the rest kept.
      const kept: Record<string, { evidence: string; claims: string[] }[]> = { preference: [], constraint: [] };
      const held: Record<string, CardId[]> = { preference: [], constraint: [] };
      for (const kind of ["preference", "constraint"]) {
        for (let tries = 0; tries < 80 && (kept[kind]?.length !== 10 || held[kind]?.length === 0); tries += 1) {
          const taken = await recordOf(world, "alpha", kind);
          const out = heldOut(world.db.keys, taken.record);
          if (!out && kept[kind]?.length === 10) continue;
          const made = await commitTo(world, taken, kind, out ? 33 : 1, { quoted: true });
          const cards = (await cardsOf(world, made.evidence)).map((one) => one.id);
          const released = await rowsOf(
            world.db,
            "select 1 from knowledge.claim_releases where evidence_id = $1 and via = 'grant'",
            [made.evidence],
          );
          expect([cards.length, released.length], taken.record).toEqual(out ? [33, 0] : [0, 1]);
          if (out) held[kind] = cards;
          else kept[kind]?.push(made);
        }
        expect(kept[kind]).toHaveLength(10);
        expect(held[kind]).toHaveLength(33);
      }
      const lifts = () => suggestions(world, "grant_lift_suggestion");

      // Paraphrases answered under the grant are no sample of it: rejecting 30 moves nothing.
      await answers(world, "alpha", "preference", 0, 30);
      expect(await rateOf(world, "alpha", "preference")).toMatchObject({ answers: 0, kept: 10, state: "granted" });

      // Not true on 2 of the 10 kept: counted apart, not yet a card; the third passes a tenth.
      const preference = kept.preference ?? [];
      for (const one of preference.slice(0, 2))
        await world.admin.facts.rejectClaim(one.claims[0] as never, { requestId: testId("req").slice(4) });
      expect(await rateOf(world, "alpha", "preference")).toMatchObject({ answers: 0, notTrue: 2, kept: 10 });
      expect(await lifts()).toEqual([]);
      await world.admin.facts.rejectClaim(preference[2]?.claims[0] as never, { requestId: testId("req").slice(4) });
      const [byNotTrue, ...more] = await lifts();
      expect(more).toEqual([]);
      expect(byNotTrue?.case_key).toMatch(/^lift:cli_[0-9A-Z]{26}:preference$/);
      const lines = (await world.admin.cards.card(byNotTrue?.id as CardId))?.lines.map((one) => one.text) ?? [];
      expect(lines).toContain("not true: 3 of 10 kept");
      expect(lines).toContain("to ask you again: pia facts grant-lift alpha preference");

      // The held-out rate: 27 of 30 is 90%, no card; 27 of 31 falls below and raises one.
      const cards = held.constraint ?? [];
      await decide(world, cards.slice(0, 27), "confirm");
      await decide(world, cards.slice(27, 30), "reject");
      expect(await rateOf(world, "alpha", "constraint")).toMatchObject({ answers: 30, confirmed: 27 });
      expect((await lifts()).filter((one) => one.case_key.endsWith(":constraint"))).toEqual([]);
      await decide(world, cards.slice(30, 31), "reject");
      expect((await lifts()).filter((one) => one.case_key.endsWith(":constraint"))).toHaveLength(1);
      // While a grant is on, no card proposes it.
      expect(await suggestions(world, "grant_suggestion")).toEqual([]);
    }));

  it("tells an agent only what rows within its clearance say", () =>
    withAgents(async (world) => {
      await cleanup(world);
      // 9 of 30 under its own label: told.
      await answers(world, "beta", "constraint", 9, 21);
      const told = await briefRows(world, "beta");
      expect(told).toEqual([{ kind: "constraint", granted: false, answers: 30, confirmed: 9 }]);
      // Widened, it proposes 20 more under a wider label, all confirmed; narrowed again, it is told
      // exactly what it was: nothing outside its clearance changes it.
      const clearance = await rowsOf<{ compartments: string[] }>(
        world.db,
        "select compartments from policy.clients where name = 'beta'",
      );
      await world.admin.clients.setCompartments("beta", [...(clearance[0]?.compartments ?? []), "employer:example"]);
      await answers(world, "beta", "constraint", 20);
      expect(await briefRows(world, "beta")).toEqual([
        { kind: "constraint", granted: false, answers: 50, confirmed: 29 },
      ]);
      // A registration never narrows in place, so the table's owner narrows it here.
      await session(world.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("alter table policy.clients no force row level security");
        try {
          await query("update policy.clients set compartments = $1 where name = 'beta'", [clearance[0]?.compartments]);
        } finally {
          await query("alter table policy.clients force row level security");
        }
      });
      expect(await briefRows(world, "beta")).toEqual(told);
      // The owner sees every row.
      expect(await rateOf(world, "beta", "constraint")).toMatchObject({ answers: 50, confirmed: 29 });
    }));
});
