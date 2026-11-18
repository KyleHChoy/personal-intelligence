import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { EntityId, GoalId, MessageId } from "./ids.ts";
import { FactId } from "./tools-args.ts";

// Who wrote a line of a card.
export const LineSource = z.enum(["code", "source", "model", "agent", "owner"]);
export type LineSource = z.infer<typeof LineSource>;

// What a code line names by id: a person, a message, a goal or a fact. The store sets them where it
// writes the line, so a page reads ids from here and never from the line's words.
export const CardLineRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), id: EntityId }),
  z.strictObject({ kind: z.literal("message"), id: MessageId }),
  z.strictObject({ kind: z.literal("goal"), id: GoalId }),
  z.strictObject({ kind: z.literal("fact"), id: FactId }),
]);
export type CardLineRef = z.infer<typeof CardLineRef>;
// The most refs one line carries.
export const CARD_LINE_REFS_MOST = 10;

// One part of what a line says, typed: words, a fixed code (a kind, a stage, a status), a time, a
// count, or a row by its kind and id.
export const CardLinePart = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("code"), code: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("time"), at: Timestamp }),
  z.strictObject({ kind: z.literal("count"), n: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("id"), of: z.string().min(1).max(40), id: z.string().min(1).max(200) }),
]);
export type CardLinePart = z.infer<typeof CardLinePart>;
// The most parts one line carries.
const CARD_LINE_PARTS_MOST = 40;

// Where a page finds the parts of the lines it reads by more than their first.
export const LINE_PARTS = {
  // The ruling, its verdict, the generation, how many past the listed, then each listed candidate.
  ruling_lost: { verdict: 1, candidates: 4 },
  known_by: { person: 0, contacts: 1, sent: 2, received: 3, meetings: 4 },
  confirmed: { confirmed: 0, answers: 1 },
  not_true: { marked: 0, kept: 1 },
  grant_command: { which: 0, agent: 1, kind: 2 },
} as const;
// A line's parts by name, each where LINE_PARTS says.
export const partsAt = <K extends keyof typeof LINE_PARTS>(
  key: K,
  named: Readonly<Record<keyof (typeof LINE_PARTS)[K], CardLinePart>>,
): CardLinePart[] => {
  const out: CardLinePart[] = [];
  const places = LINE_PARTS[key] as Readonly<Record<string, number>>;
  for (const [name, place] of Object.entries(places))
    out[place] = (named as Readonly<Record<string, CardLinePart>>)[name] as CardLinePart;
  return out;
};
// The terminal command a `grant_command` line names.
export const grantCommand = (which: string, agent: string, kind: string): string =>
  `pia facts ${which === "grant" ? "grant" : "grant-lift"} ${agent} ${kind}`;

// What a line is, by its kind: the store's line builders set it and its parts, and `cardLineText`
// renders the terminal's words from them, so a page reads the parts and never the words. Each key's
// parts, in order, are as `cardLineText` reads them.
export const CARD_LINE_KEYS = [
  // A card's own columns.
  "kind",
  "author",
  "requester",
  "at",
  "target",
  "ref",
  "request",
  "case",
  "report",
  "draft",
  "read_draft",
  "see_it",
  "record_dump",
  "health",
  "about",
  "fact_key",
  "judge",
  "host",
  "stored_under",
  "gate",
  // A sentence of code's, with no parts, or one code.
  "removed",
  "unreadable",
  "gone",
  "body_none",
  "pair_none",
  "proposal_none",
  "proposal_tainted",
  "trait_gone",
  "release_note",
  "handed",
  "own_question",
  "interpretation_note",
  "never_written",
  "refold",
  "link_opened",
  "makes_public",
  "private_together",
  "veto_in_force",
  "not_releasable",
  "erased_identifier",
  "already_known",
  "no_identifier",
  "makes_person",
  "relation_question",
  "tier_since",
  "tier_note",
  "time_effort",
  "time_effort_note",
  "time_yes_lost",
  "task",
  "source_unnamed",
  "cited_message",
  "goal_effect",
  "identity_basis",
  "identity_tried",
  "agent_answer",
  "relayed_answer",
  "checked",
  "question_rule",
  "mark",
  "run_failed",
  "point",
  "confirm_records",
  "ruling_lost",
  "interpretation",
  "private_identifier",
  "binds",
  "known_by",
  "heading",
  "asked_by",
  "source",
  "identifier",
  "subject",
  "type",
  "cited",
  "work",
  "follows_from",
  "move",
  "fact_a",
  "fact_b",
  "claim",
  "from",
  "to",
  "relation",
  "client",
  "restated",
  "first",
  "last",
  "goal",
  "goal_status",
  "change",
  "compartment_proposed",
  "target_proposed",
  "target_held_by",
  "target_name_label",
  "target_holders_changed",
  "target_pick",
  "template",
  "url",
  "link_message",
  "project",
  "ruling",
  "unnamed",
  "tier",
  "tier_already",
  "tier_proposed",
  "trait",
  "trait_as",
  "basis",
  "person",
  // A line whose words a source or an agent wrote, under a name code gives it.
  "field",
  "says_you_said",
  "you_told",
  "add_person",
  "to_you",
  "link",
  "proposal_basis",
  "statement",
  "meeting_title",
  "calendar_title",
  "start",
  "draft_subject",
  "draft_to",
  // A confirm rate's proposal card: the kind of fact, the counts, and the command it proposes.
  "fact_kind",
  "confirmed",
  "not_true",
  "grant_command",
  "answer_note",
] as const;
export const CardLineKey = z.enum(CARD_LINE_KEYS);
export type CardLineKey = z.infer<typeof CardLineKey>;

// One line of a card. `refs` is absent when a line names nothing, and only code's lines carry it.
// `key` and `value` are what it says, set by the store; a model's line is its words alone, and a line
// with no key (a body stored before keys, or one the store does not key) is shown as its words.
export const CardLine = z
  .strictObject({
    text: z.string(),
    from: LineSource,
    refs: z.array(CardLineRef).min(1).max(CARD_LINE_REFS_MOST).optional(),
    key: CardLineKey.optional(),
    value: z.array(CardLinePart).min(1).max(CARD_LINE_PARTS_MOST).optional(),
  })
  .refine((line) => line.refs === undefined || line.from === "code", {
    message: "only code's lines carry refs",
    path: ["refs"],
  })
  .refine((line) => line.from !== "model" || (line.key === undefined && line.value === undefined), {
    message: "a model's line is its words alone",
    path: ["key"],
  })
  .refine((line) => line.value === undefined || line.key !== undefined, {
    message: "a value needs a key",
    path: ["value"],
  })
  .refine((line) => line.from === "code" || (line.value ?? []).every((part) => part.kind !== "id"), {
    message: "only code's lines carry ids",
    path: ["value"],
  });
export type CardLine = z.infer<typeof CardLine>;

// ---------------------------------------------------------------------------------------------
// The terminal's words of a keyed line
// ---------------------------------------------------------------------------------------------

// The fixed sentences, word for word what the terminal shows.
const SENTENCES: Partial<Record<CardLineKey, string>> = {
  record_dump: "to record a dump: pi backup taken",
  body_none: "body: none (tainted, or a compartment the key file lacks)",
  pair_none: "pair: none",
  proposal_none: "proposal: none",
  proposal_tainted: "proposal_tainted",
  trait_gone: "trait: gone, so confirming sets nothing",
  release_note: "confirming makes this your own fact, shared with every agent cleared for own",
  handed: "no registered agent can carry this out before the send item is built; go means you will do it yourself",
  own_question: "asked: a question you wrote; confirm it if it is a lasting need",
  interpretation_note: "interpretation: the statement is the agent's words; the quotes are what it says you said",
  never_written: "warning: the owner has never written to one of these people",
  refold: "a refold narrowed this domain ignore to the addresses it covered; ignore the new domain to cover all of it",
  link_opened: "the site's owner will learn this link was opened",
  makes_public: "approving makes public, to every client cleared for public, that these pages are about this subject",
  private_together: "these values together may state a private fact about this person",
  veto_in_force: "a veto or retire of yours on this fact is in force: confirming releases nothing until you lift it",
  not_releasable: "this record cannot be released to your own label, so confirming makes no person",
  erased_identifier: "its identifier belongs to a person you erased: confirming makes no person",
  already_known:
    "already known: its identifier is this person's; confirming adds this contact to them, never a second person",
  no_identifier:
    "no identifier: confirming makes a new person at the next sync, keyed by this proposal; a name never joins anyone, so a person you erased can be proposed again by name",
  makes_person:
    "confirming makes this person at the next sync, under your own label; a name never joins anyone, and a shared name raises a same_person card",
  relation_question: "question: does the first statement stand in this relation to the second?",
  tier_since: "ruled on by you since, kept as you set them:",
  time_effort_note:
    "yes makes a project of this time and credits it; no keeps it unattributed and never proposes it again",
  time_yes_lost:
    "your yes on a time card made no project: the Mac has since replaced that day and none of that time is left in it. If it comes back it will be asked again",
  tier_note:
    "confirm sets each proposed one's tier, one ruling each; reject is remembered until you set this tier for another of them",
  task: "task",
  source_unnamed: "source_unnamed",
  trait_as: "as:",
  answer_note: "answering changes nothing else; the command is yours to run",
};
// What accepting a goal proposal does, by its change.
const GOAL_EFFECT_TEXT: Readonly<Record<string, string>> = {
  add: "accept adds this as your goal, as pi goal add does; --compartment seals it under another compartment of yours",
  reword: "accept gives your goal these words, as your own",
  pause: "accept pauses your goal",
  done: "accept marks your goal done",
  drop: "accept drops your goal",
  target: "accept makes this what your goal is after, as pia goal target does",
};
// Why two records may be one person, by code's basis.
const IDENTITY_BASIS_TEXT: Readonly<Record<string, string>> = {
  contact: "basis: contact",
  name: "basis: name",
  shared_address: "basis: one address on two contacts under different names",
};
// The trait a tier proposal's people share, by its kind.
const TRAIT_TEXT: Readonly<Record<string, string>> = {
  organization: "trait: they are affiliated with",
  role: "trait: their role is",
  relation: "trait: their relation to you is",
};

// The name a key's line is written under, where it is not the key itself.
const LABELS: Partial<Record<CardLineKey, string>> = {
  fact_key: "fact",
  fact_kind: "fact kind",
  fact_a: "fact a",
  fact_b: "fact b",
  goal_status: "status",
  compartment_proposed: "compartment proposed",
  target_proposed: "target proposed",
  target_held_by: "held by",
  target_name_label: "kept with the goal, under",
  target_holders_changed: "someone came to hold this name after the card was raised",
  target_pick: 'to see who holds it and pick: pia goal target ID --name "NAME"',
  follows_from: "follows from",
  asked_by: "asked by",
  run_failed: "run failed",
  says_you_said: "the agent says you said",
  proposal_basis: "basis",
  meeting_title: "title",
  calendar_title: "calendar title",
  draft_subject: "subject",
  draft_to: "to",
  request: "request",
  report: "report",
  draft: "draft",
  goal: "goal",
  ruling: "ruling",
};

// A part as the terminal writes it: an id with its kind before it.
function partText(part: CardLinePart | undefined): string {
  if (part === undefined) return "";
  switch (part.kind) {
    case "text":
      return part.text;
    case "code":
      return part.code;
    case "time":
      return part.at;
    case "count":
      return String(part.n);
    case "id":
      return `${part.of} ${part.id}`;
  }
}
// A part's own words: an id alone, without its kind.
const bare = (part: CardLinePart | undefined): string => (part?.kind === "id" ? part.id : partText(part));

// The terminal's words of a keyed line, from its key and its parts.
export function cardLineText(key: CardLineKey, value: readonly CardLinePart[] = []): string {
  const sentence = SENTENCES[key];
  if (sentence !== undefined) return sentence;
  const [a, b, c] = value;
  const all = value.map(partText).join(" ");
  switch (key) {
    case "cited_message":
      return b === undefined ? bare(a) : `${bare(a)} · from ${bare(b)}`;
    case "request":
    case "report":
    case "draft":
    case "fact_a":
    case "fact_b":
    case "goal":
    case "ruling":
      return `${LABELS[key]}: ${bare(a)}`;
    case "read_draft":
      return `to read it: pi send show ${bare(a)}`;
    case "see_it":
      return `to see it: pi ${all}`;
    case "removed":
      return `${all}_removed`;
    case "unreadable":
      return `${all}_unreadable`;
    case "gone":
      return `${all}: gone`;
    case "stored_under":
      return `stored under: web account ${all}, label ${all}`;
    case "gate":
      return `gate: ${value.map(partText).join(", ")}`;
    case "goal_effect":
      return GOAL_EFFECT_TEXT[partText(a)] ?? partText(a);
    case "identity_tried":
      return `pair ${partText(a)}: tried ${partText(value[1])}; ${partText(value[2])}`;
    case "checked": {
      // The searches' count, the sources' count, then each search's tool (a code) and each source (an id).
      const tools = value
        .slice(2)
        .filter((one) => one.kind === "code")
        .map(partText);
      const sources = value
        .slice(2)
        .filter((one) => one.kind === "id")
        .map(bare);
      return `checked first: ${partText(a)} searches, ${partText(b)} sources (${[...tools, ...sources].join(", ")})`;
    }
    case "agent_answer":
      return `an agent tried this first: ${partText(a)} answered ${partText(b)}, citing ${partText(c)} sources. The answer is the agent's, not yours`;
    case "relayed_answer":
      return `${partText(a)} asked you this in conversation and passed on your answer: ${partText(b)}. Your own answer here outranks it`;
    case "question_rule":
      return `the last ${partText(a)} answers on ${partText(value[1])} were all ${partText(value[2])}`;
    case "identity_basis":
      return IDENTITY_BASIS_TEXT[partText(a)] ?? `basis: ${partText(a)}`;
    case "trait":
      return TRAIT_TEXT[partText(a)] ?? `trait: ${partText(a)}`;
    case "mark":
      return all;
    case "point":
      return b === undefined ? `point: ${partText(a)}` : `point: ${partText(a)}@${partText(b)}`;
    case "confirm_records":
      return partText(a) === "quote"
        ? `confirm records the quote as your own words, given through ${partText(b)}`
        : `confirm records this fact as your own word, given through ${partText(b)}`;
    case "ruling_lost": {
      // The ruling, its verdict, the generation, how many candidates past the listed ones, then each
      // listed candidate.
      const listed = value.slice(LINE_PARTS.ruling_lost.candidates).map(bare);
      const more = value[3]?.kind === "count" && value[3].n > 0 ? `; more candidates: ${value[3].n}` : "";
      const named =
        listed.length === 0 ? "none found, the facts it named were made again under other keys" : listed.join(" ");
      return `ruling ${bare(a)} (${partText(b)}) lost its claim at generation ${partText(c)}; candidates: ${named}${more}; which claim does it apply to? Rule again on that claim with the ruling's own command, then acknowledge`;
    }
    case "interpretation":
      return `${partText(a)}'s interpretation:`;
    case "private_identifier":
      return `${partText(a)}: known only from your private sources; the search vendor will see it`;
    case "binds":
      return `approving binds these pages to ${bare(a)} (${partText(b)}), whom your own sources know`;
    case "known_by": {
      const [, contacts, sent, received, meetings] = value.map(partText);
      return `person ${partText(a)} known by: contacts ${contacts}, mail sent ${sent}, mail received ${received}, meetings ${meetings}`;
    }
    case "heading":
      return `${all}:`;
    case "identifier": {
      const held = value.slice(2).map(partText);
      return `${partText(a)}: ${partText(b)} (held under: ${held.length === 0 ? "nothing" : held.join(", ")})`;
    }
    case "subject":
      return `subject: ${value.map(bare).join(" ")}`;
    case "claim":
    case "from":
    case "to":
      return [`${key}: ${bare(a)}`, ...value.slice(1).map(partText)].join(" ");
    case "work":
      return `${partText(a)}: ${partText(b)}`;
    case "first":
    case "last":
      return `${key}: ${a === undefined ? "none" : partText(a)}`;
    case "template":
      return `template: ${partText(a)}: ${partText(b)}`;
    case "link_message":
      return `message: ${bare(a)}, sent ${partText(b)} by ${partText(c)}`;
    case "unnamed":
      return `${partText(a)}: ${bare(b)}`;
    case "person":
      return `person ${partText(a)}: ${bare(b)}`;
    case "tier_already":
      return `already ${all}, set by you in the last 30 days:`;
    case "confirmed":
      return b === undefined ? "confirmed: none counted" : `confirmed: ${partText(a)} of the last ${partText(b)}`;
    case "not_true":
      return `not true: ${partText(a)} of ${partText(b)} kept`;
    // Its parts: grant or lift, the agent's name, the kind.
    case "grant_command":
      return `${partText(a) === "grant" ? "to keep them without asking" : "to ask you again"}: ${grantCommand(partText(a), partText(b), partText(c))}`;
    case "time_effort":
      return `a new effort? ${partText(a)} minutes over ${partText(b)} days under no project:`;
    case "tier_proposed":
      return `proposed for ${all}, not yet ruled on by you:`;
    case "field":
      return `${partText(a)}: ${partText(b)}`;
    case "you_told":
      return `you told ${partText(a)}: ${partText(b)}`;
    case "add_person":
      return `add a person: ${partText(a)}, known as: ${partText(b)}`;
    case "to_you":
      return `to you: ${partText(a)}, closeness ${partText(b)}`;
    case "link":
      return b === undefined ? `link: ${partText(a)}` : `link: ${partText(a)} (inferred, no source states it)`;
    default:
      return `${LABELS[key] ?? key}: ${all}`;
  }
}

// A keyed line: its words rendered from its key and parts. `refs` are kept as a code line's are.
export function keyedLine(
  from: LineSource,
  key: CardLineKey,
  value: readonly CardLinePart[] = [],
  refs: readonly CardLineRef[] = [],
): CardLine {
  return {
    text: cardLineText(key, value),
    from,
    ...(refs.length === 0 ? {} : { refs: refs.slice(0, CARD_LINE_REFS_MOST) }),
    key,
    ...(value.length === 0 ? {} : { value: [...value] }),
  };
}

// What a proposed target with no name of theirs is called: code's words, which a question lowers.
export const TARGET_NO_NAME = "Someone you have no name for";

export const linePart = {
  text: (text: string): CardLinePart => ({ kind: "text", text }),
  code: (code: string): CardLinePart => ({ kind: "code", code }),
  time: (at: string): CardLinePart => ({ kind: "time", at }),
  count: (n: number): CardLinePart => ({ kind: "count", n }),
  id: (of: string, id: string): CardLinePart => ({ kind: "id", of, id }),
};
