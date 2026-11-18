import { rm } from "node:fs/promises";
import { REASONER_DEFERRED_CARDS_MAX, REGISTRY } from "@intelligence/personal-ladder";
import type { Dispatch } from "@intelligence/personal-store";
import { type Ref, type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { pi } from "../test-support/run-pi.ts";
import { runTick, type TickCounts } from "./tick.ts";

// Rows a tick reacts to are written in SQL by the shared work fixtures, as pi_admin, pi_owner or
// pi_work; a client's rows through the definer functions under its token.

const TIMEOUT = 240_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const tick = (
  world: WorkWorld,
  now: Date,
  dispatch: Dispatch = world.dispatch(),
): Promise<TickCounts | "already_running"> => runTick({ dispatch, registry: REGISTRY, log: world.log, now: () => now });
const count = async (world: WorkWorld, text: string, values: unknown[] = []): Promise<number> =>
  (await world.admin<{ n: number }>(`select count(*)::int as n from ${text}`, values))[0]?.n ?? 0;
const cardsOf = (world: WorkWorld, target: string): Promise<{ kind: string; state: string; author: string }[]> =>
  world.admin(
    `select c.kind, c.created_by as author,
       (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) as state
     from ledger.cards c where c.target_id = $1 order by c.created_at, c.id`,
    [target],
  );
const silences = async (world: WorkWorld): Promise<string[]> =>
  (await world.admin<{ reason: string }>("select reason from ledger.silences order by id")).map((row) => row.reason);

const sweepDue = (now: Date): number => (now.getUTCHours() >= 11 ? 1 : 0);
// The last JSON line: a refusal with a hint has its fixed hint line after it.
const lastLine = (stderr: string): unknown =>
  JSON.parse(
    stderr
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .at(-1) ?? "{}",
  );

// An agent and a policy intent for a kind, so rung 0 may decide it.
async function policyFor(
  world: WorkWorld,
  kind = "meeting_prep",
  mode: "policy" | "owner" = "policy",
): Promise<{ agent: Awaited<ReturnType<WorkWorld["agent"]>>; intent: string }> {
  const agent = await world.agent();
  return { agent, intent: await world.intent([kind], [agent.id], { mode }) };
}

async function answered(world: WorkWorld, thread = "answered"): Promise<{ sent: string; inbound: string }> {
  const sent = await world.mail({ direction: "outbound", thread });
  const inbound = await world.mail({ direction: "inbound", thread });
  return { sent: sent.id, inbound: inbound.id };
}

// What the owner's no_go on a decision card writes, as the card answer's effect does: the answer on
// the card and the owner's decision on the opportunity.
async function ownerAnswers(world: WorkWorld, opportunity: string, answer: "no_go" | "go", when: Date): Promise<void> {
  const [card] = await world.admin<{ id: string }>(
    "select id from ledger.cards where target_id = $1 order by created_at desc limit 1",
    [opportunity],
  );
  if (card !== undefined) await world.status("card", card.id, "decided", { at: when });
  await world.decision(opportunity, answer, { by: "owner", at: when });
}

describe("pi work tick", () => {
  it(
    "a proposed meeting_prep under a policy intent, with an event the owner accepted as what it is about, is decided go at rung 0",
    () =>
      withWorkWorld(async (world) => {
        const { intent } = await policyFor(world);
        const event = await world.event();
        const { id } = await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        const now = new Date();
        expect(await tick(world, now)).toMatchObject({ decided: 1, cards: 0 });
        expect(await world.latest("opportunity", id)).toBe("go");
        expect(
          await world.admin(
            "select decision, decided_by, rung, intent_id, reason from ledger.opportunity_decisions where opportunity_id = $1",
            [id],
          ),
        ).toEqual([{ decision: "go", decided_by: "policy", rung: 0, intent_id: intent, reason: "intent" }]);
        // With no reasoner, the event's calendar wake is silenced, and so is the sweep's when due.
        expect(world.logged.filter((one) => one.event.event === "work_tick").at(-1)?.event).toEqual({
          event: "work_tick",
          counts: {
            queued: 0,
            silenced: 1 + sweepDue(now),
            decided: 1,
            cards: 0,
            expired: 0,
            vetoed: 0,
            links: 0,
            assessed: 0,
          },
        });
      }),
    TIMEOUT,
  );

  it(
    "the same opportunity under an owner intent raises a card",
    () =>
      withWorkWorld(async (world) => {
        await policyFor(world, "meeting_prep", "owner");
        const event = await world.event();
        const { id } = await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        expect(await tick(world, new Date())).toMatchObject({ decided: 0, cards: 1 });
        expect(await world.latest("opportunity", id)).toBe("proposed");
        expect(await cardsOf(world, id)).toEqual([
          { kind: "opportunity_decision", state: "pending", author: "reasoner" },
        ]);
      }),
    TIMEOUT,
  );

  it(
    "with one policy intent and one owner intent for the kind, it raises a card",
    () =>
      withWorkWorld(async (world) => {
        const { agent } = await policyFor(world);
        await world.intent(["meeting_prep"], [agent.id], { mode: "owner" });
        const event = await world.event();
        const { id } = await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        expect(await tick(world, new Date())).toMatchObject({ decided: 0, cards: 1 });
        expect(await count(world, "ledger.opportunity_decisions")).toBe(0);
        expect((await cardsOf(world, id)).map((one) => one.kind)).toEqual(["opportunity_decision"]);
      }),
    TIMEOUT,
  );

  it(
    "an opportunity is decided go only on a basis the owner backs, by thread, unflagged",
    () =>
      withWorkWorld(async (world) => {
        await policyFor(world);
        await world.agent();
        const outcomeOf = async (refs: Ref[], about?: Ref): Promise<string | null> => {
          const { id } = await world.opportunity({
            about: about ?? ["event", await world.event({ response: null })],
            refs,
          });
          await tick(world, new Date());
          return world.latest("opportunity", id);
        };
        const stranger = (thread: string) => world.mail({ direction: "inbound", thread });
        const owner = (thread: string, bulk = false) => world.mail({ direction: "outbound", thread, bulk });

        const alone = await stranger("t-alone");
        expect(await outcomeOf([["message", alone.id]]), "only an inbound message").toBe("proposed");
        const other = await stranger("t-other");
        const elsewhere = await owner("t-elsewhere");
        expect(
          await outcomeOf([
            ["message", other.id],
            ["message", elsewhere.id],
          ]),
          "beside the owner's message in another thread",
        ).toBe("proposed");
        const replied = await stranger("t-replied");
        const reply = await owner("t-replied");
        expect(
          await outcomeOf([
            ["message", replied.id],
            ["message", reply.id],
          ]),
          "beside the owner's reply in its thread",
        ).toBe("go");
        const automatic = await stranger("t-auto");
        const autoReply = await owner("t-auto", true);
        expect(
          await outcomeOf([
            ["message", automatic.id],
            ["message", autoReply.id],
          ]),
          "beside the owner's automatic reply",
        ).toBe("proposed");
        const hypothesis = await world.hypothesis({ about: ["message", replied.id], refs: [["message", replied.id]] });
        expect(await outcomeOf([["hypothesis", hypothesis.id]]), "a hypothesis alone").toBe("proposed");
        const withheldSent = await owner("t-withheld");
        const withheld = await world.mail({ direction: "inbound", thread: "t-withheld", status: "withheld" });
        expect(
          await outcomeOf([
            ["message", withheldSent.id],
            ["message", withheld.id],
          ]),
          "a withheld message",
        ).toBe("proposed");
        const unscreenedSent = await owner("t-unscreened");
        const unscreened = await world.mail({ direction: "inbound", thread: "t-unscreened", status: "none" });
        expect(
          await outcomeOf([
            ["message", unscreenedSent.id],
            ["message", unscreened.id],
          ]),
          "a message extraction has not screened",
        ).toBe("proposed");
        // Each one that was not decided went to the owner as a card.
        expect(await count(world, "ledger.cards where kind = 'opportunity_decision'")).toBe(6);
      }),
    TIMEOUT,
  );

  it(
    "an opportunity a client proposed raises a card, whatever the intent",
    () =>
      withWorkWorld(async (world) => {
        const { agent } = await policyFor(world);
        const { sent, inbound } = await answered(world);
        const { id } = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
          by: agent,
        });
        expect(await tick(world, new Date())).toMatchObject({ decided: 0, cards: 1 });
        expect(await cardsOf(world, id)).toEqual([
          { kind: "opportunity_decision", state: "pending", author: `client:${agent.id}` },
        ]);
        // The positive control: the run's own proposal of the same basis is decided.
        const ran = await world.opportunity({
          about: ["event", await world.event()],
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
        });
        await tick(world, new Date());
        expect(await world.latest("opportunity", ran.id)).toBe("go");
      }),
    TIMEOUT,
  );

  it(
    "a veto silences a wake, decides no_go with the veto's ruling id, withholds a card, and closes a go opportunity and a handed one it covers",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner();
        await policyFor(world);
        const now = new Date();
        const person = await world.person();
        const named = await world.mail({ person: person.id });
        await world.event({ startsAt: at(now, 2 * HOUR), participant: person.id });
        const proposed = await world.opportunity({ about: ["message", named.id], refs: [["message", named.id]] });
        const going = await world.opportunity({
          about: ["message", named.id],
          refs: [["message", named.id]],
          kind: "investigate",
        });
        await world.decision(going.id, "go", { by: "policy" });
        const handed = await world.opportunity({
          about: ["message", named.id],
          refs: [["message", named.id]],
          kind: "reply",
        });
        await world.status("opportunity", handed.id, "handed_to_owner");
        const question = await world.hypothesis({ refs: [["message", named.id]] });
        const ruling = await world.veto("person", [person.fp]);
        const counts = await tick(world, now);
        // The vetoed event's wake queues nothing; only the sweep's does, when due.
        expect(counts).toMatchObject({ vetoed: 3, cards: 0, queued: sweepDue(now) });
        for (const id of [proposed.id, going.id, handed.id]) {
          expect(await world.latest("opportunity", id)).toBe("no_go");
          expect(
            await world.admin(
              "select decided_by, ruling_id from ledger.opportunity_decisions where opportunity_id = $1 and decision = 'no_go'",
              [id],
            ),
          ).toEqual([{ decided_by: "owner", ruling_id: ruling }]);
        }
        expect(await cardsOf(world, handed.id)).toEqual([]);
        expect(await cardsOf(world, question.id)).toEqual([]);
        expect(await silences(world)).toContain("vetoed");
      }),
    TIMEOUT,
  );

  it(
    "after a run proposed and reminded, the next tick queues no run",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner();
        const now = new Date("2026-10-04T12:00:00.000Z");
        expect(await tick(world, now)).toMatchObject({ queued: 1 });
        // What the run wrote: a proposal and a reminder, as rows of a run.
        const event = await world.event({ startsAt: at(new Date(), 60 * DAY) });
        await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        await world.intention({ kind: "remind", dueAt: at(now, 2 * HOUR) });
        expect(await tick(world, at(now, HOUR))).toMatchObject({ queued: 0 });
        expect(await count(world, "ledger.runs")).toBe(1);
      }),
    TIMEOUT,
  );

  it(
    "with the kill switch on, a tick queues nothing and stops the run in flight",
    () =>
      withWorkWorld(async (world) => {
        const reasoner = await world.reasoner();
        const now = new Date();
        await world.work(
          `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
           values ('run_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'system:work', '{own}', 'daily_sweep', 'sweep:2026-01-01', 'run_outcome', 1, 'personal_run', '1')`,
        );
        await world.status("run", "run_01ARZ3NDEKTSV4RRFFQ69G5FAV", "queued", { by: "system:work" });
        expect(await world.take(reasoner)).toBe("run_01ARZ3NDEKTSV4RRFFQ69G5FAV");
        await world.killSwitch("on");
        const event = await world.event({ startsAt: at(now, HOUR) });
        await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        expect(await tick(world, now)).toEqual({
          queued: 0,
          silenced: 0,
          decided: 0,
          cards: 0,
          expired: 0,
          vetoed: 0,
          links: 0,
          assessed: 0,
        });
        expect(
          await world.admin(
            "select event, code from ledger.record_events where row_kind = 'run' order by id desc limit 1",
          ),
        ).toEqual([{ event: "stopped", code: "kill_switch" }]);
        expect(await count(world, "ledger.runs")).toBe(1);
        expect(await count(world, "ledger.silences")).toBe(0);
        expect(await count(world, "queue.leases")).toBe(0);
      }),
    TIMEOUT,
  );

  it(
    "a spent budget, the reasoner's deferred cards at their threshold and no reasoner are each a silence with their reason",
    () =>
      withWorkWorld(async (world) => {
        const now = new Date("2026-10-04T12:00:00.000Z");
        expect(await tick(world, now)).toMatchObject({ silenced: 1, queued: 0 });
        expect(await silences(world)).toEqual(["no_reasoner"]);
        await world.reasoner();
        const deferred = [];
        for (let n = 0; n < REASONER_DEFERRED_CARDS_MAX; n += 1)
          deferred.push(
            await world.card({
              author: "reasoner",
              state: "deferred",
              kind: "notice",
              expiresAfterDays: null,
            }),
          );
        await tick(world, now);
        expect(await silences(world)).toEqual(["no_reasoner", "owner_backlog"]);
        for (const card of deferred) await world.status("card", card, "decided");
        await world.settings({ max_microusd_per_day: 0 });
        await tick(world, now);
        expect(await silences(world)).toEqual(["no_reasoner", "owner_backlog", "budget"]);
        // Ten more ticks write nothing more, and with the budget back the same key queues its run.
        for (let n = 0; n < 3; n += 1) await tick(world, at(now, n * 60_000));
        expect(await count(world, "ledger.silences")).toBe(3);
        await world.settings({ max_microusd_per_day: 5_000_000 });
        expect(await tick(world, now)).toMatchObject({ queued: 1 });
      }),
    TIMEOUT,
  );

  it(
    "a card nobody answered for 14 days as a pending card expires, and the case raises no card on the next tick; with a new message and 7 days, it raises one again",
    () =>
      withWorkWorld(async (world) => {
        await policyFor(world, "meeting_prep", "owner");
        const event = await world.event({ startsAt: at(new Date(), 90 * DAY) });
        const first = await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        const t0 = new Date();
        expect(await tick(world, t0)).toMatchObject({ cards: 1 });
        expect(await tick(world, at(t0, 15 * DAY))).toMatchObject({ expired: 1 });
        expect(await world.latest("opportunity", first.id)).toBe("expired");
        expect(await count(world, "ledger.opportunity_decisions where decision = 'go'")).toBe(0);
        const again = await world.opportunity({ about: ["event", event], refs: [["event", event]] });
        expect(await tick(world, at(t0, 15 * DAY + HOUR))).toMatchObject({ cards: 0, decided: 1 });
        expect(
          await world.admin("select decision, reason from ledger.opportunity_decisions where opportunity_id = $1", [
            again.id,
          ]),
        ).toEqual([{ decision: "no_go", reason: "expired_no_news" }]);
        const fresh = await world.mail({ direction: "outbound" });
        const news = await world.opportunity({
          about: ["event", event],
          refs: [
            ["event", event],
            ["message", fresh.id],
          ],
        });
        expect(await tick(world, at(t0, 23 * DAY))).toMatchObject({ cards: 1 });
        expect((await cardsOf(world, news.id)).map((one) => one.kind)).toEqual(["opportunity_decision"]);
      }),
    TIMEOUT,
  );

  it(
    "after the owner's no_go the same case is closed no_go with no card; with a new source ref after 7 days it raises a card and is not decided at rung 0",
    () =>
      withWorkWorld(async (world) => {
        await policyFor(world);
        const { sent, inbound } = await answered(world);
        const t0 = new Date();
        // A client's proposal goes to the owner, who says no.
        const agent = await world.agent();
        const first = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
          by: agent,
        });
        expect(await tick(world, t0)).toMatchObject({ cards: 1 });
        await ownerAnswers(world, first.id, "no_go", t0);
        const again = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
          by: agent,
        });
        expect(await tick(world, at(t0, HOUR))).toMatchObject({ cards: 0, decided: 1 });
        expect(
          await world.admin("select decision, reason from ledger.opportunity_decisions where opportunity_id = $1", [
            again.id,
          ]),
        ).toEqual([{ decision: "no_go", reason: "owner_declined" }]);
        const fresh = await world.mail({ direction: "inbound", thread: "answered" });
        const news = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
            ["message", fresh.id],
          ],
          by: agent,
        });
        expect(await tick(world, at(t0, 8 * DAY))).toMatchObject({ cards: 1, decided: 0 });
        expect(await world.latest("opportunity", news.id)).toBe("proposed");
      }),
    TIMEOUT,
  );

  it(
    "an opportunity with a pending card is not decided at rung 0 after its basis gains an owner-backed ref, and no second call row is written while the card waits",
    () =>
      withWorkWorld(async (world) => {
        const { agent } = await policyFor(world, "meeting_prep", "owner");
        const inbound = await world.mail({ direction: "inbound", thread: "late" });
        const { id } = await world.opportunity({ refs: [["message", inbound.id]] });
        const now = new Date();
        expect(await tick(world, now)).toMatchObject({ cards: 1 });
        const sent = await world.mail({ direction: "outbound", thread: "late" });
        await world.owner("select ledger.add_basis('opportunity', $1, '{own}', '{message}', $2, null)", [
          id,
          [sent.id],
        ]);
        await world.admin("update policy.intents set mode = 'policy_decides'");
        await world.intent(["meeting_prep"], [agent.id]);
        for (let n = 1; n <= 3; n += 1) await tick(world, at(now, n * HOUR));
        expect(await world.latest("opportunity", id)).toBe("proposed");
        expect(await count(world, "ledger.opportunity_decisions")).toBe(0);
        expect(await count(world, "ledger.decision_point_calls where subject_id = $1", [id])).toBe(1);
      }),
    TIMEOUT,
  );

  it(
    "two opportunities under an intent with max_open 1 in one tick: one is decided go and the other later",
    () =>
      withWorkWorld(async (world) => {
        const agent = await world.agent();
        await world.intent(["meeting_prep"], [agent.id], { maxOpen: 1 });
        const first = await world.event();
        const second = await world.event();
        const a = await world.opportunity({ about: ["event", first], refs: [["event", first]] });
        const b = await world.opportunity({ about: ["event", second], refs: [["event", second]] });
        expect(await tick(world, new Date())).toMatchObject({ decided: 2 });
        expect([await world.latest("opportunity", a.id), await world.latest("opportunity", b.id)].sort()).toEqual([
          "go",
          "later",
        ]);
      }),
    TIMEOUT,
  );

  it(
    "a follow_up under a policy intent raises a card",
    () =>
      withWorkWorld(async (world) => {
        await policyFor(world, "follow_up");
        const { sent, inbound } = await answered(world);
        const { id } = await world.opportunity({
          kind: "follow_up",
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
        });
        expect(await tick(world, new Date())).toMatchObject({ decided: 0, cards: 1 });
        expect(await world.latest("opportunity", id)).toBe("proposed");
      }),
    TIMEOUT,
  );

  it(
    "an opportunity handed to the owner gets one outcome card, and a second tick raises no second",
    () =>
      withWorkWorld(async (world) => {
        const event = await world.event();
        const { id } = await world.opportunity({ kind: "reply", about: ["event", event], refs: [["event", event]] });
        await world.status("opportunity", id, "handed_to_owner");
        expect(await tick(world, new Date())).toMatchObject({ cards: 1 });
        expect(await tick(world, new Date())).toMatchObject({ cards: 0 });
        expect(await cardsOf(world, id)).toEqual([{ kind: "outcome", state: "pending", author: "reasoner" }]);
      }),
    TIMEOUT,
  );

  it(
    "a report with a summary on a finished opportunity gets one outcome card about the move: the owner's when it is in the week's sample, else settled by code",
    () =>
      withWorkWorld(async (world) => {
        const { agent, intent } = await policyFor(world);
        await world.harness(agent, "meeting_prep", "prepare");
        const { sent, inbound } = await answered(world);
        const { id } = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
        });
        await world.decision(id, "go", { by: "policy", intent });
        const move = await world.claimAndPlan(agent, id, "prepare");
        expect(await world.report(agent, move, "done", "a summary of the prepared meeting")).toBe("done");
        // Either way there is one card, and no second.
        const first = await tick(world, new Date());
        const cards = await cardsOf(world, move);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ kind: "outcome", author: `client:${agent.id}` });
        expect(["pending", "withdrawn"]).toContain(cards[0]?.state);
        expect(first).toMatchObject({ cards: cards[0]?.state === "pending" ? 1 : 0 });
        expect(await tick(world, new Date())).toMatchObject({ cards: 0 });
        expect(await cardsOf(world, move)).toHaveLength(1);
      }),
    TIMEOUT,
  );

  it(
    "three failed runs in a row raise one notice from system:work, a fourth raises none, and after the owner acknowledges it three more raise one",
    () =>
      withWorkWorld(async (world) => {
        let serial = 0;
        const fail = async (): Promise<void> => {
          serial += 1;
          const id = `run_01ARZ3NDEKTSV4RRFFQ69G5F${String(serial).padStart(2, "0")}`;
          await world.work(
            `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
             values ($1, $1, 'system:work', '{own}', 'owner_request', $2, 'run_outcome', 1, 'personal_run', '1')`,
            [id, `owner:${id}`],
          );
          await world.status("run", id, "queued", { by: "system:work" });
          await world.work("select ledger.end_run($1, 'failed', 'model_unavailable')", [id]);
        };
        const notices = () => count(world, "ledger.cards where kind = 'notice' and created_by = 'system:work'");
        for (let n = 0; n < 2; n += 1) await fail();
        await tick(world, new Date());
        expect(await notices()).toBe(0);
        await fail();
        await tick(world, new Date());
        expect(await notices()).toBe(1);
        await fail();
        await tick(world, new Date());
        expect(await notices()).toBe(1);
        const [notice] = await world.admin<{ id: string }>("select id from ledger.cards where kind = 'notice'");
        await world.status("card", notice?.id ?? "", "decided");
        for (let n = 0; n < 3; n += 1) await fail();
        await tick(world, new Date());
        expect(await notices()).toBe(2);
      }),
    TIMEOUT,
  );

  it(
    "pi work tick refuses a key file; with the right URL to a closed port the check passes and the command fails as unavailable",
    async () => {
      const env = {
        PI_DATABASE_URL_WORK: "postgres://pi_work:local-only@127.0.0.1:1/pi_test",
        PI_ERASURE_JOURNAL: "/nonexistent/pi/keys.json.erasures",
      };
      const refused = await pi(["work", "tick"], { ...env, PI_KEY_FILE: "/nonexistent/pi/keys.json" });
      expect(refused.exit).toBe(1);
      expect(lastLine(refused.stderr)).toEqual({ event: "command_failed", code: "wrong_role_url" });
      const control = await pi(["work", "tick"], env);
      expect({ exit: control.exit, stdout: control.stdout }).toEqual({ exit: 1, stdout: "" });
      expect(lastLine(control.stderr)).toEqual({ event: "command_failed", code: "unavailable" });
    },
    TIMEOUT,
  );

  it(
    "a second tick at once exits 0 with already_running",
    () =>
      withWorkWorld(async (world) => {
        const env = { PI_DATABASE_URL_WORK: world.db.urls.work, PI_ERASURE_JOURNAL: world.journal };
        const holder = new pg.Client({ connectionString: world.db.urls.work });
        await holder.connect();
        try {
          await holder.query("select pg_advisory_lock(hashtext('intelligence personal work'))");
          expect(await tick(world, new Date())).toBe("already_running");
          const second = await pi(["work", "tick"], env);
          expect(second).toMatchObject({ exit: 0, stdout: "" });
          expect(lastLine(second.stderr)).toEqual({ event: "already_running" });
        } finally {
          await holder.end();
        }
        // The positive control: with the lock free, the command runs its tick.
        const free = await pi(["work", "tick"], env);
        expect(free.exit).toBe(0);
        expect(lastLine(free.stderr)).toMatchObject({ event: "work_tick" });
      }),
    TIMEOUT,
  );

  it(
    "a tick refuses to start while the erasure journal is ahead, and when the journal file is missing",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner();
        const env = { PI_DATABASE_URL_WORK: world.db.urls.work, PI_ERASURE_JOURNAL: world.journal };
        await world.erasure({ database: false });
        const ahead = await pi(["work", "tick"], env);
        expect(ahead.exit).toBe(1);
        expect(lastLine(ahead.stderr)).toEqual({ event: "command_failed", code: "erasure_replay_needed" });
        await rm(world.journal);
        const missing = await pi(["work", "tick"], env);
        expect(missing.exit).toBe(1);
        expect(lastLine(missing.stderr)).toEqual({ event: "command_failed", code: "journal_refused" });
        expect((await count(world, "ledger.runs")) + (await count(world, "ledger.silences"))).toBe(0);
      }),
    TIMEOUT,
  );

  it(
    "the database's point versions and hashes on call rows are the registry's",
    () =>
      withWorkWorld(async (world) => {
        await world.reasoner();
        const { agent, intent } = await policyFor(world);
        await world.harness(agent, "meeting_prep", "prepare");
        const { sent, inbound } = await answered(world);
        const { id } = await world.opportunity({
          refs: [
            ["message", inbound],
            ["message", sent],
          ],
        });
        await world.opportunity({ about: ["event", await world.event()], refs: [["message", inbound]] });
        await tick(world, new Date("2026-10-04T12:00:00.000Z"));
        expect(await world.latest("opportunity", id)).toBe("go");
        await world.claimAndPlan(agent, id, "prepare");
        void intent;
        const calls = await world.admin<{ point: string; version: number; hash: string }>(
          "select distinct point, version, definition_hash as hash from ledger.decision_point_calls order by point",
        );
        expect(calls.map((one) => one.point)).toEqual(["move_clear", "opportunity_go", "wake_worth_run"]);
        for (const call of calls) {
          const registered = REGISTRY.current(call.point as never);
          expect({ version: call.version, hash: call.hash }).toEqual({
            version: registered.definition.version,
            hash: registered.hash,
          });
        }
      }),
    TIMEOUT,
  );
});

// Every write method of Dispatch: a tick killed after the n-th of them.
const WRITES = new Set([
  "queueRun",
  "recordSilence",
  "decideOpportunity",
  "raiseDecisionCard",
  "closeVetoed",
  "raiseQuestionCard",
  "closeHypothesis",
  "raiseOutcomeCard",
  "raiseReminderCard",
  "raiseFailureNotice",
  "expire",
  "returnToGo",
  "preferClient",
  "cancelIntention",
  "stopRuns",
  "endRun",
  "matchOutcomes",
  "assessOutcomes",
]);
// Each step of a tick catches its own failure and the next step runs, so a throw is not a kill. A
// killed process does nothing more: after write n every call throws.
class Killed extends Error {}
function killedAfter(dispatch: Dispatch, n: number): { dispatch: Dispatch; writes: () => number } {
  let writes = 0;
  const proxy = new Proxy(dispatch, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const call = value as (...given: unknown[]) => unknown;
      if (!WRITES.has(String(property)))
        return (...args: unknown[]) => {
          if (writes >= n) throw new Killed();
          return call.apply(target, args);
        };
      return async (...args: unknown[]) => {
        if (writes >= n) throw new Killed();
        const result = await call.apply(target, args);
        writes += 1;
        if (writes === n) throw new Killed();
        return result;
      };
    },
  });
  return { dispatch: proxy, writes: () => writes };
}

// One world with something for every step of a tick.
async function busyWorld(world: WorkWorld, now: Date): Promise<void> {
  await world.reasoner();
  const { agent } = await policyFor(world);
  await world.intent(["reply"], [agent.id], { mode: "owner" });
  const person = await world.person();
  const named = await world.mail({ person: person.id });
  await world.opportunity({ about: ["message", named.id], refs: [["message", named.id]] });
  await world.veto("person", [person.fp]);
  const event = await world.event({ startsAt: at(now, 2 * HOUR) });
  await world.opportunity({ about: ["event", event], refs: [["event", event]] });
  const { sent, inbound } = await answered(world);
  await world.opportunity({
    kind: "reply",
    refs: [
      ["message", inbound],
      ["message", sent],
    ],
  });
  const handed = await world.opportunity({ kind: "follow_up", refs: [["message", sent]] });
  await world.status("opportunity", handed.id, "handed_to_owner");
  await world.intention({ kind: "remind", dueAt: at(now, -HOUR) });
  await world.hypothesis({ refs: [["message", inbound]] });
}

// What a tick left: the rows of each ledger table, and their states and kinds.
async function leftBy(world: WorkWorld): Promise<Record<string, unknown>> {
  const tables = [
    "ledger.runs",
    "ledger.silences",
    "ledger.cards",
    "ledger.opportunity_decisions",
    "ledger.decision_point_calls",
    "ledger.record_events",
    "ledger.basis",
    "queue.leases",
    "ledger.move_result_links",
    "ledger.outcome_assessments",
  ];
  const left: Record<string, unknown> = {};
  for (const table of tables) left[table] = await count(world, table);
  left.events = (
    await world.admin<{ line: string }>(
      "select row_kind || ' ' || event || ' ' || coalesce(code, '') as line from ledger.record_events order by 1",
    )
  ).map((row) => row.line);
  left.decisions = (
    await world.admin<{ line: string }>(
      "select decision || ' ' || decided_by || ' ' || coalesce(reason, '') as line from ledger.opportunity_decisions order by 1",
    )
  ).map((row) => row.line);
  left.cards = (
    await world.admin<{ line: string }>("select kind || ' ' || created_by as line from ledger.cards order by 1")
  ).map((row) => row.line);
  left.calls = (
    await world.admin<{ line: string }>(
      "select point || ' ' || coalesce(output, '-') || ' ' || subject_kind as line from ledger.decision_point_calls order by 1",
    )
  ).map((row) => row.line);
  return left;
}

describe("a killed tick", () => {
  it(
    "a tick killed after any write and run again leaves the same rows as one uninterrupted tick",
    async () => {
      const now = new Date("2026-10-04T12:00:00.000Z");
      let expected: Record<string, unknown> = {};
      let total = 0;
      await withWorkWorld(async (world) => {
        await busyWorld(world, now);
        const counted = killedAfter(world.dispatch(), Number.POSITIVE_INFINITY);
        // The uninterrupted tick fails no step, so its rows are a whole tick's.
        expect(await tick(world, now, counted.dispatch)).not.toHaveProperty("failed");
        total = counted.writes();
        expected = await leftBy(world);
      });
      expect(total).toBeGreaterThanOrEqual(6);
      for (let n = 1; n <= total; n += 1) {
        await withWorkWorld(async (world) => {
          await busyWorld(world, now);
          // The killed tick ends, by a rejection or with its later steps counted failed.
          const killed = await tick(world, now, killedAfter(world.dispatch(), n).dispatch).catch((error: unknown) => {
            if (error instanceof Killed) return "killed";
            throw error;
          });
          expect(
            killed === "killed" || (typeof killed === "object" && (killed.failed ?? 0) > 0),
            `killed after write ${n}`,
          ).toBe(true);
          await tick(world, now);
          expect(await leftBy(world), `killed after write ${n}`).toEqual(expected);
        });
      }
    },
    TIMEOUT * 4,
  );
});
