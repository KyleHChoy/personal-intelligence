import type { OpenedMoment } from "@intelligence/contracts/personal";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import type { RunCore } from "./config.ts";
import { EXTRACT_GENERATION } from "./config.ts";
import { interpret, passesThrough } from "./interpret.ts";
import { withheldBy } from "./lane-check.ts";
import { noteGroup } from "./moments.ts";
import { checkMoments } from "./moments-check.ts";
import { type MomentMember, type MomentPassage, planMoments } from "./moments-plan.ts";
import { ownLinesMoment } from "./own-lines.ts";
import { ownLinesPrompt } from "./prompts.ts";
import { codeOf } from "./trial.ts";

// `pi extract trial --own-lines [--sample N] [--show TYPES]`: before the switch is on, the newest
// groups of agent-app moments committed `agent_app` that hold lines of the owner's are asked the lane's
// prompt through the saved calls, checked in memory, and nothing else is written: no claim, no status
// and no belief. The owner reads what the lane would keep. Its spend is under the lane's prompt, so it
// counts toward that day's line, and no run replays it (a retry deletes the saved call).

type OwnLinesTrialReport = {
  groups: number;
  moments: number;
  live: number;
  failed: number;
  kept: number;
  // Claims kept by type, and refused by the check's code.
  claims: Record<string, number>;
  drops: Record<string, number>;
  // With `--show`: each kept claim of the types named (`all`: every type), in words of the source,
  // printed to a terminal only.
  shown?: { group: number; lines: string[] }[];
  stopped: string | null;
};

// However large the sample, the trial reads no more than this many candidates: most of an agent
// app's older moments hold no turn, and each is opened to find out.
const CANDIDATES = 2_000;

const bump = (counts: Record<string, number>, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};

export async function runOwnLinesTrial(
  deps: Pick<RunCore, "store" | "model" | "modelId" | "compartments" | "generation">,
  sample: number,
  options: { show?: readonly string[] } = {},
): Promise<OwnLinesTrialReport | "already_running"> {
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const show = new Set(options.show ?? []);
  let live = 0;
  const model: ModelClient = {
    complete: (request) => {
      live += 1;
      return deps.model.complete(request);
    },
    embed: (request) => deps.model.embed(request),
  };
  return deps.store.withExtractLock(async () => {
    const report: OwnLinesTrialReport = {
      groups: 0,
      moments: 0,
      live: 0,
      failed: 0,
      kept: 0,
      claims: {},
      drops: {},
      ...(show.size > 0 ? { shown: [] } : {}),
      stopped: null,
    };
    const groups = await deps.store.ownLineCandidates(CANDIDATES, {
      ...(deps.compartments === undefined ? {} : { compartments: deps.compartments }),
    });
    for (const group of groups) {
      if (report.groups >= sample) break;
      const part: { opened: OpenedMoment; member: MomentMember }[] = [];
      for (const member of group.moments ?? [group]) {
        try {
          const opened = await deps.store.openMoment(member.evidenceId);
          if (opened !== null && ownLinesMoment(opened, member.lane)) part.push({ opened, member });
        } catch {
          // One moment that does not open ends that moment, as a run's would, and not the sample.
          report.failed += 1;
        }
      }
      const plan = part.length === 0 ? null : planMoments(part, true, ownLinesPrompt(), true);
      const first = plan?.sent[0] as MomentPassage | undefined;
      if (plan === null || first === undefined) continue;
      report.groups += 1;
      report.moments += plan.sent.length;
      const ids = plan.sent.map((passage) => passage.member.evidenceId);
      try {
        const { output } = await interpret(plan.prompt, plan.data, first.parsed, first.read, {
          model: noteGroup(model, deps, ids),
          calls: deps.store.calls(deps.modelId, ids),
        });
        // A narrowing that withholds ends the group in a run, so nothing of it would be kept.
        if (withheldBy(output.narrowing) !== undefined) {
          bump(report.drops, `withheld_${output.narrowing}`);
          continue;
        }
        const checked = await checkMoments(output, plan, generation);
        const lines: string[] = [];
        for (const drop of checked.drops) bump(report.drops, drop.code);
        for (const found of checked.found.values())
          for (const record of found.claims) {
            const { type, fields } = record.claim.content;
            bump(report.claims, type);
            report.kept += 1;
            if (show.has("all") || show.has(type)) lines.push(`${type} ${JSON.stringify(fields)}`);
          }
        if (lines.length > 0) report.shown?.push({ group: report.groups, lines: lines.sort() });
      } catch (error) {
        if (passesThrough(error)) {
          report.stopped = codeOf(error);
          break;
        }
        if (!(error instanceof ExtractFailure)) throw error;
        report.failed += 1;
      }
    }
    report.live = live;
    return report;
  });
}

const countsLine = (counts: Record<string, number>): string => {
  const list = Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, n]) => `${key} ${n}`);
  return list.length === 0 ? "none" : list.join(", ");
};

// Counts, and with `--show` the kept claims' own words.
export function ownLinesTrialLines(report: OwnLinesTrialReport, costMicroUsd: number): string[] {
  return [
    `groups: ${report.groups} moments ${report.moments} live ${report.live} failed ${report.failed} cost_microusd ${costMicroUsd}`,
    `claims: ${report.kept} (${countsLine(report.claims)})`,
    `drops: ${countsLine(report.drops)}`,
    `stopped: ${report.stopped ?? "none"}`,
    ...(report.shown ?? []).flatMap((one) => [`show: group ${one.group}`, ...one.lines.map((line) => `  ${line}`)]),
  ];
}
