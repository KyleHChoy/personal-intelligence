import { describe, expect, it } from "vitest";
import { setClientRoles, setDefaultTaskRole, setGapRoute, setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { screened } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { setWebhook } from "../work/notices.ts";
import { AdminError } from "./admin-error.ts";

// The owner's default task role. A task proposed with no role, and a gap flag whose trigger has
// no route, take it when the row is written; an explicit role or route wins; the work notices
// follow the stored role. Synthetic rows only; role names are
// examples.

const OWN = ["own"];
const DEFAULT = "chief-of-staff";

async function agent(w: WorkWorld, name: string, roles: string[], compartments = OWN): Promise<WorkClient> {
  const client = await w.client(name, compartments, { tools: TASK_AGENT_TOOLS });
  await w.harness(client, "investigate", "investigate");
  if (roles.length > 0) await setClientRoles(w.admin, name, roles, new Date());
  await setWebhook(w.admin, name, "https://agent.example.org/hook", new Date());
  return client;
}

async function task(w: WorkWorld, by: WorkClient, role?: string, compartments = OWN): Promise<string> {
  const subject = await w.seed.entity("person");
  await w.seed.account(compartments, subject);
  const made = ok(
    await w.work.proposeTask(by.token, {
      kind: "investigate",
      about: { kind: "entity", id: subject as never },
      summary: "find who runs it",
      basis: [{ kind: "message", id: (await screened(w, compartments)) as never }],
      ...(role === undefined ? {} : { role }),
      requestId: request(),
    }),
  );
  expect(made.status).toBe("go");
  return made.opportunity;
}

async function flag(w: WorkWorld, trigger: string): Promise<string> {
  const message = await screened(w);
  const [row] = await queryAs<{ id: string | null }>(
    w.db.urls.work,
    "select ledger.raise_gap_flag($1, $2, $3, 'message', $4, 'message', $4, null, null, true) as id",
    [testId("opp"), trigger, testId("fp").replace(/[^A-Za-z0-9_]/g, "_"), message],
  );
  if (row?.id == null) throw new Error("no flag raised");
  return row.id;
}

const roleOf = async (w: WorkWorld, id: string): Promise<string | null> =>
  (await w.admin<{ role: string | null }>("select role from ledger.opportunities where id = $1", [id]))[0]?.role ??
  null;
const noticed = async (w: WorkWorld, id: string): Promise<string[]> =>
  (
    await w.admin<{ client_id: string }>(
      "select client_id from ledger.work_notices where opportunity_id = $1 and event = 'task_go' order by client_id",
      [id],
    )
  ).map((row) => row.client_id);
const refusal = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "none",
    (error: unknown) => (error instanceof AdminError ? error.code : "other"),
  );
const decisions = (w: WorkWorld) =>
  w.admin<{ details: unknown }>(
    "select details from knowledge.owner_decisions where kind = 'default_task_role' order by details ->> 'role' nulls last",
  );

describe("the owner's default task role", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is set only to a role an active agent holds, writes the owner's decision once per change, and clears", () =>
    withWorkWorld(async (w) => {
      expect(await w.admin("select default_task_role from policy.work_settings")).toEqual([
        { default_task_role: null },
      ]);
      expect(await refusal(setDefaultTaskRole(w.admin, DEFAULT, new Date()))).toBe("unknown_role");
      expect(await refusal(setDefaultTaskRole(w.admin, "Not A Role", new Date()))).toBe("invalid_argument");
      expect(await decisions(w)).toEqual([]);
      // A revoked holder holds nothing.
      const gone = await agent(w, "gone", [DEFAULT]);
      await w.admin("update policy.clients set status = 'revoked' where id = $1", [gone.id]);
      expect(await refusal(setDefaultTaskRole(w.admin, DEFAULT, new Date()))).toBe("unknown_role");

      await agent(w, "chief", [DEFAULT]);
      await setDefaultTaskRole(w.admin, DEFAULT, new Date());
      await setDefaultTaskRole(w.admin, DEFAULT, new Date());
      expect(await w.admin("select default_task_role from policy.work_settings")).toEqual([
        { default_task_role: DEFAULT },
      ]);
      await setDefaultTaskRole(w.admin, null, new Date());
      expect(await w.admin("select default_task_role from policy.work_settings")).toEqual([
        { default_task_role: null },
      ]);
      expect(await decisions(w)).toEqual([{ details: { role: DEFAULT } }, { details: { role: null } }]);
      // Only the owner's command sets it: the work role reads it and may not write it.
      expect(await queryAs(w.db.urls.work, "select default_task_role from policy.work_settings")).toEqual([
        { default_task_role: null },
      ]);
      expect(
        await sqlState(() => queryAs(w.db.urls.work, "update policy.work_settings set default_task_role = 'other'")),
      ).toBe("42501");
    }));

  it("a task with no role and a flag with no route take it when written; a role or a route wins; notices follow the stored role", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", []);
      const chief = await agent(w, "chief", [DEFAULT]);
      const net = await agent(w, "net", ["network"]);
      // Before the default: any agent's, and each agent with a webhook is told, but never the one
      // whose own write raised it.
      const before = await task(w, scout);
      expect(await roleOf(w, before)).toBeNull();
      expect(await noticed(w, before)).toEqual([chief.id, net.id].sort());

      await setDefaultTaskRole(w.admin, DEFAULT, new Date());
      const unroled = await task(w, scout);
      expect(await roleOf(w, unroled)).toBe(DEFAULT);
      // The notice reads the stored role, not the proposal's absent one: its holders alone.
      expect(await noticed(w, unroled)).toEqual([chief.id]);
      const roled = await task(w, scout, "network");
      expect(await roleOf(w, roled)).toBe("network");
      expect(await noticed(w, roled)).toEqual([net.id]);
      // Written once: the earlier task keeps none.
      expect(await roleOf(w, before)).toBeNull();
      // Only the holder sees it on the board's claim.
      expect(await w.work.claimOpportunity(net.token, { id: unroled as never, requestId: request() })).toMatchObject({
        ok: false,
      });
      ok(await w.work.claimOpportunity(chief.token, { id: unroled as never, requestId: request() }));

      await setGapRoute(w.admin, "unresolved_mention", "network", new Date());
      expect(await roleOf(w, await flag(w, "unresolved_mention"))).toBe("network");
      expect(await roleOf(w, await flag(w, "no_warm_path"))).toBe(DEFAULT);

      // Cleared: any agent's again.
      await setDefaultTaskRole(w.admin, null, new Date());
      expect(await roleOf(w, await task(w, scout))).toBeNull();
      expect(await roleOf(w, await flag(w, "unknown_attendee"))).toBeNull();
    }));

  it("strands nothing: work no active holder of the default is cleared for stays any agent's", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      // A task takes its proposer's label: wide's are under both compartments, scout's under own.
      const both = ["own", "employer:example"];
      const wide = await agent(w, "wide", [], both);
      const scout = await agent(w, "scout", []);
      const chief = await agent(w, "chief", [DEFAULT]);
      await setDefaultTaskRole(w.admin, DEFAULT, new Date());
      expect(await roleOf(w, await task(w, scout))).toBe(DEFAULT);
      // A label the holder is not cleared for: it could never claim it.
      expect(await roleOf(w, await task(w, wide, undefined, both))).toBeNull();
      // The holder loses the role, then is revoked: the setting stays, and new work is any agent's.
      await setClientRoles(w.admin, "chief", [], new Date());
      expect(await roleOf(w, await task(w, scout))).toBeNull();
      await setClientRoles(w.admin, "chief", [DEFAULT], new Date());
      expect(await roleOf(w, await task(w, scout))).toBe(DEFAULT);
      await w.admin("update policy.clients set status = 'revoked' where id = $1", [chief.id]);
      expect(await roleOf(w, await task(w, scout))).toBeNull();
      expect(await w.admin("select default_task_role from policy.work_settings")).toEqual([
        { default_task_role: DEFAULT },
      ]);
    }));
});
