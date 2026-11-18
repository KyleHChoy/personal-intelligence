import type { AgentRecordId, MoveId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { newId } from "../core/ids.ts";
import { request } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Opening it serves its result and writes one ledger.owner_views row of the move under the move's label,
// and the line leaves; so does one the owner judged, one older than seven days and a blocked task.
// Synthetic rows only.

const AGENTS = ["agent:scout"];
const DAY_MS = 86_400_000;

async function scout(w: WorkWorld): Promise<WorkClient> {
  const client = await w.client("scout", ["own", ...AGENTS], { tools: TASK_AGENT_TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
}

async function finished(
  w: WorkWorld,
  client: WorkClient,
  outcome: "done" | "blocked" = "done",
): Promise<{ move: MoveId; about: string }> {
  const person = await w.seed.entity("person");
  await w.seed.account(["own"], person);
  const message = await w.message(["own"]);
  await w.seed.pipelineItem(["own"], message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  const { opportunity } = ok(
    await w.work.proposeTask(client.token, {
      kind: "investigate",
      about: { kind: "entity", id: person as never },
      summary: "shelf-asked find who runs the hall",
      basis: [{ kind: "message", id: message.id as never }],
      requestId: request(),
    }),
  );
  ok(await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, {
      opportunity: opportunity as never,
      stage: "investigate",
      requestId: request(),
    }),
  );
  const finding = ok(
    await w.reader.record(client.token, { kind: "finding", body: "shelf-finding the chair", requestId: request() }),
  ).recordId as AgentRecordId;
  const report =
    outcome === "done"
      ? {
          deliverable: "shelf-deliverable a name",
          next: "shelf-next confirm it",
          sources: [{ kind: "agent_record" as const, id: finding }, "https://example.org/hall"],
        }
      : { reason: "shelf-reason the site is down" };
  ok(
    await w.work.reportMove(client.token, {
      move,
      outcome,
      summary: "shelf-found the hall's chair",
      report,
      requestId: request(),
    }),
  );
  return { move: move as MoveId, about: person };
}

const views = (w: WorkWorld) =>
  w.admin<{ target_kind: string; target_id: string; surface: string; compartments: string[] }>(
    "select target_kind, target_id, surface, compartments from ledger.owner_views order by id",
  );

describe("Tried for you", { timeout: DB_TEST_TIMEOUT }, () => {
  it("shows a finished task until the owner opens it, records the open as their view, and leaves out the blocked", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const agent = await scout(w);
        const { move, about } = await finished(w, agent);
        const blocked = await finished(w, agent, "blocked");
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        try {
          const lines = (await admin.cards.results()).unopened ?? [];
          expect(lines.map((one) => one.move)).toEqual([move]);
          expect(lines[0]).toMatchObject({
            kind: "investigate",
            agent: "scout",
            about: { kind: "entity", id: about },
          });
          expect(Date.now() - Date.parse(lines[0]?.doneAt ?? "")).toBeLessThan(DAY_MS);
          expect(lines.map((one) => one.move)).not.toContain(blocked.move);

          // A move the feed does not show opens nothing and writes nothing.
          expect(await admin.cards.openResult(newId("mov") as MoveId)).toBeNull();
          expect(await admin.cards.openResult(blocked.move)).toBeNull();
          expect(await views(w)).toEqual([]);

          // Opened: its result, and one view of the move under the move's own label.
          const opened = await admin.cards.openResult(move);
          expect(opened).toMatchObject({ move, judged: null });
          expect(opened?.lines.length).toBeGreaterThan(0);
          const [label] = await w.admin<{ compartments: string[] }>(
            "select compartments from ledger.moves where id = $1",
            [move],
          );
          expect(await views(w)).toEqual([
            { target_kind: "move", target_id: move, surface: "web", compartments: label?.compartments },
          ]);
          expect((await admin.cards.results()).unopened).toEqual([]);
        } finally {
          await admin.close();
        }
      },
      ["own", ...AGENTS],
    ));

  it("a result the owner judged has been opened, and a line leaves after seven days", () =>
    withWorkWorld(
      async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const agent = await scout(w);
        const judged = await finished(w, agent);
        const left = await finished(w, agent);
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        const later = createAdmin({
          url: w.db.urls.admin,
          keys: w.db.keys,
          log: w.log,
          now: () => new Date(Date.now() + 8 * DAY_MS),
        });
        try {
          await admin.cards.judgeResult({ move: judged.move, answer: "keep", requestId: request() });
          expect((await admin.cards.results()).unopened?.map((one) => one.move)).toEqual([left.move]);
          expect((await later.cards.results()).unopened).toEqual([]);
        } finally {
          await admin.close();
          await later.close();
        }
      },
      ["own", ...AGENTS],
    ));
});
