import { ContextPack } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { triedFor } from "../test-support/paid-questions.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import {
  age,
  claim,
  type Dispatch,
  dispatching,
  expiryTick,
  held,
  later,
  ownerUpdate,
  task,
  workAgent,
} from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createWriter } from "../write/writer.ts";

// Work that lasts days, at the store on a real database: a lease renewed with no limit and kept for
// its holder's 24 hours when it lapses (A1, A2), progress reports and where they are served (A3,
// A4), check-backs with a note, from a recent holder, and the 14 days counted from the latest park
// or progress (A5), a hand-off of any work, and to the owner (A6), the handoffs of held work in the
// pack and the two record kinds (A7), and invariant 6 for each new read. Time is moved two ways: a
// lease row is aged in place as pi_work, for what the database functions read with their own clock,
// and the dispatcher is handed a later `now`. Synthetic rows only. Every refusal has its control in
// the same test.

const OWN = ["own"];
const NAMES = ["scout", "other", "third"];
const AGENTS = NAMES.map((name) => `agent:${name}`);
const WORLD = ["own", ...AGENTS];
const TOOLS = [
  ...AGENT_WORK_TOOLS,
  "propose_task",
  "hand_off",
  "record",
  "read_record",
  "find_records",
  "build_context_pack",
  "get_self",
  // A search and a read, which a hand-off to the owner pays with.
  "find_messages",
  "read_message",
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const progress = (w: WorkWorld, client: WorkClient, move: string, next = "read the second filing") =>
  w.work.reportMove(client.token, {
    move: move as never,
    outcome: "progress",
    report: { done: ["read the first filing"], next },
    requestId: request(),
  });

// An agent cleared for `own` and every agent compartment, as the default clearances give them, so
// each sees the others' tasks and records; with its agent source account.
const agent = (w: WorkWorld, name: string, compartments = [...OWN, ...AGENTS]): Promise<WorkClient> =>
  workAgent(w, name, compartments, { tools: TOOLS, account: true });
// The tick's third step for one piece of work at a time: its lapsed lease, its unreported moves, its
// expiry and its lapsed hold, each written.
const tick = (dispatch: Dispatch, id: string, moves: string[], now: Date): Promise<string[]> =>
  expiryTick(dispatch, id, now, { moves });

const moveEvents = (w: WorkWorld, move: string) =>
  w.admin<{ event: string; code: string | null }>(
    "select event, code from ledger.record_events where row_kind = 'move' and row_id = $1 order by id",
    [move],
  );
const lastEvent = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ event: string; by: string; code: string | null }>(
      "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id desc limit 1",
      [id],
    )
  )[0];
const leaseOf = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ holder: string; live: boolean; preferred: boolean }>(
      "select holder, lease_until >= now() as live, preferred_until is not null as preferred from queue.leases where resource_kind = 'opportunity' and resource_id = $1",
      [id],
    )
  )[0];
const pack = async (w: WorkWorld, client: WorkClient) =>
  ContextPack.parse(ok(await w.reader.buildContextPack(client.token, { purpose: "agent_bootstrap" })));
// A record, taken in by the writer as a sync does: work rests only on a record that was.
async function record(
  w: WorkWorld,
  client: WorkClient,
  kind: "handoff" | "lesson" | "capability",
  body: string,
): Promise<string> {
  const id = ok(await w.reader.record(client.token, { kind, body, requestId: request() })).recordId;
  const writer = createWriter({ url: w.db.urls.writer, keys: w.db.keys, log: w.log });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  return id;
}

describe("work that lasts days", { timeout: DB_TEST_TIMEOUT }, () => {
  it("A1: a holder renews with no limit from its first claim", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const { id } = await held(w, scout);
      // Three days after it was first taken, with five minutes left: a claim extends it 30 minutes.
      await queryAs(
        w.db.urls.work,
        "update queue.leases set first_taken_at = now() - interval '3 days', lease_until = now() + interval '5 minutes' where resource_id = $1",
        [id],
      );
      const renewed = ok(await claim(w, scout, id));
      expect(new Date(renewed.leaseUntil).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      expect(await leaseOf(w, id)).toMatchObject({ holder: scout.id, live: true });
    }, WORLD));

  it("A1, A2: a held task survives three days with a heartbeat every six hours, its move never abandoned, and its lapsed holder reclaims ahead of another agent", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id, move } = await held(w, scout);
      expect(ok(await progress(w, scout, move))).toEqual({ move, opportunity: "claimed" });
      await dispatching(w, async (dispatch) => {
        for (let beat = 0; beat < 12; beat += 1) {
          // Six hours pass: the 30-minute lease ran out long ago.
          await age(w, id, 6);
          // Before the tick sees it, it is already the holder's alone.
          if (beat === 0)
            expect(await claim(w, other, id)).toEqual({ ok: false, code: "not_found", refusal: "work_held" });
          expect(await tick(dispatch, id, [move], new Date())).toEqual(["opportunity_lease"]);
          expect(await lastEvent(w, id)).toMatchObject({ event: "go", code: "lease_expired" });
          // The lease row stays the holder's, with its 24 hours.
          expect(await leaseOf(w, id)).toEqual({ holder: scout.id, live: false, preferred: true });
          // Another agent is neither offered it nor given it.
          expect(ok(await w.work.listOpportunities(other.token, {})).opportunities.map((one) => one.id)).not.toContain(
            id,
          );
          expect(await claim(w, other, id)).toEqual({ ok: false, code: "not_found", refusal: "work_held" });
          // The holder takes it back and says where it stands.
          ok(await claim(w, scout, id));
          expect(ok(await progress(w, scout, move))).toEqual({ move, opportunity: "claimed" });
        }
        // Three days on: the move was never closed, and the work is still the holder's.
        expect((await moveEvents(w, move)).filter((one) => one.event !== "reported")).toEqual([
          { event: "cleared", code: null },
        ]);
        expect((await moveEvents(w, move)).filter((one) => one.code === "progress")).toHaveLength(13);
        expect(await leaseOf(w, id)).toMatchObject({ holder: scout.id, live: true });

        // The holder goes quiet. The lease lapses: the work returns, the move stays open.
        await age(w, id, 1);
        expect(await tick(dispatch, id, [move], new Date())).toEqual(["opportunity_lease"]);
        expect((await moveEvents(w, move)).at(-1)).toEqual({ event: "reported", code: "progress" });
        // 25 hours later by the dispatcher's clock, with no word: the move is abandoned and the
        // hold ends.
        expect(await tick(dispatch, id, [move], later(25 * HOUR))).toEqual(["move_unreported", "hold_lapsed"]);
        expect((await moveEvents(w, move)).at(-1)).toEqual({ event: "failed", code: "abandoned" });
        expect(await lastEvent(w, id)).toMatchObject({ event: "go", code: "preference_lapsed" });
      });
      // And by the database's clock: the 24 hours over, the other agent takes it.
      await age(w, id, 25);
      ok(await claim(w, other, id));
      expect(await leaseOf(w, id)).toMatchObject({ holder: other.id, live: true });
    }, WORLD));

  it("A2: a move with no progress is abandoned when its lease lapses, as before", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const { id, move } = await held(w, scout);
      await age(w, id, 1);
      await dispatching(w, async (dispatch) => {
        expect(await tick(dispatch, id, [move], new Date())).toEqual(["opportunity_lease"]);
      });
      expect(await moveEvents(w, move)).toEqual([
        { event: "cleared", code: null },
        { event: "failed", code: "abandoned" },
      ]);
    }, WORLD));

  it("A3, A4: progress keeps the task claimed and the move open; the brief, the caller's list and the pack serve the latest; a claim the next day answers it", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id, move } = await held(w, scout);
      // One that says neither what is done nor what comes next records nothing.
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: move as never,
            outcome: "progress",
            report: { waitingOn: "a reply" },
            requestId: request(),
          }),
        ),
      ).toEqual({ move, refused: ["needs_progress"] });
      expect(await moveEvents(w, move)).toEqual([{ event: "cleared", code: null }]);

      // A repeat of a request answers as the first did and writes no second report.
      const first = request();
      const early = () =>
        w.work.reportMove(scout.token, {
          move: move as never,
          outcome: "progress",
          report: { done: ["read the first filing"], next: "an earlier next step" },
          requestId: first,
        });
      expect(ok(await early())).toEqual({ move, opportunity: "claimed" });
      expect(ok(await early())).toEqual({ move, opportunity: "claimed" });
      const resumeAt = later(DAY).toISOString();
      expect(
        ok(
          await w.work.reportMove(scout.token, {
            move: move as never,
            outcome: "progress",
            report: {
              done: ["read the first filing", "found the two founders"],
              next: "confirm who runs it day to day",
              waitingOn: "the registry's reply",
              resumeAt: resumeAt as never,
            },
            requestId: request(),
          }),
        ),
      ).toEqual({ move, opportunity: "claimed" });
      // The event: on the move, coded progress, under the work's own label, sealed.
      const label = await w.label("ledger.opportunities", id);
      const events = await w.admin<{ event: string; code: string | null; compartments: string[]; sealed: boolean }>(
        "select event, code, compartments, body_enc is not null as sealed from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported' order by id",
        [move],
      );
      expect(events).toEqual([
        { event: "reported", code: "progress", compartments: label, sealed: true },
        { event: "reported", code: "progress", compartments: label, sealed: true },
      ]);
      expect(await lastEvent(w, id)).toMatchObject({ event: "claimed" });
      expect(await leaseOf(w, id)).toMatchObject({ holder: scout.id, live: true });

      const latest = {
        done: [{ untrusted: "read the first filing" }, { untrusted: "found the two founders" }],
        next: { untrusted: "confirm who runs it day to day" },
        waitingOn: { untrusted: "the registry's reply" },
        resumeAt,
        at: expect.any(String),
        by: "scout",
      };
      // The holder's claim again, its list and its pack.
      const again = ok(await claim(w, scout, id));
      expect(again.opportunity.progress).toEqual(latest);
      expect(again.brief?.progress).toEqual(latest);
      const mine = ok(await w.work.listOpportunities(scout.token, { scope: "mine" }));
      expect(mine.opportunities.map((one) => [one.id, one.progress])).toEqual([[id, latest]]);
      const served = (await pack(w, scout)).items.filter((one) => one.section === "my_work");
      expect(served).toEqual([
        expect.objectContaining({
          id,
          kind: "held_work",
          opportunity: expect.objectContaining({ id, status: "claimed", progress: latest }),
          checkBack: null,
        }),
      ]);
      // A client that holds nothing is served no held work.
      expect((await pack(w, other)).items.filter((one) => one.section === "my_work")).toEqual([]);
      // No outcome card waits on a progress report.
      await dispatching(w, async (dispatch) => {
        expect(await dispatch.reportsWithoutCard()).not.toContain(move);
      });

      // The next day another agent takes the work over: its brief answers where it was left.
      await age(w, id, 26);
      const taken = ok(await claim(w, other, id));
      expect(taken.brief?.progress).toEqual(latest);
      // The first holder's progress is no longer taken: it holds no lease.
      expect(await progress(w, scout, move)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
    }, WORLD));

  it("A5: a park of 20 days survives the 14-day expiry, with its note in the pack; progress restarts the 14 days", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const parked = await held(w, scout);
      const plain = await held(w, scout);
      const dueAt = later(20 * DAY).toISOString();
      ok(
        await w.work.setIntention(scout.token, {
          opportunity: parked.id as never,
          dueAt: dueAt as never,
          park: true,
          note: "waiting for the March filing",
          requestId: request(),
        }),
      );
      const expiring = async (dispatch: Dispatch, now: Date): Promise<string[]> =>
        (await dispatch.expired(now)).flatMap((one) => (one.kind === "opportunity" ? [one.opportunity] : []));
      await dispatching(w, async (dispatch) => {
        // Fifteen days after their go: the plain one is due to expire, the parked one is not.
        const fifteen = later(15 * DAY);
        expect(await expiring(dispatch, fifteen)).toContain(plain.id);
        expect(await expiring(dispatch, fifteen)).not.toContain(parked.id);
        expect(await dispatch.expire({ kind: "opportunity", opportunity: parked.id as never }, fifteen)).toBe(false);
        // Fourteen days after its check-back it is.
        expect(await expiring(dispatch, later(35 * DAY))).toContain(parked.id);

        // Progress: a go 13 days old expires in two days, unless its holder reported since.
        const quiet = await held(w, scout);
        const busy = await held(w, scout);
        for (const one of [quiet, busy])
          await ownerUpdate(
            w,
            "ledger.opportunity_decisions",
            "created_at = now() - interval '13 days'",
            "opportunity_id = $1",
            [one.id],
          );
        ok(await progress(w, scout, busy.move));
        const two = later(2 * DAY);
        expect(await expiring(dispatch, two)).toContain(quiet.id);
        expect(await expiring(dispatch, two)).not.toContain(busy.id);
        expect(await dispatch.expire({ kind: "opportunity", opportunity: busy.id as never }, two)).toBe(false);
        expect(await dispatch.expire({ kind: "opportunity", opportunity: quiet.id as never }, two)).toBe(true);
        expect(await lastEvent(w, quiet.id)).toMatchObject({ event: "expired" });
      });
      // The pack: the parked work with its check-back and its note.
      const item = (await pack(w, scout)).items.find((one) => one.kind === "held_work" && one.id === parked.id);
      expect(item).toMatchObject({
        kind: "held_work",
        checkBack: { dueAt, note: { untrusted: "waiting for the March filing" } },
      });
      // The note is sealed: its words are in no column.
      const [stored] = await w.admin<{ body: string }>(
        "select body_enc::text as body from ledger.intentions where opportunity_id = $1",
        [parked.id],
      );
      expect(stored?.body).toBeDefined();
      expect(stored?.body).not.toContain("March");
    }, WORLD));

  it("A5: a check-back is at most 90 days ahead and never past the work's own expiry, which counts one no later than 90 days after the go", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const { id } = await held(w, scout);
      // A reminder, which holds nothing, may be up to 90 days ahead; one that holds, 30.
      const set = (days: number, park = false) =>
        w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: later(days * DAY).toISOString() as never,
          park,
          requestId: request(),
        });
      // 91 days ahead is refused and writes nothing; 89 is taken.
      expect(await set(91)).toEqual({ ok: false, code: "invalid_request", refusal: "due_too_far" });
      expect(await set(31, true)).toEqual({ ok: false, code: "invalid_request", refusal: "due_too_far" });
      expect(await w.admin("select 1 from ledger.intentions where opportunity_id = $1", [id])).toEqual([]);
      ok(await set(89));
      // A go 80 days old: a check-back 20 days ahead, 100 days after the go, is past the time the
      // expiry counts and is refused; one 9 days ahead, 89 days after the go, is taken, and the
      // 14 days run from it.
      await ownerUpdate(
        w,
        "ledger.opportunity_decisions",
        "created_at = now() - interval '80 days'",
        "opportunity_id = $1",
        [id],
      );
      expect(await set(20)).toEqual({ ok: false, code: "invalid_request", refusal: "due_past_expiry" });
      ok(await set(9));
      await dispatching(w, async (dispatch) => {
        const expiring = async (now: Date): Promise<string[]> =>
          (await dispatch.expired(now)).flatMap((one) => (one.kind === "opportunity" ? [one.opportunity] : []));
        expect(await expiring(later(22 * DAY))).not.toContain(id);
        expect(await expiring(later(24 * DAY))).toContain(id);
        expect(await dispatch.expire({ kind: "opportunity", opportunity: id as never }, later(24 * DAY))).toBe(true);
      });
      expect(await lastEvent(w, id)).toMatchObject({ event: "expired" });
    }, WORLD));

  it("a due check-back an earlier holder left never returns work another client holds", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id } = await held(w, scout);
      const dueAt = later(2 * HOUR).toISOString() as never;
      // A reminder the first holder left before it let the work go: a day on, its lease long run
      // out, another client takes the work. (A hand-off or a release would cancel the reminder.)
      const stale = ok(
        await w.work.setIntention(scout.token, { opportunity: id as never, dueAt, park: false, requestId: request() }),
      ).intention;
      await age(w, id, 25);
      ok(await claim(w, other, id));
      const { move } = ok(
        await w.work.planMove(other.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
      );
      const own = ok(
        await w.work.setIntention(other.token, { opportunity: id as never, dueAt, requestId: request() }),
      ).intention;
      await dispatching(w, async (dispatch) => {
        const now = later(3 * HOUR);
        const due = (await dispatch.dueIntentions(now)).filter((one) => one.opportunity === id);
        // Each names the client whose lease row the work has: the tick acts for that client alone.
        expect(due.map((one) => [one.id, one.client, one.holder, one.opportunityStatus])).toEqual(
          expect.arrayContaining([
            [stale, scout.id, other.id, "claimed"],
            [own, other.id, other.id, "claimed"],
          ]),
        );
        // The earlier holder's check-back returns nothing: the work, its lease and its move stay.
        expect(
          await dispatch.returnToGo(id as never, now, { client: scout.id as never, intention: stale as never }),
        ).toBe(false);
        expect(await lastEvent(w, id)).toMatchObject({ event: "claimed" });
        expect(await leaseOf(w, id)).toMatchObject({ holder: other.id });
        expect(await moveEvents(w, move)).toEqual([{ event: "cleared", code: null }]);
        // The control: the holder's own check-back returns it, held for the holder.
        expect(
          await dispatch.returnToGo(id as never, now, { client: other.id as never, intention: own as never }),
        ).toBe(true);
        expect(await lastEvent(w, id)).toMatchObject({ event: "go" });
        expect(await leaseOf(w, id)).toMatchObject({ holder: other.id, preferred: true });
      });
    }, WORLD));

  // That a lapsed holder's check-back holds the work is held-work.db.test.ts's replay.
  it("A5: a recent holder with no lease leaves a reminder, and one that never held the work does not; past its 24 hours, with a reminder alone, it sets nothing; the cap of three is each client's own", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id } = await held(w, scout);
      const dueAt = later(2 * DAY).toISOString() as never;
      const set = (client: WorkClient, more: { park?: boolean; keepEarlier?: boolean } = {}) =>
        w.work.setIntention(client.token, { opportunity: id as never, dueAt, ...more, requestId: request() });
      // The lease lapsed an hour ago: the holder still leaves a reminder, whether or not the tick
      // has run, and an agent that never held the work does not.
      await age(w, id, 1);
      ok(await set(scout, { park: false }));
      await dispatching(w, async (dispatch) => {
        expect(await tick(dispatch, id, [], new Date())).toContain("opportunity_lease");
      });
      ok(await set(scout, { park: false, keepEarlier: true }));
      expect(await set(other)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
      // Past its 24 hours, with a reminder alone, it is no longer the holder's to defer.
      await age(w, id, 25);
      expect(await set(scout)).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
      expect(await set(scout, { park: false })).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });

      // The cap: three of the caller's own, and another client's are not counted against it.
      ok(await claim(w, scout, id));
      ok(await set(scout, { keepEarlier: true }));
      expect(await set(scout, { keepEarlier: true })).toEqual({
        ok: false,
        code: "invalid_request",
        refusal: "check_backs_full",
      });
      expect(ok(await w.work.handOff(scout.token, { id: id as never, reason: "other", requestId: request() }))).toEqual(
        {
          handedOff: true,
        },
      );
      ok(await claim(w, other, id));
      ok(await set(other, { keepEarlier: true }));
    }, WORLD));

  it("A6: an opportunity is handed to the owner with the note as its basis; a task is handed off by its holder of the last 24 hours", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      // An opportunity, not a task: proposed by the agent and decided go by the owner.
      const intent = await w.intent(["investigate"], [scout]);
      const message = await w.message(OWN);
      const ref = { kind: "message" as const, id: message.id as never };
      const opportunity = ok(
        await w.work.proposeOpportunity(scout.token, {
          kind: "investigate",
          about: ref,
          summary: "look into the delivery date",
          basis: [ref],
          requestId: request(),
        }),
      ).opportunity;
      // Before the owner's go it is not the agent's to take, and the refusal says what it waits on.
      expect(await claim(w, scout, opportunity)).toEqual({ ok: false, code: "not_found", refusal: "not_go" });
      await w.decideGo(opportunity, intent);
      ok(await claim(w, scout, opportunity));
      const tried = await triedFor(w, scout);
      const toOwner = (more: { record?: string } = {}) =>
        w.work.handOff(scout.token, {
          id: opportunity as never,
          role: "owner",
          reason: "blocked",
          ...(more.record === undefined ? {} : { record: more.record as never }),
          tried,
          requestId: request(),
        });
      // To the owner it needs its note.
      expect(await toOwner()).toEqual({ ok: false, code: "invalid_request", refusal: "owner_needs_record" });
      expect(await lastEvent(w, opportunity)).toMatchObject({ event: "claimed" });
      const note = await record(w, scout, "handoff", "The supplier needs the owner's signature before it ships.");
      expect(ok(await toOwner({ record: note }))).toEqual({ handedOff: true });
      expect(await lastEvent(w, opportunity)).toEqual({
        event: "handed_to_owner",
        by: `client:${scout.id}`,
        code: null,
      });
      expect(await leaseOf(w, opportunity)).toBeUndefined();
      expect(
        await w.admin(
          "select ref_id from ledger.basis where row_kind = 'opportunity' and row_id = $1 and ref_kind = 'agent_record'",
          [opportunity],
        ),
      ).toEqual([{ ref_id: note }]);
      // No route is written, and a repeat answers as the first did.
      expect(
        await w.admin("select 1 from ledger.record_events where row_id = $1 and event = 'routed'", [opportunity]),
      ).toEqual([]);
      expect(ok(await toOwner({ record: note }))).toEqual({ handedOff: true });
      // Nobody else's to hand off: it waits on the owner, and the other agent never held it.
      expect(
        await w.work.handOff(other.token, { id: opportunity as never, reason: "other", requestId: request() }),
      ).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });

      // A task whose lease lapsed an hour ago is still its holder's to hand off; after 24 hours not.
      const lapsed = await held(w, scout);
      await age(w, lapsed.id, 1);
      expect(
        await w.work.handOff(other.token, { id: lapsed.id as never, reason: "other", requestId: request() }),
      ).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });
      expect(
        ok(await w.work.handOff(scout.token, { id: lapsed.id as never, reason: "blocked", requestId: request() })),
      ).toEqual({ handedOff: true });
      expect(await lastEvent(w, lapsed.id)).toMatchObject({ event: "go", by: "system:handoff" });
      ok(await claim(w, other, lapsed.id));
      const stale = await held(w, scout);
      await age(w, stale.id, 25);
      expect(
        await w.work.handOff(scout.token, { id: stale.id as never, reason: "blocked", requestId: request() }),
      ).toEqual({ ok: false, code: "not_found", refusal: "work_not_held" });

      // Only an opportunity goes to the owner: the owner's card is raised for that tier alone, so a
      // task its holder hands to the owner is refused, note and all, and stays the holder's.
      const mine = await held(w, scout);
      const taskNote = await record(w, scout, "handoff", "The registry wants the owner's own login.");
      expect(
        await w.work.handOff(scout.token, {
          id: mine.id as never,
          role: "owner",
          reason: "blocked",
          record: taskNote as never,
          tried: await triedFor(w, scout),
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "invalid_request", refusal: "task_not_to_owner" });
      expect(await lastEvent(w, mine.id)).toMatchObject({ event: "claimed" });
      expect(await leaseOf(w, mine.id)).toMatchObject({ holder: scout.id, live: true });
    }, WORLD));

  it("A7: the pack serves the latest handoff of each piece of work the caller holds beside its own; lesson and capability are record kinds", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const first = await held(w, scout);
      const second = await held(w, scout);
      const handoffs = async (client: WorkClient): Promise<string[]> =>
        (await pack(w, client)).items.filter((one) => one.section === "handoff").map((one) => one.id);
      // Each handed off with its own note; an earlier note on the first is superseded by a later.
      const early = await record(w, scout, "handoff", "The first task: the registry was down, try again.");
      const left = await record(w, scout, "handoff", "The first task: the registry answered, two founders listed.");
      const rest = await record(w, scout, "handoff", "The second task: nothing read yet.");
      for (const [id, note] of [
        [second.id, rest],
        [first.id, left],
      ] as const)
        ok(
          await w.work.handOff(scout.token, {
            id: id as never,
            reason: "other",
            record: note as never,
            requestId: request(),
          }),
        );
      // Before it holds them the other agent is served none of them.
      const own = await record(w, other, "handoff", "The weekly review of open tasks was finished on 2026-03-02.");
      expect(await handoffs(other)).toEqual([own]);
      ok(await claim(w, other, first.id));
      ok(await claim(w, other, second.id));
      // Its own latest first, then each held piece's latest, newest first. The early note is on no
      // work and is not its own.
      expect(await handoffs(other)).toEqual([own, rest, left]);
      expect(await handoffs(other)).not.toContain(early);
      // The first holder holds neither now: its own latest alone.
      expect(await handoffs(scout)).toEqual([rest]);

      // What an agent learned about the work and about its tools.
      const lesson = await record(w, scout, "lesson", "A registry search by number is faster than by name.");
      const capability = await record(w, scout, "capability", "The registry tool pages 50 rows at a time.");
      for (const [id, kind] of [
        [lesson, "lesson"],
        [capability, "capability"],
      ] as const)
        expect(ok(await w.reader.readRecord(other.token, { record: id as never }))).toMatchObject({ id, kind });
      expect(
        await w.admin("select kind, tool from ledger.agent_writes where id = any($1) order by kind", [
          [lesson, capability],
        ]),
      ).toEqual([
        { kind: "capability", tool: "record" },
        { kind: "lesson", tool: "record" },
      ]);
    }, WORLD));

  it("a refusal on work the caller sees names its cause: the record, the reason, the time, the lease or the move", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const { id, move } = await held(w, scout);
      const takeIn = async (): Promise<void> => {
        const writer = createWriter({ url: w.db.urls.writer, keys: w.db.keys, log: w.log });
        try {
          await writer.takeRecords();
        } finally {
          await writer.close();
        }
      };
      const written = async (client: WorkClient, kind: "handoff" | "lesson"): Promise<string> =>
        ok(
          await w.reader.record(client.token, {
            kind,
            body: "The registry asks for a second form.",
            requestId: request(),
          }),
        ).recordId;
      const release = (client: WorkClient, more: { reason?: "blocked"; record?: string } = {}) =>
        w.work.releaseOpportunity(client.token, { id: id as never, ...(more as object), requestId: request() });
      const handOff = (record: string) =>
        w.work.handOff(scout.token, {
          id: id as never,
          reason: "blocked",
          record: record as never,
          requestId: request(),
        });
      const invalid = (refusal: string) => ({ ok: false, code: "invalid_request", refusal });
      const notFound = (refusal: string) => ({ ok: false, code: "not_found", refusal });

      // A release: a task needs its reason; an agent that neither holds the work nor is offered it
      // has nothing to release.
      expect(await release(scout)).toEqual(invalid("release_needs_reason"));
      expect(await release(other, { reason: "blocked" })).toEqual(notFound("work_not_held"));
      // The record: a handoff of the caller's own, and one the writer has taken in.
      const lesson = await written(scout, "lesson");
      const theirs = await written(other, "handoff");
      const note = await written(scout, "handoff");
      for (const record of [lesson, theirs, testId("rec")]) {
        expect(await release(scout, { reason: "blocked", record })).toEqual(invalid("record_not_your_handoff"));
        expect(await handOff(record)).toEqual(invalid("record_not_your_handoff"));
      }
      expect(await release(scout, { reason: "blocked", record: note })).toEqual(invalid("record_not_taken_in"));
      expect(await handOff(note)).toEqual(invalid("record_not_taken_in"));
      // Nothing was written by any of them: the work is still the holder's.
      expect(await lastEvent(w, id)).toMatchObject({ event: "claimed" });
      expect(await leaseOf(w, id)).toMatchObject({ holder: scout.id, live: true });

      // A check-back's time, on the database's clock.
      const set = (ms: number) =>
        w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: later(ms).toISOString() as never,
          requestId: request(),
        });
      expect(await set(HOUR / 2)).toEqual(invalid("due_too_soon"));
      expect(await set(91 * DAY)).toEqual(invalid("due_too_far"));
      expect(
        await w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: later(40 * DAY).toISOString() as never,
          park: true,
          requestId: request(),
        }),
      ).toEqual(invalid("due_too_far"));
      expect(await w.admin("select 1 from ledger.intentions where opportunity_id = $1", [id])).toEqual([]);

      // The control: once the writer has taken the note in, the same hand-off is taken.
      await takeIn();
      expect(ok(await handOff(note))).toEqual({ handedOff: true });

      // A move that is closed takes no report: the refusal says to plan again.
      const second = await held(w, scout);
      ok(
        await w.work.reportMove(scout.token, {
          move: second.move as never,
          outcome: "failed",
          report: { reason: "the registry was offline all day" },
          requestId: request(),
        }),
      );
      expect(await progress(w, scout, second.move)).toEqual(notFound("move_closed"));
      // And closed work has nothing to release or defer.
      expect(await lastEvent(w, second.id)).toMatchObject({ event: "withdrawn" });
      expect(
        await w.work.releaseOpportunity(scout.token, {
          id: second.id as never,
          reason: "blocked",
          requestId: request(),
        }),
      ).toEqual(notFound("work_closed"));
      expect(
        await w.work.setIntention(scout.token, {
          opportunity: second.id as never,
          dueAt: later(2 * DAY).toISOString() as never,
          requestId: request(),
        }),
      ).toEqual(notFound("work_closed"));
      // The first task's move was never reported and its work was handed on: still cleared, so the
      // refusal is the lease's, as before.
      expect(await progress(w, scout, move)).toEqual(notFound("work_not_held"));
    }, WORLD));

  // record_not_taken_in tells the agent to send the same call again in a minute. That holds only
  // if a handoff wakes the writer's intake, as a proposal does; otherwise the record waits for the
  // next full sync, ten minutes or more away.
  it("a handoff record notifies the wake's channel, as a proposal does; a lesson notifies nothing", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      // Each write is checked as taken, so a refused one cannot pass for a quiet one.
      const written = (kind: "handoff" | "lesson") => async () =>
        ok(
          await w.reader.record(scout.token, {
            kind,
            body: "The registry asks for a second form.",
            requestId: request(),
          }),
        );
      // Whether the wake's channel heard anything while `act` ran, as `pi extract wake` listens.
      const woke = async (act: () => Promise<unknown>, patience: number): Promise<boolean> => {
        const client = new pg.Client({ connectionString: w.db.urls.pipeline });
        await client.connect();
        let heard = false;
        client.on("notification", () => {
          heard = true;
        });
        try {
          await client.query("listen pi_agent_write");
          await act();
          for (const end = Date.now() + patience; !heard && Date.now() < end; ) {
            await client.query("select 1");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return heard;
        } finally {
          await client.end();
        }
      };
      expect(await woke(written("lesson"), 500)).toBe(false);
      expect(await woke(written("handoff"), 30_000)).toBe(true);
    }, WORLD));

  it("invariant 6: a client outside a task's label is answered the same before and after it is held, progressed, parked and lapsed", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      // Cleared for `own` alone: a task's label is its proposer's clearance, which holds more.
      const narrow = await agent(w, "third", OWN);
      const id = await task(w, scout);
      expect(await w.label("ledger.opportunities", id)).toContain("agent:scout");
      const raw = (text: string) => readAs(w.db, narrow.token, (query) => query(text, [[id]]));
      const answers = async (): Promise<string> =>
        JSON.stringify({
          board: ok(await w.work.listOpportunities(narrow.token, { scope: "board" })),
          open: ok(await w.work.listOpportunities(narrow.token, {})),
          mine: ok(await w.work.listOpportunities(narrow.token, { scope: "mine" })),
          pack: (await pack(w, narrow)).items
            .filter((one) => one.section === "my_work" || one.section === "handoff" || one.section === "unreported")
            .map(({ asOf: _asOf, ...item }) => item),
          progress: await raw("select * from ledger.work_progress($1::text[])"),
          held: await raw("select * from ledger.lapse_held($1::text[])"),
          claim: await claim(w, narrow, id),
          defer: await w.work.setIntention(narrow.token, {
            opportunity: id as never,
            dueAt: later(2 * DAY).toISOString() as never,
            requestId: request(),
          }),
          handOff: await w.work.handOff(narrow.token, { id: id as never, reason: "other", requestId: request() }),
          // The calls whose refusals name a cause on work the caller sees: on work it does not,
          // each is the plain not_found, whatever the work's state.
          release: await w.work.releaseOpportunity(narrow.token, { id: id as never, requestId: request() }),
          park: await w.work.setIntention(narrow.token, {
            opportunity: id as never,
            dueAt: later(HOUR / 2).toISOString() as never,
            park: true,
            requestId: request(),
          }),
          toOwner: await w.work.handOff(narrow.token, {
            id: id as never,
            role: "owner",
            reason: "blocked",
            requestId: request(),
          }),
        });
      const before = await answers();
      // The plain not_found, with no refusal, for each.
      const refusals = JSON.parse(before) as Record<string, unknown>;
      for (const key of ["claim", "defer", "handOff", "release", "park", "toOwner"])
        expect(refusals[key], key).toEqual({ ok: false, code: "not_found" });
      ok(await claim(w, scout, id));
      const { move } = ok(
        await w.work.planMove(scout.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
      );
      expect(await answers()).toBe(before);
      ok(await progress(w, scout, move));
      expect(await progress(w, narrow, move)).toEqual({ ok: false, code: "not_found" });
      expect(await answers()).toBe(before);
      ok(
        await w.work.setIntention(scout.token, {
          opportunity: id as never,
          dueAt: later(3 * DAY).toISOString() as never,
          park: true,
          note: "waiting on a reply",
          requestId: request(),
        }),
      );
      expect(await answers()).toBe(before);
      // Lapsed, and returned by the tick with its holder's 24 hours.
      await queryAs(
        w.db.urls.work,
        "update queue.leases set lease_until = now() - interval '1 hour' where resource_id = $1",
        [id],
      );
      expect(await answers()).toBe(before);
      await dispatching(w, async (dispatch) => {
        await tick(dispatch, id, [move], new Date());
      });
      expect(await lastEvent(w, id)).toMatchObject({ event: "go", code: "lease_expired" });
      expect(await answers()).toBe(before);
    }, WORLD));
});
