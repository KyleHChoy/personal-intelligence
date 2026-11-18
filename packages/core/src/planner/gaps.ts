import type { GapTrigger } from "@intelligence/contracts/personal";
import { byText } from "../compare.ts";

// Gap flags: which gaps in what the system knows become research opportunities,
// which open flags close, and how many wait. Pure: the store reads the candidates (gaps that hold
// now, each under one label) and the flags already raised, the tick calls this, and the store
// writes what it says. No model, no clock, no database.

// Provisional, the owner's to tune. A meeting this many days ahead or fewer; an attendee the
// system knows little about has fewer than GAP_FEW_FACTS claims naming them and fewer than
// GAP_LOW_TIE messages both ways and meetings before, under the flag's label.
export const GAP_MEETING_DAYS = 3;
export const GAP_FEW_FACTS = 3;
export const GAP_LOW_TIE = 3;
// A logged threshold, not a silent cut: past it a tick raises no more under one label, logs how
// many wait, and the next tick raises them. Nothing is dropped. Per label, so one label's backlog
// never delays another's flags (invariant 6: nothing a viewer cannot see changes their timing).
export const GAP_FLAGS_PER_TICK = 20;
// A flag that was done, or closed by anyone but code with no `no_go` (a withdrawal), is not raised
// again for the same subject and label for this many days. One code withdrew because its gap filled,
// closed `no_go`, that expired with no agent ever claiming it, or undated work that ended with no
// result (a failed report, an expiry after a claim) rests for GAP_WITHDRAWN_REST_DAYS instead. One declined (a `no_go` that is the owner's: a no on its card, `pia work cancel`, or a veto's
// close) is declined for good, not for these days: never raised again by code from the same source;
// from a new source it comes back to the owner as a card (invariant 11). The database adds the
// owner's no on the same work under any trigger, or an agent's investigate.
export const GAP_QUIET_DAYS = 30;
// A flag code withdrew because its gap filled, or closed `no_go` at rung 0, rests this long before the
// same key may be raised again, unless it is dated. Without it a candidate that flickers (a close
// person rotating in and out of a capped list, a state that flips) is withdrawn and raised again with
// no bound, each time a new row. Code's no_go says nothing about the gap, so it must not bar the gap
// as the owner's does. Nor does an unclaimed task's expiry: nobody read it, so it says nothing about
// the gap, and thirty days of quiet would leave the board empty after any stretch with no agent. Nor
// does work that ended with no result, a limit or an outage as readily as nothing to find. The day's
// cap, the tasks' own room still bounds what comes back. A dated gap is exempt: a meeting moved out of its window
// and back needs its task, and its window bounds it. Provisional.
export const GAP_WITHDRAWN_REST_DAYS = 7;
// A defect an agent filed that stood open this long with no status set raises a triage task.
export const DEFECT_UNTRIAGED_HOURS = 48;
// Raising is capped by what finishes. Per label, as the per-tick cap is, so a hidden label's numbers
// never change another's timing (invariant 6). A label's tasks the cap covers, raised by code in one
// UTC day, stay under GAP_RAISE_FLOOR_PER_DAY plus its daily throughput: the mean of its claims and
// its completions over GAP_RAISE_WINDOW_DAYS. The floor keeps a board with no agent working it offering
// something, and means raising resumes by itself each day. Provisional, the owner's to tune.
export const GAP_RAISE_WINDOW_DAYS = 7;
export const GAP_RAISE_FLOOR_PER_DAY = 5;
// What each trigger is, so a new one answers every question here at once. `uncapped`: what the cap
// does not cover, and what the day's count leaves out. A gap with a date: a day's room spent at
// midnight must not make a meeting booked that afternoon wait for the next. A reply owed: it has no
// date but ages out of its window. An explore node: its own day's budget bounds it. A same-person
// batch: it spends nothing of the box, and holding it back only leaves pairs on the owner.
// `cappedDated`: a dated gap the cap covers all the same: what it raises is read from an event's shape
// alone, so it may be noise, and a meeting's reason for standing outside the cap does not hold for it.
// `goalless`: it raises a flag with no active goal behind it. A goal's missing path always has its
// goal; a close person's missing role is the owner's own confirmation of closeness. A meeting soon, a
// commitment falling due and mail owed a reply need none: each is the owner's own day. Nor a close
// person with no tie, whose closeness is the reason. Nor a frontier node, whose value is the reason.
// `bySubject`: a gap's identity. A close person's and a frontier node's are read from the person, with
// no source row to give a flag its gap's label back when the owner's no under another label widened
// it, so they key by subject alone: a close person's subject names its label, and a frontier node has
// one. `forItsDay`: what finished work keeps quiet. A meeting's brief is for its day, so work done for
// one day does not hold a meeting moved to another, and a move within the day pays for nothing new.
// Only gapQuietKey reads the date: an open flag, a hand-off and the owner's no are about the meeting,
// whatever its time. `defect`, `defect_untriaged`: a failing measure must not wait for the day's room
// behind research, so neither is capped. A defect has one label and its subject names it, a system
// defect's with the count of its openings, so each opening is a gap of its own and the quiet days of
// an earlier one never hold a reopened defect's task back.
type GapRule = { uncapped: boolean; cappedDated: boolean; goalless: boolean; bySubject: boolean; forItsDay: boolean };
const GAP_RULES: Readonly<Record<GapTrigger, GapRule>> = Object.freeze({
  unresolved_mention: { uncapped: false, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
  no_warm_path: { uncapped: false, cappedDated: false, goalless: false, bySubject: false, forItsDay: false },
  unknown_attendee: { uncapped: false, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
  close_no_role: { uncapped: false, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  meeting_soon: { uncapped: false, cappedDated: false, goalless: true, bySubject: false, forItsDay: true },
  commitment_due: { uncapped: false, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
  reply_owed: { uncapped: true, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
  close_no_tie: { uncapped: false, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  intro_path: { uncapped: false, cappedDated: false, goalless: false, bySubject: false, forItsDay: false },
  explore: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  deadline_soon: { uncapped: false, cappedDated: true, goalless: true, bySubject: false, forItsDay: true },
  same_person: { uncapped: true, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
  defect: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  defect_untriaged: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  card_question: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  merge_audit: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  card_relay: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  owner_queue: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  // A conflict the dream pass found and code could not settle; one task a
  // finding, whose subject is its id and whose label is the finding's.
  dream_finding: { uncapped: true, cappedDated: false, goalless: true, bySubject: true, forItsDay: false },
  // A goal's review serves its goal; a meeting's follow-up is the owner's own day, and is undated.
  goal_review: { uncapped: false, cappedDated: false, goalless: false, bySubject: false, forItsDay: false },
  meeting_followup: { uncapped: false, cappedDated: false, goalless: true, bySubject: false, forItsDay: false },
});
const triggersWhere = (rule: keyof GapRule): readonly GapTrigger[] =>
  Object.freeze((Object.keys(GAP_RULES) as GapTrigger[]).filter((trigger) => GAP_RULES[trigger][rule]));
export const GAP_UNCAPPED_TRIGGERS = triggersWhere("uncapped");
export const GAP_CAPPED_DATED_TRIGGERS = triggersWhere("cappedDated");
// The three triggers whose gaps rest on warmth, which is ranked at read with the keys: the pipeline
// raises and closes their flags after each day build, and the work tick, which holds no key, leaves
// them alone.
export const WARMTH_GAP_TRIGGERS: readonly GapTrigger[] = Object.freeze(["close_no_tie", "close_no_role", "explore"]);
const GOALLESS_TRIGGERS = triggersWhere("goalless");

// One gap that holds now: what raised it, who or what it is about (a name's fingerprint, an
// entity), the key of its label, the goal it serves or none, the row it was found in (a message, an
// event, a goal), when (an item's time, a goal's), and an attendee's meeting time and counts.
// `hold`: a gap that holds (an open flag on it stays open) but is not to be raised now: an explore
// node outside the day's budget (frontier.ts, planExplore). An explore gap is raised only with
// `hold` false, as planExplore chose it.
export type GapCandidate = {
  trigger: GapTrigger;
  subject: string;
  labelKey: string;
  goal: string | null;
  source: string;
  at: string;
  due?: string | null;
  facts?: number;
  ties?: number;
  hold?: boolean;
};
// A flag open now. `held`: an agent holds a live lease on it, so code leaves it to that agent.
// `goDue`: when it is a task still waiting for an agent, its date, which a meeting's move outdates.
export type OpenGapFlag = {
  id: string;
  trigger: GapTrigger;
  subject: string;
  labelKey: string;
  held: boolean;
  goDue?: string | null;
};
// What earlier flags say about raising a gap again: the keys in their quiet days, and for each key
// the owner declined, the sources they declined it from.
export type GapHistory = { quiet: ReadonlySet<string>; declined: ReadonlyMap<string, ReadonlySet<string>> };
// `card`: a gap the owner declined, from a new source: proposed for their decision, never decided by code.
// `limited`: the day's cap covers it, so the caller stops raising these once the label's room is gone,
// counting only what the store did raise. `capped`: held back because the label had no room at all.
// `left`: the gaps `deferred` and `capped` count.
export type GapPlan<C extends GapCandidate> = {
  raise: { gap: C; card: boolean; limited: boolean }[];
  close: string[];
  deferred: number;
  capped: number;
  left: { gap: C; why: "capped" | "deferred" }[];
};

// One label's numbers for the cap: tasks the cap covers that code raised today, and over the window
// the claims and completions of its tasks.
// `used`: its tasks that code or the owner showed were used, over the window. `triggers`: each trigger's
// standing and what it raised today, the cap covers those alone.
export type GapStanding = { scored: number; used: number; kept: number; dropped: number };
export type GapSupply = {
  raisedToday: number;
  claimed: number;
  done: number;
  used?: number;
  triggers?: Readonly<Partial<Record<GapTrigger, GapStanding & { raisedToday: number }>>>;
};
export const NO_SUPPLY: GapSupply = Object.freeze({ raisedToday: 0, claimed: 0, done: 0 });

// The window a trigger's standing is read over, and what a standing needs before it says anything:
// under these a trigger is untried, and keeps its room. Provisional, the owner's to tune.
export const GAP_VALUE_WINDOW_DAYS = 30;
export const GAP_VALUE_MIN_SCORED = 5;
export const GAP_VALUE_MIN_JUDGED = 3;

// What a trigger's work was worth, from 0 to 1. Once the owner judged enough of it their answers
// decide alone, since what they said outranks anything inferred; else the share code showed was used;
// else 1, since low counts mean untried.
export function gapWeight({ scored, used, kept, dropped }: GapStanding): number {
  if (kept + dropped >= GAP_VALUE_MIN_JUDGED) return kept / (kept + dropped);
  return scored >= GAP_VALUE_MIN_SCORED ? used / scored : 1;
}

// Room follows what was used, not what finished: the floor, plus the label's used tasks a day.
export const gapRaiseCap = ({ used }: Pick<GapSupply, "used">): number =>
  GAP_RAISE_FLOOR_PER_DAY + Math.ceil((used ?? 0) / GAP_VALUE_WINDOW_DAYS);

// How many more of one trigger the cap lets a label raise today: its share of the label's cap by its
// weight, at least one a day so a trigger can earn its way back. Nothing is cut, and it never exceeds
// the label's own room.
export function gapTriggerRoom(numbers: GapSupply, trigger: GapTrigger): number {
  const standing = numbers.triggers?.[trigger];
  if (standing === undefined) return gapRoom(numbers);
  const share = Math.max(1, Math.ceil(gapRaiseCap(numbers) * gapWeight(standing)));
  return Math.min(gapRoom(numbers), Math.max(0, share - standing.raisedToday));
}

// How many more the cap lets a label raise today.
export function gapRoom(numbers: GapSupply): number {
  return Math.max(0, gapRaiseCap(numbers) - numbers.raisedToday);
}
const gapCapped = (gap: Pick<GapCandidate, "trigger" | "due">): boolean =>
  GAP_CAPPED_DATED_TRIGGERS.includes(gap.trigger) ||
  ((gap.due ?? null) === null && !GAP_UNCAPPED_TRIGGERS.includes(gap.trigger));

export const gapKey = (one: { trigger: GapTrigger; subject: string; labelKey: string }): string =>
  GAP_RULES[one.trigger].bySubject
    ? `${one.trigger}\n${one.subject}`
    : `${one.trigger}\n${one.subject}\n${one.labelKey}`;

const dayOf = (due: string | null | undefined): string => (due ?? "").slice(0, 10);
export const gapQuietKey = (one: {
  trigger: GapTrigger;
  subject: string;
  labelKey: string;
  due?: string | null;
}): string => (GAP_RULES[one.trigger].forItsDay ? `${gapKey(one)}\n${dayOf(one.due)}` : gapKey(one));

// Whether a gap is one to raise: an attendee only when little is known of them, an introduction
// path only through an introducer, and a gap with no goal only for the goal-less triggers.
export function gapQualifies(candidate: GapCandidate): boolean {
  if (candidate.goal === null && !GOALLESS_TRIGGERS.includes(candidate.trigger)) return false;
  if (candidate.trigger === "unknown_attendee")
    return (candidate.facts ?? 0) < GAP_FEW_FACTS && (candidate.ties ?? 0) < GAP_LOW_TIE;
  if (candidate.trigger === "intro_path") return (candidate.facts ?? 0) >= 1;
  return true;
}

// Why a gap that holds is not raised now, or null when nothing here stops it: `pi-work work gaps`
// reports this and planGapFlags raises by it, so the report cannot drift from the plan. An explore
// node is raised only as planExplore chose it (`hold` false), and its rest is planExplore's: its
// value may bring it back early.
export type GapHold = "unqualified" | "open" | "quiet" | "declined" | "not_chosen";
export function gapHold(gap: GapCandidate, open: ReadonlySet<string>, history: GapHistory): GapHold | null {
  const key = gapKey(gap);
  if (!gapQualifies(gap)) return "unqualified";
  if (open.has(key)) return "open";
  if (gap.trigger !== "explore" && history.quiet.has(gapQuietKey(gap))) return "quiet";
  if (history.declined.get(key)?.has(gap.source) === true) return "declined";
  if (gap.trigger === "explore" ? gap.hold !== false : gap.hold === true) return "not_chosen";
  return null;
}

// Most urgent first: a gap with a meeting by its time, so it is raised before the meeting; then
// one with a goal; then by time, then by key.
function byUrgency<C extends GapCandidate>([ka, a]: [string, C], [kb, b]: [string, C]): number {
  const dueA = a.due ?? null;
  const dueB = b.due ?? null;
  if (dueA !== dueB) return dueA === null ? 1 : dueB === null ? -1 : byText(dueA, dueB);
  return Number(a.goal === null) - Number(b.goal === null) || byText(a.at, b.at) || byText(ka, kb);
}

// One flag per gap (gapKey): a gap with one open is not raised again, nor one in
// its quiet days, nor one the owner declined from the same source; one they declined from another
// source is raised as a card. An open flag whose gap no longer holds closes, unless an agent holds
// it. Most urgent first, at most `cap` a label, the rest deferred. Given `supply`, what the day's cap
// covers comes after what it does not, and is left out when its label has no room, before the cut,
// so what the cap holds never stands in front of a card or a reply.
export function planGapFlags<C extends GapCandidate>(input: {
  candidates: readonly C[];
  open: readonly OpenGapFlag[];
  history: GapHistory;
  cap?: number;
  supply?: ReadonlyMap<string, GapSupply>;
}): GapPlan<C> {
  const holding = new Map<string, C>();
  for (const candidate of input.candidates) {
    const key = gapKey(candidate);
    if (gapQualifies(candidate) && !holding.has(key)) holding.set(key, candidate);
  }
  // A task nobody holds, for a meeting since moved to another day, closes so one for the new day can
  // be raised. Anything further along stays: an agent's work, or a hand-off the owner has.
  const closing = input.open.filter((flag) => {
    if (flag.held) return false;
    const gap = holding.get(gapKey(flag));
    if (gap === undefined) return true;
    return GAP_RULES[flag.trigger].forItsDay && flag.goDue !== undefined && dayOf(flag.goDue) !== dayOf(gap.due);
  });
  const open = new Set(input.open.filter((flag) => !closing.includes(flag)).map(gapKey));
  const close = closing.map((flag) => flag.id);
  const due = [...holding.entries()].filter(([, gap]) => gapHold(gap, open, input.history) === null).sort(byUrgency);
  const cap = input.cap ?? GAP_FLAGS_PER_TICK;
  const { supply } = input;
  const limitedOf = ([key, gap]: [string, C]): boolean =>
    supply !== undefined && !input.history.declined.has(key) && gapCapped(gap);
  const order = supply === undefined ? due : [...due.filter((one) => !limitedOf(one)), ...due.filter(limitedOf)];
  const taken = new Map<string, number>();
  const raise: { gap: C; card: boolean; limited: boolean }[] = [];
  const left: GapPlan<C>["left"] = [];
  for (const one of order) {
    const [key, gap] = one;
    const limited = limitedOf(one);
    if (limited && gapRoom(supply?.get(gap.labelKey) ?? NO_SUPPLY) === 0) {
      left.push({ gap, why: "capped" });
      continue;
    }
    const count = taken.get(gap.labelKey) ?? 0;
    if (count >= cap) {
      left.push({ gap, why: "deferred" });
      continue;
    }
    taken.set(gap.labelKey, count + 1);
    raise.push({ gap, card: input.history.declined.has(key), limited });
  }
  return {
    raise,
    close: close.sort(),
    deferred: left.filter(({ why }) => why === "deferred").length,
    capped: left.filter(({ why }) => why === "capped").length,
    left,
  };
}
