import { ClaimId, type LocalEntityId } from "@intelligence/contracts";
import {
  type CaptureMention,
  type ClaimRecord,
  type DueCapture,
  type FiledMention,
  MENTION_FIELD,
  type MeetingCaptureFacts,
  type OpenedCapture,
} from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { logActivity, metClaims, metPeople } from "./activity.ts";
import { askedMeetingPlan } from "./asked-version.ts";
import { sha256 } from "./call-failure.ts";
import { codeClaim } from "./code-claim.ts";
import type { ExtractDeps } from "./config.ts";
import {
  type ExtractOutcome,
  failedCall,
  failedPlan,
  itemEnds,
  noPromptHere,
  opening,
  StepFailed,
  step,
} from "./item-ends.ts";
import { itemLink, logLinked } from "./link.ts";
import { askMeeting, checkMeeting, meetingShape } from "./meeting-check.ts";
import { meetingIdentity, type Who } from "./meeting-identity.ts";
import { type MeetingPlan, planMeeting } from "./meeting-plan.ts";
import { triageMeeting } from "./triage.ts";
import { meetingPassages } from "./turns.ts";

// The meeting lane: a due meeting opened, its participants made by code, triaged by rules, sent in
// groups of passages, each one call under the extraction port, budgets and replay, checked and
// attributed by code; then one commit for the meeting. Nothing a transcript, a title or a speaker's
// name says changes a lane, a request count or a check.

const PARTICIPANT_TYPE = "capture.person";
const PARTICIPANT_PIPELINE = "lens-participants-1";

// The owner, a mention resolving to nobody or to two, and a name alone (filed) make none.
async function meetingParticipants(
  facts: MeetingCaptureFacts,
  resolve: {
    speakerWho(label: string): Promise<Who>;
    mentionWho(mention: CaptureMention | null | undefined): Promise<Who>;
  },
  owner: LocalEntityId,
): Promise<{
  people: { entity: LocalEntityId; role: "speaker" | "organizer" | "attendee" }[];
  names: string[];
  unresolved: number;
}> {
  const people: { entity: LocalEntityId; role: "speaker" | "organizer" | "attendee" }[] = [];
  const names: string[] = [];
  let unresolved = 0;
  const take = (who: Who, role: "speaker" | "organizer" | "attendee"): void => {
    if (who === null) {
      unresolved += 1;
      return;
    }
    if ("name" in who) {
      unresolved += 1;
      if (!names.includes(who.name)) names.push(who.name);
      return;
    }
    if (who.entity === owner || people.some((one) => one.entity === who.entity)) return;
    people.push({ entity: who.entity, role });
  };
  for (const speaker of facts.speakers) {
    if (speaker.owner) continue;
    take(await resolve.speakerWho(speaker.label), "speaker");
  }
  if (facts.calendar !== null) {
    if (facts.calendar.organizer !== null) take(await resolve.mentionWho(facts.calendar.organizer), "organizer");
    for (const attendee of facts.calendar.attendees) take(await resolve.mentionWho(attendee), "attendee");
  }
  for (const attendee of facts.attendees ?? []) take(await resolve.mentionWho(attendee), "attendee");
  return { people, names, unresolved };
}

// It builds no belief.
function participantClaims(
  opened: OpenedCapture,
  people: { entity: LocalEntityId; role: "speaker" | "organizer" | "attendee" }[],
  generation: number,
): ClaimRecord[] {
  const { context, capture } = opened;
  return people.map(({ entity, role }) => {
    const span = "capture:participants";
    const content = { type: PARTICIPANT_TYPE, subject: entity, fields: { role } };
    const claim = codeClaim({
      id: ClaimId.parse(
        sha256(
          JSON.stringify([context.evidenceId, context.revision, span, PARTICIPANT_TYPE, entity, role, generation]),
        ),
      ),
      content,
      basis: "third_party",
      validFrom: capture.startedAt,
      evidenceId: context.evidenceId,
      span,
      label: { compartments: [...context.compartments], readers: [THE_OWNER] },
      pipelineVersion: PARTICIPANT_PIPELINE,
      generation,
    });
    return {
      claim,
      subjectKind: "person",
      disclosure: ["third_party"],
      factKey: sha256(`${PARTICIPANT_TYPE}\n${entity}\n${capture.key}`),
      lane: "meeting",
      fieldKinds: { role: "enum" },
      entities: [entity],
      origin: "source",
      answersSystem: false,
    };
  });
}

// The pipeline for one stored meeting, from its screen to its commit. The participants are made
// first, by code, and committed with the meeting however it ends here: skipped by the owner's lane,
// too_short, not_extracted with the lane off, withheld or done.
export async function processMeeting(due: DueCapture, deps: ExtractDeps): Promise<ExtractOutcome> {
  const { evidenceId } = due;
  const base = itemEnds(evidenceId, deps);
  const { defer, generation } = base;

  const opened = await opening(() => deps.store.openCapture(evidenceId));
  if (opened === null) return { status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false };
  const capture = opened.capture.id;

  const identity = meetingIdentity(opened);
  let participants: Awaited<ReturnType<typeof meetingParticipants>>;
  let met: ClaimRecord[];
  try {
    participants = await meetingParticipants(opened.capture.facts, identity, opened.context.ownerEntity);
    met = metClaims(
      opened,
      await metPeople(opened.capture.facts, identity.mentionWho, opened.context.ownerEntity),
      generation,
    );
  } catch {
    return defer("meeting", "check_failed", true);
  }
  const people = [...participantClaims(opened, participants.people, generation), ...met];
  const filed: FiledMention[] = participants.names.map((name) => ({
    name: name.slice(0, 200),
    type: "capture.person",
    field: MENTION_FIELD,
  }));
  const linked = await step(() =>
    itemLink(deps, evidenceId, opened.context.revision, generation, {
      title: opened.capture.facts.title,
      calendarTitle: opened.capture.facts.calendar?.title ?? null,
    }),
  );
  if (linked instanceof StepFailed) return defer("meeting", "check_failed", true);
  if (linked === null) return { status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false };
  const link = linked;
  // Every final status of the meeting carries its participants and its link, and logs them once
  // committed.
  const final: typeof base.final = async (
    lane,
    status,
    code,
    found = { claims: [], unmapped: [], unresolved: 0 },
    more,
  ) => {
    const outcome = await base.final(
      lane,
      status,
      code,
      {
        ...found,
        claims: [...people, ...link.claims, ...found.claims],
        mentions: [...filed, ...(found.mentions ?? [])].slice(0, 200),
      },
      more,
    );
    if (outcome.status === status) {
      deps.log.info({
        event: "participants_linked",
        counts: { made: people.length - met.length, unresolved: participants.unresolved },
        ids: { evidence: evidenceId, capture },
      });
      logLinked(deps, link, evidenceId, capture);
      if (met.length > 0) logActivity(deps, met, evidenceId);
    }
    return outcome;
  };
  const ends = { ...base, final };

  const lane = "meeting";
  if (deps.meetings !== true) return final(lane, "skipped", "not_extracted");
  const { text, passages } = meetingPassages(opened.item);
  const triaged = triageMeeting(text, due.lane);
  if (triaged.lane === "skip") return final("skip", "skipped", triaged.code);
  // A message's or a document's lane, given a meeting by hand, has no prompt for one.
  if (triaged.lane !== "meeting") return noPromptHere(ends);

  let plan: MeetingPlan;
  try {
    plan = planMeeting(opened);
    plan = await askedMeetingPlan(plan, opened, deps);
  } catch (error) {
    return failedPlan(error, lane, ends, "commit_failed");
  }
  const counts = { groups: plan.groups.length, leftOut: plan.leftOut };
  if (plan.groups.length === 0)
    return final(lane, "skipped", passages.length === 0 ? "no_text" : "too_long", undefined, counts);

  const asked = await step(() =>
    askMeeting(plan, { model: ends.model, calls: deps.store.calls(deps.modelId) }, due.override),
  );
  if (asked instanceof StepFailed) return failedCall(asked.error, lane, ends);
  if ("withheld" in asked) return final(lane, "withheld", asked.withheld, undefined, counts);

  const found = await step(() =>
    checkMeeting(asked.answers, plan, opened, due, generation, identity, undefined, (key) =>
      deps.store.keyFingerprint(key),
    ),
  );
  if (found instanceof StepFailed) return defer(lane, "check_failed", true);
  // The tally is the log's alone: the commit's shape is strict and holds no tally.
  const { tally, windows, inferred, ...checked } = found;
  const outcome = await final(lane, "done", undefined, checked, counts);
  if (outcome.status === "done")
    deps.log.info({
      event: "meeting_checked",
      counts: { candidates: 0, kept: 0, ...tally, ...meetingShape(plan, { windows, inferred }) },
      ids: { evidence: evidenceId, capture },
    });
  return outcome;
}
