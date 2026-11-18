// The command table's rows for durable work: the work commands, notes, goals, projects, areas and work time.
import { ULID_PATTERN } from "@intelligence/contracts/personal";
import { usage } from "./command-args.ts";
import {
  admin,
  areas,
  flag,
  gapReport,
  goals,
  notes,
  project,
  text,
  tick,
  time,
  WORK_URL,
  work,
  workRuns,
} from "./command-kit.ts";
import type { Rows } from "./command-types.ts";

export const WORK_AND_TIME: Rows = {
  // Durable work. The tick runs as pi_work, with no key file.
  "work tick": { role: "work", requires: [WORK_URL, "PI_ERASURE_JOURNAL"], body: tick("tickCommand") },
  // Why the board holds what it holds: per trigger, what is found and what holds it. Ids and counts,
  // and writes nothing. As pi_work, the only role that may run the gap scans, so as `pi-work work gaps`.
  "work gaps": { role: "work", requires: [WORK_URL, "PI_ERASURE_JOURNAL"], body: gapReport("gapsCommand") },
  // A note or a bio about a person, the owner's words on stdin.
  "note add": {
    ...admin,
    args: "PERSON [--bio] [--compartment C] < WORDS",
    options: { bio: flag, compartment: text },
    positionals: 1,
    body: notes("noteAdd"),
  },
  "note edit": {
    ...admin,
    args: "PERSON NOTE [--bio | --note] [--compartment C] < WORDS",
    options: { bio: flag, note: flag, compartment: text },
    positionals: 2,
    body: notes("noteEdit"),
  },
  "note retire": { ...admin, args: "NOTE", positionals: 1, body: notes("noteRetire") },
  "note list": { ...admin, terminalOnly: true, args: "PERSON", positionals: 1, body: notes("noteList") },
  "goal add": {
    ...admin,
    args: "--domain D [--compartment C]",
    options: { compartment: text, domain: text },
    body: goals("goalAdd"),
  },
  // Every stored goal's owner_command item, claim and mapping row.
  "goals backfill": { ...admin, body: goals("goalsBackfill") },
  "goal list": { ...admin, terminalOnly: true, body: goals("goalList") },
  "goal set": {
    ...admin,
    args: "ID --status active|paused|done|dropped",
    options: { status: text },
    positionals: 1,
    body: goals("goalSet"),
  },
  // The goal in the owner's new words, from stdin; and the owner's order of their goals within a life domain.
  "goal edit": { ...admin, args: "ID < WORDS", positionals: 1, body: goals("goalEdit") },
  "goal rank": {
    ...admin,
    args: "ID --after ID | --first",
    options: { after: text, first: flag },
    positionals: 1,
    body: goals("goalRank"),
  },
  // A goal stated in a source, by its fact key, made the owner's with one change, and its
  // undo; and the owner's removal of one, and its undo.
  "goal adopt": {
    ...admin,
    args: "FACT --words < WORDS | --status active|paused|done|dropped | --entity ENTITY | --after ID | --first",
    options: { words: flag, status: text, entity: text, after: text, first: flag },
    positionals: 1,
    body: goals("goalAdopt"),
  },
  "goal unadopt": { ...admin, args: "ID", positionals: 1, body: goals("goalUnadopt") },
  "goal hide": { ...admin, args: "FACT", positionals: 1, body: goals("goalHide") },
  "goal unhide": { ...admin, args: "FACT", positionals: 1, body: goals("goalUnhide") },
  // The person or organization a goal is after; the tick flags a goal with no warm path to it. Or by
  // a full name, or an organization's name with --org: those holding it, or a target the next sync
  // binds.
  "goal target": {
    ...admin,
    args: 'ID --entity ENTITY | --none | --name "NAME" [--org] [--entity ENTITY]',
    options: { entity: text, none: flag, name: text, org: flag },
    positionals: 1,
    body: goals("goalTarget"),
  },
  // Projects: the owner makes each and anchors it by thread.
  "project add": { ...admin, args: "[--compartment C]", options: { compartment: text }, body: project("projectAdd") },
  // Device anchors: exactly one flag of the eight.
  // --title reads the window title from stdin.
  "project anchor": {
    ...admin,
    args: "PROJECT (--thread MESSAGE | --app BUNDLE | --host HOST | --url PREFIX | --repo REPOSITORY | --document '~/PATH' | --series-of CAPTURE | --title < TITLE)",
    options: {
      thread: text,
      app: text,
      host: text,
      url: text,
      repo: text,
      document: text,
      "series-of": text,
      title: flag,
    },
    positionals: 1,
    body: project("projectAnchor"),
  },
  "project unanchor": { ...admin, args: "ANCHOR", positionals: 1, body: project("projectUnanchor") },
  "project close": { ...admin, args: "PROJECT", positionals: 1, body: project("projectClose") },
  "project list": { ...admin, terminalOnly: true, body: project("projectList") },
  // Areas: the standing parts of the owner's life or work that projects belong to. Only the owner
  // makes or changes one. A name is read from stdin and printed by `areas` alone, to a terminal
  // only; a key is the owner's code for the area.
  "project area": {
    ...admin,
    args: "PROJECT KEY | PROJECT --none",
    options: { none: flag },
    positionals: [1, 2],
    body: areas("projectArea"),
  },
  areas: { ...admin, terminalOnly: true, body: areas("areas") },
  "areas add": { ...admin, args: "KEY < NAME", positionals: 1, body: areas("areasAdd") },
  "areas rename": { ...admin, args: "KEY < NAME", positionals: 1, body: areas("areasRename") },
  "areas order": {
    ...admin,
    args: "KEY...",
    positionals: Array.from({ length: 32 }, (_, index) => index + 1),
    body: areas("areasOrder"),
  },
  "areas retire": { ...admin, args: "KEY", positionals: 1, body: areas("areasRetire") },
  "areas default": {
    ...admin,
    args: "ROLE KEY | ROLE --none",
    options: { none: flag },
    positionals: [1, 2],
    body: areas("areasDefault"),
  },
  // Work time: the owner's half-days, deep work and a project's time, to a
  // terminal only.
  // A malformed date, half, project or day count is a usage error before the terminal check.
  "time day": {
    ...admin,
    terminalOnly: true,
    args: "[DATE] [--half am|pm]",
    options: { half: text },
    positionals: [0, 1],
    check: ({ values, positionals }) => {
      const day = positionals[0];
      if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) usage();
      if (values.half !== undefined && values.half !== "am" && values.half !== "pm") usage();
    },
    body: time("timeDay"),
  },
  "time project": {
    ...admin,
    terminalOnly: true,
    args: "PROJECT [--days N]",
    options: { days: text },
    positionals: 1,
    check: ({ values, positionals }) => {
      if (!new RegExp(`^ent_${ULID_PATTERN}$`).test(positionals[0] ?? "")) usage();
      if (
        values.days !== undefined &&
        (typeof values.days !== "string" || !/^[1-9][0-9]{0,2}$/.test(values.days) || Number(values.days) > 365)
      )
        usage();
    },
    body: time("timeProject"),
  },
  // The owner's rulings on time, and the owner's veto of what the daily pass proposed.
  "time assign": {
    ...admin,
    args: "FROM TO (PROJECT | --none [--compartment C])",
    options: { none: flag, compartment: text },
    positionals: [2, 3],
    body: time("timeAssign"),
  },
  "time unassign": { ...admin, args: "RULING", positionals: 1, body: time("timeUnassign") },
  "time veto": {
    ...admin,
    args: "PROPOSAL [--to PROJECT]",
    options: { to: text },
    positionals: 1,
    body: time("timeVeto"),
  },
  "time except add": {
    ...admin,
    args: "(--bundle ID | --host HOST)",
    options: { bundle: text, host: text },
    body: time("timeExceptAdd"),
  },
  "time except remove": { ...admin, args: "ID", positionals: 1, body: time("timeExceptRemove") },
  "time except list": { ...admin, terminalOnly: true, body: time("timeExceptList") },
  // What agents set on work time, the owner's undo of one agent's, and the week's marks.
  "time agents": { ...admin, terminalOnly: true, body: time("timeAgents") },
  "time agents lift": { ...admin, args: "--client NAME", options: { client: text }, body: time("timeAgentsLift") },
  "time agents mark": { ...admin, args: "ID (right | wrong)", positionals: 2, body: time("timeAgentsMark") },
  // The role whose agents are served titles in get_work_time, or none.
  "time titles": {
    ...admin,
    args: "(ROLE | --none)",
    options: { none: flag },
    positionals: [0, 1],
    body: time("timeTitles"),
  },
};

export const WORK_RUNS: Rows = {
  "work status": { ...admin, body: work("workStatus") },
  "work stop": { ...admin, body: work("workStop") },
  "work start": { ...admin, body: work("workStart") },
  // The task tier, a gap trigger's route, and
  // the owner's cancel of one task.
  "work tasks": { ...admin, args: "on | off", positionals: 1, body: work("workTasks") },
  // `--default` sets the role unroled tasks and unrouted flags take; `--questions` the role the
  // owner's questions go through.
  "work route": {
    ...admin,
    args: "TRIGGER (ROLE | --none) | --default (ROLE | --none) | --questions (ROLE | --none)",
    options: { none: flag, default: flag, questions: flag },
    positionals: [0, 1, 2],
    body: work("workRoute"),
  },
  // --reason, the owner's decline reason on the cancel.
  "work cancel": {
    ...admin,
    args: "ID [--reason R]",
    options: { reason: text },
    positionals: 1,
    body: work("workCancel"),
  },
  // Work an agent holds, given back to the board: nothing cancelled, no decline.
  "work free": { ...admin, args: "OPPORTUNITY", positionals: 1, body: work("workFree") },
  // A read-only task the owner opens for a role, their note on
  // stdin, and their withdrawal of it while no agent has claimed it.
  "work task": {
    ...admin,
    args: "--role R --kind K [--about ID]...",
    options: { role: text, kind: text, about: { type: "string", multiple: true } },
    body: work("workTask"),
  },
  "work task withdraw": { ...admin, args: "ID", positionals: 1, body: work("workTaskWithdraw") },
  // The owner's Keep or Not useful on a finished task's result, `none` to clear it.
  "work result": {
    ...admin,
    args: "MOVE --answer keep|not_useful|none [--reason not_worth_it|wrong_timing|already_handled|wrong_person|missing_context|other]",
    options: { answer: text, reason: text },
    positionals: 1,
    body: work("workResult"),
  },
  "work budget": {
    ...admin,
    args: "[--runs N] [--usd N] [--cards N] [--input-chars N] [--token-price MICROUSD] [--output-tokens N] [--lessons-every N] [--planner research_only|split|one_pass] [--sweep-hour 0-23]",
    options: {
      runs: text,
      usd: text,
      cards: text,
      "input-chars": text,
      "token-price": text,
      "output-tokens": text,
      "lessons-every": text,
      planner: text,
      "sweep-hour": text,
    },
    body: work("workBudget"),
  },
  // The owner's own words on what they want from the planner, set and shown at a terminal only.
  // A lesson's kinds and roles, and the owner's retire and lift.
  "work lesson": {
    ...admin,
    args: "add [--kind K]... [--role R]... | retire ID [--note TEXT] [--lift]",
    options: {
      kind: { type: "string", multiple: true },
      role: { type: "string", multiple: true },
      note: text,
      lift: flag,
    },
    positionals: [1, 2],
    body: workRuns("workLesson"),
  },
  // Agent learnings: the owner's read, at a terminal since it
  // prints agents' words, and the owner's veto and its lifting.
  "work learnings": {
    ...admin,
    terminalOnly: true,
    args: "[--all]",
    options: { all: flag },
    body: workRuns("workLearnings"),
  },
  "work learning": {
    ...admin,
    args: "retire ID [--lift]",
    options: { lift: flag },
    positionals: 2,
    body: workRuns("workLearning"),
  },
  "work mission": { ...admin, terminalOnly: true, args: "set | show", positionals: 1, body: workRuns("workMission") },
  "work run": {
    ...admin,
    args: "[--goal ID | --entity ID | --idea ID]",
    options: { goal: text, entity: text, idea: text },
    body: workRuns("workRun"),
  },
  "work show": { ...admin, terminalOnly: true, args: "ID", positionals: 1, body: workRuns("workShow") },
  // What each run of the last days did and what came of it, to set the caps from. It prints
  // summaries and the owner's notes, so to a terminal only.
  "work report": {
    ...admin,
    terminalOnly: true,
    args: "[--days N]",
    options: { days: text },
    body: workRuns("workReport"),
  },
  // A trial run of one planner stage on a model and effort the owner names, which
  // writes nothing to the board; the trials with their counts, times and costs; and one
  // trial's output, which holds what the model wrote, so to a terminal only.
  "work trial": {
    ...admin,
    args: "--stage ideas|translate|lessons --model VENDOR/NAME[,...] --effort low|medium|high[,...] [--idea ID] [--prompt-version V]",
    options: { stage: text, model: text, effort: text, idea: text, "prompt-version": text },
    body: workRuns("workTrial"),
  },
  "work trials": {
    ...admin,
    terminalOnly: true,
    args: "[--stage S]",
    options: { stage: text },
    body: workRuns("workTrials"),
  },
  "work trial-show": { ...admin, terminalOnly: true, args: "RUN", positionals: 1, body: workRuns("workTrialShow") },
  // Who the system's pings go to, and the role that owns each kind of signal.
  "work pings": {
    ...admin,
    args: "[--order role:R|client:NAME,... | --clear-order] [--dated-minutes N] [--other-minutes N] [--batch-hour 0-23] [--signal-role KIND=ROLE|KIND=none]",
    options: {
      order: text,
      "clear-order": flag,
      "dated-minutes": text,
      "other-minutes": text,
      "batch-hour": text,
      "signal-role": text,
    },
    body: work("workPings"),
  },
};
