import { type CommitmentItem, dayIn } from "@intelligence/contracts/personal";

// `pi outcomes`: what healthy means for each outcome metric, and how a value and its sample become a
// state. The numbers are starting points, tuned here from real use. `minSample` is what a metric
// needs before it judges anything: under it the state is `no_data`, which says untried or too little
// to tell, never a failure.

export type HealthyTest = "at_least" | "under" | "at_most";

export const OUTCOME_THRESHOLDS = {
  // The headline. The sample is what was raised, a task code closed with no claim left out: of those,
  // the share a client read in the change feed or claimed.
  signals_picked_up: { test: "at_least", healthy: 0.5, minSample: 10 },
  // The sample is what clients picked up: of those, the share an agent wrote something back on.
  signals_written_back: { test: "at_least", healthy: 0.25, minSample: 10 },
  // The meter: of the replies sent, the meetings held and the deadlines met, the share `next` or the open
  // items showed beforehand. The sample is those acts, at least a week old.
  backtest_surfaced_share: { test: "at_least", healthy: 0.7, minSample: 10 },
  // Of what they showed, the share nothing was done of within a week: noise to read past.
  backtest_untouched_share: { test: "under", healthy: 0.5, minSample: 10 },
  // The sample is what models proposed from items in the window: claims kept and candidates refused.
  candidates_refused: { test: "under", healthy: 0.2, minSample: 50 },
  mail_to_claim_24h: { test: "at_least", healthy: 0.4, minSample: 20 },
  // The sample is the week's primary mail, a person's and not a mailing: of those, the share that gave a
  // plan or a commitment. Most mail states neither, so this is a floor: under it extraction lost them.
  mail_to_obligation_7d: { test: "at_least", healthy: 0.03, minSample: 20 },
  // The sample is the week's mail from programs: of those, the share that gave a plan. Most of it says
  // nothing due, so this is a floor: zero over a full week means a notice's deadline is not reaching one.
  notice_to_plan_7d: { test: "at_least", healthy: 0.005, minSample: 50 },
  // The sample is the people the owner ruled inner. Under this, their chats are out of scope, not
  // captured or not bound, and their silence says nothing.
  inner_ties_with_chat: { test: "at_least", healthy: 0.5, minSample: 3 },
  capture_to_claim_24h_meetings: { test: "at_least", healthy: 0.9, minSample: 3 },
  // The sample is the moments a model was asked about. A request's claims each cite one moment, and
  // most chat lines state nothing lasting, so this is a floor that says the lane finds anything.
  capture_to_claim_24h_moments: { test: "at_least", healthy: 0.1, minSample: 20 },
  // The sample is the moments with a model's fact: of those, the share an agent was then served.
  moment_fact_read_back_7d: { test: "at_least", healthy: 0.2, minSample: 5 },
  // The sample is the moments the own-lines lane committed done, so a lane that is off or only tried
  // has no data, never a low value. Most of the owner's lines to an agent state no fact.
  own_lines_claims_per_moment: { test: "at_least", healthy: 0.2, minSample: 5 },
  // The sample is observed minutes: an hour of work is the least a share of it says anything about.
  credited_share: { test: "at_least", healthy: 0.7, minSample: 60 },
  // The sample is the system's proposals in the window: of those, the share the owner took back.
  time_proposal_veto_rate: { test: "under", healthy: 0.2, minSample: 20 },
  finding_read_back_7d: { test: "at_least", healthy: 0.5, minSample: 5 },
  // The sample is the active projects: of those, the share whose record gained a status, decision or
  // next step from mail in the window. Low until the correspondence lane is on.
  projects_with_mail_facts: { test: "at_least", healthy: 0.5, minSample: 1 },
  // The same from the owner's chat lines. Zero until `moment` and `correspondence` are both on.
  projects_with_chat_facts: { test: "at_least", healthy: 0.25, minSample: 1 },
  // The sample is the opportunities worked on in the window, finished or not.
  done_work_per_week: { test: "at_least", healthy: 5, minSample: 3 },
  median_days_to_done: { test: "under", healthy: 7, minSample: 3 },
  reasked_after_answer: { test: "under", healthy: 0.05, minSample: 10 },
  // What the owner is asked, by week and kind. The goal is that it falls; a floor of nothing, since
  // zero is the aim, and what it is read beside is the overturned share below. No least sample: a
  // window with no question, on a store as old as the window, reads 0 and healthy, so a defect
  // filed while it was over the line closes once the questions stop; its read gives no value, and
  // so no data, for a store younger than the window that was asked nothing.
  owner_questions_per_week: { test: "at_most", healthy: 20, minSample: 0 },
  // Of the questions raised, the share code or an agent had a go at first.
  owner_questions_attempted: { test: "at_least", healthy: 0.5, minSample: 10 },
  // Of the questions agents put to the owner, the share that carried a `tried` code checked: every
  // one should, since one without it is refused.
  questions_paid_share: { test: "at_least", healthy: 1, minSample: 5 },
  // Of the bets agents settled in the last 28 days, the share the owner used by the owner's own
  // signals: a bet is a risk, so most may miss, but not nearly all.
  bets_used_share: { test: "at_least", healthy: 0.3, minSample: 5 },
  // Of what code, an agent or a rule settled without the owner, the share the owner then overturned: the check that
  // fewer questions did not mean worse answers.
  settled_without_owner_overturned: { test: "under", healthy: 0.05, minSample: 10 },
  // Of the agents' settlements the owner marked on the weekly sample, the share right:
  // a kind under 0.8 over two weeks goes back to attached-only.
  agent_settled_precision: { test: "at_least", healthy: 0.9, minSample: 5 },
  // The goal's first number: every act the system keeps a row of the owner taking, a week. A floor,
  // since a shell that records nothing is not seen. No least sample, as the questions' above: a full
  // window with no act reads 0 and healthy, the goal's best case, and a store younger than the
  // window with no act reads no data and files nothing.
  owner_actions_per_week: { test: "at_most", healthy: 20, minSample: 0 },
  // Of the defects that stand closed, the share closed with no act of the owner's: the measure
  // recovered after an agent's fix, or an agent closed its own; against the owner's dismissals.
  defects_closed_without_owner: { test: "at_least", healthy: 0.8, minSample: 5 },
  // The sample is the commitments that ended in the window and were not let go: of those, the share
  // done rather than cancelled or lapsed. Letting one go says it was never worth tracking, which the
  // next line counts. The first read that means anything is the next thirty raised, against the two
  // minutes it once took to clear twenty by hand.
  commitments_done_share: { test: "at_least", healthy: 0.7, minSample: 5 },
  // Of those that ended, the share the owner let go: high when extraction raises passing remarks.
  commitments_released_share: { test: "under", healthy: 0.3, minSample: 5 },
  // Refused for most of what is proposed, the wording is not reaching the model.
  commitments_refused_share: { test: "under", healthy: 0.5, minSample: 10 },
  top_people_filled: { test: "at_least", healthy: 0.9, minSample: 3 },
  // The sample is the Self room's rows, notices left out; a few do not say what the room reads like.
  self_rows_leading: { test: "at_least", healthy: 0.5, minSample: 20 },
  // The sample is a few of the active goals' targets the owner has no tie with: who needs a route.
  goal_targets_with_person_path: { test: "at_least", healthy: 0.5, minSample: 3 },
  // What the owner owes and what is overdue: more than none, once anything was ever owed.
  open_items_count: { test: "at_least", healthy: 1, minSample: 1 },
  // Of the items that ended in the window, the share closed as done rather than left to lapse. The
  // sample is those that ended.
  open_items_done_share: { test: "at_least", healthy: 0.3, minSample: 10 },
  // Counts of people, each over those built for the owner's audience: the audit's mark for how far
  // back the mail reaches, and whether the forgotten ties are found.
  people_with_warmth: { test: "at_least", healthy: 200, minSample: 1 },
  dormant_people: { test: "at_least", healthy: 1, minSample: 1 },
  // People work raised for active goals, per week: the sample is the active goals with a target. A
  // goal with no target raises none by design, so with none of them this says no_goal_targets, not low.
  goal_people_tasks_per_week: { test: "at_least", healthy: 3, minSample: 1 },
  // Rung 0's no_go on gap flags per day. The sample is all it decided on them in the window. Code closing what it raised,
  // tick after tick, shows here first: a healthy board has next to none.
  code_no_go_per_day: { test: "at_most", healthy: 1, minSample: 1 },
  // Of the finished tasks old enough to show a signal, or judged, the share used: a later agent cited it,
  // the owner acted on its person or thread within a week, confirmed a fact it made, or kept it. The
  // audit's mark: below half, its triggers should give way. Their answer outranks code on what they judged.
  task_used_share: { test: "at_least", healthy: 0.5, minSample: 10 },
  // Tasks claimed per day with no result: a limit, an outage or a release, counted until someone finishes
  // the task. Spend with nothing to show is here. The sample is the tasks claimed in the window.
  tasks_claimed_no_result_per_day: { test: "at_most", healthy: 1, minSample: 1 },
  // Roles with a task in go and unheld for over a day that no active client of the role asked for
  // work in that day: no client is woken, so work nobody polls for waits unseen. The sample is the
  // roles with such a task; with none, no data, `nothing_waiting`, and a defect filed closes.
  roles_unattended: { test: "at_most", healthy: 0, minSample: 1 },
  // Gap tasks code let through per day: what agents have to pick up. An empty board
  // shows here as low; `pi-work work gaps` says why. The sample is the window's days.
  gap_tasks_raised_per_day: { test: "at_least", healthy: 1, minSample: 1 },
  // Joins resting on a first name alone: each is worth the owner reading. The sample is every live join.
  merges_first_name_only: { test: "at_most", healthy: 0, minSample: 1 },
  // Of the standing rule's merges an agent audited, the share an agent reported as two people: the
  // rule's error rate. The sample is the merges audited in the window.
  policy_merges_wrong_share: { test: "at_most", healthy: 0.05, minSample: 5 },
  // The latest complete outcome test, as a share of the most it could score. The sample is the tasks
  // scored, visible and held out. The hand audit it descends from read 10 of 24.
  outcome_test_score: { test: "at_least", healthy: 0.5, minSample: 8 },
  backup_age_days: { test: "at_most", healthy: 8, minSample: 1 },
  // A restore test passed within about a month: the dump's life, 30 days, and a few to get to it.
  restore_test_age_days: { test: "at_most", healthy: 35, minSample: 1 },
  // The box health cards that told anyone: below 1, a card waits until the owner looks.
  box_health_told: { test: "at_least", healthy: 1, minSample: 1 },
} as const satisfies Record<string, { test: HealthyTest; healthy: number; minSample: number }>;

export type OutcomeName = keyof typeof OUTCOME_THRESHOLDS;
// `failing`: on the wrong side of its line, above one it must stay at or under, below one it must reach.
type OutcomeState = "ok" | "failing" | "no_data";

// How many days ago a metric's rows fall, oldest first; null when it reads what stands now.
export type OutcomeWindow = { fromDaysAgo: number; toDaysAgo: number } | null;

export type OutcomeMetric = {
  metric: OutcomeName;
  value: number | null;
  sample: number;
  healthy: { test: HealthyTest; value: number };
  minSample: number;
  window: OutcomeWindow;
  state: OutcomeState;
  // Why a metric has no data: `small_sample`, or the reason its read gave.
  code?: string;
  // What a share is made of, by code, where the codes are the point.
  parts?: Record<string, number>;
  // Parts counted over rows no label bounds (an erasure, of whatever it erased): the owner's own
  // report alone. Never stored with a reading, so never served to an agent (invariant 6).
  ownerParts?: Record<string, number>;
};

// Three places are enough to read a share, and a long float is only noise in a report.
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

export const shareOf = (hits: number, sample: number): number | null => (sample === 0 ? null : hits / sample);

const meets = (test: HealthyTest, value: number, healthy: number): boolean => {
  if (test === "at_least") return value >= healthy;
  return test === "under" ? value < healthy : value <= healthy;
};

// Which side of its line a failing value is on: `above` for a line it must stay at or under,
// `below` for one it must reach.
export const failingSide = (test: HealthyTest): "above" | "below" => (test === "at_least" ? "below" : "above");

// Whether a measure is worse at `now` than it was at `before`, by its own line's direction.
export const worsened = (test: HealthyTest, before: number, now: number): boolean =>
  test === "at_least" ? now < before : now > before;

export function outcomeState(metric: OutcomeName, value: number | null, sample: number): OutcomeState {
  const { test, healthy, minSample } = OUTCOME_THRESHOLDS[metric];
  if (value === null || sample < minSample) return "no_data";
  return meets(test, value, healthy) ? "ok" : "failing";
}

export function outcomeMetric(
  metric: OutcomeName,
  read: {
    value: number | null;
    sample: number;
    window: OutcomeWindow;
    code?: string;
    parts?: Record<string, number>;
    ownerParts?: Record<string, number>;
  },
): OutcomeMetric {
  const { test, healthy, minSample } = OUTCOME_THRESHOLDS[metric];
  const state = outcomeState(metric, read.value, read.sample);
  return {
    metric,
    value: read.value === null ? null : rounded(read.value),
    sample: read.sample,
    healthy: { test, value: healthy },
    minSample,
    window: read.window,
    state,
    ...(state === "no_data" ? { code: read.code ?? "small_sample" } : {}),
    ...(read.parts === undefined ? {} : { parts: read.parts }),
    ...(read.ownerParts === undefined ? {} : { ownerParts: read.ownerParts }),
  };
}

// Of the commitments that ended between two days, how many ended done: closed as done, by its owner
// or an agent, or by a source that says it was. Let go, cancelled, and lapsed in silence, on the day
// its own marker names, are not done. `items` is every commitment no longer open, as the owner's read
// serves them; one closed with no close the owner can see has no day to place it, and is left out.
// `releasedByAgent`: of those let go, the ones an agent closed so, which say the other side let the
// owner off (commitment-close.ts), not that the owner let a remark go.
export function commitmentEnds(
  items: readonly Pick<CommitmentItem, "closedAt" | "closedBy" | "doneAt" | "due" | "ending" | "lapsed">[],
  window: { from: string; to: string },
  zone: string | null,
): { sample: number; hits: number; released: number; aged: number; releasedByAgent: number } {
  const within = (day: string): boolean => day >= window.from && day <= window.to;
  let sample = 0;
  let hits = 0;
  let released = 0;
  let aged = 0;
  let releasedByAgent = 0;
  for (const item of items) {
    if (item.closedAt !== null && item.closedAt !== undefined) {
      if (!within(dayIn(new Date(item.closedAt), zone))) continue;
      sample += 1;
      if (item.ending === "done" || ((item.ending ?? null) === null && (item.doneAt ?? null) !== null)) hits += 1;
      else if (item.ending === "released") {
        released += 1;
        if (item.closedBy !== null && item.closedBy !== undefined && "agent" in item.closedBy) releasedByAgent += 1;
      }
    } else if (item.lapsed !== undefined && within(item.lapsed)) {
      sample += 1;
      if (item.due === null) aged += 1;
    }
  }
  return { sample, hits, released, aged, releasedByAgent };
}

// The two reads of what ended: kept or not among what was worth tracking, and how much the owner let
// go. Any release is no promise broken; only the owner's says a remark was raised as an obligation.
export function commitmentsEndedShares(
  ends: { sample: number; hits: number; released: number; aged?: number; releasedByAgent?: number },
  window: OutcomeWindow = null,
): { done: OutcomeMetric; released: OutcomeMetric } {
  // An undated line that aged out was a remark or a courtesy, not a promise broken: as one let go, it is no
  // part of what was kept.
  const aged = ends.aged ?? 0;
  const byAgent = ends.releasedByAgent ?? 0;
  const kept = ends.sample - ends.released - aged;
  return {
    done: outcomeMetric("commitments_done_share", {
      value: shareOf(ends.hits, kept),
      sample: kept,
      window,
      parts: { done: ends.hits, not_done: kept - ends.hits, released: ends.released, aged_out: aged },
    }),
    released: outcomeMetric("commitments_released_share", {
      value: shareOf(ends.released - byAgent, ends.sample - aged),
      sample: ends.sample - aged,
      window,
      parts: { by_owner: ends.released - byAgent, by_agent: byAgent },
    }),
  };
}

export function goalPeopleTasksMetric(row: { raised: number; targeted: number }, days: number): OutcomeMetric {
  return outcomeMetric("goal_people_tasks_per_week", {
    value: (row.raised / days) * 7,
    sample: row.targeted,
    window: { fromDaysAgo: days, toDaysAgo: 0 },
    ...(row.targeted === 0 ? { code: "no_goal_targets" } : {}),
  });
}

// What each top person lacks: filled at three current beliefs, one of them fresh.
const TOP_PERSON_BELIEFS = 3;
export function topPeopleParts(people: readonly { beliefs: number; fresh: boolean }[]): {
  filled: number;
  no_beliefs: number;
  few_beliefs: number;
  not_fresh: number;
} {
  const parts = { filled: 0, no_beliefs: 0, few_beliefs: 0, not_fresh: 0 };
  for (const one of people) {
    if (one.beliefs === 0) parts.no_beliefs += 1;
    else if (one.beliefs < TOP_PERSON_BELIEFS) parts.few_beliefs += 1;
    else if (!one.fresh) parts.not_fresh += 1;
    else parts.filled += 1;
  }
  return parts;
}

// A zero is a feature not yet tried, never a failure.
export type UsageState = "used" | "unused";
export const usageStateOf = (count: number): UsageState => (count === 0 ? "unused" : "used");

// Of the calls a tool took, the share refused; a tool nobody called has no rate.
export const refusalRateOf = (refused: number, calls: number): number | null => {
  const rate = shareOf(refused, calls);
  return rate === null ? null : rounded(rate);
};
