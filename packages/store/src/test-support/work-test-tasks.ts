import type { EntityId, OpportunityId, PersonalLogger } from "@intelligence/contracts/personal";
import { planGapFlags } from "@intelligence/personal-core/planner";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { setClientRoles } from "../admin/admin-tasks.ts";
import { createDispatch, type Dispatch } from "../work/dispatch.ts";
import { request, testId } from "./clients.ts";
import { session } from "./connections.ts";
import { queryAs, type TestDatabase } from "./database.ts";
import { recordingLogger } from "./recording.ts";
import type { WorkClient } from "./work-clients.ts";
import { type Message, ok, type WorkWorld } from "./work-test-world.ts";

// For the work tools' tests only, over a WorkWorld: an agent, a task, a claim, held work, time
// moved on a lease, a dispatcher and the tick's steps a store test runs alone, and the owner's
// admin. One definition of each, so a test file holds only what is its own.

const OWN = ["own"];

export const later = (ms: number): Date => new Date(Date.now() + ms);

// An agent with its tools and a harness for each kind at the investigate stage. `account`: its
// agent source account, as registering a client that holds `record` makes it, so its records are
// taken in under it. `roles`: set as the owner sets them.
export async function workAgent(
  w: WorkWorld,
  name: string,
  compartments: string[],
  options: { tools: readonly string[]; kinds?: readonly string[]; account?: boolean; roles?: string[] },
): Promise<WorkClient> {
  const client = await w.client(name, compartments, { tools: options.tools });
  for (const kind of options.kinds ?? ["investigate"]) await w.harness(client, kind, "investigate");
  if (options.account === true)
    await w.admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'agent', 'agent_record', $3)",
      [testId("acc"), `agent:${name}`, [`agent:${name}`]],
    );
  if ((options.roles ?? []).length > 0) await setClientRoles(w.admin, name, options.roles ?? [], new Date());
  return client;
}

// A message the pipeline screened and did not withhold: a basis no flag stops.
export async function screened(w: WorkWorld, compartments: string[] = OWN): Promise<Message> {
  const message = await w.message(compartments);
  await w.seed.pipelineItem(compartments, message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  return message;
}

export type TaskOptions = {
  // The person the task is about; a new one under `compartments` when not given.
  subject?: string;
  compartments?: string[];
  summary?: string;
  role?: string;
  project?: string;
  parent?: string;
  blockedBy?: string[];
  dueAt?: string;
};

// A task proposed about a person, on a screened message, all under `compartments`: the tool's
// outcome, for a test of a refusal.
export async function proposed(w: WorkWorld, client: WorkClient, options: TaskOptions = {}) {
  const compartments = options.compartments ?? OWN;
  let subject = options.subject;
  if (subject === undefined) {
    subject = await w.seed.entity("person");
    await w.seed.account(compartments, subject);
  }
  const message = await screened(w, compartments);
  return w.work.proposeTask(client.token, {
    kind: "investigate",
    about: { kind: "entity", id: subject as never },
    summary: options.summary ?? "find who runs it and what it works on",
    basis: [{ kind: "message", id: message.id as never }],
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.project === undefined ? {} : { project: options.project as EntityId }),
    ...(options.parent === undefined ? {} : { parent: options.parent as OpportunityId }),
    ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy as OpportunityId[] }),
    ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as never }),
    requestId: request(),
  });
}

// The same, taken: the task's id.
export const task = async (w: WorkWorld, client: WorkClient, options: TaskOptions = {}): Promise<string> =>
  ok(await proposed(w, client, options)).opportunity;

export const claim = (w: WorkWorld, client: WorkClient, id: string) =>
  w.work.claimOpportunity(client.token, { id: id as never, requestId: request() });

// A task its proposer claimed and planned a move on.
export async function held(
  w: WorkWorld,
  client: WorkClient,
  options: TaskOptions = {},
): Promise<{ id: string; move: string }> {
  const id = await task(w, client, options);
  ok(await claim(w, client, id));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: id as never, stage: "investigate", requestId: request() }),
  );
  return { id, move };
}

// The lease row of a piece of work moved back in time, as pi_work, which alone may update it.
export const age = (w: WorkWorld, id: string, hours: number): Promise<unknown> =>
  queryAs(
    w.db.urls.work,
    `update queue.leases set lease_until = lease_until - make_interval(hours => $2::int),
       first_taken_at = first_taken_at - make_interval(hours => $2::int),
       preferred_until = preferred_until - make_interval(hours => $2::int)
     where resource_kind = 'opportunity' and resource_id = $1`,
    [id, hours],
  );

export type { Dispatch };
// A dispatcher as pi_work, closed after; it logs to the world's log when the world has one.
export const dispatching = async <T>(
  w: { db: TestDatabase; log?: PersonalLogger },
  fn: (dispatch: Dispatch) => Promise<T>,
): Promise<T> => {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log ?? recordingLogger().log, journal: "" });
  try {
    return await fn(dispatch);
  } finally {
    await dispatch.close();
  }
};

// The tick's gap step, by the tick's own plan, as pi_work: the flags whose gap stopped holding
// close, then the gaps that hold are raised. The app's tick (`gapPass`) adds the raise cap and the
// rung 0 check, which the store cannot import; this is the plan alone.
export async function gapTick(dispatch: Dispatch, now: Date): Promise<void> {
  const flags = await dispatch.gapFlags(now);
  const plan = planGapFlags({
    candidates: await dispatch.gapCandidates(now),
    open: flags.open,
    history: flags.history,
    supply: await dispatch.gapSupply(now),
  });
  for (const id of plan.close) await dispatch.closeGapFlag(id, now);
  for (const { gap, card } of plan.raise) await dispatch.raiseGapFlag(gap, !card);
}

// The tick's steps for one piece of work, in the tick's order: what is past its time (its lapsed
// lease, its expiry, and each of `moves` left unreported), with `checkBacks` the check-backs due,
// and the hold that lapsed. What each step wrote, in order.
export async function expiryTick(
  dispatch: Dispatch,
  id: string,
  now: Date,
  options: { moves?: string[]; checkBacks?: boolean } = {},
): Promise<string[]> {
  const written: string[] = [];
  for (const one of await dispatch.expired(now)) {
    const mine =
      ((one.kind === "opportunity_lease" || one.kind === "opportunity") && one.opportunity === id) ||
      (one.kind === "move_unreported" && (options.moves ?? []).includes(one.move));
    if (mine && (await dispatch.expire(one, now))) written.push(one.kind);
  }
  if (options.checkBacks === true)
    for (const due of await dispatch.dueIntentions(now)) {
      if (due.opportunity !== id || due.kind !== "check_back" || due.client === null) continue;
      const preferred = { client: due.client, intention: due.id };
      if (due.opportunityStatus === "claimed" && due.holder === due.client) {
        if (await dispatch.returnToGo(due.opportunity, now, preferred)) written.push("returned");
      } else if (due.opportunityStatus === "go") {
        written.push((await dispatch.preferClient(due.opportunity, preferred, now)) ? "preferred" : "not_preferred");
      } else if (await dispatch.cancelIntention(due.id, now)) written.push("cancelled");
    }
  if ((await dispatch.lapsedHolds(now)).includes(id as never) && (await dispatch.lapseHold(id as never, now)))
    written.push("hold_lapsed");
  return written;
}

// The owner's admin over a world's database, closed after.
export const withAdmin = async <T>(w: { db: TestDatabase }, fn: (admin: Admin) => Promise<T>): Promise<T> => {
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
};

// One update as pi_owner past a table's forced row security: a test's stand-in for time passing,
// a taint or a due date on a row no role updates.
export const ownerUpdate = (
  w: { db: TestDatabase },
  table: string,
  set: string,
  where: string,
  values: unknown[],
): Promise<void> =>
  session(w.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`update ${table} set ${set} where ${where}`, values);
    await query(`alter table ${table} force row level security`);
  });
