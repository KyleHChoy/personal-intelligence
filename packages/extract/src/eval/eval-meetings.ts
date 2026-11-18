import { type IdentityResolver, LocalEntityId, type ModelCallStore, type Timestamp } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  CaptureId,
  type DueCapture,
  EntityId,
  EventId,
  KEY_FIELDS,
  type LifeDomain,
  type MeetingCaptureFacts,
  type OpenedCapture,
  SourceAccountId,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, personalFactKey } from "@intelligence/personal-beliefs";
import { normalizeAddress } from "@intelligence/personal-core";
import { captureFacts } from "@intelligence/personal-core/lens";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import type { CaptureTally } from "../capture-check.ts";
import { passesThrough } from "../interpret.ts";
import { MEETING_TYPES } from "../lane-versions.ts";
import { askMeeting, checkMeeting } from "../meeting-check.ts";
import { meetingIdentity } from "../meeting-identity.ts";
import { type MeetingPlan, planMeeting } from "../meeting-plan.ts";
import { callsInMemory } from "./eval-calls.ts";
import type { EvalTypeLine } from "./eval-documents.ts";
import type { MeetingProposal } from "./eval-facts.ts";
import { type MeetingDetail, saidIn, sameFactOf, sameStatement, shapeOf, systematicOf } from "./eval-facts.ts";
import {
  DECK_LINE,
  EVAL_MEETING_OWNER,
  EVAL_MEETINGS,
  type EvalMeeting,
  type EvalMeetingFact,
  type EvalScenario,
  NAMES,
  ROBIN,
  saidOf,
  ulidOf,
} from "./eval-meetings-set.ts";
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
  pooledTypeLines,
  recalledAt,
  typeCounts,
} from "./eval-score.ts";

// The meeting evaluation: synthetic meetings on reserved domains, each with its expected facts
// written by hand, at least ten with none, sent through the meeting lane to the configured model,
// read and written nowhere but the model's port, and scored by code with the document evaluation's
// thresholds, imported. A found fact matches an expected one when their type and fact key are
// equal.
//
// The set lives in this package, as the document set does (eval-set.ts): `pi extract check
// --world --lane meeting` runs on the host, and no runtime code imports a testing entry.

const EVAL_ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("evaluation meetings account")}`);
const OWNER_ENTITY = LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`evaluation person ${EVAL_MEETING_OWNER}`)}`));
export const EVAL_MEETING_OWNER_ENTITY = OWNER_ENTITY;
const entityOf = (address: string): LocalEntityId =>
  address === EVAL_MEETING_OWNER
    ? OWNER_ENTITY
    : LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`evaluation person ${address}`)}`));
const PEOPLE = new Set([...Object.keys(NAMES), EVAL_MEETING_OWNER]);

// One evaluation meeting as the pipeline opens a stored one: under `own`, unlinked, first pushed as
// it ended, with an identity port that answers for the set's people alone. Nothing is stored.
const EVAL_EVENT = EventId.parse(`evt_${ulidOf("evaluation event")}`);
export function openEvalMeeting(meeting: EvalMeeting): OpenedCapture {
  const { item } = meeting;
  const answered = new Map<string, SubjectKind>();
  const identity: IdentityResolver = {
    async resolve(mention) {
      const named = mention.key.kind === "name" ? meeting.bound?.[mention.key.value] : undefined;
      const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : (named ?? null);
      if (address === null || !PEOPLE.has(address)) return { outcome: "not_a_person" };
      const entity = entityOf(address);
      answered.set(entity, address === EVAL_MEETING_OWNER ? "owner" : "person");
      return { outcome: "linked", entity, epoch: 0 };
    },
  };
  const others = Object.fromEntries(
    item.speakers.flatMap((one) =>
      one.owner || one.mention?.address === undefined
        ? []
        : [[one.label, EntityId.parse(entityOf(one.mention.address))]],
    ),
  );
  const facts = (
    meeting.ownWord === true
      ? captureFacts(item, {
          linkedEvent: { id: EVAL_EVENT, ownerBacked: true, speakers: others },
          pushedAt: item.endedAt,
        })
      : captureFacts(item, { linkedEvent: null })
  ) as MeetingCaptureFacts;
  const evidenceId = evidenceIdFor({
    vault: "personal",
    sourceAccount: EVAL_ACCOUNT,
    sourceItemId: item.key,
    revision: 0,
  });
  return {
    item,
    capture: {
      id: CaptureId.parse(`cap_${ulidOf(`evaluation capture ${meeting.id}`)}`),
      key: item.key as OpenedCapture["capture"]["key"],
      revision: 0,
      startedAt: item.startedAt as Timestamp,
      endedAt: item.endedAt as Timestamp,
      firstPushedAt: item.endedAt as Timestamp,
      event: null,
      facts,
    },
    context: {
      evidenceId,
      revision: 0,
      compartments: ["own"],
      ownerAddresses: [EVAL_MEETING_OWNER],
      ownerEntity: OWNER_ENTITY,
      identity,
    },
    kindOf: (entity) => answered.get(entity),
  };
}

// The fields an expected fact's content has, one set for each phrasing and domain it accepts, its
// people by `entityOf`. The moment evaluation keys its facts with it too.
export function fieldsOf(
  fact: EvalMeetingFact,
  entityOf: (address: string) => LocalEntityId,
): Record<string, unknown>[] {
  switch (fact.type) {
    case "commitment":
    case "plan":
      return [
        {
          counterparty: entityOf(fact.counterparty),
          what: fact.what,
          ...(fact.due === undefined ? {} : { due: fact.due }),
          ...(fact.when === undefined ? {} : { when: fact.when }),
        },
      ];
    case "role":
      return [
        { title: fact.title, ...(fact.organization === undefined ? {} : { organization_name: fact.organization }) },
      ];
    case "affiliation":
      return [{ relation: fact.relation, organization_name: fact.organization }];
    case "relationship":
      return [{ counterparty: entityOf(fact.counterparty), relation: fact.relation }];
    default:
      return [fact.phrase, ...(fact.also ?? [])].flatMap((phrase) =>
        [fact.domain, ...(fact.domains ?? [])].map((domain) => ({
          [KEY_FIELDS[fact.type].phrase]: phrase,
          domain,
          ...(fact.polarity === undefined ? {} : { polarity: fact.polarity }),
        })),
      );
  }
}

// The fact keys an expected fact may have: its type, subject, typed fields and the meeting's key,
// at fact key version 2, so an owner-side fact keys by its phrase and domain and a role by its
// title. A commitment's and a plan's key is the same at both versions.
const expectedKeys = (opened: OpenedCapture, fact: EvalMeetingFact): string[] =>
  fieldsOf(fact, entityOf).map((fields) =>
    personalFactKey(
      { type: fact.type, subject: entityOf(fact.subject), fields },
      opened.capture.key,
      opened.context.compartments,
      undefined,
      2,
    ),
  );

// Whether a fact's words lie in no one passage the lane lists, so a claim must cite a run. The
// passages are the repaired turns.
const needsRun = (plan: MeetingPlan, fact: EvalMeetingFact): boolean =>
  !plan.passages.some((one) => one.text.includes(saidOf(fact)));

// One meeting's result: the counts, the expected facts not found and the found facts not expected.
// For `--detail`, which prints the synthetic set's own words, each meeting's drop counts, each
// candidate the model proposed with its outcome, and the words and domain of each fact missed and
// each extra, so a live run shows where facts are lost. `relation`, an affiliation's, printed
// beside its organization. `runs` counts the expected facts a claim must cite a run to state,
// reported and not gated; `credit`, gated: the meetings the set cut across labels (`fragmented`),
// those the lane found unreliable, the fragmented ones it found reliable (`missed`), and the claims
// credited to the owner (assertedBy the owner) from a meeting whose labels it found unreliable
// (`ownerWord`), which must be none; `windows`, the most windows one meeting was asked in,
// reported. `assigned` counts claims credited to anyone from a meeting found unreliable, `wrong`
// the matched facts credited otherwise than the set expects (`creditOf`), and `owned` the matched
// facts credited to the owner, which an own-word call must give, so a lane that credits nobody
// cannot pass; each must be as the gate says. `scenarios` gates recall on each failure mode's
// meetings alone.
export type MeetingEvalReport = {
  types: EvalTypeLine[];
  meetings: number;
  extras: number;
  extrasAllowed: number;
  failed: string[];
  deck: boolean;
  passed: boolean;
  detail: MeetingDetail[];
  runs: { expected: number; found: number };
  drops: CaptureTally;
  credit: {
    fragmented: number;
    unreliable: number;
    missed: string[];
    assigned: number;
    wrong: number;
    owned: number;
    owners: number;
    passed: boolean;
  };
  scenarios: { scenario: EvalScenario; expected: number; found: number; extra: number; passed: boolean }[];
  // Found facts that repeat a matched one, which no extra counts. Reported.
  repeats: number;
  windows: number;
  // Of the matched owner-side facts, those whose domain is one the set accepts; of the matched
  // commitments, those whose due day is the set's; and the matched facts whose fact key is not the
  // set's (key drift). Reported, not gated.
  agreement: { domains: number; domainsAgree: number; dues: number; duesAgree: number; keyDrift: number };
  // For each meeting paired with a clean one, its facts, how many the clean meeting found and how
  // many it found. Reported, not gated: the difference is the measure.
  paired: { id: string; facts: number; clean: number; found: number }[];
};

const shape = shapeOf(OWNER_ENTITY, new Set(Object.keys(NAMES).map(entityOf)));

export function creditOf(meeting: EvalMeeting, fact: EvalMeetingFact): LocalEntityId | null {
  if (meeting.item.mode !== "call" || meeting.fragmented === true || meeting.unreliable === true) return null;
  // Or a run of one speaker's consecutive segments on one channel, as a sentence a pause cut in two
  // is.
  const { segments } = meeting.item;
  const line = segments
    .map((one, n) => {
      let text = one.text;
      for (
        let next = n + 1;
        !text.includes(saidOf(fact)) &&
        segments[next]?.speaker === one.speaker &&
        segments[next]?.channel === one.channel;
        next += 1
      )
        text = `${text} ${segments[next]?.text}`;
      return { ...one, text };
    })
    .find((one) => one.text.includes(saidOf(fact)));
  const speaker = meeting.item.speakers.find((one) => one.label === line?.speaker);
  if (line === undefined || speaker === undefined) return null;
  if (speaker.owner) return meeting.ownWord === true && line.channel === "input" ? OWNER_ENTITY : null;
  const address =
    speaker.mention?.address ??
    (speaker.mention?.name === undefined ? undefined : meeting.bound?.[speaker.mention.name]);
  return address === undefined ? null : entityOf(address);
}

const sameFact = sameFactOf(entityOf);

type FoundInMeeting = ReturnType<typeof foundOf> & { assertedBy: LocalEntityId | null };

// What one meeting's requests found: the claims kept, the drop tally, each candidate the model
// proposed with its outcome, and how many claims were credited to anyone.
type MeetingAnswer = {
  answered: boolean;
  found: FoundInMeeting[];
  drops: CaptureTally;
  proposals: MeetingProposal[];
  assigned: number;
};

// One meeting through the lane: asked, then checked as a run checks it. A meeting the model
// withholds, or answers in a way the lane refuses, is not answered and finds nothing; the model
// away, refused or over a budget ends the check by its error.
async function askEvalMeeting(
  plan: MeetingPlan,
  opened: OpenedCapture,
  port: { model: ModelClient; calls: ModelCallStore },
): Promise<MeetingAnswer> {
  const none: MeetingAnswer = { answered: false, found: [], drops: {}, proposals: [], assigned: 0 };
  const due: DueCapture = {
    evidenceId: opened.context.evidenceId as DueCapture["evidenceId"],
    compartments: ["own"],
    observedAt: opened.capture.startedAt,
    attempts: 0,
    override: false,
  };
  try {
    const asked = await askMeeting(plan, port, false);
    if ("withheld" in asked) return none;
    const outcomes: string[] = [];
    const checked = await checkMeeting(
      asked.answers,
      plan,
      opened,
      due,
      KEY_V2_GENERATION,
      meetingIdentity(opened),
      outcomes,
    );
    return {
      answered: true,
      drops: checked.tally,
      proposals: asked.answers
        .flatMap((answer) => answer.output.claims)
        .map((claim, n) => ({
          type: JSON.stringify(claim.type),
          subject: claim.subject.key.value,
          said: saidIn(claim.type, claim.fields),
          domain: JSON.stringify(String(claim.fields.domain ?? "")),
          span: claim.span,
          outcome: outcomes[n] ?? "none",
        })),
      assigned: checked.claims.filter((record) => record.claim.assertedBy !== undefined).length,
      found: checked.claims
        .filter((record) => (MEETING_TYPES as readonly string[]).includes(record.claim.content.type))
        .map((record) => ({ ...foundOf(record), assertedBy: record.claim.assertedBy ?? null })),
    };
  } catch (error) {
    if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
    return none;
  }
}

// Of the expected facts the set credits to the owner, those found credited to the owner, matched
// by type and words among the claims about the owner, not by the whole fact key, so a commitment
// found with another due day still shows whether code credited the owner's line to the owner.
function ownerCredited(
  expected: readonly { type: string; said: string; credit: LocalEntityId | null }[],
  found: readonly FoundInMeeting[],
): number {
  const credited = found.filter((one) => one.subject === OWNER_ENTITY && one.assertedBy === OWNER_ENTITY);
  const used = new Set<number>();
  let owned = 0;
  for (const fact of expected.filter((one) => one.credit === OWNER_ENTITY)) {
    // And its words, so another claim of the type cannot stand in for the fact.
    const at = credited.findIndex(
      (one, n) => !used.has(n) && one.type === fact.type && sameStatement(fact.said, one.said),
    );
    if (at >= 0) {
      used.add(at);
      owned += 1;
    }
  }
  return owned;
}

// The set, each meeting through the lane. A meeting the model withholds or answers in a way the
// lane refuses is failed and finds nothing; the model away, refused or over a budget ends the check
// by its error.
export async function evaluateMeetings(
  port: { model: ModelClient },
  set: readonly EvalMeeting[] = EVAL_MEETINGS,
): Promise<MeetingEvalReport> {
  const calls = callsInMemory();
  const { counts, line } = typeCounts(MEETING_TYPES);
  const failed: string[] = [];
  const detail: MeetingDetail[] = [];
  const runs = { expected: 0, found: 0 };
  const drops: CaptureTally = {};
  const credit = { fragmented: 0, unreliable: 0, missed: [] as string[], assigned: 0, wrong: 0, owned: 0, owners: 0 };
  const agreement = { domains: 0, domainsAgree: 0, dues: 0, duesAgree: 0, keyDrift: 0 };
  const scenarios = new Map<EvalScenario, { expected: number; found: number; extra: number }>();
  // Found facts that repeat a matched one, reported.
  let repeats = 0;
  // Each meeting's matched expected facts by index, by its title, for `paired`.
  const matchedBy = new Map<string, Set<number>>();
  let windows = 0;
  const hasDeck = (meeting: EvalMeeting): boolean =>
    meeting.item.segments.some((segment) => segment.text === DECK_LINE);
  let deck = !set.some(hasDeck);
  // `--detail` prints words only of the synthetic set's own meetings; any other meeting's detail
  // keeps its counts and shapes alone.
  const synthetic = (meeting: EvalMeeting): boolean => EVAL_MEETINGS.some((known) => known.item === meeting.item);
  for (const meeting of set) {
    const opened = openEvalMeeting(meeting);
    const plan = planMeeting(opened);
    const unreliable = plan.labels?.reliable === false;
    windows = Math.max(windows, plan.groups.length);
    if (meeting.fragmented === true) credit.fragmented += 1;
    if (unreliable) credit.unreliable += 1;
    if ((meeting.fragmented === true || meeting.unreliable === true) && !unreliable) credit.missed.push(meeting.id);
    const expected = meeting.expected.map((fact) => ({
      type: fact.type,
      keys: expectedKeys(opened, fact),
      run: needsRun(plan, fact),
      what: fact.type === "commitment" || fact.type === "plan" ? fact.what : undefined,
      said: saidOf(fact),
      credit: creditOf(meeting, fact),
      fact,
      shape: shape({
        ...fact,
        subject: entityOf(fact.subject),
        counterparty: "counterparty" in fact ? entityOf(fact.counterparty) : undefined,
      }),
    }));
    credit.owners += expected.filter((fact) => fact.credit === OWNER_ENTITY).length;
    for (const fact of expected) line(fact.type).expected += 1;
    const asked = await askEvalMeeting(plan, opened, { model: port.model, calls });
    const { found } = asked;
    addDrops(drops, asked.drops);
    if (unreliable) credit.assigned += asked.assigned;
    // A found fact's fact key need not equal the expected one's; when it does not that is key drift,
    // reported, since production keys by it. Its domain and due day are reported as agreement, not
    // matched on. A found fact that is one of the meeting's allowed facts, with its true subject, is
    // neither matched nor an extra; one that repeats a matched fact or has an expected fact's key
    // is a repeat, as two windows may each keep it, not an extra.
    const paired = pairFacts(expected, found, sameFact, meeting.allowed ?? []);
    const { pairs, matched, extras } = paired;
    agreement.keyDrift += paired.lenient.filter(({ fact, one }) => !fact.keys.includes(one.key)).length;
    for (const { fact, one } of pairs) {
      if (Object.hasOwn(KEY_FIELDS, fact.type) && "domain" in fact.fact) {
        agreement.domains += 1;
        if ([fact.fact.domain, ...(fact.fact.domains ?? [])].includes(one.domain as LifeDomain))
          agreement.domainsAgree += 1;
      }
      if (fact.type === "commitment" && fact.fact.type === "commitment") {
        agreement.dues += 1;
        if ((fact.fact.due ?? null) === (typeof one.due === "string" ? one.due : null)) agreement.duesAgree += 1;
      }
    }
    repeats += paired.repeats;
    matchedBy.set(
      meeting.item.title ?? meeting.id,
      new Set(expected.flatMap((fact, n) => (matched.includes(fact) ? [n] : []))),
    );
    for (const { fact, one } of pairs) if (one.assertedBy !== fact.credit) credit.wrong += 1;
    // Recall is the type lines' and the scenarios' to gate; this gate is credit's.
    credit.owned += ownerCredited(expected, found);
    for (const fact of matched) line(fact.type).found += 1;
    if (meeting.scenario !== undefined) {
      const tally = scenarios.get(meeting.scenario) ?? { expected: 0, found: 0, extra: 0 };
      scenarios.set(meeting.scenario, {
        expected: tally.expected + expected.length,
        found: tally.found + matched.length,
        extra: tally.extra + extras.length,
      });
    }
    runs.expected += expected.filter((fact) => fact.run).length;
    runs.found += matched.filter((fact) => fact.run).length;
    for (const one of extras) line(one.type).extra += 1;
    if (!asked.answered || matched.length < expected.length || extras.length > 0) failed.push(meeting.id);
    detail.push({
      id: meeting.id,
      evidenceId: opened.context.evidenceId,
      answered: asked.answered,
      expected: expected.length,
      matched: matched.length,
      missed: expected.filter((fact) => !matched.includes(fact)).map((fact) => fact.shape),
      extra: extras.map(shape),
      drops: asked.drops,
      ...(synthetic(meeting)
        ? {
            proposals: asked.proposals,
            missedSaid: meeting.expected
              .filter((_, n) => !matched.includes(expected[n] as (typeof expected)[number]))
              .map((fact) => `${fact.type} "${saidOf(fact)}" ${"domain" in fact ? fact.domain : ""}`.trim()),
            extraSaid: extras.map((one) => `${one.type} ${JSON.stringify(one.said)} ${JSON.stringify(one.domain)}`),
          }
        : {}),
    });
    if (hasDeck(meeting)) deck = deckHeld(found, DECK_LINE, entityOf(ROBIN), OWNER_ENTITY);
  }
  const types = gatedLines(counts);
  const extras = extrasOf(counts);
  const extrasLimit = extrasAllowed(set.length);
  const { owners, ...counted } = credit;
  // The owner's word must be found where the set expects it, at the recall line, so crediting nobody fails.
  const credited = { ...counted, owners, passed: creditPassed(credit, owners) };
  // Where labels flip (fragmented, remote), a guessed subject is a claim about the wrong person, so
  // each scenario's extras are bounded by its own facts, at the set's share.
  const byScenario = [...scenarios].map(([scenario, one]) => ({
    scenario,
    ...one,
    passed: scenarioPassed(scenario, one),
  }));
  // The paired recall, fact by fact, of each meeting the set pairs with another in it: how many of
  // its facts the clean meeting found, and how many it found itself.
  const paired = set.flatMap((meeting) => {
    const clean = meeting.paired === undefined ? undefined : matchedBy.get(meeting.paired.title);
    const own = matchedBy.get(meeting.item.title ?? meeting.id);
    if (meeting.paired === undefined || clean === undefined || own === undefined) return [];
    return [
      {
        id: meeting.id,
        facts: meeting.paired.facts.length,
        clean: meeting.paired.facts.filter((at) => clean.has(at)).length,
        found: meeting.paired.facts.filter((_, n) => own.has(n)).length,
      },
    ];
  });
  return {
    types,
    meetings: set.length,
    extras,
    extrasAllowed: extrasLimit,
    failed,
    deck,
    detail,
    runs,
    drops,
    credit: credited,
    agreement,
    scenarios: byScenario,
    paired,
    repeats,
    windows,
    passed: meetingPassed({ types, extras, extrasAllowed: extrasLimit, deck, credit: credited, scenarios: byScenario }),
  };
}

// Where labels flip (fragmented, remote), a guessed subject is a claim about the wrong person, so
// each scenario's extras are bounded by its own facts, at the set's share; the same rule holds over
// pooled runs.
const SCENARIO_EXTRAS: readonly EvalScenario[] = ["fragmented", "remote", "context"];
const scenarioPassed = (
  scenario: EvalScenario,
  one: { expected: number; found: number; extra: number },
  runs = 1,
): boolean =>
  recalledAt(one.found, one.expected / runs, runs) &&
  (!SCENARIO_EXTRAS.includes(scenario) || one.extra <= extrasBound(one.expected / runs, runs));

// Credit's gate, over one run or pooled runs: nothing credited from unreliable labels, no matched
// fact credited otherwise, no fragmented meeting found reliable, and the owner's word found at the
// recall line of `owners` facts a run.
const creditPassed = (
  credit: { assigned: number; wrong: number; missed: readonly string[]; owned: number },
  owners: number,
  runs = 1,
): boolean =>
  credit.assigned === 0 && credit.wrong === 0 && credit.missed.length === 0 && recalledAt(credit.owned, owners, runs);

// The gate, the same for one run and for pooled runs.
const meetingPassed = (
  report: Pick<MeetingEvalReport, "types" | "extras" | "extrasAllowed" | "deck" | "credit" | "scenarios">,
): boolean =>
  report.types.every((one) => one.passed) &&
  report.extras <= report.extrasAllowed &&
  report.deck &&
  report.credit.passed &&
  report.scenarios.every((one) => one.passed);

// Twenty gates at 88 percent each pass together about one run in twelve, so the evaluation is run
// `runs` times, each independent (its own saved calls), and gated on the pooled counts. The model's
// counts are pooled: each gated type and scenario found at least 0.8 of N times its facts, the
// owner's word likewise, extras at most 0.2 of N times the meetings, a labels-flip scenario's at
// most 0.2 of N times its facts, each line the per-run line times N (no rounding in the model's
// favour). `systematic` names each missed or extra fact shape, by meeting, that more than half the
// runs share, and `each` whether each run would have passed alone.
export type PooledMeetingReport = MeetingEvalReport & { pooled: number; systematic: string[]; each: boolean[] };
// `onRun` is told each run's number before it starts (`callStatsByRun`).
export async function evaluateMeetingsPooled(
  port: { model: ModelClient; onRun?: (run: number) => void },
  runs: number,
  set: readonly EvalMeeting[] = EVAL_MEETINGS,
): Promise<PooledMeetingReport> {
  const reports: MeetingEvalReport[] = [];
  for (let n = 0; n < runs; n += 1) {
    port.onRun?.(n + 1);
    reports.push(await evaluateMeetings(port, set));
  }
  return poolMeetingReports(reports);
}
export function poolMeetingReports(reports: readonly MeetingEvalReport[]): PooledMeetingReport {
  const first = reports[0];
  if (first === undefined) throw new Error("no runs to pool");
  const n = reports.length;
  const sum = (of: (one: MeetingEvalReport) => number): number => reports.reduce((total, one) => total + of(one), 0);
  const types = pooledTypeLines(reports);
  const scenarios = first.scenarios.map((line) => {
    const of = (key: "expected" | "found" | "extra") =>
      sum((one) => one.scenarios.find((other) => other.scenario === line.scenario)?.[key] ?? 0);
    const pooled = { scenario: line.scenario, expected: of("expected"), found: of("found"), extra: of("extra") };
    return { ...pooled, passed: scenarioPassed(line.scenario, pooled, n) };
  });
  const credit = {
    fragmented: first.credit.fragmented,
    unreliable: first.credit.unreliable,
    missed: [...new Set(reports.flatMap((one) => one.credit.missed))],
    assigned: sum((one) => one.credit.assigned),
    wrong: sum((one) => one.credit.wrong),
    owned: sum((one) => one.credit.owned),
    owners: sum((one) => one.credit.owners),
  };
  const credited = { ...credit, passed: creditPassed(credit, first.credit.owners, n) };
  const extras = sum((one) => one.extras);
  const extrasLimit = extrasBound(first.meetings, n);
  const deck = reports.every((one) => one.deck);
  const agreement = {
    domains: sum((one) => one.agreement.domains),
    domainsAgree: sum((one) => one.agreement.domainsAgree),
    dues: sum((one) => one.agreement.dues),
    duesAgree: sum((one) => one.agreement.duesAgree),
    keyDrift: sum((one) => one.agreement.keyDrift),
  };
  const drops: CaptureTally = {};
  for (const one of reports) addDrops(drops, one.drops);
  const paired = first.paired.map((line) => {
    const of = (key: "facts" | "clean" | "found") =>
      sum((one) => one.paired.find((other) => other.id === line.id)?.[key] ?? 0);
    return { id: line.id, facts: of("facts"), clean: of("clean"), found: of("found") };
  });
  // A shape more than half the runs share, with how many runs show it, so a failure that recurs in
  // two runs of three is named though the pooled gate passes.
  const systematic = systematicOf(reports.map((one) => one.detail));
  return {
    types,
    meetings: first.meetings,
    extras,
    extrasAllowed: extrasLimit,
    failed: [...new Set(reports.flatMap((one) => one.failed))],
    deck,
    detail: detailByRun(reports),
    runs: { expected: sum((one) => one.runs.expected), found: sum((one) => one.runs.found) },
    drops,
    credit: credited,
    agreement,
    scenarios,
    paired,
    repeats: sum((one) => one.repeats),
    windows: Math.max(...reports.map((one) => one.windows)),
    passed: meetingPassed({ types, extras, extrasAllowed: extrasLimit, deck, credit: credited, scenarios }),
    pooled: n,
    systematic: n > 1 ? systematic : [],
    each: reports.map((one) => one.passed),
  };
}
