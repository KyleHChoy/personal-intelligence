// What the meeting evaluation prints: the report's and the pooled report's lines, the drop tally,
// each item's calls' latency and cost, and `--detail`'s lines.

import type { CaptureTally } from "../capture-check.ts";
import { type MeetingDetail, type MeetingFactShape, runKey, shapeText } from "./eval-facts.ts";
import type { MeetingEvalReport, PooledMeetingReport } from "./eval-meetings.ts";
import { pooledLines, scenarioLineText, setLineText, typeLineText } from "./eval-score.ts";

// The pooled report's lines: the evaluation's own, then the number of runs pooled and each
// systematic shape, by meeting, role and due day, no word of the set.
export function pooledMeetingReportLines(report: PooledMeetingReport): string[] {
  return pooledLines(meetingReportLines(report), report);
}

export const dropsText = (drops: CaptureTally): string => {
  const { candidates = 0, kept = 0, ...rest } = drops;
  return [
    `candidates ${candidates}`,
    `kept ${kept}`,
    ...Object.entries(rest)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, n]) => `${code} ${n}`),
  ].join(" ");
};

// What `pi extract check --world --lane meeting` prints: counts, codes and the set's own meeting
// ids, and no text.
export function meetingReportLines(report: MeetingEvalReport): string[] {
  return [
    ...report.types.map(typeLineText),
    setLineText("meetings", report.meetings, report),
    `deck: ${report.deck ? "ok" : "failed"}`,
    `runs: expected ${report.runs.expected} found ${report.runs.found} not_gated`,
    `credit: fragmented ${report.credit.fragmented} unreliable ${report.credit.unreliable} missed ${report.credit.missed.length === 0 ? "none" : report.credit.missed.join(",")} assigned ${report.credit.assigned} wrong ${report.credit.wrong} owner_word ${report.credit.owned} gated ${report.credit.passed ? "ok" : "failed"}`,
    ...report.scenarios.map(scenarioLineText),
    `windows: most ${report.windows} not_gated`,
    ...report.paired.map(
      (one) =>
        `paired ${one.id}: facts ${one.facts} clean ${one.clean} fragmented ${one.found} difference ${one.clean - one.found} not_gated`,
    ),
    `agreement: domain ${report.agreement.domainsAgree} of ${report.agreement.domains} due ${report.agreement.duesAgree} of ${report.agreement.dues} key_drift ${report.agreement.keyDrift} repeats ${report.repeats} not_gated`,
    `drops: ${dropsText(report.drops)}`,
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}

// `--detail`'s lines (the synthetic set only, so its roles and due days may be printed): one per
// meeting, with the calls' latency and cost the caller measured for it, then the totals.
type MeetingCallStats = { ms: number; microUsd: number };
// Each item's calls' latency and cost, by evidence id; once a pooled check calls `onRun`, by run
// too, so each run's detail line shows that run's numbers and the total every run's. A call counts
// under the run last announced, so it holds while runs are asked one after another, as the pooled
// evaluations ask them.
export function callStatsByRun(): {
  stats: ReadonlyMap<string, MeetingCallStats>;
  of: (evidenceId: string) => MeetingCallStats;
  onRun: (run: number) => void;
} {
  const stats = new Map<string, MeetingCallStats>();
  let run: number | undefined;
  return {
    stats,
    onRun: (next) => {
      run = next;
    },
    of: (evidenceId) => {
      const id = run === undefined ? evidenceId : runKey(run, evidenceId);
      const one = stats.get(id) ?? { ms: 0, microUsd: 0 };
      stats.set(id, one);
      return one;
    },
  };
}
const shapesText = (shapes: MeetingFactShape[]): string =>
  shapes.length === 0 ? "none" : shapes.map(shapeText).join(",");

export function meetingDetailLines(
  report: { detail: readonly MeetingDetail[] },
  stats: ReadonlyMap<string, MeetingCallStats>,
  wallMs: number,
): string[] {
  const zero: MeetingCallStats = { ms: 0, microUsd: 0 };
  const total = [...stats.values()].reduce((sum, one) => sum + one.microUsd, 0);
  return [
    ...report.detail.flatMap((one) => {
      const call = (one.evidenceIds ?? [one.evidenceId])
        .map((id) => stats.get(id) ?? zero)
        .reduce((sum, each) => ({ ms: sum.ms + each.ms, microUsd: sum.microUsd + each.microUsd }), zero);
      return [
        `${one.id}: expected ${one.expected} matched ${one.matched}${one.answered ? "" : " not_answered"} missed ${shapesText(one.missed)} extra ${shapesText(one.extra)} ms ${call.ms} micro_usd ${call.microUsd}`,
        // The synthetic set's own words, where they went.
        ...(one.drops === undefined ? [] : [`  drops: ${dropsText(one.drops)}`]),
        // Every value a model wrote is printed as a JSON string, so no line break or control
        // character in it can make a line of its own.
        ...(one.proposals ?? []).map((proposal) =>
          [
            "  proposed:",
            proposal.type,
            JSON.stringify(proposal.subject),
            JSON.stringify(proposal.said),
            proposal.relation === undefined ? "" : `relation ${JSON.stringify(proposal.relation)}`,
            proposal.domain,
            JSON.stringify(proposal.span),
            "->",
            proposal.outcome,
          ]
            .filter((part) => part !== "")
            .join(" "),
        ),
        ...(one.missedSaid ?? []).map((text) => `  missed: ${text}`),
        ...(one.extraSaid ?? []).map((text) => `  extra: ${text}`),
        ...(one.rejected ?? []).map((text) => `  rejected: ${text}`),
      ];
    }),
    `total: wall_ms ${wallMs} micro_usd ${total}`,
  ];
}
