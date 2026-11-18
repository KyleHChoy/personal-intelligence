import { DateOnly, Timestamp } from "@intelligence/contracts";
import { EntityId, RoleName, TimeProposalId } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { parsed, printJson, requestId, withAdmin } from "./owner-kit.ts";

// `pi time day` and `pi time project`: work time as the owner's
// audience sees it, computed at read by the store and printed to a terminal only, since the views
// name places, threads and task titles. Each runs the start check through withAdmin
//. Minutes are observed foreground time, not effort.

const hours = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;

// `pi time day [DATE] [--half am|pm]`: a local day's two half-days in the owner's zone (today by
// default), then the day's deep work with its totals in hours; with --half, that half-day alone,
// since deep work is the whole day's. The arguments' forms are checked in
// commands.ts.
export async function timeDay(context: CommandContext): Promise<0> {
  const day = context.positionals[0];
  if (day !== undefined && !DateOnly.safeParse(day).success) throw refusal("usage");
  const half = context.values.half;
  if (half !== undefined && half !== "am" && half !== "pm") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const found = await admin.time.day(day ?? null);
    if (half !== undefined) {
      printJson(context, {
        day: found.day,
        zone: found.zone,
        halfDays: found.halfDays.slice(half === "am" ? 0 : 1, half === "am" ? 1 : 2),
      });
      return;
    }
    const deep = found.deepWork;
    printJson(context, {
      day: found.day,
      zone: found.zone,
      halfDays: found.halfDays,
      deepWork: deep,
      hours: {
        deep: hours(deep.deepMinutes),
        switching: hours(deep.switchingMinutes),
        meetings: hours(deep.meetingMinutes),
        complete: deep.complete,
      },
      // What the daily pass proposed; `pi time veto ID [--to PROJECT]` answers one.
      proposals: found.proposals,
    });
  });
}

// `pi time project PROJECT [--days N]`: the project's time, its sessions over the last N days (30
// by default, at most 365) and its tasks with their advisory worked-on minutes.
export async function timeProject(context: CommandContext): Promise<0> {
  const project = EntityId.safeParse(context.positionals[0]);
  if (!project.success) throw refusal("usage");
  const given = context.values.days;
  const days =
    given === undefined
      ? 30
      : typeof given === "string" && /^[1-9][0-9]{0,2}$/.test(given)
        ? Number(given)
        : Number.NaN;
  if (!Number.isInteger(days) || days > 365) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.time.project(project.data, days));
  });
}

// `pi time assign FROM TO PROJECT`, or `--none [--compartment C]`: the owner's
// ruling on a stretch of at most a day, over every anchor and link inside it.
export async function timeAssign(context: CommandContext): Promise<0> {
  const [fromGiven, toGiven, projectGiven] = context.positionals;
  const none = context.values.none === true;
  const from = Timestamp.safeParse(fromGiven);
  const to = Timestamp.safeParse(toGiven);
  const project = EntityId.safeParse(projectGiven);
  if (!from.success || !to.success || none === (projectGiven !== undefined) || (!none && !project.success))
    throw refusal("usage");
  const given = context.values.compartment;
  if (given !== undefined && (!none || typeof given !== "string")) throw refusal("usage");
  return withAdmin(context, (admin) =>
    admin.time.assign({
      from: from.data,
      to: to.data,
      project: none || !project.success ? null : project.data,
      ...(typeof given === "string" ? { compartment: given } : {}),
      requestId: requestId(),
    }),
  );
}

// `pi time unassign RULING`: lifts one of the owner's own rulings.
export async function timeUnassign(context: CommandContext): Promise<0> {
  const ruling = context.positionals[0];
  if (ruling === undefined) throw refusal("usage");
  return withAdmin(context, (admin) => admin.time.unassign(ruling, requestId()));
}

// `pi time veto PROPOSAL [--to PROJECT]`: the proposal's time stops crediting it
// and is never proposed again; with --to, it is the owner's ruling for that project instead.
export async function timeVeto(context: CommandContext): Promise<0> {
  const proposal = TimeProposalId.safeParse(context.positionals[0]);
  const to = context.values.to === undefined ? undefined : EntityId.safeParse(context.values.to);
  if (!proposal.success || to?.success === false) throw refusal("usage");
  return withAdmin(context, (admin) =>
    admin.time.veto({
      proposal: proposal.data,
      ...(to?.success === true ? { to: to.data } : {}),
      requestId: requestId(),
    }),
  );
}

// `pi time except add --bundle ID | --host HOST`: an app or site never proposed.
// Prints its id.
export async function timeExceptAdd(context: CommandContext): Promise<0> {
  const { bundle, host } = context.values;
  if ((bundle === undefined) === (host === undefined)) throw refusal("usage");
  const value = bundle ?? host;
  if (typeof value !== "string") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const id = await admin.time.addException(bundle === undefined ? "host" : "bundle", value);
    printJson(context, { id });
  });
}

export async function timeExceptRemove(context: CommandContext): Promise<0> {
  const id = context.positionals[0];
  if (id === undefined) throw refusal("usage");
  return withAdmin(context, (admin) => admin.time.removeException(id));
}

export async function timeExceptList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.time.exceptions());
  });
}

//: `pi time agents` lists the live anchors and rulings agents set,
// with the agent and when, and the week's sample of five to mark; `pi time agents lift --client
// NAME` lifts every one that agent made; `pi time agents mark ID right|wrong` marks one.
export async function timeAgents(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.time.agents());
  });
}

export async function timeAgentsLift(context: CommandContext): Promise<0> {
  const client = context.values.client;
  if (typeof client !== "string" || client.length === 0) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.time.liftAgent(client));
  });
}

export async function timeAgentsMark(context: CommandContext): Promise<0> {
  const [id, mark] = context.positionals;
  if (id === undefined || !/^(aan|atr)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || (mark !== "right" && mark !== "wrong"))
    throw refusal("usage");
  return withAdmin(context, (admin) => admin.time.markAgent(id, mark));
}

// `pi time titles ROLE` names the role whose agents
// get_work_time serves window titles, page titles and meeting names; `--none` turns it off.
// unknown_role for a role no active agent holds.
export async function timeTitles(context: CommandContext): Promise<0> {
  const [role, extra] = context.positionals;
  const none = context.values.none === true;
  if (extra !== undefined || none === (role !== undefined)) throw refusal("usage");
  const chosen = role === undefined ? null : parsed(RoleName, role);
  return withAdmin(context, (admin) => admin.work.setTitleRole(chosen));
}
