import { AutonomyRules, TIERS, type Tier } from "@intelligence/contracts/personal";
import { DAY_MS, HOUR_MS } from "../days.ts";
import { repoFile } from "../repo-root.ts";

// The windows of the three gap triggers code raises every day, and the age at which a deferred card
// expires by the policy. The numbers are `ontology/autonomy.json`; this turns them into times for
// one tick, so the database compares times and holds no window of its own.

// The rule table, parsed once.
export const autonomyRules: () => AutonomyRules = repoFile("ontology/autonomy.json", (text) =>
  AutonomyRules.parse(JSON.parse(text)),
);

// For a tick at `now`:
// - meeting_soon: a meeting that starts after `now` and at or before `meetingUntil`;
// - commitment_due: an open commitment due after `now` and at or before `dueUntil`;
// - deadline_soon: a dated thing with nobody on it, by `dueUntil` too;
// - reply_owed: unanswered mail sent at or after `replyFrom` and at or before `replyUntil`;
// - a card deferred at or before `deferredBefore` expires.
export type AutonomyWindows = {
  meetingUntil: Date;
  dueUntil: Date;
  replyFrom: Date;
  replyUntil: Date;
  deferredBefore: Date;
};

export function autonomyWindows(now: Date, rules: AutonomyRules = autonomyRules()): AutonomyWindows {
  const at = now.getTime();
  return {
    meetingUntil: new Date(at + rules.meetingSoonHours * HOUR_MS),
    dueUntil: new Date(at + rules.commitmentDueHours * HOUR_MS),
    replyFrom: new Date(at - rules.replyOwedWithinDays * DAY_MS),
    replyUntil: new Date(at - rules.replyOwedDays * DAY_MS),
    deferredBefore: new Date(at - rules.deferredCardDays * DAY_MS),
  };
}

export type LoopWindows = { goalQuietSince: Date | null; followUpFrom: Date | null };

export function loopWindows(now: Date, rules: AutonomyRules = autonomyRules()): LoopWindows {
  const at = now.getTime();
  const { goalReviewOn, goalReviewDays, meetingFollowUpOn, meetingFollowUpHours } = rules;
  return {
    goalQuietSince:
      goalReviewOn === true && goalReviewDays !== undefined ? new Date(at - goalReviewDays * DAY_MS) : null,
    followUpFrom:
      meetingFollowUpOn === true && meetingFollowUpHours !== undefined
        ? new Date(at - meetingFollowUpHours * HOUR_MS)
        : null,
  };
}

// close_no_tie's tiers, closest first whatever order the table lists them in (the database ranks a
// person by their tier's place here, then by warmth), and how many people of one audience may hold
// a task at once.
export type CloseNoTieRule = { tiers: Tier[]; people: number };

export function closeNoTieRule(rules: AutonomyRules = autonomyRules()): CloseNoTieRule {
  return { tiers: TIERS.filter((tier) => rules.closeNoTieTiers.includes(tier)), people: rules.closeNoTiePeople };
}
