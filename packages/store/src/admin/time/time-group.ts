import type { AdminContext } from "../../core/admin-context.ts";
import { bound } from "../admin-bound.ts";
import * as agents from "./admin-agent-time.ts";
import * as ownerLedger from "./admin-ledger.ts";
import * as rulings from "./admin-time-rulings.ts";
import * as week from "./admin-week.ts";
import * as workTimeRead from "./admin-work-time.ts";

// The ledger's reads for the dashboard (admin-ledger.ts), as `Admin.ledger`.
export const ledgerAdmin = (context: AdminContext) =>
  bound(context, {
    // The owner's ledger: a day's tally and lanes in their zone, the feed newest first, the event
    // stream's poll, and the spend and card-load series.
    day: ownerLedger.ledgerDay,
    lanes: ownerLedger.ledgerLanes,
    feed: ownerLedger.ledgerFeed,
    events: ownerLedger.ledgerEvents,
    spendSeries: ownerLedger.spendSeries,
    cardLoadSeries: ownerLedger.cardLoadSeries,
  });

// Where the owner's time and spend went (admin-work-time.ts, admin-week.ts), as `Admin.time`.
export const timeAdmin = (context: AdminContext) =>
  bound(context, {
    // Work time: `pi time day` and `pi time project`, as pi_admin with the owner's audience.
    day: workTimeRead.timeDay,
    assign: rulings.assignTime,
    unassign: rulings.unassignTime,
    veto: rulings.vetoProposal,
    proposals: rulings.recentProposals,
    addException: rulings.addException,
    removeException: rulings.removeException,
    exceptions: rulings.listExceptions,
    // What agents set on work time, the owner's lift of one agent's, and their marks.
    agents: agents.agentTime,
    liftAgent: agents.liftAgentTime,
    markAgent: agents.markAgentTime,
    // The owner's reads: the week's meetings and work time, spend today, the budget and the
    // lessons, read only.
    weekEvents: week.weekEvents,
    week: workTimeRead.timeWeek,
    spendToday: week.spendToday,
    budget: week.budget,
    lessons: week.lessons,
    project: workTimeRead.timeProject,
  });
