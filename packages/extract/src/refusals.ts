import type { ClaimCandidate } from "@intelligence/contracts";
import type { BacklogItem, MessageLane, OpenedItem } from "@intelligence/contracts/personal";
import { segmentAt } from "@intelligence/personal-core";
import type { Prompt } from "@intelligence/personal-models";
import { doneOrder } from "./asked-version.ts";
import { ExtractFailure } from "./call-failure.ts";
import type { PersonalUnmapped } from "./check.ts";
import { EXTRACT_GENERATION, type RunCore } from "./config.ts";
import { fieldsDetail } from "./fields-detail.ts";
import { interpret, REPLAY_ONLY, readStored } from "./interpret.ts";
import { checkMessageClaims, messageCandidates } from "./lane-check.ts";
import { PROMPT_IDS } from "./message-prompts.ts";
import { messageProject, messageProjectData, withMessageProject } from "./project-named.ts";
import { promptAt } from "./prompts.ts";
import { wordingCodes } from "./refused.ts";
import { routedDue } from "./triage.ts";

// `pi extract refusals [--sample N] [--show]`: the owner's own refused candidates, read again. The
// N newest messages with a refused candidate replay their saved answers, at no cost and with no
// request, through today's check with the repair off and on, one candidate at a time; nothing is
// written. Counts and code words by default, so the owner reads how much of what was refused the
// repair would keep before setting PI_EXTRACT_REPAIR. `--show` adds, to a terminal only, what each
// said: model and source words, printed and never logged or stored.

export const REFUSALS_SHOW_CHARS = 300;

type Lane = MessageLane;
type RefusalsReport = {
  items: number;
  // No saved answer to replay, or one refused now: neither counted.
  notSaved: number;
  failed: number;
  candidates: number;
  // `<reason> <type>.<field>:<issue>`, with the repair off, and those the repair leaves.
  refused: Record<string, number>;
  stillRefused: Record<string, number>;
  // The candidates the repair keeps, by rule.
  repaired: Record<string, number>;
  // The items PI_EXTRACT_REASK would ask again: with the repair off and with it on.
  reask: { repairOff: number; repairOn: number; callMicroUsd: number | null };
  shown?: string[];
};

const keyOf = (one: PersonalUnmapped): string =>
  `${one.reason} ${one.proposedType}.${one.field ?? "-"}:${one.issue ?? "-"}`;
const add = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const sorted = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, n]) => `${key} ${n}`)
    .join(", ") || "none";

type Read = {
  generation: number;
  opened: OpenedItem;
  item: BacklogItem;
  lane: Lane;
  parsed: Awaited<ReturnType<typeof readStored>>["parsed"];
  read: Awaited<ReturnType<typeof readStored>>["read"];
};

// One candidate, alone, through the lane's checks, so what is refused is this candidate's.
async function checked(candidate: ClaimCandidate, prompt: Prompt, inputHash: string, on: Read, repair: boolean) {
  const { parsed, read, opened, item, lane, generation } = on;
  const { found: result, ontology } = await checkMessageClaims([candidate], {
    parsed,
    read,
    opened,
    due: routedDue(item, lane),
    lane,
    promptVersion: prompt.version,
    narrowing: "none",
    inputHash,
    generation,
    repair,
  });
  const [refused] = result.unmapped;
  const detail =
    refused?.reason === "bad_fields" && refused.issue === undefined
      ? fieldsDetail(ontology.get(candidate.type), candidate.fields)
      : {};
  return {
    kept: result.claims[0],
    refused: refused === undefined ? undefined : { ...refused, ...detail },
    rule: result.repairs?.[0],
  };
}

// The part of a segment to show: its start when it fits, else what stands around the value's longest
// word, the one least likely to match early. Cut from the start, most long mail hid the words a
// refusal is about, so nobody could judge it.
export function shownSegment(text: string, value: unknown): string {
  if (text.length <= REFUSALS_SHOW_CHARS) return text;
  const words = (typeof value === "string" ? value : "").toLowerCase().split(/\s+/);
  const longest = words.reduce((best, word) => (word.length > best.length ? word : best), "");
  const at = longest === "" ? -1 : text.toLowerCase().indexOf(longest);
  const from = at < 0 ? 0 : Math.max(0, Math.min(at - REFUSALS_SHOW_CHARS / 2, text.length - REFUSALS_SHOW_CHARS));
  return text.slice(from, from + REFUSALS_SHOW_CHARS);
}

// One line of what a refused candidate said, for the owner's eyes: source words.
function shownLine(candidate: ClaimCandidate, refused: PersonalUnmapped, on: Read, slice: unknown): string {
  const value = refused.field === undefined ? candidate.fields : candidate.fields[refused.field];
  const segment = segmentAt(on.parsed, candidate.span)?.text;
  const text = segment === undefined ? undefined : shownSegment(segment, value);
  return `${keyOf(refused)} value=${JSON.stringify(value)} repaired=${JSON.stringify(slice ?? null)} segment=${JSON.stringify(text ?? null)}`;
}

export async function runRefusals(
  deps: Pick<RunCore, "store" | "modelId" | "compartments" | "generation">,
  sample: number,
  options: { show?: boolean } = {},
): Promise<RefusalsReport> {
  const report: RefusalsReport = {
    items: 0,
    notSaved: 0,
    failed: 0,
    candidates: 0,
    refused: {},
    stillRefused: {},
    repaired: {},
    reask: { repairOff: 0, repairOn: 0, callMicroUsd: null },
    ...(options.show === true ? { shown: [] } : {}),
  };
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const items = await deps.store.refusedItems(sample, generation, {
    ...(deps.compartments === undefined ? {} : { compartments: deps.compartments }),
  });
  const port = { model: REPLAY_ONLY, calls: deps.store.calls(deps.modelId) };
  for (const item of items) {
    const lane = item.committedLane;
    if (lane !== "correspondence" && lane !== "transaction") continue;
    const opened = await deps.store.open(item.evidenceId, { projects: lane === "correspondence" });
    if (opened === null) continue;
    try {
      const { parsed, read } = await readStored(opened, item.compartments);
      const on: Read = { generation, opened, item, lane, parsed, read };
      const project = lane === "correspondence" ? messageProject(opened, parsed) : null;
      let answered: { prompt: Prompt; output: Awaited<ReturnType<typeof interpret>> } | undefined;
      for (const prompt of doneOrder(lane).map((version) => promptAt(lane, version))) {
        try {
          const slot = messageProjectData(prompt, parsed, item.sentAt, project);
          answered = { prompt, output: await interpret(prompt, slot, parsed, read, port) };
          on.opened = withMessageProject(opened, project, prompt);
          break;
        } catch (error) {
          // A call that is not saved reaches the model that answers nothing: the next version.
          if (!(error instanceof ExtractFailure) || error.code !== "model_unavailable") throw error;
        }
      }
      if (answered === undefined) {
        report.notSaved += 1;
        continue;
      }
      report.items += 1;
      const { prompt, output } = answered;
      const candidates = messageCandidates(lane, output.output.claims, parsed, opened);
      const off: PersonalUnmapped[] = [];
      const after: PersonalUnmapped[] = [];
      let keptOff = 0;
      let keptOn = 0;
      let unresolved = 0;
      for (const candidate of candidates) {
        report.candidates += 1;
        const without = await checked(candidate, prompt, output.inputHash, on, false);
        if (without.refused === undefined) {
          keptOff += without.kept === undefined ? 0 : 1;
          keptOn += without.kept === undefined ? 0 : 1;
          unresolved += without.kept === undefined ? 1 : 0;
          continue;
        }
        off.push(without.refused);
        add(report.refused, keyOf(without.refused));
        const repaired = await checked(candidate, prompt, output.inputHash, on, true);
        if (repaired.refused === undefined) {
          keptOn += 1;
          add(report.repaired, repaired.rule ?? "none");
        } else {
          after.push(repaired.refused);
          add(report.stillRefused, keyOf(repaired.refused));
        }
        report.shown?.push(
          shownLine(candidate, without.refused, on, repaired.kept?.claim.content.fields[without.refused.field ?? ""]),
        );
      }
      if (keptOff === 0 && wordingCodes({ claims: [], unmapped: off }, unresolved) !== null)
        report.reask.repairOff += 1;
      if (keptOn === 0 && wordingCodes({ claims: [], unmapped: after }, unresolved) !== null)
        report.reask.repairOn += 1;
    } catch (error) {
      if (!(error instanceof ExtractFailure)) throw error;
      report.failed += 1;
    }
  }
  report.reask.callMicroUsd = await deps.store.callCost(PROMPT_IDS.correspondence);
  return report;
}

// One line of counts each, no text; then, with `--show`, what each said.
export function refusalsReportLines(report: RefusalsReport): string[] {
  const refused = Object.values(report.refused).reduce((sum, n) => sum + n, 0);
  const repaired = Object.values(report.repaired).reduce((sum, n) => sum + n, 0);
  const { repairOff, repairOn, callMicroUsd } = report.reask;
  const cost = (items: number): string =>
    callMicroUsd === null ? "unknown" : String(Math.round(items * callMicroUsd));
  return [
    `items: ${report.items} not_saved ${report.notSaved} failed ${report.failed} candidates ${report.candidates}`,
    `refused: ${refused}`,
    `refused_by: ${sorted(report.refused)}`,
    `repair_would_keep: ${repaired} by ${sorted(report.repaired)}`,
    `still_refused_by: ${sorted(report.stillRefused)}`,
    `reask_would_ask: repair_off ${repairOff} cost_microusd ${cost(repairOff)}, repair_on ${repairOn} cost_microusd ${cost(repairOn)}`,
    `call_microusd: ${callMicroUsd === null ? "unknown" : Math.round(callMicroUsd)}`,
    ...(report.shown ?? []).map((line) => `show: ${line}`),
  ];
}
