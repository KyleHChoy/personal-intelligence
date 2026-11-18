import type {
  CardLine,
  CardLineKey,
  CardLinePart,
  DecisionPointId,
  PersonalRef,
  WebWriteName,
} from "@intelligence/contracts/personal";
import type { DoneLabel } from "./card-words.ts";
import { whenWords } from "./time-words.ts";
import { wordsOf } from "./words.ts";

// The fixed tables that say a card's lines in plain words, read from each line's key and parts (the
// contract's CardLine): its sentences, codes, headings, field names and source kinds. No line's
// words are read for what they mean.

// Where a card's content came from, by the line it was read from, from one fixed map.
export const FROM_WORDS: Record<CardLine["from"], string> = {
  // A card line names no source kind.
  source: "From a source",
  model: "Inferred",
  agent: "From an agent",
  owner: "You said",
  code: "From the system",
};
// The page's write that rules again, by the lost ruling's verdict; a join has none, and is ruled
// again in the terminal.
export const RULE_AGAIN: Readonly<Record<string, { write: WebWriteName; words: DoneLabel }>> = {
  reject: { write: "rejectClaim", words: "Mark it not true again" },
  veto: { write: "vetoFact", words: "Never use it again" },
  retire: { write: "retireFact", words: "Mark it no longer true again" },
};
// A relation an audit asks about, as the verb of its question; any other reads "relate to".
export const RELATION_VERBS: Readonly<Record<string, string>> = {
  supports: "support",
  contradicts: "contradict",
  refines: "refine",
  same_fact: "say the same as",
};
export const plural = (n: string, one: string, many: string): string => `${n} ${n === "1" ? one : many}`;
// Code's sentences, each as the owner reads it.
export const SEALED = "Part of it is sealed under a key this page cannot open.";
// What a result of work not handed to the owner says of its answers; the Results feed says its own (results.tsx).
export const RESULT_NOTE =
  "Keep it if this was useful, or mark it not useful. Your answer is kept as your judgment of it; the work itself stays as it is.";
// What a line with no parts says, by its key.
export const SENTENCES = {
  pair_none: "The two facts have since been removed.",
  proposal_tainted: "What the proposal rested on has since been deleted.",
  release_note: "Confirming makes this your own fact, which every agent you allow to read your own facts can see.",
  handed: "No agent can carry this out yet: going ahead means you do it yourself.",
  own_question: "A question you wrote. Confirm it if it is a lasting need.",
  interpretation_note: "The statement is the agent's reading; the quotes are what it says you said.",
  never_written: "You have never written to one of these people.",
  refold:
    "A change in how addresses are grouped narrowed this ignore to the addresses it covered. Ignore the new domain to cover all of it.",
  link_opened: "The site's owner will learn the link was opened.",
  makes_public:
    "Approving records that these pages are about this subject, which any agent you let read public information can see.",
  private_together: "Together these may say something private about this person.",
  veto_in_force: "A veto of yours is in force on this fact: confirming changes nothing until you lift it.",
  not_releasable: "Confirming will not add this person: the record cannot become your own.",
  erased_identifier: "Confirming will not add this person: the address belongs to someone you erased.",
  already_known: "Already known: confirming adds this contact to the person you know, never a second person.",
  no_identifier: "Confirming adds a new person at the next sync. A name alone never joins anyone.",
  makes_person:
    "Confirming adds this person at the next sync. A name alone never joins anyone; a shared name asks you first.",
  relation_question: "Does the first statement relate to the second as shown?",
} as const satisfies Partial<Record<CardLineKey, string>>;
// What was removed, by a `removed` line's code.
export const REMOVED: Readonly<Record<string, string>> = {
  claim: "The fact it was about has since been removed.",
  record: "The agent's record has since been removed.",
  proposal: "The proposal has since been removed.",
  capture: "The meeting has since been removed.",
  project: "The project has since been removed.",
};
// What is gone, by a `gone` line's code.
export const GONE: Readonly<Record<string, string>> = {
  claim: "One of the facts has since been removed.",
  from: "The first statement has since been removed.",
  to: "The second statement has since been removed.",
  relation: "The relation has since been removed.",
};
// Why two records may be one person, by an `identity_basis` line's code.
export const IDENTITY_BASIS: Readonly<Record<string, string>> = {
  shared_address: "One address is on two of your contacts under different names.",
  contact: "One of your contacts lists both.",
  name: "They share a name.",
};
// What a rule from the owner's answers is about, in words, by its pattern (kind:detail), and what yes does.
const ruleSubject = (pattern: string): string => {
  const [kind, detail = "", known = ""] = pattern.split(":");
  const plain = detail.replaceAll("_", " ");
  if (kind === "about_you") return `facts an agent says about you, of the kind "${plain}"`;
  if (kind === "agent_claim") return `facts an agent reports, of the kind "${plain}"`;
  if (kind === "idea") return "the planner's ideas";
  if (kind === "opportunity_decision") return `work an agent proposes, of the kind "${plain}"`;
  const how =
    detail === "local_part"
      ? "one's address spells the other's name"
      : detail === "name"
        ? "they share a name"
        : detail === "contact"
          ? "one contact lists both"
          : "something else links them";
  const who = known === "2" ? "you know both" : known === "1" ? "you know one of them" : "you know neither";
  return `pairs of records where ${how} and ${who}`;
};
const ruleAnswerWord = (answer: string): string =>
  answer === "same" ? "one person" : answer === "different" ? "two people" : "no";
export const ruleQuestion = (count: number, pattern: string, answer: string): string =>
  pattern.startsWith("same_person:")
    ? `Your last ${count} answers on ${ruleSubject(pattern)} were all "${ruleAnswerWord(answer)}". Rule every such pair ${ruleAnswerWord(answer)} from now on, without asking?`
    : `Your last ${count} answers on ${ruleSubject(pattern)} were all "${ruleAnswerWord(answer)}". Stop asking about these?`;
export const ruleEffect = (pattern: string): string =>
  pattern.startsWith("same_person:")
    ? "Yes makes a ruling on each such pair without asking you, marked as the rule's. You can lift any one, or the rule. No keeps asking, and this is not proposed again."
    : "Yes stops these reaching you. Each stays on record and can be reopened; it changes no fact and starts no work. No keeps asking, and this is not proposed again.";

// What was tried on a pair, by the codes of an `identity_tried` line.
export const TRIED_WORDS: Readonly<Record<string, string>> = {
  unestablished: "one of them is on no contact and was never written to",
  common_name: "several people carry the name",
  ruled_different: "you set one of them apart from someone else",
  lifted_before: "you split them before",
  name: "they share a name",
  local_part: "an address spells the other's name",
  contact: "a contact lists both",
  phone: "two contacts hold one phone",
  no_evidence: "nothing to go on",
  name_only: "all they share is a name",
  conflicting_evidence: "the evidence conflicts",
  not_answered: "no agent answered it",
  excepted: "you split them before",
};
// Where a model decides for the owner (the ladder's decision points), in words; null says it only as
// "a step where a model decides for you".
const POINT_WORDS: Readonly<Record<DecisionPointId, string | null>> = {
  wake_worth_run: "Whether the planner should run",
  run_outcome: "How a planner run turned out",
  opportunity_go: "Whether proposed work goes ahead",
  owner_question: "Which questions to ask you",
  move_clear: "Whether an agent's step may start",
  extract_triage: "Which new mail is worth reading",
  extract_claims: "Facts read from your mail",
  extract_injection: null,
  extract_sensitivity: null,
  send_clear: "Whether a message may be sent",
  send_first_contact: null,
  draft_disclosure: null,
  identity_candidate: null,
  identity_ruling: "Who is the same person",
  extract_recovery: null,
  record_injection: null,
  identity_rank: "Who is the same person",
  claims_same_fact: "Which facts say the same thing",
  belief_change: null,
  project_link: null,
  record_echo: null,
  change_worth_run: null,
  forecast_wait: null,
  about_you: "What is said about you",
  client_preference: null,
  restrict_category: null,
  claims_standalone: null,
  claims_said: null,
  task_go: null,
};
export const pointWords = (point: string): string | null =>
  Object.hasOwn(POINT_WORDS, point) ? POINT_WORDS[point as DecisionPointId] : null;
// A proposal's line as code writes it for the terminal ("Prefers (travel): window seats", core's
// proposalLine): a title says what it is, not its part of life in brackets.
// Its lead is any words before the bracketed domain, as core writes it: a preference's polarity
// reads into the sentence ("Prefers window seats"), any other lead keeps its kind ("Goal: ...").
const PROPOSAL_LINE = /^([^(:]+?) \([a-z_ ]+\): ([\s\S]+)$/;
const POLARITY_LEADS: ReadonlySet<string> = new Set(["Likes", "Dislikes", "Prefers", "Avoids"]);
export function proposalWords(text: string): string {
  const found = PROPOSAL_LINE.exec(text);
  if (found === null) return text;
  const [, lead = "", rest = ""] = found;
  return POLARITY_LEADS.has(lead) ? `${lead} ${rest}` : `${lead}: ${rest}`;
}
// Why a run stopped, by its code.
export const RUN_CODES: Readonly<Record<string, string>> = {
  budget_exceeded: "it reached its spending cap",
  cap_reached: "it reached its spending cap",
  timeout: "it ran out of time",
  model_error: "the model answered with an error",
  invalid_output: "the model's answer could not be read",
  tool_error: "a tool it used failed",
  cancelled: "it was cancelled",
};
// A work row's headings, by a `heading` line's code, as its rows' names.
export const HEADING_WORDS: Readonly<Record<string, string>> = {
  deliverable: "Delivered",
  draft: "Draft",
  next: "Next step",
  uncertain: "Not sure about",
  reason: "Reason",
  "why now": "Why now",
  plan: "Plan",
  "decision needed": "Decision needed",
  risks: "Risks",
  why: "Why",
  "proposed words": "Proposed words",
  "proposed target": "Who it would be after",
};
// A result's parts, by the store's headings (card-kinds-outcome.ts), as its sections' headings, in
// the order they are shown. "asked" is said by who asked, below.
export const OUTCOME_PARTS: Readonly<Record<string, string>> = {
  asked: "What was asked",
  found: "What was found",
  deliverable: "What it delivered",
  draft: "Its draft",
  next: "Next step",
  uncertain: "Not sure about",
  reason: "Why it stopped",
};
// Who asked for the work, by the store's words: as a line starts, and inside a sentence.
export type Asker = { said: string; within: string };
export const ASKERS: Readonly<Record<string, Asker>> = {
  you: { said: "You", within: "you" },
  "the planner": { said: "The planner", within: "the planner" },
  "the system": { said: "The system", within: "the system" },
  "an agent": { said: "An agent", within: "an agent" },
};
// A source by its kind: how its row is headed, what is said of one the owner's reads do not name (held,
// outside what they see, withheld or flagged), how it is counted, and whether it is the owner's own (their
// mail, their meetings, their documents). Any other kind reads as a source.
type SourceRow = { heading: string; unnamed: string; counted: readonly [string, string]; own: boolean };
const A_SOURCE: SourceRow = {
  heading: "Source",
  unnamed: "A source not named here",
  counted: ["source", "sources"],
  own: false,
};
const SOURCE_KINDS: Readonly<Record<PersonalRef["kind"] | "agent_record", SourceRow>> = {
  message: {
    heading: "Message",
    unnamed: "A message held back from this page, or since removed",
    counted: ["message", "messages"],
    own: true,
  },
  entity: {
    heading: "Person",
    unnamed: "A person held back from this page, or since removed",
    counted: ["person", "people"],
    own: false,
  },
  agent_record: {
    heading: "An agent's finding",
    unnamed: "A finding no longer kept",
    counted: ["finding", "findings"],
    own: false,
  },
  event: {
    heading: "Meeting",
    unnamed: "A meeting held back from this page, or since removed",
    counted: ["meeting", "meetings"],
    own: true,
  },
  document: {
    heading: "Document",
    unnamed: "A document held back from this page, or since removed",
    counted: ["document", "documents"],
    own: true,
  },
  page: { ...A_SOURCE, heading: "Page an agent cited", counted: ["web page", "web pages"] },
  capture: A_SOURCE,
};
export const sourceRow = (kind: string): SourceRow =>
  Object.hasOwn(SOURCE_KINDS, kind) ? SOURCE_KINDS[kind as keyof typeof SOURCE_KINDS] : A_SOURCE;
// A claim's field names in words, where the name said plainly ("due" as "Due") is not enough.
const FIELD_KEYS: Readonly<Record<string, string>> = {
  object: "What",
  objective: "Goal",
  state: "Situation",
  organization_name: "Organization",
  counterparty: "With",
  polarity: "Leaning",
  domain: "Part of your life",
  known_how: "Known through",
  linkedin: "LinkedIn",
  other: "Other person",
  url: "Address",
};
export const fieldKey = (name: string): string => FIELD_KEYS[name] ?? wordsOf(name);
// An ISO time inside the words a model or an agent wrote, said in words; code's times are parts.
const ISO = /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;
export const timesInWords = (text: string): string => text.replace(ISO, (at) => whenWords(at));
// A value an agent wrote as JSON: its words, or the value as written.
export function unquoted(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.filter((one) => typeof one === "string").join(", ");
  } catch {
    // Not JSON: the words as written.
  }
  return text;
}

// A line's parts, read by position as the contract's cardLineText writes them.
const partAt = (line: CardLine, at: number): CardLinePart | undefined => line.value?.[at];
// A part's code, or null.
export const codeAt = (line: CardLine, at = 0): string | null => {
  const part = partAt(line, at);
  return part?.kind === "code" ? part.code : null;
};
// A part's words: a text's or a code's, else null.
export const wordsAt = (line: CardLine, at = 0): string | null => {
  const part = partAt(line, at);
  return part?.kind === "text" ? part.text : part?.kind === "code" ? part.code : null;
};
// A part's row, by its kind and id, or null.
export const idAt = (line: CardLine, at = 0): { of: string; id: string } | null => {
  const part = partAt(line, at);
  return part?.kind === "id" ? { of: part.of, id: part.id } : null;
};
// A part's time, or null.
export const timeAt = (line: CardLine, at = 0): string | null => {
  const part = partAt(line, at);
  return part?.kind === "time" ? part.at : null;
};
// A part's count, or null.
export const countAt = (line: CardLine, at = 0): number | null => {
  const part = partAt(line, at);
  return part?.kind === "count" ? part.n : null;
};
