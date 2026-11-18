import type { CardId, ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { asWords } from "../test-support/card-lines.ts";
import { testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { mailFacts, mailRevision } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  countOf,
  evidenceLabelOf as labelOf,
  rowsOf,
  cardStateOf as stateOf,
  stored,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";

// Cards are raised by the commit of an agent record, as pi_pipeline; the owner reads and decides
// them as pi_admin.

const findingClaim = async (
  world: AgentWorld,
  evidence: string,
  options: { n?: number; factKey?: string; type?: string } = {},
): Promise<ClaimRecord> =>
  claimRecord(evidence, await labelOf(world, evidence), world.owner, {
    n: options.n ?? 1,
    origin: "agent_record",
    basis: "third_party",
    ...(options.factKey === undefined ? {} : { factKey: options.factKey }),
    ...(options.type === undefined ? {} : { type: options.type }),
  });
const commitFinding = async (world: AgentWorld, evidence: string, claims: ClaimRecord[], generation = 1) =>
  world.pipeline.commit(batchOf(evidence, claims, { lane: "agent", generation }));
const cards = (world: AgentWorld) =>
  rowsOf<{
    id: CardId;
    request_id: string;
    target_kind: string;
    target_id: string;
    created_by: string;
    compartments: string[];
  }>(
    world.db,
    "select id, request_id, target_kind, target_id, created_by, compartments from ledger.cards where kind = 'agent_claim' order by created_at, id",
  );
const keyOf = (world: AgentWorld, evidence: string, factKey: string): string =>
  fingerprint(world.db.keys, "agent_claim", `${evidence}\n${fingerprint(world.db.keys, "fact", factKey)}`);
const decide = (world: AgentWorld, card: CardId, answer: "confirm" | "reject") =>
  world.admin.cards.decide({ cards: [card], answer, requestId: testId("req").slice(4) });

// Moves a card's pending event, and the card, this many days into the past, as pi_owner: what no
// runtime role can do, done by the test to stand for time passing.
async function age(world: AgentWorld, card: string, days: number): Promise<void> {
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      `update ledger.record_events set at = at - make_interval(days => $2) where row_kind = 'card' and row_id = $1`,
      [card, days],
    );
  });
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("alter table ledger.cards no force row level security");
    try {
      await query(`update ledger.cards set created_at = created_at - make_interval(days => $2) where id = $1`, [
        card,
        days,
      ]);
    } finally {
      await query("alter table ledger.cards force row level security");
    }
  });
}

describe("raising the agent_claim card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("each claim key of a finding's commitments raises one agent_claim card, and two claims under one fact key raise one", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const claims = [
        await findingClaim(world, finding.evidence, { n: 1, factKey: "first" }),
        await findingClaim(world, finding.evidence, { n: 2, factKey: "second" }),
        await findingClaim(world, finding.evidence, { n: 3, factKey: "second" }),
      ];
      expect(await commitFinding(world, finding.evidence, claims)).toBe("committed");
      const raised = await cards(world);
      expect(raised.map((one) => one.request_id).sort()).toEqual(
        [keyOf(world, finding.evidence, "first"), keyOf(world, finding.evidence, "second")].sort(),
      );
      for (const card of raised) {
        expect(card).toMatchObject({
          target_kind: "claim",
          created_by: "system:extract",
          compartments: await labelOf(world, finding.evidence),
        });
        expect(await stateOf(world, card.id)).toBe("pending");
      }
      // The second key's target is the first of its claims by id.
      const second = raised.find((one) => one.request_id === keyOf(world, finding.evidence, "second"));
      const ids = [claims[1], claims[2]].map((one) => fingerprint(world.db.keys, "claim", one?.claim.id ?? "")).sort();
      expect(second?.target_id).toBe(ids[0]);
    }));

  it("a plan claim raises no card, and a claim of a message raises none, a system-sent message's included", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await commitFinding(world, finding.evidence, [await findingClaim(world, finding.evidence, { type: "plan" })]);
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await world.pipeline.commit(
        batchOf(message, [
          claimRecord(message, "own", world.owner, { n: 1 }),
          claimRecord(message, "own", world.owner, { n: 2, origin: "agent_record" }),
        ]),
      );
      expect(await countOf(world.db, "ledger.cards")).toBe(0);
    }));

  it("a card is raised with no ref, as pi_pipeline, and its first event is by system:extract", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await commitFinding(world, finding.evidence, [await findingClaim(world, finding.evidence)]);
      const [card] = await cards(world);
      const [first] = await rowsOf<{ event: string; by: string }>(
        world.db,
        "select event, by from ledger.record_events where row_id = $1 order by id limit 1",
        [card?.id],
      );
      expect(first).toEqual({ event: "pending", by: "system:extract" });
      expect(await countOf(world.db, "ledger.basis", "row_id = $1", [card?.id])).toBe(0);
    }));

  it("the card's basis rows are the agent record's cites, written through the wrapper, and a cite with no row logs card_basis_partial with the card's id", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await stored(world.writer, world.accounts.personalMail, MAIL.canary);
      const messages = await rowsOf<{ id: string }>(world.db, "select id from knowledge.messages order by id");
      const whole = await world.record("alpha", { cites: messages.map((one) => one.id) });
      await commitFinding(world, whole.evidence, [await findingClaim(world, whole.evidence)]);
      const [card] = await cards(world);
      const basis = await rowsOf<{ ref_id: string }>(
        world.db,
        "select ref_id from ledger.basis where row_kind = 'card' and row_id = $1 order by ref_id",
        [card?.id],
      );
      expect(basis.map((one) => one.ref_id)).toEqual(messages.map((one) => one.id).sort());
      expect(world.pipelineLog.filter((line) => line.event.event === "card_basis_partial")).toEqual([]);

      // A cite whose revision the message has since left behind resolves to no row.
      const [solo] = await rowsOf<{ id: string }>(
        world.db,
        "select m.id from knowledge.messages m order by m.id limit 1",
      );
      const partial = await world.record("alpha", { cites: [solo?.id ?? ""] });
      await world.writer.ingestItem(
        world.accounts.personalMail,
        mailRevision(MAIL.soloAgain, world.accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      await commitFinding(world, partial.evidence, [await findingClaim(world, partial.evidence)]);
      const second = (await cards(world)).find(
        (one) => one.request_id === keyOf(world, partial.evidence, `fact ${partial.evidence} 1`),
      );
      expect(second).toBeDefined();
      expect(
        world.pipelineLog
          .filter((line) => line.event.event === "card_basis_partial")
          .map((line) => [line.level, line.event.ids?.card]),
      ).toEqual([["warn", second?.id]]);
    }));
});

describe("replay", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a commit of the same claims under a new generation raises none, before and after the owner decided the first, and a replay writes no basis row", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [message] = await rowsOf<{ id: string }>(world.db, "select id from knowledge.messages order by id limit 1");
      const finding = await world.record("alpha", { cites: [message?.id ?? ""] });
      const first = await findingClaim(world, finding.evidence, { factKey: "kept" });
      await commitFinding(world, finding.evidence, [first]);
      const [card] = await cards(world);
      const basis = await countOf(world.db, "ledger.basis", "row_id = $1", [card?.id]);
      expect(basis).toBe(1);
      const raised = (generation: number) =>
        ({
          ...first,
          claim: {
            ...first.claim,
            id: `${first.claim.id.slice(0, 60)}000${generation}`,
            extractorGeneration: generation,
          },
        }) as ClaimRecord;
      await commitFinding(world, finding.evidence, [raised(2)], 2);
      expect((await cards(world)).length).toBe(1);
      await decide(world, card?.id as CardId, "confirm");
      await commitFinding(world, finding.evidence, [raised(3)], 3);
      expect((await cards(world)).length).toBe(1);
      expect(await stateOf(world, card?.id ?? "")).toBe("decided");
      expect(await countOf(world.db, "ledger.basis", "row_id = $1", [card?.id])).toBe(basis);
      // The confirmation still counts under the new claim's id.
      const groups = await world.pipeline.beliefClaims();
      expect(groups.flatMap((group) => group.claims.map((one) => one.claim.id))).toEqual([raised(3).claim.id]);
    }));

  it("raiseCard's replay of a decided, an expired and a withdrawn card answers that state", () =>
    withAgents(async (world) => {
      const base = {
        kind: "notice",
        author: "system:test",
        options: ["acknowledge"],
        target: null,
        refs: [],
        compartments: ["own"],
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: null,
        run: null,
        body: null,
        bodyFrom: null,
      };
      for (const state of ["decided", "expired", "withdrawn"]) {
        const requestId = testId("req").slice(4);
        const made = await world.admin.cards.raiseCard({ ...base, id: testId("crd"), requestId } as never);
        expect(made).toMatchObject({ state: "pending", replayed: false });
        await world.admin.cards
          .decide({ cards: [made.id], answer: "acknowledge", requestId: testId("req").slice(4) })
          .catch(() => undefined);
        if (state !== "decided") {
          await session(world.db.urls.bootstrap, async (query) => {
            await query("set role pi_owner");
            await query(
              "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, now(), 'system:test', '{own}')",
              [made.id, state],
            );
          });
        }
        expect(await world.admin.cards.raiseCard({ ...base, id: testId("crd"), requestId } as never)).toEqual({
          id: made.id,
          state,
          replayed: true,
        });
      }
    }));
});

describe("the card's lines", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the card's lines are its type and subject as code and its fields as agent, none marked source, while its claim exists", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await commitFinding(world, finding.evidence, [await findingClaim(world, finding.evidence)]);
      const [card] = await cards(world);
      const detail = await world.admin.cards.card(card?.id as CardId);
      const lines = asWords(detail?.lines ?? []);
      expect(lines.slice(0, 3).map((line) => line.from)).toEqual(["code", "code", "code"]);
      expect(lines).toContainEqual({ text: "type: commitment", from: "code" });
      expect(lines).toContainEqual({
        text: `subject: owner ${world.owner}`,
        from: "code",
        refs: [{ kind: "entity", id: world.owner }],
      });
      expect(lines).toContainEqual({ text: "what: Statement number 1.", from: "agent" });
      expect(lines.some((line) => line.from === "source")).toBe(false);
      expect(lines.filter((line) => line.text.startsWith("what:")).every((line) => line.from === "agent")).toBe(true);
    }));

  it("a finding about a person shows the person's kind and id as code and the first name on file as source", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const person = one(
        await rowsOf<{ entity_id: string }>(
          world.db,
          "select a.entity_id from knowledge.aliases a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' order by a.id limit 1",
        ),
      ).entity_id;
      const finding = await world.record("alpha");
      await commitFinding(world, finding.evidence, [
        claimRecord(finding.evidence, await labelOf(world, finding.evidence), person, {
          origin: "agent_record",
          basis: "third_party",
        }),
      ]);
      const [card] = await cards(world);
      const lines = (await world.admin.cards.card(card?.id as CardId))?.lines ?? [];
      const at = lines.findIndex((line) => line.text === `subject: person ${person}`);
      expect(lines[at]?.from).toBe("code");
      expect(lines[at + 1]?.from).toBe("source");
      expect(lines[at + 1]?.text.length).toBeGreaterThan(0);
    }));

  it("after a generation raise a pending card's lines are the new claim's", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const first = await findingClaim(world, finding.evidence, { factKey: "kept" });
      await commitFinding(world, finding.evidence, [first]);
      const raised = {
        ...first,
        claim: {
          ...first.claim,
          id: `${first.claim.id.slice(0, 60)}0002`,
          content: { ...first.claim.content, fields: { what: "Statement number 2." } },
        },
      } as unknown as ClaimRecord;
      await commitFinding(world, finding.evidence, [raised], 2);
      const [card] = await cards(world);
      expect(asWords((await world.admin.cards.card(card?.id as CardId))?.lines ?? [])).toContainEqual({
        text: "what: Statement number 2.",
        from: "agent",
      });
    }));

  it("a card whose claim was removed renders claim_removed and can be decided, and confirms nothing", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await commitFinding(world, finding.evidence, [await findingClaim(world, finding.evidence)]);
      const [card] = await cards(world);
      await commitFinding(world, finding.evidence, [], 2);
      expect(asWords((await world.admin.cards.card(card?.id as CardId))?.lines ?? []).at(-1)).toEqual({
        text: "claim_removed",
        from: "code",
      });
      expect(await decide(world, card?.id as CardId, "confirm")).toHaveLength(1);
      expect(await world.pipeline.beliefClaims()).toEqual([]);
    }));
});

describe("expiry, with no cap on the author's count", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a card past 30 days pending is left out by listPending and refused by decide, and the next agent record's commit writes its expired event once; the eleventh card is pending", () =>
    withAgents(async (world) => {
      const findings = [];
      for (let n = 0; n < 11; n += 1) findings.push(await world.record("alpha"));
      for (const finding of findings)
        await commitFinding(world, finding.evidence, [await findingClaim(world, finding.evidence)]);
      const raised = await cards(world);
      expect(await stateOf(world, raised.at(-1)?.id ?? "")).toBe("pending");
      const old = raised[0];
      await age(world, old?.id ?? "", 31);
      expect(
        (await world.admin.cards.listPending({ kind: "agent_claim", limit: 50 })).map((one) => one.id),
      ).not.toContain(old?.id);
      await expect(decide(world, old?.id as CardId, "confirm")).rejects.toMatchObject({ code: "not_pending" });
      const next = await world.record("alpha");
      await commitFinding(world, next.evidence, [await findingClaim(world, next.evidence)]);
      expect(await stateOf(world, old?.id ?? "")).toBe("expired");
      expect(await countOf(world.db, "ledger.record_events", "row_id = $1 and event = 'expired'", [old?.id])).toBe(1);
    }));
});

describe("what the owner answered", { timeout: DB_TEST_TIMEOUT }, () => {
  it("confirm lets the claim into its fact key's belief at the next rebuild, and reject leaves every belief as it was", () =>
    withAgents(async (world) => {
      const confirmed = await world.record("alpha");
      const rejected = await world.record("alpha");
      await commitFinding(world, confirmed.evidence, [await findingClaim(world, confirmed.evidence)]);
      await commitFinding(world, rejected.evidence, [await findingClaim(world, rejected.evidence)]);
      const byKey = new Map((await cards(world)).map((card) => [card.request_id, card.id]));
      await decide(
        world,
        byKey.get(keyOf(world, confirmed.evidence, `fact ${confirmed.evidence} 1`)) as CardId,
        "confirm",
      );
      await decide(
        world,
        byKey.get(keyOf(world, rejected.evidence, `fact ${rejected.evidence} 1`)) as CardId,
        "reject",
      );
      const kept = (await world.pipeline.beliefClaims()).flatMap((group) =>
        group.claims.map((one) => one.claim.primaryEvidenceId),
      );
      expect(kept).toEqual([confirmed.evidence]);
    }));
});
