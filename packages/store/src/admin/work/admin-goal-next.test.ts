import type { CardView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { goalNextStep, type NextStepWork } from "./admin-goal-work.ts";

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const NOW = new Date("2026-11-16T12:00:00.000Z");
const at = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);
const work = (n: number, fields: Partial<NextStepWork>): NextStepWork => ({
  id: `opp_${ulid(n)}`,
  about_id: null,
  status: "go",
  status_at: at(-48),
  due_at: null,
  event_at: null,
  ...fields,
});
const card = (n: number, target: CardView["target"]): CardView => ({
  id: `crd_${ulid(n)}` as CardView["id"],
  kind: "opportunity_decision",
  state: "pending",
  author: "agent" as CardView["author"],
  createdAt: at(-5).toISOString() as CardView["createdAt"],
  expiresAt: null,
  options: ["go", "no_go"],
  target,
  refs: [],
});

describe("goalNextStep", () => {
  it("is the first waiting proposal, naming the work it is on", () => {
    const on = work(1, {});
    expect(goalNextStep([card(9, { kind: "opportunity", id: on.id })], [on], NOW)).toEqual({
      kind: "card",
      at: at(-5).toISOString(),
      opportunity: on.id,
      card: `crd_${ulid(9)}`,
      event: null,
    });
  });

  it("is else the work handed to the owner longest ago", () => {
    const later = work(2, { status: "handed_to_owner", status_at: at(-1) });
    const first = work(3, { status: "handed_to_owner", status_at: at(-10) });
    expect(goalNextStep([], [later, first, work(4, { due_at: at(-100) })], NOW)).toMatchObject({
      kind: "handed",
      opportunity: first.id,
    });
  });

  it("is else the soonest due date or meeting still to come of open work", () => {
    const meeting = work(5, { about_id: `evt_${ulid(6)}`, event_at: at(3) });
    const due = work(7, { due_at: at(24) });
    expect(goalNextStep([], [due, meeting], NOW)).toEqual({
      kind: "event",
      at: at(3).toISOString(),
      opportunity: meeting.id,
      card: null,
      event: `evt_${ulid(6)}`,
    });
    expect(goalNextStep([], [due, work(8, { about_id: `evt_${ulid(6)}`, event_at: at(-3) })], NOW)).toMatchObject({
      kind: "due",
      opportunity: due.id,
    });
  });

  it("passes over finished work, and is null with nothing to do", () => {
    expect(goalNextStep([], [work(10, { status: "done", due_at: at(1) })], NOW)).toBeNull();
    expect(goalNextStep([], [], NOW)).toBeNull();
  });
});
