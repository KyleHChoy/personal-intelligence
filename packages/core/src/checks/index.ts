// @intelligence/personal-core/checks. Checks on what agents write: claim intake, kind checks, phrase similarity, people intake and inbound memory.
export {
  type CheckedKind,
  checkKeyFields,
  factLine,
  interpretationRefusal,
  passedOffAsOwners,
  sliceGrounded,
  summaryStandsAlone,
  wordGrounded,
} from "./claim-intake.ts";
export { namesPerson } from "./kind-checks.ts";
export { splitEntries } from "./memory-inbound.ts";
export { personProposalRefusal } from "./people-intake.ts";
export { phraseSimilarity, SAME_FACT_SIMILARITY } from "./phrase-similarity.ts";
