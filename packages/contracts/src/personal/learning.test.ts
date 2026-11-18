import {
  BoardView,
  ClientStats,
  DECISION_DETAILS,
  DecideArgs,
  ForecastSource,
  HarmKind,
  HeadlineWeek,
  JUDGMENT_SILENCES,
  OpportunityKind,
  OUTCOME_CHECKS,
  OUTCOME_LINK_DAYS,
  OUTCOME_SETTLE_DAYS,
  OutcomeCheck,
  OutcomeResult,
  OwnerDecisionKind,
  ReplayReport,
  ResultKind,
  RungReport,
  ScoreReport,
  SilenceReason,
  SilenceVerdict,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The learning contracts: the worked examples parse, and every strict shape refuses an unknown key.
// Made-up values only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const details = (kind: OwnerDecisionKind) => DECISION_DETAILS[kind] ?? z.strictObject({});

const interval = { low: 0.2, high: 0.7 };
const harm = {
  marked: { unwanted: 1, wrong_fact: 0, wrong_recipient: 0, exposure: 0, other: 2 },
  correctedAfterItLeft: 1,
  exposures: 0,
  reveals: 3,
};
const week = {
  week: "2026-03-02",
  acted: 4,
  cards: 9,
  labelled: 3,
  undeliberate: 1,
  reviewMinutes: 12.5,
  unmeasured: 2,
  silenceWeeksUnsampled: 0,
  harm,
};

describe("learning contracts", () => {
  it("the closed words are exactly the expected ones", () => {
    expect(HarmKind.options).toEqual(["unwanted", "wrong_fact", "wrong_recipient", "exposure", "other"]);
    expect(SilenceVerdict.options).toEqual(["missed", "fine"]);
    expect(OutcomeCheck.options).toEqual(["answered", "done"]);
    // The shared contracts' `unknown` is not a row here: a case not yet assessed has no row.
    expect(OutcomeResult.options).toEqual(["met", "not_met"]);
    expect(ResultKind.options).toEqual(["reply", "meeting"]);
  });

  it("the judgment silences are three of the silence reasons, and frozen", () => {
    expect(JUDGMENT_SILENCES).toEqual(["nothing_to_do", "below_bar", "waiting_is_better"]);
    for (const reason of JUDGMENT_SILENCES) expect(SilenceReason.options).toContain(reason);
    expect(Object.isFrozen(JUDGMENT_SILENCES)).toBe(true);
  });

  it("OUTCOME_CHECKS holds the send and every opportunity kind but owner_question, with R11's checks and horizons, and is frozen", () => {
    // Nor research, which closes when its gap fills, or an introduction, whose result is the
    // owner's confirmed connection.
    expect(Object.keys(OUTCOME_CHECKS).sort()).toEqual(
      [
        "send",
        ...OpportunityKind.options.filter(
          (kind) => kind !== "owner_question" && kind !== "research" && kind !== "introduction",
        ),
      ].sort(),
    );
    expect(OUTCOME_CHECKS.send).toEqual({ check: "answered", from: "send", horizonDays: 14 });
    for (const kind of ["follow_up", "reply"] as const)
      expect(OUTCOME_CHECKS[kind]).toEqual({ check: "answered", from: "first_send", horizonDays: 14 });
    // The event's start is the horizon: no number of days.
    expect(OUTCOME_CHECKS.meeting_prep).toEqual({ check: "done", from: "event_start", horizonDays: null });
    // The due time, else 30 days after the go.
    for (const kind of ["investigate", "goal_step", "life_admin"] as const)
      expect(OUTCOME_CHECKS[kind]).toEqual({ check: "done", from: "due_or_go", horizonDays: 30 });
    expect(Object.isFrozen(OUTCOME_CHECKS)).toBe(true);
    expect(Object.isFrozen(OUTCOME_CHECKS.send)).toBe(true);
    expect([OUTCOME_LINK_DAYS, OUTCOME_SETTLE_DAYS]).toEqual([30, 3]);
  });

  it("a forecast source is a lower snake case word", () => {
    for (const source of ["owner", "run", "forecast_point"]) expect(accepts(ForecastSource, source), source).toBe(true);
    for (const source of ["Owner", "", "a source", "1run", "x".repeat(33)])
      expect(accepts(ForecastSource, source), source).toBe(false);
  });

  it("a headline week parses, its harm counts every kind, and it refuses an unknown key, a negative count and a week that is not a Monday", () => {
    expect(accepts(HeadlineWeek, week)).toBe(true);
    expect(accepts(HeadlineWeek, { ...week, reviewMinutes: 0 })).toBe(true);
    expect(accepts(HeadlineWeek, { ...week, note: "x" })).toBe(false);
    expect(accepts(HeadlineWeek, { ...week, harm: { ...harm, consentFailures: 0 } })).toBe(false);
    expect(accepts(HeadlineWeek, { ...week, harm: { ...harm, marked: { ...harm.marked, rude: 1 } } })).toBe(false);
    const { other: _other, ...missing } = harm.marked;
    expect(accepts(HeadlineWeek, { ...week, harm: { ...harm, marked: missing } })).toBe(false);
    for (const field of ["acted", "cards", "labelled", "undeliberate", "unmeasured", "silenceWeeksUnsampled"]) {
      expect(accepts(HeadlineWeek, { ...week, [field]: -1 }), field).toBe(false);
      expect(accepts(HeadlineWeek, { ...week, [field]: 1.5 }), field).toBe(false);
    }
    expect(accepts(HeadlineWeek, { ...week, reviewMinutes: -0.5 })).toBe(false);
    const { reviewMinutes: _minutes, ...noMinutes } = week;
    const { harm: _harm, ...noHarm } = week;
    expect(accepts(HeadlineWeek, noMinutes)).toBe(false);
    expect(accepts(HeadlineWeek, noHarm)).toBe(false);
    // A Tuesday, and a day that is not a date.
    expect(accepts(HeadlineWeek, { ...week, week: "2026-03-03" })).toBe(false);
    expect(accepts(HeadlineWeek, { ...week, week: "2026-02-30" })).toBe(false);
  });

  it("a score report holds counts, scores, bands and intervals only; insufficient below 10 cases has no score", () => {
    const band = { from: 0.5, to: 0.8, count: 6, meanProbability: 0.62, shareMet: 0.5, interval };
    const scored = { source: "run", promptVersion: 3, count: 12, insufficient: false, brier: 0.21, bands: [band] };
    const share = { count: 8, met: 5, share: 0.625, interval, undeliberate: 1 };
    const report = {
      from: at,
      to: at,
      forecasts: [
        scored,
        { source: "owner", promptVersion: null, count: 4, insufficient: true, brier: null, bands: [] },
      ],
      owner: share,
      rungZero: { ...share, undeliberate: 0 },
    };
    expect(accepts(ScoreReport, report)).toBe(true);
    expect(accepts(ScoreReport, { ...report, text: "x" })).toBe(false);
    expect(accepts(ScoreReport, { ...report, forecasts: [{ ...scored, owner: "x" }] })).toBe(false);
    expect(accepts(ScoreReport, { ...report, forecasts: [{ ...scored, bands: [{ ...band, label: "x" }] }] })).toBe(
      false,
    );
    // Under 10 cases: insufficient and no score; at 10 or more, a score.
    expect(accepts(ScoreReport, { ...report, forecasts: [{ ...scored, count: 9 }] })).toBe(false);
    expect(accepts(ScoreReport, { ...report, forecasts: [{ ...scored, insufficient: true }] })).toBe(false);
    expect(accepts(ScoreReport, { ...report, forecasts: [{ ...scored, brier: 1.2 }] })).toBe(false);
    // An interval is a pair of shares, low first.
    expect(accepts(ScoreReport, { ...report, owner: { ...share, interval: { low: 0.8, high: 0.2 } } })).toBe(false);
    expect(
      accepts(ScoreReport, { ...report, owner: { ...share, share: null, interval: null, count: 0, met: 0 } }),
    ).toBe(true);
  });

  it("client statistics hold a client id, counts, shares and intervals only", () => {
    const counted = { count: 3, share: 0.3, interval };
    const stats = {
      client: `cli_${ULID}`,
      from: at,
      to: at,
      claims: 10,
      corroborated: counted,
      disputed: { count: 0, share: 0, interval: { low: 0, high: 0.3 } },
      retracted: counted,
      unconfirmed: counted,
      records: 12,
      flagged: 1,
      tainted: 0,
      echoes: null,
    };
    expect(accepts(ClientStats, stats)).toBe(true);
    expect(accepts(ClientStats, { ...stats, echoes: 2 })).toBe(true);
    expect(accepts(ClientStats, { ...stats, name: "hermes" })).toBe(false);
    expect(accepts(ClientStats, { ...stats, client: "hermes" })).toBe(false);
    expect(accepts(ClientStats, { ...stats, corroborated: { ...counted, claims: [] } })).toBe(false);
  });

  it("a rung report holds a point, a version, a rung and counts; rung 1 carries J2's latest report as is", () => {
    const row = {
      point: "run_outcome",
      version: 2,
      rung: 3,
      from: at,
      to: at,
      calls: 20,
      decided: 15,
      escalated: 5,
      judged: 6,
      agree: 4,
      share: 0.67,
      interval,
      scored: true,
      calibration: null,
    };
    expect(accepts(RungReport, row)).toBe(true);
    expect(
      accepts(RungReport, { ...row, rung: 0, judged: 0, agree: 0, share: null, interval: null, scored: false }),
    ).toBe(true);
    expect(accepts(RungReport, { ...row, rung: 1, calibration: { at, agreement: 0.9, agreement28d: null } })).toBe(
      true,
    );
    expect(accepts(RungReport, { ...row, rung: 5 })).toBe(false);
    expect(accepts(RungReport, { ...row, point: "Run outcome" })).toBe(false);
    expect(accepts(RungReport, { ...row, verdicts: [] })).toBe(false);
    expect(accepts(RungReport, { ...row, calibration: { at, agreement: 0.9, agreement28d: null, bands: {} } })).toBe(
      false,
    );
  });

  it("the personal replay report is counts only, adapted from the shared one", () => {
    const report = { from: at, to: at, client: null, decisions: 10, agree: 8, differ: 1, generationChanged: 1 };
    expect(accepts(ReplayReport, report)).toBe(true);
    expect(accepts(ReplayReport, { ...report, client: `cli_${ULID}` })).toBe(true);
    expect(accepts(ReplayReport, { ...report, rule: "x" })).toBe(false);
    expect(accepts(ReplayReport, { ...report, differ: -1 })).toBe(false);
  });

  it("a board lists open opportunities by their latest status, and counts the closed ones", () => {
    const item = { id: `opp_${ULID}`, kind: "follow_up", dueAt: null, summary: "Write back about the quay" };
    const board = {
      columns: [
        { status: "go", items: [item] },
        { status: "proposed", items: [] },
      ],
      closed: { done: 2, noGo: 1 },
    };
    expect(accepts(BoardView, board)).toBe(true);
    expect(accepts(BoardView, { ...board, columns: [{ status: "done", items: [] }] })).toBe(false);
    expect(accepts(BoardView, { ...board, columns: [{ status: "go", items: [{ ...item, owner: "x" }] }] })).toBe(false);
    expect(accepts(BoardView, { ...board, columns: [{ status: "go", items: [{ ...item, id: `msg_${ULID}` }] }] })).toBe(
      false,
    );
    expect(accepts(BoardView, { ...board, rows: [] })).toBe(false);
  });

  it("the nine decision kinds, after the earlier ones", () => {
    // The kinds added later come after the nine.
    const at = OwnerDecisionKind.options.indexOf("card_label");
    expect(OwnerDecisionKind.options.slice(at, at + 9)).toEqual([
      "card_label",
      "silence_verdict",
      "harm",
      "harm_lift",
      "intent_confirm",
      "intent_revoke",
      "harness_grant",
      "harness_revoke",
      "combining_grant",
    ]);
  });

  it("each new kind's details parse with its schema, strict; the others take only the empty object", () => {
    expect(accepts(details("silence_verdict"), { hurried: false })).toBe(true);
    expect(accepts(details("silence_verdict"), { hurried: true })).toBe(true);
    expect(accepts(details("silence_verdict"), {})).toBe(false);
    expect(accepts(details("silence_verdict"), { hurried: true, verdict: "missed" })).toBe(false);
    for (const kind of HarmKind.options) expect(accepts(details("harm"), { kind }), kind).toBe(true);
    expect(accepts(details("harm"), { kind: "rude" })).toBe(false);
    expect(accepts(details("harm"), { kind: "other", note: "x" })).toBe(false);
    expect(accepts(details("intent_confirm"), {})).toBe(true);
    expect(accepts(details("intent_confirm"), { proposal: `prp_${ULID}` })).toBe(true);
    expect(accepts(details("intent_confirm"), { proposal: `int_${ULID}` })).toBe(false);
    expect(accepts(details("intent_confirm"), { proposal: `prp_${ULID}`, goal: "x" })).toBe(false);
    expect(accepts(details("combining_grant"), { compartments: ["own"] })).toBe(true);
    expect(accepts(details("combining_grant"), { compartments: ["employer:example", "own"] })).toBe(true);
    expect(accepts(details("combining_grant"), { compartments: [] })).toBe(false);
    expect(accepts(details("combining_grant"), { compartments: ["own", "employer:example"] })).toBe(false);
    expect(accepts(details("combining_grant"), { compartments: ["own", "own"] })).toBe(false);
    expect(accepts(details("combining_grant"), { compartments: ["nowhere"] })).toBe(false);
    for (const kind of ["card_label", "harm_lift", "intent_revoke", "harness_grant", "harness_revoke"] as const) {
      expect(DECISION_DETAILS[kind], kind).toBeUndefined();
      expect(accepts(details(kind), {}), kind).toBe(true);
      expect(accepts(details(kind), { hurried: false }), kind).toBe(false);
    }
  });

  it("decide arguments take an expectation on one card only, from 0 to 1 with at most two decimals", () => {
    const decide = { cards: [`crd_${ULID}`], answer: "go", requestId: "req-0001" };
    for (const expect_ of [0, 0.35, 0.29, 1])
      expect(accepts(DecideArgs, { ...decide, expect: expect_ }), String(expect_)).toBe(true);
    for (const expect_ of [-0.01, 1.01, 0.355, Number.NaN])
      expect(accepts(DecideArgs, { ...decide, expect: expect_ }), String(expect_)).toBe(false);
    const two = { ...decide, cards: [`crd_${ULID}`, `crd_${ULID.slice(0, 25)}1`] };
    expect(accepts(DecideArgs, two)).toBe(true);
    expect(accepts(DecideArgs, { ...two, expect: 0.5 })).toBe(false);
    expect(accepts(DecideArgs, { ...decide, expect: 0.5, comment: "x" })).toBe(false);
  });
});
