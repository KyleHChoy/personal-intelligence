import {
  type IdentityResolver,
  type InterpreterOutput,
  LocalEntityId,
  type ModelCallStore,
  type Timestamp,
} from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  CaptureId,
  EntityId,
  type MomentCaptureFacts,
  type MomentItem,
  type OpenedMoment,
  SourceAccountId,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, personalFactKey } from "@intelligence/personal-beliefs";
import { isPhoneKey, normalizeAddress, phoneKey } from "@intelligence/personal-core";
import { captureFacts } from "@intelligence/personal-core/lens";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import type { CaptureTally } from "../capture-check.ts";
import { strip } from "../check.ts";
import { interpret, passesThrough } from "../interpret.ts";
import { withheldBy } from "../lane-check.ts";
import { MOMENT_TYPES } from "../lane-versions.ts";
import { refusedAnswer } from "../moments.ts";
import { checkMoments, sumTallies } from "../moments-check.ts";
import { type MomentPlan, planMoments } from "../moments-plan.ts";
import { triageMoment } from "../triage.ts";
import { callsInMemory } from "./eval-calls.ts";
import type { EvalTypeLine } from "./eval-documents.ts";
import type { MeetingProposal } from "./eval-facts.ts";
import { type MeetingDetail, runKey, saidIn, sameFactOf, shapeOf, systematicOf } from "./eval-facts.ts";
import { fieldsOf } from "./eval-meetings.ts";
import { dropsText } from "./eval-meetings-report.ts";
import { type EvalMeetingFact, saidOf } from "./eval-meetings-set.ts";
import {
  ARLO,
  EVAL_MOMENT_OWNER,
  type EvalMomentFact,
  type EvalMomentGroup,
  type EvalMomentScenario,
  MOMENT_DECK_LINE,
  NAMES,
  ROBIN,
  TESS,
} from "./eval-moment-builders.ts";
import { EVAL_MOMENT_GROUPS } from "./eval-moment-groups.ts";
import { ulidOf } from "./eval-open.ts";
import { extrasAllowed } from "./eval-rule.ts";
import {
  addDrops,
  deckHeld,
  detailByRun,
  extrasBound,
  extrasOf,
  foundOf,
  gatedLines,
  pairFacts,
  pooledLines,
  pooledTypeLines,
  recalledAt,
  scenarioLineText,
  setLineText,
  typeCounts,
  typeLineText,
} from "./eval-score.ts";

// The moment evaluation, built as the meeting evaluation is: synthetic groups of moments on
// reserved domains, each with its expected facts written by hand, at least ten with none, sent
// through the moment lane's request and checks to the configured model, read and written nowhere
// but the model's port, and scored by code with the document evaluation's thresholds, imported.
//
// Beside the mail groups: one-to-one and group chats with Lens's turns, agent-app conversations
// (the owner's prompts and the agent's replies) and chats with no turns. Each expected fact says
// whom code must credit (`by`: the speaker's address, or nobody). A claim citing an agent's line is
// agent output: neither a match nor an extra, and never the owner's word.
//
// The set lives in this package, as the meeting and document sets do: `pi extract check --world
// --lane moment` runs on the host, and no runtime code imports a testing entry.

const EVAL_ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("evaluation moments account")}`);
const entityOf = (address: string): LocalEntityId =>
  LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`evaluation moment person ${address}`)}`));
// The second-degree evaluation's chats are opened here, so it reads whom code credited.
export const evalMomentEntity = entityOf;
const OWNER_ENTITY = entityOf(EVAL_MOMENT_OWNER);
// The people known by a name alone resolve only through a binding.
const PEOPLE = new Set(Object.keys(NAMES).filter((address) => address !== TESS && address !== ARLO));

// One evaluation moment as the pipeline opens a stored one: under `own`, first pushed as it ended,
// no stored document, with an identity port that answers for the set's people alone. Its facts
// carry its push as it ended, so the owner's word holds; `agentApp` as the drain flags an agent
// app's moment. `bound`: a name to the person the sync's participant step binds it to, which the
// box's port reads as a binding of that moment's evidence; any other name links nobody.
export function openEvalMoment(
  item: MomentItem,
  agentApp = false,
  bound: Readonly<Record<string, string>> = {},
): OpenedMoment {
  const answered = new Map<string, SubjectKind>();
  const identity: IdentityResolver = {
    async resolve(mention) {
      // A source moment's handle by its binding (`bound`, by handle) alone; a phone
      // key no saved contact keys here.
      if (mention.key.kind === "address" && isPhoneKey(mention.key.value)) return { outcome: "not_a_person" };
      const named =
        mention.key.kind === "name" && Object.hasOwn(bound, mention.key.value) ? bound[mention.key.value] : undefined;
      const address = named ?? (mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null);
      if (address === null || (named === undefined && !PEOPLE.has(address))) return { outcome: "not_a_person" };
      const entity = entityOf(address);
      answered.set(entity, address === EVAL_MOMENT_OWNER ? "owner" : "person");
      return { outcome: "linked", entity, epoch: 0 };
    },
  };
  const at = new Date(Date.parse(item.observedAt)).toISOString() as Timestamp;
  return {
    item,
    capture: {
      id: CaptureId.parse(`cap_${ulidOf(`evaluation moment capture ${item.key}`)}`),
      key: item.key as OpenedMoment["capture"]["key"],
      revision: 0,
      observedAt: at,
      endedAt: at,
      firstPushedAt: at,
      facts: captureFacts(item, { linkedEvent: null, pushedAt: at }) as MomentCaptureFacts,
      storedDocument: false,
      agentApp,
    },
    context: {
      evidenceId: evidenceIdFor({
        vault: "personal",
        sourceAccount: EVAL_ACCOUNT,
        sourceItemId: item.key,
        revision: 0,
      }),
      revision: 0,
      compartments: ["own"],
      ownerAddresses: [EVAL_MOMENT_OWNER],
      ownerEntity: OWNER_ENTITY,
      identity,
    },
    kindOf: (entity) => answered.get(entity),
    // A bound handle's person's name, as the store reads it for the slot.
    ...(item.source === undefined
      ? {}
      : {
          handleNames: Object.fromEntries(
            item.participants.flatMap((one) =>
              one.handle !== undefined && phoneKey(one.handle) !== null && bound[one.handle] !== undefined
                ? [[one.handle, NAMES[bound[one.handle] as string] ?? "Guest"]]
                : [],
            ),
          ),
        }),
  };
}

// The fact keys an expected fact has, one for each phrasing and domain it accepts: its type,
// subject, typed fields and the key of the moment whose text states it. At fact key version 2, as
// the meeting check scores, so an owner-side fact keys by its phrase and domain and a role by its
// title; a commitment's and a plan's key is the same at both versions.
const expectedKeys = (one: EvalMomentGroup, fact: EvalMomentFact): string[] => {
  const moment = one.moments.find((item) => item.text.includes(saidOf(fact))) ?? one.moments[0];
  const phrasings: EvalMeetingFact[] =
    fact.type === "commitment" || fact.type === "plan"
      ? [fact.what, ...(fact.alt ?? [])].map((what) => ({ ...fact, what }))
      : [fact];
  return phrasings.flatMap((phrasing) =>
    fieldsOf(phrasing, entityOf).map((fields) =>
      personalFactKey(
        { type: fact.type, subject: entityOf(fact.subject), fields },
        moment?.key ?? "",
        ["own"],
        undefined,
        2,
      ),
    ),
  );
};

// Whom code credited a found claim to, and who wrote the line it cites.
type Credit = "owner" | "person" | "nobody";
type LineSpeaker = "owner" | "participant" | "agent" | "none";
const lineSpeakerOf = (label: string | null): LineSpeaker =>
  label === null ? "none" : label === "owner" || label === "agent" ? label : "participant";
// `--detail`'s speaker use for one group: the passages shown by speaker, and the claims kept by
// the speaker of the line each cites and by whom code credited it.
type MomentSpeakerDetail = {
  id: string;
  passages: Record<LineSpeaker, number>;
  cited: Record<LineSpeaker, number>;
  credited: Record<Credit, number>;
};
const zeroLines = (): Record<LineSpeaker, number> => ({ owner: 0, participant: 0, agent: 0, none: 0 });

// `detail`: each group's result for `--detail`, in the meeting evaluation's shape, which
// `meetingDetailLines` prints; its `evidenceId` is the group's request's call key, its first
// moment's.
// `credited`: the expected facts found and how many of them carry the credit they expect (gated:
// all of them; recall is the type lines'). `ownerWord`: no claim credited to the owner cites a
// line not marked the owner's (gated). `speakers`: each group's speaker use for `--detail`.
export type MomentEvalReport = {
  types: EvalTypeLine[];
  groups: number;
  extras: number;
  extrasAllowed: number;
  failed: string[];
  deck: boolean;
  credited: { found: number; right: number };
  ownerWord: boolean;
  passed: boolean;
  detail: MeetingDetail[];
  speakers: MomentSpeakerDetail[];
  drops: CaptureTally;
  // The groups the lane does not ask (its triage: no chat, no turns or an agent app's), left out
  // of every line; and each scenario's own recall and extras, gated.
  skipped: number;
  scenarios: MomentScenarioLine[];
  // Found facts that repeat a matched one or hold an expected key, no extra. Reported.
  repeats: number;
};
type MomentScenarioLine = {
  scenario: EvalMomentScenario;
  expected: number;
  found: number;
  extra: number;
  passed: boolean;
};

// The groups the lane asks, by its own triage of each moment: a chat read ax with turns from no
// agent app, long enough. The set's other groups are ones the lane does not ask, kept in the set
// so the triage is checked against them.
export const askedByLane = (group: EvalMomentGroup): boolean =>
  group.moments.every(
    (item) =>
      triageMoment(
        {
          entity: item.entity,
          agentApp: group.agentApp === true,
          storedDocument: false,
          text: item.text,
          turns: item.turns !== undefined,
          agentTurn: item.turns?.some((turn) => turn.speaker === "agent") ?? false,
          read: item.read,
        },
        undefined,
      ).lane === "moment",
  );

// A scenario's line, over `runs` pooled runs of its facts: at least 0.8 of them found and at most
// 0.2 of them extra, each the per-run line times the runs.
const scenarioLine = (
  scenario: EvalMomentScenario,
  one: { expected: number; found: number; extra: number },
  runs = 1,
): MomentScenarioLine => ({
  scenario,
  ...one,
  passed: recalledAt(one.found, one.expected / runs, runs) && one.extra <= extrasBound(one.expected / runs, runs),
});

// The gate, the same for one run and for pooled runs: every type and scenario line, the extras,
// the deck line, credit and the owner's word.
const momentPassed = (report: Omit<MomentEvalReport, "passed">): boolean =>
  report.types.every((one) => one.passed) &&
  report.scenarios.every((one) => one.passed) &&
  report.extras <= report.extrasAllowed &&
  report.deck &&
  report.credited.right === report.credited.found &&
  report.ownerWord;

const shape = shapeOf(OWNER_ENTITY, new Set(Object.keys(NAMES).map(entityOf)));
const sameFact = sameFactOf(entityOf);
const hasDeck = (group: EvalMomentGroup): boolean => group.moments.some((item) => item.text.includes(MOMENT_DECK_LINE));

// The moments as the lane's plan takes them.
const membersOf = (moments: readonly OpenedMoment[]) =>
  moments.map((moment) => ({
    opened: moment,
    member: {
      evidenceId: moment.context.evidenceId as never,
      compartments: ["own"],
      observedAt: moment.capture.observedAt,
      attempts: 0,
      override: false,
    },
  }));

type FoundMoment = ReturnType<typeof foundOf> & { by: string | undefined; line: LineSpeaker };

// What one group's requests found. `asked`: the evidence ids its requests were asked under, its
// halves' too, so its detail line counts every call it made. `rejected`: each refused answer's
// shape, for `--detail`.
type GroupAnswer = {
  answered: boolean;
  refusedHalf: boolean;
  found: FoundMoment[];
  proposals: MeetingProposal[];
  rejected: string[];
  asked: Set<string>;
  drops: CaptureTally;
};

// One plan through the lane's request and checks. As the lane asks, a request whose answer the
// schema refused is asked again as two halves of the moments sent, once; a half refused again fails
// alone, and the other half still counts.
async function askPlan(
  plan: MomentPlan | null,
  port: { model: ModelClient; calls: ModelCallStore },
  into: GroupAnswer,
  halved = false,
): Promise<void> {
  if (plan === null) return;
  const first = plan.passages[0];
  if (first === undefined) throw new ExtractFailure("no_text");
  into.asked.add(first.parsed.evidenceId);
  let output: InterpreterOutput;
  try {
    output = (await interpret(plan.prompt, plan.data, first.parsed, first.read, port)).output;
  } catch (error) {
    if (!refusedAnswer(error)) throw error;
    into.rejected.push(
      Object.entries(error.shape ?? {})
        .map(([name, n]) => `${name} ${n}`)
        .join(" "),
    );
    const sent = plan.sent.map((passage) => passage.opened);
    if (halved || sent.length < 2) throw error;
    const half = Math.ceil(sent.length / 2);
    for (const piece of [sent.slice(0, half), sent.slice(half)]) {
      try {
        await askPlan(planMoments(membersOf(piece)), port, into, true);
      } catch (inner) {
        if (!refusedAnswer(inner)) throw inner;
        into.refusedHalf = true;
      }
    }
    return;
  }
  if (withheldBy(output.narrowing) !== undefined) {
    into.answered = false;
    return;
  }
  const outcomes: string[] = [];
  const checked = await checkMoments(output, plan, KEY_V2_GENERATION, outcomes);
  // Each candidate the model proposed, with its outcome, for `--detail`; an affiliation's relation
  // beside its organization.
  into.proposals.push(
    ...strip(output.claims).map((claim, n) => ({
      type: JSON.stringify(claim.type),
      subject: claim.subject.key.value,
      said: saidIn(claim.type, claim.fields),
      ...(claim.type === "affiliation" ? { relation: String(claim.fields.relation ?? "") } : {}),
      domain: JSON.stringify(String(claim.fields.domain ?? "")),
      span: claim.span,
      outcome: outcomes[n] ?? "none",
    })),
  );
  addDrops(into.drops, sumTallies(checked.tallies, [...checked.tallies.keys()]));
  into.found.push(
    ...[...checked.found.values()]
      .flatMap((each) => each.claims)
      .filter((record) => (MOMENT_TYPES as readonly string[]).includes(record.claim.content.type))
      .map((record): FoundMoment => {
        const cited = record.claim.evidence[0];
        const passage = plan.passages.find(
          (each) => each.member.evidenceId === cited?.evidenceId && each.stored === cited?.span,
        );
        return { ...foundOf(record), by: record.claim.assertedBy, line: lineSpeakerOf(passage?.speaker ?? null) };
      }),
  );
}

// A group's requests, from its plan. A group the model withholds, or answers in a way the lane
// refuses, is not answered; the model away, refused or over a budget ends the check by its error.
async function askGroup(
  planned: MomentPlan | null,
  port: { model: ModelClient; calls: ModelCallStore },
): Promise<GroupAnswer> {
  const into: GroupAnswer = {
    answered: planned !== null && planned.tooLong.length === 0 && planned.later.length === 0,
    refusedHalf: false,
    found: [],
    proposals: [],
    rejected: [],
    asked: new Set(),
    drops: {},
  };
  try {
    await askPlan(planned, port, into);
    if (into.refusedHalf) into.answered = false;
  } catch (error) {
    if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
    into.answered = false;
  }
  return into;
}

// `--detail`'s speaker use for one group: its passages by speaker, and its claims by the speaker of
// the line each cites and by whom code credited it.
function speakerUse(id: string, planned: MomentPlan | null, found: readonly FoundMoment[]): MomentSpeakerDetail {
  const use: MomentSpeakerDetail = {
    id,
    passages: zeroLines(),
    cited: zeroLines(),
    credited: { owner: 0, person: 0, nobody: 0 },
  };
  for (const passage of planned?.passages ?? []) use.passages[lineSpeakerOf(passage.speaker)] += 1;
  for (const each of found) {
    use.cited[each.line] += 1;
    use.credited[each.by === undefined ? "nobody" : each.by === OWNER_ENTITY ? "owner" : "person"] += 1;
  }
  return use;
}

// The set, each group as one request through the lane's plan and checks. A group the model
// withholds, or answers in a way the lane refuses, is failed and finds nothing; the model away,
// refused or over a budget ends the check by its error.
export async function evaluateMoments(
  port: { model: ModelClient },
  given: readonly EvalMomentGroup[] = EVAL_MOMENT_GROUPS,
): Promise<MomentEvalReport> {
  const set = given.filter(askedByLane);
  const scenarioCounts = new Map<EvalMomentScenario, { expected: number; found: number; extra: number }>();
  const calls = callsInMemory();
  const { counts, line } = typeCounts(MOMENT_TYPES);
  const failed: string[] = [];
  const detail: MeetingDetail[] = [];
  const speakers: MomentSpeakerDetail[] = [];
  const credited = { found: 0, right: 0 };
  let ownerWord = true;
  const drops: CaptureTally = {};
  let repeats = 0;
  let deck = !set.some(hasDeck);
  for (const one of set) {
    const expected = one.expected.map((fact) => ({
      fact,
      type: fact.type,
      keys: expectedKeys(one, fact),
      what: fact.type === "commitment" || fact.type === "plan" ? fact.what : undefined,
      by: fact.by === undefined ? undefined : entityOf(fact.by),
      shape: shape({
        ...fact,
        subject: entityOf(fact.subject),
        counterparty: "counterparty" in fact ? entityOf(fact.counterparty) : undefined,
      }),
    }));
    for (const fact of expected) line(fact.type).expected += 1;
    const opened = one.moments.map((item) => openEvalMoment(item, one.agentApp === true, one.bound));
    const planned = planMoments(membersOf(opened));
    const asked = await askGroup(planned, { model: port.model, calls });
    const { found } = asked;
    addDrops(drops, asked.drops);
    // Never the owner's word but on a line Lens marked the owner's.
    if (found.some((each) => each.by === OWNER_ENTITY && each.line !== "owner")) ownerWord = false;
    speakers.push(speakerUse(one.id, planned, found));
    // As the meeting check matches; a domain or a due day of its own is no miss, and an agent's line
    // is agent output: neither a match nor an extra.
    const paired = pairFacts(expected, found, sameFact, [], (each) => each.line !== "agent");
    const { matched, extras } = paired;
    repeats += paired.repeats;
    const wrongCredit = paired.pairs.filter((pair) => pair.one.by !== pair.fact.by).length;
    credited.found += matched.length;
    credited.right += matched.length - wrongCredit;
    for (const fact of matched) line(fact.type).found += 1;
    for (const each of extras) line(each.type).extra += 1;
    if (one.scenario !== undefined) {
      const sums = scenarioCounts.get(one.scenario) ?? { expected: 0, found: 0, extra: 0 };
      scenarioCounts.set(one.scenario, {
        expected: sums.expected + expected.length,
        found: sums.found + matched.length,
        extra: sums.extra + extras.length,
      });
    }
    if (!asked.answered || matched.length < expected.length || extras.length > 0 || wrongCredit > 0)
      failed.push(one.id);
    detail.push({
      id: one.id,
      evidenceId: (planned?.passages[0]?.opened ?? opened[0])?.context.evidenceId ?? "",
      ...(asked.asked.size > 1 ? { evidenceIds: [...asked.asked] } : {}),
      answered: asked.answered,
      expected: expected.length,
      matched: matched.length,
      missed: expected.filter((fact) => !matched.includes(fact)).map((fact) => fact.shape),
      extra: extras.map(shape),
      // The synthetic set's own words, where they went, as the meeting check prints.
      drops: asked.drops,
      // An affiliation's relation where an owner-side kind's domain is.
      missedSaid: expected
        .filter((fact) => !matched.includes(fact))
        .map(({ fact }) =>
          `${fact.type} "${saidOf(fact)}" ${"domain" in fact ? fact.domain : fact.type === "affiliation" ? `relation ${fact.relation}` : ""}`.trim(),
        ),
      extraSaid: extras.map(
        (each) =>
          `${each.type} ${JSON.stringify(each.said)} ${each.type === "affiliation" ? `relation ${JSON.stringify(String(each.fields.relation ?? ""))}` : JSON.stringify(each.domain)}`,
      ),
      proposals: asked.proposals,
      ...(asked.rejected.length === 0 ? {} : { rejected: asked.rejected }),
    });
    if (hasDeck(one)) deck = deckHeld(found, MOMENT_DECK_LINE, entityOf(ROBIN), OWNER_ENTITY);
  }
  const report = {
    types: gatedLines(counts),
    groups: set.length,
    extras: extrasOf(counts),
    extrasAllowed: extrasAllowed(set.length),
    failed,
    deck,
    credited,
    ownerWord,
    detail,
    speakers,
    drops,
    skipped: given.length - set.length,
    scenarios: [...scenarioCounts].map(([scenario, sums]) => scenarioLine(scenario, sums)),
    repeats,
  };
  return { ...report, passed: momentPassed(report) };
}

// As the meeting check pools: the set run `runs` times, each independent, with its own saved calls.
// Code's properties hold over every run (the deck line, credit and the owner's word, in every run);
// the model's counts are pooled, each line the per-run line times the runs; `each` says whether
// each run would have passed alone.
type PooledMomentReport = MomentEvalReport & { pooled: number; each: boolean[]; systematic: string[] };
// `onRun` is told each run's number before it starts (`callStatsByRun`).
export async function evaluateMomentsPooled(
  port: { model: ModelClient; onRun?: (run: number) => void },
  runs: number,
  set: readonly EvalMomentGroup[] = EVAL_MOMENT_GROUPS,
): Promise<PooledMomentReport> {
  const reports: MomentEvalReport[] = [];
  for (let n = 0; n < runs; n += 1) {
    port.onRun?.(n + 1);
    reports.push(await evaluateMoments(port, set));
  }
  return poolMomentReports(reports);
}
export function poolMomentReports(reports: readonly MomentEvalReport[]): PooledMomentReport {
  const [first] = reports;
  if (first === undefined) throw new Error("no runs to pool");
  const n = reports.length;
  const sum = (of: (one: MomentEvalReport) => number): number => reports.reduce((total, one) => total + of(one), 0);
  const drops: CaptureTally = {};
  for (const one of reports) addDrops(drops, one.drops);
  const report = {
    ...first,
    types: pooledTypeLines(reports),
    groups: sum((one) => one.groups),
    extras: sum((one) => one.extras),
    extrasAllowed: n * first.extrasAllowed,
    failed: [...new Set(reports.flatMap((one) => one.failed))],
    deck: reports.every((one) => one.deck),
    credited: { found: sum((one) => one.credited.found), right: sum((one) => one.credited.right) },
    ownerWord: reports.every((one) => one.ownerWord),
    detail: detailByRun(reports),
    speakers: reports.flatMap((one, at) => one.speakers.map((group) => ({ ...group, id: runKey(at + 1, group.id) }))),
    systematic: n > 1 ? systematicOf(reports.map((one) => one.detail)) : [],
    drops,
    scenarios: first.scenarios.map((line, at) =>
      scenarioLine(
        line.scenario,
        {
          expected: sum((one) => one.scenarios[at]?.expected ?? 0),
          found: sum((one) => one.scenarios[at]?.found ?? 0),
          extra: sum((one) => one.scenarios[at]?.extra ?? 0),
        },
        n,
      ),
    ),
    repeats: sum((one) => one.repeats),
    pooled: n,
    each: reports.map((one) => one.passed),
  };
  return { ...report, passed: momentPassed(report) };
}

// What `pi extract check --world --lane moment` prints: counts, codes and the set's own group
// ids, and no text.
export function momentReportLines(report: MomentEvalReport): string[] {
  return [
    ...report.types.map(typeLineText),
    setLineText("groups", report.groups, report),
    `deck: ${report.deck ? "ok" : "failed"}`,
    `credited: found ${report.credited.found} right ${report.credited.right} ${report.credited.right === report.credited.found ? "ok" : "failed"}`,
    `owner_word: ${report.ownerWord ? "ok" : "failed"}`,
    ...report.scenarios.map(scenarioLineText),
    `skipped: ${report.skipped} not_gated`,
    `repeats: ${report.repeats} not_gated`,
    `drops: ${dropsText(report.drops)}`,
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}

// The pooled report's lines: the evaluation's own, then the runs pooled and each run's own result.
export function pooledMomentReportLines(report: PooledMomentReport): string[] {
  return pooledLines(momentReportLines(report), report);
}

// What `--detail` adds for the moment check, one line a group: the passages shown
// by speaker, and the claims kept by the speaker of the line each cites and by whom code
// credited it. Counts and the set's own group ids, no text.
export function momentSpeakerLines(report: Pick<MomentEvalReport, "speakers">): string[] {
  const counts = (record: Record<string, number>): string =>
    Object.entries(record)
      .map(([name, n]) => `${name} ${n}`)
      .join(" ");
  return report.speakers.map(
    (one) =>
      `${one.id} speakers: passages ${counts(one.passages)} cited ${counts(one.cited)} credited ${counts(one.credited)}`,
  );
}
