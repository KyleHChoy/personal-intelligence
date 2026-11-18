import { DECISION_POINT_PINS, type DecisionPointCall, type RunId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, sha256Hex } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";
import { endRun } from "../work/dispatch-expiry.ts";
import { LESSONS_RETRY, type WakeCandidate, wakeCandidates } from "../work/dispatch-wakes.ts";
import { queueRun } from "../work/dispatch-write.ts";

// The dispatcher's failure rules, on synthetic rows: a failed lessons run tried once more; and a
// lapsed lease ends its opportunity's unreported move `failed`, code `abandoned`.

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

const candidatesOf = (w: WorkWorld, source: string): Promise<WakeCandidate[]> =>
  session(w.db.urls.work, async (query) =>
    (await wakeCandidates(query, new Date())).filter((one) => one.source === source),
  );
const queue = (w: WorkWorld, candidate: WakeCandidate): Promise<RunId | null> =>
  session(w.db.urls.work, (query) => queueRun(query, candidate, RUN, new Date()));
// A run ended as the reasoner's finish_run or a lapse ends one, with its code.
const fail = (w: WorkWorld, run: RunId, code: string): Promise<boolean> =>
  session(w.db.urls.work, (query) => endRun(query, run, "failed", code));

describe("the lessons run fails small", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a failed lessons run is tried once more, as it was queued, and a failed retry is not", () =>
    withWorkWorld(async (w) => {
      await w.client("reasoner", ["own"], { kind: "reasoner" });
      const run = (await queue(w, {
        source: "lessons_due",
        wakeKey: "lessons:1",
        anchors: [],
        compartments: ["own"],
        vetoed: false,
        lessons: [],
      })) as RunId;
      expect(run).toMatch(/^run_/);
      // Queued, not failed: no retry.
      expect(await candidatesOf(w, "lessons_due")).toEqual([]);
      await fail(w, run, "unavailable");
      const [retry, ...more] = await candidatesOf(w, "lessons_due");
      expect(more).toEqual([]);
      expect(retry).toMatchObject({ wakeKey: `lessons:1${LESSONS_RETRY}`, compartments: ["own"], lessons: [] });
      const second = (await queue(w, retry as WakeCandidate)) as RunId;
      await fail(w, second, "unavailable");
      expect(await candidatesOf(w, "lessons_due")).toEqual([]);
    }));
});

describe("a lapsed lease ends its unreported move", { timeout: DB_TEST_TIMEOUT }, () => {
  it("one failed event with the code abandoned, on the open move alone, written by the tick's expiry", () =>
    withWorkWorld(async (w) => {
      const client: WorkClient = await w.client("runner", ["own"], { tools: [...AGENT_WORK_TOOLS, "propose_task"] });
      await w.harness(client, "investigate", "investigate");
      await setTaskTier(w.admin, true, new Date());
      const subject = await w.seed.entity("person");
      await w.seed.account(["own"], subject);
      const message = await w.message(["own"]);
      await w.seed.pipelineItem(["own"], message.evidence);
      await w.admin(
        "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
        [message.evidence],
      );
      const { opportunity } = ok(
        await w.work.proposeTask(client.token, {
          kind: "investigate",
          about: { kind: "entity", id: subject as never },
          summary: "find who runs it",
          basis: [{ kind: "message", id: message.id as never }],
          requestId: request(),
        }),
      );
      ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(client.token, { opportunity, stage: "investigate", requestId: request() }),
      );
      await queryAs(
        w.db.urls.work,
        "update queue.leases set lease_until = now() - interval '1 minute' where resource_id = $1",
        [opportunity],
      );
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const now = new Date();
        for (const one of (await dispatch.expired(now)).filter((item) => item.kind === "opportunity_lease"))
          expect(await dispatch.expire(one, now)).toBe(true);
      } finally {
        await dispatch.close();
      }
      expect(
        await w.admin(
          "select event, code, by from ledger.record_events where row_kind = 'move' and row_id = $1 order by id",
          [move],
        ),
      ).toEqual([
        { event: "cleared", code: null, by: expect.any(String) },
        { event: "failed", code: "abandoned", by: "system:work" },
      ]);
    }));
});
