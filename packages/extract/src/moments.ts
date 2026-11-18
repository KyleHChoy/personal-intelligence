import { DateOnly, type InterpreterOutput } from "@intelligence/contracts";
import type { ClaimRecord, DueCapture, OpenedMoment, TriageLane } from "@intelligence/contracts/personal";
import { type ModelClient, ModelClientError } from "@intelligence/personal-models";
import { messagedClaims, messagedPeople } from "./activity.ts";
import { askedMomentPlan } from "./asked-version.ts";
import { ExtractFailure } from "./call-failure.ts";
import type { CaptureTally } from "./capture-check.ts";
import { EXTRACT_GENERATION, type ExtractDeps } from "./config.ts";
import { type CallPort, interpret, passesThrough, REPLAY_ONLY } from "./interpret.ts";
import {
  type ExtractOutcome,
  failedCall,
  failedPlan,
  type ItemEnds,
  itemEnds,
  noPromptHere,
  opening,
  StoppedAfter,
} from "./item-ends.ts";
import { withheldBy } from "./lane-check.ts";
import { type ItemLink, itemLink, withLink } from "./link.ts";
import { checkMoments, sumTallies } from "./moments-check.ts";
import { type MomentMember, type MomentPassage, type MomentPlan, momentProject, planMoments } from "./moments-plan.ts";
import { OWN_LINES_PROMPT_ID, ownLinesMoment } from "./own-lines.ts";
import { resolvingProject } from "./project-named.ts";
import { ownLinesPrompt } from "./prompts.ts";
import { triageMoment } from "./triage.ts";

// The moment lane: a due group of moments, each opened and triaged by rules; the moments in the lane
// sent together as one request under the extraction port, budgets and replay; each claim checked
// against the one moment it cites, by code; then one commit for each moment. The lane offers
// MOMENT_TYPES from version 3, has no day cap (the run's and the day's dollar lines bound it), and
// logs each checked group's candidates and drops (`moment_checked`).

export { MOMENT_GROUP_MAX } from "@intelligence/contracts/personal";
export const MOMENT_SETTLE_MS = 7_200_000;

// It runs only when the replay misses, so a replay notes nothing. A note that fails is the model
// being away: the moments wait and no request is sent.
export const noteGroup = (
  model: ModelClient,
  deps: Pick<ExtractDeps, "store" | "modelId">,
  evidenceIds: string[],
): ModelClient => ({
  async complete(request) {
    try {
      await deps.store.noteExposure(deps.modelId, request.promptId, evidenceIds as never);
    } catch {
      throw new ModelClientError("unavailable");
    }
    return model.complete(request);
  },
  embed: (request) => model.embed(request),
});

// A group whose slot names a person only because a handle has bound since reads otherwise than the
// request saved before it bound, so that call would not replay and the group would be asked again.
// Its claims about the handle were held for this. The saved calls are asked, through a client that
// sends nothing, first for the request as planned (a call saved after the handle bound), then for
// it rendered without the bound handles' names (the call saved before); the first found is checked
// by the bindings now in force, with no request sent and no exposure noted. Null when no bound
// handle names anyone, or neither call is saved: the group is then asked as planned. A failed
// replay lookup leaves the group waiting; only an absent saved call may fall through to a new paid
// request.
async function replayUnbound(
  part: { opened: OpenedMoment; member: MomentMember }[],
  plan: MomentPlan | null,
  deps: Pick<ExtractDeps, "store" | "modelId">,
): Promise<{ plan: MomentPlan; output: InterpreterOutput } | null> {
  if (
    plan === null ||
    ![...plan.people.values()].some((one) => one.name !== undefined && one.mention.name === undefined)
  )
    return null;
  const missing = new ExtractFailure("model_unavailable");
  const saved = async (one: MomentPlan | null): Promise<{ plan: MomentPlan; output: InterpreterOutput } | null> => {
    const first = one?.sent[0];
    if (one === null || first === undefined) return null;
    try {
      const asked = await interpret(one.prompt, one.data, first.parsed, first.read, {
        model: { ...REPLAY_ONLY, complete: () => Promise.reject(missing) },
        calls: deps.store.calls(
          deps.modelId,
          one.sent.map((passage) => passage.member.evidenceId),
        ),
      });
      return { plan: one, output: asked.output };
    } catch (error) {
      if (error === missing) return null;
      throw error;
    }
  };
  return (await saved(plan)) ?? (await saved(planMoments(part, false)));
}

// An answer the schema refused, which carries its shape; a client's or the
// pipeline's own failure is `interpret_failed` with no shape, and is no reason to ask again.
export const refusedAnswer = (error: unknown): error is ExtractFailure =>
  error instanceof ExtractFailure && error.code === "interpret_failed" && error.shape !== undefined;

// What `moment_checked` counts of the moments committed `done`, and the request's call key's
// evidence id, which is its one id.
type Checked = { counts?: CaptureTally; evidence?: MomentMember["evidenceId"] };

// A read that fails reads as reached, so the lane waits rather than spends unseen.
async function ownLinesCapped(deps: ExtractDeps): Promise<boolean> {
  try {
    const day = DateOnly.parse(deps.now().toISOString().slice(0, 10));
    return (await deps.store.spentOnPromptSince(OWN_LINES_PROMPT_ID, day)) >= (deps.ownLines?.dayMicroUsd ?? 0);
  } catch {
    return true;
  }
}

// Steps 2 to 6 of "The pipeline for one stored item" for one group of moments, with the group's
// `moment_checked` line once its moments are committed, whatever ends the group: with the lane on,
// a group with a moment committed `done` or `skipped` logs one, with the counts of the skipped
// moments by their code beside the done moments' candidates.
export async function processMoments(due: DueCapture, deps: ExtractDeps): Promise<ExtractOutcome[]> {
  const checked: Checked = {};
  const outcomes: ExtractOutcome[] = [];
  try {
    return await processGroup(due, deps, checked, outcomes);
  } finally {
    const reasons: CaptureTally = {};
    for (const one of outcomes)
      if (one.status === "skipped" && one.code !== undefined) reasons[one.code] = (reasons[one.code] ?? 0) + 1;
    if (deps.moments === true && (checked.counts !== undefined || Object.keys(reasons).length > 0)) {
      deps.log.info({
        event: "moment_checked",
        counts: { ...checked.counts, ...reasons },
        ids: { evidence: checked.evidence ?? (due.moments?.[0] ?? due).evidenceId },
      });
    }
  }
}

type Opened = { opened: OpenedMoment; member: MomentMember };
type Links = Map<string, { link: ItemLink; capture: OpenedMoment["capture"]["id"]; activity: ClaimRecord[] }>;

// One group's run: what the lane writes into as it ends moments. `lead`: the first request's
// evidence id, which `moment_checked` keeps after a split.
type GroupRun = {
  readonly deps: ExtractDeps;
  readonly checked: Checked;
  readonly outcomes: ExtractOutcome[];
  readonly endsOf: (evidenceId: MomentMember["evidenceId"]) => ItemEnds;
  lead?: MomentMember["evidenceId"] | undefined;
};

const LANE: TriageLane = "moment";

// Each moment opened; a page and an agent app's moment committed so whatever the switch; with the
// lane off each other committed `not_extracted` with no call; else each triaged, and the moments in
// the lane sent as one request, checked, and each committed. A failed call ends every moment sent as
// one item's would end.
async function processGroup(
  due: DueCapture,
  deps: ExtractDeps,
  checked: Checked,
  outcomes: ExtractOutcome[],
): Promise<ExtractOutcome[]> {
  const opened = await openGroup(due.moments ?? [due], deps, outcomes);
  const { links, kept } = await linkGroup(opened, deps, outcomes);
  const run: GroupRun = { deps, checked, outcomes, endsOf: (evidenceId) => momentEnds(evidenceId, deps, links) };
  const { inLane, ownLane } = await triageGroup(kept, run);
  if (inLane.length === 0 && ownLane.length === 0) return outcomes;
  if (inLane.length > 0) await askPart(run, inLane);
  if (ownLane.length > 0) {
    if (await ownLinesCapped(deps)) {
      // Left as they are, still due: a later day asks them.
      checked.counts = { ...checked.counts, own_lines_capped: ownLane.length };
    } else await askPart(run, ownLane, false, true);
  }
  return outcomes;
}

// Each moment of the group opened, a gone one ended `gone`.
async function openGroup(members: MomentMember[], deps: ExtractDeps, outcomes: ExtractOutcome[]): Promise<Opened[]> {
  const opened: Opened[] = [];
  // A project's name reaches the vendor from a chat only with both lanes on: the owner's word on
  // names is for `correspondence`, and `moment` asks the version that reads it.
  const readsProjects = deps.factKinds?.includes("moment") === true && deps.factKinds.includes("correspondence");
  for (const member of members) {
    const one = await opening(() => deps.store.openMoment(member.evidenceId, { projects: readsProjects }));
    if (one === null) outcomes.push({ status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false });
    else {
      const project = momentProject(one);
      opened.push({ opened: project === null ? one : resolvingProject(one, project.project), member });
    }
  }
  return opened;
}

// A moment is never linked by title. Every final status of a moment carries its link (withLink). A
// moment whose link could not be read is deferred, and one gone since is ended `gone`; `kept` are
// the rest.
async function linkGroup(
  opened: readonly Opened[],
  deps: ExtractDeps,
  outcomes: ExtractOutcome[],
): Promise<{ links: Links; kept: Opened[] }> {
  const links: Links = new Map();
  const kept: Opened[] = [];
  const generation = deps.generation ?? EXTRACT_GENERATION;
  for (const one of opened) {
    const { evidenceId } = one.member;
    let linked: ItemLink | null;
    let activity: ClaimRecord[];
    try {
      linked = await itemLink(deps, evidenceId, one.opened.context.revision, generation, {
        title: null,
        calendarTitle: null,
      });
      activity = messagedClaims(one.opened, await messagedPeople(one.opened), generation);
    } catch {
      outcomes.push(await itemEnds(evidenceId, deps).defer("moment", "check_failed", true));
      continue;
    }
    if (linked === null) {
      outcomes.push({ status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false });
      continue;
    }
    links.set(evidenceId, { link: linked, capture: one.opened.capture.id, activity });
    kept.push(one);
  }
  return { links, kept };
}

// A moment's ends, with its link. A skipped moment keeps the claims a model made from it before (a
// done moment an anchor's re-check or a binding's replay re-commits), until the owner retries it;
// the store decides by their retry.
function momentEnds(evidenceId: MomentMember["evidenceId"], deps: ExtractDeps, links: Links): ItemEnds {
  const ends = itemEnds(evidenceId, deps);
  const linked = links.get(evidenceId);
  const made =
    linked === undefined ? ends : withLink(ends, linked.link, deps, evidenceId, linked.capture, linked.activity);
  return {
    ...made,
    final: (lane, status, code, found, more) =>
      made.final(lane, status, code, found, status === "skipped" ? { ...more, keep: true } : more),
  };
}

// Triage at rung 0, each moment on its own: those the moment lane asks, those the own-lines lane
// asks, and every other moment ended here.
async function triageGroup(opened: readonly Opened[], run: GroupRun): Promise<{ inLane: Opened[]; ownLane: Opened[] }> {
  const { deps, outcomes } = run;
  const inLane: Opened[] = [];
  const ownLane: Opened[] = [];
  for (const one of opened) {
    if (deps.ownLines !== undefined && ownLinesMoment(one.opened, one.member.lane)) {
      ownLane.push(one);
      continue;
    }
    const ends = run.endsOf(one.member.evidenceId);
    // The stored item's own kind and turns, as the contract parsed them (turns only on a chat read
    // `ax`), not the capture row's sealed facts.
    const { item, capture } = one.opened;
    const triaged = triageMoment(
      {
        entity: item.entity,
        agentApp: capture.agentApp,
        storedDocument: capture.storedDocument,
        text: item.text,
        turns: item.turns !== undefined,
        agentTurn: item.turns?.some((turn) => turn.speaker === "agent") ?? false,
        read: item.read,
      },
      one.member.lane,
    );
    // A page moment is committed `reading` with its link, whatever the switch, so switching the
    // lane on never takes one. An agent app's moment the same, `agent_app`.
    if (triaged.code === "reading" || triaged.code === "agent_app") {
      outcomes.push(await ends.final("skip", "skipped", triaged.code));
      continue;
    }
    if (deps.moments !== true) {
      outcomes.push(await ends.final(LANE, "skipped", "not_extracted"));
      continue;
    }
    if (triaged.lane === "skip") outcomes.push(await ends.final("skip", "skipped", triaged.code));
    // A message's, a document's or a meeting's lane, given a moment by hand, has no prompt for one.
    else if (triaged.lane !== "moment") outcomes.push(await noPromptHere(ends));
    else inLane.push(one);
  }
  return { inLane, ownLane };
}

// One request of the moments given, checked and committed; split in two, once, when its answer
// is refused.
async function askPart(run: GroupRun, part: Opened[], halved = false, ownLines = false): Promise<void> {
  const { deps, outcomes, endsOf } = run;
  let plan: MomentPlan | null;
  let held: { plan: MomentPlan; output: InterpreterOutput } | null = null;
  try {
    plan = ownLines ? planMoments(part, true, ownLinesPrompt(), true) : planMoments(part);
    held = ownLines ? null : await replayUnbound(part, plan, deps);
    if (held !== null) plan = held.plan;
    if (!ownLines && held === null && plan !== null) plan = await askedMomentPlan(part, plan, deps);
  } catch (error) {
    for (const one of part)
      outcomes.push(await failedPlan(error, LANE, endsOf(one.member.evidenceId), "commit_failed"));
    return;
  }
  const sent = plan?.sent ?? [];
  // After a split, moment_checked keeps the first request's id.
  if (!halved) run.lead ??= sent[0]?.member.evidenceId;
  // A moment past the bound (`plan.later`) is left as it is: still due, it is sent with the next.
  for (const member of plan === null ? part.map((one) => one.member) : plan.tooLong)
    outcomes.push(await endsOf(member.evidenceId).final(LANE, "skipped", "too_long"));
  if (plan === null) return;

  // The request is the first moment's: its call key, its label (every moment of a group shares it)
  // and the client that notes whether the vendor answered. Its saved call lists every moment sent,
  // so the removal of any one of them removes it.
  const ends = sent.map((passage) => endsOf(passage.member.evidenceId));
  const first = ends[0] as ItemEnds;
  const sentIds = sent.map((passage) => passage.member.evidenceId);
  const port: CallPort = {
    model: noteGroup(first.model, deps, sentIds),
    calls: deps.store.calls(deps.modelId, sentIds),
  };
  let output: InterpreterOutput;
  try {
    output =
      held?.output ??
      (
        await interpret(
          plan.prompt,
          plan.data,
          (sent[0] as MomentPassage).parsed,
          (sent[0] as MomentPassage).read,
          port,
        )
      ).output;
  } catch (error) {
    // An answer the schema refused is logged by its shape alone, and a request
    // of more than one moment is asked again, once, as two halves, each its own request and call
    // key, so one bad answer does not fail every moment of the group. A half refused again fails,
    // so a refusal the content causes costs at most two more requests.
    if (refusedAnswer(error)) {
      const split = !halved && sent.length > 1;
      deps.log.info({
        event: "moment_rejected",
        counts: { moments: sent.length, ...(split ? { split: 1 } : {}), ...error.shape },
        ids: { evidence: (sent[0] as MomentPassage).member.evidenceId },
      });
      if (split) {
        const asked = part.filter((one) => sentIds.includes(one.member.evidenceId));
        const half = Math.ceil(asked.length / 2);
        await askPart(run, asked.slice(0, half), true, ownLines);
        await askPart(run, asked.slice(half), true, ownLines);
        return;
      }
    }
    // A budget or a refusal of the key passes through before any moment sent is
    // committed, so the group stays due; it carries what this call committed before the request,
    // for the run's counts.
    try {
      for (const one of ends) outcomes.push(await failedCall(error, LANE, one));
    } catch (stop) {
      if (passesThrough(stop)) throw new StoppedAfter(outcomes, stop);
      throw stop;
    }
    return;
  }

  // A narrowing that withholds ends each moment the owner has not released. A group withheld whole
  // is not checked at all.
  const withheld = withheldBy(output.narrowing);
  if (withheld !== undefined && !sent.some((passage) => passage.member.override)) {
    for (const one of ends) outcomes.push(await one.final(LANE, "withheld", withheld));
    return;
  }
  let found: Awaited<ReturnType<typeof checkMoments>>;
  try {
    found = await checkMoments(
      output,
      plan,
      first.generation,
      undefined,
      (key) => deps.store.keyFingerprint(key),
      deps.repair === true,
    );
  } catch {
    for (const one of ends) outcomes.push(await one.defer(LANE, "check_failed", true));
    return;
  }
  await commitPart(run, sent, ends, found, withheld);
}

// Each moment sent committed with what the check found of it, or withheld when the owner has not
// released it.
async function commitPart(
  run: GroupRun,
  sent: readonly MomentPassage[],
  ends: readonly ItemEnds[],
  found: Awaited<ReturnType<typeof checkMoments>>,
  withheld: ReturnType<typeof withheldBy>,
): Promise<void> {
  const { deps, checked, outcomes } = run;
  const committed: string[] = [];
  for (const [at, passage] of sent.entries()) {
    const one = ends[at] as ItemEnds;
    if (withheld !== undefined && !passage.member.override) outcomes.push(await one.final(LANE, "withheld", withheld));
    else {
      const outcome = await one.final(LANE, "done", undefined, found.found.get(passage.member.evidenceId));
      outcomes.push(outcome);
      if (outcome.status === "done") committed.push(passage.member.evidenceId);
    }
  }
  // Ids, counts and codes only: the request's call key is its first moment's. Summed over the
  // requests a split made, its one id the first's. Each dropped candidate of a moment committed
  // done, by its shape alone.
  for (const drop of found.drops)
    if (committed.includes(drop.evidence))
      deps.log.info({
        event: "moment_dropped",
        code: drop.code,
        counts: drop.counts,
        ids: { evidence: drop.evidence },
      });
  if (committed.length > 0) {
    const counts: CaptureTally = {
      moments: committed.length,
      candidates: 0,
      kept: 0,
      ...sumTallies(found.tallies, committed),
    };
    checked.counts = sumTallies(
      new Map([
        ["a", checked.counts ?? {}],
        ["b", counts],
      ]),
      ["a", "b"],
    );
    checked.evidence ??= run.lead ?? (sent[0] as MomentPassage).member.evidenceId;
  }
}
