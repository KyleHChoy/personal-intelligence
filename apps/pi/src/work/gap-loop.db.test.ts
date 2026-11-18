import type { CardId } from "@intelligence/contracts/personal";
import { GAP_WITHDRAWN_REST_DAYS } from "@intelligence/personal-core/planner";
import { REGISTRY } from "@intelligence/personal-ladder";
import { createAdmin, createGapLaneStore } from "@intelligence/personal-store";
import { queryAs, seedAudience, seedLines, type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { runGapLanes } from "../extract/gap-lanes.ts";
import { runTick } from "./tick.ts";

// What one gap costs tick after tick, through the whole tick: the raise, rung 0's decision and what
// the next tick reads of it. Nothing a tick raises may be decided no_go by code at once, a no_go by
// code bars nothing for good, and the owner's own no binds. A close person's flag is the pipeline's
// pass's, so a close person's run is that pass and then a tick. Synthetic rows only.

const TIMEOUT = 240_000;
const OWN = ["own"];
const WORK = ["employer:example"];
const MINUTE = 60_000;
const DAY = 86_400_000;
const after = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

type Row = { id: string; about: string; source: string; event: string; reason: string | null };

const rows = (w: WorkWorld, trigger: string): Promise<Row[]> =>
  w.admin<Row>(
    `select o.id, o.about_id as about, o.gap_source as source, e.event,
       (select d.reason from ledger.opportunity_decisions d where d.opportunity_id = o.id order by d.id desc limit 1) as reason
     from ledger.opportunities o
     cross join lateral (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) e
     where o.gap_trigger = $1 order by o.created_at, o.id`,
    [trigger],
  );

const gapCounts = (w: WorkWorld): Record<string, number> | undefined =>
  w.logged.filter((one) => one.event.event === "gap_flags").at(-1)?.event.counts as Record<string, number> | undefined;

async function tick(w: WorkWorld, now: Date): Promise<Record<string, number> | undefined> {
  w.logged.length = 0;
  await runTick({ dispatch: w.dispatch(), registry: REGISTRY, log: w.log, now: () => now });
  return gapCounts(w);
}

// The pipeline's pass over the warmth lanes after a day build, then a tick, which decides what the
// pass raised for the owner's card: the counts the pass logged.
async function laneTick(w: WorkWorld, now: Date): Promise<Record<string, number> | undefined> {
  w.logged.length = 0;
  const lanes = createGapLaneStore({ url: w.db.urls.pipeline, keys: w.db.keys, log: w.log });
  try {
    await runGapLanes(lanes, now, w.log);
  } finally {
    await lanes.close();
  }
  const counts = w.logged.filter((one) => one.event.event === "gap_lanes").at(-1)?.event.counts as
    | Record<string, number>
    | undefined;
  await runTick({ dispatch: w.dispatch(), registry: REGISTRY, log: w.log, now: () => now });
  return counts;
}

// The owner's task tier, on since before the world's first tick: what authorizes a gap flag.
const taskTier = (w: WorkWorld, at: Date): Promise<unknown> =>
  w.admin(
    `insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at, for_tasks)
     values ('int_01HZZZZZZZZZZZZZZZZZZZZZZZ', null, array['research', 'investigate'], '{}', 'policy_decides', 1, $1, true)`,
    [at.toISOString()],
  );

// A close person with no tie: their days under the label, as the day build writes them, from which
// the owner's ranking gives `close`; the label is the owner's audience's, by a claim under it.
async function closePerson(w: WorkWorld, entity: string, label: string[], now: Date): Promise<void> {
  await seedAudience(w.claim, [label]);
  await seedLines(w.db, label, [{ entity, tier: "close", warmth: 1 }], { append: true, today: now });
}

let mentions = 0;

// A name no one resolved, in a message sent at `at`.
async function mention(w: WorkWorld, fp: string, at: Date): Promise<string> {
  const message = await w.mail();
  await w.admin("update knowledge.messages set sent_at = $2 where id = $1", [message.id, at.toISOString()]);
  await w.admin(
    `insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments)
     values ($1, $2, 1, $3, '{}', $4)`,
    [`umn_${String((mentions += 1)).padStart(26, "0")}`, message.evidence, fp, OWN],
  );
  return message.id;
}

const FP = "a".repeat(64);
const OTHER_FP = "b".repeat(64);

// What rung 0 writes on a row: a decision by policy and its status event by code.
async function codeNoGo(w: WorkWorld, id: string, at: Date): Promise<void> {
  await w.decision(id, "no_go", { by: "policy", at });
  await w.status("opportunity", id, "no_go", { by: "system:work", at });
}

async function ownerNoGo(w: WorkWorld, id: string, at: Date): Promise<void> {
  await w.decision(id, "no_go", { by: "owner", at });
  await w.status("opportunity", id, "no_go", { by: "owner", at });
}

describe("a gap flag's cost, tick after tick", () => {
  // The defect: the owner's no on work about a person under another label makes a close person's flag
  // wider than the gap it holds. The card expires unanswered, and from then on every tick raised
  // one row that rung 0 closed `expired_no_news`.
  it(
    "the owner's no under another label: one row for the owner's card, and no more once it expires",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        const prior = await w.opportunity({
          kind: "investigate",
          about: ["entity", person.id],
          refs: [["entity", person.id]],
          compartments: WORK,
        });
        await ownerNoGo(w, prior.id, after(now, -20 * DAY));
        await closePerson(w, person.id, OWN, now);

        // Waiting on the card, the one row stays: code neither withdraws it nor raises another.
        for (let i = 0; i < 3; i += 1) await laneTick(w, after(now, i * 3 * MINUTE));
        const waiting = await rows(w, "close_no_tie");
        expect(waiting.map((one) => one.event)).toEqual(["proposed"]);
        const cards = await w.admin<{ id: string }>("select id from ledger.cards where target_id = $1", [
          waiting[0]?.id,
        ]);
        expect(cards).toHaveLength(1);

        await w.status("card", cards[0]?.id as string, "expired", { by: "system:work", at: after(now, 15 * MINUTE) });
        for (let i = 0; i < 4; i += 1) await laneTick(w, after(now, (20 + i * 3) * MINUTE));
        expect((await rows(w, "close_no_tie")).map((one) => [one.event, one.reason])).toEqual([
          ["no_go", "expired_no_news"],
        ]);

        // Its rest over, the case is still closed with nothing new: no row is spent, and the log says so.
        const counts = await laneTick(w, after(now, 9 * DAY));
        expect(await rows(w, "close_no_tie")).toHaveLength(1);
        expect(counts).toMatchObject({ raised: 0, withheld: 1 });

        // Which card holds it is in `pia work report`, since a person's gap has no new source to come
        // back from. A card that plainly ran out has no reopen; one the policy expired does.
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
        try {
          const read = async () => (await admin.work.report(7)).heldByExpiredCard;
          expect(await read()).toEqual([
            {
              card: cards[0]?.id,
              opportunity: waiting[0]?.id,
              trigger: "close_no_tie",
              reopenable: false,
            },
          ]);
          await w.status("card", cards[0]?.id as string, "expired", { by: "system:card_expiry" });
          expect((await read())[0]?.reopenable).toBe(true);
        } finally {
          await admin.close();
        }
      }),
    TIMEOUT,
  );

  // What the box held: 2,927 rows in 2,927 ticks, each closed `owner_declined`, since the owner's no on
  // one card closed the case and the widened flag's key was not the gap's. Pinned at that no.
  it(
    "the owner's no on the card of a widened flag ends it: no row, tick after tick, and none closed owner_declined",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        const prior = await w.opportunity({
          kind: "investigate",
          about: ["entity", person.id],
          refs: [["entity", person.id]],
          compartments: WORK,
        });
        await ownerNoGo(w, prior.id, after(now, -20 * DAY));
        await closePerson(w, person.id, OWN, now);
        await laneTick(w, now);
        const [flag] = await rows(w, "close_no_tie");
        await ownerNoGo(w, flag?.id as string, after(now, MINUTE));

        for (let i = 0; i < 4; i += 1) await laneTick(w, after(now, (5 + i * 3) * MINUTE));
        // Past the rest and the news days as well.
        await laneTick(w, after(now, 9 * DAY));
        expect((await rows(w, "close_no_tie")).map((one) => one.event)).toEqual(["no_go"]);
        expect(
          await w.admin(
            "select 1 from ledger.opportunity_decisions where decided_by = 'policy' and decision = 'no_go' and reason = 'owner_declined'",
          ),
        ).toEqual([]);
      }),
    TIMEOUT,
  );

  it(
    "the tick neither raises nor closes a warmth lane's flag: the pipeline's pass does both",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        await closePerson(w, person.id, OWN, now);
        await tick(w, now);
        expect(await rows(w, "close_no_tie")).toEqual([]);
        await laneTick(w, now);
        const [flag] = await rows(w, "close_no_tie");
        expect(flag?.event).toBe("go");

        // Its gap fills: a tick leaves it open, and its close is refused to the tick's role; the
        // pipeline's pass closes it.
        await seedLines(w.db, OWN, [], { today: now });
        await tick(w, after(now, 3 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("go");
        await expect(
          queryAs(w.db.urls.work, "select ledger.close_gap_flag($1, now())", [flag?.id]),
        ).rejects.toMatchObject({ code: "42501" });
        await laneTick(w, after(now, 6 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("withdrawn");
      }),
    TIMEOUT,
  );

  it(
    "while the owner's ranking is rebuilt, the pipeline's pass closes no close person's flag; rebuilt, it closes one whose gap filled",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        await closePerson(w, person.id, OWN, now);
        await laneTick(w, now);
        const [flag] = await rows(w, "close_no_tie");
        expect(flag?.event).toBe("go");

        // A removal empties the label's days and leaves its build removed: the ranking is being
        // rebuilt, so the person's absence is no gap filled.
        await seedLines(w.db, OWN, [], { today: now, removed: true });
        await laneTick(w, after(now, 3 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("go");
        // The control: built again without the person, the pass closes it.
        await seedLines(w.db, OWN, [], { today: now });
        await laneTick(w, after(now, 6 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("withdrawn");
      }),
    TIMEOUT,
  );

  it(
    "the kill switch stops the pipeline's pass as it stops the tick: no lane flag raised or closed while it is on",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        await closePerson(w, person.id, OWN, now);
        await w.killSwitch("on");
        await laneTick(w, now);
        expect(await rows(w, "close_no_tie")).toEqual([]);
        await w.killSwitch("off");
        await laneTick(w, after(now, MINUTE));
        const [flag] = await rows(w, "close_no_tie");
        expect(flag?.event).toBe("go");

        // Its gap fills while the switch is on: the flag stays open until it is off.
        await seedLines(w.db, OWN, [], { today: now });
        await w.killSwitch("on");
        await laneTick(w, after(now, 2 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("go");
        await w.killSwitch("off");
        await laneTick(w, after(now, 3 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("withdrawn");
      }),
    TIMEOUT,
  );

  // A flag that expired unclaimed, with its gap named in several messages, costs one row and is on
  // the board: a task's expiry closes no case, and a key raises from one source, not one per source.
  it(
    "a flag that expired, its gap in several sources: one new go, no no_go",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        for (const back of [3, 2, 1]) await mention(w, FP, after(now, -back * DAY));
        await tick(w, now);
        const [first] = await rows(w, "unresolved_mention");
        expect(first?.event).toBe("go");
        await w.status("opportunity", first?.id as string, "expired", { by: "system:work", at: after(now, -31 * DAY) });

        for (let i = 0; i < 3; i += 1) await tick(w, after(now, i * 3 * MINUTE));
        expect((await rows(w, "unresolved_mention")).map((one) => one.event)).toEqual(["expired", "go"]);
      }),
    TIMEOUT,
  );

  it(
    "a no_go by code is a rest: the gap comes back as a task after it, from the source it was closed on",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const resting = await mention(w, FP, after(now, -DAY));
        const rested = await mention(w, OTHER_FP, after(now, -DAY));
        await tick(w, now);
        const first = await rows(w, "unresolved_mention");
        for (const one of first)
          await codeNoGo(w, one.id, after(now, one.source === resting ? -DAY : -(GAP_WITHDRAWN_REST_DAYS + 1) * DAY));

        await tick(w, now);
        const back = (await rows(w, "unresolved_mention")).filter((one) => one.event !== "no_go");
        expect(back.map((one) => [one.source, one.event])).toEqual([[rested, "go"]]);
      }),
    TIMEOUT,
  );

  it(
    "invariant 11: the owner's no holds from its source for good; a new source becomes the owner's card, never go",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        await mention(w, FP, after(now, -70 * DAY));
        await tick(w, now);
        const [first] = await rows(w, "unresolved_mention");
        await ownerNoGo(w, first?.id as string, after(now, -60 * DAY));

        await tick(w, now);
        expect(await rows(w, "unresolved_mention")).toHaveLength(1);

        const newer = await mention(w, FP, after(now, -DAY));
        await tick(w, now);
        const both = await rows(w, "unresolved_mention");
        expect(both.map((one) => one.event)).toEqual(["no_go", "proposed"]);
        expect(both[1]?.source).toBe(newer);
        const [card] = await w.admin<{ id: CardId }>("select id from ledger.cards where target_id = $1", [both[1]?.id]);

        // The owner's no on a flag still waiting closes it, as ever.
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
        try {
          await admin.cards.decide({
            cards: [card?.id as CardId],
            answer: "no_go",
            requestId: "01HZZZZZZZZZZZZZZZZZZZZZZX",
          });
        } finally {
          await admin.close();
        }
        expect(await w.latest("opportunity", both[1]?.id as string)).toBe("no_go");
      }),
    TIMEOUT,
  );

  it(
    "invariant 11: rung 0's no on a veto of the owner's holds as the owner's does, past the rest",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        await mention(w, FP, after(now, -DAY));
        await tick(w, now);
        const [first] = await rows(w, "unresolved_mention");
        const at = after(now, -(GAP_WITHDRAWN_REST_DAYS + 1) * DAY);
        await w.admin(
          `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason)
           values ('01HZZZZZZZZZZZZZZZZZZZZZZZ', $1, 'system:work', $2, $3, 'no_go', 'policy', 0, 'vetoed')`,
          [at, OWN, first?.id],
        );
        await w.status("opportunity", first?.id as string, "no_go", { by: "system:work", at });

        await tick(w, now);
        expect(await rows(w, "unresolved_mention")).toHaveLength(1);
      }),
    TIMEOUT,
  );

  // A flag code withdrew leaves its card waiting. The owner's no on that card is still a no.
  it(
    "invariant 11: the owner's no on a card whose flag was withdrawn binds when the gap comes back",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person(OWN);
        const prior = await w.opportunity({
          kind: "investigate",
          about: ["entity", person.id],
          refs: [["entity", person.id]],
          compartments: WORK,
        });
        await ownerNoGo(w, prior.id, after(now, -20 * DAY));
        await closePerson(w, person.id, OWN, now);
        await laneTick(w, now);
        const [flag] = await rows(w, "close_no_tie");
        const [card] = await w.admin<{ id: CardId }>("select id from ledger.cards where target_id = $1", [flag?.id]);

        // The gap fills, and code withdraws the flag; the card still waits.
        await seedLines(w.db, OWN, [], { today: now });
        await laneTick(w, after(now, 3 * MINUTE));
        expect(await w.latest("opportunity", flag?.id as string)).toBe("withdrawn");

        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
        try {
          await admin.cards.decide({
            cards: [card?.id as CardId],
            answer: "no_go",
            requestId: "01HZZZZZZZZZZZZZZZZZZZZZZY",
          });
        } finally {
          await admin.close();
        }
        expect(
          await w.admin("select decided_by from ledger.opportunity_decisions where opportunity_id = $1", [flag?.id]),
        ).toEqual([{ decided_by: "owner" }]);
        expect(await w.latest("opportunity", flag?.id as string)).toBe("withdrawn");

        await closePerson(w, person.id, OWN, after(now, 30 * DAY));
        await laneTick(w, after(now, 30 * DAY));
        expect(await rows(w, "close_no_tie")).toHaveLength(1);
      }),
    TIMEOUT,
  );

  // The same person at a new meeting: the same case, which the owner's no closed. Within the days
  // rung 0 gives a closed case, a raise would be no_go at once, so none is spent; after them it is a card.
  it(
    "a raise rung 0 would close at once spends no row; after the news days it is the owner's card",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const [recent, earlier] = [await w.person(OWN), await w.person(OWN)];
        for (const person of [recent, earlier])
          await w.event({ startsAt: after(now, 2 * DAY), participant: person.id });
        await tick(w, now);
        const first = await rows(w, "unknown_attendee");
        expect(first.map((one) => one.event)).toEqual(["go", "go"]);
        for (const one of first) await ownerNoGo(w, one.id, after(now, one.about === recent.id ? -DAY : -8 * DAY));

        for (const person of [recent, earlier]) await w.event({ startsAt: after(now, DAY), participant: person.id });
        const counts = await tick(w, now);
        const later = await rows(w, "unknown_attendee");
        expect(counts).toMatchObject({ withheld: 1 });
        expect(later.filter((one) => one.about === recent.id)).toHaveLength(1);
        const card = later.filter((one) => one.about === earlier.id).at(-1);
        expect(card?.event).toBe("proposed");
        expect(await w.admin("select id from ledger.cards where target_id = $1", [card?.id])).toHaveLength(1);
      }),
    TIMEOUT,
  );
});
