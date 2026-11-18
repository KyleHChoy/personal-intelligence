import { EntityView, type MeetingView, NextStep } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { at, belief, cite, OWNER, person } from "../test-support/card-fixtures.ts";
import { cardLines, fitCard } from "./read-card.ts";
import {
  closeTieSawNothing,
  closeTieUnread,
  nextStepOf,
  ownerStatedClose,
  personLead,
  UNANSWERED_DAYS,
} from "./read-person-lead.ts";
import { capText } from "./read-self.ts";

// What a person's page leads with, pure. Synthetic values only.

const ada = person(1);
const MESSAGE = `msg_${"1".repeat(26)}`;
const EVENT = `evt_${"2".repeat(26)}`;
const meeting = (startsAt: string): MeetingView =>
  ({
    id: EVENT,
    title: { untrusted: "Planning call" },
    startsAt,
    endsAt: startsAt,
    allDay: false,
    cancelled: false,
    participants: [],
  }) as unknown as MeetingView;
const base = {
  tier: "close",
  tie: "colleague",
  openCommitments: 2,
  lastThread: null,
  lastMeeting: null,
  current: {},
} as const;

describe("a close tie the system cannot see", () => {
  const silent = {
    commitments: [],
    nextMeeting: null,
    lastThread: { message: MESSAGE, at: "2026-08-01T00:00:00.000Z" } as never,
    lastFromThem: false,
    lastMeeting: null,
    lastTwoWayAt: null,
    now: new Date("2026-11-01T00:00:00.000Z"),
  };

  it("is no quiet reading, though what the system saw stays on it", () => {
    expect(nextStepOf({ ...silent, closeTie: true })).toMatchObject({
      kind: "channel_unseen",
      at: "2026-08-01T00:00:00.000Z",
      via: "message",
    });
  });

  it("with no contact at all still says so, where a stranger has no step", () => {
    const none = { ...silent, lastThread: null };
    expect(nextStepOf({ ...none, closeTie: true })).toEqual({ kind: "channel_unseen" });
    expect(nextStepOf(none)).toBeUndefined();
  });

  it("reads quiet once a chat is seen, or when the owner stated no tie", () => {
    expect(nextStepOf({ ...silent, closeTie: true, lastTwoWayChat: true })?.kind).toBe("quiet");
    expect(nextStepOf(silent)?.kind).toBe("quiet");
  });

  it("a tie is the owner's word: a tier the score gave says only how much was seen", () => {
    expect(ownerStatedClose({ tier: "inner", tierSource: "owner" }, undefined)).toBe(true);
    expect(ownerStatedClose({ tier: "close", tierSource: "owner" }, undefined)).toBe(true);
    expect(ownerStatedClose({ tier: "regular", tierSource: "owner" }, undefined)).toBe(false);
    expect(ownerStatedClose({ tier: "inner", tierSource: "inferred" }, undefined)).toBe(false);
    expect(ownerStatedClose({ tier: "regular", tierSource: "inferred" }, "inner")).toBe(true);
    expect(ownerStatedClose(undefined, "inner")).toBe(false);
    expect(ownerStatedClose({ tier: null, rebuilding: true }, "inner")).toBe(false);
  });
});

describe("personLead", () => {
  it("points at the newer of the last thread and the last meeting", () => {
    const thread = { message: MESSAGE, at: at(5) } as never;
    expect(personLead({ ...base, lastThread: thread, lastMeeting: meeting(at(3)) })).toMatchObject({
      lastContact: "message",
      lastThread: thread,
      lastMeeting: { meeting: EVENT, at: at(3) },
    });
    expect(personLead({ ...base, lastThread: thread, lastMeeting: meeting(at(7)) }).lastContact).toBe("meeting");
    expect(personLead({ ...base, lastMeeting: meeting(at(7)) }).lastContact).toBe("meeting");
    expect(personLead(base).lastContact).toBeNull();
  });

  it("names the current role's title and organization, and never the organization of their address", () => {
    const role = {
      title: { untrusted: "Co-founder" },
      organization: null,
      organizationName: { untrusted: "Example Labs" },
      since: at(1),
    };
    expect(personLead({ ...base, current: { role } })).toMatchObject({
      role: { untrusted: "Co-founder" },
      organization: { untrusted: "Example Labs" },
    });
    expect(personLead(base)).toMatchObject({ role: null, organization: null });
  });

  it("bounds a source's words", () => {
    const long = "x".repeat(1_000);
    const role = { title: { untrusted: long }, organization: null, organizationName: null, since: at(1) };
    expect(personLead({ ...base, current: { role } }).role).toEqual({ untrusted: capText(long) });
  });

  it("holds code's fields and pointers, with no words about what was said", () => {
    const lead = personLead({ ...base, lastThread: { message: MESSAGE, at: at(5) } as never });
    expect(Object.keys(lead)).toEqual([
      "tier",
      "tie",
      "openCommitments",
      "lastContact",
      "lastThread",
      "lastMeeting",
      "role",
      "organization",
    ]);
    expect(lead.lastThread).toEqual({ message: MESSAGE, at: at(5) });
  });
});

describe("a person's page", () => {
  const lead = personLead({ ...base, lastThread: { message: MESSAGE, at: at(5) } as never });
  const head = {
    id: ada.id,
    kind: "person",
    lead,
    names: [{ untrusted: "Ada Example" }],
    addresses: [],
    organization: null,
    people: [],
    mail: { inbound: 1, outbound: 1, firstAt: at(1), lastAt: at(5) },
    lastMeeting: null,
    nextMeeting: null,
    details: [],
    shared: false,
  } as const;
  const said = (n: number, kind: "goal" | "commitment", what: string, day: number, status = "active") =>
    belief(
      kind,
      n,
      kind === "goal" ? { domain: "career" } : { counterparty: OWNER },
      [
        cite(
          kind,
          { what: { untrusted: what }, ...(kind === "goal" ? {} : { counterparty: OWNER }) },
          {
            day,
            subject: ada,
          },
        ),
      ],
      { subject: ada, status },
    );

  it("leads with tie, tier and last contact on the wire, before its names and lines", () => {
    const { view } = fitCard(head as never, cardLines([said(1, "goal", "raise a seed round this year", 1)], false));
    const parsed = EntityView.parse(view);
    expect(Object.keys(parsed).slice(0, 3)).toEqual(["id", "kind", "lead"]);
    expect(parsed.lead).toMatchObject({ tier: "close", tie: "colleague", lastContact: "message" });
  });

  it("keeps the lead through any cut", () => {
    const beliefs = Array.from({ length: 30 }, (_, n) => said(n + 1, "goal", `raise a seed round number ${n}`, n));
    const { view } = fitCard(head as never, cardLines(beliefs, false), 600);
    expect(view.lead).toEqual(lead);
  });

  it("drops one- and two-word objects and ended commitments from the head, and keeps them reachable last", () => {
    const useful = said(1, "goal", "raise a seed round this year", 1);
    const fragment = said(2, "goal", "the Monday", 9);
    const closed = said(3, "commitment", "send the deck before the board meeting", 8, "closed");
    const { lines, more } = cardLines([fragment, closed, useful], false);
    expect(lines.map((one) => one.line.fact)).toEqual([useful.fact, fragment.fact, closed.fact]);
    expect(more).toBe(false);
    // And they are what a full card loses first.
    const many = Array.from({ length: 30 }, (_, n) => said(10 + n, "goal", `raise a seed round number ${n}`, 1));
    const full = cardLines([fragment, closed, ...many], false);
    expect(full.lines.map((one) => one.line.fact)).not.toContain(fragment.fact);
    expect(full.lines.map((one) => one.line.fact)).not.toContain(closed.fact);
    expect(full.more).toBe(true);
  });

  it("is a function of the page's own rows: a line the caller is not served moves no other", () => {
    const seen = [said(1, "goal", "raise a seed round this year", 1), said(2, "goal", "hire a first engineer soon", 2)];
    const hidden = said(3, "goal", "canary hidden line for one reader", 3);
    const without = cardLines(seen, false).lines.map((one) => one.line.fact);
    const within = cardLines([...seen, hidden], false).lines.map((one) => one.line.fact);
    expect(without).not.toContain(hidden.fact);
    expect(within).toContain(hidden.fact);
    expect(within.filter((one) => one !== hidden.fact)).toEqual(without);
  });
});

describe("nextStepOf", () => {
  const NOW = new Date(at(30));
  const none = {
    commitments: [],
    nextMeeting: null,
    lastThread: null,
    lastFromThem: false,
    lastMeeting: null,
    lastTwoWayAt: null,
    now: NOW,
  };
  const FACT_A = "a".repeat(64);
  const FACT_B = "b".repeat(64);
  const thread = { message: MESSAGE, at: at(25) } as never;
  const ahead = { meeting: EVENT, at: at(31) } as never;

  it("says nothing with no row to rest on", () => {
    expect(nextStepOf(none)).toBeUndefined();
  });

  it("a commitment the owner owes comes first, the earliest due of them, undated last", () => {
    expect(
      nextStepOf({
        ...none,
        nextMeeting: ahead,
        commitments: [
          { fact: FACT_A, direction: "owed_by_owner", due: null },
          { fact: FACT_B, direction: "owed_by_owner", due: "2026-03-01" },
        ],
      }),
    ).toEqual({ kind: "owed_by_owner", fact: FACT_B, due: "2026-03-01" });
  });

  it("then a meeting ahead, then their last message, then what they owe", () => {
    const theirs = [{ fact: FACT_A, direction: "owed_to_owner", due: null }] as const;
    const base = { ...none, commitments: theirs, lastThread: thread, lastFromThem: true };
    expect(nextStepOf({ ...base, nextMeeting: ahead })).toMatchObject({ kind: "meeting", meeting: EVENT });
    expect(nextStepOf(base)).toMatchObject({ kind: "unanswered", message: MESSAGE });
    expect(nextStepOf({ ...base, lastFromThem: false })).toEqual({ kind: "owed_to_owner", fact: FACT_A });
  });

  it("their last message is not unanswered once a meeting or a two-way chat came after it", () => {
    const base = { ...none, lastThread: thread, lastFromThem: true };
    expect(nextStepOf({ ...base, lastMeeting: { meeting: EVENT, at: at(27) } as never })?.kind).toBe("in_touch");
    expect(nextStepOf({ ...base, lastTwoWayAt: at(27) })?.kind).toBe("in_touch");
    expect(nextStepOf({ ...base, lastTwoWayAt: at(25) })?.kind).toBe("unanswered");
  });

  it("an old message is owed nothing: past the limit it is how long since the last contact", () => {
    const old = { message: MESSAGE, at: at(5) } as never;
    expect(nextStepOf({ ...none, lastThread: old, lastFromThem: true })).toEqual({
      kind: "quiet",
      at: at(5),
      days: 25,
      via: "message",
    });
    const limit = { message: MESSAGE, at: at(30 - UNANSWERED_DAYS) } as never;
    expect(nextStepOf({ ...none, lastThread: limit, lastFromThem: true })?.kind).toBe("unanswered");
  });

  it("a last contact this recent is no silence, and says which channel it was", () => {
    const old = { message: MESSAGE, at: at(5) } as never;
    expect(nextStepOf({ ...none, lastThread: old, lastTwoWayAt: at(30), lastTwoWayChat: true })).toEqual({
      kind: "in_touch",
      at: at(30),
      days: 0,
      via: "chat",
    });
    expect(nextStepOf({ ...none, lastMeeting: { meeting: EVENT, at: at(29) } as never })).toMatchObject({
      kind: "in_touch",
      via: "meeting",
    });
  });

  it("else how long since the last contact, in whole days, chat included", () => {
    expect(nextStepOf({ ...none, lastTwoWayAt: at(10), lastTwoWayChat: true })).toEqual({
      kind: "quiet",
      at: at(10),
      days: 20,
      via: "chat",
    });
    expect(nextStepOf({ ...none, lastTwoWayAt: at(10) })).toMatchObject({ via: "message" });
  });
});

describe("the last contact", () => {
  it("names a chat newer than the last thread and meeting, and when", () => {
    const thread = { message: MESSAGE, at: at(5) } as never;
    expect(personLead({ ...base, lastThread: thread, lastTwoWay: { at: at(9), chat: true } })).toMatchObject({
      lastContact: "chat",
      lastChatAt: at(9),
    });
    const after = personLead({ ...base, lastThread: thread, lastTwoWay: { at: at(5), chat: false } });
    expect(after.lastContact).toBe("message");
    expect(after.lastChatAt).toBeUndefined();
    expect(personLead({ ...base, lastThread: thread, lastTwoWay: { at: at(3), chat: true } }).lastContact).toBe(
      "message",
    );
  });
});

describe("a commitment as a next step", () => {
  const NOW = new Date("2026-11-05T00:00:00.000Z");
  const step = (commitments: Parameters<typeof nextStepOf>[0]["commitments"]) =>
    nextStepOf({
      commitments,
      nextMeeting: null,
      lastThread: null,
      lastFromThem: false,
      lastMeeting: null,
      lastTwoWayAt: "2026-11-04T00:00:00.000Z",
      lastTwoWayChat: true,
      now: NOW,
    });
  const FACT = "f".repeat(64);

  it("an undated chat remark owed to the owner is none: nothing in it is theirs to do", () => {
    expect(step([{ fact: FACT, direction: "owed_to_owner", due: null, remark: true }])?.kind).toBe("in_touch");
  });

  it("one with a date, from mail, or that the owner owes still is", () => {
    expect(step([{ fact: FACT, direction: "owed_to_owner", due: "2026-11-09", remark: false }])?.kind).toBe(
      "owed_to_owner",
    );
    expect(step([{ fact: FACT, direction: "owed_to_owner", due: null }])?.kind).toBe("owed_to_owner");
    expect(step([{ fact: FACT, direction: "owed_by_owner", due: null, remark: true }])?.kind).toBe("owed_by_owner");
  });
});

describe("a warmth line that cannot say what it saw", () => {
  const owned = { tier: "inner", tierSource: "owner" } as const;

  it("at zero with no two-way contact says nothing of a chat, built before it was bound or not", () => {
    const zero = { ...owned, warmth: 0, lastTwoWayAt: null };
    expect(ownerStatedClose(zero, undefined)).toBe(false);
    expect(closeTieUnread(zero, undefined)).toBe(true);
  });

  it("at zero, once asked, says what it holds: nothing, or a line out of date", () => {
    const zero = { ...owned, warmth: 0, lastTwoWayAt: null };
    expect(ownerStatedClose({ ...zero, chatNewer: false }, undefined)).toBe(true);
    expect(closeTieUnread({ ...zero, chatNewer: false }, undefined)).toBe(false);
    expect(ownerStatedClose({ ...zero, chatNewer: true }, undefined)).toBe(false);
    expect(closeTieUnread({ ...zero, chatNewer: true }, undefined)).toBe(true);
  });

  it("with some contact, built before a chat line, is out of date too", () => {
    const read = { ...owned, warmth: 4, lastTwoWayAt: "2026-10-01T00:00:00.000Z" };
    expect(ownerStatedClose({ ...read, chatNewer: true }, undefined)).toBe(false);
    expect(ownerStatedClose({ ...read, chatNewer: false }, undefined)).toBe(true);
  });

  it("no line for a stated close tie, asked and not out of date, is no contact", () => {
    expect(ownerStatedClose({ chatNewer: false }, "inner")).toBe(true);
    expect(closeTieSawNothing({ chatNewer: false }, "inner")).toBe(true);
    expect(ownerStatedClose({ chatNewer: true }, "inner")).toBe(false);
  });

  it("a line with real contact, only out of date, sends no one to look for another record", () => {
    const busy = { ...owned, warmth: 40, lastTwoWayAt: "2026-10-01T00:00:00.000Z", chatNewer: true };
    expect(closeTieSawNothing(busy, undefined)).toBe(false);
  });

  it("with a contact read and no chat does say so, even at zero", () => {
    const read = { ...owned, warmth: 0, lastTwoWayAt: "2026-10-01T00:00:00.000Z" };
    expect(ownerStatedClose(read, undefined)).toBe(true);
    expect(closeTieUnread(read, undefined)).toBe(false);
    expect(ownerStatedClose({ ...owned, warmth: 4, lastTwoWayAt: null }, undefined)).toBe(true);
  });

  it("built before a merge or a lift is not read", () => {
    expect(ownerStatedClose({ ...owned, stale: true }, undefined)).toBe(false);
    expect(closeTieUnread({ ...owned, stale: true }, undefined)).toBe(true);
  });

  it("is no business of a tie the owner did not state", () => {
    expect(closeTieUnread({ tier: "inner", tierSource: "inferred", warmth: 0, lastTwoWayAt: null }, undefined)).toBe(
      false,
    );
  });

  it("gives no quiet step, and a recent contact stays in touch", () => {
    const input = {
      commitments: [],
      nextMeeting: null,
      lastThread: { message: MESSAGE, at: "2026-08-01T00:00:00.000Z" } as never,
      lastFromThem: false,
      lastMeeting: null,
      lastTwoWayAt: null,
      closeTie: false,
      unread: true,
      now: new Date("2026-11-01T00:00:00.000Z"),
    };
    expect(nextStepOf(input)).toBeUndefined();
    expect(nextStepOf({ ...input, now: new Date("2026-08-05T00:00:00.000Z") })?.kind).toBe("in_touch");
  });
});

describe("the next step's wire form", () => {
  it("holds a report beside a meeting, marked", () => {
    const parsed = NextStep.parse({
      kind: "meeting",
      meeting: EVENT,
      at: at(3),
      reported: [
        {
          said: { untrusted: "The call moved." },
          record: `rec_${"1".repeat(26)}`,
          client: "scout",
          at: at(2),
          unconfirmed: true,
        },
      ],
    });
    expect(parsed.reported?.[0]?.unconfirmed).toBe(true);
  });
});
