// Everything waiting for the owner, handed over by their agent: the tick's rule for the hand-over
// tasks. The host of the owner's page is box configuration that `pi web serve` writes to
// policy.work_settings; nothing here reads an environment variable, and no agent process holds a
// new credential.

// What the tick reads (ledger.owner_queue_state, given whether agents' attempts are on, as the
// page reads it), one row a label: the page's host; the label, the whole clearance of an agent of
// the question role, or that of a task open today under the old subject form; the day's subject for
// it; how many cards wait within it by the page's rule (less the name hold); and whether the owner
// was told today, so no new task may be raised under it.
export type OwnerQueueState = {
  host: string | null;
  label: string[];
  subject: string;
  waiting: number;
  ended_today: boolean;
};
export const OWNER_QUEUE_STATE =
  "select host, label, subject, waiting, ended_today from ledger.owner_queue_state($1::timestamptz, $2::boolean)";

// The gaps, in the shape every source of gaps gives: none with no host (no link to hand over), none
// for a label nothing waits within, and none for a label whose day is spent (an agent reported its
// hand-over done today). An open one stays listed while a card within its label waits; then the
// tick closes it, which spends nothing.
export function ownerQueueGaps(states: readonly OwnerQueueState[], now: Date) {
  return states
    .filter((state) => state.host !== null && state.waiting > 0 && !state.ended_today)
    .map((state) => ({
      trigger: "owner_queue" as const,
      subject: state.subject,
      label: state.label,
      goal_id: null,
      about_kind: "owner" as const,
      about_id: null,
      source_kind: "queue" as const,
      source_id: state.subject,
      at: now,
      due_at: null,
      facts: null,
      ties: null,
    }));
}
