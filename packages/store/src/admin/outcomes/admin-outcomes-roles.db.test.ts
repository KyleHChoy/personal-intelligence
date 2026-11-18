import { createHash } from "node:crypto";
import type { LoopsView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { ownerStatement, session } from "../../test-support/connections.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import type { OutcomesView } from "./admin-outcomes.ts";

// `roles_unattended` in `pi outcomes` and the agents line of `pia loops`, as pi_admin on a small
// made-up world: work waiting in go, unheld, for over a day, by the role it is routed to, and whether
// an active client of that role asked for work in the last day. Rows are seeded, then moved to set
// times past the append-only triggers.

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
const RESTRICTED = "restricted:health";

let store: TestStore;
let view: OutcomesView;
let loopsView: LoopsView;

const moved = (text: string, values: unknown[]): Promise<unknown> =>
  ownerStatement(store.db.urls.bootstrap, text, values);

const event = (id: string, name: string, at: string, role: string | null = null) =>
  moved(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, role) values ('opportunity', $1, $2, $3, 'system:test', $4, $5)",
    [id, name, at, ["own"], role],
  );

const client = async (name: string, roles: string[], status = "active"): Promise<string> => {
  const id = testId("cli");
  await moved(
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, roles, revoked_at)
     values ($1, $2, $3, $4, 'none', 'local', '{own}', '{work}', '{list_opportunities,claim_opportunity,get_changes}', $5, $6)`,
    [
      id,
      name,
      createHash("sha256").update(id).digest("hex"),
      status,
      roles,
      status === "revoked" ? hoursAgo(48) : null,
    ],
  );
  return id;
};

const call = (clientId: string, tool: string, at: string) =>
  moved("insert into policy.calls (client_id, tool, at, rows, outcome) values ($1, $2, $3, 0, 'ok')", [
    clientId,
    tool,
    at,
  ]);

beforeAll(async () => {
  store = await openStore({ now: NOW, restricted: ["health"], writer: false });
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    // A task routed to `role` at proposal, its latest event `status` at `at`.
    const task = async (
      role: string | null,
      at: string,
      over: { status?: string; label?: string; routedTo?: string } = {},
    ): Promise<string> => {
      const id = await seed.opportunity([over.label ?? "own"]);
      await moved("update ledger.opportunities set tier = 'task', kind = 'investigate', role = $2 where id = $1", [
        id,
        role,
      ]);
      if (over.routedTo !== undefined) await event(id, "routed", hoursAgo(80), over.routedTo);
      await event(id, over.status ?? "go", at);
      return id;
    };

    // Engineering: two tasks waiting three days; its agent called list_opportunities only three days
    // ago and searched today, which is no ask for work.
    await task("engineering", hoursAgo(72));
    await task("engineering", hoursAgo(30));
    const engineer = await client("eng-agent", ["engineering"]);
    await call(engineer, "list_opportunities", hoursAgo(72));
    await call(engineer, "search", hoursAgo(1));
    // Research: one waiting, and its agent read the change feed two hours ago.
    await task("research", hoursAgo(48));
    await call(await client("res-agent", ["research", "writing"]), "get_changes", hoursAgo(2));
    // Finance: no client holds it; one task proposed for research was handed to it.
    await task("finance", hoursAgo(48));
    await task("research", hoursAgo(48), { routedTo: "finance" });
    // Ops: its only agent asked an hour ago, but is revoked.
    await task("ops", hoursAgo(48));
    await call(await client("ops-agent", ["ops"], "revoked"), "claim_opportunity", hoursAgo(1));
    // Not waiting over a day: in go two hours, claimed, held by a live lease, or restricted.
    await task("design", hoursAgo(2));
    await task("legal", hoursAgo(48), { status: "claimed" });
    const held = await task("legal", hoursAgo(48));
    await moved(
      "insert into queue.leases (resource_kind, resource_id, holder, lease_until, first_taken_at) values ('opportunity', $1, $2, $3, $4)",
      [held, engineer, new Date(NOW.getTime() + HOUR_MS).toISOString(), hoursAgo(1)],
    );
    await task("people", hoursAgo(48), { label: RESTRICTED });
    // A task with no role waits for anyone: counted as waiting, under no role.
    await task(null, hoursAgo(48));
  });
  view = await store.admin.box.outcomes(14);
  loopsView = await store.admin.box.loops(7);
}, TIMEOUT);

afterAll(() => store?.close());

describe("roles_unattended", { timeout: TIMEOUT }, () => {
  it("counts each role with work unheld in go over a day that no active client of it asked for", () => {
    expect(view.metrics.find((one) => one.metric === "roles_unattended")).toMatchObject({
      value: 3,
      sample: 4,
      healthy: { test: "at_most", value: 0 },
      window: { fromDaysAgo: 1, toDaysAgo: 0 },
      state: "failing",
      parts: { "role:engineering": 2, "role:finance": 2, "role:ops": 1 },
    });
  });
});

describe("pia loops, the agents line", { timeout: TIMEOUT }, () => {
  it("says how many roles are unattended and how many tasks wait, and stays on doneAndUsed for its state", () => {
    const agents = loopsView.loops.find((row) => row.loop === "agents");
    expect(agents?.produced).toMatchObject({ doneAndUsed: 0, unattendedRoles: 3, waitingOver24h: 7 });
    expect(agents?.before).toMatchObject({ unattendedRoles: 0, waitingOver24h: 0 });
    expect(agents?.state).toBe("empty");
  });
});
