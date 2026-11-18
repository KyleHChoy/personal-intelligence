import { ClaimTier, type OwnerLongWork, ProjectChange, projectStatusTierOf } from "@intelligence/contracts/personal";
import type { StatusWord } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { longestHeldFirst } from "./admin-long-work.ts";
import { projectChanges, statusTierOf } from "./admin-project-board.ts";

// The Projects room's rules without a database: which tier a status claim is, what counts as a
// change of the last seven days, and the order of the work in hand.

describe("a status claim's tier, for the owner", () => {
  it("is the owner's when a belief rests on what the owner stated, confirmed or relayed, a source's on any other", () => {
    expect(statusTierOf("owner_command", "owner", false)).toBe("owner");
    expect(statusTierOf("agent_record", "owner_confirmed", false)).toBe("owner");
    expect(statusTierOf("agent_record", "owner_relayed", false)).toBe("owner");
    expect(statusTierOf("source", "source", false)).toBe("source");
    expect(statusTierOf("agent_research", "researched", false)).toBe("source");
    // A source's claim is a source's word even beside the owner's in one belief.
    expect(statusTierOf("source", "owner", false)).toBe("source");
  });

  // What no person confirmed is never shown as the owner's: as the agents' read serves it.
  it("is not the owner's when a source or a release let an agent's claim through", () => {
    expect(statusTierOf("agent_record", "source", false)).toBe("source");
    expect(statusTierOf("agent_record", "observed", false)).toBe("source");
    for (const tier of ClaimTier.options)
      expect(statusTierOf("agent_record", tier, false), tier).toBe(projectStatusTierOf(tier));
  });

  it("is an agent's when no belief rests on its finding's claim, and no word at all once its record is dropped", () => {
    expect(statusTierOf("agent_record", null, false)).toBe("agent");
    expect(statusTierOf("agent_close", null, false)).toBe("agent");
    expect(statusTierOf("agent_record", null, true)).toBeNull();
  });

  it("is no word when it is a source's claim no belief of the owner's rests on", () => {
    expect(statusTierOf("source", null, false)).toBeNull();
    expect(statusTierOf("agent_research", null, false)).toBeNull();
    // The owner's own statement stands whatever the build kept.
    expect(statusTierOf("owner_command", null, false)).toBe("owner");
  });
});

describe("what changed on a project", () => {
  const since = new Date("2026-10-13T12:00:00Z");
  const word = (at: string, value: StatusWord["value"], tier: StatusWord["tier"]): StatusWord => ({
    tier,
    value,
    at,
    by:
      tier === "owner"
        ? { kind: "owner" }
        : tier === "agent"
          ? { kind: "agent", client: "sable" }
          : { kind: "source", who: null },
  });
  const event = (at: string, name: string, code: string | null, by: string) => ({
    row_id: "ent_01J00000000000000000000001",
    event: name,
    code,
    at: new Date(at),
    by,
  });

  it("lists each status said, each field set and each step of its work since the time, newest first", () => {
    const changes = projectChanges(
      [word("2026-10-19T09:00:00.000Z", "blocked", "agent"), word("2026-10-01T09:00:00.000Z", "active", "owner")],
      [
        event("2026-10-18T09:00:00Z", "set", "due_at", "client:cli_01J00000000000000000000002"),
        event("2026-10-17T09:00:00Z", "created", null, "owner"),
        event("2026-10-16T09:00:00Z", "closed", null, "owner"),
        // A field the page has no word for, and an event before the window.
        event("2026-10-15T09:00:00Z", "set", "something_else", "owner"),
        event("2026-10-02T09:00:00Z", "set", "name", "owner"),
      ],
      [{ row_id: "opp_01J00000000000000000000003", event: "claimed", at: new Date("2026-10-20T09:00:00Z") }],
      since,
    );
    for (const change of changes) expect(ProjectChange.parse(change)).toEqual(change);
    expect(changes.map((one) => [one.kind, one.at.slice(0, 10)])).toEqual([
      ["work", "2026-10-20"],
      ["status", "2026-10-19"],
      ["field", "2026-10-18"],
      ["field", "2026-10-17"],
      ["status", "2026-10-16"],
    ]);
    expect(changes[2]).toMatchObject({ field: "due_at", by: "agent" });
    expect(changes[3]).toMatchObject({ field: "created", by: "owner" });
    expect(changes[4]).toMatchObject({ value: "closed", by: { kind: "owner" } });
  });

  it("is empty for a project nothing touched", () => {
    expect(projectChanges([], [], [], since)).toEqual([]);
  });
});

describe("the work in hand", () => {
  const work = (n: number, since: string | null, parkedUntil: string | null): OwnerLongWork =>
    ({ opportunity: `opp_${n}`, since, parkedUntil }) as unknown as OwnerLongWork;

  it("leads with the longest held, then the parked by when each is due back", () => {
    const ordered = longestHeldFirst([
      work(1, null, "2026-10-25T09:00:00.000Z"),
      work(2, "2026-10-19T09:00:00.000Z", null),
      work(3, null, "2026-10-21T09:00:00.000Z"),
      work(4, "2026-10-12T09:00:00.000Z", "2026-10-30T09:00:00.000Z"),
    ]);
    expect(ordered.map((one) => one.opportunity)).toEqual(["opp_4", "opp_2", "opp_3", "opp_1"]);
  });
});
