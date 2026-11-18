// @intelligence/personal-core/lens. Lens and work time: captures, anchors, activity categories, the moment lane and the work-time engine.
export { activityDay, activityTable } from "./activity.ts";
export { blockMatchKeys, captureMatchKeys, deviceAnchorKey, titleTooDeep } from "./anchors.ts";
export {
  type CaptureFacts,
  captureBlock,
  captureFacts,
  meetingText,
  momentLines,
  OWN_WORD_WINDOW_MS,
  SERVED_ID_PREFIXES,
  sourceOwnerWord,
  systemIdIn,
} from "./capture.ts";
export { mirrorEntryValues, mirrorValue } from "./mirror.ts";
export { MOMENT_THREAD_DAYS, momentBatchCutoff, threadWindows } from "./moment-batch.ts";
export { credentialShaped, pathText, TEXT_WORDS_MAX, TOPIC_STOP_WORDS, wordRuns, words } from "./pages.ts";
export { checkedChoices, groupStretches, type TimeGroup, uncreditedStretches } from "./time-groups.ts";
export { type WorkRequest, type WorkViews, workTime, workWindows } from "./work-time.ts";
export {
  blockIntervals,
  creditIntervals,
  type SortTitles,
  titleKeysOf,
  type WorkCommitment,
  type WorkInputs,
  type WorkProject,
  type WorkRow,
} from "./work-time-credit.ts";
export {
  attributeCheck,
  captureWorkOf,
  lineCount,
  sealedTitle,
  type TitleSeal,
  titleFpsOf,
  withTitles,
} from "./work-time-seal.ts";
