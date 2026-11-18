import {
  GAP_QUIET_DAYS,
  GAP_RAISE_FLOOR_PER_DAY,
  GAP_WITHDRAWN_REST_DAYS,
  gapRoom,
} from "@intelligence/personal-core/planner";
import { REGISTRY } from "@intelligence/personal-ladder";
import { createAdmin, createDispatch, type Dispatch } from "@intelligence/personal-store";
import { type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { gapReport } from "./gap-report.ts";
import { runTick } from "./tick.ts";

// The board's supply through the whole tick and its report: what an unclaimed expiry says about a
// gap, what still bounds what comes back, and a report that says what the next tick does and writes
// nothing. Synthetic rows only.

const TIMEOUT = 240_000;
const OWN = ["own"];
const DAY = 86_400_000;
const after = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const taskTier = (w: WorkWorld, at: Date): Promise<unknown> =>
  w.admin(
    `insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at, for_tasks)
     values ('int_01HZZZZZZZZZZZZZZZZZZZZZZZ', null, array['research', 'investigate'], '{}', 'policy_decides', 1, $1, true)`,
    [at.toISOString()],
  );

let mentions = 0;
const fp = (n: number): string => n.toString(16).padStart(64, "0");

async function mention(w: WorkWorld, subject: string, at: Date): Promise<void> {
  const message = await w.mail();
  await w.admin("update knowledge.messages set sent_at = $2 where id = $1", [message.id, at.toISOString()]);
  mentions += 1;
  await w.admin(
    `insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments)
     values ($1, $2, 1, $3, '{}', $4)`,
    [`umn_${String(mentions).padStart(26, "0")}`, message.evidence, subject, OWN],
  );
}

type Row = { id: string; subject: string; event: string };
const rows = (w: WorkWorld): Promise<Row[]> =>
  w.admin<Row>(
    `select o.id, o.gap_subject as subject, e.event
     from ledger.opportunities o
     cross join lateral (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) e
     where o.gap_trigger = 'unresolved_mention' order by o.created_at, o.id`,
  );

const gapCounts = (w: WorkWorld): Record<string, number> | undefined =>
  w.logged.filter((one) => one.event.event === "gap_flags").at(-1)?.event.counts as Record<string, number> | undefined;

async function tick(w: WorkWorld, now: Date): Promise<Record<string, number> | undefined> {
  w.logged.length = 0;
  await runTick({ dispatch: w.dispatch(), registry: REGISTRY, log: w.log, now: () => now });
  return gapCounts(w);
}

// Every row a raise would write, counted: what the report must leave as it found it.
const written = async (w: WorkWorld): Promise<unknown> =>
  w.admin(
    `select (select count(*) from ledger.opportunities)::int as opportunities,
       (select count(*) from ledger.opportunity_decisions)::int as decisions,
       (select count(*) from ledger.record_events)::int as events,
       (select count(*) from ledger.basis)::int as basis,
       (select count(*) from ledger.cases)::int as cases,
       (select count(*) from ledger.cards)::int as cards`,
  );

async function report(w: WorkWorld, at: Date): ReturnType<typeof gapReport> {
  const dispatch: Dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    return await gapReport(dispatch, at);
  } finally {
    await dispatch.close();
  }
}

describe("the board's supply", () => {
  it(
    "a task that ended with no result rests its gap, and one done stays quiet",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const [unclaimed, worked, leftUnfinished, failed] = [fp(1), fp(2), fp(3), fp(4)];
        await mention(w, unclaimed, after(now, -DAY));
        await mention(w, worked, after(now, -DAY));
        await mention(w, leftUnfinished, after(now, -DAY));
        await mention(w, failed, after(now, -DAY));
        await tick(w, now);
        const first = await rows(w);
        const id = (subject: string): string => first.find((one) => one.subject === subject)?.id as string;
        await w.status("opportunity", id(worked), "claimed", { by: "agent", at: after(now, -9 * DAY) });
        await w.status("opportunity", id(worked), "done", { by: "agent", at: now });
        // Claimed and given back: a claim alone left nothing to read.
        await w.status("opportunity", id(leftUnfinished), "claimed", { by: "agent", at: after(now, -9 * DAY) });
        for (const subject of [unclaimed, leftUnfinished])
          await w.status("opportunity", id(subject), "expired", { by: "system:work", at: now });
        // A failed report, as ledger.report_move closes a task.
        await w.status("opportunity", id(failed), "claimed", { by: "agent", at: after(now, -DAY) });
        await w.admin(
          `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
           values ('opportunity', $1, 'withdrawn', $3, 'client:scout', $2, 'failed')`,
          [id(failed), OWN, now.toISOString()],
        );

        // Within the rest neither comes back.
        await tick(w, after(now, (GAP_WITHDRAWN_REST_DAYS - 1) * DAY));
        expect(await rows(w)).toHaveLength(4);

        // Past it what left no result is on the board again, from the same source.
        await tick(w, after(now, (GAP_WITHDRAWN_REST_DAYS + 1) * DAY));
        const back = await rows(w);
        expect(
          back
            .filter((one) => one.event === "go")
            .map((one) => one.subject)
            .sort(),
        ).toEqual([unclaimed, leftUnfinished, failed].sort());

        // The one with a result waits out the longer quiet.
        await tick(w, after(now, (GAP_QUIET_DAYS + 1) * DAY));
        expect((await rows(w)).filter((one) => one.event === "go").map((one) => one.subject)).toContain(worked);
      }),
    TIMEOUT,
  );

  it(
    "a gap that failed three times stops being asked each week",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const subject = fp(5);
        await mention(w, subject, after(now, -DAY));
        let at = now;
        for (let round = 0; round < 3; round += 1) {
          await tick(w, at);
          const open = (await rows(w)).filter((one) => one.subject === subject);
          const last = open.at(-1);
          expect(open).toHaveLength(round + 1);
          await w.status("opportunity", last?.id as string, "claimed", { by: "agent", at });
          await w.admin(
            `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code)
             values ('opportunity', $1, 'withdrawn', $3, 'client:scout', $2, 'failed')`,
            [last?.id, OWN, at.toISOString()],
          );
          at = after(at, (GAP_WITHDRAWN_REST_DAYS + 1) * DAY);
        }
        await tick(w, at);
        expect((await rows(w)).filter((one) => one.subject === subject)).toHaveLength(3);
      }),
    TIMEOUT,
  );

  it(
    "a card the owner left to expire keeps its quiet: only a task nobody claimed rests",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const subject = fp(9);
        await mention(w, subject, after(now, -DAY));
        await tick(w, now);
        const [first] = await rows(w);
        await w.decision(first?.id as string, "no_go", { by: "owner", at: now });
        await w.status("opportunity", first?.id as string, "no_go", { by: "owner", at: now });
        // From a new source it comes back as the owner's card, which goes unanswered.
        await mention(w, subject, after(now, -3_600_000));
        await tick(w, after(now, 60_000));
        const card = (await rows(w)).at(-1);
        expect(card?.event).toBe("proposed");
        await w.status("opportunity", card?.id as string, "expired", { by: "system:work", at: now });

        const seen = await report(w, after(now, (GAP_WITHDRAWN_REST_DAYS + 1) * DAY));
        expect(seen.triggers.unresolved_mention.counts).toEqual({ held_quiet: 1 });
      }),
    TIMEOUT,
  );

  it(
    "what comes back after an expiry stays under the day's cap: the volume holds",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const backlog = GAP_RAISE_FLOOR_PER_DAY + 4;
        for (let n = 1; n <= backlog; n += 1) await mention(w, fp(100 + n), after(now, -DAY));
        // The raises of the first days, each expiring with nobody on it.
        for (let day = 0; day < 3; day += 1) await tick(w, after(now, day * DAY));
        for (const one of (await rows(w)).filter((row) => row.event === "go"))
          await w.status("opportunity", one.id, "expired", { by: "system:work", at: after(now, 3 * DAY) });

        const at = after(now, (3 + GAP_WITHDRAWN_REST_DAYS + 1) * DAY);
        const counted = await tick(w, at);
        expect(counted?.raised).toBeLessThanOrEqual(GAP_RAISE_FLOOR_PER_DAY);
        await tick(w, after(at, 5 * 60_000));
        const raisedThatDay = await w.admin<{ n: number }>(
          "select count(*)::int as n from ledger.record_events where row_kind = 'opportunity' and event = 'go' and at >= $1",
          [`${at.toISOString().slice(0, 10)}T00:00:00.000Z`],
        );
        expect(raisedThatDay[0]?.n).toBeLessThanOrEqual(GAP_RAISE_FLOOR_PER_DAY);
      }),
    TIMEOUT,
  );

  it(
    "the report says what the next tick does, per trigger, in counts and ids, and writes nothing",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const [opened, resting, quiet, declined] = [fp(1), fp(2), fp(3), fp(4)];
        for (const subject of [opened, resting, quiet, declined]) await mention(w, subject, after(now, -DAY));
        await tick(w, now);
        const id = async (subject: string): Promise<string> =>
          (await rows(w)).find((one) => one.subject === subject)?.id as string;
        await w.status("opportunity", await id(resting), "expired", { by: "system:work", at: now });
        await w.status("opportunity", await id(quiet), "done", { by: "agent", at: now });
        const no = await id(declined);
        await w.decision(no, "no_go", { by: "owner", at: now });
        await w.status("opportunity", no, "no_go", { by: "owner", at: now });
        const fresh = fp(5);
        await mention(w, fresh, after(now, -DAY));

        const at = after(now, 60_000);
        const before = await written(w);
        const seen = await report(w, at);
        expect(await written(w)).toEqual(before);

        const mentionsSeen = seen.triggers.unresolved_mention;
        expect(mentionsSeen.found).toBe(5);
        expect(mentionsSeen.counts).toEqual({
          raises: 1,
          held_open: 1,
          held_rest: 1,
          held_quiet: 1,
          held_owner_no: 1,
        });
        expect(mentionsSeen.ids.raises).toEqual([fresh]);
        expect(mentionsSeen.ids.held_rest).toEqual([resting]);
        expect(mentionsSeen.ids.held_quiet).toEqual([quiet]);
        expect(mentionsSeen.ids.held_owner_no).toEqual([declined]);
        expect(mentionsSeen.flags).toMatchObject({ go: 1, expired: 1, done: 1, no_go: 1 });
        // Every trigger is named, the one with nothing found too, so a silent one shows as silent.
        expect(seen.triggers.close_no_role.found).toBe(0);
        expect(seen.labels).toEqual([
          { label: "own", raisedToday: 4, room: gapRoom({ raisedToday: 4, claimed: 0, done: 1 }) },
        ]);

        // The tick it describes.
        const counts = await tick(w, at);
        expect(counts).toMatchObject({ raised: mentionsSeen.counts.raises });
        expect((await rows(w)).map((one) => one.subject)).toContain(fresh);

        // `pia outcomes` says the same of the window, by trigger and by where they stand, as pi_admin.
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log, recordEnabled: true });
        try {
          const read = (await admin.box.outcomes(7)).metrics.find((one) => one.metric === "gap_tasks_raised_per_day");
          expect(read).toMatchObject({
            state: "failing",
            value: 0.714,
            parts: {
              unresolved_mention: 5,
              now_go: 2,
              now_expired: 1,
              now_done: 1,
              now_no_go: 1,
              unresolved_mention_now_go: 2,
              unresolved_mention_now_done: 1,
            },
          });
        } finally {
          await admin.close();
        }
      }),
    TIMEOUT,
  );
});
