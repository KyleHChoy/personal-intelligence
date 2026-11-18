import { OPEN_STATUSES, type PersonalWakeSource } from "./work.ts";

// Small rules of work's states that more than one store module reads.

export const isOpenStatus = (status: string | null): boolean =>
  status !== null && (OPEN_STATUSES as readonly string[]).includes(status);

// A hypothesis nobody has ended: what an answer or an expiry may still end.
export const LIVE_HYPOTHESIS_STATES: readonly string[] = Object.freeze(["open", "supported", "asked"]);

// What the dispatcher's `wakeWorthRun` is handed: counts and booleans, with no content, read by the
// store and decided by the ladder.
export type WakeFacts = {
  readonly source: PersonalWakeSource;
  readonly killSwitch: boolean;
  readonly anchorVetoed: boolean;
  readonly reasonerRegistered: boolean;
  // The deferred cards whose author is the reasoner.
  readonly reasonerDeferredCards: number;
  // The pending cards whose compartments are within the active reasoner's.
  readonly pendingCardsInClearance: number;
  readonly maxPendingCards: number;
  readonly runsToday: number;
  readonly maxRunsPerDay: number;
  readonly spentTodayMicroUsd: number;
  readonly maxMicroUsdPerDay: number;
};

// One text each, whatever the cause, so it says nothing of which row or rule decided: a veto is
// matched through rows the caller may not see, so a no_go never says whether it was the owner's no
// or a veto.
export const PROPOSE_TASK_NEXT = Object.freeze({
  merged:
    "Nothing new was written: this is the open task of the same kind about the same subject (about the owner, on the same refs). Claim it if list_opportunities offers it to you.",
  no_go:
    "Not taken: the owner said no to this work (about the owner: to work resting only on its refs) under 7 days ago or with no new source since, or a rule of theirs covers it. Don't propose it again as is.",
  proposed:
    "Written, and waiting on the owner: a card of theirs on the same work is undecided, or they said no to it. Nothing to claim until they answer.",
} as const);
