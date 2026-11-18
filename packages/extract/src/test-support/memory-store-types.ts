import type { EvidenceId, LocalEntityId, Timestamp } from "@intelligence/contracts";
import type { MeetingCaptureFacts, MeetingItem, TriageLane } from "@intelligence/contracts/personal";
import type { MemoryRecord, MemorySavedCall, MemoryStatus } from "./memory-store.ts";

// One meeting the drain took, under its whole label: what `dueCaptures` and `openCapture` read.
// `people` are the addresses an account holds under the label, each to its one entity, and
// `ambiguous` those two entities hold; `bound` the owner's bindings of a name in this meeting.
export type MemoryMeetingOptions = {
  compartments?: string[];
  linked?: { event: string; ownerBacked: boolean; speakers: Record<string, LocalEntityId> };
  firstPushedAt?: Timestamp;
  // This revision's push, sealed in the facts as `pushedAt`; its end by default.
  pushedAt?: Timestamp;
  people?: Record<string, LocalEntityId>;
  ambiguous?: string[];
  bound?: Record<string, LocalEntityId>;
  facts?: Partial<MeetingCaptureFacts>;
};
export type MemoryMeeting = {
  evidenceId: EvidenceId;
  item: MeetingItem;
  options: MemoryMeetingOptions;
  captureId: string;
  revision: number;
  ownerLane?: TriageLane;
  override: boolean;
  status?: MemoryStatus;
  gone?: "gone" | "superseded";
};

// The newest findings done at this generation, with no saved call of the prompt or with `saved` those
// with one, as the store's findingBacklog reads them.
export function findingBacklogOf(
  records: readonly MemoryRecord[],
  saved: readonly MemorySavedCall[],
  limit: number,
  generation: number,
  prompt: { promptId: string; promptVersion: string },
  options: { compartments?: string[]; saved?: boolean },
) {
  const { compartments, saved: replay = false } = options;
  const marked = new Set(
    saved
      .filter(
        (one) => one.record.key.promptId === prompt.promptId && one.record.key.promptVersion === prompt.promptVersion,
      )
      .map((one) => one.record.key.evidenceId),
  );
  return records
    .filter((one) => one.gone !== true && one.kind === "finding" && marked.has(one.evidenceId) === replay)
    .filter((one) => compartments === undefined || one.compartments.every((name) => compartments.includes(name)))
    .filter((one) => one.status?.generation === generation && one.status.status === "done" && !one.status.withheld)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, limit)
    .map((one) => ({
      source: "agent_record" as const,
      evidenceId: one.evidenceId,
      compartments: [...one.compartments],
      sentAt: one.recordedAt,
      attempts: 0,
      override: one.override,
      kind: one.kind,
    }));
}
