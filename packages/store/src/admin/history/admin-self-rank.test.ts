import type { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newestContact } from "../people/admin-person-lead.ts";
import { joinedBeliefs, type RankedRow, reviewRanks } from "./admin-self.ts";
import { activityTitle } from "./admin-self-activity.ts";

// The Self room's order is `get_self`'s: raw-shaped rows, as `reviewRows` builds them, made-up words.

const NOW = new Date("2026-11-04T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const hex = (n: number): string => String(n).padStart(64, "0");

let serial = 0;
const ranked = (
  over: { kind: string; fields: Record<string, unknown>; tier?: string | null; status?: string; at?: string },
  moved = false,
): RankedRow => {
  serial += 1;
  return {
    row: {
      kind: over.kind,
      status: (over.status ?? "active") as never,
      at: over.at ?? daysAgo(1),
      words: "",
      source: "mail",
      ownWords: false,
      fact: hex(serial) as never,
      facts: [hex(serial)] as never,
      factKey: hex(serial + 1000) as never,
      tier: over.tier === undefined ? "source" : over.tier,
      domain: null,
      carried: [],
    },
    record: { claim: { content: { type: over.kind, fields: over.fields } } } as unknown as ClaimRecord,
    moved,
  };
};
const situation = (state: string, over: Partial<Parameters<typeof ranked>[0]> = {}) =>
  ranked({ kind: "situation", fields: { state, domain: "career" }, ...over });
const notice = (days: number, status?: string, moved = false) =>
  ranked(
    {
      kind: "situation",
      fields: { state: "a statement is ready" },
      tier: "system_notice",
      at: daysAgo(days),
      ...(status === undefined ? {} : { status }),
    },
    moved,
  );

describe("the review's order, as get_self's", () => {
  it("leads with the owner's own word, then a source's, then what is thin or ended, then notices", () => {
    const own = situation("deciding where to work full time", { tier: "owner" });
    const trait = ranked({
      kind: "preference",
      fields: { object: "long mornings without meetings", polarity: "prefers" },
      tier: "owner",
    });
    const source = situation("between two long projects at work");
    const fragment = situation("traveling", { tier: "owner" });
    const instruction = ranked({
      kind: "preference",
      fields: { object: "no em dashes in drafts", polarity: "avoids" },
      tier: "owner",
    });
    const retired = situation("was living across the country", { tier: "owner", status: "retired" });
    const old = notice(1);
    const rows = [old, retired, instruction, fragment, source, trait, own];
    const ranks = reviewRanks(rows, NOW);
    const at = (one: RankedRow) => ranks.get(one.row);
    expect(at(own)).toMatchObject({ use: 0, rank: 1, notice: null });
    expect(at(trait)).toMatchObject({ use: 1, rank: 2 });
    expect(at(source)).toMatchObject({ use: 2, rank: 3 });
    expect(at(fragment)?.use).toBe(3);
    expect(at(instruction)?.use).toBe(3);
    expect(at(retired)).toMatchObject({ use: 4, rank: 6 });
    expect(at(old)).toMatchObject({ use: 5, rank: 7, notice: "current" });
  });

  it("a loose claim, which has no belief, ranks after a source's belief and has not ended", () => {
    const belief = situation("between two long projects at work");
    const loose = situation("between two long projects at home", { tier: null, status: "no_belief", at: daysAgo(0) });
    const ranks = reviewRanks([loose, belief], NOW);
    expect(ranks.get(belief.row)?.rank).toBe(1);
    expect(ranks.get(loose.row)).toMatchObject({ use: 2, rank: 2 });
  });

  it("keeps the newest five notices current; a lapsed or ended one is older and none is lost", () => {
    const fresh = [1, 2, 3, 4, 5].map((days) => notice(days));
    const sixth = notice(6);
    const lapsed = notice(15);
    const closed = notice(0.5, "closed");
    const rows = [lapsed, sixth, closed, ...fresh];
    const ranks = reviewRanks(rows, NOW);
    for (const one of fresh) expect(ranks.get(one.row)?.notice).toBe("current");
    for (const one of [sixth, lapsed, closed]) expect(ranks.get(one.row)?.notice).toBe("older");
    // A stale notice within its time is current, as get_self serves it.
    const stale = notice(0.2, "stale");
    expect(reviewRanks([stale], NOW).get(stale.row)?.notice).toBe("current");
    expect(ranks.size).toBe(rows.length);
  });

  it("a notice the owner moved to a part of their life stays there, last", () => {
    const moved = notice(1, undefined, true);
    const life = situation("between two long projects at work");
    const ranks = reviewRanks([moved, life], NOW);
    expect(ranks.get(moved.row)).toMatchObject({ notice: null, use: 5, rank: 2 });
  });
});

describe("a joined set of beliefs", () => {
  const member = (n: number, tier: string, domain: string | null) => {
    const { row } = ranked({ kind: "situation", fields: {}, tier });
    return {
      one: { ...row, fact: hex(n) as never, facts: [hex(n)] as never, factKey: hex(n + 5000) as never, domain },
      group: "g",
      tier: tier as never,
    };
  };
  const placeOf = (fact: string): number => Number(fact);

  it("is its latest claim, under the set's highest tier, resting on them all", () => {
    const { rows, moved } = joinedBeliefs(
      [member(2, "owner", "career"), member(1, "source", "career")],
      placeOf,
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fact: hex(1), tier: "owner", facts: [hex(1), hex(2)] });
    expect(moved.size).toBe(0);
  });

  it("keeps the owner's move though the moved member is not the latest", () => {
    const moved = member(2, "system_notice", "travel");
    const later = member(1, "system_notice", "admin");
    const joined = joinedBeliefs([moved, later], placeOf, new Set([moved.one.factKey]));
    expect(joined.rows[0]).toMatchObject({ fact: later.one.fact, domain: "travel" });
    expect(joined.moved.has(later.one.fact)).toBe(true);
    const ranks = reviewRanks(
      [
        {
          row: joined.rows[0] as never,
          record: { claim: { content: { type: "situation", fields: {} } } } as never,
          moved: true,
        },
      ],
      NOW,
    );
    expect(ranks.get(joined.rows[0] as never)?.notice).toBeNull();
  });
});

describe("an activity row's title", () => {
  const names = new Map([
    ["prj_1", "Heron Survey"],
    ["ent_1", "Blake Example"],
  ]);
  it.each([
    ["activity.worked_on", { project: "prj_1" }, "Worked on Heron Survey"],
    ["activity.worked_on", { repository: "github.com/example/heron" }, "Worked on github.com/example/heron"],
    ["activity.worked_on", { document: "plan.md" }, "Worked on plan.md"],
    ["activity.researched", { project: "prj_1", host: "docs.example.org" }, "Researched Heron Survey"],
    [
      "activity.researched",
      { topic: "soil moisture sensors", host: "docs.example.org" },
      "Researched soil moisture sensors",
    ],
    ["activity.messaged", { counterparty: "ent_1" }, "Messaged Blake Example"],
    ["activity.met", { counterparty: "ent_1" }, "Met Blake Example"],
  ] as const)("%s %j", (type, fields, title) => {
    expect(activityTitle(type, fields, names)).toBe(title);
  });

  it("says a block known only by its category as time on its host, never as research", () => {
    expect(activityTitle("activity.researched", { category: "communication", host: "mail.example.org" }, names)).toBe(
      "Communication on mail.example.org",
    );
    expect(activityTitle("activity.researched", { category: "other", host: "www.example.org" }, names)).toBe(
      "Browsing on www.example.org",
    );
  });

  it("never prints an id for a name it cannot read", () => {
    expect(activityTitle("activity.met", { counterparty: "ent_gone" }, names)).toBe("Met someone");
    expect(activityTitle("activity.worked_on", { project: "prj_gone" }, names)).toBe("Worked on a project");
  });
});

describe("the panel's last contact", () => {
  it("is the newest of the three, and none with none", () => {
    expect(newestContact(null, null, null)).toBeNull();
    expect(newestContact(daysAgo(3), daysAgo(1), daysAgo(2))).toBe("meeting");
    expect(newestContact(daysAgo(3), daysAgo(4), daysAgo(2))).toBe("chat");
    expect(newestContact(daysAgo(1), daysAgo(1), daysAgo(1))).toBe("message");
  });
});
