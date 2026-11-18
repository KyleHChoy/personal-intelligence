import type { OwnerTaskBody, RequestId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS } from "../../test-support/work-clients.ts";
import { withWorkWorld } from "../../test-support/work-test-world.ts";
import { createAdmin } from "../admin.ts";
import { setClientRoles, setTaskTier } from "../admin-tasks.ts";

// An owner may ask for the same kind of work about the same thing more than once: each ask is a task
// of its own on the board, whether the earlier one is still open or long finished.
describe("the owner's repeated tasks", { timeout: DB_TEST_TIMEOUT }, () => {
  it("opens a second task of one kind with nothing named, and a second about one person", () =>
    withWorkWorld(async (w) => {
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
      try {
        const scout = await w.client("scout", ["own"], { tools: [...AGENT_WORK_TOOLS] });
        await w.harness(scout, "research", "investigate");
        await setClientRoles(w.admin, "scout", ["research"], new Date());
        await setTaskTier(w.admin, true, new Date());
        const person = await w.seed.entity("person");
        await w.seed.account(["own"], person);
        const body = (about: OwnerTaskBody["about"], note: string): OwnerTaskBody => ({
          role: "research" as never,
          kind: "research",
          about,
          note,
          requestId: testId("req") as RequestId,
        });

        const first = await admin.work.addTask(body([], "One thing to look into."));
        const second = await admin.work.addTask(body([], "Another thing to look into."));
        expect(second.task).not.toBe(first.task);
        const named = [{ kind: "entity", id: person as never }] as OwnerTaskBody["about"];
        const third = await admin.work.addTask(body(named, "About this person."));
        const fourth = await admin.work.addTask(body(named, "More about this person."));
        expect(fourth.task).not.toBe(third.task);
        expect(fourth.status).toBe(third.status);

        // Two asks at once, the first of their kind about this person: both land, on one case.
        const someone = await w.seed.entity("person");
        await w.seed.account(["own"], someone);
        const atOnce = [{ kind: "entity", id: someone as never }] as OwnerTaskBody["about"];
        const both = await Promise.all([
          admin.work.addTask(body(atOnce, "At once, one.")),
          admin.work.addTask(body(atOnce, "At once, two.")),
        ]);
        expect(both[0].task).not.toBe(both[1].task);

        // One case, two tasks: what ends one leaves the other open.
        const fifth = await admin.work.addTask(body(named, "And again, with nothing changed."));
        const open = async (id: string): Promise<string> => w.latest("opportunity", id);
        await admin.work.withdrawTask({ task: third.task as never, requestId: testId("req") as RequestId });
        expect(await open(third.task)).toBe("withdrawn");
        expect(await open(fourth.task)).toBe("go");
        expect(await admin.work.cancelTask(fourth.task as never)).toBe(true);
        expect(await open(fourth.task)).toBe("no_go");
        expect(await open(fifth.task)).toBe("go");
        // An owner's no never stops the owner asking again.
        const sixth = await admin.work.addTask(body(named, "After the no."));
        expect(await open(sixth.task)).toBe("go");
        await w.status("opportunity", sixth.task, "expired", "system:work");
        expect(await open(fifth.task)).toBe("go");
        await w.status("opportunity", first.task, "done", "system:work");
        expect(await open(second.task)).toBe("go");
        const cases = await w.admin<{ n: number }>(
          "select count(distinct case_id)::int as n from ledger.opportunities where id = any ($1::text[])",
          [[third.task, fourth.task, fifth.task, sixth.task]],
        );
        expect(cases[0]?.n).toBe(1);
      } finally {
        await admin.close();
      }
    }));
});
