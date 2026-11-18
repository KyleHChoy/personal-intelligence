import type { CardId } from "@intelligence/contracts/personal";
import { planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setOwnerPageHost, setQuestionRole } from "../admin/admin-tasks.ts";
import { WAITING } from "../admin/cards/admin-queue.ts";
import { attemptsOn } from "../cards/agent-attempts.ts";
import {
  aged,
  asWork,
  cardFlag,
  type OwnerWorld,
  waitingCard,
  withOwnerWorld,
} from "../test-support/card-task-world.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";
import { gapCandidates } from "./dispatch-gaps.ts";
import { ownerQueueGaps } from "./owner-queue.ts";

// The page also hides a card held for a person with no name, which takes the owner's keys to read,
// so the count can exceed the page by such cards; that hold is not compared here. Made-up values on
// reserved domains only.

const OWN = ["own"];
const A = ["agent:alpha", "own"];
const B = ["agent:beta", "own"];
const KEYS = ["own", "agent:alpha", "agent:beta", "agent:canary-seed"];
const ROLE = "chief-of-staff";
const HOST = "box.example.ts.net";

type World = OwnerWorld & { qa: WorkClient; qb: WorkClient; viewer: WorkClient };

const agent = async (w: WorkWorld, name: string, compartments: string[], role: string): Promise<WorkClient> => {
  const client = await workAgent(w, name, compartments, {
    tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "record"],
    kinds: ["research"],
  });
  await w.admin("update policy.clients set roles = array[$2] where name = $1", [name, role]);
  return client;
};

const inWorld = (fn: (w: World) => Promise<void>, settings = true): Promise<void> =>
  withOwnerWorld(KEYS, "owner-queue", async (base) => {
    // Two agents of the question role, each cleared for `own` and one agent's compartment; a third,
    // of another role, cleared for `own` alone.
    const qa = await agent(base, "qa", A, ROLE);
    const qb = await agent(base, "qb", B, ROLE);
    const viewer = await agent(base, "viewer", OWN, "research");
    if (settings) {
      await setQuestionRole(base.admin, ROLE, new Date());
      await setOwnerPageHost(base.admin, HOST);
    }
    await fn({ ...base, qa, qb, viewer });
  });

type State = { host: string | null; label: string[]; subject: string; waiting: number; ended_today: boolean };
const state = (w: WorkWorld) =>
  queryAs<State>(
    w.db.urls.work,
    "select host, label, subject, waiting, ended_today from ledger.owner_queue_state(now(), $1) order by subject",
    [attemptsOn()],
  );
const raise = (w: WorkWorld, subject: string) =>
  queryAs<{ id: string | null }>(
    w.db.urls.work,
    "select ledger.raise_gap_flag($1, 'owner_queue', $2, 'owner', null, 'queue', $2, null, null, true) as id",
    [testId("opp"), subject],
  );
const board = async (w: World, client: WorkClient): Promise<string> =>
  JSON.stringify(ok(await w.work.listOpportunities(client.token, { scope: "board", tier: "task" })));
const answer = (w: World, card: CardId, choice = "reject") =>
  w.owner.cards.decide({ cards: [card], answer: choice, requestId: request() });
const handovers = async (w: WorkWorld, label: string[]): Promise<string[]> =>
  (
    await w.admin<{ id: string }>(
      "select id from ledger.opportunities where gap_trigger = 'owner_queue' and compartments = $1 order by created_at, id",
      [label],
    )
  ).map((row) => row.id);
// The tick's gap step, as close-no-tie.db.test.ts runs it: close, then raise; the hand-overs it did.
async function tick(w: WorkWorld): Promise<{ raised: number; closed: number }> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    const now = new Date();
    const flags = await dispatch.gapFlags(now);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(now),
      open: flags.open,
      history: flags.history,
    });
    const counts = { raised: 0, closed: 0 };
    for (const id of plan.close) if (await dispatch.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise)
      if (gap.trigger === "owner_queue" && (await dispatch.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
    return counts;
  } finally {
    await dispatch.close();
  }
}
const queueGaps = (w: WorkWorld) =>
  asWork(w, async (query) => (await gapCandidates(query, new Date())).filter((gap) => gap.trigger === "owner_queue"));

// A decision on a read-only task, which a relay asks about.
async function decision(w: WorkWorld, label: string[]): Promise<CardId> {
  const task = (await w.seed.into("ledger.opportunities")(label)) as string;
  await asOwner(w.db, "update ledger.opportunities set tier = 'task', kind = 'investigate' where id = $1", [task]);
  await w.status("opportunity", task, "proposed", "system:work");
  return waitingCard(w, "opportunity_decision", ["go", "no_go"], { label, target: { kind: "opportunity", id: task } });
}

describe("the hand-over of everything waiting for the owner", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("gives two question agents of different clearances a task each under its own clearance, which an agent cleared for less never sees", () =>
    inWorld(async (w) => {
      const before = await board(w, w.viewer);
      await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN });
      const wideA = await waitingCard(w, "question_rule", ["confirm", "decline"], { label: A });
      await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: B });
      const rows = await state(w);
      expect(rows.map((row) => [row.label, row.waiting, row.ended_today])).toEqual(
        expect.arrayContaining([
          [A, 2, false],
          [B, 2, false],
        ]),
      );
      expect(rows).toHaveLength(2);
      const ids: string[] = [];
      for (const row of rows) {
        const [flag] = await raise(w, row.subject);
        expect(flag?.id).toBeTruthy();
        ids.push(flag?.id ?? "");
        expect(await w.admin("select compartments, role from ledger.opportunities where id = $1", [flag?.id])).toEqual([
          { compartments: row.label, role: ROLE },
        ]);
      }
      // An agent of another role cleared for `own` alone sees neither on its board.
      expect(await board(w, w.viewer)).toBe(before);

      // The claim's brief counts what waits within the task's label, by kind in words.
      const aTask = ids[rows.findIndex((row) => row.label.join() === A.join())] ?? "";
      const claimed = ok(await w.work.claimOpportunity(w.qa.token, { id: aTask as never, requestId: request() }));
      expect((claimed as { brief?: { handover?: unknown } }).brief?.handover).toEqual({
        waiting: [
          { kind: "goal_proposal", words: "proposed changes to your goals", count: 1 },
          { kind: "question_rule", words: "proposed rules for questions", count: 1 },
        ],
        link: `https://${HOST}/#today`,
      });

      // The wide card answered: the same labels and subjects, the same tasks, nothing new for anyone.
      await answer(w, wideA, "decline");
      const after = await state(w);
      expect(after.map((row) => row.subject)).toEqual(rows.map((row) => row.subject));
      for (const [at, row] of after.entries()) expect(await raise(w, row.subject)).toEqual([{ id: ids[at] }]);
    }));

  it("raises no task again today once one under a label ended, whatever arrives after", () =>
    inWorld(async (w) => {
      await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: A });
      const [row] = (await state(w)).filter((one) => one.label.join() === A.join());
      const [flag] = await raise(w, row?.subject ?? "");
      await asOwner(
        w.db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'done', now(), 'system:test', $2)",
        [flag?.id, A],
      );
      await waitingCard(w, "question_rule", ["confirm", "decline"], { label: A });
      const [later] = (await state(w)).filter((one) => one.label.join() === A.join());
      expect(later).toMatchObject({ subject: row?.subject, waiting: 2, ended_today: true });
      expect(ownerQueueGaps(later === undefined ? [] : [later], new Date())).toEqual([]);
    }));

  it("spends the day only once an agent told the owner: a task the tick withdrew is raised again when a card waits again", () =>
    inWorld(async (w) => {
      const first = await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: A });
      expect(await tick(w)).toEqual({ raised: 1, closed: 0 });
      const [withdrawn] = await handovers(w, A);
      // Nothing waits a moment: the tick withdraws the task nobody claimed, and nobody was told.
      await answer(w, first);
      expect(await tick(w)).toEqual({ raised: 0, closed: 1 });
      await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: A });
      expect(await tick(w)).toEqual({ raised: 1, closed: 0 });
      const ids = await handovers(w, A);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(withdrawn);
      // Told: the agent reports the second done. A card arriving after raises nothing more today.
      await asOwner(
        w.db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'done', now(), $2, $3)",
        [ids[1], w.qa.id, A],
      );
      await waitingCard(w, "question_rule", ["confirm", "decline"], { label: A });
      expect(await tick(w)).toEqual({ raised: 0, closed: 0 });
      expect(await handovers(w, A)).toEqual(ids);
    }));

  it("lists no gap once nothing waits, so the tick closes the task", () =>
    inWorld(async (w) => {
      const card = await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN });
      expect((await queueGaps(w)).length).toBe(2);
      await answer(w, card);
      expect(await queueGaps(w)).toEqual([]);
    }));

  it("raises nothing with no host for the owner's page or no question role", () =>
    inWorld(async (w) => {
      await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN });
      expect(await state(w)).toEqual([]);
      await setQuestionRole(w.admin, ROLE, new Date());
      expect(await state(w)).toEqual([]);
      expect(await queueGaps(w)).toEqual([]);
      await setOwnerPageHost(w.admin, HOST);
      expect((await state(w)).length).toBe(2);
    }, false));

  it("counts exactly the cards the owner's page shows waiting", () =>
    inWorld(async (w) => {
      const shown: string[] = [];
      const held: string[] = [];
      shown.push(await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN }));
      // A notice is shown too: the page waits on its acknowledge.
      shown.push(await waitingCard(w, "notice", ["acknowledge"], { label: OWN }));
      // Deferred: not shown.
      const deferred = await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN });
      await w.status("card", deferred, "deferred", "owner");
      held.push(deferred);
      // Under a canary compartment: never shown.
      held.push(await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: ["agent:canary-seed", "own"] }));
      // A box health card in its quiet hours, and one past them.
      held.push(await waitingCard(w, "box_health", ["seen"], { label: OWN }));
      const loud = await waitingCard(w, "box_health", ["seen"], { label: OWN });
      await aged(w, loud, 25 * 60);
      shown.push(loud);
      // Past its expiry.
      const expired = await waitingCard(w, "goal_proposal", ["accept", "reject"], { label: OWN, days: 1 });
      await asOwner(
        w.db,
        "update ledger.cards set expires_after_days = null, expires_at = now() - interval '1 minute' where id = $1",
        [expired],
      );
      held.push(expired);
      // A relay's task open and claimed: held for it; one unclaimed past the hours: handed back.
      const relayed = await decision(w, OWN);
      const relayTask = await cardFlag(w, "card_relay", relayed);
      ok(await w.work.claimOpportunity(w.qa.token, { id: relayTask, requestId: request() }));
      held.push(relayed);
      const handedBack = await decision(w, OWN);
      await cardFlag(w, "card_relay", handedBack);
      await asOwner(
        w.db,
        "update ledger.opportunities set created_at = now() - interval '7 hours' where gap_trigger = 'card_relay' and gap_subject = $1",
        [handedBack],
      );
      shown.push(handedBack);
      // An agent's claim new and with its attempt to come: held while attempts are on.
      const attempted = await waitingCard(w, "agent_claim", ["confirm", "reject"], { label: OWN });
      (attemptsOn() ? held : shown).push(attempted);

      const at = new Date().toISOString();
      const all = [...shown, ...held];
      const page = (await w.admin<{ id: string }>(`select c.id ${WAITING("$1")} and c.id = any ($2)`, [at, all])).map(
        (row) => row.id,
      );
      const ours = (
        await asOwner<{ id: string }>(
          w.db,
          "select c.id from ledger.cards c where c.id = any ($3) and ledger.owner_queue_waits(c, $1, $2)",
          [at, attemptsOn(), all],
        )
      ).map((row) => row.id);
      expect(ours.sort()).toEqual(page.sort());
      expect(page.sort()).toEqual([...shown].sort());
    }));
});
