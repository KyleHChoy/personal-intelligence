import { autonomyRules } from "@intelligence/personal-core/planner";
import { REGISTRY } from "@intelligence/personal-ladder";
import { type WorkWorld, withWorkWorld } from "@intelligence/personal-store/testing";
import { describe, expect, it } from "vitest";
import { runTick } from "./tick.ts";

// The triggers through the whole tick, in the shapes the owner's records take: a meeting moved after
// its task, and a thread the owner opened and the other side answered. Synthetic rows only.

const TIMEOUT = 240_000;
const OWN = ["own"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const after = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const taskTier = (w: WorkWorld, at: Date): Promise<unknown> =>
  w.admin(
    `insert into policy.intents (id, goal_id, opportunity_kinds, client_ids, mode, max_open, confirmed_at, for_tasks)
     values ('int_01HZZZZZZZZZZZZZZZZZZZZZZZ', null, array['research', 'investigate'], '{}', 'policy_decides', 1, $1, true)`,
    [at.toISOString()],
  );

const tick = (w: WorkWorld, now: Date): Promise<unknown> =>
  runTick({ dispatch: w.dispatch(), registry: REGISTRY, log: w.log, now: () => now });

type Row = { id: string; subject: string; due: Date | null; event: string };
const rows = (w: WorkWorld, trigger: string): Promise<Row[]> =>
  w.admin<Row>(
    `select o.id, o.gap_subject as subject, o.due_at as due, e.event
     from ledger.opportunities o
     cross join lateral (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) e
     where o.gap_trigger = $1 order by o.created_at, o.id`,
    [trigger],
  );

async function meeting(w: WorkWorld, startsAt: Date): Promise<string> {
  const person = await w.person();
  return w.event({ startsAt, participant: person.id });
}

const moveTo = (w: WorkWorld, event: string, starts: Date): Promise<unknown> =>
  w.admin("update knowledge.event_details set starts_at = $2 where event_id = $1", [event, starts.toISOString()]);

describe("the triggers on the owner's own shapes", () => {
  it(
    "a meeting moved to another day after its task was worked raises a task for it, once",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const first = after(now, 5 * HOUR);
        const event = await meeting(w, first);
        await tick(w, now);
        const [worked] = await rows(w, "meeting_soon");
        expect(worked?.due?.toISOString()).toBe(first.toISOString());
        await w.status("opportunity", worked?.id as string, "done", { by: "agent", at: after(now, HOUR) });

        // The same day again: the work is done.
        await tick(w, after(now, 2 * HOUR));
        expect(await rows(w, "meeting_soon")).toHaveLength(1);

        // Moved a day: what was prepared may no longer hold.
        const second = after(now, 30 * HOUR);
        await moveTo(w, event, second);
        await tick(w, after(now, 3 * HOUR));
        const moved = await rows(w, "meeting_soon");
        expect(moved).toHaveLength(2);
        expect(moved[1]?.event).toBe("go");
        expect(moved[1]?.due?.toISOString()).toBe(second.toISOString());

        // And it stays one task a day.
        await tick(w, after(now, 4 * HOUR));
        expect(await rows(w, "meeting_soon")).toHaveLength(2);
      }),
    TIMEOUT,
  );

  it(
    "a waiting task for the old day closes, and the owner's no on the meeting outlasts a move",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const event = await meeting(w, after(now, 5 * HOUR));
        await tick(w, now);
        await moveTo(w, event, after(now, 30 * HOUR));
        await tick(w, after(now, HOUR));
        const open = await rows(w, "meeting_soon");
        expect(open.map((one) => one.event)).toEqual(["withdrawn", "go"]);

        await w.decision(open[1]?.id as string, "no_go", { by: "owner", at: after(now, 2 * HOUR) });
        await w.status("opportunity", open[1]?.id as string, "no_go", { by: "owner", at: after(now, 2 * HOUR) });
        await moveTo(w, event, after(now, 54 * HOUR));
        await tick(w, after(now, 25 * HOUR));
        expect(await rows(w, "meeting_soon")).toHaveLength(2);
      }),
    TIMEOUT,
  );

  it(
    "a move leaves a hand-off the owner has, and raises nothing beside it",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const event = await meeting(w, after(now, 5 * HOUR));
        await tick(w, now);
        const [handed] = await rows(w, "meeting_soon");
        await w.status("opportunity", handed?.id as string, "handed_to_owner", { by: "agent", at: after(now, HOUR) });
        await moveTo(w, event, after(now, 30 * HOUR));
        await tick(w, after(now, 2 * HOUR));
        expect((await rows(w, "meeting_soon")).map((one) => one.event)).toEqual(["handed_to_owner"]);
      }),
    TIMEOUT,
  );

  it(
    "a thread the owner opened, the other side answered, with nothing since, is owed, and raises no paid task while reply_owed is off",
    () =>
      withWorkWorld(async (w) => {
        const now = new Date();
        await taskTier(w, after(now, -DAY));
        const person = await w.person();
        const answer = await w.mail({ thread: "asked", person: person.id });
        const asked = await w.mail({ thread: "asked", direction: "outbound" });
        await w.admin("update knowledge.messages set sent_at = $2 where id = $1", [
          answer.id,
          after(now, -6 * DAY).toISOString(),
        ]);
        await w.admin("update knowledge.messages set sent_at = $2 where id = $1", [
          asked.id,
          after(now, -7 * DAY).toISOString(),
        ]);
        await w.admin(
          `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
           values ($1, $2, 'm-owner', $3, 'outbound', 'email', now() - interval '7 days', $4, '{m-owner}', 'recipient')`,
          ["itx_asked", asked.evidence, person.id, OWN],
        );
        await tick(w, now);
        expect(await rows(w, "reply_owed")).toEqual([]);
        // The control: it is the owed reply a turned-on trigger would raise.
        const owed = await w.dispatch().gapCandidates(now, { ...autonomyRules(), replyOwedOn: true });
        expect(owed.filter((one) => one.trigger === "reply_owed").map((one) => one.subject)).toEqual([answer.id]);
      }),
    TIMEOUT,
  );
});
