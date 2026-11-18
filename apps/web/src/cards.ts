import type { CardLine, CardMention, CardView, KnownCardKind, Tier } from "@intelligence/contracts/personal";
import { authorWords } from "./agent-words.ts";
import { type BoxNames, boxHealthWords } from "./box-words.ts";
import { CARD_KINDS, cardKindRow } from "./card-kinds.ts";
import {
  codeAt,
  FROM_WORDS,
  fieldKey,
  OUTCOME_PARTS,
  proposalWords,
  RELATION_VERBS,
  RESULT_NOTE,
  sourceRow,
} from "./card-lines.ts";
import { kindOf } from "./card-order.ts";
import { type CardRead, note, readLines } from "./card-read.ts";
import { type CardCite, type CardRow, type CardShape, type Reply, shapeOfCode } from "./card-shape.ts";
import { doneLabel } from "./card-words.ts";
import { AFFILIATION_PLURAL_WORDS, factTypeWords, RELATIONSHIP_WORDS, STAGE_WORDS, TIER_WORDS } from "./enum-words.ts";
import { PHRASE_FIELD, sentenceOf } from "./facts.ts";
import { goalChangeOf } from "./goal-change-words.ts";
import { learnShape } from "./learn-cards.ts";
import { questionOf } from "./questions.ts";
import { durationOf, whenWords } from "./time-words.ts";
import { capital } from "./words.ts";

// A card as the owner reads it: a title that is its content (the claim as a sentence, the proposed
// work, the question), one line under it (who or what it is about, by name, and where it came from in
// words), and, opened, the design's key-value rows. A card's `lines` come from the store
// (`packages/store/src/cards/card-kinds*.ts`, `admin-research.ts`), each with its words for the
// terminal and, where code gave it one, its key and typed parts (the contract's CardLine): code's
// lines carry the card's columns, ids, types and codes, mixed with what a source, a model or an agent
// said. Here each line is read by its key and parts, never by its words, and hidden or said in plain
// words; no id, code, field name or ISO time is shown.

// The messages and meetings an agent's words named, which `pi web` names in place of their ids, as
// cites, each once: one its lines cite already is not cited again.
const mentionCites = (mentions: readonly CardMention[], cited: readonly CardCite[]): CardCite[] =>
  mentions.flatMap((one): CardCite[] =>
    (one.open.kind === "message" || one.open.kind === "meeting") && !cited.some((known) => known.id === one.open.id)
      ? [{ kind: one.open.kind, id: one.open.id, subject: one.words, from: null }]
      : [],
  );

// The trait a tier proposal's people share, in plain words after "others": an
// organization by how they are tied to it, from a fixed map per relation, never "affiliated with
// Example Org as employee". The kind is the store's `trait` line's code (tier-proposer.ts).
function traitWords(trait: string, value: string, relation: string | null): string {
  const plural = AFFILIATION_PLURAL_WORDS as Readonly<Record<string, string>>;
  if (trait === "organization") return `${plural[relation ?? "other"] ?? AFFILIATION_PLURAL_WORDS.other} ${value}`;
  if (trait === "role") return `whose role is ${value}`;
  if (trait === "relation")
    return `whose relation to you is ${(RELATIONSHIP_WORDS as Readonly<Record<string, string>>)[value] ?? value}`;
  return value;
}

// A tier proposal: the people like the ones the owner set to a tier, by a trait they
// share, proposed for the same tier. Its lines are code's headings, each over the source's names.
function tierShape(lines: readonly CardLine[]): CardShape {
  let trait = "";
  let tier = "";
  let heading = "";
  const named: Record<string, string[]> = { trait: [], as: [], already: [], proposed: [] };
  for (const line of lines) {
    const text = line.text.trim();
    if (line.from !== "code") {
      named[heading]?.push(text);
      continue;
    }
    // A person no source names is named by nothing here: the heading it is under goes on.
    if (line.key === "unnamed") continue;
    if (line.key === "trait") [heading, trait] = ["trait", codeAt(line) ?? ""];
    else if (line.key === "trait_as") heading = "as";
    else if (line.key === "tier") [heading, tier] = ["", codeAt(line) ?? ""];
    else if (line.key === "tier_already") heading = "already";
    else if (line.key === "tier_proposed") heading = "proposed";
    else heading = "";
  }
  const list = (names: string[]): string => names.join(", ");
  const like = traitWords(trait, list(named.trait ?? []), named.as?.[0] ?? null);
  const proposed = named.proposed ?? [];
  // The tier by its name in People (Close, Inner), as a move the owner makes.
  const tierName =
    tier === "" ? "this tier" : Object.hasOwn(TIER_WORDS, tier) ? TIER_WORDS[tier as Tier] : capital(tier);
  const title =
    proposed.length === 0
      ? `Move others ${like} to ${tierName}?`
      : `Move ${list(proposed)} to ${tierName}, like others ${like}?`;
  return shapeOfCode({
    question: capital(title),
    replies: CARD_KINDS.tier_proposal.replies,
    title: capital(title),
    sub: "A suggestion from your own tiers",
    rows: [
      { k: "Who", v: `People ${like}` },
      { k: `Already ${tier}`, v: list(named.already ?? []) },
      { k: `Proposed for ${tier}`, v: list(proposed) },
    ].filter((row) => row.v !== ""),
    notes: [
      "Confirming sets each proposed person's tier; you can change any of them later. Rejecting is remembered until you set this tier for one of them yourself.",
    ],
  });
}

type Card = CardView & { lines?: CardLine[]; mentions?: CardMention[] | undefined };
// A claim's fields, as its sentence when no line gave one, each field a row besides; the step its move was at.
function fieldsOf(s: CardRead, lines: readonly CardLine[]): void {
  const fieldNames = Object.keys(s.fields).filter((name) => !name.startsWith("__"));
  if (s.type !== null && s.title === null && fieldNames.length > 0) {
    s.title = {
      text: sentenceOf(s.type, s.fields, s.about),
      from: lines.find((line) => line.from !== "code")?.from ?? "agent",
    };
  }
  if (s.kind !== "about_you" || s.title === null)
    for (const name of fieldNames) s.rows.push({ k: fieldKey(name), v: s.fields[name] ?? "" });
  // A result is reported back, so the step its move was at says nothing.
  if (s.stage !== null && s.kind !== "outcome" && Object.hasOwn(STAGE_WORDS, s.stage))
    s.rows.unshift({ k: "Step", v: (STAGE_WORDS as Record<string, string>)[s.stage] ?? "" });
}

// A goal proposal's change leads its words; the words it proposes are what its question asks about.
function goalRead(s: CardRead, kindTitle: string): void {
  const change = s.fields.__change;
  // Its status is worth a row only where the change is to its status.
  if (change === "reword" || change === "add") s.rows = s.rows.filter((one) => one !== s.goalNow);
  s.proposed = s.title?.text ?? null;
  const changeWords = goalChangeOf(change)?.words;
  if (change !== undefined && s.title !== null)
    s.title = { ...s.title, text: `${changeWords ?? "A goal"}: ${s.title.text}` };
  else if (change !== undefined) s.title = { text: changeWords ?? kindTitle, from: "code" };
}

// An ignore_narrowed card names the ignore (its ruling, which the opened card shows by whom it
// covers) and the new domains to ignore, its body's lines, each an exact command.
function ignoreNarrowed(s: CardRead, lines: readonly CardLine[]): void {
  const domains = [
    ...new Set(
      lines.filter((line) => line.from === "source").flatMap((line) => line.text.split("\n").map((one) => one.trim())),
    ),
  ].filter((one) => /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(one));
  s.domains = domains;
  s.rows.length = 0;
  s.ack = "Keep only those ignored";
  if (domains.length === 0) {
    note(
      s,
      "A change in how addresses are grouped moved some addresses you ignore to a new domain. The addresses you ignored stay ignored; others at that domain are not. Keep it so here, or ignore everyone at the new domain in the terminal: list what you ignore to find it, then add it, with DOMAIN the domain the list shows. Ignoring a whole domain is done only in the terminal.",
    );
    s.command = "pia ignore list";
    s.commandWhy = "To ignore everyone at the new domain instead, in the terminal, with DOMAIN the one the list shows:";
    s.afterCommand = "pia ignore add domain DOMAIN";
    return;
  }
  const named = domains.join(" and ");
  // One plain sentence for what changed, never "ignore" as a noun.
  s.title = { text: `Others at ${named} are no longer ignored`, from: "code" };
  // The title says what changed; the store's sentence would say it again.
  s.notes.length = 0;
  note(
    s,
    `A change in how addresses are grouped moved ${named} out from under a domain you ignore. The addresses you ignored there stay ignored; anyone else at ${named} is not. Keep it so here, or ignore everyone at ${named} in the terminal. Ignoring a whole domain is done only in the terminal.`,
  );
  s.command = `pia ignore add domain ${domains[0]}`;
  s.commandWhy = `To ignore everyone at ${named} instead, in the terminal:`;
  s.afterCommand =
    domains.length < 2
      ? undefined
      : domains
          .slice(1)
          .map((one) => `pia ignore add domain ${one}`)
          .join("\n");
}

// An agent's words said to be an agent's: by name where the name is known.
const agentWho = (name: string | null): string =>
  name === null || name === "an agent" ? "an agent" : `${name}, an agent`;
const agentWords = (name: string | null): string => `From ${agentWho(name)}`;

// A result leads with what was found, else what was asked; its parts follow as sections, what was
// asked said by who asked it, and what leads the card not said again. A fact an agent's sentence
// names by id is said once: where its words follow in brackets ("is chair (Chair at Example Garden
// Club)"), the brackets go; the fact stays under "Named in it", where it opens.
function resultParts(s: CardRead, mentions: readonly CardMention[]) {
  const factWords = new Set(mentions.filter((one) => one.open.kind === "fact").map((one) => one.words));
  const once = (text: string): string =>
    text.replace(/ \(([^()]+)\)/g, (bracket, words: string) => (factWords.has(words) ? "" : bracket));
  const part = (k: string): string | undefined => {
    const v = s.sections.find((one) => one.k === k)?.v;
    return v === undefined ? undefined : once(v);
  };
  const asker = s.askedBy?.within ?? null;
  // What was asked is the asker's words; every other part the words of the agent that reported it.
  const nameOf = (k: string): string | null => (k === "asked" ? asker : s.writer);
  const lead = part("found") === undefined ? "asked" : "found";
  const leading = s.sections.find((one) => one.k === lead);
  const titled = s.kind === "outcome" && s.title === null && leading !== undefined;
  if (titled) s.title = { text: part(lead) ?? "", from: leading.from };
  const sections = Object.keys(OUTCOME_PARTS).flatMap((k) => {
    const v = part(k);
    if (v === undefined || v === s.title?.text) return [];
    const by = s.sections.find((one) => one.k === k)?.from === "agent" ? { by: agentWords(nameOf(k)) } : {};
    return [{ k: k === "asked" && asker !== null ? `What ${asker} asked` : (OUTCOME_PARTS[k] ?? k), v, ...by }];
  });
  // A proposal's details are the words of whoever made the work, an agent's only if an agent did.
  const maker =
    asker === "you" || asker === "the planner" || asker === "the system" ? `From ${asker}` : agentWords(asker);
  return {
    part,
    asker,
    sections,
    maker,
    titleAgent: titled && leading.from === "agent" ? agentWho(nameOf(lead)) : null,
  };
}

// Who or what it is about, by name, and where it came from: who it is from is said once, who asked
// for it where that is known. A title an agent wrote always says so, whoever asked for the work: its
// words may read as the system's own.
function subOf(s: CardRead, from: string, asker: string | null): string {
  const asked = asker === null ? null : s.task ? `A task ${asker} asked for` : `Asked by ${asker}`;
  return [
    s.draft.to === undefined ? null : `To ${s.draft.to}`,
    s.about === null ? null : s.about === "You" ? "About you" : `About ${s.about}`,
    s.work,
    asked,
    s.type === null ? null : factTypeWords(s.type),
    asked === null || s.title?.from === "agent" ? from : null,
  ]
    .filter((part, index, all) => part !== null && part !== "A fact" && all.indexOf(part) === index)
    .join(" · ");
}

// An about-you card: Delete is the owner's reject; Edit, where its kind takes the owner's value, confirms
// their corrected words, whether an agent proposed it or their mail said it. One whose fact is gone keeps
// only its Dismiss. The title's words before the value ("Prefers") are the fixed part of the
// sentence, shown beside the field, so the owner's words go where the value goes.
const EDIT_KINDS: ReadonlySet<string> = new Set([
  "goal",
  "need",
  "capability",
  "preference",
  "constraint",
  "situation",
]);
function editOf(s: CardRead, gone: boolean): CardShape["edit"] {
  const field =
    s.kind === "about_you" && !gone && s.type !== null && EDIT_KINDS.has(s.type) ? PHRASE_FIELD[s.type] : undefined;
  if (field === undefined) return undefined;
  const value = s.fields[field] ?? s.title?.text ?? "";
  const shownTitle = s.title === null ? "" : proposalWords(s.title.text);
  const lead =
    value !== "" && shownTitle.toLowerCase().endsWith(value.toLowerCase())
      ? shownTitle.slice(0, shownTitle.length - value.length).trim()
      : "";
  return { field, value, lead: capital(lead) };
}

// Its answers as replies that say what they do: the kind's, then what this card's own words say.
function repliesOf(card: Card, s: CardRead, gone: boolean): Record<string, Reply> {
  const replies: Record<string, Reply> = { ...(cardKindRow(card.kind)?.replies ?? {}) };
  const own = stepsOf(card.kind).replies;
  if (own !== undefined) own(s, replies);
  else if (s.ack !== null) saysYes(replies, s.ack, doneLabel(s.ack));
  if (gone) for (const option of card.options) replies[option] = { label: "Clear it", done: "Cleared" };
  return replies;
}
// An acknowledgement as what it decides.
const saysYes = (replies: Record<string, Reply>, label: string, done: string): void => {
  replies.acknowledge = { label, done };
  replies.seen = { label, done };
};

// What a kind does beyond what every card does, by the step of `cardShape` it does it at, so what
// `goal_proposal` or `outcome` does is read here: `read`, once its lines and fields are read; `title`, what
// it makes of its title; `titled`, once a result's parts are read; `replies`, its answers in place of
// its acknowledgement's. A question its code asks leads with what it is about, by name, never the kind's
// question alone.
type KindSteps = {
  read?: (s: CardRead, lines: readonly CardLine[], kindTitle: string) => void;
  title?: (s: CardRead) => void;
  titled?: (s: CardRead, names: BoxNames) => void;
  replies?: (s: CardRead, replies: Record<string, Reply>) => void;
};
// A title of code's, where no line gave one.
const asking =
  (question: (s: CardRead) => string | null) =>
  (s: CardRead): void => {
    const text = s.title === null ? question(s) : null;
    if (text !== null) s.title = { text, from: "code" };
  };
const personOf = (s: CardRead, n: number): string | null => s.people[n]?.[0] ?? null;
const addressOf = (s: CardRead): string | null => s.people[1]?.find((part) => part.includes("@")) ?? null;
const KIND_STEPS: Readonly<Partial<Record<KnownCardKind, KindSteps>>> = {
  // Its title is said as a proposal.
  about_you: {
    title: (s) => {
      if (s.title !== null) s.title = { ...s.title, text: proposalWords(s.title.text) };
    },
  },
  goal_proposal: {
    read: (s, _lines, kindTitle) => goalRead(s, kindTitle),
    replies: (s, replies) => {
      if (s.ack !== null) saysYes(replies, s.ack, doneLabel(s.ack));
      const yes = goalChangeOf(s.fields.__change)?.yes;
      if (yes !== undefined) replies.accept = yes;
    },
  },
  ruling_carry: {
    read: (s) => {
      s.notes.unshift("A change in how facts are read left one of your rulings with no fact to apply to.");
      // Its acknowledgement says what it does: a ruling with no fact is let go.
      s.ack ??= "Let the ruling go";
    },
  },
  // It leads with its subject, and says to whom under it; its acknowledgement says it stays to send in the
  // terminal.
  draft_waiting: {
    read: (s) => {
      s.ack ??= "Keep the draft";
    },
    title: (s) => {
      if (s.title !== null || (s.draft.subject === undefined && s.draft.to === undefined)) return;
      s.title = { text: s.draft.subject ?? `A message to ${s.draft.to ?? "someone"}`, from: "agent" };
      if (s.draft.to !== undefined) s.about = null;
    },
    replies: (_s, replies) => saysYes(replies, "Yes, keep it", "Kept the draft"),
  },
  ignore_narrowed: { read: (s, lines) => ignoreNarrowed(s, lines) },
  // The command after the first: the exact one that resumes a drifted step, by its name.
  calibration_drift: {
    read: (s) => {
      if (s.drifted !== null) s.afterCommand = `pia ladder resume ${s.drifted}`;
    },
  },
  stale_restatement: {
    read: (s) => {
      if (s.fact !== null) s.fact = { ...s.fact, lead: `${s.agent ?? "An agent"} keeps repeating, out of date` };
    },
  },
  same_person: {
    title: asking((s) => {
      const [first, second] = [personOf(s, 1), personOf(s, 2)];
      return first !== null && second !== null ? `${first} and ${second}: the same person?` : null;
    }),
  },
  shared_address: {
    title: asking((s) => {
      const address = addressOf(s) ?? personOf(s, 1);
      return address !== null ? `Is ${address} shared by more than one person?` : null;
    }),
  },
  same_fact: {
    title: asking((s) => (s.first !== null && s.second !== null ? `"${s.first}" and "${s.second}": the same?` : null)),
  },
  relation_audit: {
    title: asking((s) =>
      s.first !== null && s.second !== null
        ? `Does "${s.first}" ${RELATION_VERBS[s.relation ?? ""] ?? "relate to"} "${s.second}"?`
        : null,
    ),
  },
  research_request: {
    title: asking((s) =>
      s.about === null ? null : `Search the web about ${s.about}${s.search === null ? "" : `: ${s.search}`}`,
    ),
  },
  box_health: {
    titled: (s, names) => {
      const health = boxHealthWords(s.fields.__health ?? "", s.fields.__about ?? "", names);
      s.title = { text: health.title, from: "code" };
      note(s, health.note);
      s.command = health.command;
    },
  },
  // With nothing but code's lines it leads with what it says. A title has no full stop.
  notice: {
    titled: (s) => {
      if (s.title === null && s.notes[0] !== undefined)
        s.title = { text: (s.notes.shift() ?? "").replace(/\.$/, ""), from: "code" };
    },
  },
  // Work handed to the owner: their acknowledgement marks it done, their dismissal drops it. The store
  // raises an outcome card on an opportunity only once it is handed to the owner (`declineAnswersOfCard`
  // reads it so too). A result of work not handed to the owner (a report, a finished task's) is theirs to
  // keep or not: their answer changes nothing of the work.
  outcome: {
    titled: (s) => {
      note(
        s,
        s.handed
          ? "No agent can carry this out: it is yours to do. Mark it done once you have, or drop it."
          : RESULT_NOTE,
      );
      s.ack = s.handed ? "Done" : "Keep it";
    },
    replies: (s, replies) => {
      saysYes(replies, s.handed ? "Yes, it's done" : "Yes, keep it", s.handed ? "Marked done" : "Kept");
      replies.dismiss = s.handed
        ? { label: "No, drop it", done: "Dropped" }
        : { label: "No, not useful", done: "Marked not useful" };
    },
  },
};
const stepsOf = (kind: string): KindSteps =>
  Object.hasOwn(KIND_STEPS, kind) ? (KIND_STEPS[kind as KnownCardKind] ?? {}) : {};

// The daily time pass's card: a group of the owner's time that fits no project, by what its evidence
// says, with its minutes and days from the store's line. Its evidence erased, it holds nothing.
function timeEffortShape(lines: readonly CardLine[]): CardShape {
  const counts = lines.find((line) => line.key === "time_effort");
  const what = lines.find((line) => line.from === "source")?.text.trim() ?? "";
  const gone = counts === undefined || what === "";
  const minutes = counts === undefined ? 0 : Number(codeAt(counts, 0) ?? 0);
  const days = counts === undefined ? 0 : Number(codeAt(counts, 1) ?? 0);
  const title = gone ? "This time is gone" : `Is ${JSON.stringify(what)} a project of its own?`;
  return shapeOfCode({
    question: title,
    replies: CARD_KINDS.time_effort.replies,
    title,
    sub: "A suggestion from your own time",
    rows: gone
      ? []
      : [
          { k: "Time", v: durationOf(minutes) },
          { k: "Days", v: String(days) },
        ],
    notes: gone
      ? []
      : ["Yes makes a project of this time and credits it. No keeps it unfiled, and it is not suggested again."],
    gone,
  });
}

// The kinds whose shape is their own, from their lines alone.
const OWN_SHAPES: Readonly<Partial<Record<KnownCardKind, (lines: readonly CardLine[]) => CardShape>>> = {
  tier_proposal: tierShape,
  time_effort: timeEffortShape,
  grant_suggestion: (lines) => learnShape("grant_suggestion", lines),
  grant_lift_suggestion: (lines) => learnShape("grant_lift_suggestion", lines),
};

export function cardShape(card: Card, names: BoxNames = {}): CardShape {
  const lines = card.lines ?? [];
  const ownShape = Object.hasOwn(OWN_SHAPES, card.kind) ? OWN_SHAPES[card.kind as KnownCardKind] : undefined;
  if (ownShape !== undefined) return ownShape(lines);
  const kind = kindOf(card.kind);
  const steps = stepsOf(card.kind);
  const s = readLines(card.kind, lines, card.kind === "outcome" && card.target?.kind === "opportunity");
  fieldsOf(s, lines);
  steps.read?.(s, lines, kind.title);
  // A question or a lesson of the planner's says why it asks, after what it cites.
  const why = cardKindRow(card.kind)?.whyAsked;
  if (why !== undefined) s.rows.push({ k: "Why it asks", v: why });
  steps.title?.(s);
  const { part, asker, sections, maker, titleAgent } = resultParts(s, card.mentions ?? []);
  steps.titled?.(s, names);
  const from =
    titleAgent !== null
      ? `From ${titleAgent}`
      : s.title === null || s.title.from === "code"
        ? (cardKindRow(card.kind)?.askedFrom ?? FROM_WORDS.code)
        : FROM_WORDS[s.title.from];
  const sub = subOf(s, from, asker);
  const { gone, afterCommand: then } = s;
  // A card whose fact is gone says so in its title when nothing else names it.
  const shown = s.title?.text ?? (gone ? `${kind.title}, since removed` : kind.title);
  const edit = editOf(s, gone);
  const posed = questionOf({
    ...s,
    said: s.proposed !== undefined ? s.proposed : (s.title?.text ?? null),
    asked: part("asked") ?? null,
    found: part("found") ?? null,
    change: s.fields.__change ?? null,
    goal: s.goal,
    first: card.kind === "same_person" ? personOf(s, 1) : s.first,
    second: card.kind === "same_person" ? personOf(s, 2) : s.second,
    address: card.kind === "shared_address" ? (addressOf(s) ?? personOf(s, 1)) : null,
    subject: s.draft.subject ?? null,
    to: s.draft.to ?? null,
  });
  return {
    question: posed.question,
    ...(posed.factAsk === undefined ? {} : { factAsk: posed.factAsk }),
    cites: [...s.cites.filter((one) => one.subject !== ""), ...mentionCites(card.mentions ?? [], s.cites)],
    replies: repliesOf(card, s, gone),
    commandWhy: s.command === null ? null : s.commandWhy,
    title: capital(shown),
    ...(s.title?.from === "agent" ? { agentTitled: titleAgent ?? agentWho(null) } : {}),
    sub: gone && s.title === null ? "Nothing left to check: dismiss it" : sub,
    from,
    rows: s.rows.filter((one) => one.v !== "").map((one) => (one.by === undefined ? one : { ...one, by: maker })),
    notes: s.notes,
    command: s.command,
    resolve: s.resolve,
    gone,
    ack: s.ack,
    fact: s.fact,
    ...(then === undefined ? {} : { then }),
    ...(s.ignore === undefined ? {} : { ignore: s.ignore }),
    ...(sections.length === 0 ? {} : { sections }),
    // A source the owner's reads did not name keeps no id: it opens nothing.
    ...(s.sources.length === 0
      ? {}
      : {
          sources: s.sources.map((one) =>
            one.words === "" ? { kind: one.kind, id: null, words: sourceRow(one.kind).unnamed } : one,
          ),
        }),
    ...(card.kind === "same_fact" && s.first !== null && s.second !== null
      ? { pair: { first: s.first, second: s.second } }
      : {}),
    ...(edit === undefined ? {} : { edit }),
  };
}

// The opened card's fixed rows: who said it and when, as the design orders them: the planner or an
// agent, with when; when alone where it is the system's own. A title in an agent's words says whose,
// by name where known, whoever raised the card; this row is where an opened card says it. An agent is
// otherwise a card's author by its id alone, never its name.
// `rowSaysWhen`: the row it opens under shows its time already (the desk's row; the phone's sheet
// does not), so the time is not said twice.
export function cardHead(
  card: CardView & { lines?: CardLine[] },
  shape: Pick<CardShape, "agentTitled">,
  rowSaysWhen = false,
): CardRow[] {
  // The title is the row's own line, so the opened card does not say it again.
  const when = capital(whenWords(card.createdAt));
  const who = shape.agentTitled !== undefined ? capital(shape.agentTitled) : authorWords(card.author);
  const said = who === "The system";
  return [
    ...(rowSaysWhen
      ? said
        ? []
        : [{ k: "Said by", v: who }]
      : [said ? { k: "When", v: when } : { k: "Said by", v: `${who} · ${when}` }]),
    // Every card here waits for an answer from the owner; only a deadline is worth a line.
    ...(card.expiresAt === null ? [] : [{ k: "Answer by", v: capital(whenWords(card.expiresAt)) }]),
  ];
}
