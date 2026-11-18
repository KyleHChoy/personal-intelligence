import {
  AGENT_ATTEMPT_BY,
  AGENT_ATTEMPT_GRACE_MINUTES,
  AGENT_ATTEMPT_HOURS,
  type CardId,
  type CardLine,
  type OpportunityId,
} from "@intelligence/contracts/personal";
import { autonomyRules } from "@intelligence/personal-core/planner";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import {
  aged,
  cardFlag,
  cardGaps,
  type OwnerWorld,
  waitingCard,
  withOwnerWorld,
} from "../test-support/card-task-world.ts";
import { request, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personNamed as person } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";

// Made-up values on reserved domains only.

// The switch is the rule data's. Every test here but the last block's holds it on, and that block off, whatever the
// file says: what the owner's queue and the report read where no rules are passed.
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
const SIDE = ["agent:scout", "own"];
const KEYS = ["own", "employer:example", "agent:scout", "agent:wide", "agent:far"];

type World = OwnerWorld & { scout: WorkClient; wide: WorkClient; far: WorkClient };

async function agent(w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> {
  const client = await workAgent(w, name, compartments, {
    tools: READING_AGENT_TOOLS,
    kinds: ["research"],
  });
  await w.admin("update policy.clients set roles = array['network'] where name = $1", [name]);
  return client;
}

const inWorld = (fn: (w: World) => Promise<void>): Promise<void> =>
  withOwnerWorld(KEYS, "agent-attempts", async (base) => {
    await base.admin("update policy.work_settings set default_task_role = 'network'");
    const scout = await agent(base, "scout", ["own", "agent:scout", "agent:wide"]);
    const wide = await agent(base, "wide", ["own", "agent:scout", "agent:wide"]);
    // Cleared for nothing a card here is under.
    const far = await agent(base, "far", ["agent:far"]);
    await fn({ ...base, scout, wide, far });
  });

// A waiting card as the tick writes one. `target`: the claim it is about.
const card = (
  w: WorkWorld,
  kind: string,
  options: string[],
  label: string[] = OWN,
  author = "system:work",
  target: string | null = null,
): Promise<CardId> =>
  waitingCard(w, kind, options, { label, author, target: target === null ? null : { kind: "claim", id: target } });
const gaps = (w: WorkWorld, at = new Date()) => cardGaps(w, "card_gaps", AGENT_ATTEMPT_HOURS, at);
// The card's task, raised as the tick raises it.
const flagOf = (w: WorkWorld, id: CardId): Promise<OpportunityId> => cardFlag(w, "card_question", id);

// An agent_claim card as the pipeline raises it: by `system:extract`, its target a claim whose
// evidence is the record this agent wrote.
async function claimCard(w: World, author: WorkClient): Promise<CardId> {
  const record = ok(
    await w.reader.record(author.token, { kind: "finding", body: "A made-up claim.", requestId: request() }),
  ).recordId;
  const evidence = await w.seed.evidence(OWN, await w.seed.sourceAccount(OWN));
  await w.admin("update ledger.agent_writes set evidence_id = $2 where id = $1", [record, evidence]);
  const claim = await w.seed.claim(OWN, evidence);
  return card(w, "agent_claim", ["confirm", "reject"], OWN, "system:extract", claim);
}

// Claims the card's task, records a finding and reports this answer: the report's answer.
async function answer(w: World, client: WorkClient, flag: OpportunityId, said: string) {
  ok(await w.work.claimOpportunity(client.token, { id: flag, requestId: request() }));
  return finish(w, client, flag, said);
}

// The rest of an answer, by the agent that holds the task.
async function finish(w: World, client: WorkClient, flag: OpportunityId, said: string) {
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: flag, stage: "investigate", requestId: request() }),
  );
  const finding = ok(
    await w.reader.record(client.token, {
      kind: "finding",
      body: "What the cited records show, read whole.",
      requestId: request(),
    }),
  ).recordId;
  return w.work.reportMove(client.token, {
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
}

const events = (w: WorkWorld, id: string) =>
  w.admin<{ event: string; by: string; code: string | null }>(
    "select event, by, code from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
    [id],
  );
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
    waiting: of("owner_questions_per_week")?.parts?.waiting_on_agent,
    attempted: of("owner_questions_attempted")?.parts?.attempted,
    settled: of("settled_without_owner_overturned")?.parts?.settled,
    overturned: of("settled_without_owner_overturned")?.parts?.overturned,
  };
}

describe("an agent is asked a card before the owner", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a card of a kind an agent can work raises one task under the card's label, and its brief is the card by ids", () =>
    inWorld(async (w) => {
      const id = await card(w, "same_fact", ["same", "different", "skip"], SIDE);
      expect(await gaps(w)).toEqual([{ subject: id, label: SIDE, about_kind: "owner", source_kind: "card" }]);
      const flag = await flagOf(w, id);
      const [task] = await w.admin<{
        compartments: string[];
        tier: string;
        role: string;
        gap_source: string;
        kind: string;
      }>("select compartments, tier, role, gap_source, kind from ledger.opportunities where id = $1", [flag]);
      expect(task).toEqual({ compartments: SIDE, tier: "task", role: "network", gap_source: id, kind: "research" });
      // One task for a card: its gap holds while the task is open, and a second raise answers the open one.
      expect(await gaps(w)).toEqual([{ subject: id, label: SIDE, about_kind: "owner", source_kind: "card" }]);
      expect(await flagOf(w, id)).toBe(flag);
      const claimed = ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      expect((claimed as { brief?: { card?: unknown } }).brief?.card).toEqual({
        id,
        kind: "same_fact",
        options: ["same", "different", "skip"],
        target: null,
        refs: [],
        own: false,
      });
    }));

  it("no task for a kind only the owner answers, a restricted label, an answered card or one past the wait", () =>
    inWorld(async (w) => {
      const theirs = await card(w, "about_you", ["confirm", "reject"]);
      const lesson = await card(w, "lesson", ["confirm", "reject"]);
      const old = await card(w, "same_fact", ["same", "different", "skip"]);
      await aged(w, old, AGENT_ATTEMPT_HOURS * 60 + 1);
      const decided = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', $2)",
        [decided, OWN],
      );
      expect(await gaps(w)).toEqual([]);
      // The wait is the gap's (ledger.card_gaps takes the hours); a raise refuses the rest itself.
      for (const id of [theirs, lesson, decided])
        expect(
          await queryAs(
            w.db.urls.work,
            "select ledger.raise_gap_flag($1, 'card_question', $2, 'owner', null, 'card', $2, null, null, true) as id",
            [testId("opp"), id],
          ),
        ).toEqual([{ id: null }]);
    }));

  it("a client outside the card's label sees no task: its board is byte-identical (invariant 6)", () =>
    inWorld(async (w) => {
      const board = async () =>
        JSON.stringify(ok(await w.work.listOpportunities(w.far.token, { scope: "board", tier: "task" })));
      const before = await board();
      const id = await card(w, "same_fact", ["same", "different", "skip"]);
      const flag = await flagOf(w, id);
      expect(await board()).toBe(before);
      ok(await answer(w, w.scout, flag, "same"));
      expect(await board()).toBe(before);
      // And it can neither claim the task nor read its card.
      const refused = await w.work.claimOpportunity(w.far.token, { id: flag, requestId: request() });
      expect(refused).toMatchObject({ ok: false });
    }));

  it("an answer that settles its kind withdraws the card as an agent's, never the owner's, and changes nothing else", () =>
    inWorld(async (w) => {
      const id = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      const flag = await flagOf(w, id);
      // A reminder is due when it is raised: the owner sees it at once, while its task is open.
      expect(await queue(w)).toContain(id);
      expect(await measures(w)).toMatchObject({ asked: 1, waiting: 0, byAgent: 0 });
      expect(ok(await answer(w, w.scout, flag, "done"))).toMatchObject({ opportunity: "done" });
      expect(await events(w, id)).toEqual([
        { event: "pending", by: "system:work", code: null },
        { event: "withdrawn", by: AGENT_ATTEMPT_BY, code: "agent_done" },
      ]);
      expect(await w.admin("select client_name, answer from ledger.card_answers where card_id = $1", [id])).toEqual([
        { client_name: "scout", answer: "done" },
      ]);
      expect(await w.admin("select id from knowledge.owner_decisions where card_id = $1", [id])).toEqual([]);
      expect(await queue(w)).not.toContain(id);
      // It never reached the owner; it is counted as settled without the owner, by an agent.
      expect(await measures(w)).toEqual({ asked: 0, byAgent: 1, waiting: 0, attempted: 0, settled: 1, overturned: 0 });
    }));

  it("the owner's reopen gives a settled card back, and the report says it was overturned", () =>
    inWorld(async (w) => {
      const id = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      ok(await answer(w, w.scout, await flagOf(w, id), "done"));
      await w.owner.cards.reopenExpiredCard(id);
      expect((await events(w, id)).at(-1)).toEqual({ event: "pending", by: "owner", code: null });
      expect(await queue(w)).toContain(id);
      expect(await measures(w)).toEqual({ asked: 1, byAgent: 0, waiting: 0, attempted: 1, settled: 1, overturned: 1 });
    }));

  it("a card the owner touched is never settled by an agent (invariant 11)", () =>
    inWorld(async (w) => {
      const id = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      const flag = await flagOf(w, id);
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'owner', $2)",
        [id, OWN],
      );
      ok(await answer(w, w.scout, flag, "done"));
      expect((await events(w, id)).at(-1)).toEqual({ event: "pending", by: "owner", code: null });
      expect(await queue(w)).toContain(id);
    }));

  it("an agent's answer waits on the card's lock, and never lands on a card the owner answered meanwhile", () =>
    inWorld(async (w) => {
      const id = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      const flag = await flagOf(w, id);
      ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      // The owner answering, holding the card's lock as decide does, not yet committed.
      const owner = new pg.Client({ connectionString: w.db.urls.admin });
      await owner.connect();
      let reported = false;
      try {
        await owner.query("begin");
        await owner.query("select ledger.lock_rows($1)", [[id]]);
        const report = finish(w, w.scout, flag, "done").then((result) => {
          reported = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(reported).toBe(false);
        await owner.query(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', $2)",
          [id, OWN],
        );
        await owner.query("commit");
        expect(ok(await report)).toMatchObject({ refused: ["card_answer_refused"] });
      } finally {
        await owner.end();
      }
      expect((await events(w, id)).at(-1)).toEqual({ event: "decided", by: "owner", code: null });
      expect(await w.admin("select id from ledger.card_answers where card_id = $1", [id])).toEqual([]);
    }));

  it("an answer whose effect is a ruling is attached to the card the owner sees, and rules nothing", () =>
    inWorld(async (w) => {
      const rulings = () => w.admin("select id from knowledge.owner_decisions order by id");
      const before = await rulings();
      const id = await card(w, "same_fact", ["same", "different", "skip"]);
      const flag = await flagOf(w, id);
      expect(await queue(w)).not.toContain(id);
      ok(await answer(w, w.scout, flag, "same"));
      expect(await events(w, id)).toEqual([{ event: "pending", by: "system:work", code: null }]);
      expect(await rulings()).toEqual(before);
      expect(await queue(w)).toContain(id);
      const shown = (await w.owner.cards.card(id)) as { lines: CardLine[] };
      const line = shown.lines.find((one) => one.key === "agent_answer");
      expect(line?.from).toBe("code");
      expect(line?.value?.slice(0, 2)).toEqual([
        { kind: "text", text: "scout" },
        { kind: "code", code: "same" },
      ]);
      expect(await measures(w)).toMatchObject({ asked: 1, attempted: 1, byAgent: 0, waiting: 0 });
    }));

  it("cant_tell gives the card to the owner at once, and is the attempt on record", () =>
    inWorld(async (w) => {
      const id = await card(w, "reminder", ["done", "snooze", "dismiss"]);
      ok(await answer(w, w.scout, await flagOf(w, id), "cant_tell"));
      expect(await events(w, id)).toEqual([{ event: "pending", by: "system:work", code: null }]);
      expect(await queue(w)).toContain(id);
      expect(await measures(w)).toMatchObject({ asked: 1, attempted: 1 });
    }));

  it("refuses an answer that is no option", () =>
    inWorld(async (w) => {
      const id = await card(w, "same_fact", ["same", "different", "skip"]);
      expect(ok(await answer(w, w.scout, await flagOf(w, id), "confirm"))).toMatchObject({
        refused: ["card_answer_refused"],
      });
      expect(await w.admin("select id from ledger.card_answers")).toEqual([]);
    }));

  it("no agent confirms its own claim: the card of a claim it wrote says so in its brief and refuses its answer", () =>
    inWorld(async (w) => {
      const own = await claimCard(w, w.scout);
      const flag = await flagOf(w, own);
      const briefOf = async (client: WorkClient, task: OpportunityId) =>
        (
          ok(await w.work.claimOpportunity(client.token, { id: task, requestId: request() })) as {
            brief?: { card?: { own?: boolean; target?: unknown } };
          }
        ).brief?.card;
      expect(await briefOf(w.scout, flag)).toMatchObject({ own: true, target: { kind: "claim" } });
      expect(ok(await finish(w, w.scout, flag, "confirm"))).toMatchObject({ refused: ["card_answer_refused"] });
      expect(await w.admin("select id from ledger.card_answers")).toEqual([]);
      // Another agent may answer it, and its answer settles the card as an agent's
      // (agents-settle.db.test.ts holds the ruling it writes).
      const again = await claimCard(w, w.scout);
      const next = await flagOf(w, again);
      expect(await briefOf(w.wide, next)).toMatchObject({ own: false });
      ok(await finish(w, w.wide, next, "confirm"));
      expect(await w.admin("select client_name, answer from ledger.card_answers")).toEqual([
        { client_name: "wide", answer: "confirm" },
      ]);
      expect(await events(w, again)).toEqual([
        { event: "pending", by: "system:extract", code: null },
        { event: "withdrawn", by: AGENT_ATTEMPT_BY, code: "agent_confirm" },
      ]);
      expect(await queue(w)).not.toContain(again);
    }));

  it("a card nobody answered is the owner's after the wait, one with no task after a few minutes, and none waits with tasks off", () =>
    inWorld(async (w) => {
      const tasked = await card(w, "time_effort", ["confirm", "reject"]);
      await flagOf(w, tasked);
      const bare = await card(w, "tier_proposal", ["confirm", "reject"]);
      // New: both wait. Past the minutes the tick has to raise a task: only the one with an open task.
      expect(await queue(w)).toEqual([]);
      await aged(w, bare, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      await aged(w, tasked, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      expect(await queue(w)).toEqual([bare]);
      // Past the wait: the owner's, though its task is still open; the gap no longer holds, so the tick closes it.
      await aged(w, tasked, AGENT_ATTEMPT_HOURS * 60 + 1);
      expect((await queue(w)).sort()).toEqual([bare, tasked].sort());
      expect((await gaps(w)).map((one) => one.subject)).toEqual([bare]);
      expect(await measures(w)).toMatchObject({ waiting: 0, attempted: 0 });
      // With tasks off no task can be raised: a new card is the owner's at once.
      await setTaskTier(w.admin, false, new Date());
      const off = await card(w, "same_fact", ["same", "different", "skip"]);
      expect(await queue(w)).toContain(off);
    }));

  it("a task that failed gives its card to the owner, with no attempt counted", () =>
    inWorld(async (w) => {
      const id = await card(w, "time_effort", ["confirm", "reject"]);
      const flag = await flagOf(w, id);
      await aged(w, id, AGENT_ATTEMPT_GRACE_MINUTES + 1);
      ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      expect(await queue(w)).toEqual([]);
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "failed",
          report: { reason: "Nothing to read." },
          requestId: request(),
        }),
      );
      expect(await queue(w)).toEqual([id]);
      expect(await measures(w)).toMatchObject({ asked: 1, attempted: 0 });
      // No second task: the gap held only until one raised for it ended.
      expect(await gaps(w)).toEqual([]);
    }));

  it("a task's done report raises no card of its own", () =>
    inWorld(async (w) => {
      const id = await card(w, "same_fact", ["same", "different", "skip"]);
      const before = await w.admin<{ n: number }>("select count(*)::int as n from ledger.cards");
      ok(await answer(w, w.scout, await flagOf(w, id), "different"));
      expect(await w.admin<{ n: number }>("select count(*)::int as n from ledger.cards")).toEqual(before);
    }));
});

// The tick's candidates for the card trigger, under these rules.
async function cardCandidates(w: WorkWorld, rules = autonomyRules()): Promise<string[]> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    return (await dispatch.gapCandidates(new Date(), rules))
      .filter((gap) => gap.trigger === "card_question")
      .map((gap) => gap.subject);
  } finally {
    await dispatch.close();
  }
}

describe("the switch", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("absent, holds no card from the owner and raises no task; set, the tick finds the card", () =>
    inWorld(async (w) => {
      attempts.on = false;
      try {
        const id = await card(w, "same_fact", ["same", "different", "skip"]);
        const reminder = await card(w, "reminder", ["done", "snooze", "dismiss"]);
        expect((await queue(w)).sort()).toEqual([id, reminder].sort());
        expect(await cardCandidates(w, { ...autonomyRules(), cardAttemptsOn: undefined })).toEqual([]);
        expect(await w.admin("select id from ledger.opportunities where gap_trigger = 'card_question'")).toEqual([]);
        expect(await measures(w)).toMatchObject({ asked: 2, waiting: 0 });
        expect((await cardCandidates(w, { ...autonomyRules(), cardAttemptsOn: true })).sort()).toEqual(
          [id, reminder].sort(),
        );
      } finally {
        attempts.on = true;
      }
    }));
});

// A message on a person's interaction log, under this label.
async function wrote(w: WorkWorld, entity: string, label: string[] = OWN): Promise<string> {
  const id = await w.seed.message(label, undefined, { text: "A note about the project." });
  const [row] = await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [
    id,
  ]);
  const made = row?.evidence_id ?? "";
  await w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
     values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '10 days', $4, '{m-owner}', 'sender')`,
    [interactionId(made, entity), made, entity, label],
  );
  return id;
}

let minute = 0;
const sweep = (w: World) =>
  w.writer.proposeIdentity(new Date(Date.parse("2026-11-05T12:00:00Z") + (minute += 1) * 60_000));

type Recent = { message: string; at: string; subject: { untrusted: string } | null }[];
type Brief = { brief?: { samePerson?: { a: string; records: { a: { recent: Recent }; b: { recent: Recent } } }[] } };

describe("a same-person brief carries what an agent needs to answer", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("lists each side's recent messages by id, date and subject, within the pair's label alone", () =>
    inWorld(async (w) => {
      await w.owner.identity.setIdentityAgents("on");
      const a = await person(w, "dara.work@example.org", "Dara Vance");
      const b = await person(w, "dv-home@example.net", "Dara Vance");
      const first = await wrote(w, a);
      const second = await wrote(w, a);
      const other = await wrote(w, b);
      // On the first person's log, under a label the agent is cleared for and the pair is not.
      const wider = await wrote(w, a, SIDE);
      await sweep(w);
      const [gap] = await queryAs<{ subject: string; about_id: string }>(
        w.db.urls.work,
        "select subject, about_id from ledger.same_person_gaps()",
      );
      const [flag] = await queryAs<{ id: string }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'same_person', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), gap?.subject, gap?.about_id],
      );
      const claimed = ok(
        await w.work.claimOpportunity(w.scout.token, { id: flag?.id as OpportunityId, requestId: request() }),
      ) as Brief;
      const [pair] = claimed.brief?.samePerson ?? [];
      const [mine, theirs] = pair?.a === a ? [pair.records.a, pair.records.b] : [pair?.records.b, pair?.records.a];
      expect(mine?.recent.map((one) => one.message).sort()).toEqual([first, second].sort());
      expect(theirs?.recent.map((one) => one.message)).toEqual([other]);
      expect(JSON.stringify(claimed)).not.toContain(wider);
      for (const one of [...(mine?.recent ?? []), ...(theirs?.recent ?? [])]) {
        expect(one.subject?.untrusted).toMatch(/^Seed subject /);
        expect(Number.isNaN(Date.parse(one.at))).toBe(false);
      }
    }));

  it("a pair with nothing to read on either side rests: no task, no card, until a message arrives", () =>
    inWorld(async (w) => {
      await w.owner.identity.setIdentityAgents("on");
      const a = await person(w, "lee.one@example.org", "Lee Stone");
      await person(w, "lee-two@example.net", "Lee Stone");
      await sweep(w);
      expect(await w.admin("select state, passed_code from ledger.identity_questions")).toEqual([
        { state: "resting", passed_code: "nothing_to_read" },
      ]);
      expect(await queryAs(w.db.urls.work, "select subject from ledger.same_person_gaps()")).toEqual([]);
      expect(await w.admin("select id from ledger.cards where created_by = 'system:identity'")).toEqual([]);
      await wrote(w, a);
      await sweep(w);
      expect(await w.admin("select state from ledger.identity_questions")).toEqual([{ state: "agents" }]);
    }));
});
