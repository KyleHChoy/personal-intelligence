import {
  type AgentRecordId,
  agentMessageBody,
  type ChangesView,
  gapBatchBody,
  type OpportunityId,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { cancelTask, pingSettings, setClientRoles, setPingSettings, setTaskTier } from "../admin/admin-tasks.ts";
import { intentFor } from "../admin/cards/card-kinds-work.ts";
import { Reader } from "../read/read.ts";
import { gapSignalKey } from "../read/read-changes.ts";
import { request, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs, scanForPlaintext } from "../test-support/database.ts";
import { triedFor } from "../test-support/paid-questions.ts";
import { recordingPool } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personUnder as person, screened } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createNotices, noticeCounts, setWebhook } from "./notices.ts";

// The seam between the system and the owner's agents: one agent the owner names is pinged, assigns
// read-only work to another with no card, that agent picks it up and writes back, the assigner reads
// the result; an unclaimed ping falls back; knowledge gaps batch into one ping a day; an agent is never
// woken by its own write; get_changes says what changed under the caller's token. Synthetic rows only;
// role names and addresses are examples on reserved domains.

const OWN = ["own"];
const WORK = ["employer:example"];
const VIEWS = ["self", "people", "work"];
const TOOLS = [
  ...AGENT_WORK_TOOLS,
  "propose_task",
  "hand_off",
  "record",
  "get_changes",
  "write_back",
  "get_self",
  "list_opportunities",
  "post_agent_message",
  "read_agent_inbox",
  // A needs_owner write-back pays first: a search and a read, as triedFor makes them.
  "find_messages",
  "read_message",
];
const NAMES = ["lead", "researcher", "spare", "other", "outside"];
const SHARED = NAMES.map((name) => `agent:${name}`);
const WORLD = ["own", "employer:example", ...SHARED];
const inWorld = <T>(fn: (w: WorkWorld) => Promise<T>): Promise<T> => withWorkWorld(fn, WORLD);
const ADDRESS = "https://agent.example.org/hook";
const HOUR = 3_600_000;
const at = (ms: number): Date => new Date(Date.now() + ms);

async function agent(w: WorkWorld, name: string, roles: string[] = [], compartments = OWN): Promise<WorkClient> {
  const client = await w.client(name, compartments.includes("own") ? [...compartments, ...SHARED] : compartments, {
    tools: TOOLS,
    views: VIEWS,
  });
  for (const kind of ["investigate", "research"]) await w.harness(client, kind, "investigate");
  if (roles.length > 0) await setClientRoles(w.admin, name, roles, new Date());
  await setWebhook(w.admin, name, ADDRESS, new Date());
  return client;
}

const assign = async (
  w: WorkWorld,
  by: WorkClient,
  options: { role?: string; about?: string; dueAt?: string; refs?: string[]; hypothesis?: string } = {},
) => {
  const refs = options.refs ?? [await screened(w)];
  const made = ok(
    await w.work.proposeTask(by.token, {
      kind: "investigate",
      about: options.about === undefined ? { kind: "owner" } : { kind: "entity", id: options.about as never },
      summary: "find who runs the clinic and what it works on",
      basis: refs.map((id) => ({ kind: "message" as const, id: id as never })),
      ...(options.hypothesis === undefined ? {} : { hypothesis: options.hypothesis as never }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as never }),
      requestId: request(),
    }),
  );
  return made;
};

const noticesOf = (w: WorkWorld, item: string) =>
  w.admin<{ client_id: string; event: string; batched: boolean; state: string }>(
    `select client_id, event, batched, state from ledger.work_notices where opportunity_id = $1 and client_id is not null order by created_at, id`,
    [item],
  );

// A gap code raised, decided go, about a person.
async function gap(w: WorkWorld, subject: string, compartments = OWN): Promise<string> {
  const message = await screened(w, compartments);
  const [row] = await queryAs<{ id: string | null }>(
    w.db.urls.work,
    "select ledger.raise_gap_flag($1, 'no_warm_path', $2, 'entity', $2, 'message', $3, null, null, true) as id",
    [testId("opp"), subject, message],
  );
  return row?.id as string;
}

// How long an item has waited on its place, as a test's stand-in for waiting.
const toldAgo = (w: WorkWorld, item: string, hours: number): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("update ledger.ping_walks set told_at = now() - make_interval(hours => $2) where opportunity_id = $1", [
      item,
      hours,
    ]);
  });
const fallBack = async (w: WorkWorld): Promise<number> =>
  (await queryAs<{ n: number }>(w.db.urls.work, "select ledger.fall_back_pings(now()) as n"))[0]?.n ?? -1;

// One statement as pi_owner, the table's owner, past its forced row security and its triggers: a
// test's stand-in for a claim, or for rung 0 closing a task.
const stored = (w: WorkWorld, table: string, text: string, values: unknown[]): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`alter table ${table} disable trigger user`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} enable trigger user`);
      await query(`alter table ${table} force row level security`);
    }
  });

// Past the five minutes between computing a client's signals, as a test's stand-in for waiting.
const signalsDue = (w: WorkWorld, client: WorkClient): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("update ledger.change_cursors set computed_at = null where client_id = $1", [client.id]);
  });
const changesOf = async (w: WorkWorld, client: WorkClient, since?: string): Promise<ChangesView> =>
  ok(await w.reader.getChanges(client.token, since === undefined ? {} : { since }));

async function sent(
  w: WorkWorld,
  compartments: string[],
  direction: "inbound" | "outbound",
  when: Date,
  thread?: string,
) {
  const message = await w.message(compartments);
  await w.admin(
    "update knowledge.messages set direction = $2, sent_at = $3, bulk = false, thread_fp = coalesce($4, thread_fp) where id = $1",
    [message.id, direction, when.toISOString(), thread ?? null],
  );
  const [row] = await w.admin<{ thread_fp: string }>("select thread_fp from knowledge.messages where id = $1", [
    message.id,
  ]);
  return { ...message, thread: row?.thread_fp as string };
}
async function interaction(
  w: WorkWorld,
  evidence: string,
  entity: string,
  direction: "inbound" | "outbound",
  compartments: string[],
) {
  await w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
     values ($1, $2, 'm-owner', $3, $4, 'email', now() - interval '10 days', $5, '{m-owner}', $6)`,
    [
      interactionId(evidence, entity),
      evidence,
      entity,
      direction,
      compartments,
      direction === "inbound" ? "sender" : "recipient",
    ],
  );
}
async function conversation(w: WorkWorld, compartments: string[]) {
  const who = await person(w, compartments);
  const inbound = await sent(w, compartments, "inbound", at(-HOUR));
  await interaction(w, inbound.evidence, who, "inbound", compartments);
  const mine = await sent(w, compartments, "outbound", at(-30 * 24 * HOUR), inbound.thread);
  await interaction(w, mine.evidence, who, "outbound", compartments);
  return { ...inbound, who };
}

describe("assignment", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a task about the owner goes with no card, whatever earlier cards on the owner's kind of work say", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      await agent(w, "researcher", ["research"]);
      // The cause on the box: a case about the owner has no subject, so one card on any investigate about
      // the owner bound every later one to a card.
      const first = await assign(w, lead);
      await w.admin(
        `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
           select $1, $2, now(), 'system:work', 'opportunity', 'opportunity', o.id, '{go,no_go}', 14, o.case_id, o.compartments from ledger.opportunities o where o.id = $3`,
        [testId("crd"), testId("req"), first.opportunity],
      );
      const second = await assign(w, lead, { role: "research" });
      expect(second.status).toBe("go");
      // And it is its own task, not merged into the first.
      expect(second.opportunity).not.toBe(first.opportunity);
      expect(second).not.toHaveProperty("merged");
      const cards = await w.admin<{ n: number }>("select count(*)::int as n from ledger.cards where target_id = $1", [
        second.opportunity,
      ]);
      expect(cards[0]?.n).toBe(0);
    }));

  it("about a subject: a card still waiting holds a task, one answered does not, and the owner's no still does", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const subject = await person(w);
      const first = await assign(w, lead, { about: subject });
      const card = testId("crd");
      await w.admin(
        `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
           select $1, $2, now(), 'system:work', 'opportunity', 'opportunity', o.id, '{go,no_go}', 14, o.case_id, o.compartments from ledger.opportunities o where o.id = $3`,
        [card, testId("req"), first.opportunity],
      );
      await w.status("opportunity", first.opportunity, "withdrawn", "system:gaps");
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) select 'card', c.id, 'pending', now(), 'system:work', c.compartments from ledger.cards c where c.id = $1",
        [card],
      );
      expect((await assign(w, lead, { about: subject })).status).toBe("proposed");
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) select 'card', c.id, 'answered', clock_timestamp(), 'owner', c.compartments from ledger.cards c where c.id = $1",
        [card],
      );
      await w.status(
        "opportunity",
        (await w.admin<{ id: string }>("select id from ledger.opportunities order by created_at desc limit 1"))[0]
          ?.id as string,
        "withdrawn",
        "system:gaps",
      );
      const answered = await assign(w, lead, { about: subject });
      expect(answered.status).toBe("go");
      // The owner's no holds: another agent's same work goes to the owner as a card.
      const spare = await agent(w, "spare");
      expect(await cancelTask(w.admin, answered.opportunity as OpportunityId, new Date())).toBe(true);
      expect((await assign(w, spare, { about: subject })).status).toBe("proposed");
    }));

  it("about the owner, a no binds the same refs from anyone, and only them", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare");
      const m1 = await screened(w);
      const first = await assign(w, lead, { refs: [m1] });
      expect(first.status).toBe("go");
      expect(await cancelTask(w.admin, first.opportunity as OpportunityId, new Date())).toBe(true);
      // The same agent, the same refs: declined, as its own case's no.
      expect((await assign(w, lead, { refs: [m1] })).status).toBe("no_go");
      // One old ref and one new is no longer held (the test after this one).
      // The same refs from another agent: the owner's card, never go.
      expect((await assign(w, spare, { refs: [m1] })).status).toBe("proposed");
      // From the same agent under a hypothesis of its own, on work the owner declined: the same.
      const m2 = await screened(w);
      const second = await assign(w, lead, { refs: [m2] });
      expect(await cancelTask(w.admin, second.opportunity as OpportunityId, new Date())).toBe(true);
      const subject = await person(w);
      const { hypothesis } = ok(
        await w.work.proposeHypothesis(lead.token, {
          kind: "open_loop",
          about: { kind: "entity", id: subject as never },
          summary: "the clinic may be looking for help with its records",
          basis: [{ kind: "message", id: (await screened(w)) as never }],
          requestId: request(),
        }),
      );
      expect((await assign(w, lead, { refs: [m2], hypothesis: hypothesis as string })).status).toBe("proposed");
      // Other refs entirely: other work, of any class of ref.
      expect((await assign(w, lead)).status).toBe("go");
      const goal = await w.goal(OWN, "A goal to rest on.");
      const onGoal = ok(
        await w.work.proposeTask(lead.token, {
          kind: "investigate",
          about: { kind: "owner" },
          summary: "find what the goal needs next from the clinic",
          basis: [{ kind: "goal", id: goal as never }],
          requestId: request(),
        }),
      );
      expect(onGoal.status).toBe("go");
    }));

  it("about the owner, a no binds only a near-duplicate: work sharing one source with it goes, and a veto still holds", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const [m1, m2] = [await screened(w), await screened(w)];
      const declined = await assign(w, lead, { refs: [m1, m2] });
      expect(declined.status).toBe("go");
      expect(await cancelTask(w.admin, declined.opportunity as OpportunityId, new Date())).toBe(true);
      const reason = async (id: string) =>
        (
          await w.admin<{ reason: string }>(
            "select reason from ledger.opportunity_decisions where opportunity_id = $1",
            [id],
          )
        ).map((one) => one.reason);

      // A near-duplicate, within the week: every source of it is one the declined task rests on.
      const same = await assign(w, lead, { refs: [m1, m2] });
      expect(same.status).toBe("no_go");
      expect(await reason(same.opportunity)).toEqual(["owner_declined"]);
      const narrower = await assign(w, lead, { refs: [m2] });
      expect(narrower.status).toBe("no_go");
      expect(await reason(narrower.opportunity)).toEqual(["owner_declined"]);
      // Other work that cites one source in common with it: no longer held by the owner's no.
      const unrelated = await assign(w, lead, { refs: [m1, await screened(w)] });
      expect(unrelated.status).toBe("go");
      expect(await reason(unrelated.opportunity)).toEqual(["task"]);

      // A veto is its own rule: it refuses the near-duplicate and the unrelated work alike.
      await w.vetoKind("investigate");
      const vetoedSame = await assign(w, lead, { refs: [m1, m2] });
      const vetoedOther = await assign(w, lead, { refs: [await screened(w)] });
      expect([vetoedSame.status, vetoedOther.status]).toEqual(["no_go", "no_go"]);
      expect([await reason(vetoedSame.opportunity), await reason(vetoedOther.opportunity)]).toEqual([
        ["vetoed"],
        ["vetoed"],
      ]);
    }));

  it("the whole path: pinged, assigned to a role, that agent pinged, claims, reports, and the assigner reads the result", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());

      // Another agent's unrouted work pings the default alone, not the proposer or anyone else.
      const unrouted = await assign(w, other);
      expect(unrouted.status).toBe("go");
      expect((await noticesOf(w, unrouted.opportunity)).map((one) => one.client_id)).toEqual([lead.id]);

      // The default assigns to a role: no card, that role's agent is pinged, and not the assigner.
      const made = await assign(w, lead, { role: "research", about: await person(w) });
      expect(made.status).toBe("go");
      expect((await noticesOf(w, made.opportunity)).map((one) => [one.client_id, one.event])).toEqual([
        [researcher.id, "task_go"],
      ]);

      const id = made.opportunity as OpportunityId;
      ok(await w.work.claimOpportunity(researcher.token, { id, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(researcher.token, { opportunity: id, stage: "investigate", requestId: request() }),
      );
      const { recordId } = ok(
        await w.reader.record(researcher.token, {
          kind: "finding",
          body: "The clinic is run by its two founders, who started it in 2019.",
          requestId: request(),
        }),
      );
      ok(
        await w.work.reportMove(researcher.token, {
          move,
          outcome: "done",
          report: {
            deliverable: "The clinic is run by its two founders.",
            next: "Tell the owner who they are.",
            sources: [{ kind: "agent_record" as const, id: recordId as AgentRecordId }, "the clinic's own site"],
          },
          requestId: request(),
        }),
      );
      const closed = ok(await w.work.listOpportunities(lead.token, { scope: "closed" }));
      const found = closed.opportunities.find((one) => one.id === id);
      expect(found?.status).toBe("done");
      expect(JSON.stringify(found)).toContain("two founders");
    }));

  it("hand_off works, to a role or to an agent by name, and the new holder is pinged", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      const spare = await agent(w, "spare");
      await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());
      const made = await assign(w, spare, { about: await person(w) });
      const id = made.opportunity as OpportunityId;
      ok(await w.work.claimOpportunity(lead.token, { id, requestId: request() }));
      expect(
        ok(await w.work.handOff(lead.token, { id, role: "research", reason: "other_role", requestId: request() })),
      ).toEqual({
        handedOff: true,
      });
      expect((await noticesOf(w, id)).at(-1)).toMatchObject({ client_id: researcher.id, event: "routed" });
      ok(await w.work.claimOpportunity(researcher.token, { id, requestId: request() }));
      // By name: a client that holds no role.
      expect(
        ok(await w.work.handOff(researcher.token, { id, role: "spare", reason: "other", requestId: request() })),
      ).toEqual({
        handedOff: true,
      });
      expect((await noticesOf(w, id)).at(-1)).toMatchObject({ client_id: spare.id, event: "routed" });
      ok(await w.work.claimOpportunity(spare.token, { id, requestId: request() }));
      // A name that is neither is refused.
      expect(
        await w.work.handOff(spare.token, { id, role: "no-such-one", reason: "other", requestId: request() }),
      ).toEqual({
        ok: false,
        code: "unknown_role",
      });
    }));
});

describe("a claim and a move agree", { timeout: DB_TEST_TIMEOUT }, () => {
  const claimAs = (w: WorkWorld, client: WorkClient, id: string) =>
    w.work.claimOpportunity(client.token, { id: id as OpportunityId, requestId: request() });
  // An opportunity the owner said go on, under the intent given.
  const wentAhead = async (w: WorkWorld, intent: string): Promise<string> => {
    const id = await w.seed.opportunity(OWN);
    await w.decideGo(id, intent);
    return id;
  };

  it("an agent the go's intent excludes is not pinged and cannot claim, though another intent lists it", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare");
      for (const client of [lead, spare]) await w.harness(client, "follow_up", "investigate");
      const forSpare = await w.intent(["follow_up"], [spare], "owner_decides");
      await w.intent(["follow_up"], [lead], "owner_decides");
      await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());
      const id = await wentAhead(w, forSpare);
      expect((await noticesOf(w, id)).map((one) => one.client_id)).toEqual([spare.id]);
      expect((await claimAs(w, lead, id)).ok).toBe(false);
      expect((await claimAs(w, spare, id)).ok).toBe(true);
    }));

  it("the owner's go binds to the intent that lets the default agent work it", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare");
      const first = await w.intent(["follow_up"], [spare], "owner_decides");
      const second = await w.intent(["follow_up"], [lead], "owner_decides");
      expect((await intentFor(w.admin, "follow_up", "opportunity"))?.id).toBe(first);
      await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());
      expect((await intentFor(w.admin, "follow_up", "opportunity"))?.id).toBe(second);
    }));

  it("plan_move names why, and an agent cleared only to propose cannot claim", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      await w.harness(lead, "follow_up", "investigate");
      const intent = await w.intent(["follow_up"], [lead], "owner_decides");
      const id = await wentAhead(w, intent);
      ok(await claimAs(w, lead, id));
      await w.admin("update policy.intents set revoked_at = now() where id = $1", [intent]);
      expect(
        await w.work.planMove(lead.token, {
          opportunity: id as OpportunityId,
          stage: "investigate",
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "not_permitted", refusal: "intent_revoked" });

      const spare = await agent(w, "spare");
      await w.harness(spare, "follow_up", "investigate", "propose");
      const open = await w.intent(["follow_up"], [spare], "owner_decides");
      expect((await claimAs(w, spare, await wentAhead(w, open))).ok).toBe(false);
    }));

  it("a new check-back replaces the client's earlier one unless it says otherwise, and parking holds the item", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      const spare = await agent(w, "spare");
      const { opportunity } = await assign(w, spare, { about: await person(w) });
      const id = opportunity as OpportunityId;
      ok(await claimAs(w, lead, id));
      const live = async (): Promise<number> =>
        (
          await w.admin<{ n: number }>(
            `select count(*)::int as n from ledger.intentions i where i.opportunity_id = $1
             and (select r.event from ledger.record_events r where r.row_kind = 'intention' and r.row_id = i.id order by r.id desc limit 1) = 'set'`,
            [id],
          )
        )[0]?.n ?? -1;
      const dueAt = at(48 * HOUR).toISOString() as never;
      ok(await w.work.setIntention(lead.token, { opportunity: id, dueAt, requestId: request() }));
      ok(await w.work.setIntention(lead.token, { opportunity: id, dueAt, requestId: request() }));
      expect(await live()).toBe(1);
      ok(await w.work.setIntention(lead.token, { opportunity: id, dueAt, keepEarlier: true, requestId: request() }));
      expect(await live()).toBe(2);

      const until = at(5 * 24 * HOUR);
      ok(
        await w.work.setIntention(lead.token, {
          opportunity: id,
          dueAt: until.toISOString() as never,
          park: true,
          requestId: request(),
        }),
      );
      expect(await live()).toBe(1);
      const [lease] = await w.admin<{ holder: string; lease_until: Date }>(
        "select holder, lease_until from queue.leases where resource_id = $1",
        [id],
      );
      expect(lease?.holder).toBe(lead.id);
      expect(lease?.lease_until.getTime()).toBeGreaterThanOrEqual(until.getTime());
      // Nothing else is offered it, and nobody is pinged for it while it waits.
      expect(ok(await w.work.listOpportunities(spare.token, {})).opportunities.map((one) => one.id)).not.toContain(id);
      expect((await claimAs(w, spare, id)).ok).toBe(false);
      expect(await fallBack(w)).toBe(0);
      // Renewing its claim keeps the parked lease.
      ok(await claimAs(w, lead, id));
      const [renewed] = await w.admin<{ lease_until: Date }>(
        "select lease_until from queue.leases where resource_id = $1",
        [id],
      );
      expect(renewed?.lease_until.getTime()).toBeGreaterThanOrEqual(until.getTime());
      // Over the limit is refused.
      expect(
        (
          await w.work.setIntention(lead.token, {
            opportunity: id,
            dueAt: at(40 * 24 * HOUR).toISOString() as never,
            park: true,
            requestId: request(),
          })
        ).ok,
      ).toBe(false);
    }));
});

describe("pings", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent's own write wakes no one for it, with or without an order", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const made = await assign(w, lead);
      expect((await noticesOf(w, made.opportunity)).filter((one) => one.client_id === lead.id)).toEqual([]);
      await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());
      const own = await assign(w, lead, { about: await person(w) });
      expect((await noticesOf(w, own.opportunity)).filter((one) => one.client_id === lead.id)).toEqual([]);
    }));

  it("an unclaimed dated ping falls back after its wait, in the order set; a claimed one does not", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare");
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["role:chief", "client:spare"], datedMinutes: 120 }, new Date());
      const made = await assign(w, other, { about: await person(w), dueAt: at(5 * HOUR).toISOString() });
      const id = made.opportunity;
      expect((await noticesOf(w, id)).map((one) => one.client_id)).toEqual([lead.id]);
      // Not yet.
      await toldAgo(w, id, 1);
      expect(await fallBack(w)).toBe(0);
      await toldAgo(w, id, 3);
      expect(await fallBack(w)).toBe(1);
      expect((await noticesOf(w, id)).at(-1)).toMatchObject({ client_id: spare.id, event: "fallback", batched: false });
      // The order ends there.
      await toldAgo(w, id, 3);
      expect(await fallBack(w)).toBe(0);

      const claimed = await assign(w, other, { about: await person(w), dueAt: at(5 * HOUR).toISOString() });
      ok(await w.work.claimOpportunity(lead.token, { id: claimed.opportunity as OpportunityId, requestId: request() }));
      await toldAgo(w, claimed.opportunity, 3);
      expect(await fallBack(w)).toBe(0);
    }));

  it("a task routed to a role that does not take it opens to the order, unless the owner routed it", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["role:chief"], otherMinutes: 60 }, new Date());
      const made = await assign(w, other, { role: "research", about: await person(w) });
      expect((await noticesOf(w, made.opportunity)).map((one) => one.client_id)).toEqual([researcher.id]);
      await toldAgo(w, made.opportunity, 2);
      expect(await fallBack(w)).toBe(1);
      expect((await noticesOf(w, made.opportunity)).at(-1)).toMatchObject({ client_id: lead.id, event: "routed" });
      ok(await w.work.claimOpportunity(lead.token, { id: made.opportunity as OpportunityId, requestId: request() }));

      // A task the owner opened keeps the route the owner gave it, past its wait.
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const mine = await admin.work.addTask({
          role: "research" as never,
          kind: "investigate",
          about: [],
          note: "Find what the clinic does.",
          requestId: request(),
        });
        await toldAgo(w, mine.task, 2);
        expect(await fallBack(w)).toBe(0);
        expect((await w.admin("select 1 from ledger.ping_walks where opportunity_id = $1", [mine.task])).length).toBe(
          0,
        );
        expect(await w.latest("opportunity", mine.task)).toBe("go");
        expect(
          (await w.work.claimOpportunity(lead.token, { id: mine.task as OpportunityId, requestId: request() })).ok,
        ).toBe(false);
      } finally {
        await admin.close();
      }
    }));

  it("a routed task whose only holder has no address still opens when its wait is over", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const poller = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      await setClientRoles(w.admin, "researcher", ["research"], new Date());
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["role:chief"], otherMinutes: 60 }, new Date());
      const made = await assign(w, other, { role: "research", about: await person(w) });
      expect(await noticesOf(w, made.opportunity)).toEqual([]);
      await toldAgo(w, made.opportunity, 2);
      expect(await fallBack(w)).toBe(1);
      expect((await noticesOf(w, made.opportunity)).at(-1)).toMatchObject({ client_id: lead.id });
      expect(poller.id).toBeDefined();
    }));

  it("a first place with no address has its wait before the second may take the ping", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const poller = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      for (const kind of ["investigate", "research"]) await w.harness(poller, kind, "investigate");
      const lead = await agent(w, "lead", ["chief"]);
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["client:researcher", "role:chief"], datedMinutes: 120 }, new Date());
      const made = await assign(w, other, { about: await person(w), dueAt: at(5 * HOUR).toISOString() });
      expect(await noticesOf(w, made.opportunity)).toEqual([]);
      await toldAgo(w, made.opportunity, 1);
      expect(await fallBack(w)).toBe(0);
      await toldAgo(w, made.opportunity, 3);
      expect(await fallBack(w)).toBe(1);
      expect((await noticesOf(w, made.opportunity)).at(-1)).toMatchObject({ client_id: lead.id, event: "fallback" });
    }));

  it("a gap falls back at the next day's batch: about 24 hours a place, not 48", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare");
      await setPingSettings(w.admin, { order: ["role:chief", "client:spare"] }, new Date());
      const id = await gap(w, await person(w));
      expect(await noticesOf(w, id)).toMatchObject([{ client_id: lead.id, batched: true }]);
      await toldAgo(w, id, 22);
      expect(await fallBack(w)).toBe(0);
      await toldAgo(w, id, 23);
      expect(await fallBack(w)).toBe(1);
      const [row] = await w.admin<{ client_id: string; next_try_at: Date }>(
        "select client_id, next_try_at from ledger.work_notices where opportunity_id = $1 and event = 'fallback'",
        [id],
      );
      expect(row?.client_id).toBe(spare.id);
      expect((row?.next_try_at.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    }));

  it("no order is what it always was: every client that may take the item is told", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      const spare = await agent(w, "spare");
      const other = await agent(w, "other");
      const made = await assign(w, other, { about: await person(w) });
      expect((await noticesOf(w, made.opportunity)).map((one) => one.client_id).sort()).toEqual(
        [lead.id, spare.id].sort(),
      );
      expect(await fallBack(w)).toBe(0);
    }));

  it("knowledge gaps batch into one ping a day; a dated item goes at once", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const other = await agent(w, "other");
      await setPingSettings(w.admin, { order: ["role:chief"], batchHour: 13 }, new Date());
      const gaps = [await gap(w, await person(w)), await gap(w, await person(w))];
      for (const id of gaps)
        expect(await noticesOf(w, id)).toMatchObject([{ client_id: lead.id, batched: true, state: "pending" }]);
      const dated = await assign(w, other, { about: await person(w), dueAt: at(5 * HOUR).toISOString() });
      expect(await noticesOf(w, dated.opportunity)).toMatchObject([{ client_id: lead.id, batched: false }]);

      const store = createNotices(w.db.urls.notify ?? "", w.log);
      try {
        const now = await store.due(new Date());
        expect(now.filter((one) => one.notice.event === "gap_batch")).toEqual([]);
        const tomorrow = new Date(Date.now() + 26 * HOUR);
        const later = await store.due(tomorrow);
        const batches = later.flatMap((one) => (one.notice.event === "gap_batch" ? [one] : []));
        expect(batches).toHaveLength(1);
        expect(batches[0]?.client).toBe(lead.id);
        expect(batches[0]?.notice).toMatchObject({ event: "gap_batch", count: 2 });
        // What leaves: a count and fixed words, no item.
        const body = JSON.stringify(gapBatchBody(batches[0]?.notice as never));
        for (const id of gaps) expect(body).not.toContain(id);
        // Folded once: a second sweep does not fold them again.
        await store.mark(batches[0]?.notice.notice as never, {
          state: "delivered",
          attempts: 1,
          lastCode: null,
          nextTryAt: new Date(),
          deliveredAt: new Date(),
        });
        expect((await store.due(tomorrow)).filter((one) => one.notice.event === "gap_batch")).toEqual([]);
        for (const id of gaps) expect(await noticesOf(w, id)).toMatchObject([{ state: "rolled" }]);
      } finally {
        await store.close();
      }
    }));

  it("the owner's settings are the owner's decision, and name only what exists", () =>
    inWorld(async (w) => {
      await agent(w, "lead", ["chief"]);
      await expect(setPingSettings(w.admin, { order: ["role:nobody"] }, new Date())).rejects.toThrow();
      await setPingSettings(w.admin, { order: ["role:chief", "client:lead"], datedMinutes: 30 }, new Date());
      await setPingSettings(w.admin, { signalRole: { kind: "reply_waiting", role: "chief" } }, new Date());
      expect(await pingSettings(w.admin)).toEqual({
        order: ["role:chief", "client:lead"],
        datedMinutes: 30,
        otherMinutes: 1440,
        batchHour: 13,
        signalRoles: { reply_waiting: "chief" },
      });
      const [row] = await w.admin<{ n: number }>(
        "select count(*)::int as n from knowledge.owner_decisions where kind = 'ping_settings'",
      );
      expect(row?.n).toBe(2);
    }));
});

describe("an agent that only polls", { timeout: DB_TEST_TIMEOUT }, () => {
  it("learns of a message and of work by id; an uncleared agent learns nothing", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      for (const kind of ["investigate", "research"]) await w.harness(researcher, kind, "investigate");
      await setClientRoles(w.admin, "researcher", ["research"], new Date());
      const narrow = await w.client("other", WORK, { tools: TOOLS, views: VIEWS });
      const first = await changesOf(w, researcher);
      expect((await changesOf(w, narrow)).changes).toEqual([]);

      const posted = ok(
        await w.work.postAgentMessage(lead.token, {
          to: { client: "researcher" } as never,
          subject: "About the clinic",
          body: "Who runs it?",
          kind: "question",
          requestId: request(),
        }),
      );
      const made = await assign(w, lead, { role: "research", about: await person(w) });
      const seen = await changesOf(w, researcher, first.cursor ?? undefined);
      expect(seen.changes.find((c) => c.change === "message")).toMatchObject({ id: posted.message });
      expect(seen.changes.find((c) => c.change === "work")).toMatchObject({ id: made.opportunity });
      expect(JSON.stringify(seen)).not.toContain("clinic");
      // Once.
      expect((await changesOf(w, researcher, seen.cursor as string)).changes).toEqual([]);
      expect((await changesOf(w, narrow)).changes).toEqual([]);
    }));

  it("a poll sees what committed behind its last look, once; an unrouted task; two reads at once both answer", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      for (const kind of ["investigate", "research"]) await w.harness(researcher, kind, "investigate");
      const first = await changesOf(w, researcher);
      const posted = ok(
        await w.work.postAgentMessage(lead.token, {
          to: { client: "researcher" } as never,
          subject: "A question",
          body: "Who runs it?",
          kind: "question",
          requestId: request(),
        }),
      );
      // Stamped when its transaction began, before the last poll looked.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("update ledger.change_cursors set polled_at = now() + interval '1 minute' where client_id = $1", [
          researcher.id,
        ]);
      });
      const behind = await changesOf(w, researcher, first.cursor ?? undefined);
      expect(behind.changes.find((c) => c.change === "message")).toMatchObject({ id: posted.message });
      expect((await changesOf(w, researcher, behind.cursor ?? undefined)).changes).toEqual([]);

      const unrouted = await assign(w, lead, { about: await person(w) });
      const after = await changesOf(w, researcher, behind.cursor ?? undefined);
      expect(after.changes.find((c) => c.change === "work")).toMatchObject({ id: unrouted.opportunity });

      const both = await Promise.all([
        w.reader.getChanges(researcher.token, {}),
        w.reader.getChanges(researcher.token, {}),
      ]);
      expect(both.map((one) => one.ok)).toEqual([true, true]);
    }));

  it("the board and the inbox say how many changes wait, for the caller alone, and saying so marks nothing read", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      for (const kind of ["investigate", "research"]) await w.harness(researcher, kind, "investigate");
      await setClientRoles(w.admin, "researcher", ["research"], new Date());
      const narrow = await w.client("other", WORK, { tools: TOOLS, views: VIEWS });
      const noFeed = await w.client("spare", [...OWN, ...SHARED], {
        tools: TOOLS.filter((tool) => tool !== "get_changes"),
        views: VIEWS,
      });
      const waiting = async (client: WorkClient) => ({
        board: ok(await w.work.listOpportunities(client.token, { scope: "board" })).changes,
        open: ok(await w.work.listOpportunities(client.token, {})).changes,
        inbox: ok(await w.work.readAgentInbox(client.token, { markRead: false })).changes,
      });
      const none = { board: { waiting: 0 }, open: { waiting: 0 }, inbox: { waiting: 0 } };
      // What the feed keeps of the researcher: its log and where it read to.
      const feed = async () =>
        JSON.stringify([
          await w.admin(
            "select signal_key, kind, print, logged_at from ledger.change_log where client_id = $1 order by signal_key",
            [researcher.id],
          ),
          await w.admin(
            "select logged_at, signal_key, polled_at, computed_at from ledger.change_cursors where client_id = $1",
            [researcher.id],
          ),
        ]);

      // Read to the end: nothing waits.
      await changesOf(w, researcher);
      await changesOf(w, narrow);
      expect(await waiting(researcher)).toEqual(none);
      const narrowBefore = JSON.stringify(await waiting(narrow));

      // A message to the researcher and a task for its role, neither of them the narrow client's to see.
      ok(
        await w.work.postAgentMessage(lead.token, {
          to: { client: "researcher" } as never,
          subject: "About the clinic",
          body: "Who runs it?",
          kind: "question",
          requestId: request(),
        }),
      );
      await assign(w, lead, { role: "research", about: await person(w) });
      const kept = await feed();
      const counted = await waiting(researcher);
      expect(counted.board).toEqual({ waiting: 2 });
      expect(counted.open).toEqual(counted.board);
      expect(counted.inbox).toEqual(counted.board);
      // Counting wrote nothing: no log row, no poll, and the cursor where it was.
      expect(await feed()).toBe(kept);
      // So the feed still serves every one of them, as many as the board said.
      const seen = await changesOf(w, researcher);
      expect(seen.changes.length).toBeGreaterThanOrEqual(counted.board?.waiting ?? Number.POSITIVE_INFINITY);
      expect(seen.changes.filter((one) => one.change === "message" || one.change === "work")).toHaveLength(2);
      // Once read, nothing waits.
      expect(await waiting(researcher)).toEqual(none);
      // The count is the caller's own: a client that sees neither is told what it was told before,
      // the sender is not told of its own message, and a client with no feed is told nothing.
      expect(JSON.stringify(await waiting(narrow))).toBe(narrowBefore);
      expect(await waiting(noFeed)).toEqual({ board: undefined, open: undefined, inbox: undefined });
      // A refusal carries no count.
      expect(
        await w.work.listOpportunities(researcher.token, { scope: "closed", project: testId("ent") as never }),
      ).toEqual({ ok: false, code: "invalid_request" });
    }));

  it("an empty poll: few statements, nothing opened, no row counted", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      await conversation(w, OWN);
      await changesOf(w, lead);
      const recorded = recordingPool(w.pool);
      const reader = new Reader({ pool: recorded.pool, keys: w.keys, log: w.log });
      recorded.statements.length = 0;
      const answer = ok(await reader.getChanges(lead.token, {}));
      expect(answer.changes).toEqual([]);
      const statements = [...recorded.statements];
      expect(statements.length).toBeLessThanOrEqual(14);
      expect(statements.join("\n")).not.toMatch(/_enc\b|knowledge\.messages/);
      const [call] = await w.admin<{ rows: number; outcome: string }>(
        "select rows, outcome from policy.calls where client_id = $1 and tool = 'get_changes' order by id desc limit 1",
        [lead.id],
      );
      expect(call).toEqual({ rows: 0, outcome: "ok" });
    }));
});

describe("a message wakes its recipient", { timeout: DB_TEST_TIMEOUT }, () => {
  const pings = (w: WorkWorld, client: WorkClient) =>
    w.admin<{ state: string }>(
      "select state from ledger.batch_notices where client_id = $1 and event = 'agent_message' order by created_at",
      [client.id],
    );
  const post = (w: WorkWorld, from: WorkClient, to: Record<string, unknown>, subject = "A question about the clinic") =>
    w.work.postAgentMessage(from.token, {
      to: to as never,
      subject,
      body: "Who runs it?",
      kind: "question",
      requestId: request(),
    });
  const replyTo = (w: WorkWorld, from: WorkClient, message: string) =>
    w.work.postAgentMessage(from.token, {
      replyTo: message as never,
      body: "Its two founders.",
      kind: "answer",
      requestId: request(),
    });

  it("by name, by role and to all: never the sender, never an uncleared agent, and no address raises nothing", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead", ["chief"]);
      const spare = await agent(w, "spare", ["chief"]);
      const narrow = await agent(w, "other", [], WORK);
      const noAddress = await w.client("researcher", [...OWN, ...SHARED], { tools: TOOLS, views: VIEWS });
      ok(await post(w, lead, { client: "spare" }));
      expect(await pings(w, spare)).toHaveLength(1);
      expect(await pings(w, lead)).toEqual([]);
      ok(await post(w, spare, { role: "chief" }));
      expect(await pings(w, lead)).toHaveLength(1);
      expect(await pings(w, spare)).toHaveLength(1);
      ok(await post(w, lead, { all: true }));
      // The other is cleared only for its compartment: the message's label is not within it.
      expect(await pings(w, narrow)).toEqual([]);
      expect(await pings(w, noAddress)).toEqual([]);
      // No word of it is in what leaves.
      const store = createNotices(w.db.urls.notify ?? "", w.log);
      try {
        const due = (await store.due(new Date())).flatMap((one) =>
          one.notice.event === "agent_message" ? [one.notice] : [],
        );
        expect(due.length).toBeGreaterThan(0);
        expect(JSON.stringify(due.map((one) => agentMessageBody(one)))).not.toContain("clinic");
      } finally {
        await store.close();
      }
      // The agent with no address still reads it.
      const inbox = await w.work.readAgentInbox(noAddress.token, {});
      expect(inbox.ok).toBe(true);
    }));

  it("two agents replying to each other make one ping each until each reads its inbox", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      const spare = await agent(w, "spare");
      const first = ok(await post(w, lead, { client: "spare" }));
      // Unread on both sides: replies pile up, pings do not.
      for (let n = 0; n < 6; n += 1) {
        ok(await replyTo(w, n % 2 === 0 ? spare : lead, first.message));
      }
      expect(await pings(w, spare)).toHaveLength(1);
      expect(await pings(w, lead)).toHaveLength(1);
      // Delivered and still unread: nothing more.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "update ledger.batch_notices set state = 'delivered', delivered_at = now(), created_at = created_at - interval '1 minute'",
        );
      });
      ok(await replyTo(w, lead, first.message));
      expect(await pings(w, spare)).toHaveLength(1);
      // What it cost, as counts: many messages, few pings.
      const counted = await noticeCounts(w.admin, new Date(Date.now() - HOUR));
      expect(counted.messages.posted).toBeGreaterThanOrEqual(8);
      expect(counted.messages.pinged).toBe(2);
      // Read: the next message pings again.
      ok(await w.work.readAgentInbox(spare.token, {}));
      ok(await replyTo(w, lead, first.message));
      expect(await pings(w, spare)).toHaveLength(2);
    }));
});

describe("a wake-up that cannot stop for good", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an hour on, a delivered ping unread no longer holds the next", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      const spare = await agent(w, "spare");
      const post = () =>
        w.work.postAgentMessage(lead.token, {
          to: { client: "spare" } as never,
          subject: "A question",
          body: "Who runs it?",
          kind: "question",
          requestId: request(),
        });
      ok(await post());
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("update ledger.batch_notices set state = 'delivered', created_at = now() - interval '2 hours'");
      });
      ok(await post());
      const rows = await w.admin("select 1 from ledger.batch_notices where client_id = $1 and state = 'pending'", [
        spare.id,
      ]);
      expect(rows).toHaveLength(1);
    }));
});

describe("get_changes and write_back", { timeout: DB_TEST_TIMEOUT }, () => {
  it("what changed, once, with a cursor per client; a stable order; a read log", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      const owed = await conversation(w, OWN);
      await setPingSettings(w.admin, { signalRole: { kind: "reply_waiting", role: "chief" } }, new Date());
      const one = await changesOf(w, lead);
      const reply = one.changes.find((c) => c.change === "signal" && c.kind === "reply_waiting");
      expect(reply).toMatchObject({ source: { kind: "message", id: owed.id }, role: "chief" });
      expect(one.cursor).not.toBeNull();
      // Nothing new, from where it read to, with the cursor or without.
      expect((await changesOf(w, lead, one.cursor as string)).changes).toEqual([]);
      expect((await changesOf(w, lead)).changes).toEqual([]);
      // A second client has a cursor of its own.
      expect((await changesOf(w, researcher)).changes.map((c) => c.key)).toContain(reply?.key);
      // Replaying from the start gives the same order.
      const rows = await w.admin<{ n: number }>(
        "select count(*)::int as n from ledger.read_log where tool = 'get_changes' and shown @> array[$1]::text[]",
        [owed.evidence],
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    }));

  it("handled clears a signal for another agent and held keeps it marked; neither is a claim", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      const owed = await conversation(w, OWN);
      const seen = await changesOf(w, researcher);
      const source = { kind: "message" as const, id: owed.id as never };
      const claimsBefore = await w.admin<{ n: number }>("select count(*)::int as n from knowledge.claims");
      const writesBefore = await w.admin<{ n: number }>("select count(*)::int as n from ledger.agent_writes");

      ok(
        await w.work.writeBack(lead.token, {
          source,
          state: "drafted",
          note: "A draft waits on the owner.",
          requestId: request(),
        }),
      );
      const held = await changesOf(w, researcher, seen.cursor as string);
      const signal = held.changes.find((c) => c.change === "signal");
      expect(signal).toMatchObject({ kind: "reply_waiting", state: "drafted" });
      const wrote = held.changes.find((c) => c.change === "write_back");
      expect(wrote).toMatchObject({ by: "lead", state: "drafted", note: { untrusted: "A draft waits on the owner." } });
      // The caller's own write-back is no news to it.
      expect((await changesOf(w, lead)).changes.filter((c) => c.change === "write_back")).toEqual([]);
      const selfHeld = ok(await w.reader.getSelf(researcher.token)).next?.moves.find((m) => m.kind === "reply");
      expect(selfHeld?.state).toBe("drafted");

      ok(await w.work.writeBack(lead.token, { source, state: "handled", note: "Answered.", requestId: request() }));
      const cleared = await changesOf(w, researcher, held.cursor as string);
      expect(cleared.changes.some((c) => c.change === "cleared" && c.key === signal?.key)).toBe(true);
      expect(ok(await w.reader.getSelf(researcher.token)).next?.moves.filter((m) => m.kind === "reply")).toEqual([]);

      // A note is sealed: with marks, the log and the cursors filled, its text is in no column.
      expect(await scanForPlaintext(w.db.urls.admin, ["A draft waits on the owner."])).toEqual([]);
      expect((await w.admin<{ n: number }>("select count(*)::int as n from knowledge.claims"))[0]?.n).toBe(
        claimsBefore[0]?.n,
      );
      expect((await w.admin<{ n: number }>("select count(*)::int as n from ledger.agent_writes"))[0]?.n).toBe(
        writesBefore[0]?.n,
      );
    }));

  it("mail the owner sends clears an owed reply by itself, and a repeat answers the first", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      const owed = await conversation(w, OWN);
      const first = await changesOf(w, lead);
      const signal = first.changes.find((c) => c.change === "signal");
      await sent(w, OWN, "outbound", at(-1000), owed.thread);
      await signalsDue(w, lead);
      const after = await changesOf(w, lead, first.cursor as string);
      expect(after.changes.some((c) => c.change === "cleared" && c.key === signal?.key)).toBe(true);
      const requestId = request();
      const source = { kind: "message" as const, id: owed.id as never };
      const one = ok(await w.work.writeBack(lead.token, { source, state: "handled", requestId }));
      expect(ok(await w.work.writeBack(lead.token, { source, state: "handled", requestId }))).toEqual(one);
    }));

  it("a person who first wrote this week and a gap on the board are signals", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      const who = await person(w);
      const inbound = await sent(w, OWN, "inbound", at(-HOUR));
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
         values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '1 hour', $4, '{m-owner}', 'sender')`,
        [interactionId(inbound.evidence, who), inbound.evidence, who, OWN],
      );
      const flagged = await gap(w, await person(w));
      const { changes } = await changesOf(w, lead);
      expect(changes.find((c) => c.change === "signal" && c.kind === "new_person")).toMatchObject({
        source: { kind: "entity", id: who },
      });
      expect(changes.find((c) => c.change === "signal" && c.kind === "gap")).toMatchObject({
        source: { kind: "opportunity", id: flagged },
      });
    }));

  it("invariant 6: a viewer's feed, ids and all, is the same with rows it cannot see beside it", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const viewer = await agent(w, "other");
      const wide = await agent(w, "outside", ["chief"], ["own", "employer:example", ...SHARED]);
      const owed = await conversation(w, OWN);
      const before = await changesOf(w, viewer);
      const keys = (view: ChangesView) => view.changes.map((c) => c.key).sort();
      // Hidden: a reply, a gap, a person and a write-back under a compartment it does not hold.
      const hidden = await conversation(w, WORK);
      await gap(w, hidden.who, WORK);
      ok(
        await w.work.writeBack(wide.token, {
          source: { kind: "message", id: hidden.id as never },
          state: "handled",
          note: "Done.",
          requestId: request(),
        }),
      );
      const again = await changesOf(w, viewer, before.cursor as string);
      expect(again).toEqual({ changes: [], cursor: before.cursor, more: false });
      // It cannot write back on what it cannot see, and is told exactly what an unknown id is told.
      const hiddenCall = await w.work.writeBack(viewer.token, {
        source: { kind: "message", id: hidden.id as never },
        state: "handled",
        requestId: request(),
      });
      const noneCall = await w.work.writeBack(viewer.token, {
        source: { kind: "message", id: `msg_${"7".repeat(26)}` as never },
        state: "handled",
        requestId: request(),
      });
      expect(hiddenCall).toEqual(noneCall);
      expect(hiddenCall).toEqual({ ok: false, code: "not_found" });
      // The wider client's mark under its own clearance does not clear what the viewer sees of its own.
      ok(
        await w.work.writeBack(wide.token, {
          source: { kind: "message", id: owed.id as never },
          state: "handled",
          requestId: request(),
        }),
      );
      const [label] = await w.admin<{ compartments: string[] }>(
        "select compartments from ledger.signal_marks where client_name = 'outside' order by created_at limit 1",
      );
      expect(label?.compartments).toContain("employer:example");
      expect(keys(await changesOf(w, viewer, before.cursor as string))).toEqual([]);
      expect(ok(await w.reader.getSelf(viewer.token)).next?.moves.map((m) => m.source.id)).toContain(owed.id);
    }));

  it("reading in pages loses nothing, with the cursor or without", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      for (let n = 0; n < 3; n += 1) await gap(w, await person(w));
      const seen: string[] = [];
      for (let page = 0; page < 4; page += 1) {
        const view = ok(await w.reader.getChanges(lead.token, { limit: 1 }));
        seen.push(...view.changes.map((c) => c.key));
      }
      expect(new Set(seen).size).toBe(3);
      expect(seen).toHaveLength(3);

      const other = await agent(w, "other");
      const byCursor: string[] = [];
      let cursor: string | undefined;
      let more = true;
      while (more) {
        const view: ChangesView = ok(
          await w.reader.getChanges(other.token, { limit: 1, ...(cursor === undefined ? {} : { since: cursor }) }),
        );
        byCursor.push(...view.changes.map((c) => c.key));
        cursor = view.cursor ?? undefined;
        more = view.more;
      }
      expect([...byCursor].sort()).toEqual([...seen].sort());
    }));

  it("past a block's room everything is served and can clear; what a read cuts it says, and never loses", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      const replies: Awaited<ReturnType<typeof conversation>>[] = [];
      for (let n = 0; n < 13; n += 1) replies.push(await conversation(w, OWN));
      const first = await changesOf(w, lead);
      expect(first.changes.filter((c) => c.change === "signal" && c.kind === "reply_waiting")).toHaveLength(13);
      expect(first.cut).toBeUndefined();
      const gone = first.changes.find((c) => c.change === "signal" && c.source.id === replies[0]?.id);
      await sent(w, OWN, "outbound", at(-1000), replies[0]?.thread);
      await signalsDue(w, lead);
      const cleared = await changesOf(w, lead, first.cursor as string);
      expect(cleared.changes.some((c) => c.change === "cleared" && c.key === gone?.key && c.unsure === undefined)).toBe(
        true,
      );

      // 31 gaps: a read keeps the newest 30 and says so.
      const other = await agent(w, "other");
      for (let n = 0; n < 31; n += 1) await gap(w, await person(w));
      const cut = await changesOf(w, other);
      expect(cut.cut).toBe(true);
      await gap(w, await person(w));
      await signalsDue(w, other);
      const since = Buffer.from(`2000-01-01T00:00:00.000Z\nsig_${"0".repeat(32)}`, "utf8").toString("base64url");
      const replayed = ok(await w.reader.getChanges(other.token, { since, limit: 100 }));
      expect(replayed.changes.filter((c) => c.change === "cleared" && c.unsure === true)).toHaveLength(1);
    }));

  it("a client revoked holds no parked work", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead");
      const spare = await agent(w, "spare");
      const { opportunity } = await assign(w, spare, { about: await person(w) });
      const id = opportunity as OpportunityId;
      ok(await w.work.claimOpportunity(lead.token, { id, requestId: request() }));
      ok(
        await w.work.setIntention(lead.token, {
          opportunity: id,
          dueAt: at(5 * 24 * HOUR).toISOString() as never,
          park: true,
          requestId: request(),
        }),
      );
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        expect(await admin.clients.revokeClient("lead")).toBe(true);
      } finally {
        await admin.close();
      }
      expect((await w.work.claimOpportunity(spare.token, { id, requestId: request() })).ok).toBe(true);
      // Its check-back goes with it, so it can't take the work back from the agent now holding it.
      const [checkBack] = await w.admin<{ event: string }>(
        `select r.event from ledger.intentions i join ledger.record_events r on r.row_kind = 'intention' and r.row_id = i.id
         where i.opportunity_id = $1 order by r.id desc limit 1`,
        [id],
      );
      expect(checkBack?.event).toBe("cancelled");
    }));

  it("a person handled is no signal", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      const other = await agent(w, "other");
      const who = await person(w);
      const inbound = await sent(w, OWN, "inbound", at(-HOUR));
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
         values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '1 hour', $4, '{m-owner}', 'sender')`,
        [interactionId(inbound.evidence, who), inbound.evidence, who, OWN],
      );
      const before = await changesOf(w, other);
      expect(before.changes.some((c) => c.change === "signal" && c.kind === "new_person")).toBe(true);
      ok(
        await w.work.writeBack(lead.token, {
          source: { kind: "entity", id: who as never },
          state: "handled",
          requestId: request(),
        }),
      );
      const after = await changesOf(w, other, before.cursor as string);
      expect(after.changes.some((c) => c.change === "cleared")).toBe(true);
    }));

  it("a removed source takes its write-backs with it", () =>
    inWorld(async (w) => {
      const lead = await agent(w, "lead");
      const owed = await conversation(w, OWN);
      ok(
        await w.work.writeBack(lead.token, {
          source: { kind: "message", id: owed.id as never },
          state: "handled",
          note: "Answered.",
          requestId: request(),
        }),
      );
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("alter table knowledge.messages no force row level security");
        await query("delete from knowledge.messages where id = $1", [owed.id]);
        await query("alter table knowledge.messages force row level security");
      });
      const rows = await w.admin<{ n: number }>(
        "select count(*)::int as n from ledger.signal_marks where ref_id = $1",
        [owed.id],
      );
      expect(rows[0]?.n).toBe(0); // erasure-proves: ledger.signal_marks.ref_id
    }));
});

describe("the headline", { timeout: DB_TEST_TIMEOUT }, () => {
  it("signals raised, picked up and written back, by role, and a handled mark counts as used", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const owed = await conversation(w, OWN);
      await gap(w, await person(w));
      await changesOf(w, lead);
      ok(
        await w.work.writeBack(lead.token, {
          source: { kind: "message", id: owed.id as never },
          state: "needs_owner",
          tried: await triedFor(w, lead),
          requestId: request(),
        }),
      );
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const view = await admin.box.outcomes(7);
        const signals = view.headline.signals;
        expect(signals.raised).toBeGreaterThanOrEqual(1);
        expect(signals.pickedUp).toBeGreaterThanOrEqual(1);
        expect(signals.writtenBack.needsOwner).toBe(1);
        expect(signals.byRole.find((one) => one.role === "chief")).toMatchObject({ writtenBack: 1 });
        expect(view.metrics.map((one) => one.metric)).toEqual(
          expect.arrayContaining(["signals_picked_up", "signals_written_back"]),
        );
      } finally {
        await admin.close();
      }
    }));

  it("a claimed gap its agent reported on is written back, with no write_back call, and one only claimed is not", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const researcher = await agent(w, "researcher", ["research"]);
      const reported = (await gap(w, await person(w))) as OpportunityId;
      const progress = (await gap(w, await person(w))) as OpportunityId;
      const held = (await gap(w, await person(w))) as OpportunityId;
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      const written = (view: Awaited<ReturnType<typeof admin.box.outcomes>>) =>
        view.metrics.find((one) => one.metric === "signals_written_back");
      try {
        for (const id of [reported, progress, held])
          ok(await w.work.claimOpportunity(researcher.token, { id, requestId: request() }));
        const { move } = ok(
          await w.work.planMove(researcher.token, {
            opportunity: reported,
            stage: "investigate",
            requestId: request(),
          }),
        );
        ok(
          await w.work.reportMove(researcher.token, {
            move,
            outcome: "failed",
            report: { reason: "Nothing on the public record names a warm path." },
            requestId: request(),
          }),
        );
        // A move planned and not yet reported says nothing about what happened.
        ok(
          await w.work.planMove(researcher.token, {
            opportunity: progress,
            stage: "investigate",
            requestId: request(),
          }),
        );

        const view = await admin.box.outcomes(7);
        const signals = view.headline.signals;
        expect(signals.pickedUp).toBe(3);
        expect(signals.writtenBack).toEqual({ handled: 0, drafted: 0, needsOwner: 0, reported: 1 });
        expect(signals.byRole.find((one) => one.role === "research")).toMatchObject({ pickedUp: 3, writtenBack: 1 });
        expect(written(view)).toMatchObject({ sample: 3, parts: { reported: 1 } });
        expect(written(view)?.value).toBeCloseTo(1 / 3, 3);

        // A write-back on a task it also reported on is one source, at its latest.
        ok(
          await w.work.writeBack(researcher.token, {
            source: { kind: "opportunity", id: reported },
            state: "needs_owner",
            tried: await triedFor(w, researcher),
            requestId: request(),
          }),
        );
        const again = (await admin.box.outcomes(7)).headline.signals;
        expect(again.writtenBack).toEqual({ handled: 0, drafted: 0, needsOwner: 1, reported: 0 });
      } finally {
        await admin.close();
      }
    }));

  it("a gap task whose source was written back on and whose move was reported counts once", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const researcher = await agent(w, "researcher", ["research"]);
      const task = (await gap(w, await person(w))) as OpportunityId;
      const [row] = await w.admin<{ gap_source: string }>("select gap_source from ledger.opportunities where id = $1", [
        task,
      ]);
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        ok(await w.work.claimOpportunity(researcher.token, { id: task, requestId: request() }));
        const { move } = ok(
          await w.work.planMove(researcher.token, { opportunity: task, stage: "investigate", requestId: request() }),
        );
        ok(
          await w.work.reportMove(researcher.token, {
            move,
            outcome: "failed",
            report: { reason: "Nothing on the public record names a warm path." },
            requestId: request(),
          }),
        );
        // The same task said twice: its source's mark, and the report on its move.
        ok(
          await w.work.writeBack(researcher.token, {
            source: { kind: "message", id: row?.gap_source as never },
            state: "needs_owner",
            tried: await triedFor(w, researcher),
            requestId: request(),
          }),
        );
        const view = await admin.box.outcomes(7);
        const signals = view.headline.signals;
        expect(signals.writtenBack).toEqual({ handled: 0, drafted: 0, needsOwner: 1, reported: 0 });
        expect(signals.byRole.find((one) => one.role === "research")).toMatchObject({ writtenBack: 1 });
        expect(view.metrics.find((one) => one.metric === "signals_written_back")).toMatchObject({
          value: 1,
          sample: 1,
        });
      } finally {
        await admin.close();
      }
    }));

  it("another agent's write-back on a gap task's source leaves the reporting agent's report, and each role's credit, as they are", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const researcher = await agent(w, "researcher", ["research"]);
      const lead = await agent(w, "lead", ["chief"]);
      const task = (await gap(w, await person(w))) as OpportunityId;
      const [row] = await w.admin<{ gap_source: string }>("select gap_source from ledger.opportunities where id = $1", [
        task,
      ]);
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        ok(await w.work.claimOpportunity(researcher.token, { id: task, requestId: request() }));
        const { move } = ok(
          await w.work.planMove(researcher.token, { opportunity: task, stage: "investigate", requestId: request() }),
        );
        ok(
          await w.work.reportMove(researcher.token, {
            move,
            outcome: "failed",
            report: { reason: "Nothing on the public record names a warm path." },
            requestId: request(),
          }),
        );
        // The lead marks the shared source: its own work, not the researcher's.
        ok(
          await w.work.writeBack(lead.token, {
            source: { kind: "message", id: row?.gap_source as never },
            state: "needs_owner",
            tried: await triedFor(w, lead),
            requestId: request(),
          }),
        );
        const signals = (await admin.box.outcomes(7)).headline.signals;
        expect(signals.writtenBack).toEqual({ handled: 0, drafted: 0, needsOwner: 1, reported: 1 });
        expect(signals.byRole.find((one) => one.role === "research")).toMatchObject({ writtenBack: 1 });
        expect(signals.byRole.find((one) => one.role === "chief")).toMatchObject({ writtenBack: 1 });
      } finally {
        await admin.close();
      }
    }));

  it("a claimed gap is picked up with no read of the feed, once when also read, and one code closed is not raised", () =>
    inWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const lead = await agent(w, "lead", ["chief"]);
      const researcher = await agent(w, "researcher", ["research"]);
      // The lead reads the first gap in the feed; the other two are raised after its read.
      const read = await gap(w, await person(w));
      const fed = await changesOf(w, lead);
      expect(fed.changes.map((one) => one.key)).toContain(gapSignalKey(read));
      const claimed = await gap(w, await person(w));
      const closed = await gap(w, await person(w));
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      const picked = (view: Awaited<ReturnType<typeof admin.box.outcomes>>) =>
        view.metrics.find((one) => one.metric === "signals_picked_up");
      try {
        const before = await admin.box.outcomes(7);
        expect(before.headline.signals.codeClosed).toBe(0);
        expect(picked(before)?.parts).toMatchObject({ claimed: 0 });

        // The lead claims the gap it read, the researcher one it never read, and rung 0 closes the third.
        await stored(
          w,
          "ledger.record_events",
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'claimed', now(), $2, '{own}')",
          [read, `client:${lead.id}`],
        );
        await stored(
          w,
          "ledger.record_events",
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'claimed', now(), $2, '{own}')",
          [claimed, `client:${researcher.id}`],
        );
        await stored(
          w,
          "ledger.opportunity_decisions",
          `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason)
           values ($1, now(), 'system:work', '{own}', $2, 'no_go', 'policy', 0, 'owner_declined')`,
          [testId("req"), closed],
        );

        const after = await admin.box.outcomes(7);
        const signals = after.headline.signals;
        expect(signals.codeClosed).toBe(1);
        expect(signals.raised).toBe(before.headline.signals.raised - 1);
        // The gap read and claimed is one signal still; the one only claimed is one more.
        expect(signals.pickedUp).toBe(before.headline.signals.pickedUp + 1);
        expect(picked(after)?.parts).toEqual({ read: picked(before)?.parts?.read, claimed: 2 });
        expect(signals.byRole.find((one) => one.role === "research")).toMatchObject({ pickedUp: 1 });
        expect(signals.byRole.find((one) => one.role === "chief")?.pickedUp).toBe(
          before.headline.signals.byRole.find((one) => one.role === "chief")?.pickedUp,
        );
      } finally {
        await admin.close();
      }
    }));
});
