import type { AdminContext } from "../../core/admin-context.ts";
import {
  backupTaken,
  currentDatabase,
  dreamDue,
  latestMigration,
  openHealthCount,
  recordCanary,
  recordDashboardDown,
  recordHold,
  recordJob,
  recordRestarting,
  recordRestoreSkipped,
  recordRestoreTest,
  restoredFacts,
} from "../../core/box-health.ts";
import { acceptKeys, checkKeys } from "../../core/key-fingerprint.ts";
import { bound, boundNow, boundQuery } from "../admin-bound.ts";
import { pingSettings, setPingSettings } from "../admin-tasks.ts";
import { recordSurfaced } from "./admin-backtest.ts";
import { canaryWhat, setupCanary } from "./admin-canary.ts";
import { capabilityLedger } from "./admin-capabilities.ts";
import {
  closeImprovement,
  defectHolds,
  defectWords,
  fileImprovements,
  improvementsView,
  recordNightly,
  setDefectRole,
  setImprovementRole,
} from "./admin-improvements.ts";
import { leversView, setLever, undoLever } from "./admin-levers.ts";
import { loops } from "./admin-loops.ts";
import { outcomes } from "./admin-outcomes.ts";
import { systemMeasures } from "./admin-system.ts";
import { coverage, recordCoverage } from "./coverage.ts";

// The box's health: coverage, jobs, holds, restarts, backups and the shadow sampler
// (core/box-health.ts, pipeline/coverage.ts), as `Admin.box`.
export const boxAdmin = (context: AdminContext) => ({
  ...bound(context, {
    // `pia canary setup` and what `pi canary check` reads and records (admin-canary.ts).
    canarySetup: setupCanary,
    canaryWhat: canaryWhat,
    recordCanary: recordCanary,
    // `pia improvements`: the store's counts, its oldest open and what each cause measures.
    improvements: improvementsView,
    // The page's read of what an agent wrote of each open defect it filed.
    defectWords: defectWords,
    // The roles whose live defect tasks one agent holds to a date, every one.
    defectHolds: defectHolds,
    // `pi improvements file`: one filing pass, by code, with no model.
    fileImprovements: fileImprovements,
    // `pia improvements nightly --red N`: the nightly report's count.
    recordNightly: recordNightly,
    // `pia improvements close` and `pia improvements role`: the owner's dismissal of a defect and
    // the role whose agents work it.
    closeImprovement: closeImprovement,
    setImprovementRole: setImprovementRole,
    // `pia improvements default-role`: the role defects go to, or none.
    setDefectRole: setDefectRole,
    // `pia levers`, `pia levers set` and `pia levers undo` (admin-levers.ts).
    levers: leversView,
    setLever: setLever,
    undoLever: undoLever,
    // `pia backtest record`: what `next` and the open items show now, by id, for `pia outcomes` to score.
    backtestRecord: recordSurfaced,
    // box-health.ts: `pia health job`, a run the timer saw end, with its timed-out
    // card and its job's failure streak; `pia health hold`, a hold on for more than an hour; `pia
    // backup taken`; and `pia health dream-due`, the owner's day and whether its sweep hour has come.
    recordJob: recordJob,
    recordRestarting: recordRestarting,
    backupTaken: backupTaken,
    recordRestoreTest: recordRestoreTest,
    recordRestoreSkipped: recordRestoreSkipped,
    latestMigration: latestMigration,
    currentDatabase: currentDatabase,
    restoredFacts: restoredFacts,
    openHealthCount: openHealthCount,
    dreamDue: dreamDue,
    // AdminError "invalid_argument" otherwise). Ids, counts and codes only. `generation` is the
    // extractor's, for what is due in each lane, as extractionStatus.
    coverage: coverage,
    // `--record`: the states kept, and the rows that entered `silent` with this record.
    // A row that is no CoverageRow is refused with AdminError "invalid_argument", and nothing is kept.
    recordCoverage: recordCoverage,
    // `pia outcomes`: each feature's outcome metric and its use over the last `days` days (1 to 90;
    // AdminError "invalid_argument" otherwise), read-only, in ids, counts and codes.
    outcomes: outcomes,
    // `pia loops`: what each autonomous loop produced over `days` days (1 to 90) and the `days` before.
    loops: loops,
    // The dashboard's System room: each measure's latest stored reading against its healthy line.
    measures: systemMeasures,
    // `--off`, the hold lifted, closes its card; a process restarting; the page off
    // the owner's tailnet, and back.
    recordHold: recordHold,
    recordDashboardDown: recordDashboardDown,
    // key-fingerprint.ts: `pi health keys`, the key file against its recorded identity at each
    // start, and `pia keys accept-fingerprint`, the owner's word that it changed on purpose.
    checkKeys: checkKeys,
    acceptKeys: acceptKeys,
  }),
  ...boundQuery(context, {
    pingSettings: pingSettings,
  }),
  ...boundNow(context, {
    // Who the system's pings go to, the owner's setting.
    setPingSettings: setPingSettings,
    // `pia ledger`: each scheduled job's runs over 14 days and its last run, ids and counts only.
    capabilities: capabilityLedger,
  }),
});
