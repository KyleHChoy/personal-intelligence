import {
  type CardId,
  DECISION_POINT_PINS,
  type DecisionPointCall,
  type OpportunityId,
  type RunId,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, readAs } from "../test-support/connections.ts";
import { asSuperuser } from "../test-support/sender-fixtures.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-fixtures.ts";
import type { WakeCandidate } from "./dispatch-wakes.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const call = (point: "wake_worth_run" | "opportunity_go", output: string | null): DecisionPointCall => ({
  point,
  version: 1,
  definitionHash: DECISION_POINT_PINS[`${point}@1`] ?? "",
  rung: output === null ? 4 : 0,
  inputHash: sha256Hex(`${point}:${output ?? "escalated"}`),
  output,
  effect:
    output === null
      ? null
      : (({ run: "start_run", skip: "record_silence", go: "go_internal", no_go: "decline", later: "defer" } as const)[
          output as "run"
        ] ?? null),
  effectClass:
    output === null
      ? null
      : output === "skip" || output === "no_go" || output === "later"
        ? "narrow"
        : "internal_reversible",
  escalated: output === null,
});
const RUN = call("wake_worth_run", "run");
const SKIP = call("wake_worth_run", "skip");
const GO = call("opportunity_go", "go");
const ESCALATED = call("opportunity_go", null);

const sweep = (day: string): WakeCandidate => ({
  source: "daily_sweep",
  wakeKey: `sweep:${day}`,
  anchors: [],
  compartments: ["own"],
  vetoed: false,
});
const goalWake = (goal: string, ruling: string): WakeCandidate => ({
  source: "goal_changed",
  wakeKey: `goal:${ruling}`,
  anchors: [{ kind: "goal", id: goal } as never],
  compartments: ["own"],
  vetoed: false,
});

const count = async (world: WorkWorld, text: string, values: unknown[] = []): Promise<number> =>
  one(await world.admin<{ n: number }>(`select count(*)::int as n from ${text}`, values)).n;
const eventsOf = async (world: WorkWorld, rowKind: string, id: string): Promise<string[]> =>
  (
    await world.admin<{ event: string }>(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
      [rowKind, id],
    )
  ).map((row) => row.event);

// A trusted basis: the owner's sent message and an inbound one in its thread.
async function trusted(world: WorkWorld): Promise<[string, string][]> {
  const sent = await world.mail({ direction: "outbound", thread: "answered" });
  const inbound = await world.mail({ direction: "inbound", thread: "answered" });
  return [
    ["message", sent.id],
    ["message", inbound.id],
  ];
}

// One connection that holds the row locks of `ids` until it is released, as a transaction in
// flight would.
async function holding(url: string, ids: string[]): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("begin");
  await client.query("select ledger.lock_rows($1)", [ids]);
  return async () => {
    await client.query("commit");
    await client.end();
  };
}
const outcome = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A queued run taken by the reasoner, as ledger.next_run takes one.
async function running(world: WorkWorld, wakeKey: string): Promise<RunId> {
  const reasoner = await world.reasoner(["own"]);
  const dispatch = world.dispatch();
  const run = await dispatch.queueRun(
    { source: "daily_sweep", wakeKey, anchors: [], compartments: ["own"], vetoed: false },
    RUN,
    new Date(),
  );
  if (run === null) throw new Error("no run queued");
  const [taken] = await readAs(world.db, reasoner.token, (query) =>
    query<{ run_id: string }>("select run_id from ledger.next_run($1, $2)", [testId("req"), reasoner.session]),
  );
  expect(taken?.run_id).toBe(run);
  return run;
}

describe("the dispatcher's writes", () => {
  it(
    "a wake key queues one run, however many ticks see it",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const first = await dispatch.queueRun(sweep("2026-10-04"), RUN, now);
        expect(first).toMatch(/^run_/);
        for (let tick = 0; tick < 3; tick += 1)
          expect(await dispatch.queueRun(sweep("2026-10-04"), RUN, now)).toBeNull();
        expect(await count(world, "ledger.runs")).toBe(1);
        expect(await count(world, "ledger.decision_point_calls where subject_kind = 'run'")).toBe(1);
        expect(await eventsOf(world, "run", first ?? "")).toEqual(["queued"]);
      }),
    TIMEOUT,
  );

  it(
    "a wake silenced for budget writes one silence over ten ticks, and queues a run on the next day's first tick",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const { goal, ruling } = await world.goal();
        const wake = goalWake(goal, ruling);
        const today = new Date("2026-10-04T12:00:00.000Z");
        let written = 0;
        for (let tick = 0; tick < 10; tick += 1)
          if (await dispatch.recordSilence(wake, "budget", SKIP, at(today, tick * 60_000))) written += 1;
        expect(written).toBe(1);
        expect(await count(world, "ledger.silences")).toBe(1);
        expect(await count(world, "ledger.decision_point_calls where subject_kind = 'silence'")).toBe(1);
        const run = await dispatch.queueRun(wake, RUN, at(today, DAY));
        expect(run).toMatch(/^run_/);
        expect(
          one(
            await world.admin<{ kind: string; id: string }>(
              "select ref_kind as kind, ref_id as id from ledger.basis where row_kind = 'run' and row_id = $1",
              [run],
            ),
          ),
        ).toEqual({ kind: "goal", id: goal });
      }),
    TIMEOUT,
  );

  it(
    "a vetoed silence uses the key up",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner(["own"]);
        const dispatch = world.dispatch();
        const vetoed = await world.goal();
        const passing = await world.goal();
        const now = new Date();
        await dispatch.recordSilence(goalWake(vetoed.goal, vetoed.ruling), "vetoed", SKIP, now);
        await dispatch.recordSilence(goalWake(passing.goal, passing.ruling), "budget", SKIP, now);
        const keys = (await dispatch.wakeCandidates(now))
          .filter((one) => one.source === "goal_changed")
          .map((one) => one.wakeKey);
        expect(keys).toEqual([`goal:${passing.ruling}`]);
      }),
    TIMEOUT,
  );

  it(
    "a decision written twice is one row",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const intent = await world.intent(["meeting_prep"], []);
        const { id } = await world.opportunity({ refs: await trusted(world) });
        const now = new Date();
        expect(
          await dispatch.decideOpportunity(
            id as OpportunityId,
            GO,
            { output: "go", reason: "intent", intent: intent as never },
            now,
          ),
        ).toBe(true);
        expect(
          await dispatch.decideOpportunity(
            id as OpportunityId,
            GO,
            { output: "go", reason: "intent", intent: intent as never },
            now,
          ),
        ).toBe(false);
        expect(await count(world, "ledger.opportunity_decisions where opportunity_id = $1", [id])).toBe(1);
        expect(await count(world, "ledger.decision_point_calls where subject_id = $1", [id])).toBe(1);
        expect(await eventsOf(world, "opportunity", id)).toEqual(["proposed", "go"]);
      }),
    TIMEOUT,
  );

  it(
    "an expired card closes its opportunity as expired, writes no go, and admits its author's oldest deferred card",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const { id, caseId } = await world.opportunity({ refs: await trusted(world) });
        const card = await world.card({
          target: ["opportunity", id],
          caseKey: caseId,
          state: "pending",
          at: at(now, -15 * DAY),
        });
        const deferred = await world.card({
          author: "reasoner",
          state: "deferred",
          kind: "notice",
          expiresAfterDays: null,
        });
        // The positive control: a day before its 14 days are up, nothing is expired.
        expect((await dispatch.expired(at(now, -2 * DAY))).filter((one) => one.kind === "card")).toEqual([]);
        const items = (await dispatch.expired(now)).filter((one) => one.kind === "card");
        expect(items).toEqual([{ kind: "card", card }]);
        expect(await dispatch.expire({ kind: "card", card: card as CardId }, now)).toBe(true);
        expect(await dispatch.expire({ kind: "card", card: card as CardId }, now)).toBe(false);
        expect(await world.latest("card", card)).toBe("expired");
        expect(await eventsOf(world, "opportunity", id)).toEqual(["proposed", "expired"]);
        expect(await count(world, "ledger.opportunity_decisions")).toBe(0);
        expect(await world.latest("card", deferred)).toBe("pending");
      }),
    TIMEOUT,
  );

  it(
    "a decision, its call and its card carry the opportunity's label, and a sweep's run carries own",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const label = ["employer:example", "own"];
        const sent = await world.mail({ direction: "outbound", thread: "both", compartments: label });
        const decided = await world.opportunity({
          about: ["event", await world.event({ compartments: label })],
          refs: [["message", sent.id]],
          compartments: label,
        });
        const carded = await world.opportunity({
          about: ["event", await world.event({ compartments: label })],
          refs: [["message", sent.id]],
          compartments: label,
        });
        expect(
          await dispatch.decideOpportunity(
            decided.id as OpportunityId,
            GO,
            { output: "no_go", reason: "owner_declined", intent: null },
            now,
          ),
        ).toBe(true);
        const card = await dispatch.raiseDecisionCard(carded.id as OpportunityId, ESCALATED, now);
        expect(card).toMatch(/^crd_/);
        expect(
          one(
            await world.admin<{ compartments: string[] }>(
              "select compartments from ledger.opportunity_decisions where opportunity_id = $1",
              [decided.id],
            ),
          ).compartments,
        ).toEqual(label);
        const calls = await world.admin<{ compartments: string[]; card: string | null }>(
          "select compartments, card_id as card from ledger.decision_point_calls order by created_at, id",
        );
        expect(calls).toEqual([
          { compartments: label, card: null },
          { compartments: label, card },
        ]);
        expect(
          one(
            await world.admin<{ compartments: string[]; author: string; case_key: string }>(
              "select compartments, created_by as author, case_key from ledger.cards where id = $1",
              [card],
            ),
          ),
        ).toEqual({
          compartments: label,
          author: "reasoner",
          case_key: carded.caseId,
        });
        const run = await dispatch.queueRun(sweep("2026-10-04"), RUN, now);
        expect(
          one(
            await world.admin<{ compartments: string[] }>("select compartments from ledger.runs where id = $1", [run]),
          ).compartments,
        ).toEqual(["own"]);
      }),
    TIMEOUT,
  );

  it(
    "a card raised for a vetoed subject is not raised",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const person = await world.person();
        const named = await world.mail({ person: person.id });
        const plain = await world.mail();
        const vetoed = await world.opportunity({ refs: [["message", named.id]] });
        const free = await world.opportunity({ refs: [["message", plain.id]] });
        await world.veto("person", [person.fp]);
        expect(await dispatch.raiseDecisionCard(vetoed.id as OpportunityId, ESCALATED, now)).toBeNull();
        expect(await dispatch.raiseDecisionCard(free.id as OpportunityId, ESCALATED, now)).toMatch(/^crd_/);
        expect(await count(world, "ledger.cards")).toBe(1);
      }),
    TIMEOUT,
  );

  it(
    "closeVetoed leaves the opportunity no_go, unleased, with no pending card and no live intention, a handed one included",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const agent = await world.agent();
        const person = await world.person();
        const named = await world.mail({ person: person.id });
        const { id } = await world.opportunity({ refs: [["message", named.id]] });
        await world.status("opportunity", id, "handed_to_owner");
        const card = await world.card({
          kind: "outcome",
          target: ["opportunity", id],
          caseKey: `outcome:${id}`,
          author: "reasoner",
        });
        await world.work(
          "insert into queue.leases (resource_kind, resource_id, holder, lease_until, first_taken_at) values ('opportunity', $1, $2, now() + interval '1 hour', now())",
          [id, agent.id],
        );
        const intention = await world.intention({
          kind: "check_back",
          opportunity: id,
          client: agent,
          dueAt: at(now, DAY),
        });
        const ruling = await world.veto("person", [person.fp]);
        const [vetoed] = await dispatch.vetoedOpen();
        expect(vetoed).toEqual({ id, ruling });
        expect(await dispatch.closeVetoed(id as OpportunityId, ruling as never, now)).toBe(true);
        expect(await dispatch.closeVetoed(id as OpportunityId, ruling as never, now)).toBe(false);
        expect(await world.latest("opportunity", id)).toBe("no_go");
        expect(
          one(
            await world.admin(
              "select decision, decided_by, ruling_id, rung from ledger.opportunity_decisions where opportunity_id = $1",
              [id],
            ),
          ),
        ).toEqual({ decision: "no_go", decided_by: "owner", ruling_id: ruling, rung: 4 });
        expect(await count(world, "queue.leases")).toBe(0);
        expect(await world.latest("card", card)).toBe("withdrawn");
        expect(await world.latest("intention", intention)).toBe("cancelled");
        expect(await dispatch.vetoedOpen()).toEqual([]);
      }),
    TIMEOUT,
  );

  it(
    "a due check-back returns a claimed opportunity to go and prefers its client for 24 hours",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const agent = await world.agent();
        const { id } = await world.opportunity({ refs: await trusted(world) });
        await world.status("opportunity", id, "go");
        await world.status("opportunity", id, "claimed");
        await world.work(
          "insert into queue.leases (resource_kind, resource_id, holder, lease_until, first_taken_at) values ('opportunity', $1, $2, now() + interval '1 hour', now())",
          [id, agent.id],
        );
        const intention = await world.intention({
          kind: "check_back",
          opportunity: id,
          client: agent,
          dueAt: at(now, -HOUR),
        });
        const [due] = await dispatch.dueIntentions(now);
        expect(due).toEqual({
          id: intention,
          kind: "check_back",
          opportunity: id,
          client: agent.id,
          opportunityStatus: "claimed",
          holder: agent.id,
        });
        expect(
          await dispatch.returnToGo(id as OpportunityId, now, {
            client: agent.id as never,
            intention: intention as never,
          }),
        ).toBe(true);
        expect(await world.latest("opportunity", id)).toBe("go");
        expect(await world.latest("intention", intention)).toBe("fired");
        const lease = one(
          await world.admin<{ holder: string; lease_until: Date; preferred_until: Date }>(
            "select holder, lease_until, preferred_until from queue.leases where resource_id = $1",
            [id],
          ),
        );
        expect(lease.holder).toBe(agent.id);
        expect(lease.lease_until.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(lease.preferred_until.getTime()).toBe(now.getTime() + DAY);
        expect(await dispatch.dueIntentions(now)).toEqual([]);
      }),
    TIMEOUT,
  );

  it(
    "a due check-back on an opportunity a veto closed the day before changes nothing and is cancelled",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const agent = await world.agent();
        const { id } = await world.opportunity({ refs: await trusted(world) });
        await world.status("opportunity", id, "claimed");
        const intention = await world.intention({
          kind: "check_back",
          opportunity: id,
          client: agent,
          dueAt: at(now, -HOUR),
        });
        await world.decision(id, "no_go", { by: "owner", at: at(now, -DAY) });
        expect(
          await dispatch.returnToGo(id as OpportunityId, now, {
            client: agent.id as never,
            intention: intention as never,
          }),
        ).toBe(false);
        expect(
          await dispatch.preferClient(
            id as OpportunityId,
            { client: agent.id as never, intention: intention as never },
            now,
          ),
        ).toBe(false);
        expect(await dispatch.cancelIntention(intention as never, now)).toBe(true);
        expect(await world.latest("opportunity", id)).toBe("no_go");
        expect(await world.latest("intention", intention)).toBe("cancelled");
        expect(await count(world, "queue.leases")).toBe(0);
      }),
    TIMEOUT,
  );

  it(
    "an opportunity handed 14 days ago is expired",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const handed = await world.opportunity({ about: ["event", await world.event()], refs: await trusted(world) });
        await world.status("opportunity", handed.id, "handed_to_owner", { at: at(now, -15 * DAY) });
        const card = await world.card({
          kind: "outcome",
          target: ["opportunity", handed.id],
          caseKey: `outcome:${handed.id}`,
        });
        const recent = await world.opportunity({ about: ["event", await world.event()], refs: await trusted(world) });
        await world.status("opportunity", recent.id, "handed_to_owner", { at: at(now, -13 * DAY) });
        expect((await dispatch.expired(now)).filter((one) => one.kind === "opportunity")).toEqual([
          { kind: "opportunity", opportunity: handed.id },
        ]);
        expect(await dispatch.expire({ kind: "opportunity", opportunity: handed.id as OpportunityId }, now)).toBe(true);
        expect(await world.latest("opportunity", handed.id)).toBe("expired");
        expect(await world.latest("opportunity", recent.id)).toBe("handed_to_owner");
        // Its waiting outcome card goes with it.
        expect(await world.latest("card", card)).toBe("withdrawn");
      }),
    TIMEOUT,
  );

  it(
    "stopRuns ends every queued and running run and drops their leases",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const taken = await running(world, "sweep:2026-10-03");
        const queued = await dispatch.queueRun(sweep("2026-10-04"), RUN, new Date());
        expect(await count(world, "queue.leases where resource_kind = 'run'")).toBe(1);
        expect(await dispatch.stopRuns()).toBe(2);
        for (const run of [taken, queued ?? ""]) {
          expect(
            one(
              await world.admin(
                "select event, code from ledger.record_events where row_kind = 'run' and row_id = $1 order by id desc limit 1",
                [run],
              ),
            ),
          ).toEqual({ event: "stopped", code: "kill_switch" });
        }
        expect(await count(world, "queue.leases")).toBe(0);
        expect(await dispatch.stopRuns()).toBe(0);
      }),
    TIMEOUT,
  );

  it(
    "a run whose erasure mark moved is ended stopped with the code erasure",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const run = await running(world, "sweep:2026-10-04");
        const now = new Date();
        expect((await dispatch.expired(now)).filter((one) => one.kind === "run_erasure")).toEqual([]);
        await world.erasure();
        expect((await dispatch.expired(now)).filter((one) => one.kind === "run_erasure")).toEqual([
          { kind: "run_erasure", run },
        ]);
        expect(await dispatch.expire({ kind: "run_erasure", run }, now)).toBe(true);
        expect(
          one(
            await world.admin(
              "select event, code from ledger.record_events where row_kind = 'run' and row_id = $1 order by id desc limit 1",
              [run],
            ),
          ),
        ).toEqual({ event: "stopped", code: "erasure" });
        expect(await count(world, "queue.leases")).toBe(0);
      }),
    TIMEOUT,
  );

  it(
    "a card for a run's row has the author reasoner, and the eleventh is pending too",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        const refs = await trusted(world);
        const states: string[] = [];
        for (let n = 0; n < 11; n += 1) {
          const { id } = await world.opportunity({ about: ["event", await world.event()], refs });
          const card = await dispatch.raiseDecisionCard(id as OpportunityId, ESCALATED, now);
          states.push((await world.latest("card", card ?? "")) ?? "none");
        }
        expect(states).toEqual(Array.from({ length: 11 }, () => "pending"));
        expect(await count(world, "ledger.cards where created_by = 'reasoner'")).toBe(11);
        // A client's row's card is the client's.
        const agent = await world.agent();
        const { id } = await world.opportunity({ about: ["event", await world.event()], refs, by: agent });
        const card = await dispatch.raiseDecisionCard(id as OpportunityId, ESCALATED, now);
        expect(
          one(
            await world.admin<{ author: string }>("select created_by as author from ledger.cards where id = $1", [
              card,
            ]),
          ).author,
        ).toBe(`client:${agent.id}`);
        expect(await world.latest("card", card ?? "")).toBe("pending");
      }),
    TIMEOUT,
  );

  it(
    "an expiry and a decide of one card at once leave one outcome",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const now = new Date();
        // Pending for two of its three days by the admin's clock, past them by the tick's.
        const card = await world.card({
          kind: "notice",
          author: "system:work",
          expiresAfterDays: 3,
          at: at(now, -2 * DAY),
        });
        const admin = createAdmin({ url: world.db.urls.admin, keys: world.db.keys, log: world.log, now: () => now });
        try {
          const release = await holding(world.db.urls.work, [card]);
          const expiry = outcome(dispatch.expire({ kind: "card", card: card as CardId }, at(now, 2 * DAY)));
          const decision = outcome(
            admin.cards.decide({ cards: [card as CardId], answer: "acknowledge", requestId: testId("req") }),
          );
          await pause(300);
          await release();
          const [expired, decided] = await Promise.all([expiry, decision]);
          const events = await eventsOf(world, "card", card);
          expect(events[0]).toBe("pending");
          expect(events.slice(1).length).toBe(1);
          expect(["expired", "decided"]).toContain(events[1]);
          expect(expired.ok && expired.value === true).toBe(events[1] === "expired");
          expect(decided.ok).toBe(events[1] === "decided");
        } finally {
          await admin.close();
        }
      }),
    TIMEOUT,
  );

  it(
    "returnToGo and a report_move at once leave the opportunity done, or go with the report refused, never done and then go",
    () =>
      withWorkWorld(async (world) => {
        const dispatch = world.dispatch();
        const agent = await world.agent();
        const intent = await world.intent(["meeting_prep"], [agent.id]);
        await world.harness(agent, "meeting_prep", "prepare");
        const { id } = await world.opportunity({ refs: await trusted(world) });
        await world.decision(id, "go", { by: "policy", intent });
        const as = <Row>(text: string, values: unknown[]) =>
          readAs(world.db, agent.token, (query) => query<Row>(text, values));
        const [claimed] = await as<{ until: Date | null }>("select ledger.claim($1, $2, $3, $4) as until", [
          id,
          testId("asg"),
          testId("req"),
          agent.session,
        ]);
        expect(claimed?.until).not.toBeNull();
        const move = testId("mov");
        const [planned] = await as<{ move: string | null }>(
          "select ledger.plan_move($1, $2, 'prepare', $3, $4, 1, $5) as move",
          [move, id, testId("req"), agent.session, DECISION_POINT_PINS["move_clear@1"]],
        );
        expect(planned?.move).toBe(move);
        // The lease lapses: the tick may hand the opportunity back.
        await world.work("update queue.leases set lease_until = now() - interval '1 minute' where resource_id = $1", [
          id,
        ]);
        const release = await holding(world.db.urls.work, [id]);
        const back = outcome(dispatch.returnToGo(id as OpportunityId, new Date()));
        const report = outcome(
          as<{ status: string | null }>("select ledger.report_move($1, 'done', $2, $3, null, '{}', '{}') as status", [
            move,
            testId("req"),
            agent.session,
          ]),
        );
        await pause(300);
        await release();
        const [returned, reported] = await Promise.all([back, report]);
        const events = await eventsOf(world, "opportunity", id);
        const last = events.at(-1);
        expect(["done", "go"]).toContain(last);
        if (last === "done") expect(returned).toEqual({ ok: true, value: false });
        else expect(reported.ok && reported.value[0]?.status).toBeNull();
        // Never done and then go.
        const done = events.indexOf("done");
        expect(done === -1 || !events.slice(done).includes("go")).toBe(true);
      }),
    TIMEOUT,
  );

  // The day the owner sets their zone, the sweep's key moves from UTC's day to theirs; a sweep queued
  // under the old key keeps a second one away for 12 hours.
  it("no second daily sweep within twelve hours of the last, though setting the zone moved the day's key", () =>
    withWorkWorld(async (world) => {
      await world.reasoner(["own"]);
      await world.admin("update policy.work_settings set sweep_hour_utc = 0");
      const now = new Date();
      const dispatch = world.dispatch();
      const sweeps = async () => (await dispatch.wakeCandidates(now)).filter((one) => one.source === "daily_sweep");
      const [utc] = await sweeps();
      if (utc === undefined) throw new Error("no sweep");
      expect(await dispatch.queueRun(utc, RUN, now)).not.toBeNull();
      // A zone whose day is not UTC's now: twelve hours behind before noon, fourteen ahead after.
      const zone = now.getUTCHours() < 12 ? "Etc/GMT+12" : "Etc/GMT-14";
      await world.admin("update policy.owner_settings set time_zone = $1", [zone]);
      expect(await sweeps()).toEqual([]);
      // The control: once the last sweep is twelve hours old, the owner's day's sweep is due.
      // As the tables' owner, under a policy of the test's own: no runtime role rewrites a run's time.
      await asSuperuser(
        world.db,
        "ledger.runs",
        "update ledger.runs set created_at = created_at - interval '12 hours 1 minute' where wake_source = 'daily_sweep'",
      );
      const due = (await sweeps()).map((one) => one.wakeKey);
      expect(due).toHaveLength(1);
      expect(due[0]).not.toBe(utc.wakeKey);
    }));
});
