// The evaluations `pi extract check` runs against a live model, with their report lines. They ship
// because that command does, by this entry, so no other importer of the package loads them; the
// sets they score are exported only through ./testing, and the evaluations no command runs are test
// support.
export { correspondenceReportLines, evaluateCorrespondence } from "./eval/eval-correspondence.ts";
export { evaluateDocuments, reportLines } from "./eval/eval-documents.ts";
export { evaluateDueNotices } from "./eval/eval-due-notices.ts";
export type { MeetingDetail } from "./eval/eval-facts.ts";
export { evaluateMeetings, evaluateMeetingsPooled } from "./eval/eval-meetings.ts";
export {
  callStatsByRun,
  meetingDetailLines,
  meetingReportLines,
  pooledMeetingReportLines,
} from "./eval/eval-meetings-report.ts";
export {
  evaluateMoments,
  evaluateMomentsPooled,
  momentReportLines,
  momentSpeakerLines,
  pooledMomentReportLines,
} from "./eval/eval-moments.ts";
export { evaluateSecondDegree, secondDegreeReportLines } from "./eval/eval-second-degree.ts";
export { evaluateTransactions, transactionReportLines } from "./eval/eval-transactions.ts";
