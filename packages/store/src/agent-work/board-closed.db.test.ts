import type { AgentRecordId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request } from "../test-support/clients.ts";
import { ownerStatement } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { task as taskOf, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// list_opportunities, scope closed: what a worked, failed or expired task leaves, for whoever holds the
// tool, with no new grant. A row shows under the row's own label; a report's words only to one its
// label and its finding's policy already let read them. Synthetic rows only.

const OWN = ["own"];
const WORKER = [...OWN, "agent:worker"];
const LABELS = [...WORKER, "public"];
const FOUND = "canary-deliverable two names";
const WHY = "canary-reason nothing new";

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: TASK_AGENT_TOOLS });
const task = (w: WorkWorld, client: WorkClient): Promise<string> =>
  taskOf(w, client, { summary: "find who runs the canary clinic" });

async function claimAndPlan(w: WorkWorld, client: WorkClient, id: string): Promise<never> {
  ok(await w.work.claimOpportunity(client.token, { id: id as never, requestId: request() }));
  return ok(
    await w.work.planMove(client.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
  ).move as never;
}

async function finish(w: WorkWorld, client: WorkClient, id: string): Promise<string> {
  const move = await claimAndPlan(w, client, id);
  const finding = ok(
    await w.reader.record(client.token, { kind: "finding", body: "canary-finding", requestId: request() }),
  ).recordId as AgentRecordId;
  ok(
    await w.work.reportMove(client.token, {
      move,
      outcome: "done",
      report: { deliverable: FOUND, next: "canary-next", sources: [{ kind: "agent_record", id: finding }] },
      requestId: request(),
    }),
  );
  return finding;
}

async function fail(w: WorkWorld, client: WorkClient, id: string): Promise<void> {
  const move = await claimAndPlan(w, client, id);
  ok(await w.work.reportMove(client.token, { move, outcome: "failed", report: { reason: WHY }, requestId: request() }));
}

const closed = async (w: WorkWorld, client: WorkClient, limit?: number) =>
  ok(await w.work.listOpportunities(client.token, { scope: "closed", ...(limit === undefined ? {} : { limit }) }))
    .opportunities;

describe("the closed rows of the board", { timeout: DB_TEST_TIMEOUT }, () => {
  it("says what each ended as, newest first, and its report to the agent that wrote it", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      const doneId = await task(w, worker);
      const failedId = await task(w, worker);
      const expiredId = await task(w, worker);
      const openId = await task(w, worker);
      const finding = await finish(w, worker, doneId);
      await fail(w, worker, failedId);
      await w.status("opportunity", expiredId, "expired", "system:work");

      const rows = await closed(w, worker);
      expect(rows.map((one) => one.id)).toEqual([expiredId, failedId, doneId]);
      const [expired, failed, done] = rows;
      expect(done).toMatchObject({ status: "done", closed: { by: "you" } });
      expect(done?.closed?.report).toMatchObject({
        deliverable: { untrusted: FOUND },
        next: { untrusted: "canary-next" },
        findings: [finding],
      });
      expect(failed).toMatchObject({
        status: "withdrawn",
        closed: { by: "you", failed: true, report: { reason: { untrusted: WHY } } },
      });
      expect(expired).toMatchObject({ status: "expired", closed: { by: "system" } });
      expect(expired?.closed?.report).toBeUndefined();
      // Cut by when each closed, and the open scopes do not change.
      expect((await closed(w, worker, 1)).map((one) => one.id)).toEqual([expiredId]);
      const board = ok(await w.work.listOpportunities(worker.token, { scope: "board" })).opportunities;
      expect(board.map((one) => one.id)).toEqual([openId]);
      expect(board[0]?.closed).toBeUndefined();
    }, LABELS));

  it("shows another agent the row, and the report's words only when its finding is one it may read", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      const peer = await agent(w, "peer", OWN);
      const shared = await agent(w, "shared", WORKER);
      // Under `own`, as code raises a gap's task, and worked under the worker's whole clearance.
      const author = await agent(w, "author", OWN);
      const doneId = await task(w, author);
      const failedId = await task(w, author);
      const finding = await finish(w, worker, doneId);
      await fail(w, worker, failedId);

      // Cleared for `own` alone: the rows, by an agent, and no word of what its compartment holds.
      const seen = await closed(w, peer);
      expect(seen.map((one) => one.id).sort()).toEqual([doneId, failedId].sort());
      expect(seen.find((one) => one.id === doneId)).toMatchObject({ status: "done", closed: { by: "agent" } });
      for (const row of seen) expect(row.closed?.report).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain("canary-");

      // Cleared for the writer's compartment: its done report, by the finding it may read. A failed
      // one cites no finding the record's policy could vouch for, so its words stay the writer's.
      const wide = await closed(w, shared);
      expect(wide.find((one) => one.id === doneId)?.closed?.report).toMatchObject({
        deliverable: { untrusted: FOUND },
        findings: [finding],
      });
      expect(wide.find((one) => one.id === failedId)?.closed?.report).toBeUndefined();
    }, LABELS));

  it("shows nothing outside the caller's label, no other agent's undecided row, and no no of code's", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      const elsewhere = await agent(w, "elsewhere", ["public"]);
      const peer = await agent(w, "peer", OWN);
      const worked = await task(w, worker);
      await finish(w, worker, worked);
      expect(await closed(w, elsewhere)).toEqual([]);

      const rested = await task(w, worker);
      await w.status("opportunity", rested, "no_go", "policy");
      expect((await closed(w, worker)).map((one) => one.id)).toEqual([worked]);

      // A proposal that never went: its author sees how it ended, another agent nothing of it.
      const message = await w.message(OWN);
      const { opportunity: undecided } = ok(
        await w.work.proposeOpportunity(worker.token, {
          kind: "investigate",
          about: { kind: "message", id: message.id as never },
          summary: "find who runs the canary harbour",
          basis: [{ kind: "message", id: message.id as never }],
          requestId: request(),
        }),
      );
      await w.status("opportunity", undecided, "expired", "system:work");
      expect((await closed(w, worker)).map((one) => one.id)).toContain(undecided);
      expect((await closed(w, peer)).map((one) => one.id)).not.toContain(undecided);
    }, LABELS));

  it("counts a claim that ended with nothing to read, and not one with a report, one still held or one whose report a deletion took", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      await finish(w, worker, await task(w, worker));
      await fail(w, worker, await task(w, worker));
      const letGo = await task(w, worker);
      await claimAndPlan(w, worker, letGo);
      await w.status("opportunity", letGo, "expired", "system:work");
      await w.admin("delete from queue.leases where resource_kind = 'opportunity' and resource_id = $1", [letGo]);
      await claimAndPlan(w, worker, await task(w, worker));
      // Reported, and its report taken by a deletion: left out, never counted as nothing to read.
      const erased = await task(w, worker);
      await finish(w, worker, erased);
      await ownerStatement(
        w.db.urls.bootstrap,
        "update ledger.record_events set tainted_at = now() where row_kind = 'move' and event = 'reported' and row_id in (select id from ledger.moves where opportunity_id = $1)",
        [erased],
      );

      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const line = (await admin.box.outcomes(7)).metrics.find(
          (one) => one.metric === "tasks_claimed_no_result_per_day",
        );
        expect(line).toMatchObject({ sample: 3, parts: { with_result: 2, no_result: 1 } });
      } finally {
        await admin.close();
      }
    }, LABELS));

  it("takes a report's words away once its finding is erased, and keeps the row", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      const id = await task(w, worker);
      const finding = await finish(w, worker, id);
      expect((await closed(w, worker))[0]?.closed?.report).toBeDefined();
      await w.admin("update ledger.agent_writes set body_enc = null where id = $1", [finding]);
      const [row] = await closed(w, worker);
      expect(row).toMatchObject({ id, status: "done" });
      expect(row?.closed?.report).toBeUndefined();
    }, LABELS));

  it("pages by a cursor that holds no id: every row once, next only while more are left, and no other scope takes one", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const worker = await agent(w, "worker", WORKER);
      const ended: string[] = [];
      for (let n = 0; n < 3; n += 1) ended.push(await task(w, worker));
      for (const id of ended) await w.status("opportunity", id, "expired", "system:work");
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = ok(
          await w.work.listOpportunities(worker.token, {
            scope: "closed",
            limit: 1,
            ...(after === undefined ? {} : { after }),
          }),
        );
        seen.push(...page.opportunities.map((one) => one.id));
        after = page.next;
        pages += 1;
        if (after !== undefined)
          for (const id of ended) expect(Buffer.from(after, "base64url").toString()).not.toContain(id);
      } while (after !== undefined && pages < 10);
      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual([...ended].sort());
      expect(await w.work.listOpportunities(worker.token, { scope: "board", after: "abc" })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      const impossible = Buffer.from(`2026-02-30 10:00:00+00|${"a".repeat(32)}`).toString("base64url");
      expect(await w.work.listOpportunities(worker.token, { scope: "closed", after: impossible })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(
        await w.work.listOpportunities(worker.token, { scope: "closed", after: "bm90LWEtY3Vyc29y" }),
      ).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }, LABELS));
});
