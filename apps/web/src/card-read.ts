import { type CardLine, type CardLineKey, cardLineText, LINE_PARTS } from "@intelligence/contracts/personal";
import { agentName } from "./agent-words.ts";
import {
  ASKERS,
  type Asker,
  codeAt,
  countAt,
  FROM_WORDS,
  GONE,
  HEADING_WORDS,
  IDENTITY_BASIS,
  idAt,
  OUTCOME_PARTS,
  plural,
  pointWords,
  REMOVED,
  RULE_AGAIN,
  RUN_CODES,
  ruleEffect,
  ruleQuestion,
  SEALED,
  SENTENCES,
  TRIED_WORDS,
  timeAt,
  timesInWords,
  unquoted,
  wordsAt,
} from "./card-lines.ts";
import type { CardCite, CardRow, CardShape, CardSource } from "./card-shape.ts";
import type { DoneLabel } from "./card-words.ts";
import { GOAL_STATE_WORDS, OPPORTUNITY_KIND_NOUNS, REPORT_MARK_WORDS } from "./enum-words.ts";
import { GOAL_CHANGES } from "./goal-change-words.ts";
import { whenWords } from "./time-words.ts";
import { capital, wordsOf } from "./words.ts";

// What a card's lines say, read one line at a time by its key and parts (never its words) into one
// state that cards.ts then shapes into what the page shows. Each key's reading is its own handler,
// looked up in a table: code's lines in CODE_LINES, keyed words a source or an agent wrote in
// WORDS_LINES, and the words that follow a code line in CONTEXTS, by what that line said they are.

// One state the lines are read into, in order. Beside the rows, notes and title: what some kinds read
// for their question (questions.ts) and shape (cards.ts), each said where it is set.
const blank = (kind: string, handed: boolean) => ({
  kind,
  // An outcome on an opportunity: work handed to the owner, theirs to do.
  handed,
  rows: [] as CardRow[],
  notes: [] as string[],
  fields: {} as Record<string, string>,
  title: null as { text: string; from: CardLine["from"] } | null,
  about: null as string | null,
  type: null as string | null,
  stage: null as string | null,
  work: null as string | null,
  command: null as string | null,
  commandWhy: null as string | null,
  // The command after the first.
  afterCommand: undefined as string | undefined,
  resolve: null as CardShape["resolve"],
  ack: null as DoneLabel | null,
  fact: null as CardShape["fact"],
  agent: null as string | null,
  drifted: null as string | null,
  run: null as string | null,
  where: null as string | null,
  verdict: null as string | null,
  candidates: 0,
  ignore: undefined as string | undefined,
  // The messages and meetings it cites, the one whose words come next.
  cites: [] as CardCite[],
  citing: null as CardCite | null,
  // What the code line before a content line said it is.
  context: "",
  sections: [] as (CardRow & { from: CardLine["from"] })[],
  sources: [] as CardSource[],
  askedBy: null as Asker | null,
  // The agent that reported a result, by the name the owner registered.
  writer: null as string | null,
  task: false,
  draft: {} as { subject?: string; to?: string },
  // The person whose lines come next, and what each person's lines said, by their number.
  person: 0,
  people: {} as Record<number, string[]>,
  // The two sides of a same-fact or relation card, and the relation between them, by its code.
  first: null as string | null,
  second: null as string | null,
  relation: null as string | null,
  search: null as string | null,
  goal: null as string | null,
  goalNow: null as CardRow | null,
  // Its fact has since been removed. Proposed work no agent can carry out: going ahead means the owner does it.
  gone: false,
  yours: false,
  // What a goal proposal proposes, before its change leads the title.
  proposed: undefined as string | null | undefined,
  domains: [] as string[],
});
export type CardRead = ReturnType<typeof blank>;

type Read = (s: CardRead, line: CardLine, text: string) => void;

// A part's words, or "".
const said = (line: CardLine, at = 0): string => wordsAt(line, at) ?? "";
// A table's own entry, never one an object inherits.
const own = <T>(table: Readonly<Partial<Record<string, T>>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export const note = (s: CardRead, text: string): void => {
  if (!s.notes.includes(text)) s.notes.push(text);
};
const row = (s: CardRead, k: string, v: string): void => {
  const last = s.rows[s.rows.length - 1];
  if (last !== undefined && last.k === k && (k === "Cites" || k.startsWith("Person"))) last.v = `${last.v} · ${v}`;
  else s.rows.push({ k, v });
};
// A person's part, in their row and for who they are.
const personPart = (s: CardRead, n: number, text: string): void => {
  (s.people[n] ??= []).push(text);
  row(s, `Person ${n}`, text);
};
const setContext =
  (context: string): Read =>
  (s) => {
    s.context = context;
  };

// What was tried on a pair and why it did not settle, in a line.
function triedSentence(line: CardLine): string {
  const why = said(line, 2)
    .split("+")
    .map((one) => TRIED_WORDS[one] ?? one)
    .join("; ");
  const tried = said(line, 1);
  return `Pair ${countAt(line) ?? ""}: code could not settle it (${TRIED_WORDS[tried] ?? tried}), and your agents said: ${why}.`;
}

// What a keyed line of code's says as a sentence, or null when it says none: a sentence, what was
// removed or is gone, a sealed part, why two records may be one person, what accepting a goal does, a
// report's mark.
function lineSentence(line: CardLine): string | null {
  if (line.key === undefined) return null;
  const code = codeAt(line) ?? "";
  switch (line.key) {
    case "removed":
      return REMOVED[code] ?? null;
    case "gone":
      return GONE[code] ?? null;
    case "unreadable":
    case "body_none":
      return SEALED;
    case "identity_basis":
      return IDENTITY_BASIS[code] ?? null;
    case "identity_tried":
      return triedSentence(line);
    case "agent_answer":
    case "relayed_answer":
    case "checked":
      return cardLineText(line.key, line.value ?? []);
    // A rule card says what yes does, by its pattern.
    case "question_rule":
      return ruleEffect(codeAt(line, 1) ?? "");
    case "goal_effect":
      return own(GOAL_CHANGES, code)?.effect ?? null;
    case "mark":
      return Object.hasOwn(REPORT_MARK_WORDS, code) ? REPORT_MARK_WORDS[code as keyof typeof REPORT_MARK_WORDS] : null;
    default:
      return own<string>(SENTENCES, line.key) ?? null;
  }
}

// A run that stopped: why, and what the owner can do about it.
const runFailed: Read = (s, line) => {
  const code = said(line);
  s.run = code;
  note(
    s,
    code === "none"
      ? "The run stopped without saying why."
      : `The run stopped: ${RUN_CODES[code] ?? "it ended with an error"}.`,
  );
  // Caps are set in the terminal only: keeping it is the answer from the owner here; raising it is
  // the exact command, a day's dollars for N.
  if (code === "budget_exceeded" || code === "cap_reached") {
    note(
      s,
      "Keep the cap here, or raise it in the terminal with the command below, putting the dollars a day you allow in place of N. A cap is changed only in the terminal; Settings, under Models and spend, shows each one.",
    );
    s.command = "pia work budget --usd N";
    s.commandWhy = "To raise the cap instead, in the terminal, with N the dollars a day you allow:";
    s.ack = "Keep the cap";
  } else {
    note(s, "See why in the terminal.");
    s.command = "pia work status";
    s.commandWhy = "To see why, in the terminal:";
  }
};

// A ruling that lost its fact: rule again on the claim it applies to.
const rulingLost: Read = (s, line) => {
  const { verdict, candidates: listed } = LINE_PARTS.ruling_lost;
  const verb = RULE_AGAIN[said(line, verdict)];
  const candidates = (line.value ?? []).slice(listed).flatMap((one) => (one.kind === "id" ? [one.id] : []));
  s.verdict = said(line, verdict) || null;
  s.candidates = candidates.length;
  if (candidates.length === 1 && candidates[0] !== undefined) s.fact = { id: candidates[0], lead: "Rule again on" };
  if (candidates.length === 1 && verb !== undefined) {
    note(s, "It can apply to one fact only: rule on it again here, and the card is answered with it.");
    s.resolve = { write: verb.write, body: { fact: candidates[0] }, words: verb.words };
    return;
  }
  note(
    s,
    candidates.length === 0
      ? "No fact is left for it: mark this seen."
      : candidates.length === 1
        ? "It can apply to one fact only; rule on it again in the terminal, as this ruling cannot be made on this page, then mark this seen."
        : `It may apply to one of ${candidates.length} facts: read them in the terminal and rule again on the right one.`,
  );
  if (candidates.length > 0) {
    s.command = "pia review --kind ruling_carry";
    s.commandWhy = "To read them and rule again, in the terminal:";
  }
};

// What sets a cited message's sender off from its subject. A subject may hold it too, so the sender is
// what follows the last one.
const FROM_MARK = " · from ";
// A line of code's, by its key; a key with no entry is the card's own columns, refs, kinds, ids and
// codes, and is hidden.
const CODE_LINES = {
  run_failed: runFailed,
  time_yes_lost: (s) =>
    note(
      s,
      "Your yes on a time card made no project: none of that time is left in that day. If it comes back it will be asked again.",
    ),
  see_it: (s, line) => {
    // A drifted step says its two commands in its own note.
    if (s.kind !== "calibration_drift") note(s, "See it in the terminal.");
    s.command = `pia ${said(line)}`;
    s.commandWhy =
      s.kind === "calibration_drift"
        ? "To read the report, then let it decide again, in the terminal:"
        : "To see it, in the terminal:";
  },
  point: (s, line) => {
    // A step where a model decides for the owner drifted from their answers (calibration_drift):
    // the system stopped trusting it; resuming it is the ladder's, kept out of the browser.
    if (s.kind !== "calibration_drift") return;
    const name = said(line);
    s.where = pointWords(name);
    row(s, "Where", s.where ?? "A step where a model decides for you");
    note(
      s,
      "Where a model decides for you, its answers have drifted from yours, so the system stopped trusting it and asks you instead. Keep deciding it yourself here, or read the report in the terminal with the first command and, if you want it back, resume it with the second.",
    );
    s.ack = "Keep deciding it myself";
    s.drifted = name === "" ? null : name;
  },
  confirm_records: (s, line) =>
    note(
      s,
      `Confirming records ${codeAt(line) === "quote" ? "the quote as your own words" : "this as your own word"}, given through ${agentName(said(line, 1))}.`,
    ),
  ruling_lost: rulingLost,
  interpretation: setContext("reading"),
  private_identifier: (s, line) =>
    note(s, `${said(line)} is known only from your own sources; the search service will see it.`),
  binds: (s, line) => note(s, `Approving ties these pages to ${said(line, 1)}, whom your own sources know.`),
  known_by: (s, line) => {
    const at = LINE_PARTS.known_by;
    const count = (part: number): string => String(countAt(line, part) ?? 0);
    personPart(
      s,
      countAt(line, at.person) ?? 0,
      `${plural(count(at.contacts), "contact", "contacts")}, ${count(at.sent)} sent, ${count(at.received)} received, ${plural(count(at.meetings), "meeting", "meetings")}`,
    );
  },
  heading: (s, line) => {
    s.context = said(line);
  },
  // A result's work is a task; who asked for it; each source it cites (card-kinds-outcome.ts).
  task: (s) => {
    s.task = true;
  },
  asked_by: (s, line) => {
    const name = codeAt(line) === "agent" ? agentName(said(line, 1)) : "Someone";
    s.askedBy = own(ASKERS, said(line)) ?? { said: name, within: name };
  },
  source: (s, line) => {
    const named = idAt(line);
    s.sources.push({ kind: named?.of ?? said(line), id: named?.id ?? null, words: "" });
    s.context = "source";
  },
  source_unnamed: setContext(""),
  identifier: (s, line) => row(s, "Looks up", said(line, 1)),
  person: (s, line) => {
    s.person = countAt(line) ?? 0;
    s.context = "person";
  },
  subject: (s, line) => {
    // An id names who it is about; a name (a research request's) is said.
    if ((line.value ?? []).some((one) => one.kind === "id")) s.context = "subject";
    else s.about = said(line);
  },
  type: (s, line) => {
    s.type = said(line);
  },
  cited: (s, line) => {
    s.context = "cited";
    s.rows.push({ k: "Cites", v: "" });
    // A message or meeting it cites, by its id, opens to itself.
    const cited = idAt(line);
    s.citing =
      cited === null || (cited.of !== "message" && cited.of !== "event")
        ? null
        : { kind: cited.of === "message" ? "message" : "meeting", id: cited.id, subject: "", from: null };
    if (s.citing !== null) s.cites.push(s.citing);
  },
  work: (s, line) => {
    // A work row's kind opens it; a result says what was asked under its own heading.
    const [table, rowKind] = [said(line), said(line, 1)];
    if (table === "opportunity" && Object.hasOwn(OPPORTUNITY_KIND_NOUNS, rowKind))
      s.work = (OPPORTUNITY_KIND_NOUNS as Record<string, string>)[rowKind] ?? null;
    if (s.kind === "outcome") return;
    s.context = s.title === null ? "content" : "follows";
  },
  follows_from: setContext("follows"),
  move: (s, line) => {
    s.stage = said(line);
  },
  fact_a: setContext("first"),
  from: setContext("first"),
  fact_b: setContext("second"),
  to: setContext("second"),
  relation: (s, line) => {
    s.relation = said(line);
    row(s, "Relation", wordsOf(said(line)));
  },
  client: (s, line) => {
    const name = said(line);
    // A result's line under its title and each of its parts say who reported it.
    if (s.kind === "outcome") {
      s.writer = agentName(name);
      return;
    }
    row(s, "Agent", agentName(name));
    // An agent repeating an out-of-date fact: what its memory keeps is read in the terminal.
    if (s.kind !== "stale_restatement") return;
    s.agent = agentName(name);
    note(s, `See what ${agentName(name)} keeps in its memory, then tell it the current fact, and mark this done.`);
    s.command = `pia memory status --client ${name}`;
    s.commandWhy = "To see what it remembers, in the terminal:";
    s.ack = "Done: I told it";
  },
  claim: (s, line) => {
    // The out-of-date fact an agent keeps repeating, by its latest claim (card-kinds.ts).
    const claim = idAt(line);
    if (s.kind === "stale_restatement" && claim !== null) s.fact = { id: claim.id, lead: "" };
  },
  restated: (s, line) => row(s, "Restated", `${countAt(line) ?? 0} times`),
  first: (s, line) => {
    const at = timeAt(line);
    if (at !== null) row(s, "First", capital(whenWords(at)));
  },
  last: (s, line) => {
    const at = timeAt(line);
    if (at !== null) row(s, "Latest", capital(whenWords(at)));
  },
  goal: setContext("goal"),
  goal_status: (s, line) => {
    row(s, "Your goal now", (GOAL_STATE_WORDS as Record<string, string>)[said(line)] ?? wordsOf(said(line)));
    s.goalNow = s.rows.at(-1) ?? null;
  },
  change: (s, line) => {
    if (Object.hasOwn(GOAL_CHANGES, said(line))) s.fields.__change = said(line);
  },
  compartment_proposed: (s) => note(s, "It asks to keep this goal apart from your others."),
  // Its name follows under the "proposed target" heading.
  target_proposed: () => {},
  target_name_label: (s) =>
    note(s, "Accepting keeps this name with your goal, so whatever can read the goal can read it."),
  target_holders_changed: (s) => note(s, "Someone came to hold this name after this was proposed."),
  // The command for the owner to run. No id is on the page, and the name is theirs to read above,
  // never pasted from an agent's words into something a shell runs.
  target_pick: (s) => {
    s.command = 'pia goal target ID --name "NAME"';
    s.commandWhy =
      "To see who holds it, in the terminal, with the goal's id from pia goal list and the name above; then the same with --entity and the id it prints, and answer again:";
  },
  // Holders share a name, so when each was last seen tells them apart. One with no name of its own
  // goes by the name proposed.
  target_held_by: (s, line) => {
    const at = timeAt(line, 1);
    const name = wordsAt(line, 2) ?? s.title?.text ?? "";
    row(s, "Holds that name", `${name}, ${at === null ? "not seen yet" : `last seen ${whenWords(at)}`}`);
  },
  template: (s, line) => {
    s.search ??= wordsAt(line, 1) ?? wordsOf(said(line));
    row(s, "Search", wordsAt(line, 1) ?? wordsOf(said(line)));
  },
  url: (s, line) => row(s, "Link", said(line)),
  link_message: (s, line) => {
    const at = timeAt(line, 1);
    row(s, "Found in", `A message from ${said(line, 2)}, ${at === null ? "at an unknown time" : whenWords(at)}`);
  },
  project: (s, line) => row(s, "Project", said(line)),
  ruling: (s, line) => {
    const ruling = idAt(line);
    if (ruling !== null) s.ignore = ruling.id;
  },
} as const satisfies Partial<Record<CardLineKey, Read>>;

function readCodeLine(s: CardRead, line: CardLine, text: string): void {
  // A line of code's with no key (a body stored before lines had keys) is said as written.
  if (line.key === undefined) {
    if (text !== "") note(s, text);
    return;
  }
  // A result handed to the owner says what it is theirs to do in its own note (cards.ts).
  if (s.kind === "outcome" && line.key === "handed") return;
  // A rule card asks in the words of what it would do, so the owner sees it before opening anything.
  if (line.key === "question_rule")
    s.fields.__rule = ruleQuestion(countAt(line) ?? 0, codeAt(line, 1) ?? "", codeAt(line, 2) ?? "");
  if (line.key === "removed" && codeAt(line) === "claim") s.gone = true;
  if (line.key === "handed") s.yours = true;
  const sentence = lineSentence(line);
  if (sentence !== null) {
    note(s, sentence);
    // What the heading before a sealed part named is sealed: the next line is not it.
    if (line.key === "unreadable" || line.key === "body_none") s.context = "";
    return;
  }
  // A box health card: what went wrong and what it is about, said whole by
  // boxHealthWords; its own command lines are that one's.
  if (s.kind === "box_health") {
    if (line.key === "health" || line.key === "about") s.fields[`__${line.key}`] = said(line);
    return;
  }
  own<Read>(CODE_LINES, line.key)?.(s, line, text);
}

// The words that follow a code line, by what it said they are. Each ends that context except a
// cited item's, a person's and a pair's, whose words go on while a source wrote them.
const CONTEXTS: Readonly<Record<string, Read>> = {
  subject: (s, _line, text) => {
    s.about = text;
    s.context = "";
  },
  cited: (s, _line, text) => {
    const last = s.rows[s.rows.length - 1];
    if (last !== undefined && last.k === "Cites") last.v = last.v === "" ? text : `${last.v}, from ${text}`;
    if (s.citing !== null) {
      if (s.citing.subject === "") s.citing.subject = text;
      else s.citing.from ??= text;
    }
  },
  person: (s, _line, text) => personPart(s, s.person, text),
  first: (s, _line, text) => {
    s.first ??= unquoted(text);
    row(s, "First", unquoted(text));
  },
  second: (s, _line, text) => {
    s.second ??= unquoted(text);
    row(s, "Second", unquoted(text));
  },
  reading: (s, _line, text) => {
    row(s, "The agent's reading", text);
    s.context = "";
  },
  // A message a result cites, "Subject · from Sender" as the store writes it, is cited too.
  source: (s, _line, text) => {
    const at = text.lastIndexOf(FROM_MARK);
    citedSource(s, text, at === -1 ? text : text.slice(0, at), at === -1 ? null : text.slice(at + FROM_MARK.length));
  },
  goal: (s, _line, text) => {
    s.goal ??= text;
    row(s, "Your goal", text);
    s.context = "";
  },
  content: (s, line, text) => {
    if (s.title === null) s.title = { text: timesInWords(text), from: line.from };
    else row(s, "Summary", timesInWords(text));
    s.context = "";
  },
  follows: (s, _line, text) => {
    row(s, "Follows from", text);
    s.context = "";
  },
};
// A result's part, under the heading before it.
const outcomePart: Read = (s, line, text) => {
  s.sections.push({ k: s.context, v: timesInWords(text), from: line.from });
  s.context = "";
};
// A work row's heading's words, as its row, or the proposed words as its title.
const headed: Read = (s, line, text) => {
  if ((s.context === "proposed words" || s.context === "proposed target") && s.title === null)
    s.title = { text, from: line.from };
  else {
    row(s, HEADING_WORDS[s.context] ?? "", text);
    // An agent's words say so; whose, once who made the work is known (cards.ts).
    const made = s.rows.at(-1);
    if (line.from === "agent" && made !== undefined) made.by = FROM_WORDS.agent;
  }
  s.context = "";
};
const contextRead = (s: CardRead): Read | undefined =>
  own(CONTEXTS, s.context) ??
  (s.kind === "outcome" && Object.hasOwn(OUTCOME_PARTS, s.context)
    ? outcomePart
    : Object.hasOwn(HEADING_WORDS, s.context)
      ? headed
      : undefined);

// The words of the source a result cites last, which, when they are a message's, is cited too, once.
const citedSource = (s: CardRead, text: string, subject: string, from: string | null): void => {
  const last = s.sources.at(-1);
  if (last !== undefined) last.words = text;
  if (last?.kind === "message" && last.id !== null && !s.cites.some((one) => one.id === last.id))
    s.cites.push({ kind: "message", id: last.id, subject, from });
  s.context = "";
};

// Words a source, a model or an agent wrote under a key code gave them.
const WORDS_LINES = {
  cited_message: (s, line, text) => citedSource(s, text, wordsAt(line) ?? "", wordsAt(line, 1)),
  type: (s, line) => {
    s.type = said(line);
  },
  says_you_said: (s, line) => row(s, "You said", said(line)),
  add_person: (s, line) => {
    s.title ??= { text: `Add ${said(line) || "a person"} to the people you know`, from: line.from };
    if (wordsAt(line, 1) !== null) row(s, "Known through", said(line, 1));
  },
  to_you: (s, line) => row(s, "To you", `${said(line)}, closeness: ${said(line, 1)}`),
  link: (s, line) =>
    row(s, "Link", `${said(line)}${codeAt(line, 1) === "inferred" ? " (inferred, no source states it)" : ""}`),
  proposal_basis: (s, line) => row(s, "Why", said(line)),
  meeting_title: (s, line) => row(s, "Meeting", said(line)),
  calendar_title: (s, line) => row(s, "Calendar title", said(line)),
  start: (s, line) => {
    const at = timeAt(line);
    if (at !== null) row(s, "When", capital(whenWords(at)));
  },
  // A claim's field: kept for its sentence, and shown as a row.
  field: (s, line) => {
    s.fields[said(line)] = unquoted(said(line, 1));
  },
} as const satisfies Partial<Record<CardLineKey, Read>>;

// A line a source, a model, an agent or the owner wrote: content.
function readWordsLine(s: CardRead, line: CardLine, text: string): void {
  if (text === "") return;
  // A draft's subject and recipients, as the agent wrote them (card-kinds.ts draftWaiting.detail).
  if (line.key === "draft_subject" || line.key === "draft_to") {
    s.draft[line.key === "draft_subject" ? "subject" : "to"] = said(line);
    return;
  }
  // What the owner told an agent, by the agent's registered name (card-kinds-claims.ts leadLines).
  if (line.key === "you_told") {
    row(s, `You told ${agentName(said(line))}`, said(line, 1));
    return;
  }
  // The words of a cited item, a person or a pair are a source's; any other line ends them.
  if (["cited", "person", "first", "second"].includes(s.context) && line.from !== "source") s.context = "";
  if (line.key === "cited_message") {
    WORDS_LINES.cited_message(s, line, text);
    return;
  }
  const inContext = contextRead(s);
  if (inContext !== undefined) {
    inContext(s, line, text);
    return;
  }
  const keyed = line.key === undefined ? undefined : own<Read>(WORDS_LINES, line.key);
  if (keyed !== undefined) {
    keyed(s, line, text);
    return;
  }
  // A statement proposal's statement is its words; any other line is content as written.
  const words = line.key === "statement" ? said(line) : text;
  if (s.title === null) s.title = { text: timesInWords(words), from: line.from };
  else
    row(
      s,
      line.from === "agent" ? "In the agent's words" : line.from === "model" ? "Summary" : "Also",
      timesInWords(words),
    );
}

// The keys this reader leaves to another (`lineSentence`, the box health card's words, the cards that
// shape themselves from their lines), and the keys it hides: a card's own columns, refs, kinds, ids and
// codes, which are no one's to read. A key the store starts writing, in none of these, fails to compile,
// so each is decided shown or hidden.
// Keys written as words a space apart, each word one key.
type Keys<S extends string> = S extends `${infer One} ${infer Rest}` ? One | Keys<Rest> : S;
type SaidElsewhere = Keys<
  | "removed gone unreadable body_none identity_basis identity_tried agent_answer relayed_answer checked"
  | "question_rule goal_effect mark health about draft_subject draft_to you_told statement trait trait_as"
  | "trait_gone tier tier_already tier_proposed tier_since tier_note unnamed time_effort time_effort_note"
  | "grant_command fact_kind confirmed not_true"
>;
type Hidden = Keys<
  | "kind author requester at target ref request case report draft read_draft record_dump fact_key judge host"
  | "stored_under gate proposal_none basis answer_note"
>;
type Undecided = Exclude<
  CardLineKey,
  keyof typeof CODE_LINES | keyof typeof WORDS_LINES | keyof typeof SENTENCES | SaidElsewhere | Hidden
>;
type NoneLeft<T extends never> = T;
// Every key is decided, and every key named is one the store writes.
export type NoKeyUndecided = NoneLeft<Undecided | Exclude<SaidElsewhere | Hidden, CardLineKey>>;

// Every line of a card, read in order into one state.
export function readLines(kind: string, lines: readonly CardLine[], handed = false): CardRead {
  const s = blank(kind, handed);
  for (const line of lines) {
    const text = line.text.trim();
    if (line.from === "code") readCodeLine(s, line, text);
    else readWordsLine(s, line, text);
  }
  return s;
}
