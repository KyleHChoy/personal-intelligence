import { describe, expect, it } from "vitest";
import { silentRaises } from "../../core/box-health.ts";
import { syncState } from "./coverage.ts";

// The sync's coverage state and its card's rest, with no database: the rule alone.

const MIN = 60_000;
const NOW = Date.parse("2026-11-11T20:24:00Z");
const SINCE = NOW - 7 * 24 * 60 * MIN;
// A sync that started `ago` minutes ago and took one minute.
const sync = (ago: number) => ({ start: NOW - ago * MIN, end: NOW - (ago - 1) * MIN });
// Syncs every five minutes from `from` minutes ago down to `to`.
const every5 = (from: number, to: number) => {
  const runs = [];
  for (let ago = from; ago >= to; ago -= 5) runs.push(sync(ago));
  return runs;
};

describe("the sync's state is where it stands now, not the window's worst gap", () => {
  it("is silent while no sync has started for over 30 minutes, and with no sync at all", () => {
    expect(syncState(every5(200, 45), NOW, SINCE)).toMatchObject({ silent: true, gapMinutes: 44 });
    expect(syncState([], NOW, SINCE).silent).toBe(true);
    expect(syncState(every5(200, 10), NOW, SINCE)).toEqual({ silent: false, gapMinutes: 9 });
  });

  it("stays silent for half an hour after it resumes, and is covered after that", () => {
    // Out from 420 to 70 minutes ago (the box's 13:23 to 19:15), syncing every five minutes since.
    const resumed = [...every5(600, 420), ...every5(70, 5)];
    expect(syncState(resumed, NOW, SINCE).silent).toBe(false);
    // The same outage, resumed 20 minutes ago: not yet a full healthy interval.
    const justBack = [...every5(600, 420), ...every5(20, 5)];
    expect(syncState(justBack, NOW, SINCE)).toMatchObject({ silent: true, gapMinutes: 399 });
    // On the earlier rule one such gap anywhere in the window read silent for the window's days.
    const daysAgo = [...every5(3000, 2900), ...every5(2800, 5)];
    expect(syncState(daysAgo, NOW, SINCE).silent).toBe(false);
  });

  it("a gap under a sync hold's card is the hold's, not a silent source", () => {
    const held = [...every5(600, 420), ...every5(20, 5)];
    // The timer raised the hold's card an hour into the gap.
    expect(syncState(held, NOW, SINCE, [NOW - 359 * MIN]).silent).toBe(false);
    // A card from before the gap says nothing of it.
    expect(syncState(held, NOW, SINCE, [NOW - 900 * MIN]).silent).toBe(true);
    // Held now: no sync for an hour and a half, the card raised 30 minutes ago.
    expect(syncState(every5(300, 90), NOW, SINCE, [NOW - 30 * MIN]).silent).toBe(false);
  });
});

describe("a silent row's card", () => {
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 60 * MIN);
  const now = new Date(NOW);
  it("is raised as the row enters silent, and not again while it stays so", () => {
    expect(silentRaises(true, undefined, now)).toBe(true);
    expect(silentRaises(false, { event: "pending", at: at(5) }, now)).toBe(false);
    expect(silentRaises(false, { event: "decided", at: at(50) }, now)).toBe(false);
    expect(silentRaises(true, { event: "decided", at: at(50) }, now)).toBe(true);
  });

  it("rests a day after code withdrew it, then is raised if the row is still silent", () => {
    expect(silentRaises(true, { event: "withdrawn", at: at(3) }, now)).toBe(false);
    expect(silentRaises(false, { event: "withdrawn", at: at(23) }, now)).toBe(false);
    expect(silentRaises(false, { event: "withdrawn", at: at(25) }, now)).toBe(true);
  });

  it("rests a day after an agent marked it seen, then is raised if the row is still silent", () => {
    const agent = "client:cli_01JABCDEFGHJKMNPQRSTVWXYZ0";
    expect(silentRaises(false, { event: "decided", at: at(23), by: agent }, now)).toBe(false);
    expect(silentRaises(true, { event: "decided", at: at(23), by: agent }, now)).toBe(false);
    expect(silentRaises(false, { event: "decided", at: at(25), by: agent }, now)).toBe(true);
    expect(silentRaises(false, { event: "decided", at: at(25), by: "owner" }, now)).toBe(false);
  });
});
