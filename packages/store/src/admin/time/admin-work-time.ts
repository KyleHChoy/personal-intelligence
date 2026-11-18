import { DateOnly } from "@intelligence/contracts";
import {
  type DeepWorkDay,
  dayIn,
  type HalfDay,
  type ProjectTime,
  type TaskView,
  type TimeProposalView,
  type TimeWeek,
  type WorkSession,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import type { Keys } from "../../core/keys.ts";
import { openedUnder } from "../../core/tx.ts";
import { gather, type Source } from "../../core/work-time-read.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { ownerBeliefs } from "../admin-owner.ts";
import { REPEATABLE, unrestrictedOf } from "../admin-time-base.ts";
import { dayProposals } from "./admin-time-rulings.ts";

// Work time for the owner's terminal: `pi time day` and `pi time project`, the reader's gathering
// run as pi_admin over every compartment the key file holds but a restricted one, with the owner's
// beliefs computed when asked, in one repeatable-read snapshot so every statement sees the same
// committed state. Writes nothing.

function adminSource(keys: Keys, query: Query): Source {
  const within = unrestrictedOf(keys);
  return {
    run: (text, values) => query(text, values),
    open: (table, column, row) => openedUnder(keys, row.compartments, { table, id: row.id, column }, row.value_enc),
    within,
    clearance: async () => within,
    anchorFp: (key) => fingerprint(keys, "anchor", key),
    supportOf: async (facts) => (await ownerBeliefs({ query, keys }, facts)).map((one) => one.support),
  };
}

// `pi time day`: the two half-days of a local day in the owner's zone (today by default) and its
// deep work.
export type TimeDay = {
  day: string;
  zone: string | null;
  halfDays: HalfDay[];
  deepWork: DeepWorkDay;
  proposals: TimeProposalView[];
};
export function timeDay(admin: AdminContext, day: string | null): Promise<TimeDay> {
  return admin.transaction(async (query) => {
    await query(REPEATABLE);
    const zone = await ownerZoneOf(query);
    const now = admin.now();
    const date = day ?? dayIn(now, zone);
    const views = await gather(adminSource(admin.keys, query), { view: "day", day: date }, now, zone);
    if (views.day === undefined) throw new Error("work: no day view");
    const proposals = await dayProposals(admin, query, date, zone);
    return { day: date, zone, halfDays: views.day.halfDays, deepWork: views.day.deepWork, proposals };
  });
}

export function timeWeek(admin: AdminContext, weekStart: string): Promise<TimeWeek> {
  if (!DateOnly.safeParse(weekStart).success) return Promise.reject(new AdminError("invalid_argument"));
  return admin.transaction(async (query) => {
    await query(REPEATABLE);
    const zone = await ownerZoneOf(query);
    const views = await gather(adminSource(admin.keys, query), { view: "week", weekStart }, admin.now(), zone);
    if (views.week === undefined) throw new Error("work: no week view");
    return views.week;
  });
}

// `pi time project`: a project's time, its sessions over the last `days` and its tasks with their
// worked-on minutes. Throws AdminError "not_found" for no such active project within the
// compartments the gathering reads.
type TimeProject = { time: ProjectTime; sessions: WorkSession[]; tasks: TaskView[] };
export function timeProject(admin: AdminContext, project: string, days: number): Promise<TimeProject> {
  return admin.transaction(async (query) => {
    await query(REPEATABLE);
    const source = adminSource(admin.keys, query);
    const [found] = await query<{ id: string }>(
      "select id from knowledge.projects where id = $1 and status = 'active' and compartments <@ $2::text[]",
      [project, source.within],
    );
    if (found === undefined) throw new AdminError("not_found");
    const views = await gather(source, { view: "project", project, days }, admin.now(), await ownerZoneOf(query));
    if (views.project === undefined) throw new Error("work: no project view");
    return views.project;
  });
}
