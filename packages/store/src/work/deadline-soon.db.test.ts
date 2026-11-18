import { type AutonomyRules, GAP_ASK, GAP_MISSING } from "@intelligence/contracts/personal";
import { autonomyRules, GAP_RAISE_FLOOR_PER_DAY, planGapFlags } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { ALL_TOOLS } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";

// deadline_soon through the store's dispatch as pi_work, the tick's role, which holds no key: it reads
// an event's shape, off in the rule data, and under the day's cap though it is dated. Synthetic rows.

const OWN = ["own"];
const WORK = ["employer:example"];
const HOUR = 3_600_000;
const ON: AutonomyRules = { ...autonomyRules(), deadlineSoonOn: true };
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

type Shape = {
  minutes?: number;
  allDayDays?: number;
  person?: boolean;
  recurring?: boolean;
  cancelled?: boolean;
  response?: string;
};

async function event(w: WorkWorld, compartments: string[], starts: Date, shape: Shape): Promise<string> {
  const id = await w.seed.event(compartments);
  await w.seed.eventDetails(compartments, id);
  const allDay = shape.allDayDays !== undefined;
  const ends = allDay
    ? at(starts, (shape.allDayDays as number) * 24 * HOUR)
    : at(starts, (shape.minutes ?? 0) * 60_000);
  await w.admin(
    "update knowledge.event_details set starts_at = $2, ends_at = $3, all_day = $4, recurring = $5, cancelled = $6, owner_response = $7 where event_id = $1",
    [
      id,
      starts.toISOString(),
      ends.toISOString(),
      allDay,
      shape.recurring ?? false,
      shape.cancelled ?? false,
      shape.response ?? null,
    ],
  );
  if (shape.person === true) {
    const person = await w.seed.entity("person");
    await w.seed.account(compartments, person);
    await w.admin(
      "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
      [id, person, compartments],
    );
  }
  return id;
}

async function found(w: WorkWorld, now: Date, rules: AutonomyRules): Promise<string[]> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    return (await dispatch.gapCandidates(now, rules))
      .filter((gap) => gap.trigger === "deadline_soon")
      .map((gap) => gap.subject)
      .sort();
  } finally {
    await dispatch.close();
  }
}

describe("deadline_soon", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is on in the rule data and raises only when on: an absent switch, or a false one, is off", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const id = await event(w, OWN, at(now, 24 * HOUR), { allDayDays: 1 });
      expect(autonomyRules().deadlineSoonOn).toBe(true);
      expect(await found(w, now, autonomyRules())).toEqual([id]);
      expect(await found(w, now, ON)).toEqual([id]);
      const { deadlineSoonOn: _on, ...absent } = ON;
      expect(await found(w, now, absent)).toEqual([]);
      expect(await found(w, now, { ...ON, deadlineSoonOn: false })).toEqual([]);
    }));

  it("reads the shape of a reminder, within the window, and no other", () =>
    withWorkWorld(async (w) => {
      const now = new Date();
      const soon = at(now, 24 * HOUR);
      const raised = [
        await event(w, OWN, soon, { allDayDays: 1 }),
        await event(w, OWN, soon, { minutes: 30 }),
        await event(w, OWN, soon, { minutes: 0 }),
        // All day of one day, whoever is on it.
        await event(w, OWN, soon, { allDayDays: 1, person: true }),
      ].sort();
      await event(w, OWN, soon, { allDayDays: 3 });
      await event(w, OWN, soon, { minutes: 31 });
      await event(w, OWN, soon, { minutes: 15, person: true });
      await event(w, OWN, soon, { allDayDays: 1, recurring: true });
      await event(w, OWN, soon, { allDayDays: 1, cancelled: true });
      await event(w, OWN, soon, { allDayDays: 1, response: "declined" });
      await event(w, OWN, at(now, 72 * HOUR), { allDayDays: 1 });
      await event(w, OWN, at(now, -HOUR), { minutes: 0 });
      expect(await found(w, now, ON)).toEqual(raised);
    }));

  it("raises a task under the event's label that an agent is told how to treat, and pi_work alone may scan", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await w.client("scout", OWN, { tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS] });
      await w.harness(scout, "research", "investigate");
      const now = new Date();
      const id = await event(w, OWN, at(now, 24 * HOUR), { allDayDays: 1 });
      await event(w, WORK, at(now, 24 * HOUR), { allDayDays: 1 });
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const flags = await dispatch.gapFlags(now);
        const plan = planGapFlags({
          candidates: await dispatch.gapCandidates(now, ON),
          open: flags.open,
          history: flags.history,
        });
        for (const { gap, card } of plan.raise) await dispatch.raiseGapFlag(gap, !card);
      } finally {
        await dispatch.close();
      }
      const rows = await w.admin<{ gap_subject: string; compartments: string[]; about_id: string; tier: string }>(
        "select gap_subject, compartments, about_id, tier from ledger.opportunities where gap_trigger = 'deadline_soon' order by compartments",
      );
      expect(rows).toHaveLength(2);
      const board = ok(await w.work.listOpportunities(scout.token, { scope: "board" })).opportunities;
      const seen = board.filter((one) => one.gap?.trigger === "deadline_soon");
      expect(seen.map((one) => one.about)).toEqual([{ kind: "event", id }]);
      expect(seen[0]?.gap).toMatchObject({ missing: GAP_MISSING.deadline_soon, ask: GAP_ASK.deadline_soon });
    }));

  it("stands under the day's cap though it is dated, and what it raises counts toward the cap", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const now = new Date();
      for (let n = 0; n < GAP_RAISE_FLOOR_PER_DAY + 2; n += 1)
        await event(w, OWN, at(now, (n + 1) * HOUR), { allDayDays: 1 });
      const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
      try {
        const empty = await dispatch.gapSupply(now);
        const flags = await dispatch.gapFlags(now);
        const plan = planGapFlags({
          candidates: await dispatch.gapCandidates(now, ON),
          open: flags.open,
          history: flags.history,
          supply: empty,
        });
        const limited = plan.raise.filter((one) => one.gap.trigger === "deadline_soon");
        expect(limited.every((one) => one.limited)).toBe(true);
        for (const { gap, card } of limited.slice(0, GAP_RAISE_FLOOR_PER_DAY)) await dispatch.raiseGapFlag(gap, !card);
        const [numbers] = [...(await dispatch.gapSupply(new Date())).values()];
        expect(numbers?.raisedToday).toBe(GAP_RAISE_FLOOR_PER_DAY);
        const again = await dispatch.gapFlags(now);
        const held = planGapFlags({
          candidates: await dispatch.gapCandidates(now, ON),
          open: again.open,
          history: again.history,
          supply: await dispatch.gapSupply(new Date()),
        });
        expect(held.raise.filter((one) => one.gap.trigger === "deadline_soon")).toEqual([]);
        expect(held.capped).toBe(2);
      } finally {
        await dispatch.close();
      }
    }));
});
