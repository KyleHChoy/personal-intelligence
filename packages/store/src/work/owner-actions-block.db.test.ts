import {
  type CardId,
  DECISION_POINT_PINS,
  type DecisionPointCall,
  type NewCard,
  type RunId,
  type RunRequest,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import { queueTrial } from "../admin/work/admin-trials.ts";
import { newId } from "../core/ids.ts";
import { request, sha256Hex, testId } from "../test-support/clients.ts";
import { type Query, session } from "../test-support/connections.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { withWorkAdmin as withOwner } from "../test-support/work-seeds.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { actionsDue, ownerActionsBlock, type WakeCandidate, wakeCandidates } from "./dispatch-wakes.ts";
import { queueRun } from "./dispatch-write.ts";

// Made-up values only.

const BOTH = ["employer:example", "own"];
const TOOLS = [
  "get_self",
  "list_opportunities",
  "claim_opportunity",
  "release_opportunity",
  "propose_opportunity",
  "propose_hypothesis",
  "get_suggestions",
];
const TRIAL = { model: "anthropic/claude-haiku-5.5", effort: "low" } as const;

const RUN: DecisionPointCall = {
  point: "wake_worth_run",
  version: 1,
  definitionHash: DECISION_POINT_PINS["wake_worth_run@1"] ?? "",
  rung: 0,
  inputHash: sha256Hex("wake_worth_run:run"),
  output: "run",
  effect: "start_run",
  effectClass: "internal_reversible",
  escalated: false,
};

// One committed transaction as pi_work, the tick's role.
async function asTick<T>(w: WorkWorld, fn: (query: Query) => Promise<T>): Promise<T> {
  return session(w.db.urls.work, async (query) => {
    await query("begin");
    const result = await fn(query);
    await query("commit");
    return result;
  });
}

// A `plan`-kind decision the tick reads, as pi_admin writes one; a commitment close has no target.
async function decide(
  w: WorkWorld,
  options: { kind?: string; compartments?: string[]; target?: [string, string] } = {},
): Promise<string> {
  const id = testId("rul");
  await w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, $3, $4, $5, $6, 0, '{}', '{}', clock_timestamp(), $7)`,
    [
      id,
      testId("req"),
      options.kind ?? "commitment_close",
      options.target?.[0] ?? null,
      options.target?.[1] ?? null,
      options.kind === undefined ? "done" : null,
      options.compartments ?? ["own"],
    ],
  );
  return id;
}

// The lessons run the tick queues for a batch, as the wake does once lessons 5 is switched on.
async function queueLessons(
  w: WorkWorld,
  clearance: string[],
  batches: number,
): Promise<{ run: RunId | null; candidate: WakeCandidate | null }> {
  return asTick(w, async (query) => {
    const due = await actionsDue(query, clearance, batches);
    if (due === null) return { run: null, candidate: null };
    const candidate: WakeCandidate = {
      source: "lessons_due",
      wakeKey: due.key,
      anchors: [],
      compartments: due.block.compartments,
      vetoed: false,
      lessons: [],
      decisions: due.block.decisions,
      cursor: due.block.cursor,
    };
    return { run: await queueRun(query, candidate, RUN, new Date()), candidate };
  });
}

const rowOf = async (w: WorkWorld, run: string) =>
  (
    await w.admin<{
      compartments: string[];
      decisions: string[] | null;
      decisions_cursor: string | null;
      wake_key: string;
    }>("select compartments, decisions, decisions_cursor, wake_key from ledger.runs where id = $1", [run])
  )[0];

const ref = (message: Message) => ({ kind: "message" as const, id: message.id as never });
const proposed = async (w: WorkWorld, client: WorkClient, summary: string): Promise<string> => {
  const about = await w.message(client.compartments);
  return ok(
    await w.work.proposeOpportunity(client.token, {
      kind: "investigate",
      about: ref(about),
      summary,
      basis: [ref(about)],
      requestId: request(),
    }),
  ).opportunity;
};

const taken = async (w: WorkWorld, reasoner: WorkClient): Promise<RunRequest> => {
  const run = ok(await w.work.nextRun(reasoner.token, { requestId: request() })).run;
  if (run === null) throw new Error("no run was taken");
  return run;
};

describe("lessons runs see what the owner did", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("shows each decision to one run, newest first, as lines code built, and starts nowhere before the switch", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const agent = await w.client("alpha", ["own"], { tools: TOOLS });
      // The goal's own goal_set names no target here, so its line has no text; the owner's reword does.
      const goal = await w.goal(["own"], "Run the spring marathon");
      await decide(w, { kind: "goal_reword", target: ["goal", goal] });
      const opportunity = await proposed(w, agent, "find the harbour master");
      await withOwner(w, async (admin) => {
        const card: NewCard = {
          id: newId("crd") as CardId,
          requestId: testId("req"),
          kind: "opportunity_decision",
          author: "reasoner",
          options: [...(CARD_KINDS.opportunity_decision?.options ?? [])],
          target: { kind: "opportunity", id: opportunity } as never,
          refs: [],
          compartments: ["own"],
          expiresAt: null,
          expiresAfterDays: 14,
          caseKey: null,
          run: null,
          body: null,
          bodyFrom: null,
        };
        await admin.cards.raiseCard(card);
        await admin.cards.decide({
          cards: [card.id],
          answer: "no_go",
          reason: "wrong_timing",
          note: "not this spring",
          requestId: testId("req"),
        } as never);
      });
      // Under run_outcome@13 (lessons 4) the wake queues lessons runs as before: no block.
      await w.admin("update policy.work_settings set lessons_every = 1");
      const before = await asTick(w, (query) => wakeCandidates(query, new Date()));
      const lessons = before.find((one) => one.source === "lessons_due");
      expect(lessons).toBeDefined();
      expect(lessons?.decisions).toBeUndefined();
      expect(lessons?.compartments).toEqual(["own"]);

      const first = await queueLessons(w, ["own"], 1);
      expect(first.run).not.toBeNull();
      const one = await rowOf(w, first.run as string);
      expect(one?.decisions).toHaveLength(3);
      expect(one?.decisions_cursor).toBe([...(one?.decisions ?? [])].sort().at(-1));
      const shown = await taken(w, reasoner);
      expect(shown.id).toBe(first.run);
      expect(shown.actions?.map((line) => line.decision).sort()).toEqual([...(one?.decisions ?? [])].sort());
      // Newest first: the answer from the owner, their reword, the goal they set; their reason and note
      // marked as theirs.
      expect(shown.actions?.map((line) => line.did)).toEqual(["answered a card", "reworded a goal", "set a goal"]);
      // A card with no body of its own: the line's text is what it asks about.
      expect(shown.actions?.[0]).toMatchObject({
        answer: "no_go",
        object: "an opportunity_decision card",
        text: { untrusted: "find the harbour master" },
        his: { reason: "wrong_timing", note: { untrusted: "not this spring" } },
      });
      expect(shown.actions?.[1]).toMatchObject({ object: "a goal", text: { untrusted: "Run the spring marathon" } });
      expect(shown.actions?.[2]?.text).toBeUndefined();

      // The next batch starts after the cursor: only what came since.
      const later = await decide(w);
      expect((await queueLessons(w, ["own"], 1)).run).toBeNull();
      const second = await queueLessons(w, ["own"], 2);
      expect((await rowOf(w, second.run as string))?.decisions).toEqual([later]);
    }));

  it("queues a second run for a burst of 70, each decision shown once", () =>
    withWorkWorld(async (w) => {
      const earlier = await decide(w);
      const first = await queueLessons(w, ["own"], 1);
      expect((await rowOf(w, first.run as string))?.decisions).toEqual([earlier]);
      const burst: string[] = [];
      for (let i = 0; i < 70; i += 1) burst.push(await decide(w));
      const second = await queueLessons(w, ["own"], 7);
      const full = await rowOf(w, second.run as string);
      expect(full?.decisions).toHaveLength(60);
      expect(full?.wake_key).toBe("lessons:7");
      // The batch's key is used; the full run's cursor queues the next.
      const third = await queueLessons(w, ["own"], 7);
      const rest = await rowOf(w, third.run as string);
      expect(rest?.wake_key).toBe(`lessons:after:${full?.decisions_cursor}`);
      expect(rest?.decisions).toHaveLength(10);
      expect([...(full?.decisions ?? []), ...(rest?.decisions ?? [])].sort()).toEqual([...burst].sort());
      // Nothing waits, and nothing is shown twice.
      expect((await queueLessons(w, ["own"], 7)).run).toBeNull();
    }));

  // A full first run, the newest 60, leaves nothing waiting, so a decision made
  // after it waits for its batch; and a run's label covers the cases its closed block may show.
  it("wakes no extra run for a decision made after a full run, and labels a run with the cases it may read", () =>
    withWorkWorld(async (w) => {
      const agent = await w.client("alpha", BOTH, { tools: TOOLS });
      const work = await proposed(w, agent, "find the harbour master");
      const caseLabel = await w.label("ledger.opportunities", work);
      expect(caseLabel).toContain("employer:example");
      for (let i = 0; i < 61; i += 1) await decide(w);
      const first = await queueLessons(w, BOTH, 1);
      const row = await rowOf(w, first.run as string);
      expect(row?.decisions).toHaveLength(60);
      expect(row?.compartments).toEqual(BOTH);
      await decide(w);
      expect((await queueLessons(w, BOTH, 1)).run).toBeNull();
      expect((await rowOf(w, (await queueLessons(w, BOTH, 2)).run as string))?.decisions).toHaveLength(1);
    }, BOTH));

  it("labels the run, its lessons and their basis with the union, and a brief carries a lesson only within the client's clearance", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", BOTH, { kind: "reasoner" });
      const own = await decide(w);
      const work = await decide(w, { compartments: ["employer:example"] });
      const queued = await queueLessons(w, BOTH, 1);
      expect((await rowOf(w, queued.run as string))?.compartments).toEqual(BOTH);
      const run = await taken(w, reasoner);
      expect(run.actions?.map((line) => line.decision).sort()).toEqual([own, work].sort());
      const finished = ok(
        await w.work.finishRun(reasoner.token, {
          run: run.id as RunId,
          outcome: "finished",
          output: {
            lessons: [
              { lesson: "Closes his work commitments himself.", basis: [{ kind: "decision", id: work as never }] },
            ],
          },
          requestId: request(),
        }),
      );
      expect(finished.outcome).toBe("finished");
      const [lesson] = await w.admin<{ id: string; compartments: string[] }>(
        "select id, compartments from ledger.hypotheses where run_id = $1 and kind = 'lesson'",
        [run.id],
      );
      expect(lesson?.compartments).toEqual(BOTH);
      expect(
        await w.admin(
          "select ref_kind, ref_id, compartments from ledger.basis where row_kind = 'hypothesis' and row_id = $1",
          [lesson?.id],
        ),
      ).toEqual([{ ref_kind: "decision", ref_id: work, compartments: BOTH }]);

      // A lesson citing a decision its run was not shown fails the run, writing nothing.
      await decide(w);
      await queueLessons(w, BOTH, 2);
      const next = await taken(w, reasoner);
      const refused = ok(
        await w.work.finishRun(reasoner.token, {
          run: next.id as RunId,
          outcome: "finished",
          output: { lessons: [{ lesson: "Closes things fast.", basis: [{ kind: "decision", id: own as never }] }] },
          requestId: request(),
        }),
      );
      expect(refused.outcome).toBe("failed");
      expect(await w.admin("select id from ledger.hypotheses where run_id = $1", [next.id])).toEqual([]);

      // Confirmed, the lesson reaches the brief of a client cleared for both compartments, never
      // one cleared for `own` alone.
      await w.status("hypothesis", lesson?.id as string, "confirmed");
      const briefLessons = async (compartments: string[]): Promise<string[]> => {
        const agent = await w.client(`agent-${compartments.length}`, compartments, { tools: TOOLS });
        const intent = await w.intent(["investigate"], [agent]);
        await w.harness(agent, "investigate", "investigate");
        const held = await proposed(w, agent, "find the marina owner");
        await w.decideGo(held, intent);
        const claimed = ok(await w.work.claimOpportunity(agent.token, { id: held as never, requestId: request() }));
        return (claimed.brief?.lessons ?? []).map((one) => one.id as string);
      };
      expect(await briefLessons(BOTH)).toEqual([lesson?.id]);
      expect(await briefLessons(["own"])).toEqual([]);
    }, BOTH));

  it("gives a run the same request with or without a decision outside its clearance, and a trial writes nothing", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", ["own"], { kind: "reasoner" });
      const shown = [await decide(w), await decide(w)];
      const trial = async (): Promise<RunRequest> => {
        await session(w.db.urls.admin, (query) =>
          queueTrial(query, { stage: "lessons", trial: TRIAL, promptVersion: "5" }, new Date()),
        );
        return taken(w, reasoner);
      };
      const blockBefore = await asTick(w, (query) => ownerActionsBlock(query, ["own"], null));
      const first = await trial();
      expect(first.point.promptVersion).toBe("5");
      expect(first.actions?.map((line) => line.decision).sort()).toEqual([...shown].sort());

      // Outside the reasoner's clearance: a decision's label, and its target's.
      await decide(w, { compartments: ["employer:example"] });
      const elsewhere = await w.goal(["employer:example"], "A goal under another label");
      await decide(w, { kind: "goal_reword", target: ["goal", elsewhere] });
      expect(await asTick(w, (query) => ownerActionsBlock(query, ["own"], null))).toEqual(blockBefore);
      const second = await trial();
      expect(JSON.stringify({ ...second, id: first.id })).toBe(JSON.stringify(first));

      // A trial writes nothing but its output, and moves no cursor.
      const done = ok(
        await w.work.finishRun(reasoner.token, {
          run: first.id as RunId,
          outcome: "finished",
          output: {
            lessons: [{ lesson: "Closes commitments himself.", basis: [{ kind: "decision", id: shown[0] as never }] }],
          },
          requestId: request(),
        }),
      );
      expect(done).toEqual({ recorded: 0, outcome: "finished" });
      expect(await w.admin("select id from ledger.hypotheses where run_id = $1", [first.id])).toEqual([]);
      expect(
        await w.admin("select id from ledger.basis where row_kind = 'hypothesis' and ref_kind = 'decision'"),
      ).toEqual([]);
      expect(await w.admin("select count(*)::int as n from ledger.runs where decisions_cursor is not null")).toEqual([
        { n: 0 },
      ]);
      expect((await rowOf(w, first.id))?.decisions?.sort()).toEqual([...shown].sort());
    }, BOTH));
});
