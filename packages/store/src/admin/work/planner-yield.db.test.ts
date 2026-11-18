import { type MoveId, type OpportunityId, STAGE_PROMPT_IDS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { request, testId } from "../../test-support/clients.ts";
import { type Query, session } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import type { WorkClient } from "../../test-support/work-clients.ts";
import { withAdmin } from "../../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../../test-support/work-test-world.ts";

// `pia work report`'s planner yield: for each planner run, what it proposed, what the owner answered,
// what they accepted and what was then used, and by UTC week and prompt the cost of each accepted and
// each used item. A sign of use under a label the owner's terminal does not hold marks nothing used
// (invariant 6). Made-up values only.

const OWN = ["own"];
// A compartment the test's key file does not hold.
const UNSEEN = ["employer:other", "own"];

// One committed statement as pi_owner, as the definer functions write these rows.
const asOwner = (w: WorkWorld, text: string, values: unknown[] = []) =>
  session(w.db.urls.bootstrap, async (query: Query) => {
    await query("begin");
    await query("set local role pi_owner");
    const rows = await query(text, values);
    await query("commit");
    return rows;
  });

// A planner run as the tick queues one, taken once and finished, with one model call of the given cost.
async function plannerRun(w: WorkWorld, reasoner: WorkClient, prompt: string, cost: number): Promise<string> {
  const id = testId("run");
  await queryAs(
    w.db.urls.work,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $2, 'system:tick', '{own}', 'daily_sweep', $3, 'run_outcome', 1, $4, '1')`,
    [id, testId("req"), `daily_sweep:${id}`, prompt],
  );
  await w.status("run", id, "finished", "system:tick");
  await asOwner(
    w,
    `insert into ledger.run_attempts (run_id, attempt, request_id, created_by, session_id, compartments, client_id, taken_at, erasure_mark)
     values ($1, 1, $2, $3, $4, '{own}', $5, now(), 0)`,
    [id, testId("req"), `client:${reasoner.id}`, reasoner.session, reasoner.id],
  );
  await asOwner(
    w,
    `insert into ledger.run_steps (request_id, created_by, run_id, compartments, attempt, ordinal, client_id, kind, prompt_id, prompt_version, model_id, cost_microusd)
     values ($1, $2, $3, '{own}', 1, 1, $4, 'model_call', $5, '1', 'example/model', $6)`,
    [testId("req"), `client:${reasoner.id}`, id, reasoner.id, prompt, cost],
  );
  return id;
}

// A row a run wrote, with its case and its first event, as finish_run writes one.
async function proposed(
  w: WorkWorld,
  run: string,
  row: { rowKind: "opportunity" | "hypothesis"; kind: string; about?: string; idea?: string },
): Promise<string> {
  const id = testId(row.rowKind === "opportunity" ? "opp" : "hyp");
  const caseId = testId("cas");
  const [aboutKind, aboutId] = row.about === undefined ? ["owner", null] : ["entity", row.about];
  await asOwner(
    w,
    `insert into ledger.cases (id, request_id, created_by, run_id, compartments, row_kind, kind, about_kind, about_id, author, hypothesis_id)
     values ($1, $1, $2, $3, '{own}', $4, $5, $6, $7, 'run', $8)`,
    [caseId, `run:${run}`, run, row.rowKind, row.kind, aboutKind, aboutId, row.idea ?? null],
  );
  if (row.rowKind === "opportunity")
    await asOwner(
      w,
      `insert into ledger.opportunities (id, request_id, created_by, run_id, compartments, case_id, kind, hypothesis_id, about_kind, about_id, proposed_by_class)
       values ($1, $1, $2, $3, '{own}', $4, $5, $6, $7, $8, 'run')`,
      [id, `run:${run}`, run, caseId, row.kind, row.idea ?? null, aboutKind, aboutId],
    );
  else
    await asOwner(
      w,
      `insert into ledger.hypotheses (id, request_id, created_by, run_id, compartments, case_id, kind, about_kind, about_id, about_owner)
       values ($1, $1, $2, $3, '{own}', $4, $5, $6, $7, $8)`,
      [id, `run:${run}`, run, caseId, row.kind, aboutKind, aboutId, aboutKind === "owner"],
    );
  await w.status(row.rowKind, id, row.rowKind === "opportunity" ? "proposed" : "open", `run:${run}`);
  return id;
}

// An answer of the owner's on a row, as `decide` writes it.
const answer = (w: WorkWorld, kind: string, target: string, word: string) =>
  w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'answer', $3, $4, $5, 0, '{}', '{}', now(), '{own}')`,
    [testId("rul"), testId("req"), kind, target, word],
  );

// The owner's go on an opportunity, and an agent's work on it reported done.
async function worked(
  w: WorkWorld,
  agent: WorkClient,
  intent: string,
  opportunity: string,
  kind = "investigate",
): Promise<MoveId> {
  await answer(w, "opportunity", opportunity, "go");
  await w.decideGo(opportunity, intent);
  ok(await w.work.claimOpportunity(agent.token, { id: opportunity as OpportunityId, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(agent.token, {
      opportunity: opportunity as OpportunityId,
      stage: "investigate",
      requestId: request(),
    }),
  );
  const outcome = ok(
    await w.work.reportMove(agent.token, {
      move,
      outcome: "done",
      // A follow-up's investigate stage ends in a draft for the owner.
      report:
        kind === "follow_up" ? { draft: "a short note to say hello" } : { deliverable: "two names", next: "nothing" },
      requestId: request(),
    }),
  );
  expect(outcome).not.toHaveProperty("refused");
  return move as MoveId;
}

// The owner writing to a person, a minute from now.
const wroteTo = (w: WorkWorld, person: string, compartments: string[]) =>
  w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
     values ($1, (select id from vault.evidence_items limit 1), 'owner', $2, 'outbound', 'email', $3, 'recipient', $4, '{}')`,
    [testId("itr"), person, new Date(Date.now() + 60_000), compartments],
  );

describe("the planner's yield in the work report", { timeout: DB_TEST_TIMEOUT }, () => {
  it("counts per run what was proposed, answered, accepted and used, and per week and prompt the cost of each accepted and used item", () =>
    withWorkWorld(async (w) => {
      const reasoner = await w.client("reasoner", OWN, { kind: "reasoner" });
      const agent = await w.client("scout", OWN);
      const intent = await w.intent(["investigate", "follow_up"], [agent]);
      await w.harness(agent, "investigate", "investigate");
      await w.harness(agent, "follow_up", "investigate");
      await w.message(OWN);

      const run = await plannerRun(w, reasoner, "personal_run", 1_200_000);
      const quiet = await plannerRun(w, reasoner, "personal_run", 300_000);
      const translate = await plannerRun(w, reasoner, STAGE_PROMPT_IDS.translate, 400_000);

      // Accepted, done, and the owner wrote to the person within the week: used.
      const person = await w.seed.entity("person");
      const usedWork = await proposed(w, run, { rowKind: "opportunity", kind: "investigate", about: person });
      const move = await worked(w, agent, intent, usedWork);
      await wroteTo(w, person, OWN);
      // Accepted and done, and the owner wrote to the person only under a label the report does not
      // hold: not used.
      const other = await w.seed.entity("person");
      const unseen = await proposed(w, run, { rowKind: "opportunity", kind: "investigate", about: other });
      await worked(w, agent, intent, unseen);
      await wroteTo(w, other, UNSEEN);
      // A follow-up whose agents' part ended in the owner's hands, and the owner wrote to the person: used.
      const third = await w.seed.entity("person");
      const followUp = await proposed(w, run, { rowKind: "opportunity", kind: "follow_up", about: third });
      await worked(w, agent, intent, followUp, "follow_up");
      expect(await w.latest("opportunity", followUp)).toBe("handed_to_owner");
      await wroteTo(w, third, OWN);
      // Answered no.
      const declined = await proposed(w, run, { rowKind: "opportunity", kind: "investigate" });
      await answer(w, "opportunity", declined, "no_go");
      // An idea pursued, and an opportunity resting on it accepted: used.
      const idea = await proposed(w, run, { rowKind: "hypothesis", kind: "idea", about: person });
      await answer(w, "hypothesis", idea, "pursue");
      const resting = await proposed(w, translate, { rowKind: "opportunity", kind: "investigate", idea });
      await answer(w, "opportunity", resting, "go");
      // A lesson confirmed, and a move's report named it: used.
      const lesson = await proposed(w, run, { rowKind: "hypothesis", kind: "lesson" });
      await answer(w, "hypothesis", lesson, "confirm");
      await asOwner(
        w,
        "insert into ledger.move_lessons (created_by, session_id, move_id, lesson_id, compartments) values ($1, $2, $3, $4, '{own}')",
        [`client:${agent.id}`, agent.session, move, lesson],
      );
      // Not answered.
      const waiting = await proposed(w, run, {
        rowKind: "opportunity",
        kind: "investigate",
        about: await w.seed.entity("person"),
      });

      const report = await withAdmin(w, (admin) => admin.work.report(7));
      const runOf = (id: string) => report.runs.find((one) => one.id === id);
      expect(runOf(run)?.yield).toEqual({ proposed: 7, answered: 6, accepted: 5, used: 4 });
      expect(runOf(quiet)?.yield).toEqual({ proposed: 0, answered: 0, accepted: 0, used: 0 });
      expect(runOf(translate)?.yield).toEqual({ proposed: 1, answered: 1, accepted: 1, used: 0 });
      expect(
        Object.fromEntries((runOf(run)?.proposals ?? []).map((one) => [one.id, [one.accepted, one.used]])),
      ).toEqual({
        [usedWork]: [true, true],
        [unseen]: [true, false],
        [followUp]: [true, true],
        [declined]: [false, false],
        [idea]: [true, true],
        [lesson]: [true, true],
        [waiting]: [false, false],
      });

      const week = new Date();
      week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
      expect(report.plannerYield).toEqual([
        {
          week: week.toISOString().slice(0, 10),
          prompt: "personal_run",
          runs: 2,
          proposing: 1,
          costMicroUsd: 1_500_000,
          proposed: 7,
          answered: 6,
          accepted: 5,
          used: 4,
          costPerAcceptedMicroUsd: 300_000,
          costPerUsedMicroUsd: 375_000,
        },
        {
          week: week.toISOString().slice(0, 10),
          prompt: STAGE_PROMPT_IDS.translate,
          runs: 1,
          proposing: 1,
          costMicroUsd: 400_000,
          proposed: 1,
          answered: 1,
          accepted: 1,
          used: 0,
          costPerAcceptedMicroUsd: 400_000,
          costPerUsedMicroUsd: null,
        },
      ]);

      // The owner's Not useful on the used work's result outranks what code showed.
      await w.admin(
        `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
         values ($1, $2, 'result_eval', 'move', $3, 'not_useful', 0, '{}', '{"reason":"not_worth_it"}', now(), '{own}')`,
        [testId("rul"), testId("req"), move],
      );
      const judged = await withAdmin(w, (admin) => admin.work.report(7));
      expect(judged.runs.find((one) => one.id === run)?.yield.used).toBe(3);
    }));
});
