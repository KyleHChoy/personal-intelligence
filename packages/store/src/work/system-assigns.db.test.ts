import {
  type AgentRecordId,
  type AutonomyRules,
  GAP_ASK,
  GAP_MISSING,
  type GapTrigger,
  type OpportunityId,
} from "@intelligence/contracts/personal";
import { autonomyRules, gapKey, planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { ownerCommitted } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";

// Synthetic rows.

const OWN = ["own"];
const WORK = ["employer:example", "own"];
const KEYS = ["own", "employer:example", "agent:scout"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ON: AutonomyRules = {
  ...autonomyRules(),
  goalReviewOn: true,
  goalReviewDays: 14,
  meetingFollowUpOn: true,
  meetingFollowUpHours: 36,
};
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const dispatching = async <T>(w: WorkWorld, fn: (dispatch: ReturnType<typeof createDispatch>) => Promise<T>) => {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    return await fn(dispatch);
  } finally {
    await dispatch.close();
  }
};

const found = (w: WorkWorld, now: Date, rules: AutonomyRules, trigger: GapTrigger): Promise<string[]> =>
  dispatching(w, async (dispatch) =>
    (await dispatch.gapCandidates(now, rules))
      .filter((gap) => gap.trigger === trigger)
      .map((gap) => gap.subject)
      .sort(),
  );

// The tick's plan at `now`: what it would raise of `trigger`, and whether that was raised.
const raiseAll = (w: WorkWorld, now: Date, trigger?: GapTrigger): Promise<string[]> =>
  dispatching(w, async (dispatch) => {
    const flags = await dispatch.gapFlags(now);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(now, ON),
      open: flags.open,
      history: flags.history,
    });
    const raised: string[] = [];
    for (const { gap, card } of plan.raise) {
      await dispatch.raiseGapFlag(gap, !card);
      if (trigger === undefined || gap.trigger === trigger) raised.push(gap.subject);
    }
    return raised;
  });

// An active goal last changed `days` ago.
async function goal(w: WorkWorld, compartments: string[], days: number, now: Date): Promise<string> {
  const id = await w.goal(compartments, "a synthetic goal");
  await w.admin("update projections.goal_state set stated_at = $2, updated_at = $2 where goal_id = $1", [
    id,
    at(now, -days * DAY).toISOString(),
  ]);
  return id;
}

// Another opportunity of the goal under `compartments`, with an event `by` wrote on it now.
async function moved(w: WorkWorld, goalId: string, compartments: string[], by: string): Promise<void> {
  const id = await w.seed.opportunity(compartments);
  await ownerCommitted(w.db, async (query) => {
    await query("update ledger.opportunities set goal_id = $2 where id = $1", [id, goalId]);
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'claimed', now(), $2, $3)",
      [id, by, compartments],
    );
  });
}

// An idea `by` wrote, citing the goal now, under `compartments`.
async function cited(w: WorkWorld, goalId: string, compartments: string[], by: string): Promise<void> {
  const id = await w.seed.hypothesis(compartments);
  await ownerCommitted(w.db, async (query) => {
    await query("update ledger.hypotheses set created_by = $2 where id = $1", [id, by]);
    await query(
      "insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, source_class, compartments, added_at) values ('hypothesis', $1, 'goal', $2, 'agent', $3, now())",
      [id, goalId, compartments],
    );
  });
}

// A finding filed now under a project of the goal: the project under `project`, the finding under
// `finding`, flagged or not.
async function filed(
  w: WorkWorld,
  goalId: string,
  label: { project: string[]; finding: string[] },
  flagged = false,
): Promise<void> {
  const project = (await w.seed.into("knowledge.projects")(label.project)) as string;
  const { id } = (await w.seed.into("ledger.agent_writes")(label.finding)) as { id: string };
  await ownerCommitted(w.db, async (query) => {
    await query("update knowledge.projects set goal_id = $2 where id = $1", [project, goalId]);
    await query(
      "update ledger.agent_writes set kind = 'finding', project_id = $2, created_at = now(), flagged_at = $3 where id = $1",
      [id, project, flagged ? new Date().toISOString() : null],
    );
  });
}

type Meeting = { person?: boolean; recurring?: boolean; cancelled?: boolean; allDay?: boolean; response?: string };
async function meeting(w: WorkWorld, compartments: string[], ends: Date, shape: Meeting = {}): Promise<string> {
  const id = await w.seed.event(compartments);
  await w.seed.eventDetails(compartments, id);
  await w.admin(
    "update knowledge.event_details set starts_at = $2, ends_at = $3, all_day = $4, recurring = $5, cancelled = $6, owner_response = $7 where event_id = $1",
    [
      id,
      at(ends, -HOUR).toISOString(),
      ends.toISOString(),
      shape.allDay ?? false,
      shape.recurring ?? false,
      shape.cancelled ?? false,
      shape.response ?? null,
    ],
  );
  if (shape.person !== false) {
    const person = await w.seed.entity("person");
    await w.seed.account(compartments, person);
    await w.admin(
      "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
      [id, person, compartments],
    );
  }
  return id;
}

async function scout(w: WorkWorld): Promise<WorkClient> {
  await setTaskTier(w.admin, true, new Date());
  // Cleared for its own compartment too, where its records are kept.
  const client = await w.client("scout", ["own", "agent:scout"], { tools: READING_AGENT_TOOLS });
  await w.harness(client, "research", "investigate");
  return client;
}

// The review of a goal, raised: its id.
async function review(w: WorkWorld, goalId: string, now: Date): Promise<OpportunityId> {
  expect(await raiseAll(w, now, "goal_review")).toEqual([goalId]);
  const [row] = await w.admin<{ id: OpportunityId }>(
    "select id from ledger.opportunities where gap_trigger = 'goal_review' and gap_subject = $1",
    [goalId],
  );
  return row?.id as OpportunityId;
}

// An agent claims the review, plans a move, and reports it done with a finding, or failed.
async function worked(w: WorkWorld, agent: WorkClient, id: OpportunityId, outcome: "done" | "failed") {
  ok(await w.work.claimOpportunity(agent.token, { id, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(agent.token, { opportunity: id, stage: "investigate", requestId: request() }),
  );
  if (outcome === "failed") {
    ok(
      await w.work.reportMove(agent.token, {
        move,
        outcome: "failed",
        report: { reason: "Nothing on file bears on the goal." },
        requestId: request(),
      }),
    );
    return;
  }
  const record = ok(
    await w.reader.record(agent.token, {
      kind: "finding",
      body: "the goal is stuck on one reply",
      requestId: request(),
    }),
  ).recordId as AgentRecordId;
  ok(
    await w.work.reportMove(agent.token, {
      move,
      outcome: "done",
      report: {
        deliverable: "what moved and what is stuck",
        next: "ask for the reply",
        sources: [{ kind: "agent_record", id: record }],
      },
      requestId: request(),
    }),
  );
}

// Whether the goal's review is quiet at `when`, and what the plan would raise of it then.
const quietAt = (w: WorkWorld, goalId: string, when: Date) =>
  dispatching(w, async (dispatch) => {
    const flags = await dispatch.gapFlags(when);
    const key = gapKey({ trigger: "goal_review", subject: goalId, labelKey: "own" });
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(when, ON),
      open: flags.open,
      history: flags.history,
    });
    return {
      quiet: flags.history.quiet.has(key),
      raised: plan.raise.filter((one) => one.gap.trigger === "goal_review").map((one) => one.gap.subject),
    };
  });

describe("goal_review", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is on in the rule data, and reads only while its switch is on", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const id = await goal(w, OWN, 20, now);
      expect(autonomyRules().goalReviewOn).toBe(true);
      expect(await found(w, now, autonomyRules(), "goal_review")).toEqual([id]);
      expect(await found(w, now, { ...ON, goalReviewOn: false }, "goal_review")).toEqual([]);
    }));

  it("work is what the owner or an agent did on the goal within its label; code, a planner run and a wider label are not", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const quiet = await goal(w, OWN, 20, now);
      await goal(w, OWN, 3, now);
      const paused = await goal(w, OWN, 20, now);
      await w.admin("update projections.goal_state set status = 'paused' where goal_id = $1", [paused]);
      // Events on another opportunity of the goal: an agent's and the owner's are work; code's and a
      // planner run's are not, nor an agent's under a label wider than the goal's.
      const byAgent = await goal(w, OWN, 20, now);
      await moved(w, byAgent, OWN, `client:${testId("cli")}`);
      const byOwner = await goal(w, OWN, 20, now);
      await moved(w, byOwner, OWN, "owner");
      const byCode = await goal(w, OWN, 20, now);
      await moved(w, byCode, OWN, "system:gaps");
      const byRun = await goal(w, OWN, 20, now);
      await moved(w, byRun, OWN, `run:${testId("run")}`);
      const wider = await goal(w, OWN, 20, now);
      await moved(w, wider, WORK, `client:${testId("cli")}`);
      // An idea citing the goal: an agent's is work; a planner run's is not, nor one under a wider label.
      const ideaAgent = await goal(w, OWN, 20, now);
      await cited(w, ideaAgent, OWN, `client:${testId("cli")}`);
      const ideaRun = await goal(w, OWN, 20, now);
      await cited(w, ideaRun, OWN, `run:${testId("run")}`);
      const ideaWider = await goal(w, OWN, 20, now);
      await cited(w, ideaWider, WORK, `client:${testId("cli")}`);
      // A finding under a project of the goal is work; a flagged one is not, nor one whose project or
      // finding is under a wider label.
      const finding = await goal(w, OWN, 20, now);
      await filed(w, finding, { project: OWN, finding: OWN });
      const flagged = await goal(w, OWN, 20, now);
      await filed(w, flagged, { project: OWN, finding: OWN }, true);
      const projectWider = await goal(w, OWN, 20, now);
      await filed(w, projectWider, { project: WORK, finding: OWN });
      expect(await found(w, now, ON, "goal_review")).toEqual(
        [quiet, byCode, byRun, wider, ideaRun, ideaWider, flagged, projectWider].sort(),
      );
    }));

  it("raises nothing for a goal under a restricted label, nor over a veto of research", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const open = await goal(w, OWN, 20, now);
      // A goal's row moved under a restricted label, as no key file here may hold one.
      const restricted = await goal(w, OWN, 20, now);
      await ownerCommitted(w.db, (query) =>
        query("update projections.goal_state set compartments = $2 where goal_id = $1", [
          restricted,
          ["own", "restricted:health"],
        ]),
      );
      expect(await found(w, now, ON, "goal_review")).toEqual([open]);
      await w.vetoKind("research");
      expect(await found(w, now, ON, "goal_review")).toEqual([]);
    }));

  it("raises a task for its goal under the goal's label; an agent claiming and reporting it is not work on the goal", () =>
    withWorkWorld(async (w) => {
      const agent = await scout(w);
      const now = new Date();
      const id = await goal(w, OWN, 20, now);
      const task = await review(w, id, now);
      expect(
        await w.admin("select gap_subject, goal_id, about_kind, tier from ledger.opportunities where id = $1", [task]),
      ).toEqual([{ gap_subject: id, goal_id: id, about_kind: "owner", tier: "task" }]);
      const board = ok(await w.work.listOpportunities(agent.token, { scope: "board" })).opportunities;
      const seen = board.filter((one) => one.gap?.trigger === "goal_review");
      expect(seen.map((one) => one.id)).toEqual([task]);
      expect(seen[0]?.gap).toMatchObject({ missing: GAP_MISSING.goal_review, ask: GAP_ASK.goal_review });
      await worked(w, agent, task, "done");
      // The agent's claim, move and report on the review are by `client:`, and the goal still holds.
      expect(
        (
          await w.admin<{ by: string }>(
            "select distinct by from ledger.record_events where row_kind = 'opportunity' and row_id = $1 and by like 'client:%'",
            [task],
          )
        ).length,
      ).toBe(1);
      expect(await found(w, now, ON, "goal_review")).toEqual([id]);
    }, KEYS));

  // Any end of a review quiets its goal for GAP_QUIET_DAYS (30), past the seven days' rest other
  // undated triggers take.
  for (const end of ["done", "failed", "expired_unclaimed"] as const)
    it(`a review that ended ${end} quiets its goal for 30 days, not 7`, () =>
      withWorkWorld(async (w) => {
        const agent = await scout(w);
        const now = new Date();
        const id = await goal(w, OWN, 20, now);
        const task = await review(w, id, now);
        if (end === "expired_unclaimed")
          // As the tick's expiry writes it, 14 days after an unclaimed go.
          await ownerCommitted(w.db, (query) =>
            query(
              "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'expired', now(), 'system:work', $2)",
              [task, OWN],
            ),
          );
        else await worked(w, agent, task, end);
        expect(await w.latest("opportunity", task)).toBe(
          end === "expired_unclaimed" ? "expired" : end === "done" ? "done" : "withdrawn",
        );
        expect(await quietAt(w, id, now)).toEqual({ quiet: true, raised: [] });
        expect(await quietAt(w, id, at(now, 8 * DAY))).toEqual({ quiet: true, raised: [] });
        expect(await quietAt(w, id, at(now, 31 * DAY))).toEqual({ quiet: false, raised: [id] });
      }, KEYS));
});

describe("meeting_followup", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is on in the rule data, and reads only while its switch is on", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const id = await meeting(w, OWN, at(now, -2 * HOUR));
      expect(autonomyRules().meetingFollowUpOn).toBe(true);
      expect(await found(w, now, autonomyRules(), "meeting_followup")).toEqual([id]);
      expect(await found(w, now, { ...ON, meetingFollowUpOn: false }, "meeting_followup")).toEqual([]);
    }));

  it("finds a meeting with a person on it, that the owner accepted or organised, that ended within the window, and no other", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const ended = [
        await meeting(w, OWN, at(now, -2 * HOUR)),
        await meeting(w, OWN, at(now, -2 * HOUR), { response: "accepted" }),
        await meeting(w, WORK, at(now, -30 * HOUR)),
      ].sort();
      await meeting(w, OWN, at(now, -2 * HOUR), { response: "declined" });
      await meeting(w, OWN, at(now, -2 * HOUR), { response: "needsAction" });
      await meeting(w, OWN, at(now, -2 * HOUR), { response: "tentative" });
      await meeting(w, OWN, at(now, -2 * HOUR), { person: false });
      await meeting(w, OWN, at(now, -2 * HOUR), { recurring: true });
      await meeting(w, OWN, at(now, -2 * HOUR), { cancelled: true });
      await meeting(w, OWN, at(now, -2 * HOUR), { allDay: true });
      await meeting(w, OWN, at(now, -40 * HOUR));
      await meeting(w, OWN, at(now, HOUR));
      expect(await found(w, now, ON, "meeting_followup")).toEqual(ended);
    }));

  it("raises a task about the meeting under its label, which an agent is told how to do", () =>
    withWorkWorld(async (w) => {
      const agent = await scout(w);
      const now = new Date();
      const id = await meeting(w, OWN, at(now, -2 * HOUR));
      await meeting(w, WORK, at(now, -2 * HOUR));
      await raiseAll(w, now);
      const rows = await w.admin<{ compartments: string[] }>(
        "select compartments from ledger.opportunities where gap_trigger = 'meeting_followup' order by compartments",
      );
      expect(rows).toHaveLength(2);
      const board = ok(await w.work.listOpportunities(agent.token, { scope: "board" })).opportunities;
      const seen = board.filter((one) => one.gap?.trigger === "meeting_followup");
      expect(seen.map((one) => one.about)).toEqual([{ kind: "event", id }]);
      expect(seen[0]?.gap).toMatchObject({ missing: GAP_MISSING.meeting_followup, ask: GAP_ASK.meeting_followup });
    }));
});
