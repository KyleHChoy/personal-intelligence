import { type AutonomyRules, type EntityId, GAP_ASK, type Tier } from "@intelligence/contracts/personal";
import {
  autonomyRules,
  GAP_QUIET_DAYS,
  GAP_WITHDRAWN_REST_DAYS,
  planGapFlags,
} from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setClientRoles, setGapRoute, setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedAudience, seedLines } from "../test-support/warmth-lines.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createGapLaneStore } from "../work/gap-lanes.ts";

// close_no_role, through the pipeline's pass over the warmth lanes as pi_pipeline: a
// person the owner placed in the closest tiers of their ranking, read from the days within the owner's
// audience, with no role claim raises one read-only task, which reaches an agent under its route and
// within its clearance. Synthetic rows only.

const OWN = ["own"];
const WORK = ["employer:example"];
// A record-writing agent's clearance, as `pi clients add` gives one: its own `agent:` compartment
// beside own, which labels every record it writes.
const AGENT_LABEL = ["agent:scout", "own"];

async function scan(w: WorkWorld, now: Date, rules?: AutonomyRules): Promise<{ raised: number; closed: number }> {
  const lanes = createGapLaneStore({ url: w.db.urls.pipeline, keys: w.db.keys, log: w.log });
  try {
    const flags = await lanes.gapFlags(now);
    const found = (await lanes.gapCandidates(now, rules)).filter((gap) => gap.trigger === "close_no_role");
    const plan = planGapFlags({ candidates: found, open: flags.open, history: flags.history });
    const counts = { raised: 0, closed: 0 };
    for (const id of plan.close) if (await lanes.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise) if ((await lanes.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
    return counts;
  } finally {
    await lanes.close();
  }
}

// A person's warmth under one label, seeded as the day build writes it, with the tier the owner's
// ranking of those days gives (warmth-lines.ts): the owner's tier ruling on the person's address
// (`owner`, the default), or the floors' (`inferred`). Each compartment of the label is the owner's
// audience's, by a claim under it. Returns the person's id.
async function warm(
  w: WorkWorld,
  options: { label?: string[]; tier?: Tier; source?: "owner" | "inferred"; entity?: string } = {},
): Promise<string> {
  const entity = options.entity ?? (await w.seed.entity("person"));
  const label = options.label ?? OWN;
  const source = options.source ?? "owner";
  await seedAudience((one) => w.seed.claim([one]), [label]);
  if (source === "owner") await w.seed.account(OWN, entity);
  await seedLines(w.db, label, [{ entity, tier: options.tier ?? "close", warmth: 1, tierSource: source }], {
    append: true,
  });
  return entity;
}

// Two people the owner ruled the same, each with an address under `own`: one group.
async function group(w: WorkWorld, a: string, b: string): Promise<void> {
  for (const one of [a, b]) await w.seed.account(OWN, one);
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
  try {
    await admin.identity.linkPeople(a as EntityId, b as EntityId, "same", { requestId: testId("req") });
  } finally {
    await admin.close();
  }
}

async function role(w: WorkWorld, entity: string, compartments: string[]): Promise<void> {
  const claim = await w.seed.claim(compartments);
  await w.claims("update knowledge.claims set type = 'role' where id = $1", [claim]);
  await w.seed.claimEntity(compartments, claim, entity);
}

const flags = (
  w: WorkWorld,
): Promise<{ id: string; about_id: string; role: string | null; compartments: string[] }[]> =>
  w.admin(
    "select id, about_id, role, compartments from ledger.opportunities where gap_trigger = 'close_no_role' order by about_id collate \"C\"",
  );

async function agent(w: WorkWorld, name: string, compartments: string[], roles: string[]): Promise<WorkClient> {
  const client = await w.client(name, compartments, { tools: READING_AGENT_TOOLS });
  await w.harness(client, "research", "investigate");
  if (roles.length > 0) await setClientRoles(w.admin, name, roles, new Date());
  return client;
}

const listed = async (w: WorkWorld, client: WorkClient): Promise<string[]> =>
  ok(await w.work.listOpportunities(client.token, { tier: "task" })).opportunities.flatMap((one) =>
    one.gap?.trigger === "close_no_role" ? [one.id] : [],
  );

describe("close people with no role get a task that finds it", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a task done settles the person; one that failed or was let go rests and comes back", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await agent(w, "scout", OWN, []);
      await setTaskTier(w.admin, true, now);
      const [done, failed, letGo] = [await warm(w), await warm(w), await warm(w)];
      expect((await scan(w, now)).raised).toBe(3);
      const idOf = async (person: string): Promise<string> =>
        (await flags(w)).find((one) => one.about_id === person)?.id as string;
      await w.status("opportunity", await idOf(done), "done", "agent");
      await w.admin(
        `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
         values ('opportunity', $1, 'withdrawn', now(), 'client:scout', $2, 'failed')`,
        [await idOf(failed), OWN],
      );
      await w.status("opportunity", await idOf(letGo), "claimed", "agent");
      await w.status("opportunity", await idOf(letGo), "expired", "system:work");

      const days = (n: number): Date => new Date(now.getTime() + n * 86_400_000);
      expect((await scan(w, days(GAP_WITHDRAWN_REST_DAYS - 1))).raised).toBe(0);
      expect((await scan(w, days(GAP_WITHDRAWN_REST_DAYS + 1))).raised).toBe(2);
      const raised = (await flags(w)).filter((one) => one.about_id === done);
      expect(raised).toHaveLength(1);
    }));

  it("history takes no place of the cap: past a settled, a declined or a resting person, the next is reached", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await agent(w, "scout", OWN, []);
      await setTaskTier(w.admin, true, now);
      const one: AutonomyRules = { ...autonomyRules(), closeNoTiePeople: 1 };
      const people = [await warm(w), await warm(w), await warm(w), await warm(w)].sort();
      const flagOf = async (person: string | undefined): Promise<string> =>
        (await flags(w)).find((flag) => flag.about_id === person)?.id as string;

      // An open flag keeps its place: its gap holds, so it stays open and the next waits.
      expect(await scan(w, now, one)).toEqual({ raised: 1, closed: 0 });
      expect(await scan(w, now, one)).toEqual({ raised: 0, closed: 0 });
      expect((await flags(w)).map((flag) => flag.about_id)).toEqual([people[0]]);

      // A task done settles the first.
      await w.status("opportunity", await flagOf(people[0]), "done", "agent");
      expect((await scan(w, now, one)).raised).toBe(1);
      expect((await flags(w)).map((flag) => flag.about_id).sort()).toEqual([people[0], people[1]]);

      // The owner's no holds the second.
      await w.status("opportunity", await flagOf(people[1]), "no_go", "owner");
      expect((await scan(w, now, one)).raised).toBe(1);

      // A task nobody took rests the third, and the fourth is reached.
      await w.status("opportunity", await flagOf(people[2]), "go", "system:gaps");
      await w.status("opportunity", await flagOf(people[2]), "expired", "system:work");
      expect((await scan(w, now, one)).raised).toBe(1);
      expect((await flags(w)).map((flag) => flag.about_id).sort()).toEqual(people);
    }));

  it("the retry that fails too goes quiet for a month, where another trigger would be asked a third time", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await agent(w, "scout", OWN, []);
      await setTaskTier(w.admin, true, now);
      const person = await warm(w);
      const days = (n: number): Date => new Date(now.getTime() + n * 86_400_000);
      const fail = async (at: Date): Promise<void> => {
        const id = (await flags(w)).filter((one) => one.about_id === person).at(-1)?.id as string;
        await w.admin(
          `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
           values ('opportunity', $1, 'withdrawn', $3, 'client:scout', $2, 'failed')`,
          [id, OWN, at.toISOString()],
        );
      };
      expect((await scan(w, now)).raised).toBe(1);
      await fail(now);
      const retry = days(GAP_WITHDRAWN_REST_DAYS + 1);
      expect((await scan(w, retry)).raised).toBe(1);
      await fail(retry);
      expect((await scan(w, days(2 * GAP_WITHDRAWN_REST_DAYS + 3))).raised).toBe(0);
      expect((await scan(w, days(GAP_WITHDRAWN_REST_DAYS + 1 + GAP_QUIET_DAYS + 1))).raised).toBe(1);
    }));

  it("raises once for a person the owner placed, with no role under the label; a role closes it", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      await agent(w, "scout", OWN, []);
      await setTaskTier(w.admin, true, now);

      const placed = await warm(w);
      // The tiers only inferred this one: the trigger is the owner's confirmation.
      await warm(w, { source: "inferred" });
      // Not close.
      await warm(w, { tier: "regular" });
      // A role on file, an agent's or a source's: nothing to find.
      await role(w, await warm(w), OWN);
      // A role on another member of the group is the group's.
      const member = await w.seed.entity("person");
      await group(w, await warm(w), member);
      await role(w, member, OWN);
      // Invariant 6: a role under a label the gap's reader cannot see changes nothing for that reader.
      const hidden = await warm(w);
      await role(w, hidden, WORK);

      expect((await scan(w, now)).raised).toBe(2);
      expect((await flags(w)).map((one) => one.about_id).sort()).toEqual([placed, hidden].sort());

      // Once: it holds a key by subject, and a second pass raises nothing more.
      expect((await scan(w, now)).raised).toBe(0);
      expect(await flags(w)).toHaveLength(2);

      await role(w, placed, OWN);
      expect((await scan(w, now)).closed).toBe(1);
    }));

  it("the role the owner told an agent, recorded as a finding's role claim with no cite, closes the person's gap", () =>
    withWorkWorld(
      async (w) => {
        const now = new Date();
        const scout = await workAgent(w, "scout", AGENT_LABEL, { tools: READING_AGENT_TOOLS, account: true });
        await setTaskTier(w.admin, true, now);
        const placed = await w.seed.entity("person");
        await warm(w, { label: AGENT_LABEL, entity: placed });
        expect((await scan(w, now)).raised).toBe(1);

        const ack = ok(
          await w.reader.record(scout.token, {
            kind: "finding",
            body: 'The owner said Jo Example is an intern at Northwind right now: "Jo is interning at Northwind".',
            claims: [
              {
                subject: { id: placed as EntityId },
                type: "role",
                fields: { title: "intern", organization_name: "Northwind" },
                cites: [],
                requestId: request(),
              },
            ],
            requestId: request(),
          }),
        );
        expect(ack.refused ?? []).toEqual([]);
        const [written] = await w.admin<{ type: string; compartments: string[] }>(
          "select c.type, c.compartments from knowledge.claims c join ledger.agent_writes a on a.evidence_id = c.evidence_id where a.id = $1",
          [ack.recordId],
        );
        expect(written).toEqual({ type: "role", compartments: AGENT_LABEL });
        expect((await scan(w, now)).closed).toBe(1);
        expect((await scan(w, now)).raised).toBe(0);
      },
      [...AGENT_LABEL],
    ));

  it("reaches the agent holding its route, within its clearance, and says what to do", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const holder = await agent(w, "holder", OWN, ["chief-of-staff"]);
      const other = await agent(w, "other", OWN, ["network"]);
      const elsewhere = await agent(w, "elsewhere", WORK, ["chief-of-staff"]);
      await setTaskTier(w.admin, true, now);
      await setGapRoute(w.admin, "close_no_role", "chief-of-staff", now);

      await warm(w);
      expect((await scan(w, now)).raised).toBe(1);
      const [flag] = await flags(w);
      expect(flag).toMatchObject({ role: "chief-of-staff", compartments: OWN });

      expect(await listed(w, holder)).toEqual([flag?.id]);
      expect(await listed(w, other)).toEqual([]);
      expect(await listed(w, elsewhere)).toEqual([]);

      const seen = ok(await w.work.listOpportunities(holder.token, { tier: "task" })).opportunities[0];
      expect(seen?.gap).toMatchObject({ trigger: "close_no_role", missing: "role", ask: GAP_ASK.close_no_role });
      expect(seen?.stage).toBe("investigate");
      ok(await w.work.claimOpportunity(holder.token, { id: flag?.id as never, requestId: "req_close_role" as never }));
    }));
});
