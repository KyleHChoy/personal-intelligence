import type { LedgerEvent, LedgerFeed, LedgerSpan } from "@intelligence/contracts/personal";
import { authorParts, isClientAuthor, RunId } from "@intelligence/contracts/personal";
import { agentName, ledgerEventWords } from "../agent-words.ts";
import { answerWords } from "../card-words.ts";
import { STAGE_WORDS } from "../enum-words.ts";
import { isOf } from "../id-kinds.ts";
import { clockOf } from "../time-words.ts";
import { capital, wordsOf } from "../words.ts";
import { plural } from "./system-parts.tsx";

// The Ledger's model: how its events become pieces of work, each with its steps, its words and where
// it stands, so "What happened" reads as what was done, never as a list of event kinds.

// Who took a step, by plain name: an agent by its own name, the system's jobs by what they do.
const WORKERS: Record<string, string> = {
  pipeline: "Reading mail",
  identity: "Matching people",
  reasoner: "The planner",
  work: "The planner",
  owner: "You",
};
export const whoOf = (by: string | null): string => {
  if (by === null) return "The system";
  const parts = authorParts(by);
  if (parts.kind === "client") return agentName(parts.rest);
  if (parts.kind === "run") return "The planner";
  if (parts.kind === "system") return WORKERS[parts.rest] ?? "The system";
  return WORKERS[by] ?? "The system";
};
const PIPELINE = "system:pipeline";
// The steps that belong to no piece of work, titled by what was done.
const RUN_TITLE = "The planner looked over your work";
const OTHER_TITLES: Readonly<Record<string, string>> = {
  reasoner: RUN_TITLE,
  owner: "Your decisions",
  [PIPELINE]: "Read your new mail and messages",
  "system:identity": "Checked whether new contacts are people you know",
};
const midSentence = (words: string): string => (words.startsWith("The ") ? `the ${words.slice(4)}` : words);

// How a report ended, as a step and as the row's state.
const ENDED_WORDS: Readonly<Record<string, { step: string; state: string }>> = {
  done: { step: "Reported back: done", state: "Done" },
  failed: { step: "Reported back: found nothing worth keeping", state: "Found nothing" },
  blocked: { step: "Reported back: stuck, it could not go on", state: "Stuck" },
};
const endedWords = (code: string | null): { step: string; state: string } =>
  (code === null ? ENDED_WORDS.done : ENDED_WORDS[code]) ?? {
    step: `Reported back: ${wordsOf(code ?? "").toLowerCase()}`,
    state: wordsOf(code ?? ""),
  };
const isOutcome = (event: LedgerEvent): boolean => event.row.kind === "move" && Object.hasOwn(ENDED_WORDS, event.event);
function backOnBoard(event: LedgerEvent): string {
  if (event.code === "lease_expired") return "Its hold ran out, so it went back on the board";
  if (event.code === "blocked") return "Back on the board for another agent";
  if (event.by === "owner") return "You said go ahead";
  if (isClientAuthor(event.by)) return "Gave it back for another agent";
  return "Back on the board for any agent";
}

// A step in words, never an event and its code: "Started: research", "Reported back: done",
// "You answered yes: <what the card asked>".
export function stepOf(event: LedgerEvent, cards: ReadonlyMap<string, string> = new Map()): string {
  if (event.row.kind === "run") {
    if (event.event === "done" || event.event === "completed") return "The planner finished";
    if (event.event === "failed") return "The planner stopped with an error";
  }
  if (event.event === "planned")
    return event.code !== null && Object.hasOwn(STAGE_WORDS, event.code)
      ? `Started: ${STAGE_WORDS[event.code as keyof typeof STAGE_WORDS].toLowerCase()}`
      : "Started";
  if (isOutcome(event)) return endedWords(event.event).step;
  if (event.event === "reported" || event.event === "completed") return endedWords(event.code).step;
  if (event.row.kind === "opportunity") {
    if (event.event === "go") return backOnBoard(event);
    if (event.event === "done") return "Closed: the work is done";
    if (event.event === "withdrawn" && event.code === "failed") return "Closed: nothing worth keeping was found";
  }
  const said = ledgerEventWords(event.event);
  const card = event.row.kind === "card" ? cards.get(event.row.id) : undefined;
  if (event.event === "decided") {
    const answer = event.code === null ? null : answerWords(event.code);
    if (card === undefined) return answer === null ? said : `${said}: ${answer}`;
    return `${answer === null ? "You answered" : `You answered ${answer}`}: ${card}`;
  }
  return card === undefined ? said : `${said}: ${card}`;
}

// A piece of work's steps in the order they happened, each report once: a report's text is written
// as a second event just after its outcome, which says nothing more.
export const storySteps = (events: readonly LedgerEvent[]): LedgerEvent[] => {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const reported = new Set(ordered.filter(isOutcome).map((event) => event.row.id));
  return ordered.filter(
    (event) => !(event.event === "reported" && event.row.kind === "move" && reported.has(event.row.id)),
  );
};

// `syncs`: the pipeline's, on its own row: a sync writes no ledger event, only its span.
export type Thread = {
  key: string;
  work: string | null;
  title: string;
  under: string;
  author: string | null;
  events: LedgerEvent[];
  syncs: readonly LedgerSpan[];
};

// The feed's events grouped by their piece of work, newest piece first; an event with none is the
// owner's decision or the system's, grouped by who took it. A piece of work is named by what it is.
export function threadsOf(
  events: readonly LedgerEvent[],
  names: ReadonlyMap<string, string>,
  syncs: readonly LedgerSpan[] = [],
): Thread[] {
  const threads = new Map<string, Thread>();
  for (const event of [...events].sort((a, b) => b.id - a.id)) {
    const key = event.work ?? event.by ?? "other";
    let thread = threads.get(key);
    if (thread === undefined) {
      thread = { key, work: event.work, title: "", under: "", author: null, events: [], syncs: [] };
      threads.set(key, thread);
    }
    thread.events.push(event);
  }
  for (const thread of threads.values()) {
    const first = thread.events.at(-1);
    const steps = `${plural(storySteps(thread.events).length, "step")}${first === undefined ? "" : ` since ${clockOf(new Date(first.at))}`}`;
    // A piece of work's author is its first who is not the owner: what the owner said on it is a step.
    const author =
      thread.work === null ? thread.key : (thread.events.findLast((event) => event.by !== "owner")?.by ?? null);
    thread.author = author;
    if (thread.work === null) {
      thread.title = OTHER_TITLES[thread.key] ?? `Other steps by ${midSentence(whoOf(thread.key))}`;
      thread.under = thread.key === "owner" ? "On this page and in the terminal" : steps;
      continue;
    }
    const who = author === null ? null : whoOf(author);
    const named = names.get(thread.work);
    thread.title = isOf(RunId, thread.work)
      ? RUN_TITLE
      : named === undefined
        ? `Work by ${who === null ? "an agent" : who.replace(/^The /, "the ")}`
        : capital(named);
    thread.under = [who, steps].filter((part) => part !== null).join(". ");
  }
  const list = [...threads.values()];
  if (syncs.length === 0) return list;
  // The day's syncs, on the pipeline's own row, placed by its latest read.
  const first = [...syncs].sort((a, b) => a.from.localeCompare(b.from))[0];
  const held = threads.get(PIPELINE);
  const thread = held ?? {
    key: PIPELINE,
    work: null,
    title: OTHER_TITLES[PIPELINE] ?? "",
    under: "",
    author: PIPELINE,
    events: [],
    syncs: [],
  };
  thread.syncs = syncs;
  const ran =
    first === undefined
      ? ""
      : syncs.length === 1
        ? `read once, at ${clockOf(new Date(first.from))}`
        : `read ${syncs.length} times since ${clockOf(new Date(first.from))}`;
  thread.under = held === undefined ? `From your accounts. ${capital(ran)}` : `${held.under}. ${capital(ran)}`;
  if (held !== undefined) return list;
  const last = latestOf(thread);
  const place = list.findIndex((one) => latestOf(one) < last);
  list.splice(place === -1 ? list.length : place, 0, thread);
  return list;
}

// When a piece of work last moved: its newest step, or its newest sync.
export const latestOf = (thread: Pick<Thread, "events" | "syncs">): string =>
  [...thread.events.map((event) => event.at), ...thread.syncs.map((sync) => sync.to ?? sync.from)].reduce(
    (most, at) => (at > most ? at : most),
    "",
  );

// Where a piece of work stands, the row's meta: done, stuck, waiting for the owner, working.
const ENDED: ReadonlySet<string> = new Set(["reported", "completed"]);
const WAITING_ON_HIM: ReadonlySet<string> = new Set([
  "pending",
  "deferred",
  "proposed",
  "later",
  "handed_to_owner",
  "asked",
]);
const CLOSED: ReadonlySet<string> = new Set([
  "done",
  "expired",
  "withdrawn",
  "no_go",
  "outcome_met",
  "outcome_not_met",
  "failed",
]);
export function stateOf(thread: Thread): { words: string; wrong: boolean } {
  const lastSync = [...thread.syncs].sort((a, b) => a.from.localeCompare(b.from)).at(-1);
  if (lastSync !== undefined && thread.events.length === 0)
    return lastSync.code === undefined || lastSync.code === "ok"
      ? { words: "done", wrong: false }
      : { words: "stopped", wrong: true };
  const latest = storySteps(thread.events).at(-1);
  if (latest === undefined) return { words: "", wrong: false };
  if (thread.work === null && thread.key === "owner")
    return { words: plural(thread.events.length, "decision"), wrong: false };
  const cards = new Set(thread.events.flatMap((event) => (event.row.kind === "card" ? [event.row.id] : [])));
  if (thread.work === null)
    return { words: cards.size > 0 ? `asked ${plural(cards.size, "question")}` : "done", wrong: false };
  if (isOutcome(latest) || ENDED.has(latest.event)) {
    const state = endedWords(isOutcome(latest) ? latest.event : latest.code).state;
    return { words: state.toLowerCase(), wrong: state === "Stuck" };
  }
  if (latest.row.kind === "run" && latest.event === "failed") return { words: "stopped", wrong: true };
  if (CLOSED.has(latest.event)) return { words: ledgerEventWords(latest.event).toLowerCase(), wrong: false };
  if (WAITING_ON_HIM.has(latest.event)) return { words: "waiting for you", wrong: false };
  return { words: "working", wrong: false };
}

// What a sync read from the owner's accounts, in words: what it kept, left out and removed.
export type SyncRead = NonNullable<LedgerSpan["read"]>;
export function readWords(read: SyncRead): string {
  return [
    `${read.stored} kept`,
    read.junk === 0 ? null : `${read.junk} left out as junk`,
    read.held === 0 ? null : `${read.held} held back`,
    read.removed === 0 ? null : `${plural(read.removed, "item")} removed at the source`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}
export const stoppedWords = (code: string | undefined): string | null =>
  code === undefined || code === "ok" ? null : `Stopped: ${wordsOf(code).toLowerCase()}`;

// What the feed's page says each of its pieces of work is, and each card it asked.
export const namedIn = (feed: LedgerFeed): [string, string][] =>
  feed.works.map((one) => [one.work, one.summary.untrusted]);
