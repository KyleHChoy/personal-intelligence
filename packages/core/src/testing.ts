// The fakes and the synthetic world every personal test uses: fixtures on reserved domains, so no
// real data enters the repository.

export { type FakeCalendar, fakeCalendar } from "./test-support/calendar.ts";
export {
  csvOf,
  GOOGLE_CONTACTS,
  GOOGLE_CONTACTS_OLD,
  LINKEDIN_CONNECTIONS,
  RESEARCH_SHEET,
  RESEARCH_SHEET_HEADERS,
  RESEARCH_SHEET_MAPPING,
  RESEARCH_SHEET_ROWS,
} from "./test-support/contact-files.ts";
// The evaluation set of hard contradictions, which the relation step's evaluation scores.
export {
  CONTRADICTION_CLAIMS,
  CONTRADICTION_SCENARIOS,
  CONTRADICTIONS,
  type ContradictionClaim,
  type ContradictionPair,
  type ContradictionRelation,
  type ContradictionScenario,
  contradictionCounts,
  wilsonInterval,
} from "./test-support/contradictions.ts";
export { documentationFold, FOLD_SETUP, useDocumentationFold } from "./test-support/domains.ts";
export { type FakeDrive, type FakeDriveFile, fakeDrive } from "./test-support/drive.ts";
export { type FakeGmail, fakeGmail } from "./test-support/gmail.ts";
export {
  correspondentsOf,
  HIDDEN_ONLY,
  type HiddenOptions,
  hiddenWorld,
  isReserved,
} from "./test-support/hidden-world.ts";
export { fakeLens, LENS_PHONES, type LensHandles, type LensScopeRule, type LensWorld } from "./test-support/lens.ts";
// The outcome evaluation set.
export {
  OUTCOME_CASES,
  type OutcomeEvalAnswer,
  type OutcomeEvalCase,
  type OutcomeEvalKind,
  type OutcomeEvalScenario,
  type OutcomeEvalSource,
  outcomeCaseCounts,
} from "./test-support/outcomes.ts";
export { type FakeContacts, fakeContacts } from "./test-support/people.ts";
export {
  type FakeProvider,
  fakeProvider,
  fakeTurnModel,
  type ProviderCall,
  type ScriptedAnswer,
} from "./test-support/providers.ts";
export { fakeSources } from "./test-support/sources.ts";
export type { FailureKind } from "./test-support/support.ts";
export {
  type FakeWeb,
  type FakeWebWorld,
  fakeWeb,
  type WebPage,
  type WebRobots,
  type WebSearch,
} from "./test-support/web.ts";
export {
  type DecideOutput,
  type ExpectedPageClaim,
  type ResearchSubject,
  type World,
  type WorldAccount,
  type WorldFact,
  type WorldHandles,
  type WorldResearch,
  world,
  worldModelOutputs,
} from "./test-support/world.ts";
export type { WorldDocument, WorldDrive } from "./test-support/world-documents.ts";
