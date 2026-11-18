import type { Timestamp } from "@intelligence/contracts";
import type {
  AskedLane,
  FactKindLane,
  ItemProject,
  MessageLane,
  OpenedCapture,
  OpenedItem,
  OpenedMoment,
  OpenedRecord,
} from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";
import type { Prompt } from "@intelligence/personal-models";
import type { ExtractDeps } from "./config.ts";
import { interpretItem, type readStored, savedCall } from "./interpret.ts";
import {
  baseVersion,
  FACT_KIND_HISTORY,
  FACT_KIND_VERSIONS,
  LANE_VERSIONS,
  MOMENT_PROJECT_VERSIONS,
  SECOND_DEGREE_VERSIONS,
  type SecondDegreeLane,
} from "./lane-versions.ts";
import { type MeetingPlan, planMeeting } from "./meeting-plan.ts";
import { messageData } from "./message.ts";
import { PROMPT_VERSIONS } from "./message-prompts.ts";
import { type MomentMember, type MomentPlan, momentProject, planMoments } from "./moments-plan.ts";
import { messageProject, messageProjectData, withMessageProject } from "./project-named.ts";
import { momentPromptAt, promptAt, promptFor, promptOf } from "./prompts.ts";

// Which version of its lane's prompt an item gets. Every lane, the retry, the trial and the refusal
// report read the order from here. A saved call replays at no cost whatever set the item waiting; a
// switch only ever changes what a new item is asked.

// The versions a lane looks for a saved call of with its fact-kind switch on, after its base, in the
// order it takes one: its second-degree version, then, for correspondence and transaction, every
// fact-kind version oldest first, since a trial saves later ones beside the one an item was done
// under.
const savedAfterBase = (lane: FactKindLane): readonly string[] => [
  ...(lane === "transaction" ? [] : [SECOND_DEGREE_VERSIONS[lane]]),
  ...(lane === "transaction" || lane === "correspondence" ? FACT_KIND_HISTORY[lane] : []),
];

// A lane's versions for a retry that keeps its answers, whether or not the lane is switched on: what
// a run would replay, and an agent record's asked version, which the ask itself finds. Off, only its
// base and second-degree version: it buys nothing new.
export const replayedVersions = (lane: AskedLane, on: boolean): string[] => {
  const base = [PROMPT_VERSIONS[lane], ...(lane === "transaction" ? [] : [SECOND_DEGREE_VERSIONS[lane]])];
  if (!on) return base;
  return lane === "agent" ? [...base, FACT_KIND_VERSIONS.agent] : [...base, ...FACT_KIND_HISTORY[lane]];
};

// The versions an item may have been done under, in the order a replay of its refusals tries them:
// the lane's current one, correspondence's second-degree one, then the rest, newest first. A trial
// saves later ones beside the one the item was done under, and this order never takes those first.
export function doneOrder(lane: MessageLane): string[] {
  const first = [PROMPT_VERSIONS[lane], ...(lane === "correspondence" ? [SECOND_DEGREE_VERSIONS.correspondence] : [])];
  const rest = LANE_VERSIONS[lane].rows.map((one) => one.version).filter((version) => !first.includes(version));
  return [...first, ...rest.reverse()];
}

// The prompt an item of a second-degree lane is asked, by its own saved call, never by moving the
// generation. `base` is the version the lane asks today. With the switch off it is `base`, so
// nothing changes. With it on, an item whose call of `base` is saved (`saved`: an item already
// done, or set waiting by a refile) keeps `base` and replays that call at no cost; only an item
// with no such call, a new one, is asked the second-degree version. A saved call of the
// second-degree version is then found by the ask itself.
export async function secondDegreePrompt(
  lane: SecondDegreeLane,
  base: Prompt,
  on: boolean,
  saved: (prompt: Prompt) => Promise<boolean>,
): Promise<Prompt> {
  if (!on || base.version !== baseVersion(lane)) return base;
  if (await saved(base)) return base;
  return promptOf(base.id, SECOND_DEGREE_VERSIONS[lane]);
}

// The prompt an item is asked, unless a retry chose it a version. With its lane in PI_EXTRACT_FACT_KINDS, a saved call of
// `current` or of what savedAfterBase names replays, the oldest first; only a new item is asked the fact-kind version. Off,
// secondDegreePrompt's.
export async function factKindPrompt(
  lane: FactKindLane,
  current: Prompt,
  switches: { secondDegree: boolean; factKinds: boolean },
  saved: (prompt: Prompt) => Promise<boolean>,
): Promise<Prompt> {
  if (switches.factKinds && current.version === baseVersion(lane)) {
    const kept = [current, ...savedAfterBase(lane).map((version) => promptOf(current.id, version))];
    const held = await Promise.all(kept.map(saved));
    return kept.find((_, index) => held[index]) ?? promptOf(current.id, FACT_KIND_VERSIONS[lane]);
  }
  return lane === "transaction" ? current : secondDegreePrompt(lane, current, switches.secondDegree, saved);
}

// With its lane in PI_EXTRACT_FACT_KINDS and no saved call of either, the fact-kind one.
export async function askedPrompt(
  lane: AskedLane,
  parsed: Parsed,
  sentAt: Timestamp,
  deps: ExtractDeps,
  project: ItemProject | null = null,
): Promise<Prompt> {
  const data = messageData(parsed, sentAt);
  const calls = deps.store.calls(deps.modelId);
  return factKindPrompt(
    lane,
    promptFor(lane),
    { secondDegree: deps.secondDegree === true, factKinds: deps.factKinds?.includes(lane) === true },
    async (prompt) =>
      (await savedCall(prompt, data, parsed, calls)) ||
      (project !== null &&
        (await savedCall(prompt, messageProjectData(prompt, parsed, sentAt, project), parsed, calls))),
  );
}

// A finding filed under a project, with the lane on, is asked the version that can read it even when
// an earlier version's call is saved, so retrying the lane brings in one filed before the switch.
export const askedFinding = (record: OpenedRecord, parsed: Parsed, deps: ExtractDeps): Promise<Prompt> | Prompt =>
  record.item.project !== undefined && deps.factKinds?.includes("agent") === true
    ? promptAt("agent", FACT_KIND_VERSIONS.agent)
    : askedPrompt("agent", parsed, record.item.recordedAt, deps);

// A message's one call: the project code found in it, the version asked, and what the check reads it against. A
// retry's choice (`chosen`, a version) is asked that version, with the lane on, and is held to it. Every other item
// replays what it has at no cost, whatever set it waiting: an anchor or a mention ruling buys nothing, so a project's old
// mail gets its facts from the retry alone. A new item is asked the fact-kind version. A saved call made before the message
// had this project replays as it was made, told of none.
export async function askMessage(
  lane: MessageLane,
  stored: Awaited<ReturnType<typeof readStored>>,
  opened: OpenedItem,
  sentAt: Timestamp,
  deps: ExtractDeps,
  chosen: string | undefined,
) {
  const project = lane === "correspondence" ? messageProject(opened, stored.parsed) : null;
  const on = deps.factKinds?.includes(lane) === true;
  const fixed = on && chosen !== undefined ? promptAt(lane, chosen) : undefined;
  const asked = fixed ?? (await askedPrompt(lane, stored.parsed, sentAt, deps, project));
  const calls = deps.store.calls(deps.modelId);
  const madeBefore =
    fixed === undefined &&
    project !== null &&
    !(await savedCall(asked, messageProjectData(asked, stored.parsed, sentAt, project), stored.parsed, calls)) &&
    (await savedCall(asked, messageData(stored.parsed, sentAt), stored.parsed, calls));
  const told = madeBefore ? null : project;
  const data = messageProjectData(asked, stored.parsed, sentAt, told);
  const { output, inputHash } = await interpretItem(stored.parsed, stored.read, lane, sentAt, deps, asked, data);
  return { output, inputHash, asked, project: told, opened: withMessageProject(opened, told, asked) };
}

export async function askedMeetingPlan(
  plan: MeetingPlan,
  opened: OpenedCapture,
  deps: ExtractDeps,
): Promise<MeetingPlan> {
  const first = plan.groups[0];
  const factKinds = deps.factKinds?.includes("meeting") === true;
  if ((deps.secondDegree !== true && !factKinds) || first === undefined) return plan;
  const chosen = await factKindPrompt(
    "meeting",
    plan.prompt,
    { secondDegree: deps.secondDegree === true, factKinds },
    (prompt) => savedCall(prompt, first.data, plan.parsed, deps.store.calls(deps.modelId)),
  );
  return chosen === plan.prompt ? plan : planMeeting(opened, chosen);
}

// As a meeting's, for a group whose call of the current version is not saved. A group with a project
// among what it sends, with no call of the lane's version saved, is asked the version told of it. A
// group done under that version replays it and asks nothing.
export async function askedMomentPlan(
  part: { opened: OpenedMoment; member: MomentMember }[],
  planned: MomentPlan,
  deps: ExtractDeps,
): Promise<MomentPlan | null> {
  const first = planned.sent[0];
  const factKinds = deps.factKinds?.includes("moment") === true;
  if ((deps.secondDegree !== true && !factKinds) || first === undefined) return planned;
  const calls = deps.store.calls(
    deps.modelId,
    planned.sent.map((passage) => passage.member.evidenceId),
  );
  const chosen = await factKindPrompt(
    "moment",
    planned.prompt,
    { secondDegree: deps.secondDegree === true, factKinds },
    (prompt) => savedCall(prompt, planned.data, first.parsed, calls),
  );
  const plan = chosen === planned.prompt ? planned : planMoments(part, true, chosen);
  if (
    chosen.version === FACT_KIND_VERSIONS.moment &&
    plan?.sent.some((one) => momentProject(one.opened) !== null) === true &&
    !(await savedCall(chosen, plan.data, first.parsed, calls))
  )
    return planMoments(part, true, momentPromptAt(MOMENT_PROJECT_VERSIONS[0] as string));
  return plan;
}
