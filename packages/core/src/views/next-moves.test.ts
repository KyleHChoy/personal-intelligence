import {
  type MeetingView,
  NEXT_MOVES_MOST,
  NextMoves,
  type OpenItem,
  type Who,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  asksForAnswer,
  composeNext,
  meetingsToShow,
  type OwedReply,
  replyAsks,
  subjectAsks,
  titleSaysMoving,
} from "./next-moves.ts";

// What next on synthetic values: what is weighed, in what order, and what stays marked.

const NOW = new Date("2026-11-12T12:00:00Z");
const owner = { id: `ent_${"0".repeat(26)}`, kind: "owner", name: null, address: null } as unknown as Who;
const other = { id: `ent_${"7".repeat(26)}`, kind: "person", name: { untrusted: "Rhea Sol" }, address: null } as Who;
const fp = (char: string): string => char.repeat(64);

const item = (id: string, over: Partial<OpenItem> = {}): OpenItem =>
  ({
    what: { untrusted: `Item ${id}` },
    due: null,
    source: { kind: "plan", id: fp(id) },
    whoActs: owner,
    project: null,
    overdue: false,
    lateDays: null,
    ...over,
  }) as OpenItem;
const late = (id: string, days: number, over: Partial<OpenItem> = {}): OpenItem =>
  item(id, { due: "2026-11-10", overdue: true, lateDays: days, ...over });
const reply = (id: string, at: string): OwedReply => ({
  message: `msg_${id.repeat(26)}`,
  who: other,
  what: { untrusted: `Subject ${id}` },
  at,
  asks: false,
  bodyRead: true,
});
const meeting = (startsAt: string, over: Partial<MeetingView> = {}): MeetingView =>
  ({
    id: `evt_${"1".repeat(26)}`,
    title: { untrusted: "Call with Rhea" },
    startsAt,
    endsAt: startsAt,
    allDay: false,
    cancelled: false,
    participants: [other],
    ...over,
  }) as MeetingView;
const compose = (over: Partial<Parameters<typeof composeNext>[0]> = {}) =>
  composeNext({
    now: NOW,
    zone: null,
    items: [],
    more: false,
    replies: [],
    meeting: null,
    findings: [],
    hours: { due: 48 },
    ...over,
  });
const kinds = (out: NextMoves): string[] => out.moves.map((one) => one.kind);

describe("what next", () => {
  it("nothing computed is nothing proposed", () => {
    expect(compose()).toEqual({ moves: [], more: false });
  });

  it("a fixed order by kind: late, due, replies, then the meeting, and no goal step", () => {
    const out = compose({
      items: [late("a", 2), item("b", { due: "2026-11-13" })],
      replies: [reply("3", "2026-11-11T09:00:00Z")],
      meeting: meeting("2026-11-13T09:00:00Z"),
    });
    expect(NextMoves.safeParse(out).success).toBe(true);
    expect(kinds(out)).toEqual(["overdue", "due_soon", "reply", "meeting"]);
    expect(out.moves.every((one) => one.step === undefined)).toBe(true);
  });

  it("a meeting further off than its window comes after the replies", () => {
    const out = compose({
      items: [late("a", 1)],
      replies: [reply("3", "2026-11-11T09:00:00Z")],
      meeting: meeting("2026-11-17T09:00:00Z"),
    });
    expect(kinds(out)).toEqual(["overdue", "reply", "meeting"]);
  });

  it("late and due take the room replies that ask nothing would hold, and more says the rest wait", () => {
    const out = compose({
      items: [
        late("a", 1),
        late("b", 2),
        late("c", 3),
        item("d", { due: "2026-11-13" }),
        item("e", { due: "2026-11-14" }),
      ],
      replies: [
        reply("3", "2026-11-12T09:00:00Z"),
        reply("4", "2026-11-11T09:00:00Z"),
        reply("5", "2026-11-10T09:00:00Z"),
      ],
    });
    expect(kinds(out)).toEqual(["overdue", "overdue", "overdue", "due_soon", "due_soon"]);
    expect(out.more).toBe(true);
  });

  it("what is least late comes first, the owner's before what others owe", () => {
    const out = compose({
      items: [late("a", 9), late("b", 1, { whoActs: other }), late("c", 2)],
    });
    expect(out.moves.map((one) => one.source.id)).toEqual([fp("c"), fp("a"), fp("b")]);
  });

  it("of replies alike, the newest comes first", () => {
    const out = compose({ replies: [reply("3", "2026-11-12T09:00:00Z"), reply("4", "2026-11-05T09:00:00Z")] });
    expect(out.moves.map((one) => one.at)).toEqual(["2026-11-12T09:00:00Z", "2026-11-05T09:00:00Z"]);
    expect(out.moves[0]?.why).toContain("today");
    expect(out.moves[1]?.why).toContain("7 days ago");
  });

  it("what is inside the window says its day, in the owner's zone, and what is past it comes after", () => {
    const out = compose({
      items: [item("a", { due: "2026-11-14" }), item("b", { due: "2026-11-15" }), item("c")],
    });
    expect(out.moves.map((one) => one.source.id)).toEqual([fp("a"), fp("b")]);
    expect(out.moves[0]?.why).toBe("Due in 2 days.");
    expect(out.moves[1]?.why).toBe("Due in 3 days.");
  });

  it("a reminder whose date has passed is not falling due, and leaves room for what is", () => {
    const out = compose({ items: [item("a", { remindAt: "2026-11-10" }), item("b", { due: "2026-11-13" })] });
    expect(out.moves.map((one) => one.source.id)).toEqual([fp("b")]);
    expect(out.more).toBe(false);
  });

  it("a meeting inside the hour says so", () => {
    const out = compose({ meeting: meeting("2026-11-12T12:20:00Z") });
    expect(out.moves[0]?.why).toBe("Your next meeting, within the hour.");
  });

  it("a person's first name counts only as written, and an organization is never split", () => {
    const finding = {
      id: `rec_${"4".repeat(26)}`,
      client: "scout",
      at: "2026-11-12T10:00:00Z",
      text: "The launch will be pushed.",
    };
    const participants = [
      { ...other, name: { untrusted: "Will Chen" } },
      { ...other, kind: "organization", name: { untrusted: "The Launch Group" } },
    ] as Who[];
    const quiet = compose({ meeting: meeting("2026-11-13T09:00:00Z", { participants }), findings: [finding] });
    expect(quiet.moves[0]?.reported).toBeUndefined();
    const named = { ...finding, text: "Will moved the call." };
    const said = compose({ meeting: meeting("2026-11-13T09:00:00Z", { participants }), findings: [named] });
    expect(said.moves[0]?.reported).toHaveLength(1);
  });

  it("a reminder with no deadline falls by its own date", () => {
    const out = compose({ items: [item("a", { remindAt: "2026-11-13" })] });
    expect(out.moves[0]).toMatchObject({ kind: "due_soon", at: "2026-11-13", why: "Reminder for tomorrow." });
  });

  it("an item an agent reported stays marked unconfirmed, and so do its reports", () => {
    const record = `rec_${"4".repeat(26)}`;
    const reported = [
      { said: { untrusted: "moved" }, record, client: "scout", at: NOW.toISOString(), unconfirmed: true },
    ];
    const out = compose({
      items: [
        late("a", 1, { source: { kind: "plan", id: fp("a"), record, agent: "scout" } } as Partial<OpenItem>),
        item("b", { due: "2026-11-13", reported } as Partial<OpenItem>),
      ],
    });
    expect(out.moves[0]).toMatchObject({ kind: "overdue", unconfirmed: true });
    expect(out.moves[0]?.why).toContain("nobody has confirmed");
    expect(out.moves[1]?.reported).toEqual(reported);
    expect(out.moves[1]?.unconfirmed).toBeUndefined();
  });

  it("a finding of a meeting's change sits beside it, marked, and moves nothing", () => {
    const finding = {
      id: `rec_${"4".repeat(26)}`,
      client: "scout",
      at: "2026-11-12T10:00:00Z",
      text: "The call with Rhea moved to Friday.",
    };
    const out = compose({ meeting: meeting("2026-11-13T09:00:00Z"), findings: [finding] });
    expect(out.moves[0]).toMatchObject({ kind: "meeting", at: "2026-11-13T09:00:00Z" });
    expect(out.moves[0]?.reported?.[0]).toMatchObject({ record: finding.id, unconfirmed: true });
    expect(out.moves[0]?.why).toContain("unconfirmed");
  });

  it("a finding about something else stays off the meeting", () => {
    const unrelated = {
      id: `rec_${"4".repeat(26)}`,
      client: "scout",
      at: "2026-11-12T10:00:00Z",
      text: "The Kiln launch moved to Friday.",
    };
    const out = compose({ meeting: meeting("2026-11-13T09:00:00Z"), findings: [unrelated] });
    expect(out.moves[0]?.reported).toBeUndefined();
  });

  it("why holds no source's words", () => {
    const out = compose({
      items: [late("a", 2, { what: { untrusted: "SECRET plan" } })],
      replies: [{ ...reply("3", "2026-11-11T09:00:00Z"), what: { untrusted: "SECRET subject" } }],
      meeting: meeting("2026-11-13T09:00:00Z", { title: { untrusted: "SECRET title" } }),
    });
    for (const one of out.moves) expect(one.why).not.toContain("SECRET");
  });

  it("an item that is the next meeting is not listed twice", () => {
    const event = `evt_${"1".repeat(26)}`;
    const out = compose({
      items: [item("a", { due: "2026-11-13", source: { kind: "calendar", id: event } as OpenItem["source"] })],
      meeting: meeting("2026-11-13T09:00:00Z"),
    });
    expect(kinds(out)).toEqual(["meeting"]);
  });

  describe("a meeting whose own title says it is moving", () => {
    it("reads pinned markers at the head of the title and nothing else", () => {
      for (const title of [
        "[rescheduling] Call: Rhea // Owner",
        "[rescheduling]Call: Rhea",
        "(Rescheduled) Call",
        "Rescheduled: Call",
        "Postponed - Call",
        "[cancelled] Call",
        "Canceled: Call",
        "Rescheduled \u2014 Call",
        "Postponed -Call",
      ])
        expect(titleSaysMoving(title), title).toBe(true);
      for (const title of [
        "Call about the rescheduled launch",
        "Moved Rhea's desk",
        "Moved-in checklist",
        "Call",
        "Reschedule policy review",
      ])
        expect(titleSaysMoving(title), title).toBe(false);
    });

    it("holds no place against a firm one: both show, the firm one first", () => {
      const start = "2026-11-12T20:00:00Z";
      const later = "2026-11-13T20:00:00Z";
      const called = meeting(start, {
        id: `evt_${"4".repeat(26)}` as never,
        title: { untrusted: "Canceled: Standup" },
      });
      const firm = meeting(later);
      expect(meetingsToShow([called, firm])).toEqual({ meeting: firm, moving: called });
      expect(meetingsToShow([firm, called])).toEqual({ meeting: firm, moving: null });
      expect(meetingsToShow([called])).toEqual({ meeting: called, moving: null });
      expect(meetingsToShow([])).toEqual({ meeting: null, moving: null });
      const out = compose({ meeting: firm, moving: called });
      expect(NextMoves.safeParse(out).success).toBe(true);
      expect(out.moves.filter((one) => one.kind === "meeting").map((one) => one.moving === true)).toEqual([
        false,
        true,
      ]);
    });

    it("says so in next, is no longer read as fixed, and keeps the calendar's time", () => {
      const start = "2026-11-12T20:00:00Z";
      const out = compose({
        items: [late("a", 1)],
        meeting: meeting(start, { title: { untrusted: "[rescheduling]Call with Rhea" } }),
      });
      expect(NextMoves.safeParse(out).success).toBe(true);
      expect(kinds(out)).toEqual(["overdue", "meeting"]);
      const move = out.moves[1];
      expect(move?.moving).toBe(true);
      expect(move?.at).toBe(start);
      expect(move?.why).toContain("title says it is being moved");
      expect(move?.why).not.toContain("Your next meeting");
    });

    it("a plain title stays as it was", () => {
      const move = compose({ meeting: meeting("2026-11-12T20:00:00Z") }).moves[0];
      expect(move?.moving).toBeUndefined();
      expect(move?.why).toContain("Your next meeting");
    });
  });

  it("a date from a person the owner never wrote to comes after a reply owed; one from anyone else stays ahead", () => {
    const stranger = item("6", { due: "2026-11-12" });
    const known = item("7", { due: "2026-11-12" });
    const out = compose({
      items: [stranger, known],
      replies: [reply("3", "2026-11-11T09:00:00Z")],
      strangers: new Set([stranger.source.id]),
    });
    expect(out.moves.map((move) => move.source.id)).toEqual([
      known.source.id,
      `msg_${"3".repeat(26)}`,
      stranger.source.id,
    ]);
  });

  describe("replies, the most worth answering first", () => {
    it("tells an ask in a body from advice, above the quote only", () => {
      expect(asksForAnswer("Please let me know if any of these times will work:\n- the 3rd\n- the 4th")).toBe(true);
      expect(asksForAnswer("May we move this to next week? Sorry for the change.")).toBe(true);
      expect(asksForAnswer("Could you send the draft by Friday.")).toBe(true);
      expect(
        asksForAnswer("Thanks. Worth planning a spare for the final.\n\nOn Mon, Rhea wrote:\n> Can you check?"),
      ).toBe(false);
      expect(asksForAnswer("Good work.\n> Are you free?")).toBe(false);
      expect(asksForAnswer("Let me know if you need anything!")).toBe(false);
      expect(asksForAnswer("Let me know if you\u2019d like anything else.")).toBe(false);
      expect(asksForAnswer("Let me know if you have time on Thursday.")).toBe(true);
      expect(asksForAnswer("Let me know if there is a slot next week.")).toBe(true);
      expect(asksForAnswer("All set.\n\nFrom: Owner\nSent: Monday\n\nCan you confirm Friday?")).toBe(false);
      expect(asksForAnswer("Read https://example.com/a?b=1 when you can.")).toBe(false);
    });

    it("tells an ask in a subject", () => {
      expect(subjectAsks("Re: Are you around Friday?")).toBe(true);
      expect(subjectAsks("Quick question on the lease")).toBe(true);
      expect(subjectAsks("Re: Panel Questions")).toBe(false);
      expect(subjectAsks("Weekly update")).toBe(false);
    });

    it("a body that was read decides, whatever the thread's subject asked", () => {
      expect(replyAsks("Re: Are you around Friday?", "Great, see you then.")).toBe(false);
      expect(replyAsks("Weekly note", "Could you send the deck?")).toBe(true);
      expect(replyAsks("Re: Are you around Friday?", undefined)).toBe(true);
      expect(replyAsks("Weekly note", undefined)).toBe(false);
      expect(replyAsks(undefined, undefined)).toBe(false);
    });

    it("a reply a task looked at stays, says so, points at the task, and ranks below one no task looked at", () => {
      const task = `opp_${"3".repeat(26)}` as never;
      const looked = { ...reply("4", "2026-11-12T09:00:00Z"), asks: true, task };
      const plain = reply("3", "2026-11-05T09:00:00Z");
      const out = compose({ replies: [looked, plain] });
      expect(NextMoves.safeParse(out).success).toBe(true);
      expect(out.moves.map((one) => one.source.id)).toEqual([plain.message, looked.message]);
      expect(out.moves[1]?.task).toBe(task);
      expect(out.moves[1]?.why).toContain("list_opportunities, scope closed");
      expect(out.moves[0]?.task).toBeUndefined();
    });

    it("what asks comes first, then the newest, and the why says which it is", () => {
      const asked = { ...reply("4", "2026-11-12T09:00:00Z"), asks: true, bodyRead: true };
      const older = { ...reply("3", "2026-11-05T09:00:00Z"), asks: false, bodyRead: true };
      const newer = { ...reply("5", "2026-11-11T09:00:00Z"), asks: false, bodyRead: true };
      const out = compose({ replies: [older, newer, asked] });
      expect(out.moves.map((one) => one.source.id)).toEqual([asked.message, newer.message]);
      expect(out.more).toBe(true);
      expect(out.moves[0]?.asks).toBe(true);
      expect(out.moves[0]?.why).toContain("asks for an answer");
      expect(out.moves[1]?.asks).toBeUndefined();
      expect(out.moves[1]?.why).toContain("Nothing in it asks");
    });

    it("a body not read is said to be unread, and never reads as asking nothing", () => {
      const out = compose({ replies: [{ ...reply("4", "2026-11-12T09:00:00Z"), asks: false, bodyRead: false }] });
      expect(out.moves[0]?.why).toContain("read only its subject");
    });

    it("every why fits the contract", () => {
      const out = compose({
        replies: [{ ...reply("4", "2026-10-12T09:00:00Z"), asks: false, bodyRead: false }],
        meeting: meeting("2026-11-18T20:00:00Z", { title: { untrusted: "[moved] Call" } }),
      });
      expect(NextMoves.safeParse(out).success).toBe(true);
    });
  });

  describe("room goes by what is there", () => {
    const asking = (id: string, at: string): OwedReply => ({ ...reply(id, at), asks: true });
    const dueOn = (id: string, due: string): OpenItem => item(id, { due });
    const ofKind = (next: NextMoves, kind: string) => next.moves.filter((one) => one.kind === kind);

    it("a reply that asks nothing gives its place to a due item past the window", () => {
      const next = compose({
        replies: [asking("A", "2026-11-12T10:00:00Z"), reply("B", "2026-11-12T11:00:00Z")],
        items: [
          dueOn("1", "2026-11-13"),
          dueOn("2", "2026-11-16"),
          dueOn("3", "2026-11-17"),
          dueOn("4", "2026-11-18"),
          dueOn("5", "2026-11-19"),
        ],
      });
      expect(ofKind(next, "due_soon").map((one) => one.at)).toEqual([
        "2026-11-13",
        "2026-11-16",
        "2026-11-17",
        "2026-11-18",
      ]);
      expect(ofKind(next, "reply").map((one) => one.source.id)).toEqual([`msg_${"A".repeat(26)}`]);
      expect(next.more).toBe(true);
    });

    it("with nothing else to fill it, a reply that asks nothing keeps its place and says so", () => {
      const next = compose({ replies: [reply("B", "2026-11-12T11:00:00Z")], items: [dueOn("1", "2026-11-13")] });
      expect(ofKind(next, "reply")[0]?.why).toContain("Nothing in it asks");
      expect(next.more).toBe(false);
    });

    it("what is due past a week does not come in, and none of it sets more", () => {
      const next = compose({ items: [dueOn("1", "2026-12-20")] });
      expect(ofKind(next, "due_soon")).toEqual([]);
      expect(next.more).toBe(false);
    });

    it("what asks keeps its two places against any number of items, and the moves stay within the most", () => {
      const next = compose({
        replies: [
          asking("A", "2026-11-12T10:00:00Z"),
          asking("B", "2026-11-12T09:00:00Z"),
          asking("C", "2026-11-12T08:00:00Z"),
        ],
        items: Array.from({ length: 8 }, (_, n) => late(String(n + 1), n + 1)),
      });
      expect(ofKind(next, "reply")).toHaveLength(2);
      expect(ofKind(next, "overdue")).toHaveLength(3);
      expect(next.more).toBe(true);
      expect(next.moves.length).toBeLessThanOrEqual(NEXT_MOVES_MOST);
    });

    it("a late item takes room before what is merely coming", () => {
      const next = compose({
        items: [
          ...Array.from({ length: 4 }, (_, n) => late(String(n + 1), n + 1)),
          dueOn("5", "2026-11-13"),
          dueOn("6", "2026-11-16"),
        ],
      });
      expect(ofKind(next, "overdue")).toHaveLength(4);
      expect(ofKind(next, "due_soon")).toHaveLength(1);
    });
  });

  describe("a recurring slot", () => {
    const slot = meeting("2026-11-13T12:00:00Z", {
      id: `evt_${"2".repeat(26)}` as MeetingView["id"],
      title: { untrusted: "The Weekly Hour" },
    });
    const oneOff = meeting("2026-11-15T12:00:00Z");

    it("a one-off meeting is the next meeting, past a recurring slot ahead of it", () => {
      const isSlot = (one: MeetingView) => one.id === slot.id;
      expect(meetingsToShow([slot, oneOff], isSlot)).toEqual({ meeting: oneOff, moving: null, slot });
      const next = compose({ meeting: oneOff, slot });
      const move = next.moves.find((one) => one.kind === "meeting");
      expect(move?.why).toContain("Your next one-off meeting");
      expect(next.moves.filter((one) => one.kind === "meeting")).toHaveLength(1);
      // The slot is not silently gone: more says so, and moves shows it, and then more clears.
      expect(next.more).toBe(true);
      const whole = compose({ meeting: oneOff, slot, whole: true });
      expect(whole.moves.filter((one) => one.kind === "meeting").map((one) => one.recurring)).toEqual([
        undefined,
        true,
      ]);
      expect(whole.more).toBe(false);
    });

    it("with no one-off, the slot shows and does not read as your next meeting, nor lead", () => {
      const isSlot = (one: MeetingView) => one.id === slot.id;
      expect(meetingsToShow([slot], isSlot)).toEqual({ meeting: slot, moving: null });
      const next = compose({ meeting: slot, recurring: true, replies: [reply("A", "2026-11-12T10:00:00Z")] });
      const move = next.moves.find((one) => one.kind === "meeting");
      expect(move?.recurring).toBe(true);
      expect(move?.why).toContain("recurring");
      expect(move?.why).not.toContain("Your next meeting");
      expect(next.moves[0]?.kind).toBe("reply");
    });

    it("a moving meeting ahead of a slot still shows, and of two firm meetings the first one-off is the next", () => {
      const moving = meeting("2026-11-12T20:00:00Z", {
        id: `evt_${"3".repeat(26)}` as MeetingView["id"],
        title: { untrusted: "[rescheduling] Call" },
      });
      const isSlot = (one: MeetingView) => one.id === slot.id;
      expect(meetingsToShow([moving, slot], isSlot)).toEqual({ meeting: slot, moving });
      expect(meetingsToShow([moving, slot, oneOff], isSlot)).toEqual({ meeting: oneOff, moving, slot });
    });
  });

  describe("every move, when more says there are more", () => {
    it("room for each kind and more false, in the same order", () => {
      const replies = ["1", "3", "4", "5"].map((id, index) => reply(id, `2026-11-1${index}T09:00:00Z`));
      const items = [late("a", 1), late("b", 2), late("c", 3)];
      const out = compose({ items, replies, whole: true });
      expect(NextMoves.safeParse(out).success).toBe(true);
      expect(kinds(out)).toEqual(["overdue", "overdue", "overdue", "reply", "reply", "reply", "reply"]);
      expect(out.more).toBe(false);
      expect(compose({ items, replies }).more).toBe(true);
    });

    it("still says more when the read ran out", () => {
      expect(compose({ more: true, whole: true }).more).toBe(true);
    });
  });
});
