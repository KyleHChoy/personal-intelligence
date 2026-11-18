import { KEY_FIELDS, MomentItem } from "@intelligence/contracts/personal";
import { MOMENT_THREAD_DAYS } from "@intelligence/personal-core/lens";
import type { ModelClient } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { MOMENT_TYPES } from "../lane-versions.ts";
import { MOMENT_GROUP_MAX } from "../moments.ts";
import { planMoments } from "../moments-plan.ts";
import { momentPrompt } from "../prompts.ts";
import { MOMENT_DB_MIN_CHARS, MOMENT_MIN_CHARS } from "../triage.ts";
import { callStatsByRun, meetingDetailLines } from "./eval-meetings-report.ts";
import { saidOf } from "./eval-meetings-set.ts";
import {
  EVAL_MOMENT_OWNER,
  type EvalMomentFact,
  type EvalMomentGroup,
  FRIDAY,
  MOMENT_DECK_LINE,
} from "./eval-moment-builders.ts";
import { EVAL_MOMENT_GROUPS } from "./eval-moment-groups.ts";
import {
  askedByLane,
  evaluateMoments,
  evaluateMomentsPooled,
  type MomentEvalReport,
  momentReportLines,
  momentSpeakerLines,
  openEvalMoment,
  pooledMomentReportLines,
  poolMomentReports,
} from "./eval-moments.ts";
import { EVAL_EXTRAS_PER_ITEM, EVAL_RECALL, extrasAllowed } from "./eval-rule.ts";

// The moment evaluation, on the fake model only.

const mention = (address: string, item: EvalMomentGroup["moments"][number]) => ({
  key: { kind: "address", value: address },
  observedAt: new Date(Date.parse(item.observedAt)).toISOString(),
});

// The group's request as the lane plans it.
const planOf = (group: EvalMomentGroup) => {
  const plan = planMoments(
    group.moments.map((item) => ({
      opened: openEvalMoment(item, group.agentApp === true, group.bound),
      member: {
        evidenceId: openEvalMoment(item).context.evidenceId as never,
        compartments: ["own"],
        observedAt: item.observedAt as never,
        attempts: 0,
        override: false,
      },
    })),
  );
  if (plan === null) throw new Error("no plan");
  return plan;
};

// What a model that finds a fact answers for it: the span of the passage that says it; a person by
// the address the passage shows, else the owner or a participant by label; explicit_self when its
// speaker says it of themselves. Every type's fields, as the meeting check's fake model writes
// them.
function claimFor(group: EvalMomentGroup, fact: EvalMomentFact, over: Record<string, unknown> = {}) {
  const given = { ...fact, ...over } as EvalMomentFact;
  const plan = planOf(group);
  const words = saidOf(fact);
  const passage =
    plan.passages.find((one) =>
      one.parsed.segments.some((segment) => segment.span === one.chars && segment.text.includes(words)),
    ) ?? (plan.passages[0] as (typeof plan.passages)[number]);
  const text = passage.opened.item.text.slice(passage.range.from, passage.range.to);
  const at = passage.opened.capture.observedAt;
  // A participant known by a name alone, by the name the group binds to the address.
  const named = (address: string): string | undefined =>
    Object.entries(group.bound ?? {}).find(([, to]) => to === address)?.[0];
  const labelOf = (address: string): string | undefined =>
    address === EVAL_MOMENT_OWNER
      ? "owner"
      : [...plan.people.values()].find(
          (one) =>
            one.mention.address === address ||
            (one.mention.address === undefined &&
              one.mention.name !== undefined &&
              one.mention.name === named(address)) ||
            // A source moment's contact by the handle the group binds to the address.
            (one.mention.handle !== undefined && one.mention.handle === named(address)),
        )?.label;
  const who = (address: string) => {
    const label = labelOf(address);
    return text.includes(address) || label === undefined
      ? mention(address, passage.opened.item)
      : { key: { kind: "source_id", value: `speaker:${label}` }, observedAt: at };
  };
  const selfSaid = given.by !== undefined && given.by === given.subject && passage.speaker === labelOf(given.subject);
  const fields = (): Record<string, unknown> => {
    switch (given.type) {
      case "commitment":
      case "plan":
        return {
          counterparty: who(given.counterparty),
          what: given.what,
          ...(given.due === undefined ? {} : { due: given.due }),
          ...(given.when === undefined ? {} : { when: given.when }),
        };
      case "role":
        return {
          title: given.title,
          ...(given.organization === undefined ? {} : { organization_name: given.organization }),
        };
      case "affiliation":
        return { relation: given.relation, organization_name: given.organization };
      case "relationship":
        return { counterparty: who(given.counterparty), relation: given.relation };
      default:
        return {
          [KEY_FIELDS[given.type].phrase]: given.phrase,
          domain: given.domain,
          ...(given.polarity === undefined ? {} : { polarity: given.polarity }),
        };
    }
  };
  return {
    type: given.type,
    subject: who(given.subject),
    fields: fields(),
    statementKind: "stated_fact",
    basis: selfSaid ? "explicit_self" : "third_party",
    span: passage.span,
  };
}

// A fake model's outputs: each group's expected facts but those `drop` leaves out, with `extra`
// claims added, by group id; keyed by the group's first moment, whose call key the request is.
function outputs(
  set: readonly EvalMomentGroup[],
  options: { drop?: (fact: EvalMomentFact) => boolean; extra?: Record<string, unknown[]> } = {},
): Record<string, unknown> {
  return Object.fromEntries(
    set.map((group) => [
      openEvalMoment(group.moments[0] as EvalMomentGroup["moments"][number]).context.evidenceId,
      {
        claims: [
          ...group.expected.filter((fact) => options.drop?.(fact) !== true).map((fact) => claimFor(group, fact)),
          ...(options.extra?.[group.id] ?? []),
        ],
        narrowing: "none",
      },
    ]),
  );
}

const run = (given: Record<string, unknown>, calls: string[] = []): Promise<MomentEvalReport> =>
  evaluateMoments({ model: fakeModelClient(given, calls) });
// The evaluation scores the groups the lane asks alone.
const ASKED = EVAL_MOMENT_GROUPS.filter(askedByLane);
const deckGroup = ASKED.find((group) =>
  group.moments.some((item) => item.text.includes(MOMENT_DECK_LINE)),
) as EvalMomentGroup;
const firstOf = (group: EvalMomentGroup) =>
  openEvalMoment(group.moments[0] as EvalMomentGroup["moments"][number]).context.evidenceId;

describe("the evaluation moments", () => {
  it("hold at least ten commitments and at least ten groups with none, on reserved domains, each a group the lane would form and send, each fact a sentence of one of its moments", () => {
    const facts = EVAL_MOMENT_GROUPS.flatMap((group) => group.expected);
    expect(facts.filter((fact) => fact.type === "commitment").length).toBeGreaterThanOrEqual(10);
    expect(EVAL_MOMENT_GROUPS.filter((group) => group.expected.length === 0).length).toBeGreaterThanOrEqual(10);
    expect(new Set(EVAL_MOMENT_GROUPS.map((group) => group.id)).size).toBe(EVAL_MOMENT_GROUPS.length);
    expect(new Set(EVAL_MOMENT_GROUPS.flatMap((group) => group.moments.map((item) => item.key))).size).toBe(
      EVAL_MOMENT_GROUPS.flatMap((group) => group.moments).length,
    );
    for (const group of EVAL_MOMENT_GROUPS) {
      expect(group.moments.length).toBeGreaterThanOrEqual(1);
      expect(group.moments.length).toBeLessThanOrEqual(MOMENT_GROUP_MAX);
      // One app, one thread, one local day: as the store groups them. A source moment's thread, by
      // its key, over at most MOMENT_THREAD_DAYS local days.
      expect(
        new Set(
          group.moments.map(
            (item) =>
              `${item.app.bundle} ${item.source === undefined ? (item.thread ?? "") : item.threadKey} ${item.source === undefined ? item.observedAt.slice(0, 10) : ""}`,
          ),
        ).size,
      ).toBe(1);
      const days = group.moments.map((item) => Date.parse(`${item.observedAt.slice(0, 10)}T00:00:00Z`));
      expect(Math.max(...days) - Math.min(...days)).toBeLessThan(MOMENT_THREAD_DAYS * 86_400_000);
      for (const item of group.moments) {
        expect([...item.text].length, group.id).toBeGreaterThanOrEqual(
          item.read === "db" ? MOMENT_DB_MIN_CHARS : MOMENT_MIN_CHARS,
        );
        for (const address of item.text.match(/[\w.+-]+@[\w.-]+/g) ?? [])
          expect(address).toMatch(/\.example$|@example\.org$/);
      }
      for (const fact of group.expected)
        expect(
          group.moments.filter((item) => item.text.includes(saidOf(fact))),
          saidOf(fact),
        ).toHaveLength(1);
    }
    expect(EVAL_MOMENT_OWNER).toMatch(/\.example$/);
    expect(deckGroup.expected).toEqual([
      expect.objectContaining({ type: "commitment", counterparty: EVAL_MOMENT_OWNER, what: MOMENT_DECK_LINE }),
    ]);
    expect([EVAL_RECALL, EVAL_EXTRAS_PER_ITEM]).toEqual([0.8, 0.2]);
  });

  // A promise the set leaves out is an extra whenever a model finds it, and the fact key holds no
  // text, so every line that promises something is expected.
  it('expect every line that promises something: each "I will" sentence is an expected commitment\'s', () => {
    const unexpected = EVAL_MOMENT_GROUPS.flatMap((group) =>
      group.moments
        .flatMap((item) => item.text.split(/(?<=\.) |\n/))
        .filter(
          (sentence) =>
            /\bI will\b/.test(sentence) &&
            !group.expected.some((fact) => fact.type === "commitment" && sentence.includes(fact.what)),
        ),
    );
    expect(unexpected).toEqual([]);
  });

  it("date the deck line's Friday as the moment prompt's example does, from the same Monday; the lines naming one day are dated, the others not", () => {
    expect((deckGroup.expected[0] as EvalMomentFact & { type: "commitment" }).due).toBe(FRIDAY);
    expect(FRIDAY).toBe("2026-03-06");
    const example = momentPrompt().instructions;
    // Version 2's example, as version 1's, dates "by Friday" said that Monday.
    expect(example).toContain(`"what":"I will send you the plans by Friday.","due":"${FRIDAY}"`);
    expect(example).toContain('"observedAt":"2026-03-02');
    // Every moment is seen on that Monday, on its own clock and in UTC; the sessions of a thread
    // over days on that week's days, each dated from its own.
    for (const item of EVAL_MOMENT_GROUPS.flatMap((group) => group.moments)) {
      const day = item.observedAt.slice(0, 10);
      expect(new Date(item.observedAt).toISOString().slice(0, 10)).toBe(day);
      if (item.source === undefined || day === "2026-03-02") expect(day).toBe("2026-03-02");
      else expect(day > "2026-03-02" && day < "2026-03-09").toBe(true);
    }
    expect(new Date("2026-03-02T00:00:00.000Z").getUTCDay()).toBe(1);
    const dues = Object.fromEntries(
      EVAL_MOMENT_GROUPS.flatMap((group) => group.expected).flatMap((fact) =>
        fact.type === "commitment" ? [[fact.what, fact.due ?? null]] : [],
      ),
    );
    expect(dues).toMatchObject({
      [MOMENT_DECK_LINE]: "2026-03-06",
      "I will send you the venue shortlist tomorrow morning.": "2026-03-03",
      "I will prune the hedge on Thursday afternoon.": "2026-03-05",
      "I will draft the budget section for you this week.": null,
      "I will write the project summary and share it with you before Friday.": null,
    });
  });
});

describe("chats, group chats, agent apps and chats without turns", () => {
  const chats = EVAL_MOMENT_GROUPS.filter((group) => group.moments.some((item) => item.entity === "chat"));
  const askedChats = chats.filter(askedByLane);

  it("every moment of the set is a valid MomentItem; the set holds one-to-one chats, group chats, agent-app conversations and chats without turns", () => {
    for (const item of EVAL_MOMENT_GROUPS.flatMap((group) => group.moments))
      expect(MomentItem.safeParse(item).success, item.key).toBe(true);
    const withTurns = chats.filter((group) => group.moments.every((item) => item.turns !== undefined));
    expect(
      withTurns.filter((group) => group.agentApp !== true && group.moments[0]?.participants.length === 1).length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      withTurns.filter((group) => (group.moments[0]?.participants.length ?? 0) >= 3).length,
    ).toBeGreaterThanOrEqual(2);
    expect(chats.filter((group) => group.agentApp === true).length).toBeGreaterThanOrEqual(3);
    expect(
      chats.filter((group) => group.moments.every((item) => item.turns === undefined)).length,
    ).toBeGreaterThanOrEqual(2);
    // An agent's reply in it states something about the owner.
    expect(
      chats.some(
        (group) =>
          group.agentApp === true &&
          group.moments.some((item) =>
            item.turns?.some(
              (turn) => turn.speaker === "agent" && /^You said you will/.test(item.text.slice(turn.from, turn.to)),
            ),
          ),
      ),
    ).toBe(true);
    // A promise between two participants, neither the owner.
    expect(
      chats.some((group) =>
        group.expected.some(
          (fact) =>
            fact.type === "commitment" &&
            fact.by !== undefined &&
            fact.subject !== EVAL_MOMENT_OWNER &&
            fact.counterparty !== EVAL_MOMENT_OWNER,
        ),
      ),
    ).toBe(true);
    // Each type gated has at least ten expected facts.
    expect(
      EVAL_MOMENT_GROUPS.flatMap((group) => group.expected).filter((fact) => fact.type === "commitment").length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("each chat fact is credited as it expects: the owner's line to the owner, a contact's to the contact, a chat without turns to nobody", async () => {
    const report = await run(outputs(ASKED));
    expect(report.credited.right).toBe(report.credited.found);
    expect(report.credited.found).toBe(ASKED.flatMap((group) => group.expected).length);
    expect(report.ownerWord).toBe(true);
    // A set expecting another credit for one fact fails the gate: the lane that credits nobody, or
    // swaps two speakers, cannot pass.
    const target = askedChats.find((group) =>
      group.expected.some((fact) => fact.by === EVAL_MOMENT_OWNER),
    ) as EvalMomentGroup;
    const swapped = ASKED.map((group) =>
      group === target
        ? {
            ...group,
            expected: group.expected.map((fact) =>
              fact.by === EVAL_MOMENT_OWNER && "counterparty" in fact ? { ...fact, by: fact.counterparty } : fact,
            ),
          }
        : group,
    );
    const failed = await evaluateMoments({ model: fakeModelClient(outputs(swapped)) }, swapped);
    expect(failed.passed).toBe(false);
    expect(failed.failed).toContain(target.id);
    expect(failed.credited.right).toBeLessThan(failed.credited.found);
    expect(momentReportLines(failed)).toContain(
      `credited: found ${failed.credited.found} right ${failed.credited.right} failed`,
    );
  });

  // The lane asks no agent app's moment, no chat without turns and no mail, so the evaluation
  // scores none of them: they are skipped, with no request.
  it("a group the lane does not ask is skipped: no request, in no line", async () => {
    const calls: string[] = [];
    const report = await run(outputs(EVAL_MOMENT_GROUPS), calls);
    const skipped = EVAL_MOMENT_GROUPS.filter((group) => !askedByLane(group));
    expect(skipped.some((group) => group.agentApp === true)).toBe(true);
    expect(
      skipped.some((group) => group.moments.every((item) => item.entity === "chat" && item.turns === undefined)),
    ).toBe(true);
    expect(skipped.some((group) => group.moments.every((item) => item.entity === "mail"))).toBe(true);
    expect(report.skipped).toBe(skipped.length);
    for (const group of skipped) expect(calls).not.toContain(firstOf(group));
    expect(report.groups).toBe(ASKED.length);
    expect(momentReportLines(report)).toContain(`skipped: ${skipped.length} not_gated`);
  });

  it("--detail: each group's passages by speaker and its claims by the line they cite and whom code credited, with no text", async () => {
    const report = await run(outputs(ASKED));
    const lines = momentSpeakerLines(report);
    expect(lines).toHaveLength(ASKED.length);
    const hike = askedChats[0] as EvalMomentGroup;
    expect(lines).toContain(
      `${hike.id} speakers: passages owner 2 participant 3 agent 0 none 0 cited owner 1 participant 1 agent 0 none 0 credited owner 1 person 1 nobody 0`,
    );
    const text = lines.join("\n");
    expect(text).not.toContain("@");
    for (const item of ASKED.flatMap((group) => group.moments))
      for (const sentence of item.text.split(/(?<=\.) |\n/).filter((one) => one.length > 0))
        expect(text).not.toContain(sentence);
  });
});

describe("evaluateMoments", () => {
  it("on the fake model answering the expected facts the check passes, and with a fact missing it fails", async () => {
    const calls: string[] = [];
    const report = await run(outputs(ASKED), calls);
    expect(report).toMatchObject({ passed: true, failed: [], extras: 0, deck: true });
    expect(report.types.find((one) => one.type === "commitment")).toMatchObject({
      gated: true,
      passed: true,
      extra: 0,
    });
    // One request for each group, its first moment's.
    expect(calls).toEqual(ASKED.map(firstOf));
    // Too many commitments missing: it fails, and the groups that lost them are named.
    const lost = await run(
      outputs(ASKED, { drop: (fact) => fact.type === "commitment" && fact.subject !== EVAL_MOMENT_OWNER }),
    );
    expect(lost.passed).toBe(false);
    expect(lost.failed).toContain(deckGroup.id);
    // One missing: recall still holds the line, the positive control, and its group is named.
    const one = ASKED.find((group) => group.id !== deckGroup.id && group.expected.length > 0) as EvalMomentGroup;
    const nearly = await run(outputs(ASKED, { drop: (fact) => fact === one.expected[0] }));
    expect(nearly).toMatchObject({ passed: true, failed: [one.id] });
  });

  it("Robin's deck line yields a commitment owed to the owner by Robin, never one by the owner", async () => {
    const fact = deckGroup.expected[0] as EvalMomentFact & { type: "commitment" };
    const owners = await run({
      ...outputs(ASKED),
      [firstOf(deckGroup)]: {
        claims: [claimFor(deckGroup, fact, { subject: EVAL_MOMENT_OWNER, counterparty: fact.subject })],
        narrowing: "none",
      },
    });
    expect(owners).toMatchObject({ deck: false, passed: false });
    expect((await run(outputs(ASKED))).deck).toBe(true);
  });

  // As the meeting check matches: a found fact matches by its type, subject, people and words; its
  // due day is the fact key's, and a differing key is no miss.
  it("a deck line found with no due date still matches by its words; a promise in other words is a miss, and a repeat of its key, no extra", async () => {
    const fact = deckGroup.expected[0] as EvalMomentFact & { type: "commitment" };
    const { due: _friday, ...undated } = fact;
    const report = await run({
      ...outputs(ASKED),
      [firstOf(deckGroup)]: { claims: [claimFor(deckGroup, undated)], narrowing: "none" },
    });
    expect(report.failed).not.toContain(deckGroup.id);
    expect(report.detail.find((one) => one.id === deckGroup.id)).toMatchObject({ expected: 1, matched: 1, extra: [] });
    // The positive control: the commitment found on another line of the group, with other words.
    const other = { ...fact, what: "Hi Sam, the numbers are done and the story is mostly there." };
    const wrong = await run({
      ...outputs(ASKED),
      [firstOf(deckGroup)]: { claims: [claimFor(deckGroup, other)], narrowing: "none" },
    });
    expect(wrong.detail.find((one) => one.id === deckGroup.id)).toMatchObject({ expected: 1, matched: 0, extra: [] });
    expect(wrong.repeats).toBe(1);
    expect(momentReportLines(wrong)).toContain("repeats: 1 not_gated");
    expect(wrong.failed).toContain(deckGroup.id);
  });

  it("extras over the allowance fail it; a withheld group is failed", async () => {
    // One more extra than the set allows, each a contact's owner-side fact given to the owner.
    const allowed = extrasAllowed(ASKED.length);
    const side = (fact: EvalMomentFact): boolean =>
      fact.subject !== EVAL_MOMENT_OWNER &&
      (fact.type === "goal" ||
        fact.type === "need" ||
        fact.type === "capability" ||
        fact.type === "constraint" ||
        fact.type === "situation" ||
        fact.type === "preference");
    const extra = ASKED.filter((group) => group.expected.some(side)).slice(0, allowed + 1);
    expect(extra).toHaveLength(allowed + 1);
    const claims = Object.fromEntries(
      extra.map((group) => [
        group.id,
        [claimFor(group, group.expected.find(side) as EvalMomentFact, { subject: EVAL_MOMENT_OWNER })],
      ]),
    );
    const over = await run(outputs(ASKED, { extra: claims }));
    expect(over.extras).toBe(allowed + 1);
    expect(over.passed).toBe(false);
    const withheld = await run({ ...outputs(ASKED), [firstOf(deckGroup)]: { claims: [], narrowing: "quarantine" } });
    expect(withheld.failed).toContain(deckGroup.id);
  });

  it("--detail: one line per group, its missed and extra facts by type, role and due day, its request's latency and cost, then the totals", async () => {
    const dropped = ASKED.find((group) => group.expected.some((fact) => fact.type === "plan")) as EvalMomentGroup;
    const report = await run({
      ...outputs(ASKED),
      [firstOf(dropped)]: { claims: [], narrowing: "none" },
      [firstOf(deckGroup)]: { claims: [], narrowing: "quarantine" },
    });
    const stats = new Map([
      [firstOf(dropped), { ms: 812, microUsd: 1450 }],
      [firstOf(deckGroup), { ms: 640, microUsd: 1200 }],
    ]);
    const lines = meetingDetailLines(report, stats, 9100);
    // Each group's line, then its indented drops and words.
    expect(lines.filter((one) => !one.startsWith("  "))).toHaveLength(ASKED.length + 1);
    const plan = dropped.expected[0] as EvalMomentFact & { type: "plan" };
    expect(lines).toContain(
      `${dropped.id}: expected 1 matched 0 missed plan/other>owner/due=none/when=${plan.when} extra none ms 812 micro_usd 1450`,
    );
    expect(lines).toContain(
      `${deckGroup.id}: expected 1 matched 0 not_answered missed commitment/other>owner/due=${FRIDAY} extra none ms 640 micro_usd 1200`,
    );
    const passed = ASKED.find((group) => group.expected.length === 0) as EvalMomentGroup;
    expect(lines).toContain(`${passed.id}: expected 0 matched 0 missed none extra none ms 0 micro_usd 0`);
    expect(lines.at(-1)).toBe("total: wall_ms 9100 micro_usd 2650");
    expect(lines.join("\n")).not.toContain("@");
    // A `proposed:` line prints the synthetic set's own words, where they went; no other line holds
    // a moment's sentence (the one-line session is one whole sentence).
    const text = lines.filter((one) => !one.startsWith("  proposed:")).join("\n");
    for (const item of ASKED.flatMap((group) => group.moments))
      for (const sentence of item.text.split(/(?<=\.) /)) expect(text).not.toContain(sentence);
  });

  it("the check prints counts and no text", async () => {
    const lines = momentReportLines(await run(outputs(ASKED)));
    expect(lines.at(-1)).toBe("result: ok");
    expect(lines).toContain("deck: ok");
    expect(lines).toContain("owner_word: ok");
    expect(lines.some((one) => one.startsWith(`groups: ${ASKED.length} `))).toBe(true);
    const text = lines.join("\n");
    expect(text).not.toContain("@");
    for (const group of ASKED) {
      for (const item of group.moments) {
        expect(text).not.toContain(item.thread ?? "@@");
        for (const sentence of item.text.split(/(?<=\.) /)) expect(text).not.toContain(sentence);
      }
    }
  });
});

// The person-fact types, scored as the meeting check scores them.
describe("every type of MOMENT_TYPES", () => {
  const facts = ASKED.flatMap((group) => group.expected);

  it("each of the eleven types but plan has at least ten expected facts, so each is gated; every new fact names whom code must credit", async () => {
    for (const type of MOMENT_TYPES.filter((one) => one !== "plan"))
      expect(facts.filter((fact) => fact.type === type).length, type).toBeGreaterThanOrEqual(10);
    const report = await run(outputs(ASKED));
    for (const type of MOMENT_TYPES.filter((one) => one !== "plan"))
      expect(
        report.types.find((one) => one.type === type),
        type,
      ).toMatchObject({ gated: true, passed: true, extra: 0 });
    expect(report).toMatchObject({ passed: true, failed: [], extras: 0, deck: true, ownerWord: true });
    expect(report.credited.right).toBe(report.credited.found);
    // A chat without turns credits nobody; with turns, the subject's own line credits the subject.
    for (const group of ASKED.filter((one) => one.moments.every((item) => item.turns !== undefined))) {
      for (const fact of group.expected.filter((one) => one.type !== "commitment" && one.type !== "plan"))
        expect(fact.by, saidOf(fact)).toBe(fact.subject);
    }
  });

  it("too many of one new type missing fails its gate, and the groups that lost them are named", async () => {
    const lost = await run(outputs(ASKED, { drop: (fact) => fact.type === "preference" }));
    expect(lost.passed).toBe(false);
    expect(lost.types.find((one) => one.type === "preference")).toMatchObject({ gated: true, passed: false, found: 0 });
    const holding = ASKED.filter((group) => group.expected.some((fact) => fact.type === "preference")).map(
      (group) => group.id,
    );
    for (const id of holding) expect(lost.failed).toContain(id);
  });

  // A domain of its own is no miss, as the meeting check reads it.
  it("an owner-side fact found in another domain still matches; about another person it is a miss and an extra", async () => {
    const group = ASKED.find((one) =>
      one.expected.some((fact) => fact.type === "goal" && fact.domains === undefined),
    ) as EvalMomentGroup;
    const fact = group.expected.find((one) => one.type === "goal" && one.domains === undefined) as EvalMomentFact & {
      type: "goal";
    };
    const other = fact.domain === "faith" ? "admin" : "faith";
    const domained = await run({
      ...outputs(ASKED),
      [firstOf(group)]: {
        claims: group.expected.map((one) =>
          one === fact ? claimFor(group, one, { domain: other }) : claimFor(group, one),
        ),
        narrowing: "none",
      },
    });
    expect(domained.failed).not.toContain(group.id);
    const someone =
      fact.subject === EVAL_MOMENT_OWNER
        ? (group.expected.find((one) => one.subject !== EVAL_MOMENT_OWNER)?.subject as string)
        : EVAL_MOMENT_OWNER;
    const misplaced = await run({
      ...outputs(ASKED),
      [firstOf(group)]: {
        claims: group.expected.map((one) =>
          one === fact ? claimFor(group, one, { subject: someone }) : claimFor(group, one),
        ),
        narrowing: "none",
      },
    });
    expect(misplaced.failed).toContain(group.id);
    expect(misplaced.types.find((one) => one.type === "goal")).toMatchObject({ extra: 1 });
  });

  it("the drops line counts each candidate's outcome over the set: a type the version does not offer is type_not_in_lane", async () => {
    const group = ASKED.find((one) =>
      one.expected.some((fact) => fact.type === "role" && fact.by !== undefined),
    ) as EvalMomentGroup;
    const fact = group.expected.find((one) => one.type === "role") as EvalMomentFact & { type: "role" };
    const consent = { ...claimFor(group, fact), type: "consent", fields: { about: "contact", what: fact.title } };
    const report = await run({
      ...outputs(ASKED),
      [firstOf(group)]: { claims: [...group.expected.map((one) => claimFor(group, one)), consent], narrowing: "none" },
    });
    expect(report.drops.type_not_in_lane).toBe(1);
    expect(report.drops.candidates).toBe(facts.length + 1);
    expect(report.drops.kept).toBe(facts.length);
    expect(momentReportLines(report)).toContain(
      `drops: candidates ${facts.length + 1} kept ${facts.length} type_not_in_lane 1`,
    );
  });
});

// The real chat's shape. A long two-person thread and a group chat, each contact known by a name
// alone and bound by the sync's step; gated per scenario, and pooled over runs.
describe("long chats with contacts known by name alone", () => {
  const thread = ASKED.find((group) => group.scenario === "thread") as EvalMomentGroup;
  const named = ASKED.find((group) => group.scenario === "group_named") as EvalMomentGroup;

  it("the thread is about 13 000 characters in moments of at most 4 000 and 400 turns, every line a turn, the contact a name and no address; the group chat has two such contacts", () => {
    const chars = thread.moments.reduce((sum, item) => sum + item.text.length, 0);
    expect(chars).toBeGreaterThanOrEqual(12_500);
    expect(chars).toBeLessThanOrEqual(13_500);
    expect(thread.moments.length).toBeGreaterThanOrEqual(4);
    for (const group of [thread, named]) {
      for (const item of group.moments) {
        expect(MomentItem.safeParse(item).success).toBe(true);
        expect(item.turns?.length).toBe(item.text.split("\n").length);
        expect(item.participants.every((one) => one.address === undefined && one.name !== undefined)).toBe(true);
        expect(item.text).not.toContain("@");
      }
      expect(Object.keys(group.bound ?? {})).toEqual(group.moments[0]?.participants.map((one) => one.name));
    }
    expect(named.moments[0]?.participants).toHaveLength(2);
    // Facts for both sides: the owner's and the contact's, each of several types.
    const of = (group: EvalMomentGroup, owner: boolean) =>
      new Set(group.expected.filter((fact) => (fact.subject === EVAL_MOMENT_OWNER) === owner).map((fact) => fact.type));
    expect(of(thread, true).size).toBeGreaterThanOrEqual(7);
    expect(of(thread, false).size).toBeGreaterThanOrEqual(8);
    // A promise between the two contacts.
    expect(
      named.expected.some(
        (fact) =>
          fact.type === "commitment" && fact.subject !== EVAL_MOMENT_OWNER && fact.counterparty !== EVAL_MOMENT_OWNER,
      ),
    ).toBe(true);
  });

  it("on the fake model each scenario finds every fact with no extra, each credited to its speaker; the lines print each scenario", async () => {
    const report = await run(outputs(ASKED));
    const imessage = ASKED.filter((group) => group.scenario === "imessage").reduce(
      (total, group) => total + group.expected.length,
      0,
    );
    expect(report.scenarios).toEqual([
      { scenario: "thread", expected: thread.expected.length, found: thread.expected.length, extra: 0, passed: true },
      {
        scenario: "group_named",
        expected: named.expected.length,
        found: named.expected.length,
        extra: 0,
        passed: true,
      },
      { scenario: "imessage", expected: imessage, found: imessage, extra: 0, passed: true },
    ]);
    expect(report.credited.right).toBe(report.credited.found);
    expect(momentReportLines(report)).toContain(
      `scenario thread: expected ${thread.expected.length} found ${thread.expected.length} extra 0 gated ok`,
    );
  });

  it("unbound, the contact's facts are unresolved_subject and the scenario fails, while the owner's own are kept: the live failure", async () => {
    const unbound = ASKED.map((group) => (group === thread ? { ...group, bound: {} } : group));
    const report = await evaluateMoments({ model: fakeModelClient(outputs(ASKED)) }, unbound);
    const line = report.scenarios.find((one) => one.scenario === "thread");
    expect(line?.passed).toBe(false);
    const owners = thread.expected.filter(
      (fact) =>
        fact.subject === EVAL_MOMENT_OWNER && !("counterparty" in fact && fact.counterparty !== EVAL_MOMENT_OWNER),
    );
    expect(line?.found).toBe(owners.length);
    expect(report.drops.unresolved_subject).toBeGreaterThanOrEqual(
      thread.expected.filter((fact) => fact.subject !== EVAL_MOMENT_OWNER).length,
    );
    expect(report.passed).toBe(false);
  });

  it("a contact's facts given to the owner are misses and extras: past a fifth of the thread's facts the scenario fails", async () => {
    const theirs = thread.expected.filter(
      (fact) => fact.subject !== EVAL_MOMENT_OWNER && fact.type !== "commitment" && fact.type !== "plan",
    );
    const swap = (n: number) => ({
      ...outputs(ASKED),
      [firstOf(thread)]: {
        claims: thread.expected.map((fact) =>
          theirs.slice(0, n).includes(fact)
            ? claimFor(thread, fact, { subject: EVAL_MOMENT_OWNER })
            : claimFor(thread, fact),
        ),
        narrowing: "none",
      },
    });
    const allowed = Math.floor(thread.expected.length * 0.2 + 1e-9);
    expect((await run(swap(allowed))).scenarios.find((one) => one.scenario === "thread")?.passed).toBe(true);
    expect((await run(swap(allowed + 1))).scenarios.find((one) => one.scenario === "thread")?.passed).toBe(false);
  });

  it("--runs pools the runs: each line the per-run line times the runs, a line for each run, and code's properties in every run", async () => {
    const pooled = await evaluateMomentsPooled({ model: fakeModelClient(outputs(ASKED)) }, 3);
    expect(pooled).toMatchObject({ pooled: 3, each: [true, true, true], passed: true });
    expect(pooled.scenarios.find((one) => one.scenario === "thread")).toMatchObject({
      expected: 3 * thread.expected.length,
      found: 3 * thread.expected.length,
      passed: true,
    });
    const lines = pooledMomentReportLines(pooled);
    expect(lines).toContain("pooled: runs 3 not_gated");
    expect(lines.at(-1)).toBe("result: ok");
    // A run that lost the thread's contact facts fails alone, and is named; the pooled line is the
    // per-run line times the runs, so two good runs carry one such run, and two such runs fail.
    const good = await run(outputs(ASKED));
    const bad = await evaluateMoments(
      { model: fakeModelClient(outputs(ASKED)) },
      ASKED.map((group) => (group === thread ? { ...group, bound: {} } : group)),
    );
    const found = (report: MomentEvalReport) => report.scenarios.find((one) => one.scenario === "thread")?.found ?? 0;
    const line = 3 * Math.ceil(0.8 * thread.expected.length);
    const once = poolMomentReports([good, good, bad]);
    expect(once.each).toEqual([true, true, false]);
    expect(once.scenarios.find((one) => one.scenario === "thread")?.passed).toBe(2 * found(good) + found(bad) >= line);
    const twice = poolMomentReports([good, bad, bad]);
    expect(found(good) + 2 * found(bad)).toBeLessThan(line);
    expect(twice.scenarios.find((one) => one.scenario === "thread")?.passed).toBe(false);
    expect(twice.passed).toBe(false);
  });
});

// The check asks as the lane does. A refused answer is split once, and its shape, never its text,
// is in `--detail`.
describe("a refused answer in the check", () => {
  it("splits the group once, prints each refusal's shape and no word of it, and scores what the halves found", async () => {
    const thread = ASKED.find((group) => group.scenario === "thread") as EvalMomentGroup;
    const lead = (index: number) =>
      openEvalMoment(thread.moments[index] as EvalMomentGroup["moments"][number]).context.evidenceId;
    const half = Math.ceil(thread.moments.length / 2);
    const report = await run({
      ...outputs(ASKED),
      [lead(0)]: "Sorry, I would rather not go through this conversation.",
      [lead(half)]: { claims: [], narrowing: "none" },
    });
    const detail = report.detail.find((one) => one.id === thread.id);
    expect(detail?.rejected).toEqual(["chars 55 first_letter 1 not_json 1", "chars 55 first_letter 1 not_json 1"]);
    // A half refused again: the group is not answered, which tells a refusal from a miss.
    expect(detail?.answered).toBe(false);
    expect(report.failed).toContain(thread.id);
    const lines = meetingDetailLines(report, new Map(), 0);
    expect(lines).toContain("  rejected: chars 55 first_letter 1 not_json 1");
    expect(lines.join("\n")).not.toContain("rather not");
  });
});

// What a pooled live check cannot show: each run's detail line, and a split thread's calls.
describe("the detail lines and the thread's lines", () => {
  it("pooled, each run's detail line shows that run's latency and cost, and the total all of them", async () => {
    const counter = callStatsByRun();
    const fake = fakeModelClient(outputs(ASKED));
    const model: ModelClient = {
      ...fake,
      complete: async (request) => {
        const one = counter.of(request.callKey?.evidenceId ?? "");
        one.ms += 1;
        one.microUsd += 10;
        return fake.complete(request);
      },
    };
    const pooled = await evaluateMomentsPooled({ model, onRun: counter.onRun }, 3);
    const lines = meetingDetailLines(pooled, counter.stats, 0);
    const heads = lines.filter((line) => /^run[123]\//.test(line));
    // One request a group, so each run's line is one call's, never three.
    expect(heads).toHaveLength(3 * ASKED.length);
    for (const line of heads) expect(line).toMatch(/ ms 1 micro_usd 10$/);
    expect(lines.at(-1)).toBe(`total: wall_ms 0 micro_usd ${3 * ASKED.length * 10}`);
    // Unpooled, the stats are by evidence id alone.
    const once = callStatsByRun();
    once.of("ev").ms += 5;
    expect([...once.stats.keys()]).toEqual(["ev"]);
  });

  // A split group's second half is asked under its own first moment's evidence id.
  it("a split group's line counts both halves' calls, pooled under each run", async () => {
    const thread = ASKED.find((group) => group.scenario === "thread") as EvalMomentGroup;
    const lead = (index: number) =>
      openEvalMoment(thread.moments[index] as EvalMomentGroup["moments"][number]).context.evidenceId;
    const half = Math.ceil(thread.moments.length / 2);
    const given = {
      ...outputs(ASKED),
      [lead(0)]: "Sorry, I would rather not go through this conversation.",
      [lead(half)]: { claims: [], narrowing: "none" },
    };
    const single = await run(given);
    const line = (lines: string[], id: string) => lines.find((one) => one.startsWith(`${id}: `));
    expect(
      line(
        meetingDetailLines(
          single,
          new Map([
            [lead(0), { ms: 3, microUsd: 30 }],
            [lead(half), { ms: 4, microUsd: 40 }],
          ]),
          0,
        ),
        thread.id,
      ),
    ).toMatch(/ ms 7 micro_usd 70$/);
    const counter = callStatsByRun();
    const fake = fakeModelClient(given);
    const model: ModelClient = {
      ...fake,
      complete: async (request) => {
        const one = counter.of(request.callKey?.evidenceId ?? "");
        one.ms += 1;
        one.microUsd += 10;
        return fake.complete(request);
      },
    };
    const pooled = await evaluateMomentsPooled({ model, onRun: counter.onRun }, 2);
    const lines = meetingDetailLines(pooled, counter.stats, 0);
    // Three requests a run: the whole group, refused and replayed for its first half, then the second half.
    for (const k of [1, 2]) expect(line(lines, `run${k}/${thread.id}`)).toMatch(/ ms 3 micro_usd 30$/);
  });

  it("--detail prints an affiliation's relation beside its organization: proposed, missed and extra", async () => {
    const group = ASKED.find((one) =>
      one.expected.some((fact) => fact.type === "affiliation" && fact.relation === "alumnus"),
    ) as EvalMomentGroup;
    const fact = group.expected.find(
      (one) => one.type === "affiliation" && one.relation === "alumnus",
    ) as EvalMomentFact & { type: "affiliation" };
    const report = await run({
      ...outputs(ASKED),
      [firstOf(group)]: {
        claims: group.expected.map((one) =>
          one === fact ? claimFor(group, one, { relation: "student" }) : claimFor(group, one),
        ),
        narrowing: "none",
      },
    });
    const lines = meetingDetailLines(report, new Map(), 0);
    const at = lines.findIndex((line) => line.startsWith(`${group.id}: `));
    const own = lines.slice(at + 1).filter((_line, n, all) => all.slice(0, n + 1).every((one) => one.startsWith("  ")));
    expect(own).toContain(`  missed: affiliation "${fact.organization}" relation alumnus`);
    expect(own).toContain(`  extra: affiliation "${fact.organization}" relation "student"`);
    expect(
      own.some(
        (line) =>
          line.startsWith(`  proposed: "affiliation" `) && line.includes(`"${fact.organization}" relation "student" `),
      ),
    ).toBe(true);
    // Every other kind's line is as it was: no relation.
    expect(
      own
        .filter((line) => line.startsWith("  proposed:") && !line.startsWith(`  proposed: "affiliation"`))
        .every((line) => !line.includes(" relation ")),
    ).toBe(true);
  });

  it("the thread's lines hold no phrasing removed from its expected facts", () => {
    const thread = ASKED.find((group) => group.scenario === "thread") as EvalMomentGroup;
    const text = thread.moments.map((item) => item.text).join("\n");
    expect(text).toContain("I am between apartments right now.");
    expect(text).toContain("I cannot work more than ten hours a week.");
    expect(text).not.toContain("staying with my sister");
    expect(text).not.toContain("ten hours a week on it");
  });
});

// Chats read from Messages' own database, their contacts by phone handles bound through saved
// contacts, gated as `thread` is.
describe("the imessage scenario", () => {
  const groups = ASKED.filter((group) => group.scenario === "imessage");
  const [pair, crew, typed, drawn, days, short, texting] = groups as [
    EvalMomentGroup,
    EvalMomentGroup,
    EvalMomentGroup,
    EvalMomentGroup,
    EvalMomentGroup,
    EvalMomentGroup,
    EvalMomentGroup,
  ];

  it("a one-to-one thread of about 6 000 characters in two source moments and a group chat of two contacts, every turn a message with its time, the contacts handles with no name", () => {
    // And a chat as people type one, one with emoji, a thread over two days, a session of one short
    // line, a chat typed as texting, and short-term lines beside a commitment, a plan and a lasting
    // state.
    expect(groups).toHaveLength(8);
    expect(groups.at(-1)?.expected.map((fact) => fact.type)).toEqual(["situation", "plan", "commitment"]);
    const chars = pair.moments.reduce((sum, item) => sum + item.text.length, 0);
    expect(chars).toBeGreaterThanOrEqual(5_500);
    expect(chars).toBeLessThanOrEqual(6_500);
    expect(pair.moments).toHaveLength(2);
    for (const group of groups) {
      for (const item of group.moments) {
        expect(MomentItem.safeParse(item).success, item.key).toBe(true);
        expect(item).toMatchObject({ read: "db", source: "imessage", entity: "chat" });
        expect(item.turns?.length).toBe(item.text.split("\n").length);
        expect(item.turns?.every((turn) => turn.at !== undefined)).toBe(true);
        expect(
          item.participants.every(
            (one) => one.handle !== undefined && one.name === undefined && one.address === undefined,
          ),
        ).toBe(true);
        expect(item.text).not.toContain("@");
      }
      // One thread key for each chat, across its sessions.
      expect(new Set(group.moments.map((item) => item.threadKey)).size).toBe(1);
      expect(Object.keys(group.bound ?? {}).sort()).toEqual(
        group.moments[0]?.participants.map((one) => one.handle).sort(),
      );
    }
    // The first line is hours before the rest, so its own time shows.
    const first = pair.moments[0];
    expect(Date.parse(first?.turns?.[1]?.at ?? "") - Date.parse(first?.turns?.[0]?.at ?? "")).toBeGreaterThanOrEqual(
      4 * 3_600_000,
    );
    expect(crew.moments[0]?.participants).toHaveLength(2);
    expect(
      crew.expected.some(
        (fact) =>
          fact.type === "commitment" && fact.subject !== EVAL_MOMENT_OWNER && fact.counterparty !== EVAL_MOMENT_OWNER,
      ),
    ).toBe(true);
  });

  // Real sessions are typed as people type; this chat is, and its owner's question naming a week is
  // no fact, so a plan taken from it is an extra.
  it("the typed chat has lines in lower case with no final stop, two owner messages as one passage, and a plan from the owner's question is an extra", async () => {
    const lines = typed.moments.flatMap((item) => item.text.split("\n"));
    expect(lines.filter((line) => /^[a-z]/u.test(line)).length).toBeGreaterThanOrEqual(lines.length - 1);
    expect(lines.filter((line) => !/[.!?]$/u.test(line)).length).toBeGreaterThanOrEqual(6);
    for (const mark of ["’", "\u{1F605}", "ok "]) expect(typed.moments[0]?.text).toContain(mark);
    const plan = planOf(typed);
    const first = plan.passages[0];
    expect(first?.speaker).toBe("owner");
    expect(first?.opened.item.text.slice(first.range.from, first.range.to)).toBe(`${lines[0]}\n${lines[1]}`);
    const question = lines.find((line) => line.endsWith("?")) as string;
    expect(typed.expected.some((fact) => saidOf(fact) === question)).toBe(false);
    const extra = {
      type: "plan",
      subject: { key: { kind: "source_id", value: "speaker:owner" }, observedAt: first?.opened.capture.observedAt },
      fields: {
        counterparty: { key: { kind: "source_id", value: "speaker:P1" }, observedAt: first?.opened.capture.observedAt },
        what: question,
        when: "2026-12-26",
      },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: plan.passages.find((one) => one.opened.item.text.slice(one.range.from, one.range.to) === question)?.span,
    };
    const report = await run(outputs(ASKED, { extra: { [typed.id]: [extra] } }));
    expect(report.scenarios.find((one) => one.scenario === "imessage")?.extra).toBe(1);
  });

  // The drops seen on typed chats, by shape: each fact copied as a model copies it (an emoji left
  // out between two messages' words, a selector left off, a final stop added, a rule with emoji
  // among its words copied whole) is kept, each credited to its speaker.
  it("the emoji chat's facts, each copied as a model copies a typed line, are all kept and credited", async () => {
    const copied: Record<string, Record<string, unknown>> = {
      "only do weekends \u{1F629}\nbc of work": { phrase: "only do weekends bc of work" },
      "run the \u{2615}\u{FE0F} cart": { phrase: "run the \u{2615} cart" },
      "a bigger studio": { phrase: "a bigger studio." },
    };
    const plan = planOf(drawn);
    expect(
      plan.passages.map((one) => [
        one.speaker,
        one.opened.item.turns?.filter((turn) => turn.from < one.range.to && turn.to > one.range.from).length,
      ]),
    ).toEqual([
      ["owner", 2],
      ["P1", 1],
      ["owner", 1],
      ["P1", 2],
      ["owner", 1],
      ["P1", 1],
    ]);
    const given = outputs(ASKED);
    given[firstOf(drawn)] = {
      claims: drawn.expected.map((fact) => claimFor(drawn, fact, copied[saidOf(fact)] ?? {})),
      narrowing: "none",
    };
    const report = await run(given);
    const line = report.scenarios.find((one) => one.scenario === "imessage");
    expect(line).toMatchObject({ found: line?.expected, extra: 0, passed: true });
  });

  // Each key phrase of the texting chat copied as a model tidies it (case, an apostrophe added,
  // "with" for "w/", "and" for "&", "you" for "u", "people" for "ppl" and a letter put back) is
  // kept as the chat's own words, matched by its fact key, and credited to its speaker;
  // moment_checked's counts name the rule each needed.
  it("the texting chat's facts, each copied tidied, are all kept as the chat's own words and credited", async () => {
    const tidied: Record<string, Record<string, unknown>> = {
      "Training For A Half Marathon w/ my sister": { phrase: "training for a half marathon with my sister" },
      "cant run anymore": { phrase: "can't run anymore" },
      "a physio who knows knees & backs": { phrase: "a physio who knows knees and backs" },
      "Run The Lisbon Marathon With U": { phrase: "run the Lisbon marathon with you" },
      "realy good at pacing ppl": { phrase: "really good at pacing people" },
    };
    expect(Object.keys(tidied).sort()).toEqual(texting.expected.map(saidOf).sort());
    for (const line of texting.moments.flatMap((item) => item.text.split("\n"))) expect(line).not.toMatch(/['’]/u);
    const given = outputs(ASKED);
    given[firstOf(texting)] = {
      claims: texting.expected.map((fact) => claimFor(texting, fact, tidied[saidOf(fact)] ?? {})),
      narrowing: "none",
    };
    const report = await run(given);
    const line = report.scenarios.find((one) => one.scenario === "imessage");
    expect(line).toMatchObject({ found: line?.expected, extra: 0, passed: true });
    expect(report.credited.right).toBe(report.credited.found);
    expect(report.drops).toMatchObject({ texting_abbreviation: 3, texting_apostrophe: 1, texting_one_edit: 1 });
    // Copied as typed, nothing needs a rule.
    expect(Object.keys((await run(outputs(ASKED))).drops).filter((code) => code.startsWith("texting_"))).toEqual([]);
  });

  it("the slot shows each bound contact's name and no handle", () => {
    const plan = planOf(crew);
    const slot = plan.data.moments;
    expect((JSON.parse(slot) as { participants: unknown }).participants).toEqual([
      { label: "P1", name: "Omar Reyes" },
      { label: "P2", name: "Theo Marsh" },
    ]);
    for (const handle of Object.keys(crew.bound ?? {})) expect(slot).not.toContain(handle);
  });

  // The lane asks a thread's due days together, so the two-day thread is one request whose second
  // day's promise ("it") rests on the first's; a one-line session the screen's floor would skip is
  // asked.
  it("the two-day thread is one request of two days' sessions, and the one-line session is asked though under 200 code points", async () => {
    const plan = planOf(days);
    expect(new Set(days.moments.map((item) => item.observedAt.slice(0, 10))).size).toBe(2);
    expect(plan.sent).toHaveLength(2);
    expect(
      (JSON.parse(plan.data.moments) as { moments: { seen: string }[] }).moments.map((one) => one.seen.slice(0, 10)),
    ).toEqual(days.moments.map((item) => item.observedAt.slice(0, 10)));
    expect(days.moments[0]?.text).toContain("ladder");
    expect(days.expected.every((fact) => !saidOf(fact).includes("ladder"))).toBe(true);
    expect(short.moments).toHaveLength(1);
    expect([...(short.moments[0]?.text ?? "")].length).toBeLessThan(MOMENT_MIN_CHARS);
    expect(askedByLane(short)).toBe(true);
    const report = await run(outputs(ASKED));
    expect(report.detail.some((one) => one.id === short.id)).toBe(true);
  });

  // A contact's fact about a handle no person holds is held, not dropped.
  it("unbound, the contacts' facts are held and the scenario fails, while the owner's own are kept", async () => {
    const unbound = ASKED.map((group) => (group.scenario === "imessage" ? { ...group, bound: {} } : group));
    const report = await evaluateMoments({ model: fakeModelClient(outputs(ASKED)) }, unbound);
    const line = report.scenarios.find((one) => one.scenario === "imessage");
    expect(line?.passed).toBe(false);
    expect(report.drops.held).toBeGreaterThan(0);
    expect(report.drops.unresolved_subject ?? 0).toBe(0);
    const owners = groups
      .flatMap((group) => group.expected)
      .filter(
        (fact) =>
          fact.subject === EVAL_MOMENT_OWNER && !("counterparty" in fact && fact.counterparty !== EVAL_MOMENT_OWNER),
      );
    expect(line?.found).toBe(owners.length);
    expect(report.passed).toBe(false);
  });
});
