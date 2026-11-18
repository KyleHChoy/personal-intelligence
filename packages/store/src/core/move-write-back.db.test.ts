import { ContextPack } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { task, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "../work/dispatch.ts";

// At the store: a task's write-back is a finding alone, never a
// proposal; and a move left unreported is listed to its planner with "report or release", in
// list_opportunities (scope mine) and agent_bootstrap@10, then closed failed by the tick once the
// planner's lease ends. Synthetic rows only.

const OWN = ["own"];
const WORLD = ["own", "agent:scout", "agent:other"];
const TOOLS = [...AGENT_WORK_TOOLS, "propose_task", "record", "propose_about_you", "build_context_pack", "get_self"];

const agent = (w: WorkWorld, name: string): Promise<WorkClient> =>
  workAgent(w, name, [...OWN, `agent:${name}`], { tools: TOOLS });

const moveEvents = (w: WorkWorld, move: string) =>
  w.admin<{ event: string; by: string; code: string | null }>(
    "select event, by, code from ledger.record_events where row_kind = 'move' and row_id = $1 and event <> 'reported' order by id",
    [move],
  );

describe("write-back and unreported moves at the store", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a proposal is no write-back; a finding is", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const id = await task(w, scout);
      ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(scout.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
      );
      const proposal = ok(
        await w.reader.proposeAboutYou(scout.token, {
          statement: "The owner prefers meetings before 10am",
          requestId: request(),
        }),
      ).recordId;
      const report = { deliverable: "The clinic is run by its two founders.", next: "Nothing more is needed." };
      const cite = (recordId: string) => ({
        ...report,
        sources: [{ kind: "agent_record" as const, id: recordId as never }, "the clinic's own site"],
      });
      expect(
        ok(
          await w.work.reportMove(scout.token, { move, outcome: "done", report: cite(proposal), requestId: request() }),
        ),
      ).toEqual({ move, refused: ["needs_writeback"] });
      const raw = await readAs(w.db, scout.token, (query) =>
        query<{ status: string | null }>(
          "select status from ledger.report_move($1, 'done', $2, $3, null, '{}', '{}', '{}')",
          [move, request(), scout.session],
        ),
      );
      expect(raw).toEqual([]);
      const finding = ok(
        await w.reader.record(scout.token, {
          kind: "finding",
          body: "The clinic in Harbourtown is run by its two founders, as its site says.",
          requestId: request(),
        }),
      ).recordId;
      expect(
        ok(
          await w.work.reportMove(scout.token, { move, outcome: "done", report: cite(finding), requestId: request() }),
        ),
      ).toMatchObject({ move, opportunity: "done" });
    }, WORLD));

  it("an unreported move is listed to its planner, served in agent_bootstrap@10, and closed failed by the tick when the lease ends", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const id = await task(w, scout);
      ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(scout.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
      );
      const listed = ok(await w.work.listOpportunities(scout.token, { scope: "mine" }));
      expect(listed.unreported).toEqual([{ move, opportunity: id, stage: "investigate", say: "report or release" }]);
      // Another client is never told of it.
      expect(ok(await w.work.listOpportunities(other.token, { scope: "mine" })).unreported).toBeUndefined();
      const pack = ContextPack.parse(ok(await w.reader.buildContextPack(scout.token, { purpose: "agent_bootstrap" })));
      expect(pack.template).toBe("agent_bootstrap@16");
      expect(pack.items.filter((one) => one.section === "unreported")).toEqual([
        expect.objectContaining({
          id: move,
          kind: "unreported_move",
          opportunity: id,
          stage: "investigate",
          say: "report or release",
        }),
      ]);

      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        // While the lease is live, the tick leaves it.
        expect((await dispatch.expired(new Date())).filter((one) => one.kind === "move_unreported")).toEqual([]);
        await queryAs(
          w.db.urls.work,
          "update queue.leases set lease_until = now() - interval '1 minute' where resource_id = $1",
          [id],
        );
        const now = new Date();
        const due = (await dispatch.expired(now)).filter((one) => one.kind === "move_unreported");
        expect(due).toEqual([{ kind: "move_unreported", move }]);
        for (const one of due) expect(await dispatch.expire(one, now)).toBe(true);
        expect((await moveEvents(w, move)).at(-1)).toEqual({ event: "failed", by: "system:work", code: "abandoned" });
        // Once closed it is neither listed nor closed again.
        expect((await dispatch.expired(new Date())).filter((one) => one.kind === "move_unreported")).toEqual([]);
        expect(await dispatch.expire({ kind: "move_unreported", move: move as never }, new Date())).toBe(false);
        ok(await w.work.claimOpportunity(scout.token, { id: id as never, requestId: request() }));
        expect(ok(await w.work.listOpportunities(scout.token, { scope: "mine" })).unreported).toBeUndefined();
      } finally {
        await dispatch.close();
      }
    }, WORLD));
});
