import type { ClaimCandidate, InterpreterOutput, OntologyView } from "@intelligence/contracts";
import {
  type AskedLane,
  type BacklogItem,
  type DueItem,
  isCoded,
  KEY_FIELDS,
  type MessageLane,
  type OpenedItem,
  type OpenedRecord,
  type PersonalUnmappedReason,
} from "@intelligence/contracts/personal";
import { cutFromNegation, KEY_V2_GENERATION } from "@intelligence/personal-beliefs";
import { type Parsed, segmentAt } from "@intelligence/personal-core";
import type { ModelClient, Prompt } from "@intelligence/personal-models";
import { ExtractFailure } from "./call-failure.ts";
import { type DropDetail, type personalCheck, strip } from "./check.ts";
import { EXTRACT_GENERATION, type RunCore } from "./config.ts";
import { findingData, interpret, passesThrough, REPLAY_ONLY, readRecord, readStored } from "./interpret.ts";
import { checkFindingClaims, checkMessageClaims, messageCandidates } from "./lane-check.ts";
import { FACT_KIND_VERSIONS, SECOND_DEGREE_VERSIONS } from "./lane-versions.ts";
import { messageSlot } from "./message.ts";
import { PROMPT_VERSIONS } from "./message-prompts.ts";
import { messageProject, messageProjectData, withMessageProject } from "./project-named.ts";
import { promptAt } from "./prompts.ts";
import { withSharedDetail } from "./refused.ts";
import { routedDue } from "./triage.ts";

// `pi extract trial --sample N`. The N newest items done in the correspondence lane at the current
// generation that have no saved call of prompt version 4 are asked prompt version 4 through the
// saved-call store, so the switch replays each call and pays for it once. Each answer is checked and
// keyed in memory, at fact key version 2, and nothing else is written: no claim, no status and no
// belief. Only the saved calls, and the usage rows and exposure notes the caller's model client
// writes. Counts only, no text. `--lane transaction` takes the transaction lane's items, and
// `--fact-kinds` asks the lane's fact-kind version, each item's saved call of the version it was done
// under replayed beside it at no cost (`before`), so the owner reads what the new version keeps,
// refuses and adds against what the old one did on the same items. `--lane agent --fact-kinds` does
// the same over the newest findings, checked as a run checks one.

export const TRIAL_VERSION = PROMPT_VERSIONS.correspondence;
type TrialLane = AskedLane;
// The version a trial asks: correspondence's current one, or with `--second-degree` its second-degree
// one; with `--fact-kinds` the lane's fact-kind version; the transaction lane's current one otherwise.
const trialVersion = (secondDegree: boolean, lane: TrialLane = "correspondence", factKinds = false): string =>
  factKinds
    ? FACT_KIND_VERSIONS[lane]
    : lane === "transaction"
      ? PROMPT_VERSIONS.transaction
      : secondDegree
        ? SECOND_DEGREE_VERSIONS.correspondence
        : TRIAL_VERSION;
// The versions an item of the lane may have been done under, newest first: what `before` replays.
const DONE_UNDER: Readonly<Record<TrialLane, readonly string[]>> = {
  correspondence: [SECOND_DEGREE_VERSIONS.correspondence, TRIAL_VERSION],
  transaction: [PROMPT_VERSIONS.transaction],
  agent: [SECOND_DEGREE_VERSIONS.agent, PROMPT_VERSIONS.agent],
};

type Counts = {
  // Claims kept by type, then by domain (`none` for a claim with none).
  claims: Record<string, Record<string, number>>;
  unmapped: Partial<Record<PersonalUnmappedReason, number>>;
  // Each refused claim by `<reason> <type>.<field>:<issue>` (`-` where the check names none), the
  // drop detail: what a reason's count is made of, in code words only.
  drops: Record<string, number>;
};

type TrialReport = Counts & {
  lane: TrialLane;
  // The prompt version asked: 4, the second-degree one or the fact-kind one.
  version: string;
  items: number;
  live: number;
  failed: number;
  ownerSideNoDomain: number;
  // Distinct fact keys over the owner-side claims kept, at version 1 and version 2.
  keys: { v1: number; v2: number };
  // Where each answer's cited span falls, by code: the cause of a `bad_span`, which the reason
  // alone does not tell.
  spans: SpanCounts;
  // With `--fact-kinds`: the same items' saved calls of the version each was done under, replayed
  // and checked: `items` replayed, `missing` with no saved call and `failed` whose saved answer is
  // refused now (neither counted).
  before?: Counts & { items: number; missing: number; failed: number };
  // With `--show`: for each item whose claims of the shown types differ between the version asked
  // and the version it was done under, both versions' kept claims of those types, each marked the
  // owner's or another's. Source words,
  // printed to a terminal only.
  shown?: { item: number; before: string[]; after: string[] }[];
  // With `--show-drops`: what each candidate the negation rule refused said. Source words, printed
  // to a terminal only.
  shownDrops?: string[];
  // How the trial ended: every item asked, or the code of the error that stopped it (a budget, a
  // refusal, the model away).
  stopped: string | null;
};

// A span as listed, a part of a listed span, a quoted segment's, the subject line's, or one no
// segment holds. Only the first two can be kept in the correspondence lane.
type SpanCounts = { listed: number; inside: number; quoted: number; subject: number; unheld: number };

export function spanClass(parsed: Parsed, span: string): keyof SpanCounts {
  const segment = segmentAt(parsed, span);
  if (segment === undefined) return "unheld";
  if (segment.quoted) return "quoted";
  if (span.startsWith("subject:")) return "subject";
  return segment.span === span ? "listed" : "inside";
}

// A client that counts the calls that reach the vendor; a replay reaches none.
function counting(model: ModelClient): { model: ModelClient; live(): number } {
  let live = 0;
  return {
    live: () => live,
    model: {
      complete: (request) => {
        live += 1;
        return model.complete(request);
      },
      embed: (request) => model.embed(request),
    },
  };
}

export const codeOf = (error: unknown): string => {
  const code = isCoded(error) ? error.code : undefined;
  return typeof code === "string" ? code : "failed";
};

// How many of the newest done items, of every lane, the trial looks through for its sample.
export const TRIAL_WINDOW = 20_000;

const emptyCounts = (): Counts => ({ claims: {}, unmapped: {}, drops: {} });

// `replay`: take the items whose version 4 call is already saved, so every answer replays at no
// cost and its refusals can be read again; a call that would go to the vendor fails its item
// instead (the model it is given is only reached for an unsaved call). Every item done at the
// current generation was asked version 4, so the trial finds nothing to ask unless it replays.
// `generation` is EXTRACT_GENERATION when absent; only a test passes another, to try an earlier
// generation. `secondDegree`: the sample is asked the correspondence lane's second-degree version
// (SECOND_DEGREE_VERSIONS) in place of version 4, the newest items with no saved call of it, so the
// owner prices the 180-day backfill from the cost of a sample before they set
// PI_EXTRACT_SECOND_DEGREE; its calls are saved as the backfill's would be, so the backfill pays
// for none of them again. `lane` and `factKinds`: the lane's items, asked its fact-kind version,
// beside `before`. `checkGeneration`: the answers are checked in memory as that generation would
// check them, so a replay shows what a raise would refuse before it is raised.
export async function runTrial(
  deps: Pick<RunCore, "store" | "model" | "modelId" | "compartments" | "generation">,
  sample: number,
  options: {
    replay?: boolean;
    project?: boolean;
    secondDegree?: boolean;
    lane?: TrialLane;
    factKinds?: boolean;
    show?: readonly string[];
    checkGeneration?: number;
    showDrops?: boolean;
  } = {},
): Promise<TrialReport | "already_running"> {
  const generation = deps.generation ?? EXTRACT_GENERATION;
  const lane = options.lane ?? "correspondence";
  const factKinds = options.factKinds === true;
  const version = trialVersion(options.secondDegree === true, lane, factKinds);
  return deps.store.withExtractLock(async () => {
    const report: TrialReport = {
      lane,
      version,
      items: 0,
      live: 0,
      failed: 0,
      ...emptyCounts(),
      ownerSideNoDomain: 0,
      keys: { v1: 0, v2: 0 },
      spans: { listed: 0, inside: 0, quoted: 0, subject: 0, unheld: 0 },
      stopped: null,
    };
    if (factKinds) report.before = { items: 0, missing: 0, failed: 0, ...emptyCounts() };
    const show = new Set(options.show ?? []);
    if (factKinds && show.size > 0) report.shown = [];
    if (options.showDrops === true) report.shownDrops = [];
    const shownOf = (kept: Awaited<ReturnType<typeof answer>>["kept"]): string[] =>
      kept
        .filter((record) => show.has(record.claim.content.type))
        .map(
          (record) =>
            `${record.claim.content.type} ${record.subjectKind === "owner" ? "owner" : record.subjectKind === "project" ? "project" : "other"} ${JSON.stringify(record.claim.content.fields)}`,
        )
        .sort();
    const prompt = promptAt(lane, version);
    const { model, live } = counting(options.replay === true ? REPLAY_ONLY : deps.model);
    const calls = deps.store.calls(deps.modelId);
    if (lane === "agent") {
      await trialFindings(
        deps,
        sample,
        generation,
        prompt,
        { replay: options.replay === true, model, shownOf },
        report,
      );
      report.live = live();
      return report;
    }
    // The backlog reads newest first, every lane; only the lane's items are the trial's. Its
    // window is the whole backlog, not a multiple of the sample: on the box the 500 newest done
    // items held 28 correspondence items among receipts, so a sample of 50 found 3.
    const backlog = await deps.store.backlog(
      Math.max(sample * 10, TRIAL_WINDOW),
      generation,
      { promptId: prompt.id, promptVersion: version },
      {
        ...(deps.compartments === undefined ? {} : { compartments: deps.compartments }),
        ...(options.replay === true ? { saved: true } : {}),
      },
    );
    const inLane = backlog.filter((one) => one.committedLane === lane);
    // `--project` asks only messages in a project, so the window is read and the sample counts those.
    const due = options.project === true ? inLane : inLane.slice(0, sample);
    const v1 = new Set<string>();
    const v2 = new Set<string>();
    for (const item of due) {
      if (report.items >= sample) break;
      const opened = await deps.store.open(item.evidenceId, {
        projects: lane === "correspondence" && options.factKinds === true,
      });
      if (opened === null) continue;
      if (options.project === true && !(await namesProject(opened, item.compartments))) continue;
      report.items += 1;
      try {
        const { parsed, read } = await readStored(opened, item.compartments);
        const slot = { message: JSON.stringify(messageSlot(parsed, item.sentAt)) };
        const project = lane === "correspondence" ? messageProject(opened, parsed) : null;
        const answered = await answer(
          prompt,
          messageProjectData(prompt, parsed, item.sentAt, project),
          {
            parsed,
            read,
            opened: withMessageProject(opened, project, prompt),
            item,
            lane,
            model,
            calls,
            checkGeneration: options.checkGeneration,
            dropsShown: report.shownDrops,
          },
          report,
        );
        for (const claim of answered.spans) report.spans[spanClass(parsed, claim)] += 1;
        for (const record of answered.kept) {
          if (!Object.hasOwn(KEY_FIELDS, record.claim.content.type)) continue;
          if (typeof record.claim.content.fields.domain !== "string") report.ownerSideNoDomain += 1;
          v2.add(record.factKey);
          v1.add(record.legacyFactKey ?? record.factKey);
        }
        if (report.before !== undefined) {
          const before = report.before;
          await replayBefore(report, before, DONE_UNDER[lane], shownOf(answered.kept), async (old) => {
            const replayed = await answer(
              promptAt(lane, old),
              slot,
              { parsed, read, opened, item, lane, model: REPLAY_ONLY, calls },
              before,
            );
            return shownOf(replayed.kept);
          });
        }
      } catch (error) {
        // A budget, the vendor's refusal of the key or the model away ends the trial; anything
        // else ends the item.
        if (passesThrough(error)) {
          report.stopped = codeOf(error);
          break;
        }
        if (!(error instanceof ExtractFailure)) throw error;
        report.failed += 1;
      }
    }
    report.live = live();
    report.keys = { v1: v1.size, v2: v2.size };
    return report;
  });
}

// The version an item was done under, replayed from its saved call, never bought, and counted in
// `before`. Only a call that is not saved (REPLAY_ONLY's `model_unavailable`) moves on to the next
// older version; a saved answer refused now counts as `failed`, never as another version's. When
// the item's shown claims differ from the replayed version's, both are noted in `report.shown`.
async function replayBefore(
  report: TrialReport,
  before: NonNullable<TrialReport["before"]>,
  versions: readonly string[],
  after: string[],
  replay: (version: string) => Promise<string[]>,
): Promise<void> {
  let outcome: "items" | "missing" | "failed" = "missing";
  let earlier: string[] = [];
  for (const old of versions) {
    try {
      earlier = await replay(old);
      outcome = "items";
    } catch (error) {
      if (!(error instanceof ExtractFailure)) throw error;
      if (error.code === "model_unavailable") continue;
      outcome = "failed";
    }
    break;
  }
  before[outcome] += 1;
  if (report.shown !== undefined && outcome === "items" && after.join("\n") !== earlier.join("\n"))
    report.shown.push({ item: report.items, before: earlier, after });
}

// The agent lane's sample: the newest findings done at this generation, each asked its fact-kind
// version and checked as a run checks one, written nowhere. `before` as for a message.
async function trialFindings(
  deps: Pick<RunCore, "store" | "modelId" | "compartments">,
  sample: number,
  generation: number,
  prompt: Prompt,
  options: {
    replay: boolean;
    model: ModelClient;
    shownOf: (kept: ReturnType<typeof personalCheck>["claims"]) => string[];
  },
  report: TrialReport,
): Promise<void> {
  const calls = deps.store.calls(deps.modelId);
  const due = await deps.store.findingBacklog(
    sample,
    generation,
    { promptId: prompt.id, promptVersion: prompt.version },
    {
      ...(deps.compartments === undefined ? {} : { compartments: deps.compartments }),
      ...(options.replay ? { saved: true } : {}),
    },
  );
  for (const item of due) {
    const record = await deps.store.openRecord(item.evidenceId);
    if (record === null) continue;
    report.items += 1;
    try {
      const { parsed, read } = readRecord(record, item.compartments);
      const asked = { parsed, read, record, due: item, calls };
      const answered = await findingAnswer(prompt, { ...asked, model: options.model }, report);
      for (const span of answered.spans) report.spans[spanClass(parsed, span)] += 1;
      if (report.before === undefined) continue;
      const before = report.before;
      await replayBefore(report, before, DONE_UNDER.agent, options.shownOf(answered.kept), async (old) => {
        const replayed = await findingAnswer(promptAt("agent", old), { ...asked, model: REPLAY_ONLY }, before);
        return options.shownOf(replayed.kept);
      });
    } catch (error) {
      if (passesThrough(error)) {
        report.stopped = codeOf(error);
        break;
      }
      if (!(error instanceof ExtractFailure)) throw error;
      report.failed += 1;
    }
  }
}

type FindingAsked = {
  parsed: Parsed;
  read: ReturnType<typeof readRecord>["read"];
  record: OpenedRecord;
  due: DueFinding;
  model: ModelClient;
  calls: ReturnType<RunCore["store"]["calls"]>;
};
type DueFinding = Extract<DueItem, { source: "agent_record" }>;

type Asked = {
  parsed: Parsed;
  read: Awaited<ReturnType<typeof readStored>>["read"];
  opened: OpenedItem;
  item: BacklogItem;
  lane: MessageLane;
  model: ModelClient;
  calls: ReturnType<RunCore["store"]["calls"]>;
  checkGeneration?: number | undefined;
  dropsShown?: string[] | undefined;
};

// How much of a segment a shown drop prints.
const SHOW_DROP_CHARS = 300;

// What each candidate the negation rule refused said, and the start of its segment: source words.
function negationDrops(
  asked: Asked,
  candidates: readonly ClaimCandidate[],
  refused: readonly { id: string; proposedType: string; reason: string }[],
  details: ReadonlyMap<string, DropDetail>,
): string[] {
  return refused.flatMap((one) => {
    const field = details.get(one.id)?.field;
    if (one.reason !== "negation_cut" || field === undefined) return [];
    return candidates.flatMap((candidate) => {
      const value = candidate.fields[field];
      const text = segmentAt(asked.parsed, candidate.span)?.text;
      if (candidate.type !== one.proposedType || typeof value !== "string" || text === undefined) return [];
      return cutFromNegation(value, text)
        ? [
            `${one.proposedType}.${field} value=${JSON.stringify(value)} segment=${JSON.stringify(text.slice(0, SHOW_DROP_CHARS))}`,
          ]
        : [];
    });
  });
}

// Whether a message is in a project. One that cannot be read is not, here: the trial reads on.
const namesProject = async (opened: OpenedItem, compartments: BacklogItem["compartments"]): Promise<boolean> => {
  try {
    return messageProject(opened, (await readStored(opened, compartments)).parsed) !== null;
  } catch (error) {
    if (error instanceof ExtractFailure) return false;
    throw error;
  }
};

// One answer of `prompt` for the item, checked as the lane checks it (the transaction lane's
// subject set to the owner by code, as process-item does), its counts added to `into`.
async function answer(
  prompt: Prompt,
  slot: Record<string, string>,
  asked: Asked,
  into: Counts,
): Promise<{ spans: string[]; kept: ReturnType<typeof personalCheck>["claims"] }> {
  const { parsed, read, opened, item, lane } = asked;
  const { output, inputHash } = await interpret(prompt, slot, parsed, read, { model: asked.model, calls: asked.calls });
  const candidates = messageCandidates(lane, output.claims, parsed, opened);
  const details = new Map<string, DropDetail>();
  const { found, ontology } = await checkMessageClaims(
    candidates,
    {
      parsed,
      read,
      opened,
      due: routedDue(item, lane),
      lane,
      promptVersion: prompt.version,
      narrowing: output.narrowing,
      inputHash,
      generation: asked.checkGeneration ?? KEY_V2_GENERATION,
    },
    details,
  );
  asked.dropsShown?.push(...new Set(negationDrops(asked, candidates, found.unmapped, details)));
  return counted(output, ontology, found, details, into);
}

// One answer of `prompt` for a finding, checked as commitFinding checks it, its counts added to
// `into`. A finding's narrowing is ignored here, as a trial's other lanes keep their claims under it.
async function findingAnswer(
  prompt: Prompt,
  asked: FindingAsked,
  into: Counts,
): Promise<{ spans: string[]; kept: ReturnType<typeof personalCheck>["claims"] }> {
  const { parsed, read, record, due } = asked;
  const { output, inputHash } = await interpret(prompt, findingData(prompt, parsed, record), parsed, read, {
    model: asked.model,
    calls: asked.calls,
  });
  const details = new Map<string, DropDetail>();
  const { found, ontology } = await checkFindingClaims(
    strip(output.claims),
    {
      parsed,
      read,
      record,
      due,
      promptVersion: prompt.version,
      narrowing: "none",
      inputHash,
      generation: KEY_V2_GENERATION,
    },
    details,
  );
  return counted(output, ontology, found, details, into);
}

function counted(
  output: InterpreterOutput,
  ontology: OntologyView,
  found: ReturnType<typeof personalCheck>,
  details: ReadonlyMap<string, DropDetail>,
  into: Counts,
): { spans: string[]; kept: ReturnType<typeof personalCheck>["claims"] } {
  for (const one of withSharedDetail(found.unmapped, output.claims, (type) => ontology.get(type))) {
    into.unmapped[one.reason] = (into.unmapped[one.reason] ?? 0) + 1;
    const key = `${one.reason} ${one.proposedType}.${one.field ?? details.get(one.id)?.field ?? "-"}:${one.issue ?? details.get(one.id)?.issue ?? "-"}`;
    into.drops[key] = (into.drops[key] ?? 0) + 1;
  }
  for (const record of found.claims) {
    const { type, fields } = record.claim.content;
    const domain = typeof fields.domain === "string" ? fields.domain : "none";
    const byDomain = (into.claims[type] ??= {});
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
  }
  return { spans: output.claims.map((claim) => claim.span), kept: found.claims };
}

const claimsLine = (counts: Counts): string => {
  const claims = Object.entries(counts.claims)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([type, domains]) =>
        `${type} ${Object.entries(domains)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([domain, n]) => `${domain}:${n}`)
          .join(",")}`,
    );
  return claims.length === 0 ? "none" : claims.join("; ");
};
const unmappedLine = (counts: Counts): string => {
  const unmapped = Object.entries(counts.unmapped)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, n]) => `${reason} ${n}`);
  return unmapped.length === 0 ? "none" : unmapped.join(", ");
};
const dropsLine = (counts: Counts): string => {
  const drops = Object.entries(counts.drops)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, n]) => `${key} ${n}`);
  return drops.length === 0 ? "none" : drops.join(", ");
};

// One line of counts each, no text.
export function trialReportLines(report: TrialReport, costMicroUsd: number): string[] {
  const before = report.before;
  return [
    `items: ${report.items} live ${report.live} failed ${report.failed} cost_microusd ${costMicroUsd}`,
    `prompt: ${report.lane} ${report.version}`,
    `claims: ${claimsLine(report)}`,
    `owner_side_no_domain: ${report.ownerSideNoDomain}`,
    `unmapped: ${unmappedLine(report)}`,
    `drops: ${dropsLine(report)}`,
    `owner_side_keys: v1 ${report.keys.v1} v2 ${report.keys.v2}`,
    `spans: ${Object.entries(report.spans)
      .map(([where, n]) => `${where} ${n}`)
      .join(", ")}`,
    ...(before === undefined
      ? []
      : [
          `before: items ${before.items} missing ${before.missing} failed ${before.failed}`,
          `before_claims: ${claimsLine(before)}`,
          `before_unmapped: ${unmappedLine(before)}`,
          `before_drops: ${dropsLine(before)}`,
        ]),
    `stopped: ${report.stopped ?? "none"}`,
    ...(report.shownDrops ?? []).map((line) => `show_drop: ${line}`),
    ...(report.shown ?? []).flatMap((one) => [
      `show: item ${one.item}`,
      ...one.before.map((line) => `  before ${line}`),
      ...one.after.map((line) => `  after ${line}`),
    ]),
  ];
}
