import type { Timestamp } from "@intelligence/contracts";
import { type ClientId, type IntentionId, noticeBody, type OpportunityId } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setClientRoles, setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { screened } from "../test-support/work-seeds.ts";
import { ownerUpdate } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";
import { createNotices, listenNotices, setWebhook } from "./notices.ts";

// Who is written a work notice, when, and what the sender's role may touch. Synthetic rows only;
// role names and addresses are examples on reserved domains. Nothing writes a `stage_cleared`
// notice: nothing raises a `cleared` move event outside its holder's own call, so no test here
// raises one.

const OWN = ["own"];
const BOTH = ["own", "employer:example"];
const ADDRESS = "https://agent.example.org/hook";

type Notice = {
  client_id: string | null;
  opportunity_id: string | null;
  event: string | null;
  state: string;
  last_code: string | null;
};

async function agent(
  w: WorkWorld,
  name: string,
  options: { compartments?: string[]; roles?: string[]; webhook?: boolean; harness?: boolean } = {},
): Promise<WorkClient> {
  const client = await w.client(name, options.compartments ?? OWN, { tools: TASK_AGENT_TOOLS });
  if (options.harness !== false) {
    for (const [kind, stage] of [
      ["investigate", "investigate"],
      ["follow_up", "investigate"],
    ] as const)
      await w.harness(client, kind, stage);
  }
  if ((options.roles ?? []).length > 0) await setClientRoles(w.admin, name, options.roles ?? [], new Date());
  if (options.webhook !== false) await setWebhook(w.admin, name, ADDRESS, new Date());
  return client;
}

// A task proposed by `by`, decided go by code: its first `go`.
async function task(
  w: WorkWorld,
  by: WorkClient,
  options: { role?: string; compartments?: string[]; summary?: string; dueAt?: string } = {},
): Promise<OpportunityId> {
  const subject = await w.seed.entity("person");
  await w.seed.account(options.compartments ?? OWN, subject);
  const made = ok(
    await w.work.proposeTask(by.token, {
      kind: "investigate",
      about: { kind: "entity", id: subject as never },
      summary: options.summary ?? "find who runs it",
      basis: [{ kind: "message", id: (await screened(w, options.compartments ?? OWN)) as never }],
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as Timestamp }),
      requestId: request(),
    }),
  );
  expect(made.status).toBe("go");
  return made.opportunity as OpportunityId;
}

const notices = (w: WorkWorld, opportunity?: string): Promise<Notice[]> =>
  w.admin<Notice>(
    `select client_id, opportunity_id, event, state, last_code from ledger.work_notices
     where $1::text is null or opportunity_id = $1 order by created_at, client_id`,
    [opportunity ?? null],
  );
const to = (rows: Notice[], client: WorkClient): Notice[] => rows.filter((row) => row.client_id === client.id);
const claim = (w: WorkWorld, client: WorkClient, id: string) =>
  w.work.claimOpportunity(client.token, { id: id as OpportunityId, requestId: request() });
const release = (w: WorkWorld, client: WorkClient, id: string) =>
  w.work.releaseOpportunity(client.token, { id: id as OpportunityId, reason: "no_time", requestId: request() });

describe("work notices", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a task routed to a role notifies each active holder with a webhook and the clearance, and no other client", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { compartments: BOTH, webhook: false });
      const net = await agent(w, "net", { compartments: BOTH, roles: ["network"] });
      const narrow = await agent(w, "narrow", { roles: ["network"] });
      const revoked = await agent(w, "revoked", { compartments: BOTH, roles: ["network"] });
      const ungranted = await agent(w, "ungranted", { compartments: BOTH, roles: ["network"], harness: false });
      const silent = await agent(w, "silent", { compartments: BOTH, roles: ["network"], webhook: false });
      const other = await agent(w, "other", { compartments: BOTH, roles: ["other-role"] });
      await w.admin("update policy.clients set status = 'revoked' where id = $1", [revoked.id]);
      // Under own and employer:example: narrow is not cleared for it (invariant 6).
      const id = await task(w, scout, { role: "network", compartments: BOTH });
      const rows = await notices(w, id);
      expect(rows).toEqual([
        { client_id: net.id, opportunity_id: id, event: "task_go", state: "pending", last_code: null },
      ]);
      for (const none of [narrow, revoked, ungranted, silent, other, scout])
        expect(to(rows, none), none.name).toEqual([]);
      // The positive control for the clearance: a task under own alone, proposed by an agent cleared
      // for own alone (a task takes its proposer's label), reaches narrow too.
      const local = await agent(w, "local", { webhook: false });
      const owned = await task(w, local, { role: "network" });
      expect((await notices(w, owned)).map((row) => row.client_id).sort()).toEqual([net.id, narrow.id].sort());
    }));

  it("an item hidden from a client changes nothing in that client's notices", async () => {
    const world = async (hidden: boolean) =>
      withWorkWorld(async (w) => {
        await setTaskTier(w.admin, true, new Date());
        const scout = await agent(w, "scout", { compartments: BOTH, webhook: false });
        const narrow = await agent(w, "narrow", { roles: ["network"] });
        if (hidden) await task(w, scout, { role: "network", compartments: BOTH });
        const local = await agent(w, "local", { webhook: false });
        const seen = await task(w, local, { role: "network" });
        return (await notices(w))
          .filter((row) => row.client_id === narrow.id)
          .map((row) => ({
            ...row,
            client_id: "narrow",
            opportunity_id: row.opportunity_id === seen ? "seen" : "other",
          }));
      });
    const without = await world(false);
    expect(without).toEqual([
      { client_id: "narrow", opportunity_id: "seen", event: "task_go", state: "pending", last_code: null },
    ]);
    expect(await world(true)).toEqual(without);
  });

  it("hand_off is routed, a release and a lapsed lease are returned to the others, and a claim's own lapsed-lease return is none", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const a = await agent(w, "a", { roles: ["network"] });
      const b = await agent(w, "b", { roles: ["network"] });
      const id = await task(w, scout);
      expect((await notices(w, id)).map((row) => row.event)).toEqual(["task_go", "task_go"]);
      // a claims and hands off to network: one `routed` to each other holder that may take it, not its own write.
      ok(await claim(w, a, id));
      expect(
        ok(await w.work.handOff(a.token, { id, role: "network", reason: "other_role", requestId: request() })),
      ).toEqual({ handedOff: true });
      const routed = (await notices(w, id)).filter((row) => row.event === "routed");
      expect(routed.map((row) => row.client_id)).toEqual([b.id]);
      // b claims and releases with a reason: a is told `returned`, the releaser never.
      ok(await claim(w, b, id));
      const before = (await notices(w, id)).length;
      expect(ok(await release(w, b, id))).toEqual({ released: true });
      const returned = (await notices(w, id)).slice(before);
      expect(returned.map((row) => [row.client_id, row.event])).toEqual([[a.id, "returned"]]);
      // a claims; its lease lapses; the tick returns it: b declined, so only a is told.
      ok(await claim(w, a, id));
      await ownerUpdate(w, "queue.leases", "lease_until = now() - interval '1 minute'", "resource_id = $1", [id]);
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const count = (await notices(w, id)).length;
        expect(await dispatch.returnToGo(id, new Date())).toBe(true);
        expect((await notices(w, id)).slice(count).map((row) => [row.client_id, row.event])).toEqual([
          [a.id, "returned"],
        ]);
      } finally {
        await dispatch.close();
      }
      // a claims again, its lease lapses, and a claims it back itself: that lazy return is none.
      ok(await claim(w, a, id));
      await ownerUpdate(w, "queue.leases", "lease_until = now() - interval '1 minute'", "resource_id = $1", [id]);
      const count = (await notices(w, id)).length;
      ok(await claim(w, a, id));
      expect(
        (
          await w.admin<{ code: string | null }>(
            "select code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 and event = 'go' order by id desc limit 1",
            [id],
          )
        )[0]?.code,
      ).toBe("lease_expired");
      expect((await notices(w, id)).length).toBe(count);
    }));

  it("a check-back fired on a claimed item is one intention_due to its setter and none to the other holders; one on an item already go the same", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const a = await agent(w, "a");
      const b = await agent(w, "b");
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        for (const claimed of [true, false]) {
          const id = await task(w, scout);
          ok(await claim(w, a, id));
          const due = new Date(Date.now() + 2 * 3_600_000).toISOString();
          const { intention } = ok(
            await w.work.setIntention(a.token, {
              opportunity: id,
              kind: "check_back",
              dueAt: due,
              requestId: request(),
            }),
          );
          const preferred = { client: a.id as ClientId, intention: intention as IntentionId };
          if (!claimed) {
            // Back on the board by a's lapsed lease, with its check-back still waiting (a release
            // would cancel it), so that only the check-back decides what a is told.
            await queryAs(
              w.db.urls.work,
              "update queue.leases set lease_until = now() - interval '1 hour' where resource_kind = 'opportunity' and resource_id = $1",
              [id],
            );
            expect(await dispatch.returnToGo(id, new Date())).toBe(true);
          }
          const count = (await notices(w, id)).length;
          if (claimed) expect(await dispatch.returnToGo(id, new Date(), preferred)).toBe(true);
          else expect(await dispatch.preferClient(id, preferred, new Date())).toBe(true);
          const added = (await notices(w, id)).slice(count);
          expect(
            added.map((row) => [row.client_id, row.event]),
            String(claimed),
          ).toEqual([[a.id, "intention_due"]]);
          expect(to(added, b)).toEqual([]);
        }
      } finally {
        await dispatch.close();
      }
    }));

  it("an opportunity under an intent with a role: a holder may claim it and is told; a client neither listed nor holding it is neither", () =>
    withWorkWorld(async (w) => {
      const chief = await agent(w, "chief", { roles: ["chief-of-staff"] });
      const stranger = await agent(w, "stranger", { roles: ["network"] });
      const intent = testId("int");
      await w.admin(
        `insert into policy.intents (id, goal_id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at, role)
         values ($1, null, '{follow_up}', '{none}', '{}', 'owner_decides', 5, now(), 'chief-of-staff')`,
        [intent],
      );
      const id = await w.seed.opportunity(OWN);
      await w.decideGo(id, intent);
      expect((await notices(w, id)).map((row) => [row.client_id, row.event])).toEqual([[chief.id, "opportunity_go"]]);
      const [role] = await w.admin<{ role: string | null; tier: string }>(
        "select role, tier from ledger.work_notices where opportunity_id = $1",
        [id],
      );
      expect(role).toEqual({ role: "chief-of-staff", tier: "opportunity" });
      // The stranger holds no grant for the work at its stage (the intent names a role it lacks), and
      // is told so from its own grants.
      expect(await claim(w, stranger, id)).toEqual({ ok: false, code: "not_found", refusal: "no_harness_mode" });
      ok(await claim(w, chief, id));
      // The positive control for plan_move: the role holder is listed for its intent.
      ok(
        await w.work.planMove(chief.token, {
          opportunity: id as OpportunityId,
          stage: "investigate",
          requestId: request(),
        }),
      );
    }));

  it("a release without a lease declines for 7 days: no event, no lease, no notice; its expiry writes none; a hand-off to a role it holds clears it", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const a = await agent(w, "a", { roles: ["network"] });
      const b = await agent(w, "b", { roles: ["network"] });
      const id = await task(w, scout);
      const events = async () =>
        (
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.record_events where row_kind = 'opportunity' and row_id = $1",
            [id],
          )
        )[0]?.n;
      const before = { events: await events(), notices: (await notices(w)).length };
      expect(ok(await release(w, a, id))).toEqual({ declined: true });
      expect({ events: await events(), notices: (await notices(w)).length }).toEqual(before);
      expect(await w.admin("select resource_id from queue.leases where resource_id = $1", [id])).toEqual([]);
      // b claims and releases: a, declined, is not told; nothing for b, the releaser.
      ok(await claim(w, b, id));
      const count = (await notices(w, id)).length;
      ok(await release(w, b, id));
      expect((await notices(w, id)).slice(count)).toEqual([]);
      // a's decline, 7 days old: its expiry writes nothing, and the next event tells a again.
      await ownerUpdate(
        w,
        "ledger.work_declines",
        "created_at = now() - interval '8 days', expires_at = now() - interval '1 day'",
        "client_id = $1",
        [a.id],
      );
      expect((await notices(w, id)).length).toBe(count);
      ok(await claim(w, b, id));
      ok(await release(w, b, id));
      expect(to((await notices(w, id)).slice(count), a).map((row) => row.event)).toEqual(["returned"]);
      // a and b each declined it. A hand-off to network clears both declines.
      ok(await release(w, a, id));
      ok(await claim(w, b, id));
      expect(
        await w.admin<{ client_id: string }>(
          "select client_id from ledger.work_declines where opportunity_id = $1 order by client_id",
          [id],
        ),
      ).toHaveLength(2);
      ok(await w.work.handOff(b.token, { id, role: "network", reason: "other_role", requestId: request() }));
      expect(await w.admin("select client_id from ledger.work_declines where opportunity_id = $1", [id])).toEqual([]);
      expect(
        to(
          (await notices(w, id)).filter((row) => row.event === "routed"),
          a,
        ),
      ).toHaveLength(1);
    }));

  it("a hold that lapses unclaimed: the tick writes one preference_lapsed go and one returned notice to each client that may take it, once", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const a = await agent(w, "a");
      const b = await agent(w, "b");
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const lapsing = await task(w, scout);
        const taken = await task(w, scout);
        for (const id of [lapsing, taken]) {
          ok(await claim(w, a, id));
          const { intention } = ok(
            await w.work.setIntention(a.token, {
              opportunity: id,
              kind: "check_back",
              dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
              requestId: request(),
            }),
          );
          expect(
            await dispatch.returnToGo(id, new Date(Date.now() - 25 * 3_600_000), {
              client: a.id as ClientId,
              intention: intention as IntentionId,
            }),
          ).toBe(true);
        }
        // The hold on `taken` ends with b's claim (claim clears the hold), before it lapses.
        ok(await claim(w, b, taken));
        const count = (await notices(w)).length;
        expect(await dispatch.lapsedHolds(new Date())).toEqual([lapsing]);
        expect(await dispatch.lapseHold(lapsing, new Date())).toBe(true);
        const added = (await notices(w)).slice(count);
        expect(added.map((row) => [row.client_id, row.opportunity_id, row.event]).sort()).toEqual(
          [
            [a.id, lapsing, "returned"],
            [b.id, lapsing, "returned"],
          ].sort(),
        );
        expect(
          (
            await w.admin<{ event: string; code: string }>(
              "select event, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
              [lapsing],
            )
          )[0],
        ).toEqual({
          event: "go",
          code: "preference_lapsed",
        });
        expect(await w.admin("select preferred_until from queue.leases where resource_id = $1", [lapsing])).toEqual([
          { preferred_until: null },
        ]);
        // A second tick writes nothing more.
        expect(await dispatch.lapsedHolds(new Date())).toEqual([]);
        expect(await dispatch.lapseHold(lapsing, new Date())).toBe(false);
        expect((await notices(w)).length).toBe(count + 2);
      } finally {
        await dispatch.close();
      }
    }));

  it("a notice function that fails leaves the work committed and one row with no client; such a row with another code is refused", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      await agent(w, "a");
      await asOwner(
        w.db,
        "create or replace function ledger.notice_due(opportunity_id text, client_id text) returns boolean language plpgsql as $$ begin raise exception 'planted'; end $$",
      );
      const id = await task(w, scout);
      expect(await w.latest("opportunity", id)).toBe("go");
      expect(await notices(w, id)).toEqual([
        { client_id: null, opportunity_id: id, event: null, state: "failed", last_code: "notice_error" },
      ]);
      const insert = (code: string) =>
        sqlState(() =>
          asOwner(
            w.db,
            "insert into ledger.work_notices (id, client_id, opportunity_id, txid, state, last_code) values ($1, null, $2, 1, 'failed', $3)",
            [testId("ntc"), id, code],
          ),
        );
      expect(await insert("no_secret")).toBe("23514");
      expect(await insert("notice_error")).toBeNull();
    }));

  it("claimable_by answers exactly as each client's claim does, and notice_current agrees", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { compartments: BOTH, webhook: false });
      const clients = [
        scout,
        await agent(w, "net", { roles: ["network"] }),
        await agent(w, "wide", { compartments: BOTH }),
        await agent(w, "bare", { harness: false }),
      ];
      const items = [
        await task(w, scout),
        await task(w, scout, { role: "network" }),
        await task(w, scout, { compartments: BOTH }),
      ];
      ok(await claim(w, clients[2]!, items[2]!));
      for (const client of clients) {
        for (const item of items) {
          const [answer] = await asOwner<{ can: boolean }>(w.db, "select ledger.claimable_by($1, $2) as can", [
            item,
            client.id,
          ]);
          const until = await readAs(w.db, client.token, async (query) => {
            await query("begin");
            try {
              return (
                (
                  await query<{ until: Date | null }>("select ledger.claim($1, $2, $3, $4) as until", [
                    item,
                    testId("asg"),
                    request(),
                    client.session,
                  ])
                )[0]?.until ?? null
              );
            } finally {
              await query("rollback");
            }
          });
          expect(answer?.can, `${client.name} ${item}`).toBe(until !== null);
        }
      }
      for (const row of await w.admin<{ id: string; client_id: string; opportunity_id: string }>(
        "select id, client_id, opportunity_id from ledger.work_notices where state = 'pending'",
      )) {
        const [current] = await queryAs<{ current: boolean }>(
          w.db.urls.notify ?? "",
          "select ledger.notice_current($1) as current",
          [row.id],
        );
        const [due] = await asOwner<{ due: boolean }>(w.db, "select ledger.notice_due($1, $2) as due", [
          row.opportunity_id,
          row.client_id,
        ]);
        expect(current?.current).toBe(due?.due);
      }
    }));

  it("pi_notify holds exactly its grants; no runtime role writes a notice or a decline; pi_work holds nothing on either", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      await agent(w, "a");
      const id = await task(w, scout);
      await w.killSwitch("off");
      const notify = w.db.urls.notify ?? "";
      const as = (text: string, values: unknown[] = []) => sqlState(() => queryAs(notify, text, values));
      expect(await queryAs(notify, "select state from ledger.kill_switch")).toEqual([{ state: "off" }]);
      const [row] = await queryAs<{ id: string }>(
        notify,
        "select id, client_id, opportunity_id, event, tier, kind, role, txid, state, attempts, last_code, next_try_at, delivered_at, created_at from ledger.work_notices",
      );
      expect(
        await as(
          "update ledger.work_notices set state = 'delivered', attempts = 1, last_code = 'http_204', next_try_at = now(), delivered_at = now() where id = $1",
          [row?.id],
        ),
      ).toBeNull();
      expect(await as("update ledger.work_notices set event = 'routed' where id = $1", [row?.id])).toBe("42501");
      expect(await as("select client_id, address from policy.client_webhooks")).toBeNull();
      expect(await as("select ruling_id from policy.client_webhooks")).toBe("42501");
      expect(await as("select ledger.notice_current($1)", [row?.id])).toBeNull();
      for (const sql of [
        "select 1 from ledger.opportunities",
        "select 1 from ledger.record_events",
        "select 1 from policy.clients",
        "select 1 from ledger.cards",
        "select 1 from policy.secrets",
        "select 1 from vault.evidence_items",
        "select 1 from ledger.work_declines",
        `select ledger.claimable_by('${id}', 'cli_x')`,
        "insert into ledger.work_notices (id, client_id, opportunity_id, txid) values ('ntc_01JABCDEFGHJKMNPQRSTVWXYZ0', null, null, 1)",
        "delete from ledger.work_notices",
      ]) {
        expect(await as(sql), sql).toBe("42501");
      }
      for (const url of [w.db.urls.admin, w.db.urls.work, w.db.urls.writer]) {
        expect(
          await sqlState(() =>
            queryAs(
              url,
              "insert into ledger.work_notices (id, client_id, opportunity_id, txid) values ('ntc_01JABCDEFGHJKMNPQRSTVWXYZ0', null, null, 1)",
            ),
          ),
        ).toBe("42501");
        expect(
          await sqlState(() =>
            queryAs(
              url,
              "insert into ledger.work_declines (opportunity_id, client_id, expires_at) values ($1, 'cli_x', now() + interval '1 day')",
              [id],
            ),
          ),
        ).toBe("42501");
      }
      for (const table of ["ledger.work_notices", "ledger.work_declines", "policy.client_webhooks"]) {
        expect(await sqlState(() => queryAs(w.db.urls.work, `select 1 from ${table}`)), table).toBe("42501");
      }
    }));

  it("a committed notice wakes a listener on another connection; a rolled-back one does not", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      await agent(w, "a");
      let woken = 0;
      const listener = await listenNotices(w.db.urls.notify ?? "", w.log, {
        onNotice: () => (woken += 1),
        onLost: () => {},
      });
      try {
        const wait = () => new Promise((resolve) => setTimeout(resolve, 300));
        // A go rolled back: no notice and no wake.
        const id = await task(w, scout);
        await vi.waitFor(() => expect(woken).toBeGreaterThan(0), { timeout: 20_000 });
        // Anything else of this go arrives before this.
        await wait();
        const after = woken;
        const client = new pg.Client({ connectionString: w.db.urls.work });
        await client.connect();
        try {
          await client.query("begin");
          await client.query(
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('opportunity', $1, 'go', now(), 'system:work', '{own}', 'lease_expired')",
            [id],
          );
          await client.query("rollback");
        } finally {
          await client.end();
        }
        await wait();
        expect(woken).toBe(after);
      } finally {
        await listener.close();
      }
    }));

  it("only the owner sets an address, each a decision; rm and revoke remove the row; list shows whether, never the address", () =>
    withWorkWorld(async (w) => {
      const a = await agent(w, "a");
      const b = await agent(w, "b");
      expect(
        await w.admin(
          "select kind, target_id from knowledge.owner_decisions where kind = 'webhook_set' order by target_id",
        ),
      ).toEqual([a.id, b.id].sort().map((id) => ({ kind: "webhook_set", target_id: id })));
      // No agent or runtime role writes one.
      for (const url of [w.db.urls.work, w.db.urls.writer, w.db.urls.notify ?? ""]) {
        expect(
          await sqlState(() =>
            queryAs(
              url,
              "insert into policy.client_webhooks (client_id, address, ruling_id) values ($1, 'https://x.example.org/', 'rul_x')",
              [a.id],
            ),
          ),
        ).toBe("42501");
      }
      expect(
        await sqlState(() =>
          readAs(w.db, a.token, (query) =>
            query("update policy.client_webhooks set address = 'https://elsewhere.example.org/'"),
          ),
        ),
      ).toBe("42501");
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        expect(
          (await admin.clients.listClients())
            .filter((row) => row.name === "a" || row.name === "b")
            .map((row) => row.webhook),
        ).toEqual([true, true]);
        expect(JSON.stringify(await admin.clients.listClients())).not.toContain(ADDRESS);
        expect(await admin.clients.removeWebhook("a")).toEqual({ client: a.id, removed: true });
        expect(await admin.clients.revokeClient("b")).toBe(true);
        expect(await w.admin("select client_id from policy.client_webhooks")).toEqual([]);
        expect(
          await w.admin(
            "select target_id from knowledge.owner_decisions where kind = 'webhook_removed' order by target_id",
          ),
        ).toEqual([a.id, b.id].sort().map((id) => ({ target_id: id })));
      } finally {
        await admin.close();
      }
    }));

  // The body a routine reads carries the item's due time, and its text is built from codes alone,
  // whatever the item's summary says.
  it("a notice carries its item's due time; the body sent holds no word of the item's summary", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const net = await agent(w, "net", { roles: ["network"] });
      const now = new Date();
      const dueAt = new Date(now.getTime() + 10 * 24 * 3_600_000).toISOString();
      const id = await task(w, scout, {
        role: "network",
        summary: "Meet Alex Example about the Riverside clinic",
        dueAt,
      });
      const undated = await task(w, scout, { role: "network" });
      expect(
        await w.admin(
          "select opportunity_id, due_at from ledger.work_notices where client_id = $1 order by created_at",
          [net.id],
        ),
      ).toEqual([
        { opportunity_id: id, due_at: new Date(dueAt) },
        { opportunity_id: undated, due_at: null },
      ]);
      const store = createNotices(w.db.urls.notify ?? "", w.log);
      try {
        // Work notices alone here (a box health card's shares the same page).
        const due = (await store.due(new Date(Date.now() + 60_000))).flatMap((one) =>
          one.notice.event === "box_health" || one.notice.event === "gap_batch" || one.notice.event === "agent_message"
            ? []
            : [one.notice],
        );
        expect(due.map((one) => [one.opportunity, one.deadline])).toEqual([
          [id, dueAt],
          [undated, null],
        ]);
        const sent = JSON.stringify(due.map((one) => noticeBody(one)));
        for (const word of ["Alex", "Example", "Riverside", "clinic", "Meet"]) expect(sent, word).not.toContain(word);
        // Ten days out when written: low, as an undated task is.
        expect(due.map((one) => noticeBody(one).priority)).toEqual(["low", "low"]);
      } finally {
        await store.close();
      }
    }));

  it("tainting an item makes its pending notices stale and removes its declines", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout", { webhook: false });
      const a = await agent(w, "a");
      await agent(w, "b");
      const id = await task(w, scout);
      ok(await release(w, a, id));
      await ownerUpdate(w, "ledger.opportunities", "tainted_at = now()", "id = $1", [id]);
      expect([...new Set((await notices(w, id)).map((row) => row.state))]).toEqual(["stale"]);
      expect(await w.admin("select 1 from ledger.work_declines where opportunity_id = $1", [id])).toEqual([]);
    }));
});
