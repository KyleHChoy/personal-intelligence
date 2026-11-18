import { AGENT_ATTEMPT_BY, type CardId, type OpportunityId } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { cardFlag, type OwnerWorld, waitingCard, withOwnerWorld } from "../test-support/card-task-world.ts";
import { request } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";

// Agents settling the owner's questions: an agent_claim card is settled by a second agent, its confirm
// stored as an agent ruling the belief build reads below the owner's own confirmation and the owner's
// reopen lifts; nothing the owner learns from counts it; about_you cards reach the owner five a week;
// the owner marks the week's sample of settlements right or wrong. Made-up values only.

const attempts = vi.hoisted(() => ({ on: true }));
vi.mock("./agent-attempts.ts", async (original) => {
  const real = await original<typeof import("./agent-attempts.ts")>();
  return {
    ...real,
    attemptsOn: (rules?: Parameters<typeof real.attemptsOn>[0]) =>
      rules === undefined ? attempts.on : real.attemptsOn(rules),
  };
});

const OWN = ["own"];
const KEYS = ["own", "agent:scout", "agent:wide"];

type World = OwnerWorld & { scout: WorkClient; wide: WorkClient };

async function agent(w: WorkWorld, name: string): Promise<WorkClient> {
  const client = await workAgent(w, name, ["own", "agent:scout", "agent:wide"], {
    tools: READING_AGENT_TOOLS,
    kinds: ["research"],
  });
  await w.admin("update policy.clients set roles = array['chief-of-staff'] where name = $1", [name]);
  return client;
}

const inWorld = (fn: (w: World) => Promise<void>): Promise<void> =>
  withOwnerWorld(KEYS, "agents-settle", async (base) => {
    await base.admin("update policy.work_settings set default_task_role = 'chief-of-staff'");
    const scout = await agent(base, "scout");
    const wide = await agent(base, "wide");
    await fn({ ...base, scout, wide });
  });

// An agent_claim card as the pipeline raises it: by `system:extract`, its target a claim whose
// evidence is the record `author` wrote. Its request id is the claim key the belief build asks by.
async function claimCard(w: World, author: WorkClient): Promise<{ card: CardId; key: string }> {
  const record = ok(
    await w.reader.record(author.token, { kind: "finding", body: "A made-up claim.", requestId: request() }),
  ).recordId;
  const evidence = await w.seed.evidence(OWN, await w.seed.sourceAccount(OWN));
  await w.admin("update ledger.agent_writes set evidence_id = $2 where id = $1", [record, evidence]);
  const claim = await w.seed.claim(OWN, evidence);
  const card = await waitingCard(w, "agent_claim", ["confirm", "reject"], {
    author: "system:extract",
    target: { kind: "claim", id: claim },
  });
  const [row] = await w.admin<{ request_id: string }>("select request_id from ledger.cards where id = $1", [card]);
  return { card, key: row?.request_id ?? "" };
}

// Claims the card's task, records a finding and reports this answer, citing the finding.
async function answer(w: World, client: WorkClient, flag: OpportunityId, said: string) {
  ok(await w.work.claimOpportunity(client.token, { id: flag, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: flag, stage: "investigate", requestId: request() }),
  );
  const finding = ok(
    await w.reader.record(client.token, {
      kind: "finding",
      body: "What the cited records show.",
      requestId: request(),
    }),
  ).recordId;
  const reported = await w.work.reportMove(client.token, {
    move,
    outcome: "done",
    report: {
      deliverable: "Read what the card names.",
      next: "Nothing more is needed.",
      sources: [{ kind: "agent_record", id: finding }],
      card: { answer: said },
    } as never,
    requestId: request(),
  });
  return { reported, finding };
}

const lastEvent = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ event: string; by: string; code: string | null }>(
      "select event, by, code from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [id],
    )
  )[0];
// What the belief build reads as an agent's confirmation, as the pipeline's role asks it.
const agentConfirmed = (w: WorkWorld, key: string) =>
  queryAs<{ key: string }>(w.db.urls.pipeline, "select k as key from policy.agent_confirmed_claims($1) as k", [[key]]);
const ownerConfirmed = (w: WorkWorld, key: string) =>
  queryAs<{ key: string }>(w.db.urls.pipeline, "select k as key from policy.confirmed_claims($1) as k", [[key]]);
const queue = async (w: World): Promise<string[]> =>
  (await w.owner.cards.listPending({ limit: 50 })).map((one) => one.id);

async function measures(w: World) {
  const metrics = await ownerQuestions(
    w.admin,
    new Date(Date.now() - 86_400_000).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    OWN,
  );
  const of = (name: string) => metrics.find((row) => row.metric === name);
  return {
    asked: of("owner_questions_per_week")?.sample,
    byAgent: of("owner_questions_per_week")?.parts?.settled_by_agent,
    precision: of("agent_settled_precision")?.value,
    marked: of("agent_settled_precision")?.sample,
  };
}

describe("a second agent settles an agent's claim", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a confirm settles the card as an agent's, stores its ruling with what it cited, and the belief build reads it below the owner's", () =>
    inWorld(async (w) => {
      const decisions = () => w.admin("select id from knowledge.owner_decisions order by id");
      const rules = () => w.admin("select id from ledger.question_rules order by id");
      const [before, rulesBefore] = [await decisions(), await rules()];
      const { card, key } = await claimCard(w, w.scout);
      const flag = await cardFlag(w, "card_question", card);
      // The task is the chief-of-staff role's, the route the default gives a card's task.
      expect(await w.admin("select role from ledger.opportunities where id = $1", [flag])).toEqual([
        { role: "chief-of-staff" },
      ]);
      const { reported, finding } = await answer(w, w.wide, flag, "confirm");
      ok(reported);
      expect(await lastEvent(w, card)).toEqual({ event: "withdrawn", by: AGENT_ATTEMPT_BY, code: "agent_confirm" });
      expect(
        await w.admin(
          "select kind, answer, client_name, cited_kinds, cited_ids, compartments from ledger.agent_rulings where card_id = $1",
          [card],
        ),
      ).toEqual([
        {
          kind: "agent_claim",
          answer: "confirm",
          client_name: "wide",
          cited_kinds: ["agent_record"],
          cited_ids: [finding],
          compartments: OWN,
        },
      ]);
      expect(await agentConfirmed(w, key)).toEqual([{ key }]);
      // Never the owner's: no decision of theirs, none of their confirmations, no rule learned.
      expect(await ownerConfirmed(w, key)).toEqual([]);
      expect(await decisions()).toEqual(before);
      expect(await rules()).toEqual(rulesBefore);
      expect(await queue(w)).not.toContain(card);
      expect(await measures(w)).toMatchObject({ asked: 0, byAgent: 1 });
    }));

  it("the owner's reopen lifts the agent's ruling, and the card is theirs to answer (invariant 11)", () =>
    inWorld(async (w) => {
      const { card, key } = await claimCard(w, w.scout);
      ok((await answer(w, w.wide, await cardFlag(w, "card_question", card), "confirm")).reported);
      expect(await agentConfirmed(w, key)).toEqual([{ key }]);
      await w.owner.cards.reopenExpiredCard(card);
      expect(await lastEvent(w, card)).toEqual({ event: "pending", by: "owner", code: null });
      expect(await agentConfirmed(w, key)).toEqual([]);
      expect(await queue(w)).toContain(card);
      expect(await measures(w)).toMatchObject({ asked: 1, byAgent: 0 });
    }));

  it("a reject settles the card too, and confirms nothing", () =>
    inWorld(async (w) => {
      const { card, key } = await claimCard(w, w.scout);
      ok((await answer(w, w.wide, await cardFlag(w, "card_question", card), "reject")).reported);
      expect(await lastEvent(w, card)).toEqual({ event: "withdrawn", by: AGENT_ATTEMPT_BY, code: "agent_reject" });
      expect(await w.admin("select answer from ledger.agent_rulings where card_id = $1", [card])).toEqual([
        { answer: "reject" },
      ]);
      expect(await agentConfirmed(w, key)).toEqual([]);
    }));

  it("the claim's author never settles it: its answer is refused and no ruling is written", () =>
    inWorld(async (w) => {
      const { card } = await claimCard(w, w.scout);
      const { reported } = await answer(w, w.scout, await cardFlag(w, "card_question", card), "confirm");
      expect(ok(reported)).toMatchObject({ refused: ["card_answer_refused"] });
      expect(await w.admin("select card_id from ledger.agent_rulings")).toEqual([]);
      expect(await lastEvent(w, card)).toEqual({ event: "pending", by: "system:extract", code: null });
    }));
});

describe("the owner's weekly sample of what agents settled", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("samples the last whole week, lists a settled card with its question and what its ruling cited, takes the owner's mark, and counts it in precision", () =>
    inWorld(async (w) => {
      const { card } = await claimCard(w, w.scout);
      const { finding } = await answer(w, w.wide, await cardFlag(w, "card_question", card), "confirm");
      // Settled this week: not in the sample, which is last week's and fixed.
      expect((await w.owner.cards.listSettled({ sample: true })).settlements).toEqual([]);
      expect((await w.owner.cards.listSettled()).settlements.map((one) => one.card)).toEqual([card]);
      await w.owner.cards.markSettled(card, "right");
      await w.owner.cards.markSettled(card, "wrong");
      expect(await measures(w)).toMatchObject({ precision: 0, marked: 1 });
      // Answered a week ago, it is in last week's sample, with the card the owner reads.
      await asOwner(
        w.db,
        "update ledger.card_answers set created_at = created_at - interval '7 days' where card_id = $1",
        [card],
      );
      const [one] = (await w.owner.cards.listSettled({ sample: true })).settlements;
      expect(one).toMatchObject({
        card,
        kind: "agent_claim",
        agent: "wide",
        answer: "confirm",
        cited: [{ kind: "agent_record", id: finding }],
        mark: "wrong",
        reopened: false,
      });
      // The card the owner reads is served beside it: the seeded claim holds a full record, so its
      // lines open.
      expect(one?.question).toMatchObject({ id: card, kind: "agent_claim" });
      // A card no agent settled takes no mark.
      const other = await waitingCard(w, "same_fact", ["same", "different", "skip"]);
      await expect(w.owner.cards.markSettled(other, "right")).rejects.toMatchObject({ code: "not_found" });
    }));
});
