import type { AdminContext } from "../../core/admin-context.ts";
import * as memory from "../../memory/memory-admin.ts";
import { bound, boundNow, boundQuery, boundTx } from "../admin-bound.ts";
import * as tasks from "../admin-tasks.ts";
import { adoptGoal, hideGoal, unadoptGoal, unhideGoal } from "../goals/goal-adopt.ts";
import { agentLongWork } from "../projects/admin-long-work.ts";
import { agentActivity } from "./admin-activity.ts";
import { clearRestatement, listRestatements, memoryImports, purgeMemory } from "./admin-agent.ts";
import { agentRecords, agentWeeks } from "./admin-agent-records.ts";
import * as commitments from "./admin-commitments.ts";
import { goalWork } from "./admin-goal-work.ts";
import { ideas } from "./admin-ideas.ts";
import { learnings, retireLearning } from "./admin-learnings.ts";
import * as openItems from "./admin-open-items.ts";
import { ownerGoals } from "./admin-owner-goals.ts";
import { listRecords, recordOf, removeRecord } from "./admin-records.ts";
import * as research from "./admin-research.ts";
import { liftResearch, researchLanded } from "./admin-research-fill.ts";
import { listTrials, queueTrial, showTrial } from "./admin-trials.ts";
import * as work from "./admin-work.ts";
import * as planner from "./admin-work-planner.ts";
import { workReport } from "./admin-work-report.ts";
import { showWork } from "./admin-work-show.ts";
import { addOwnerTask, withdrawOwnerTask } from "./owner-tasks.ts";

// What agents keep: memory and its exposures, imports and purges, restatements and agent records
// (memory-admin.ts, admin-agent.ts, admin-records.ts), and what agents are doing (admin-activity.ts),
// as `Admin.agents`.
export const agentsAdmin = (context: AdminContext) => ({
  ...bound(context, {
    clearRestatement: clearRestatement,
    // In admin-agent.ts: memory changes counted by client and mark, with no
    // locator and no text; and every memory change of one client removed.
    memoryImports: memoryImports,
    purgeMemory: purgeMemory,
    activity: agentActivity,
    // The dashboard's read of who is on what: the work each agent holds, since when, its latest
    // progress, and the work parked with when it is due back (admin-long-work.ts).
    longWork: agentLongWork,
    records: agentRecords,
    // each agent's bets, questions and answers taken back by ISO week, for
    // `pia agents record` (admin-agent-records.ts). Throws AdminError "invalid_argument" for weeks
    // that are not a whole number from 1 to 26.
    weeks: agentWeeks,
    ideas: ideas,
    listRestatements: listRestatements,
  }),
  // The two owner reads of memory, in memory-admin.ts: every client, or the one named, with its
  // memory rows and exposures counted; and the exposures, newest first. Throws AdminError
  // "not_found" for a name that is no client, and, for the exposures, "invalid_argument" for a
  // limit that is not a whole number from 1 to 500.
  ...boundQuery(context, {
    memoryStatus: memory.memoryStatus,
    memoryExposures: memory.memoryExposures,
  }),
  ...boundTx(context, {
    // Agent records: every one, of every client and label, newest first, at most 200, with no
    // content. Throws AdminError "invalid_argument" for a kind or state that is none, or a limit
    // outside 1 to 200.
    listRecords: listRecords,
    // One agent record, its body opened; null for an id not there.
    record: recordOf,
    // That one agent record emptied; `{ removed: 0 }` when it had no body left, null for an id not there.
    removeRecord: removeRecord,
  }),
});

// Commitments and how they close (admin-commitments.ts), as `Admin.commitments`.
export const commitmentsAdmin = (context: AdminContext) =>
  bound(context, {
    closeCommitment: commitments.closeCommitment,
    reopenCommitment: commitments.reopenCommitment,
    setAgentCloses: commitments.setAgentCloses,
    list: commitments.commitmentsList,
    listCloses: commitments.listCloses,
  });

// What the owner owes and what is overdue (admin-open-items.ts), as `Admin.openItems`.
export const openItemsAdmin = (context: AdminContext) =>
  bound(context, {
    list: openItems.ownerOpenItems,
    close: openItems.closeOpenItem,
    reopen: openItems.reopenOpenItem,
  });

// Web research the owner files and its settings (admin-research.ts, admin-research-fill.ts), as
// `Admin.research`.
export const researchAdmin = (context: AdminContext) =>
  bound(context, {
    // The owner's research commands, in admin-research.ts.
    fileOwnerResearch: research.fileOwnerResearch,
    listResearch: research.listResearch,
    showResearch: research.showResearch,
    withdrawResearch: research.withdrawResearch,
    status: research.researchStatus,
    settings: research.researchSettings,
    // Each change is an owner decision of kind research_settings.
    setResearchSettings: research.setResearchSettings,
    landed: researchLanded,
    liftResearch: liftResearch,
  });

// The owner's commands of durable work, as `Admin.work`. Every decision goes through writeDecision,
// and every method that writes a ledger row begins its transaction with lockRows.
export const workAdmin = (context: AdminContext) => ({
  ...bound(context, {
    // Goals.
    addGoal: work.addGoal,
    backfillGoals: work.backfillGoals,
    setGoalStatus: work.setGoalStatus,
    editGoal: work.editGoal,
    rankGoal: work.rankGoal,
    listGoals: work.listGoals,
    ownerGoals: ownerGoals,
    goalWork: goalWork,
    rebuildGoalState: work.rebuildGoalState,
    setGoalTarget: work.setGoalTarget,
    targetGoalByName: work.targetGoalByName,
    // Intents and harness modes.
    addIntent: work.addIntent,
    listIntents: work.listIntents,
    setIntentRole: work.setIntentRole,
    revokeIntent: work.revokeIntent,
    grantHarnessMode: work.grantHarnessMode,
    listHarnessModes: work.listHarnessModes,
    revokeHarnessMode: work.revokeHarnessMode,
    // The switch, the budget and a run on request (admin-work-planner.ts).
    setKillSwitch: planner.setKillSwitch,
    setWorkBudget: planner.setWorkBudget,
    setMission: planner.setMission,
    addLesson: planner.addLesson,
    retireLesson: planner.retireLesson,
    // Agent learnings: the owner's read and veto.
    learnings: learnings,
    retireLearning: retireLearning,
    mission: planner.mission,
    wakeFacts: planner.wakeFacts,
    queueRequestedRun: planner.queueRequestedRun,
    queueIdeaRun: planner.queueIdeaRun,
    silenceRequestedRun: planner.silenceRequestedRun,
    status: planner.workStatus,
    // `pi work show`, in admin-work-show.ts, and `pi work report`, in admin-work-report.ts.
    showWork: showWork,
    report: workReport,
    queueTrials: work.queueTrials,
  }),
  ...boundNow(context, {
    // The owner's task commands, each one transaction that writes the owner's decision.
    setTaskTier: tasks.setTaskTier,
    setClientRoles: tasks.setClientRoles,
    setGapRoute: tasks.setGapRoute,
    // The owner's default task role, or none.
    setDefaultTaskRole: tasks.setDefaultTaskRole,
    // The role the owner's questions go through, or none.
    setQuestionRole: tasks.setQuestionRole,
    // The role whose agents are served titles in get_work_time, or none.
    setTitleRole: tasks.setTitleRole,
    // `pi work trial`.
    queueTrial: queueTrial,
    // `pi work free`: work an agent holds, given back to the board with no decline.
    freeWork: tasks.freeWork,
  }),
  ...boundQuery(context, {
    // The host of the owner's page, as `pi web serve` starts.
    setOwnerPageHost: tasks.setOwnerPageHost,
  }),
  ...boundTx(context, {
    // `pi goal adopt`: a goal stated in a source, by its fact key, made the owner's own goal with one
    // change (goal-adopt.ts); null for a key that is no such goal shown to the owner; undone by
    // `unadoptGoal`, false for a goal no adoption in force made.
    adoptGoal: adoptGoal,
    unadoptGoal: unadoptGoal,
    hideGoal: hideGoal,
    unhideGoal: unhideGoal,
    cancelTask: tasks.ownerCancelTask,
    addTask: addOwnerTask,
    withdrawTask: withdrawOwnerTask,
    // Trial runs: `pi work trials` and `pi work trial-show`. Each opens what it shows for a terminal
    // only.
    trials: listTrials,
    trialShow: showTrial,
  }),
});
