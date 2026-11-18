import type {
  AgentSettlementView,
  CardRelayView,
  DreamSampleCheck,
  IdeaStatus,
  OwnerIdea,
  OwnerLongWork,
} from "@intelligence/contracts/personal";
import { agentName } from "./agent-words.ts";
import { cardKindRow } from "./card-kinds.ts";
import { cardShape } from "./cards.ts";
import { OPPORTUNITY_STATUS_WORDS } from "./enum-words.ts";
import { sinceWords, whenWords } from "./time-words.ts";
import { capital } from "./words.ts";

// Work's words: an idea filed by an agent or the planner, an answer an agent passed on as the owner's,
// and the owner's mark on what an agent settled.

export const IDEA_STATUS_WORDS: Readonly<Record<IdeaStatus, string>> = {
  open: "Open",
  supported: "A check supported it",
  refuted: "A check went against it",
  asked: "Put to you",
  confirmed: "Confirmed",
  pursued: "You pursued it",
  not_now: "You said not now",
  rejected: "You said no",
  expired: "Lapsed",
  withdrawn: "Withdrawn",
};

// What an idea rests on, by kind, in words.
const EVIDENCE_WORDS: Readonly<Record<string, string>> = {
  message: "A message",
  event: "A meeting",
  entity: "A person or organization",
  goal: "One of your goals",
  hypothesis: "Another idea",
  opportunity: "A piece of work",
  agent_record: "An agent's note",
  owner_request: "Your request, as an agent quoted it",
  decision: "One of your answers",
};
export const evidenceWords = (kind: string): string => EVIDENCE_WORDS[kind] ?? "Something else on file";

// Who filed it: the agent by name, or the planner.
export const filerWords = (idea: Pick<OwnerIdea, "by">): string =>
  idea.by === null ? "the planner" : agentName(idea.by);

// The row's title: the idea's first line (a planner's idea carries its why and test below it).
export const ideaTitle = (idea: Pick<OwnerIdea, "summary">): string =>
  idea.summary === null ? "An idea that cannot be opened here" : (idea.summary.split("\n")[0] ?? "").trim();

export const RELAY_STATE_WORDS: Readonly<Record<CardRelayView["state"], string>> = {
  taken: "Not applied yet",
  applied: "Applied as your answer",
  failed: "Not applied: the question is yours to answer",
  reopened: "Taken back by you",
};

// What a take-back left as it was, as the server names it, in words. The card always comes back;
// these are the effects of the relayed answer that taking it back does not undo.
const LEFT_WORDS: Readonly<Record<string, string>> = {
  lesson_retired:
    "The lesson this answer replaced stays retired: taking the answer back does not bring it back. Restore it yourself if you want it.",
  changed_since:
    "What this answer decided has changed again since, so it was left as it now stands. Check it yourself.",
  effect_kept:
    "What this answer did (a ruling, a project, a reminder or a queued piece of work) stays as it is. Change it yourself if you want it undone.",
};
const LEFT_UNKNOWN = "Part of what this answer did was left as it stands. Check it yourself.";

// What the page says after a take-back: plainly what was done, then each thing it left.
export function takenBackWords(left: readonly string[]): string {
  const base = "The question is in your queue again, unanswered.";
  if (left.length === 0) return `Taken back. ${base}`;
  const each = [...new Set(left.map((code) => LEFT_WORDS[code] ?? LEFT_UNKNOWN))];
  return `Taken back in part. ${base} ${each.join(" ")}`;
}

// Which question a relayed answer was to: the card's own question, as the cards list shows it;
// else what kind of question it was, for a card that is gone or cannot be read here.
export function relayQuestion(relay: Pick<CardRelayView, "question" | "kind">): string {
  const asked = relay.question == null ? "" : cardShape(relay.question).question.trim();
  return asked !== "" ? asked : (cardKindRow(relay.kind)?.title ?? "A question for you");
}

// An option's code as words: `not_now` reads "Not now".
export const optionWords = (option: string): string => capital(option.replaceAll("_", " "));

export function markWords(mark: AgentSettlementView["mark"]): string {
  if (mark === "right") return "You marked it right";
  if (mark === "wrong") return "You marked it wrong";
  return "Not marked yet";
}

// ---------- What dreaming found ----------

// What a finding of each kind says of its claims, the first claim listed first.
const SAYS: Readonly<Record<string, string>> = {
  same_fact: "These say the same fact",
  refines: "The first says the second more precisely",
  supersedes: "The first replaces the second, which no longer holds",
  contradicts: "These cannot both be true",
  prevails: "These disagree, and the first holds now",
  fulfils: "The first says a promise in the second was done",
  same_person: "These are about the same person",
};
export const findingSays = (kind: string): string => SAYS[kind] ?? "A finding of dreaming";

export function dreamMarkWords(one: Pick<DreamSampleCheck, "mark" | "newToMe">): string {
  if (one.mark === null) return "Not marked yet";
  const mark = one.mark === "right" ? "You marked it right" : "You marked it wrong";
  return one.newToMe === true ? `${mark}, and new to you` : mark;
}

// ---------- Work that lasts days ----------

// Its latest progress in one line: what comes next, else the last thing done.
export function progressLine(work: Pick<OwnerLongWork, "progress">): string {
  const { progress } = work;
  if (progress === null) return "No progress reported yet";
  const waiting = progress.waitingOn === null ? "" : ` · Waiting on: ${progress.waitingOn.untrusted}`;
  if (progress.next !== null) return `Next: ${progress.next.untrusted}${waiting}`;
  const last = progress.done.at(-1);
  return last === undefined ? `Reported ${whenWords(progress.at)}${waiting}` : `Done: ${last.untrusted}${waiting}`;
}

// Work its agent stopped renewing and has not picked up again, said as what it means for the
// owner: since when nobody has touched it, and until when it is still that agent's alone.
export function untouchedWords(work: Pick<OwnerLongWork, "lapsedAt" | "theirsUntil">, now: Date = new Date()): string {
  const since = work.lapsedAt === null ? "Not picked up again" : `Not touched since ${whenWords(work.lapsedAt, now)}`;
  const until =
    work.theirsUntil === null
      ? "still theirs to pick up"
      : `still theirs to pick up until ${whenWords(work.theirsUntil, now)}`;
  return `${since}; ${until}`;
}

// How its holder has it: held to a date, left untouched and still its alone, or held since a time.
function holdWords(work: OwnerLongWork, now: Date = new Date()): string | null {
  if (work.parkedUntil !== null) return `Held until ${whenWords(work.parkedUntil, now)}`;
  if (work.holder !== null && work.lapsed) return untouchedWords(work, now);
  return work.holder !== null && work.since !== null ? sinceWords(work.since, now) : null;
}

// Where it stands, as a row's meta: how it is held, else its state.
export const standingWords = (work: OwnerLongWork, now: Date = new Date()): string =>
  holdWords(work, now) ?? OPPORTUNITY_STATUS_WORDS[work.status];

// The work by agent: what each holds or parked, an agent's name heading its rows. Work neither
// held nor parked by a registered agent is its own group last, so none of it drops from view.
export function byAgent(work: readonly OwnerLongWork[]): { agent: string | null; rows: OwnerLongWork[] }[] {
  const groups = new Map<string | null, OwnerLongWork[]>();
  for (const one of work) {
    const agent = one.holder ?? one.parkedBy;
    groups.set(agent, [...(groups.get(agent) ?? []), one]);
  }
  return [...groups]
    .map(([agent, rows]) => ({ agent, rows }))
    .sort((a, b) => (a.agent === null ? 1 : b.agent === null ? -1 : a.agent < b.agent ? -1 : 1));
}
