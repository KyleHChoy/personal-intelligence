import { KEY_FIELDS } from "@intelligence/contracts/personal";
import type { ModelClient } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { MEETING_TYPES } from "../lane-versions.ts";
import { textValuesOf, untied } from "../meeting-check.ts";
import { citedPassage, claimSpeaker, planMeeting, TURN_RUN } from "../meeting-plan.ts";
import { meetingPrompt, meetingPromptAt } from "../prompts.ts";
import { type MeetingPassage, meetingPassages } from "../turns.ts";
import {
  creditOf,
  EVAL_MEETING_OWNER_ENTITY,
  evaluateMeetings,
  evaluateMeetingsPooled,
  type MeetingEvalReport,
  openEvalMeeting,
  poolMeetingReports,
} from "./eval-meetings.ts";
import {
  callStatsByRun,
  meetingDetailLines,
  meetingReportLines,
  pooledMeetingReportLines,
} from "./eval-meetings-report.ts";
import {
  DECK_LINE,
  EVAL_MEETING_OWNER,
  EVAL_MEETING_OWNER_NAME,
  EVAL_MEETINGS,
  type EvalMeeting,
  type EvalMeetingFact,
  type EvalStated,
  FRIDAY,
  saidOf,
} from "./eval-meetings-set.ts";
import { EVAL_EXTRAS_PER_ITEM, EVAL_RECALL } from "./eval-rule.ts";

// The meeting evaluation, on the fake model only.

const START = "2026-03-02T15:00:00.000Z";
// A speaker by its label: the one with the person's address, or the one whose name the meeting
// binds to the person.
const labelOf = (meeting: EvalMeeting, address: string): string =>
  meeting.item.speakers.find(
    (one) =>
      one.mention?.address === address ||
      (one.mention?.name !== undefined && meeting.bound?.[one.mention.name] === address),
  )?.label ?? "S9";
const speaker = (meeting: EvalMeeting, address: string) => ({
  key: { kind: "source_id", value: `speaker:${labelOf(meeting, address)}` },
  observedAt: START,
});

// The passages the lane lists: the repaired turns.
const passagesOf = (meeting: EvalMeeting): MeetingPassage[] => planMeeting(openEvalMeeting(meeting)).passages;

// The span a model cites for a fact's words: the one passage that holds them, or else the
// shortest run that does, within the turns' run bounds.
function spanFor(meeting: EvalMeeting, said: string): string {
  const passages = passagesOf(meeting);
  const one = passages.find((passage) => passage.text.includes(said));
  if (one !== undefined) return one.span;
  for (let length = 2; length <= TURN_RUN.passages; length += 1) {
    for (let first = 0; first + length <= passages.length; first += 1) {
      const span = `${passages[first]?.span}..${passages[first + length - 1]?.span}`;
      if (citedPassage(span, passages, true, TURN_RUN)?.text.includes(said)) return span;
    }
  }
  return "seg:0-1";
}

// The fields a model gives a fact, its people by speaker label.
function fieldsFor(meeting: EvalMeeting, fact: EvalMeetingFact): Record<string, unknown> {
  switch (fact.type) {
    case "commitment":
    case "plan":
      return {
        counterparty: speaker(meeting, fact.counterparty),
        what: fact.what,
        ...(fact.due === undefined ? {} : { due: fact.due }),
        ...(fact.when === undefined ? {} : { when: fact.when }),
      };
    case "role":
      return {
        title: fact.title,
        ...(fact.organization === undefined ? {} : { organization_name: fact.organization }),
      };
    case "affiliation":
      return { relation: fact.relation, organization_name: fact.organization };
    case "relationship":
      return { counterparty: speaker(meeting, fact.counterparty), relation: fact.relation };
    default:
      return {
        [KEY_FIELDS[fact.type].phrase]: fact.phrase,
        domain: fact.domain,
        ...(fact.polarity === undefined ? {} : { polarity: fact.polarity }),
      };
  }
}

// What a model that finds a fact answers for it: the span of the passages that say it, and
// explicit_self when their speaker is its subject.
function claimFor(meeting: EvalMeeting, fact: EvalMeetingFact, over: Partial<EvalStated> = {}) {
  const given = { ...fact, ...over } as EvalMeetingFact;
  const span = spanFor(meeting, saidOf(fact));
  const cited = citedPassage(span, passagesOf(meeting), true, TURN_RUN);
  const own =
    cited !== undefined &&
    claimSpeaker(cited, [saidOf(fact)]) === speaker(meeting, given.subject).key.value.slice("speaker:".length);
  return {
    type: given.type,
    subject: speaker(meeting, given.subject),
    fields: fieldsFor(meeting, given),
    statementKind: "stated_fact",
    basis: own ? "explicit_self" : "third_party",
    span,
  };
}

// A fake model's outputs: each meeting's expected facts but those `drop` leaves out, with `extra`
// claims added, by meeting id.
// A meeting asked in several windows is answered window by window, each fact in the
// first window that lists its span, by `<evidence id>/<input hash>`; a meeting of one window by its
// evidence id, so a test can answer it otherwise.
function outputs(
  set: readonly EvalMeeting[],
  options: { drop?: (fact: EvalMeetingFact) => boolean; extra?: Record<string, unknown[]> } = {},
): Record<string, unknown> {
  return Object.fromEntries(
    set.flatMap((meeting) => {
      const opened = openEvalMeeting(meeting);
      const claims = [
        ...meeting.expected.filter((fact) => options.drop?.(fact) !== true).map((fact) => claimFor(meeting, fact)),
        ...((options.extra?.[meeting.id] ?? []) as { span: string }[]),
      ];
      const { groups } = planMeeting(opened);
      if (groups.length === 1) return [[opened.context.evidenceId, { claims, narrowing: "none" }]];
      const firstIn = (claim: { span: string }) =>
        groups.findIndex((group) => group.passages.some((one) => one.span === claim.span.split("..")[0]));
      return groups.map((group, n) => [
        `${opened.context.evidenceId}/${group.inputHash}`,
        { claims: claims.filter((claim) => firstIn(claim) === n), narrowing: "none" },
      ]);
    }),
  );
}

const run = (
  given: Record<string, unknown>,
  calls: string[] = [],
  set: readonly EvalMeeting[] = EVAL_MEETINGS,
): Promise<MeetingEvalReport> => evaluateMeetings({ model: fakeModelClient(given, calls) }, set);
const runSet = (
  set: readonly EvalMeeting[],
  given: Record<string, unknown> = outputs(set),
): Promise<MeetingEvalReport> => run(given, [], set);
const deckMeeting = EVAL_MEETINGS.find((meeting) =>
  meeting.item.segments.some((one) => one.text === DECK_LINE),
) as EvalMeeting;

describe("the evaluation meetings", () => {
  it("hold at least ten commitments and at least ten meetings with none, on reserved domains, each fact's statement a segment of its meeting, S2's deck line among them", () => {
    const facts = EVAL_MEETINGS.flatMap((meeting) => meeting.expected);
    expect(facts.filter((fact) => fact.type === "commitment").length).toBeGreaterThanOrEqual(10);
    expect(EVAL_MEETINGS.filter((meeting) => meeting.expected.length === 0).length).toBeGreaterThanOrEqual(10);
    expect(new Set(EVAL_MEETINGS.map((meeting) => meeting.id)).size).toBe(EVAL_MEETINGS.length);
    for (const meeting of EVAL_MEETINGS) {
      // A fact's words in one segment, or in one run of a room.
      for (const fact of meeting.expected) {
        const span = spanFor(meeting, saidOf(fact));
        expect(span, saidOf(fact)).not.toBe("seg:0-1");
        if (span.includes(".."))
          expect(
            meeting.item.mode === "room" || planMeeting(openEvalMeeting(meeting)).labels?.reliable === false,
            saidOf(fact),
          ).toBe(true);
      }
      for (const one of meeting.item.speakers)
        if (one.mention?.address !== undefined) expect(one.mention.address).toMatch(/[.@]example(\.org)?$/);
    }
    expect(EVAL_MEETING_OWNER).toMatch(/\.example$/);
    expect(deckMeeting.expected).toEqual([
      expect.objectContaining({ type: "commitment", counterparty: EVAL_MEETING_OWNER, what: DECK_LINE }),
    ]);
    expect(deckMeeting.item.segments.find((one) => one.text === DECK_LINE)?.speaker).toBe("S2");
    expect([EVAL_RECALL, EVAL_EXTRAS_PER_ITEM]).toEqual([0.8, 0.2]);
  });

  // A promise the set leaves out is an extra whenever a model finds it, and the fact key holds no
  // text, so every line that promises something is expected. Two lines say "I will" of no promise.
  it('expect every line that promises something: each "I will" line is an expected commitment\'s but two', () => {
    // A promise cut across a room's passages is its commitment's too, and a promise among the
    // meeting's allowed facts counts as expected.
    const unexpected = EVAL_MEETINGS.flatMap((meeting) =>
      meeting.item.segments
        .filter(
          (one) =>
            /\bI will\b/.test(one.text) &&
            ![...meeting.expected, ...(meeting.allowed ?? [])].some(
              (fact) => fact.type === "commitment" && (one.text.includes(fact.what) || fact.what.includes(one.text)),
            ),
        )
        .map((one) => one.text),
    );
    expect(unexpected).toEqual([
      "No need to rush it back, I will not need it again until the following week.",
      "I will need a few weeks before I can keep up with any of you, I suspect.",
    ]);
  });

  // The lines of 07, 09 and 10 that a model read two ways, each reworded to say one thing.
  const named = (id: string) => EVAL_MEETINGS.find((meeting) => meeting.id === id) as EvalMeeting;
  const other = (meeting: EvalMeeting) => meeting.item.speakers.find((one) => !one.owner)?.mention?.address ?? "";
  const lineOf = (meeting: EvalMeeting, fact: EvalMeetingFact | undefined) =>
    meeting.item.segments.find((one) => fact !== undefined && one.text.includes(saidOf(fact)));
  const DAY =
    /\b(today|tonight|tomorrow|week|weekend|morning|afternoon|evening|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|\d+)\b/i;

  it("07: the hedge is due by the date its line names, a Thursday from the Monday start", () => {
    const garden = named("meeting-07");
    const hedge = {
      type: "commitment",
      subject: other(garden),
      counterparty: EVAL_MEETING_OWNER,
      what: "I will prune the hedge by Thursday, March 5, 2026.",
      due: "2026-03-05",
    } as const;
    expect(garden.expected).toContainEqual(hedge);
    expect(new Date(`${hedge.due}T00:00:00Z`).getUTCDay()).toBe(4);
    expect(lineOf(garden, hedge)?.speaker).toBe("S2");
  });

  it("a plan's day is named in its proposer's line alone, the other speaker does not confirm it, and the meeting's promises are undated and name no day", () => {
    const plans = EVAL_MEETINGS.filter((meeting) => meeting.expected.some((fact) => fact.type === "plan"));
    expect(plans.map((meeting) => meeting.id)).toEqual(expect.arrayContaining(["meeting-09", "meeting-10"]));
    for (const meeting of plans) {
      const plan = meeting.expected.find((fact) => fact.type === "plan") as EvalStated;
      const proposer = meeting.item.speakers.find((one) => one.mention?.address === plan.subject)?.label;
      const day = new Date(`${plan.when}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
      expect(
        meeting.item.segments.filter((one) => one.text.includes(day)).map((one) => [one.speaker, one.text]),
      ).toEqual([[proposer, plan.what]]);
      // The plan type's subject is "who proposed or confirmed it": the other speaker's replies hold no assent.
      const after = meeting.item.segments.slice(meeting.item.segments.findIndex((one) => one.text === plan.what) + 1);
      const replies = after.filter((one) => one.speaker !== proposer).map((one) => one.text);
      expect(
        replies.filter((text) =>
          /\b(yes|great|good|perfect|wonderful|lovely|agreed|deal|suits|that date|sounds|see you|works for me)\b/i.test(
            text,
          ),
        ),
        meeting.id,
      ).toEqual([]);
      for (const fact of meeting.expected.filter((one): one is EvalStated => one.type === "commitment")) {
        expect(fact.due, fact.what).toBeUndefined();
        expect(fact.what).not.toMatch(DAY);
      }
    }
    // 09: the owner's plan is with Nina alone, not Nina's club, and Nina's promise is owed to the owner.
    const running = named("meeting-09");
    expect(running.expected).toEqual([
      {
        type: "plan",
        subject: EVAL_MEETING_OWNER,
        counterparty: other(running),
        what: "Nina, let's meet at the park gate on March 12, 2026, just the two of us, for my first run.",
        when: "2026-03-12",
      },
      {
        type: "commitment",
        subject: other(running),
        counterparty: EVAL_MEETING_OWNER,
        what: "I will send you the link to the club's group chat.",
      },
    ]);
    // 10: Omar's plan, and the owner's promise hangs on no day.
    const lunch = named("meeting-10");
    expect(lunch.expected).toEqual([
      {
        type: "plan",
        subject: other(lunch),
        counterparty: EVAL_MEETING_OWNER,
        what: "Let's have lunch at the harbour cafe on March 18, 2026 and go through them.",
        when: "2026-03-18",
      },
      {
        type: "commitment",
        subject: EVAL_MEETING_OWNER,
        counterparty: other(lunch),
        what: "I will send you the new contract drafts as soon as our lawyer signs them off.",
      },
    ]);
    expect(lineOf(lunch, lunch.expected[1])?.speaker).toBe("S1");
  });

  it("date the deck line's Friday as the meeting prompt's example does, from the same Monday", () => {
    expect((deckMeeting.expected[0] as EvalStated).due).toBe(FRIDAY);
    expect(FRIDAY).toBe("2026-03-06");
    const example = meetingPrompt().instructions;
    // Version 3's example promise, restated, on the same Friday.
    expect(example).toContain(`"what":"I will send you my notes by Friday.","due":"${FRIDAY}"`);
    expect(example).toContain(`"observedAt":"${START.slice(0, 10)}`);
    expect(new Date(START).getUTCDay()).toBe(1);
  });
});

describe("evaluateMeetings", () => {
  it("on the fake model answering the expected facts the check passes, with one call for each meeting", async () => {
    const calls: string[] = [];
    const report = await run(outputs(EVAL_MEETINGS), calls);
    expect(report).toMatchObject({ passed: true, failed: [], extras: 0, deck: true });
    expect(report.types.find((one) => one.type === "commitment")).toMatchObject({
      gated: true,
      passed: true,
      extra: 0,
    });
    // One call for each window of each meeting.
    expect(calls).toHaveLength(
      EVAL_MEETINGS.reduce((sum, meeting) => sum + planMeeting(openEvalMeeting(meeting)).groups.length, 0),
    );
    expect(report.windows).toBeGreaterThan(1);
  });

  it("with too many commitments missing it fails, and the meetings that lost them are named", async () => {
    const report = await run(
      outputs(EVAL_MEETINGS, { drop: (fact) => fact.type === "commitment" && fact.subject !== EVAL_MEETING_OWNER }),
    );
    expect(report.passed).toBe(false);
    expect(report.failed).toContain(deckMeeting.id);
    // With one missing, recall still holds the line: the positive control.
    const one = EVAL_MEETINGS.find(
      (meeting) => meeting.id !== deckMeeting.id && meeting.expected.length > 0,
    ) as EvalMeeting;
    const nearly = await run(outputs(EVAL_MEETINGS, { drop: (fact) => fact === one.expected[0] }));
    expect(nearly).toMatchObject({ passed: true, failed: [one.id] });
  });

  it("S2's deck line yields a commitment owed to the owner by S2's mention, never one by the owner", async () => {
    const fact = deckMeeting.expected[0] as EvalStated;
    // The owner's commitment on S2's line: refused, and the deck line is not found.
    const owners = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(deckMeeting).context.evidenceId]: {
        claims: [claimFor(deckMeeting, fact, { subject: EVAL_MEETING_OWNER, counterparty: fact.subject })],
        narrowing: "none",
      },
    });
    expect(owners).toMatchObject({ deck: false, passed: false });
    const right = await run(outputs(EVAL_MEETINGS));
    expect(right.deck).toBe(true);
  });

  // The due day is reported as agreement and its other fact key as key drift; the
  // fact itself is found by its words.
  it("a deck line found with no due date, against the Friday the line names, is found by its words, its due day a disagreement and its key drift", async () => {
    const fact = deckMeeting.expected[0] as EvalStated;
    const { due: _friday, ...undated } = fact;
    const right = await run(outputs(EVAL_MEETINGS));
    const report = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(deckMeeting).context.evidenceId]: {
        claims: [claimFor(deckMeeting, undated)],
        narrowing: "none",
      },
    });
    expect(report).toMatchObject({ extras: 0, deck: true });
    expect(report.types.find((one) => one.type === "commitment")?.found).toBe(
      right.types.find((one) => one.type === "commitment")?.found,
    );
    expect(report.agreement.duesAgree).toBe(right.agreement.duesAgree - 1);
    expect(report.agreement.keyDrift).toBe(right.agreement.keyDrift + 1);
    // Another person's promise on the line is no match: a miss and an extra.
    const swapped = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(deckMeeting).context.evidenceId]: {
        claims: [claimFor(deckMeeting, fact, { subject: EVAL_MEETING_OWNER, counterparty: fact.subject })],
        narrowing: "none",
      },
    });
    expect(swapped).toMatchObject({ failed: expect.arrayContaining([deckMeeting.id]), extras: 1 });
  });

  it("extras over the allowance fail it; a withheld meeting is failed", async () => {
    // A meeting with no fact whose owner the lane knows, so a claim of the owner's is found: one more than
    // the allowance.
    const allowed = Math.floor(EVAL_MEETINGS.length * EVAL_EXTRAS_PER_ITEM);
    // One claim on each of the first two passages of each such meeting, as many as it takes.
    const extra = EVAL_MEETINGS.filter(
      (meeting) => meeting.expected.length === 0 && meeting.item.speakers.some((one) => one.owner),
    )
      .flatMap((meeting) =>
        passagesOf(meeting)
          .slice(0, 2)
          .map((passage) => ({ meeting, passage })),
      )
      .slice(0, allowed + 1);
    expect(extra).toHaveLength(allowed + 1);
    const claimsOf = (some: typeof extra): Record<string, unknown[]> => {
      const by: Record<string, unknown[]> = {};
      for (const { meeting, passage } of some)
        (by[meeting.id] ??= []).push({
          type: "commitment",
          subject: speaker(meeting, EVAL_MEETING_OWNER),
          fields: {
            counterparty: speaker(meeting, meeting.item.speakers[1]?.mention?.address ?? ""),
            what: passage.text,
          },
          statementKind: "stated_fact",
          basis: "third_party",
          span: passage.span,
        });
      return by;
    };
    const over = await run(outputs(EVAL_MEETINGS, { extra: claimsOf(extra) }));
    expect(over).toMatchObject({ extras: allowed + 1, extrasAllowed: allowed, passed: false });
    // The positive control: at the allowance it passes.
    const at = await run(outputs(EVAL_MEETINGS, { extra: claimsOf(extra.slice(0, allowed)) }));
    expect(at).toMatchObject({ extras: allowed, passed: true });
    const withheld = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(deckMeeting).context.evidenceId]: { claims: [], narrowing: "quarantine" },
    });
    expect(withheld.failed).toContain(deckMeeting.id);
  });

  it("--detail: each meeting's counts, its missed and extra facts by role and due day, its calls' latency and cost, then the totals", async () => {
    const fact = deckMeeting.expected[0] as EvalStated;
    // The owner's promise on S2's line: a miss and an extra.
    const report = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(deckMeeting).context.evidenceId]: {
        claims: [claimFor(deckMeeting, fact, { subject: EVAL_MEETING_OWNER, counterparty: fact.subject })],
        narrowing: "none",
      },
    });
    expect(report.detail).toHaveLength(EVAL_MEETINGS.length);
    expect(report.detail.find((one) => one.id === deckMeeting.id)).toMatchObject({
      expected: 1,
      matched: 0,
      answered: true,
      missed: [{ type: "commitment", subject: "other", counterparty: "owner", due: FRIDAY, when: null }],
      extra: [{ type: "commitment", subject: "owner", counterparty: "other", due: FRIDAY, when: null }],
    });
    const deckId = openEvalMeeting(deckMeeting).context.evidenceId;
    const lines = meetingDetailLines(report, new Map([[deckId, { ms: 1234, microUsd: 700 }]]), 5000);
    expect(lines).toContain(
      `${deckMeeting.id}: expected 1 matched 0 missed commitment/other>owner/due=${FRIDAY} extra commitment/owner>other/due=${FRIDAY} ms 1234 micro_usd 700`,
    );
    expect(lines.at(-1)).toBe("total: wall_ms 5000 micro_usd 700");
    // A plan's day is printed as its `when`.
    const planned = EVAL_MEETINGS.find((meeting) => meeting.expected.some((one) => one.type === "plan")) as EvalMeeting;
    const plan = planned.expected.find((one) => one.type === "plan") as EvalStated;
    const missedPlan = await run(outputs(EVAL_MEETINGS, { drop: (one) => one === plan }));
    expect(meetingDetailLines(missedPlan, new Map(), 0).find((line) => line.startsWith(`${planned.id}:`))).toContain(
      `missed plan/owner>other/due=none/when=${plan.when}`,
    );
    // A meeting with no call measured shows zeros.
    expect(lines.find((line) => line.startsWith(`${EVAL_MEETINGS[1]?.id}:`))).toMatch(
      /matched 2 missed none extra none ms 0 micro_usd 0$/,
    );
    // Under each meeting, its drops, each proposal with its outcome, and the words
    // of each fact missed and each extra, from the synthetic set alone.
    const deckAt = lines.findIndex((line) => line.startsWith(`${deckMeeting.id}:`));
    expect(lines[deckAt + 1]).toBe("  drops: candidates 1 kept 1");
    expect(lines[deckAt + 2]).toMatch(
      /^ {2}proposed: "commitment" "speaker:S1" "I will send the deck by Friday\." "" "seg:\d+-\d+" -> /,
    );
    expect(lines).toContain(`  missed: commitment "${DECK_LINE}"`);
    expect(lines).toContain(`  extra: commitment ${JSON.stringify(DECK_LINE)} ""`);
  });

  it("prints counts and codes and no text", async () => {
    const lines = meetingReportLines(await run(outputs(EVAL_MEETINGS)));
    expect(lines.at(-1)).toBe("result: ok");
    expect(lines).toContain("deck: ok");
    const text = lines.join("\n");
    for (const meeting of EVAL_MEETINGS) {
      expect(text).not.toContain(meeting.item.title ?? "");
      for (const one of meeting.item.segments) expect(text).not.toContain(one.text);
      for (const one of meeting.item.speakers) expect(text).not.toContain(one.mention?.address ?? "@@");
    }
  });
});

describe("the meeting evaluation's new cases", () => {
  const facts = EVAL_MEETINGS.flatMap((meeting) => meeting.expected.map((fact) => ({ meeting, fact })));
  const NEW_TYPES = MEETING_TYPES.filter((type) => type !== "commitment" && type !== "plan");

  it("every new type has at least ten expected facts, so each is gated; the set holds rooms, unnamed speakers and facts that need a run", () => {
    for (const type of NEW_TYPES)
      expect(facts.filter(({ fact }) => fact.type === type).length, type).toBeGreaterThanOrEqual(10);
    expect(facts.filter(({ fact }) => fact.type === "commitment").length).toBeGreaterThanOrEqual(10);
    const rooms = EVAL_MEETINGS.filter((meeting) => meeting.item.mode === "room");
    expect(rooms.length).toBeGreaterThanOrEqual(8);
    // Meetings no speaker of which is known, and a room with one speaker nobody named.
    expect(
      EVAL_MEETINGS.filter((meeting) => meeting.item.speakers.every((one) => !one.owner && one.mention === undefined))
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      rooms.some(
        (meeting) =>
          meeting.item.speakers.some((one) => !one.owner && one.mention === undefined) && meeting.expected.length > 0,
      ),
    ).toBe(true);
    // Facts whose words a diarizer cut across segments, some across two speakers' labels: at least
    // ten. The repaired turns hold most of them whole, so few still need a run.
    const cut = facts.filter(
      ({ meeting, fact }) => !meetingPassages(meeting.item).passages.some((one) => one.text.includes(saidOf(fact))),
    );
    expect(cut.length).toBeGreaterThanOrEqual(10);
    const mixed = cut.filter(
      ({ meeting, fact }) =>
        new Set(
          citedPassage(spanFor(meeting, saidOf(fact)), passagesOf(meeting), true, TURN_RUN)?.parts.map(
            (one) => one.speaker,
          ),
        ).size > 1,
    );
    expect(mixed.length).toBeGreaterThanOrEqual(3);
    expect(cut.filter(({ meeting, fact }) => !spanFor(meeting, saidOf(fact)).includes("..")).length).toBeGreaterThan(
      cut.length / 2,
    );
  });

  it("no fact is about a speaker nobody named: every subject and counterparty is the owner or a named speaker of its meeting", () => {
    for (const { meeting, fact } of facts) {
      const known = new Set([
        EVAL_MEETING_OWNER,
        ...meeting.item.speakers.flatMap((one) => (one.mention?.address === undefined ? [] : [one.mention.address])),
        ...Object.values(meeting.bound ?? {}),
      ]);
      expect(known.has(fact.subject), `${meeting.id} ${saidOf(fact)}`).toBe(true);
      if ("counterparty" in fact) expect(known.has(fact.counterparty), `${meeting.id} ${saidOf(fact)}`).toBe(true);
    }
  });

  it("on the fake model answering every expected fact, every type is found whole, every run is found, and the drop counts are candidates and kept alone", async () => {
    const report = await run(outputs(EVAL_MEETINGS));
    expect(report.passed).toBe(true);
    for (const type of NEW_TYPES)
      expect(
        report.types.find((one) => one.type === type),
        type,
      ).toMatchObject({ gated: true, passed: true, extra: 0 });
    expect(report.types.find((one) => one.type === "plan")).toMatchObject({ gated: false });
    // The repaired turns hold nearly every cut sentence whole, so few facts need a run.
    expect(report.runs.found).toBe(report.runs.expected);
    expect(report.runs.expected).toBeGreaterThanOrEqual(1);
    expect(report.drops).toEqual({ candidates: facts.length, kept: facts.length });
    const lines = meetingReportLines(report);
    expect(lines).toContain(`runs: expected ${report.runs.expected} found ${report.runs.expected} not_gated`);
    expect(lines).toContain(`drops: candidates ${facts.length} kept ${facts.length}`);
  });

  it("a new type found under 80 percent fails the check, and a run cited by its first passage alone is a miss", async () => {
    const goals = facts.filter(({ fact }) => fact.type === "goal").map(({ fact }) => fact);
    const short = await run(
      outputs(EVAL_MEETINGS, { drop: (fact) => goals.slice(0, Math.ceil(goals.length * 0.2) + 1).includes(fact) }),
    );
    expect(short.types.find((one) => one.type === "goal")).toMatchObject({ gated: true, passed: false });
    expect(short.passed).toBe(false);
    // A run claim cut to its first passage holds no words of its fact: bad_fields, a drop and a miss.
    const { meeting, fact } = facts.find((one) =>
      spanFor(one.meeting, saidOf(one.fact)).includes(".."),
    ) as (typeof facts)[number];
    const cut = { ...claimFor(meeting, fact), span: spanFor(meeting, saidOf(fact)).split("..")[0] };
    const others = meeting.expected.filter((one) => one !== fact).map((one) => claimFor(meeting, one));
    const report = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(meeting).context.evidenceId]: { claims: [cut, ...others], narrowing: "none" },
    });
    expect(report.runs.found).toBe(report.runs.expected - 1);
    expect(report.failed).toContain(meeting.id);
    expect(report.extras).toBe(0);
    expect(report.drops.bad_fields).toBe(1);
  });

  it("a claim about a speaker nobody named is dropped as unresolved, never found as an extra", async () => {
    const unnamed = EVAL_MEETINGS.find((meeting) =>
      meeting.item.speakers.every((one) => !one.owner && one.mention === undefined),
    ) as EvalMeeting;
    const [first] = passagesOf(unnamed);
    const about = {
      type: "goal",
      subject: {
        key: { kind: "source_id", value: `speaker:${first?.speaker}` },
        observedAt: "2026-03-02T15:00:00.000Z",
      },
      fields: { objective: "learn the piano", domain: "interests" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: first?.span,
    };
    const report = await run({
      ...outputs(EVAL_MEETINGS),
      [openEvalMeeting(unnamed).context.evidenceId]: { claims: [about], narrowing: "none" },
    });
    expect(report).toMatchObject({ extras: 0, passed: true });
    expect(report.drops.unresolved_subject).toBe(1);
    expect(report.detail.find((one) => one.id === unnamed.id)).toMatchObject({ expected: 0, matched: 0, extra: [] });
  });
});

describe("fragmented labels, garble, a participant known by name, a long meeting", () => {
  const byTitle = (title: string) => EVAL_MEETINGS.find((meeting) => meeting.item.title === title) as EvalMeeting;
  const fragmented = byTitle("Studio lease");
  const garbled = byTitle("Grant ideas");
  const named = byTitle("Workshop space");
  const long = byTitle("Long catch-up");

  it("the set holds each mode: a fragmented call the lane finds unreliable, garbled words kept as transcribed, a speaker known by name alone, and fifty minutes asked in windows", () => {
    expect(fragmented.ownWord && fragmented.fragmented).toBe(true);
    const plan = planMeeting(openEvalMeeting(fragmented));
    expect(plan.labels?.reliable).toBe(false);
    // Every sentence cut in pieces of two to six words whose labels flip, each
    // piece on its speaker's stream, so the channels are clean and the remote lines are marked.
    for (const one of fragmented.item.segments) expect(one.text.split(" ").length).toBeLessThanOrEqual(6);
    expect(plan.labels?.mixed ?? 0).toBeGreaterThanOrEqual(0.5 * (plan.labels?.sentences ?? 0));
    expect(plan.channels).toMatchObject({ mixed: 0, clean: true });
    expect(plan.remote).toBe(true);
    // Garble: the phrases are the transcript's words, homophones and all.
    for (const word of ["fondant", "clawed", "quite", "right", "male"])
      expect(garbled.item.segments.some((one) => one.text.includes(` ${word} `))).toBe(true);
    expect(garbled.expected.some((fact) => saidOf(fact) === "raise a fondant for climate startups")).toBe(true);
    // A speaker the owner named with no address, bound by name.
    const other = named.item.speakers.find((one) => !one.owner);
    expect(other?.mention).toEqual({ name: "Ivo Brandt" });
    expect(
      named.expected.filter((fact) => fact.subject === Object.values(named.bound ?? {})[0]).length,
    ).toBeGreaterThanOrEqual(4);
    // About fifty minutes, at least twenty facts, in more than one window.
    expect((Date.parse(long.item.endedAt) - Date.parse(long.item.startedAt)) / 60_000).toBeGreaterThanOrEqual(45);
    expect(long.expected.length).toBeGreaterThanOrEqual(20);
    expect(planMeeting(openEvalMeeting(long)).groups.length).toBeGreaterThanOrEqual(2);
    for (const type of ["goal", "need", "capability", "preference", "constraint", "situation", "commitment"])
      expect(
        long.expected.some((fact) => fact.type === type),
        type,
      ).toBe(true);
  });

  it("on the fake model the credit gate holds: nothing credited from a meeting whose labels are unreliable, every matched fact credited as the set expects, the owner's word found where it holds, and each scenario recalled", async () => {
    const report = await run(outputs(EVAL_MEETINGS));
    expect(report.credit).toMatchObject({
      fragmented: EVAL_MEETINGS.filter((one) => one.fragmented === true).length,
      missed: [],
      assigned: 0,
      wrong: 0,
      passed: true,
    });
    expect(report.credit.owned).toBeGreaterThanOrEqual(1);
    expect(report.credit.unreliable).toBeGreaterThanOrEqual(1);
    expect(report.scenarios.map((one) => one.scenario).sort()).toEqual([
      "context",
      "fragmented",
      "garble",
      "long",
      "named",
      "realism",
      "remote",
    ]);
    for (const one of report.scenarios) expect(one, one.scenario).toMatchObject({ passed: true, found: one.expected });
    expect(report.passed).toBe(true);
    expect(report.detail.find((one) => one.id === fragmented.id)).toMatchObject({
      matched: fragmented.expected.length,
      extra: [],
    });
    const lines = meetingReportLines(report);
    expect(lines).toContain(
      `credit: fragmented ${report.credit.fragmented} unreliable ${report.credit.unreliable} missed none assigned 0 wrong 0 owner_word ${report.credit.owned} gated ok`,
    );
    const scenario = EVAL_MEETINGS.filter((one) => one.scenario === "fragmented").reduce(
      (sum, one) => sum + one.expected.length,
      0,
    );
    expect(lines).toContain(`scenario fragmented: expected ${scenario} found ${scenario} extra 0 gated ok`);
    expect(lines).toContain(`windows: most ${report.windows} not_gated`);
  });

  it("a scenario under 80 percent fails the check though every type's recall holds: losing the lease call's and the name-only facts together", async () => {
    const lost = new Set([...fragmented.expected, ...named.expected]);
    const report = await run(outputs(EVAL_MEETINGS, { drop: (fact) => lost.has(fact) }));
    expect(report.types.every((one) => one.passed)).toBe(true);
    // The lease call is the `remote` scenario's.
    expect(
      report.scenarios
        .filter((one) => !one.passed)
        .map((one) => one.scenario)
        .sort(),
    ).toEqual(["named", "remote"]);
    expect(report.passed).toBe(false);
  });

  it("a meeting the set calls fragmented that the lane finds reliable fails the credit gate: the measure is gated, not only reported", async () => {
    const calm = EVAL_MEETINGS.find(
      (meeting) =>
        meeting.item.mode === "call" &&
        meeting.expected.length > 0 &&
        planMeeting(openEvalMeeting(meeting)).labels?.reliable === true,
    ) as EvalMeeting;
    const set = [...EVAL_MEETINGS.filter((one) => one !== calm), { ...calm, fragmented: true as const }];
    const report = await runSet(set);
    expect(report.credit).toMatchObject({ missed: [calm.id], passed: false });
    expect(report.passed).toBe(false);
  });

  it("the owner's word in a reliable call that meets R81's conditions must be found: a lane that credits it to nobody fails the gate", async () => {
    const grant = EVAL_MEETINGS.find(
      (meeting) => meeting.ownWord === true && meeting.fragmented !== true,
    ) as EvalMeeting;
    const owner = grant.expected.find((fact) => creditOf(grant, fact) === EVAL_MEETING_OWNER_ENTITY);
    expect(owner).toBeDefined();
    const right = await runSet([grant]);
    expect(right.credit).toMatchObject({ owned: 1, wrong: 0, passed: true });
    // The owner's line missing, as a lane crediting nobody would leave it: the gate fails.
    const none = await runSet([grant], outputs([grant], { drop: (fact) => fact === owner }));
    expect(none.credit).toMatchObject({ owned: 0, passed: false });
  });

  it("the facts about a speaker known by name alone are found once the name is bound, and dropped as unresolved without the binding", async () => {
    const bound = await runSet([named]);
    expect(bound.detail[0]).toMatchObject({ matched: named.expected.length, extra: [] });
    const { bound: _bound, ...unbound } = named;
    const report = await runSet([unbound], outputs([named]));
    expect(report.detail[0]?.matched).toBe(named.expected.filter((fact) => fact.subject === EVAL_MEETING_OWNER).length);
    expect(report.drops.unresolved_subject).toBeGreaterThanOrEqual(4);
  });

  it("the long meeting's facts are each found once though the windows overlap: a fact answered in two windows is a duplicate, not an extra", async () => {
    const opened = openEvalMeeting(long);
    const { groups } = planMeeting(opened);
    const claims = long.expected.map((fact) => claimFor(long, fact));
    const both = Object.fromEntries(
      groups.map((group) => [
        `${opened.context.evidenceId}/${group.inputHash}`,
        { claims: claims.filter((claim) => group.passages.some((one) => one.span === claim.span)), narrowing: "none" },
      ]),
    );
    const report = await runSet([long], both);
    expect(report.detail[0]).toMatchObject({ matched: long.expected.length, extra: [] });
    expect(report.extras).toBe(0);
    expect(report.drops.duplicate).toBeGreaterThanOrEqual(1);
  });
});

// The three causes the first live meeting check found.
describe("the meeting check's causes", () => {
  const byTitle = (title: string) => EVAL_MEETINGS.find((meeting) => meeting.item.title === title) as EvalMeeting;

  it("cause 1: the models' restated promises and plans with their dates left out are kept, not refused bad_fields", async () => {
    const restated = EVAL_MEETINGS.filter((meeting) =>
      ["Garden plans", "Running club", "Supplier lunch"].includes(meeting.item.title ?? ""),
    );
    const outputsFor = Object.fromEntries(
      restated.map((meeting) => [
        openEvalMeeting(meeting).context.evidenceId,
        {
          claims: meeting.expected.map((fact) => {
            const claim = claimFor(meeting, fact);
            if (fact.type !== "commitment" && fact.type !== "plan") return claim;
            // The line from its promise to its first comma, its date left out, as a model writes it.
            const at = fact.what.search(/I will|I'll|let's|Let's/);
            const what = `${(at < 0 ? fact.what : fact.what.slice(at)).split(/,| so | as soon as /)[0]?.replace(/[.?!]$/, "")}.`;
            return { ...claim, fields: { ...claim.fields, what } };
          }),
          narrowing: "none",
        },
      ]),
    );
    const report = await runSet(restated, outputsFor);
    expect(report.drops.bad_fields ?? 0).toBe(0);
    for (const one of report.detail) expect(one, one.id).toMatchObject({ matched: one.expected });
  });

  it("cause 3: the owner's word is found by its type among their credited claims, so a promise dated otherwise than the set expects still shows it credited to the owner", async () => {
    const grant = byTitle("Grant application");
    const opened = openEvalMeeting(grant);
    // As both models answered: the owner's "before Friday" promise dated Friday.
    const claims = grant.expected.map((fact) => {
      const claim = claimFor(grant, fact);
      return fact.type === "commitment" && fact.subject === EVAL_MEETING_OWNER
        ? { ...claim, fields: { ...claim.fields, due: FRIDAY } }
        : claim;
    });
    const report = await runSet([grant], { [opened.context.evidenceId]: { claims, narrowing: "none" } });
    expect(report.credit).toMatchObject({ owned: 1, wrong: 0, passed: true });
    // Found by its words, its due day reported as a disagreement.
    expect(report.detail[0]).toMatchObject({ matched: grant.expected.length });
    expect(report.agreement.duesAgree).toBeLessThan(report.agreement.dues);
    // More than one call holds the owner's word, so the gate rests on several facts.
    expect(
      EVAL_MEETINGS.filter((meeting) => meeting.ownWord === true && meeting.fragmented !== true).map(
        (meeting) => meeting.item.title,
      ),
    ).toEqual(expect.arrayContaining(["Grant application", "Hiring round", "Sabbatical"]));
  });

  // The fragmented room, cut by the seeded fragmenter from the long room's lines.
  it("(a) the fragmented room is shaped as the diagnosed one, expects only the facts a cue ties, allows the rest, and pairs each fact with the long room's", async () => {
    const cut = byTitle("Long catch-up, fragmented");
    const long = byTitle("Long catch-up");
    const plan = planMeeting(openEvalMeeting(cut));
    expect(cut.item.mode).toBe("room");
    expect(plan.labels).toMatchObject({ sentences: 74, reliable: false });
    expect(plan.labels?.mixed ?? 0).toBeGreaterThanOrEqual(0.7 * 74);
    expect(cut.item.segments.length).toBeGreaterThanOrEqual(300);
    for (const one of cut.item.segments) expect(one.text.split(" ").length, one.text).toBeGreaterThanOrEqual(2);
    for (const one of cut.item.segments) expect(one.text.split(" ").length, one.text).toBeLessThanOrEqual(6);
    // Each expected fact is the long room's, a cue in its line, and every other fact is allowed.
    expect(cut.expected.length + (cut.allowed?.length ?? 0)).toBe(long.expected.length);
    cut.paired?.facts.forEach((at, n) => {
      expect(saidOf(cut.expected[n] as EvalMeetingFact), String(n)).toContain(
        saidOf(long.expected[at] as EvalMeetingFact).replace(/\.$/, ""),
      );
    });
    for (const fact of cut.expected)
      expect(
        plan.passages.some((one) => one.text.includes(saidOf(fact)) && /^(Liv|Sam), /.test(one.text)),
        saidOf(fact),
      ).toBe(true);
    // Nothing is credited, and the paired recall is reported: a model that loses every fact of the
    // cut room shows the whole difference.
    const both = [long, cut];
    const right = await runSet(both);
    expect(right.credit).toMatchObject({ assigned: 0, wrong: 0 });
    expect(right.paired).toEqual([
      { id: cut.id, facts: cut.expected.length, clean: cut.expected.length, found: cut.expected.length },
    ]);
    expect(meetingReportLines(right)).toContain(
      `paired ${cut.id}: facts ${cut.expected.length} clean ${cut.expected.length} fragmented ${cut.expected.length} difference 0 not_gated`,
    );
    // The cut room's facts are the long room's own objects, so the cut room is answered with none.
    const lost = await runSet(both, { ...outputs([long]), ...outputs([cut], { drop: () => true }) });
    expect(lost.paired[0]).toMatchObject({ clean: cut.expected.length, found: 0 });
  });

  it("(a) an allowed fact on an unnamed line of the room is kept from version 7: with its true subject neither matched nor extra, with another an extra", async () => {
    const cut = byTitle("Long catch-up, fragmented");
    const allowed = cut.allowed?.find((fact) => fact.type === "need") as EvalMeetingFact;
    const right = await runSet([cut], outputs([cut], { extra: { [cut.id]: [claimFor(cut, allowed)] } }));
    expect(right.detail[0]).toMatchObject({ matched: cut.expected.length, extra: [] });
    expect(right.drops.untied_subject).toBeUndefined();
    const other = allowed.subject === EVAL_MEETING_OWNER ? "liv.hart@brook.example" : EVAL_MEETING_OWNER;
    // Outside a room, code refuses its subject as untied; in a room the lane keeps the model's
    // attribution, so a wrong one is an extra, gated as the scenario's.
    const wrong = await runSet(
      [cut],
      outputs([cut], { extra: { [cut.id]: [claimFor(cut, allowed, { subject: other })] } }),
    );
    expect(wrong.extras).toBe(1);
    expect(wrong.drops.untied_subject).toBeUndefined();
  });

  it("the no-cue room is a two-person room the lane finds unreliable, no line names a speaker, so version 6's rule would refuse every fact; from version 7 each is found, credited to nobody", async () => {
    const coffee = byTitle("Coffee with a fund partner");
    expect(coffee.item.mode).toBe("room");
    expect(coffee.scenario).toBe("context");
    expect(coffee.item.speakers.map((one) => one.label)).toEqual(["S1", "S2"]);
    const opened = openEvalMeeting(coffee);
    const plan = planMeeting(opened);
    expect(plan.labels?.reliable).toBe(false);
    for (const one of plan.passages) expect(one.text, one.text).not.toMatch(/\b(Sam|Tove)\b/u);
    // Both people have facts, and every one is untied by code's test.
    expect(new Set(coffee.expected.map((one) => one.subject))).toEqual(
      new Set([EVAL_MEETING_OWNER, "tove.ash@pine.example"]),
    );
    for (const fact of coffee.expected) {
      const claim = claimFor(coffee, fact);
      const cited = citedPassage(claim.span, plan.passages, true, TURN_RUN) as MeetingPassage;
      expect(
        untied(claim.subject as never, cited, plan.remote, opened.capture.facts, textValuesOf(fact.type, claim.fields)),
        saidOf(fact),
      ).toBe(true);
    }
    const right = await runSet([coffee]);
    expect(right.detail[0]).toMatchObject({ matched: coffee.expected.length, extra: [] });
    expect(right.credit).toMatchObject({ assigned: 0, wrong: 0 });
    expect(right.scenarios).toEqual([
      { scenario: "context", expected: coffee.expected.length, found: coffee.expected.length, extra: 0, passed: true },
    ]);
  });

  it("the context scenario is gated on recall and on wrong attributions: two facts given the other person fail it, one passes", async () => {
    const coffee = byTitle("Coffee with a fund partner");
    const swap = (fact: EvalMeetingFact) =>
      claimFor(coffee, fact, {
        subject: fact.subject === EVAL_MEETING_OWNER ? "tove.ash@pine.example" : EVAL_MEETING_OWNER,
      });
    const swapped = (n: number) => {
      const wrong = coffee.expected.filter((one) => one.type !== "commitment" && one.type !== "role").slice(0, n);
      return runSet(
        [coffee],
        outputs([coffee], { drop: (fact) => wrong.includes(fact), extra: { [coffee.id]: wrong.map(swap) } }),
      );
    };
    const one = await swapped(1);
    expect(one.scenarios[0]).toMatchObject({ found: coffee.expected.length - 1, extra: 1, passed: true });
    const two = await swapped(2);
    expect(two.scenarios[0]).toMatchObject({ found: coffee.expected.length - 2, extra: 2, passed: false });
    expect(two.passed).toBe(false);
  });

  // Calls, the channel the stream's and the labels flipping on their own.
  it("(b) the remote stream is marked in a call of two invited people, and not with a second voice at the owner's microphone or two people under one remote label", () => {
    const listed = (meeting: EvalMeeting) => planMeeting(openEvalMeeting(meeting));
    const lease = listed(byTitle("Studio lease"));
    expect(lease.remote).toBe(true);
    const slot = lease.groups.flatMap(
      (group) => (JSON.parse(group.data.meeting) as { passages: { text: string; channel?: string }[] }).passages,
    );
    // Kai's four lines, and nothing on the owner's microphone.
    expect(slot.filter((one) => one.channel === "remote").map((one) => one.text)).toEqual(
      lease.passages.filter((one) => one.channel === "output").map((one) => one.text),
    );
    expect(slot.filter((one) => one.channel === "remote")).toHaveLength(4);
    expect(
      slot
        .filter((one) => one.channel === undefined)
        .every((one) => lease.passages.some((turn) => turn.text === one.text && turn.channel === "input")),
    ).toBe(true);
    for (const title of ["Speakerphone order", "Board call"]) {
      const plan = listed(byTitle(title));
      expect(plan.labels?.reliable, title).toBe(false);
      expect(plan.remote, title).toBe(false);
    }
  });

  // The owner's name, so a line that calls the owner by it ties its speaker.
  it("(c) the slot names the owner's speaker", () => {
    const slot = JSON.parse(
      planMeeting(openEvalMeeting(byTitle("Long catch-up, fragmented"))).groups[0]?.data.meeting ?? "{}",
    ) as { speakers: { owner: boolean; name?: string }[] };
    expect(slot.speakers.find((one) => one.owner)?.name).toBe(EVAL_MEETING_OWNER_NAME);
  });

  // The credit gate's positive control.
  it("(f) the owner's word rests on at least five of the owner's facts in at least two clean calls, none a promise with a due day", async () => {
    const owners = EVAL_MEETINGS.flatMap((meeting) =>
      meeting.expected
        .filter((fact) => creditOf(meeting, fact) === EVAL_MEETING_OWNER_ENTITY && fact.type !== "commitment")
        .map(() => meeting.id),
    );
    expect(owners.length).toBeGreaterThanOrEqual(5);
    expect(new Set(owners).size).toBeGreaterThanOrEqual(2);
    const training = byTitle("Training plan");
    const report = await runSet([training]);
    expect(report.credit).toMatchObject({ owned: 5, wrong: 0, passed: true });
  });

  it("(g) a sentence the owner pauses in for two and a half seconds is one turn from version 4, and credited to the owner; a call with almost no punctuation fails closed and credits nobody", async () => {
    const sailing = byTitle("Sailing lessons");
    const [before, after] = sailing.item.segments.slice(2, 4);
    expect((after?.fromMs ?? 0) - (before?.toMs ?? 0)).toBe(2_500);
    expect(
      planMeeting(openEvalMeeting(sailing)).passages.some(
        (one) => one.text === "I need a boat to borrow on weekends, ideally.",
      ),
    ).toBe(true);
    expect(
      planMeeting(openEvalMeeting(sailing), meetingPromptAt("3")).passages.some(
        (one) => one.text === "I need a boat to borrow on weekends, ideally.",
      ),
    ).toBe(false);
    const sail = await runSet([sailing]);
    expect(sail.credit).toMatchObject({ owned: 2, wrong: 0, passed: true });
    const house = byTitle("House painting");
    expect(planMeeting(openEvalMeeting(house)).labels?.reliable).toBe(false);
    const report = await runSet([house]);
    expect(report.credit).toMatchObject({ missed: [], assigned: 0, wrong: 0 });
    expect(report.detail[0]).toMatchObject({ matched: house.expected.length, extra: [] });
    // Were the lane to find it reliable, the gate would fail.
    expect(creditOf(house, house.expected[0] as EvalMeetingFact)).toBeNull();
  });

  it("a phrase with its negation dropped is no match; a repeat of a matched fact is no extra; a meeting not of the set prints no words", async () => {
    const training = byTitle("Training plan");
    const hills = training.expected.find((fact) => fact.type === "constraint") as EvalMeetingFact;
    const opened = openEvalMeeting(training);
    const claims = training.expected.map((fact) => claimFor(training, fact));
    const dropped = claims.map((claim) =>
      claim.type === "constraint" ? { ...claim, fields: { ...claim.fields, rule: "run on hills" } } : claim,
    );
    const negation = await runSet([training], { [opened.context.evidenceId]: { claims: dropped, narrowing: "none" } });
    expect(negation.detail[0]?.missed.map((one) => one.type)).toContain(hills.type);
    // The same fact again, as a second window might keep it.
    const twice = await runSet([training], {
      [opened.context.evidenceId]: {
        claims: [...claims, claimFor(training, training.expected[0] as EvalMeetingFact)],
        narrowing: "none",
      },
    });
    expect(twice).toMatchObject({ extras: 0 });
    const copy = { ...training, item: { ...training.item } };
    const other = await runSet([copy], { [opened.context.evidenceId]: { claims, narrowing: "none" } });
    expect(other.detail[0]).not.toHaveProperty("proposals");
    expect(other.detail[0]).not.toHaveProperty("missedSaid");
    expect((await runSet([training])).detail[0]).toHaveProperty("proposals");
  });

  it("a promise with its negation dropped is no match; the remote call is gated on its own; a labels-flip scenario's guessed subjects are bounded by its own facts", async () => {
    const deck = EVAL_MEETINGS.find((one) =>
      one.item.segments.some((segment) => segment.text === DECK_LINE),
    ) as EvalMeeting;
    const fact = deck.expected[0] as EvalStated;
    const negated = await runSet([deck], {
      [openEvalMeeting(deck).context.evidenceId]: {
        claims: [claimFor(deck, { ...fact, what: "I will not send the deck by Friday." })],
        narrowing: "none",
      },
    });
    expect(negated.detail[0]).toMatchObject({ matched: 0 });
    // The lease call's four remote facts lost: its scenario fails though the pooled ones hold.
    const lease = byTitle("Studio lease");
    expect(lease.scenario).toBe("remote");
    const remote = lease.expected.filter((one) => one.subject !== EVAL_MEETING_OWNER);
    expect(remote).toHaveLength(4);
    const lost = await run(outputs(EVAL_MEETINGS, { drop: (one) => remote.includes(one) }));
    expect(lost.scenarios.find((one) => one.scenario === "remote")).toMatchObject({ passed: false });
    expect(lost.types.every((one) => one.passed)).toBe(true);
    // Five wrong-subject readings of named lines in the fragmented room: the fragmented scenario
    // fails on them (an unnamed line's guess is refused by code before).
    const cut = byTitle("Long catch-up, fragmented");
    const wrong = cut.expected
      .filter((one) => one.type !== "commitment" && one.type !== "relationship")
      .slice(0, 5)
      .map((one) =>
        claimFor(cut, one, {
          subject: one.subject === EVAL_MEETING_OWNER ? "liv.hart@brook.example" : EVAL_MEETING_OWNER,
        }),
      );
    const fragmentedSet = EVAL_MEETINGS.filter((one) => one.scenario === "fragmented");
    const guessed = await runSet(fragmentedSet, outputs(fragmentedSet, { extra: { [cut.id]: wrong } }));
    expect(guessed.scenarios.find((one) => one.scenario === "fragmented")).toMatchObject({ extra: 5, passed: false });
  });

  it("an employee affiliation with the organization a role names is allowed; another relation, or another organization, is an extra", async () => {
    const house = byTitle("House painting");
    const opened = openEvalMeeting(house);
    const claims = house.expected.map((fact) => claimFor(house, fact));
    const role = house.expected.find((fact) => fact.type === "role") as EvalMeetingFact & { organization: string };
    const as = (relation: string, organization: string) => ({
      ...claimFor(house, role),
      type: "affiliation",
      fields: { relation, organization_name: organization },
    });
    const employee = await runSet([house], {
      [opened.context.evidenceId]: { claims: [...claims, as("employee", role.organization)], narrowing: "none" },
    });
    expect(employee.extras).toBe(0);
    const founder = await runSet([house], {
      [opened.context.evidenceId]: { claims: [...claims, as("founder", role.organization)], narrowing: "none" },
    });
    expect(founder.extras).toBe(1);
  });

  it("the speakerphone call's owner lines name the owner, so a reader can tie them", () => {
    const call = byTitle("Speakerphone order");
    for (const fact of call.expected.filter((one) => one.subject === EVAL_MEETING_OWNER)) {
      const line = call.item.segments.map((one) => one.text).join(" ");
      expect(
        line.slice(Math.max(0, line.indexOf(saidOf(fact)) - 40), line.indexOf(saidOf(fact))),
        saidOf(fact),
      ).toMatch(/\bSam\b/);
    }
  });

  it("pooled runs gate the model's counts on their sum, keep zero gates for the code's, and name what every run missed", async () => {
    const good = await run(outputs(EVAL_MEETINGS));
    const lease = byTitle("Studio lease");
    const remote = lease.expected.filter((one) => one.subject !== EVAL_MEETING_OWNER).slice(0, 2);
    // One run loses two of the lease call's facts: alone its scenario fails, pooled with two good runs it holds.
    const bad = await run(outputs(EVAL_MEETINGS, { drop: (one) => remote.includes(one) }));
    expect(bad.passed).toBe(false);
    const pooled = poolMeetingReports([bad, good, good]);
    expect(pooled).toMatchObject({ pooled: 3, passed: true, systematic: [] });
    expect(pooled.scenarios.find((one) => one.scenario === "remote")).toMatchObject({
      expected: 18,
      found: 16,
      passed: true,
    });
    // Missed in every run: systematic, named by meeting and shape.
    const always = poolMeetingReports([bad, bad, bad]);
    expect(always.passed).toBe(false);
    expect(always.systematic).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^${lease.id} missed `))]),
    );
    expect(pooledMeetingReportLines(always)).toEqual(
      expect.arrayContaining(["pooled: runs 3 not_gated", expect.stringMatching(/^systematic: /)]),
    );
    expect(pooledMeetingReportLines(always).at(-1)).toBe("result: failed");
    // Systematic lines carry roles and codes, no word of the set; a shape in two runs of three is
    // named; each run's own result is printed.
    for (const line of always.systematic)
      expect(line).toMatch(/^meeting-\d+ (missed|extra) [a-z]+\/[a-z]+>[a-z]+\/due=\S+ in \d of \d$/);
    expect(poolMeetingReports([bad, bad, good]).systematic).toEqual(
      expect.arrayContaining([expect.stringMatching(/ in 2 of 3$/)]),
    );
    expect(pooledMeetingReportLines(poolMeetingReports([bad, good, good]))).toEqual(
      expect.arrayContaining(["run 1: failed not_gated", "run 2: ok not_gated"]),
    );
    // The pooled line is the per-run line times N, so no rounding favours the model: a labels-flip
    // scenario of 7 facts allows 1 extra a run, 3 over three runs, never 4.
    const seven = {
      ...good,
      scenarios: [{ scenario: "fragmented" as const, expected: 7, found: 7, extra: 0, passed: true }],
    };
    const four = { ...seven, scenarios: [{ ...seven.scenarios[0]!, extra: 4 }] };
    expect(poolMeetingReports([four, seven, seven]).scenarios[0]).toMatchObject({ extra: 4, passed: false });
    expect(
      poolMeetingReports([{ ...seven, scenarios: [{ ...seven.scenarios[0]!, extra: 3 }] }, seven, seven]).scenarios[0],
    ).toMatchObject({ extra: 3, passed: true });
    // A code property wrong in one run fails the pool whatever the others say.
    const wrongCredit = { ...good, credit: { ...good.credit, wrong: 1, passed: false } };
    expect(poolMeetingReports([good, wrongCredit, good]).passed).toBe(false);
    const noDeck = { ...good, deck: false };
    expect(poolMeetingReports([good, good, noDeck]).passed).toBe(false);
    // Each run is independent: three runs on the fake model ask three times as many calls.
    const calls: string[] = [];
    const three = await evaluateMeetingsPooled({ model: fakeModelClient(outputs(EVAL_MEETINGS), calls) }, 3);
    expect(three).toMatchObject({ pooled: 3, passed: true });
    // The no-cue room's scenario, pooled.
    expect(three.scenarios.find((one) => one.scenario === "context")).toMatchObject({
      expected: 24,
      found: 24,
      extra: 0,
      passed: true,
    });
    expect(calls.length).toBe(
      3 * EVAL_MEETINGS.reduce((sum, meeting) => sum + planMeeting(openEvalMeeting(meeting)).groups.length, 0),
    );
  });

  // A pooled run's calls are counted under that run, so each run's detail line shows
  // its own latency and cost, never the sum over every run of the same synthetic evidence id.
  it("pooled, each run's detail line shows that run's latency and cost, and the total all of them", async () => {
    const counter = callStatsByRun();
    const fake = fakeModelClient(outputs(EVAL_MEETINGS));
    let calls = 0;
    const model: ModelClient = {
      ...fake,
      complete: async (request) => {
        calls += 1;
        const one = counter.of(request.callKey?.evidenceId ?? "");
        one.ms += 1;
        one.microUsd += 10;
        return fake.complete(request);
      },
    };
    const pooled = await evaluateMeetingsPooled({ model, onRun: counter.onRun }, 3);
    const lines = meetingDetailLines(pooled, counter.stats, 0);
    const meeting = EVAL_MEETINGS[0] as EvalMeeting;
    const asked = planMeeting(openEvalMeeting(meeting)).groups.length;
    for (const run of [1, 2, 3])
      expect(lines.find((line) => line.startsWith(`run${run}/${meeting.id}: `))).toMatch(
        new RegExp(` ms ${asked} micro_usd ${10 * asked}$`),
      );
    expect(lines.at(-1)).toBe(`total: wall_ms 0 micro_usd ${10 * calls}`);
  });
});
