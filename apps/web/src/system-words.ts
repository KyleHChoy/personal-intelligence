import {
  type AgentRecord,
  type AgentWeek,
  agentRecordAsked,
  type FixNoneCode,
  type SystemDefect,
  type SystemMeasure,
} from "@intelligence/contracts/personal";
import { agentName, toolWords } from "./agent-words.ts";
import { boxHealthWords } from "./box-words.ts";
import { DECLINE_REASON_WORDS } from "./enum-words.ts";
import { DAY_MS, dateWords, spanWords, whenWords } from "./time-words.ts";
import { capital, wordsOf } from "./words.ts";

// The System room's words: each measure by what it measures, its value by its unit, a defect by
// what it is about. No code is shown where the owner reads: a measure with no words of its own
// reads as its code's words.

// How a measure's number reads: a share as a percentage, a count as it is, an age in days, a rate
// by the day or the week.
type Unit = "share" | "count" | "days" | "a_day" | "a_week";
const MEASURES: Readonly<Record<string, readonly [string, Unit]>> = {
  signals_picked_up: ["Signals an agent picked up", "share"],
  signals_written_back: ["Signals an agent wrote back on", "share"],
  backtest_surfaced_share: ["What you then did that was shown to you first", "share"],
  backtest_untouched_share: ["What was shown and never acted on", "share"],
  candidates_refused: ["Proposed facts that were refused", "share"],
  mail_to_claim_24h: ["Mail that gave a fact within a day", "share"],
  mail_to_obligation_7d: ["Mail from people that gave a plan or a commitment", "share"],
  notice_to_plan_7d: ["Notices that gave a plan", "share"],
  inner_ties_with_chat: ["Closest people whose chats are read", "share"],
  capture_to_claim_24h_meetings: ["Meetings that gave a fact within a day", "share"],
  capture_to_claim_24h_moments: ["Screen moments that gave a fact within a day", "share"],
  moment_fact_read_back_7d: ["Facts from the screen an agent then read", "share"],
  own_lines_claims_per_moment: ["Facts from your own lines to agents", "count"],
  credited_share: ["Work time credited to a project", "share"],
  time_proposal_veto_rate: ["Time proposals you took back", "share"],
  finding_read_back_7d: ["Findings an agent then read", "share"],
  projects_with_mail_facts: ["Projects that gained a fact from mail", "share"],
  projects_with_chat_facts: ["Projects that gained a fact from chat", "share"],
  done_work_per_week: ["Work finished", "a_week"],
  median_days_to_done: ["Time for work to finish", "days"],
  reasked_after_answer: ["Questions asked again after your answer", "share"],
  owner_questions_per_week: ["Questions put to you", "a_week"],
  owner_actions_per_week: ["Things you had to do yourself", "a_week"],
  defects_closed_without_owner: ["Defects closed without you", "share"],
  owner_questions_attempted: ["Questions something tried to settle first", "share"],
  questions_paid_share: ["Agents' questions that showed what they checked first", "share"],
  bets_used_share: ["Agents' own bets you used", "share"],
  settled_without_owner_overturned: ["Settled without you, then overturned by you", "share"],
  agent_settled_precision: ["Agents' settlements you marked right", "share"],
  commitments_done_share: ["Commitments that ended done", "share"],
  commitments_released_share: ["Commitments you let go", "share"],
  commitments_refused_share: ["Proposed commitments that were refused", "share"],
  top_people_filled: ["Closest people with their facts filled in", "share"],
  self_rows_leading: ["Rows about you that lead with what matters", "share"],
  goal_targets_with_person_path: ["Goal targets with a route through someone you know", "share"],
  open_items_count: ["What you owe or is overdue, tracked", "count"],
  open_items_done_share: ["Open items that ended done", "share"],
  people_with_warmth: ["People with a closeness reading", "count"],
  dormant_people: ["Forgotten ties found", "count"],
  goal_people_tasks_per_week: ["People work raised for your goals", "a_week"],
  code_no_go_per_day: ["Work the system raised and then closed itself", "a_day"],
  task_used_share: ["Finished tasks that were then used", "share"],
  tasks_claimed_no_result_per_day: ["Tasks taken with nothing to show", "a_day"],
  roles_unattended: ["Roles whose waiting work no agent asked for", "count"],
  gap_tasks_raised_per_day: ["Tasks raised for agents to pick up", "a_day"],
  merges_first_name_only: ["People joined on a first name alone", "count"],
  policy_merges_wrong_share: ["Automatic joins an agent found wrong", "share"],
  outcome_test_score: ["Whether agents had what they needed", "share"],
  backup_age_days: ["Age of the latest backup", "days"],
  restore_test_age_days: ["Age of the latest restore test", "days"],
  box_health_told: ["Box problems that reached someone", "count"],
  nightly_red: ["Test files failing in the nightly run", "count"],
};

export const measureWords = (metric: string): string => MEASURES[metric]?.[0] ?? wordsOf(metric);

const tidy = (value: number): string =>
  (Math.round(value * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
const inUnit = (unit: Unit | undefined, value: number): string => {
  if (unit === "share") return `${Math.round(value * 100)}%`;
  if (unit === "days") return value === 1 ? "1 day" : `${tidy(value)} days`;
  if (unit === "a_day") return `${tidy(value)} a day`;
  if (unit === "a_week") return `${tidy(value)} a week`;
  return tidy(value);
};

// A measure's latest value, in its unit; "No reading" when it has none.
export const measureValue = (measure: Pick<SystemMeasure, "metric" | "value">): string =>
  measure.value === null ? "No reading" : inUnit(MEASURES[measure.metric]?.[1], measure.value);

// Where healthy is, said beside the value: "healthy at 50% or more".
export function healthyWords(measure: Pick<SystemMeasure, "metric" | "healthy">): string | null {
  if (measure.healthy === null) return null;
  const line = inUnit(MEASURES[measure.metric]?.[1], measure.healthy.value);
  if (measure.healthy.test === "at_least") return `healthy at ${line} or more`;
  if (measure.healthy.test === "under") return `healthy under ${line}`;
  return `healthy at ${line} or less`;
}

// What the reading rests on: how much it counted, and, with too little to tell, how much it needs.
export function sampleWords(measure: Pick<SystemMeasure, "state" | "sample" | "minSample">): string {
  if (measure.state === "no_data" && measure.minSample !== null && measure.sample < measure.minSample)
    return `${measure.sample.toLocaleString()} counted, needs ${measure.minSample.toLocaleString()} to tell`;
  return `${measure.sample.toLocaleString()} counted`;
}

// How long a measure had been failing when it was last read: from when its run of failing readings began
// to the reading's own time, never to now, so a reading nothing has replaced does not grow.
export function failingFor(failingSince: string | null, readAt: string): string {
  if (failingSince === null) return "Failing";
  const days = Math.floor((new Date(readAt).getTime() - new Date(failingSince).getTime()) / DAY_MS);
  return days < 1 ? "Failing for under a day" : `Failing for ${spanWords(days)}`;
}

// When a failing or a stale reading was taken, for the line under its name; null where the mark at
// the right already says it. A stale failing one says how long it had been failing when it was read.
export function readingNote(
  measure: Pick<SystemMeasure, "state" | "failingSince" | "readAt" | "stale">,
  now: Date = new Date(),
): string | null {
  const when = whenWords(measure.readAt, now);
  if (!measure.stale) return measure.state === "failing" ? `read ${when}` : null;
  return measure.state === "failing"
    ? `${failingFor(measure.failingSince, measure.readAt).toLowerCase()} when last read, ${when}`
    : `last read ${when}`;
}

export const SEVERITY_WORDS: Readonly<Record<SystemDefect["severity"], string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const AREA_WORDS: Readonly<Record<SystemDefect["area"], string>> = {
  mcp: "Agent tools",
  extraction: "Reading for facts",
  knowledge: "What is known",
  work: "Agent work",
  planner: "The planner",
  sources: "Sources",
  deploy: "The box",
  docs: "Documentation",
  other: "Other",
};
export const areaWords = (area: SystemDefect["area"]): string => AREA_WORDS[area];
const STATUS_WORDS: Readonly<Record<SystemDefect["status"], string>> = {
  open: "Not started",
  triaged: "Looked at",
  in_progress: "Being fixed",
  done: "Fixed",
  wont_do: "Dismissed",
  duplicate: "A duplicate",
};
export const defectStatusWords = (status: SystemDefect["status"]): string => STATUS_WORDS[status];
export const roleWords = (role: string): string => capital(role.replaceAll("-", " ").replaceAll("_", " "));

// A cause as the system files it: its kind, and after a colon what it is about.
const causeOf = (cause: string): { kind: string; subject: string | null } => {
  const cut = cause.indexOf(":");
  return cut < 0 ? { kind: cause, subject: null } : { kind: cause.slice(0, cut), subject: cause.slice(cut + 1) };
};
const CAUSES: Readonly<Record<string, (subject: string | null) => string>> = {
  measure_floor: (subject) =>
    subject === null ? "A measure is off its healthy line" : `Off its healthy line: ${measureWords(subject)}`,
  outcome_drop: () => "The score for whether agents had what they needed dropped",
  outcome_gap: () => "Test tasks agents can see score well above the held-out ones",
  standing_check: (subject) =>
    subject === null
      ? "The daily end-to-end check is failing"
      : `The daily end-to-end check is failing: ${wordsOf(subject).toLowerCase()}`,
  refusal_pattern: () => "Reading for facts keeps refusing one kind of fact",
  tool_refusals: (subject) =>
    subject === null ? "An agent tool is refused most of the time" : `Refused most of the time: ${toolWords(subject)}`,
  // Its subject is the kind and what it is about, `silent:job.sync`: said as the box health card
  // of that kind and about says it, so the defect and its card read the same.
  box_health: (subject) => {
    if (subject === null) return "Something on the box needs a look";
    const cut = subject.indexOf(":");
    const kind = cut < 0 ? subject : subject.slice(0, cut);
    // What it is about, as the card's own `about`: the cause writes a `/` as a `.`.
    const about = cut < 0 ? "" : subject.slice(cut + 1).replace(".", "/");
    return boxHealthWords(kind, about).title;
  },
  lever_change: () => "A measure got worse after an agent changed a setting",
  nightly_red: () => "Nightly tests are failing",
  ruling_detached: () => "One of your rulings no longer finds its fact",
};

// A defect by what it is about: one the system filed is named by its cause, one an agent filed by
// the title the agent gave it (its own words, shown as text), else by its kind and area.
export function defectTitle(
  defect: Pick<SystemDefect, "cause" | "kind" | "area"> & Partial<Pick<SystemDefect, "words">>,
): string {
  if (defect.cause !== null) {
    const { kind, subject } = causeOf(defect.cause);
    return CAUSES[kind]?.(subject) ?? "Something the system measures is failing";
  }
  const title = defect.words?.title?.untrusted.trim() ?? "";
  return title !== "" ? title : defectKindWords(defect);
}

// What kind of report an agent's defect is, and where: the line under its title.
export const defectKindWords = (defect: Pick<SystemDefect, "kind" | "area">): string =>
  `${defect.kind === "bug" ? "A fault" : "An improvement"} an agent reported: ${AREA_WORDS[defect.area].toLowerCase()}`;

// What a defect was taken with, in words. A reference an agent names is the agent's claim: a pull
// request and a commit are checked by nothing, and say so.
const NONE_WORDS: Readonly<Record<FixNoneCode, string>> = {
  owners_to_change: "An agent looked: yours to change",
  not_reproducible: "An agent looked: it could not make it happen again",
  duplicate: "An agent looked: the same as another defect",
};
const LEVER_WORDS: Readonly<Record<string, string>> = {
  "lessons.digest_weekly": "an old weekly limit on lessons, which no longer limits anything",
};
export function fixWords(fixRef: string | null): string {
  if (fixRef === null) return "None named yet";
  const { kind, subject } = causeOf(fixRef);
  const value = subject ?? "";
  if (kind === "pr" && /^\d+$/.test(value)) return `Pull request ${value} (not checked)`;
  if (kind === "commit" && /^[0-9a-f]+$/.test(value))
    return `A commit an agent named: ${value.slice(0, 7)} (not checked)`;
  if (kind === "lever")
    return `The agent moved a setting: ${LEVER_WORDS[value] ?? wordsOf(value.replaceAll(".", "_")).toLowerCase()}`;
  if (kind === "none")
    return (NONE_WORDS as Readonly<Record<string, string>>)[value] ?? "An agent looked and named no fix";
  if (kind === "ops") return "An agent ran a repair on the box";
  return "A fix an agent named";
}

// Who filed it, and from which measure where the system did.
export function filedWords(defect: Pick<SystemDefect, "cause" | "filedBy">): string {
  if (defect.filedBy === "agent" || defect.cause === null) return "An agent";
  const { kind, subject } = causeOf(defect.cause);
  return kind === "measure_floor" && subject !== null
    ? `The system, from the measure "${measureWords(subject)}"`
    : "The system, from its own checks";
}

// What the agent that filed a defect wrote of it, each part where it wrote one.
export function defectSaid(defect: Pick<SystemDefect, "words">): { detail: string | null; evidence: string | null } {
  const text = (one: { untrusted: string } | null | undefined): string | null => {
    const said = one?.untrusted.trim() ?? "";
    return said === "" ? null : said;
  };
  return { detail: text(defect.words?.detail), evidence: text(defect.words?.evidence) };
}

export const heldWords = (heldBy: string | null): string => (heldBy === null ? "No one yet" : agentName(heldBy));

// An agent's own record in words: what it did and how much of it was used (by the owner or another
// agent: the count does not tell them apart); how often its work put a question in the owner's
// queue, with those still waiting, and how often the answer was no, with the reason given most; and
// the relayed answers the owner took back, when any. Counts and reasons in words, no code.
export function agentRecordWords(record: AgentRecord): string[] {
  const { work, questions, noReasons, overturned } = record;
  const asked = agentRecordAsked(record);
  const top = noReasons[0];
  return [
    `${work.done} ${work.done === 1 ? "task" : "tasks"} done, ${work.used} used`,
    `Asked you ${asked === 1 ? "once" : `${asked} times`}${
      questions.waiting === 0 ? "" : ` (${questions.waiting} waiting)`
    }, you said no to ${questions.no}${top === undefined ? "" : `, mostly: ${DECLINE_REASON_WORDS[top.reason].toLowerCase()}`}`,
    ...(overturned === 0
      ? []
      : [`You took back ${overturned === 1 ? "one answer" : `${overturned} answers`} it passed on`]),
    betWords(record.bets),
  ];
}

// Its bets, work nobody asked for: how many you used, how many you did not, how many are still open,
// and what it may still place this week.
function betWords({ open, used, unused, budget, left }: AgentRecord["bets"]): string {
  const placed = open + used + unused;
  const week = `${left} of ${budget} left this week`;
  if (placed === 0) return `No bets yet, ${week}`;
  return `${placed === 1 ? "1 bet" : `${placed} bets`} on its own: you used ${used}, not ${unused}, ${open} open; ${week}`;
}

// one ISO week of an agent's record, the one under way first: its bets placed
// and how they stand now, what was left of its budget, its questions to you and how many showed what
// it checked first, its questions refused for not showing it, and answers you took back.
export function agentWeekWords(week: AgentWeek, first: boolean, now: Date = new Date()): { t: string; sub: string } {
  const [year, month, day] = week.week.split("-").map(Number);
  const monday = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const { bets, questions, takenBack } = week;
  const placed =
    bets.placed === 0
      ? "no bets"
      : `${bets.placed === 1 ? "1 bet" : `${bets.placed} bets`}: you used ${bets.used}, not ${bets.unused}, ${bets.open} open`;
  const asked =
    questions.asked === 0
      ? "asked you nothing"
      : `asked you ${questions.asked === 1 ? "once" : `${questions.asked} times`}, ${questions.paid} showing what it checked first`;
  return {
    t: first ? "This week" : `Week of ${dateWords(monday, now)}`,
    sub: [
      `${capital(placed)}, ${bets.left} of ${bets.budget} left`,
      capital(asked),
      ...(questions.refused === 0
        ? []
        : [`${questions.refused} ${questions.refused === 1 ? "question" : "questions"} refused for not showing it`]),
      ...(takenBack === 0 ? [] : [`You took back ${takenBack === 1 ? "one answer" : `${takenBack} answers`}`]),
    ].join(" · "),
  };
}
