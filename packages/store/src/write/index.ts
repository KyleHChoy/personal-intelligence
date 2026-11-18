// @intelligence/personal-store/write. The Writer, as pi_writer. What other packages import from
// this context; the package root re-exports the same names.
export { createWriter, sourceAccountOf, type Writer } from "./writer.ts";
export { AGENT_PEOPLE_PREFIX, type ConfirmedProposal } from "./writer-agent-people.ts";
export type { ImportPreview } from "./writer-import.ts";
export type { GoogleAccountRow, SourceAccountRow, SyncCounts } from "./writer-types.ts";
