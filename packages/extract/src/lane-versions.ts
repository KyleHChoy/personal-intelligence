import type { OntologyView } from "@intelligence/contracts";
import { type AskedLane, FACT_KIND_LANES, type FactKindLane, type MessageLane } from "@intelligence/contracts/personal";
import {
  ADDED_FACT_TYPES,
  beforeSecondDegree,
  PERSONAL_TYPES,
  type PersonalType,
  PROJECT_FINDING_TYPES,
  RELATIONSHIP_SD,
  V4_TYPES,
  VERSION_1_TYPES,
  viewOf,
} from "@intelligence/personal-beliefs";

// Every version of every lane's prompt, one row each, oldest first. The row says what the types the
// check accepts are and what the version is in its lane's history. The pins, the decision points, a
// run's choice of version and the check's rules by version all read these rows. A new prompt version
// is a row here, its text in prompts.ts and its pin in the contracts' PROMPT_PINS.

// The lanes a model is asked in with types of their own: a message's two, and the document, meeting
// and moment lanes, which offer types of the correspondence lane and have none of their own.
type ModelLane = MessageLane | "document" | "meeting" | "moment";
// What has a prompt and versions: those, an agent record's, and the own-lines lane's.
export type VersionedLane = ModelLane | AskedLane | "ownLines";
export type SecondDegreeLane = "correspondence" | "agent" | "meeting" | "moment";

export type VersionRow = {
  version: string;
  // The types the check takes an answer of this version under.
  view: OntologyView;
  // The version a run asks with no switch on.
  base?: true;
  // Asked only under PI_EXTRACT_SECOND_DEGREE: the base with the relationship's every relation and
  // intro_offer.
  secondDegree?: true;
  // A fact-kind version, asked only for new items of a lane named in PI_EXTRACT_FACT_KINDS: its place
  // among its lane's wordings. A later wording changes the words alone, so a saved call of an earlier
  // one is read under the same types and rules.
  wording?: number;
  // The fact-kind version a new item of the lane is asked.
  asked?: true;
  // Told of the project code found: fixed, so a later version does not change how a saved call of
  // this one is read. A moment's is asked only for a group with a project in it, so it is no lane's
  // asked version and the others keep the asked one and its saved calls.
  project?: true;
  // Its commitments pass the bar (commitment-bar.ts): the wording that tells the model what it
  // refuses, and any after it. A claim of an earlier version keeps passing as it did at every rebuild.
  commitmentBar?: true;
  // What the lane's code takes up from this version on, which every later row keeps.
  from?: readonly VersionBehaviour[];
};

export type VersionBehaviour = "roomRuns" | "turns" | "pauseAndRemote" | "ties" | "roomContext" | "joinedTurns";

// What the document lane offers. A document's text has no author, so no type of the transaction
// lane, whose subject is the owner by the headers, is in it.
export const DOCUMENT_TYPES = Object.freeze(["commitment", "plan"] as const);

// What personal_meeting version 1 offers: the two version 1 correspondence types.
export const MEETING_TYPES_V1 = Object.freeze(["commitment", "plan"] as const);
// What version 2 offers, the person-fact types beside those two: role, affiliation, relationship
// and the six owner-side kinds, in correspondence version 4's shape.
export const MEETING_TYPES = Object.freeze([
  "commitment",
  "plan",
  "role",
  "affiliation",
  "relationship",
  "need",
  "capability",
  "goal",
  "preference",
  "constraint",
  "situation",
] as const);

// What personal_moment versions 1 and 2 offer: the same two.
export const MOMENT_TYPES_V1 = Object.freeze(["commitment", "plan"] as const);
// What version 3 offers, the meeting lane's eleven, as a list of its own, so a later meeting
// version cannot change what moment version 3 checks.
export const MOMENT_TYPES = Object.freeze([
  "commitment",
  "plan",
  "role",
  "affiliation",
  "relationship",
  "need",
  "capability",
  "goal",
  "preference",
  "constraint",
  "situation",
] as const);

// What personal_transaction version 2 offers, a notice's two types beside the receipt: a status of
// the owner's (a situation) and a dated appointment (a plan). Version 1 offers the receipt alone.
// Both have the owner as their subject, which the lane sets by code (check.ts ownerSubject).
export const TRANSACTION_TYPES_V2 = Object.freeze(["transaction.receipt", "situation", "plan"] as const);

// Version 4's correspondence lane: version 3's types, the owner-side kinds in their version 4.
export const CORRESPONDENCE_V4_TYPES: readonly PersonalType[] = Object.freeze(
  PERSONAL_TYPES.filter((type) => type.lane === "correspondence" && beforeSecondDegree(type)).map(
    (type) => V4_TYPES.find((next) => next.id === type.id) ?? type,
  ),
);
// Version 2's meeting types, each as correspondence version 4 writes it.
export const MEETING_V2_TYPES: readonly PersonalType[] = Object.freeze(
  CORRESPONDENCE_V4_TYPES.filter((type) => (MEETING_TYPES as readonly string[]).includes(type.id)),
);
// Version 3's moment types, each as correspondence version 4 writes it.
export const MOMENT_V3_TYPES: readonly PersonalType[] = Object.freeze(
  CORRESPONDENCE_V4_TYPES.filter((type) => (MOMENT_TYPES as readonly string[]).includes(type.id)),
);
// Version 2's transaction types: the receipt, and the situation in correspondence version 4's shape
// (its state phrase and life domain), as the meeting and moment lanes write it; the plan has one
// shape.
export const TRANSACTION_V2_TYPES: readonly PersonalType[] = Object.freeze(
  TRANSACTION_TYPES_V2.map(
    (id) =>
      (PERSONAL_TYPES.find((type) => type.id === id && type.lane === "transaction") ??
        CORRESPONDENCE_V4_TYPES.find((type) => type.id === id)) as PersonalType,
  ),
);

// The second-degree versions' types: the version before with the relationship's every relation and
// intro_offer.
const secondDegreeOf = (types: readonly PersonalType[]): readonly PersonalType[] =>
  Object.freeze([
    ...types.map((type) => (type.id === RELATIONSHIP_SD.id ? RELATIONSHIP_SD : type)),
    ...PERSONAL_TYPES.filter((type) => !beforeSecondDegree(type)),
  ]);
const CORRESPONDENCE_SD_TYPES = secondDegreeOf(CORRESPONDENCE_V4_TYPES);
const MEETING_SD_TYPES = secondDegreeOf(MEETING_V2_TYPES);
const MOMENT_SD_TYPES = secondDegreeOf(MOMENT_V3_TYPES);

// The kinds each fact-kind version adds to the version it is built from.
export const FACT_KIND_ADDED: Readonly<Record<"conversation" | "transaction", readonly string[]>> = Object.freeze({
  conversation: Object.freeze(["view", "status", "visited"]),
  transaction: Object.freeze(["status"]),
});
const addedTypes = (ids: readonly string[]): PersonalType[] =>
  ids.map((id) => ADDED_FACT_TYPES.find((type) => type.id === id) as PersonalType);
const factKindsOf = (types: readonly PersonalType[]): readonly PersonalType[] =>
  Object.freeze([...types, ...addedTypes(FACT_KIND_ADDED.conversation)]);
export const CORRESPONDENCE_FK_TYPES: readonly PersonalType[] = factKindsOf(CORRESPONDENCE_SD_TYPES);
export const MEETING_FK_TYPES: readonly PersonalType[] = factKindsOf(MEETING_SD_TYPES);
export const MOMENT_FK_TYPES: readonly PersonalType[] = factKindsOf(MOMENT_SD_TYPES);
export const TRANSACTION_V3_TYPES: readonly PersonalType[] = Object.freeze(
  TRANSACTION_V2_TYPES.flatMap((type) => (type.id === "situation" ? addedTypes(FACT_KIND_ADDED.transaction) : [type])),
);
export const PROJECT_NEXT_STEP = PROJECT_FINDING_TYPES[1] as PersonalType;
// A chat's project version offers its status and its decisions, from the owner's own lines.
export const MOMENT_PROJECT_TYPES: readonly PersonalType[] = Object.freeze(
  ["project.status", "project.decision"].map((id) => PERSONAL_TYPES.find((type) => type.id === id) as PersonalType),
);

// The own-lines lane: the fact kinds a person states of themselves. A commitment, a relationship and an
// offer read someone else, and a status takes its newest word, so it has none.
const OWN_LINES_IDS: readonly string[] = [
  "goal",
  "need",
  "capability",
  "preference",
  "constraint",
  "situation",
  "plan",
  "role",
  "affiliation",
  "view",
  "visited",
];
export const OWN_LINES_TYPES: readonly PersonalType[] = Object.freeze(
  MOMENT_FK_TYPES.filter((type) => OWN_LINES_IDS.includes(type.id)),
);

// The one lane's types and no other, and never a parent: what the shared check is given.
const CORRESPONDENCE_V1 = viewOf(
  PERSONAL_TYPES.filter((type) => type.lane === "correspondence" && beforeSecondDegree(type)),
);
const CORRESPONDENCE_V4 = viewOf(CORRESPONDENCE_V4_TYPES);
const CORRESPONDENCE_SD = viewOf(CORRESPONDENCE_SD_TYPES);
const CORRESPONDENCE_FK = viewOf(CORRESPONDENCE_FK_TYPES);
const MEETING_V1 = viewOf(PERSONAL_TYPES.filter((type) => (MEETING_TYPES_V1 as readonly string[]).includes(type.id)));
const MEETING_V2 = viewOf(MEETING_V2_TYPES);
const MEETING_FK = viewOf(MEETING_FK_TYPES);
const MOMENT_V1 = viewOf(PERSONAL_TYPES.filter((type) => (MOMENT_TYPES_V1 as readonly string[]).includes(type.id)));
const MOMENT_V3 = viewOf(MOMENT_V3_TYPES);
const MOMENT_FK = viewOf(MOMENT_FK_TYPES);
const TRANSACTION_V2 = viewOf(TRANSACTION_V2_TYPES);
const TRANSACTION_V3 = viewOf(TRANSACTION_V3_TYPES);
const DOCUMENT = viewOf(PERSONAL_TYPES.filter((type) => (DOCUMENT_TYPES as readonly string[]).includes(type.id)));
export const OWN_LINES_VIEW: OntologyView = viewOf(OWN_LINES_TYPES);

const row = (version: string, view: OntologyView, facts: Omit<VersionRow, "version" | "view"> = {}): VersionRow => ({
  version,
  view,
  ...facts,
});
// A lane's fact-kind versions, each its next wording, the asked one and the bar's as told.
const fk = (
  versions: readonly string[],
  view: OntologyView,
  { asked, bar }: { asked: string; bar?: readonly string[] },
): VersionRow[] =>
  versions.map((version, wording) =>
    row(version, view, {
      wording,
      ...(version === asked ? { asked: true as const } : {}),
      ...(bar?.includes(version) ? { commitmentBar: true as const } : {}),
    }),
  );

export const LANE_VERSIONS: Readonly<
  Record<VersionedLane, { promptId: string; slot: string; rows: readonly VersionRow[] }>
> = {
  correspondence: {
    promptId: "personal_correspondence",
    slot: "message",
    rows: [
      row("1", CORRESPONDENCE_V1),
      row("2", CORRESPONDENCE_V1),
      row("3", CORRESPONDENCE_V1),
      // The atomic version, which asks one fact per claim, asked from EXTRACT_GENERATION 5 on.
      row("4", CORRESPONDENCE_V4, { base: true }),
      row("5", CORRESPONDENCE_SD, { secondDegree: true }),
      ...fk(["6", "7", "8", "9", "10"], CORRESPONDENCE_FK, { asked: "11", bar: ["10"] }),
      // A message's project, which code found, and its next step.
      row("11", viewOf([...CORRESPONDENCE_FK_TYPES, PROJECT_NEXT_STEP]), {
        wording: 5,
        asked: true,
        project: true,
        commitmentBar: true,
      }),
    ],
  },
  agent: {
    promptId: "personal_agent_record",
    slot: "message",
    rows: [
      // Version 1 lists the two version 1 correspondence types, version 2 every correspondence type.
      row(
        "1",
        viewOf(PERSONAL_TYPES.filter((type) => type.lane === "correspondence" && VERSION_1_TYPES.includes(type.id))),
      ),
      row("2", CORRESPONDENCE_V1),
      row("3", CORRESPONDENCE_V4, { base: true }),
      row("4", CORRESPONDENCE_SD, { secondDegree: true }),
      ...fk(["5", "6", "7", "8"], CORRESPONDENCE_FK, { asked: "9" }),
      // A finding's owner and project mentions and a project's detail and next step.
      row("9", viewOf([...CORRESPONDENCE_FK_TYPES, ...PROJECT_FINDING_TYPES]), {
        wording: 4,
        asked: true,
        project: true,
        commitmentBar: true,
      }),
    ],
  },
  transaction: {
    promptId: "personal_transaction",
    slot: "message",
    rows: [
      // The receipt alone, so a saved call of version 1 replays under it.
      row("1", viewOf(PERSONAL_TYPES.filter((type) => type.lane === "transaction"))),
      // A notice's situation and plan beside the receipt. The generation was not raised for it, so an
      // item done under version 1 keeps its saved answer until the owner's retry asks it again.
      row("2", TRANSACTION_V2, { base: true }),
      ...fk(["3", "4"], TRANSACTION_V3, { asked: "4" }),
    ],
  },
  document: { promptId: "personal_document", slot: "document", rows: [row("1", DOCUMENT, { base: true })] },
  meeting: {
    promptId: "personal_meeting",
    slot: "meeting",
    rows: [
      row("1", MEETING_V1),
      row("2", MEETING_V2, { from: ["roomRuns"] }),
      row("3", MEETING_V2, { from: ["turns"] }),
      row("4", MEETING_V2, { from: ["pauseAndRemote"] }),
      row("5", MEETING_V2),
      row("6", MEETING_V2, { from: ["ties"] }),
      row("7", MEETING_V2, { base: true, from: ["roomContext"] }),
      row("8", viewOf(MEETING_SD_TYPES), { secondDegree: true }),
      ...fk(["9", "10", "11", "12"], MEETING_FK, { asked: "12" }),
    ],
  },
  moment: {
    promptId: "personal_moment",
    slot: "moments",
    rows: [
      row("1", MOMENT_V1),
      row("2", MOMENT_V1),
      row("3", MOMENT_V3),
      row("4", MOMENT_V3, { from: ["joinedTurns"] }),
      row("5", MOMENT_V3),
      row("6", MOMENT_V3),
      row("7", MOMENT_V3),
      row("8", MOMENT_V3),
      row("9", MOMENT_V3, { base: true }),
      row("10", viewOf(MOMENT_SD_TYPES), { secondDegree: true }),
      ...fk(["11", "12", "13", "14", "15"], MOMENT_FK, { asked: "15", bar: ["15"] }),
      // A chat's project, which code found in the owner's own lines, its status and its decisions.
      row("16", viewOf([...MOMENT_FK_TYPES, ...MOMENT_PROJECT_TYPES]), {
        wording: 5,
        project: true,
        commitmentBar: true,
      }),
    ],
  },
  ownLines: { promptId: "personal_own_lines", slot: "moments", rows: [row("1", OWN_LINES_VIEW, { base: true })] },
};

const rowsOf = (lane: VersionedLane): readonly VersionRow[] => LANE_VERSIONS[lane].rows;
export const rowAt = (lane: VersionedLane, version: string): VersionRow | undefined =>
  rowsOf(lane).find((one) => one.version === version);
// Whether a version of the lane does what a row at or before it took up. A version with no row was
// never asked.
export function versionDoes(lane: VersionedLane, version: string, behaviour: VersionBehaviour): boolean {
  const rows = rowsOf(lane);
  const at = rows.findIndex((one) => one.version === version);
  if (at < 0) throw new Error(`${lane}: no prompt version ${version}`);
  return rows.slice(0, at + 1).some((one) => one.from?.includes(behaviour) === true);
}
const only = (lane: VersionedLane, fact: (one: VersionRow) => boolean): string => {
  const [found, more] = rowsOf(lane).filter(fact);
  if (found === undefined || more !== undefined) throw new Error(`${lane}: not one version`);
  return found.version;
};

// The version a run asks with no switch on.
export const baseVersion = (lane: VersionedLane): string => only(lane, (one) => one.base === true);
export const SECOND_DEGREE_VERSIONS: Readonly<Record<SecondDegreeLane, string>> = Object.freeze({
  correspondence: only("correspondence", (one) => one.secondDegree === true),
  agent: only("agent", (one) => one.secondDegree === true),
  meeting: only("meeting", (one) => one.secondDegree === true),
  moment: only("moment", (one) => one.secondDegree === true),
});
const eachFactKindLane = <T>(of: (lane: FactKindLane) => T): Readonly<Record<FactKindLane, T>> =>
  Object.freeze(Object.fromEntries(FACT_KIND_LANES.map((lane) => [lane, of(lane)]))) as Record<FactKindLane, T>;
// Each lane's fact-kind versions, oldest first, and the one a new item of it is asked.
export const FACT_KIND_HISTORY: Readonly<Record<FactKindLane, readonly string[]>> = eachFactKindLane((lane) =>
  Object.freeze(rowsOf(lane).flatMap((one) => (one.wording === undefined ? [] : [one.version]))),
);
export const FACT_KIND_VERSIONS: Readonly<Record<FactKindLane, string>> = eachFactKindLane((lane) =>
  only(lane, (one) => one.asked === true),
);
// The versions told of a project.
const projectVersions = (lane: VersionedLane): readonly string[] =>
  Object.freeze(rowsOf(lane).flatMap((one) => (one.project === true ? [one.version] : [])));
export const AGENT_PROJECT_VERSIONS = projectVersions("agent");
export const CORRESPONDENCE_PROJECT_VERSIONS = projectVersions("correspondence");
export const MOMENT_PROJECT_VERSIONS = projectVersions("moment");
export const commitmentBarVersions = (lane: VersionedLane): readonly string[] =>
  rowsOf(lane).flatMap((one) => (one.commitmentBar === true ? [one.version] : []));
// Atomic versions ask one fact per claim: the base of correspondence and of an agent record, and every
// version built on it. The check grounds a commitment's or a plan's `what` under them as a phrase.
const fromBase = (lane: VersionedLane): readonly string[] => {
  const rows = rowsOf(lane);
  return Object.freeze(rows.slice(rows.findIndex((one) => one.base === true)).map((one) => one.version));
};
export const ATOMIC_VERSIONS: Readonly<Record<"correspondence" | "agent", readonly string[]>> = Object.freeze({
  correspondence: fromBase("correspondence"),
  agent: fromBase("agent"),
});
// The version each second-degree version is built from: the version its lane asks today.
export const SECOND_DEGREE_BASE: Readonly<Record<SecondDegreeLane, string>> = Object.freeze({
  correspondence: baseVersion("correspondence"),
  agent: baseVersion("agent"),
  meeting: baseVersion("meeting"),
  moment: baseVersion("moment"),
});
// The version each fact-kind version is built from.
export const FACT_KIND_BASE: Readonly<Record<FactKindLane, string>> = Object.freeze({
  ...SECOND_DEGREE_VERSIONS,
  transaction: baseVersion("transaction"),
});

// With no version named, a lane's view: correspondence's before the atomic version, the others' base.
const NO_VERSION: Readonly<Record<ModelLane, OntologyView>> = {
  correspondence: CORRESPONDENCE_V1,
  transaction: TRANSACTION_V2,
  document: DOCUMENT,
  meeting: MEETING_V2,
  moment: MOMENT_V3,
};

// The types the check takes an answer under: those of the version asked, so a saved call replays
// under the types it was asked with. A version with no row was never asked.
export function ontologyFor(lane: ModelLane, version?: string): OntologyView {
  if (version === undefined) return NO_VERSION[lane];
  return viewAt(lane, version);
}
function viewAt(lane: VersionedLane, version: string): OntologyView {
  const found = rowAt(lane, version);
  if (found === undefined) throw new Error(`${lane}: no prompt version ${version}`);
  return found.view;
}
// An agent record's check takes the types of the prompt version it asked, so it accepts what the
// prompt asks and nothing more.
export const agentOntology = (version: string): OntologyView => viewAt("agent", version);
