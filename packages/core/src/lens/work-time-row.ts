import type { CaptureWork, MeetingView } from "@intelligence/contracts/personal";

// One knowledge.captures row the caller can see. `minutes` is a block day's clear total, `day` its
// local day; `work` its work_enc opened, null while the catch-up has not reached it.
export type WorkRow = {
  id: string;
  evidence: string;
  kind: "block" | "moment" | "meeting" | "task";
  startedAt: number;
  endedAt: number;
  minutes: number | null;
  day: string | null;
  compartments: readonly string[];
  work: CaptureWork | null;
  // A meeting's linked calendar event as the caller may see it, for a half-day's list.
  meeting?: MeetingView | null;
};
