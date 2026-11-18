import type { KnownCardKind } from "@intelligence/contracts/personal";
import { KIND_REGISTRY_DATA } from "@intelligence/contracts/personal/kinds";
import { RUN_CODES } from "./card-lines.ts";
import type { CardRead } from "./card-read.ts";
import type { FactAsk } from "./card-shape.ts";
import { RELATIONSHIP_WORDS } from "./enum-words.ts";
import { goalChangeOf } from "./goal-change-words.ts";
import { capital, told, unstop } from "./words.ts";

// Every card asks the owner one crisp question in plain English,
// made by code from the card's content, and its answers are plain replies, each saying what it does.
// The question is all a card shows by default, with the message it came from; the rest is behind
// "Show the evidence" (card-parts.tsx CardBody). No model writes a question: these are templates.

// What a card's content gives its question: most of what its lines said as they were read (card-read.ts),
// and what cards.ts `cardShape` makes of them.
export type QuestionParts = Pick<
  CardRead,
  "kind" | "type" | "fields" | "about" | "gone" | "yours" | "run" | "where" | "verdict" | "candidates" | "agent"
> & {
  // The card's content as one sentence (the fact as stored, the proposed work, the planner's words).
  said: string | null;
  // An outcome on work handed to the owner (theirs to do), or a result of work not handed to them.
  handed: boolean;
  asked: string | null;
  found: string | null;
  // A goal proposal: its change, the goal's words now and the words proposed.
  change: string | null;
  goal: string | null;
  // Same person, shared address, same fact and relation audit: the two sides by name or words.
  first: string | null;
  second: string | null;
  address: string | null;
  // A draft's subject and to whom.
  subject: string | null;
  to: string | null;
  // An ignore's new domains.
  domains: readonly string[];
};

// A question that leaves a fact's words to be filled once read (a notice about one fact, read for
// its words): `before` the words, quoted, then `after`; "this fact" until they are read. `told`: a
// card with one answer says what happened, a statement, not a question;
// until its fact's words are read it says `told` itself.
export const factQuestion = (ask: FactAsk, words: string | null): string =>
  ask.told !== undefined
    ? words === null
      ? ask.told
      : `${ask.before} "${unstop(words)}"${ask.after === "" ? "" : ` ${ask.after}`}`
    : `${ask.before} ${words === null ? "this fact" : `"${unstop(words)}"`}${ask.after === "" ? "" : ` ${ask.after}`}?`;

// An imperative, its first verb lowered so it reads inside a question ("Write back" to "write
// back"), or null where the words do not open with a verb this list knows: a name is never lowered.
const VERBS = new Set(
  "add apply ask book buy call cancel check choose collect compare confirm contact draft email explore finish find follow gather get introduce invite join learn list look make meet message pay plan prepare propose read reach register remind reply research review schedule send set share sign start tell thank try update visit write".split(
    " ",
  ),
);
const imperative = (text: string): string | null => {
  const found = /^([A-Z][a-z]+)(\s[\s\S]*)$/.exec(unstop(text));
  return found !== null && VERBS.has((found[1] ?? "").toLowerCase())
    ? `${(found[1] ?? "").toLowerCase()}${found[2] ?? ""}`
    : null;
};
// A situation that reads after "Are you currently": a state that starts with an -ing verb or a word
// of place or condition ("moving flats", "on parental leave", "between jobs").
const STATE_LEADS = new Set(
  "on in at between away off out abroad without not still back home living based recovering unemployed employed self-employed retired pregnant engaged married single sick ill injured busy travelling traveling".split(
    " ",
  ),
);
// Words ending in -ing that are not verbs.
const ING_NOUNS = new Set(
  "spring something nothing anything everything thing king ring string wing morning evening wedding building ceiling sibling darling during ping sing swing bring sting duckling pudding clothing housing funding earring offspring".split(
    " ",
  ),
);
const readsAsState = (state: string): boolean => {
  const first = state.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return (first.endsWith("ing") && first.length > 5 && !ING_NOUNS.has(first)) || STATE_LEADS.has(first);
};
const lowerState = (state: string): string =>
  /^[A-Z][a-z-]+(\s|$)/.test(state) ? state.charAt(0).toLowerCase() + state.slice(1) : state;
// "Dana Example is your sister" asked: "Is Dana Example your sister?". Only a short plain subject
// (no comma, no clause of its own) before the one "is"; anything else is asked "Is this right".
const asYesNo = (sentence: string): string | null => {
  const found = /^([^,;:]+?) is (.+)$/.exec(unstop(sentence));
  const subject = found?.[1] ?? "";
  if (
    found === null ||
    subject.split(/\s+/).length > 5 ||
    /\b(who|which|that|whose)\b/i.test(subject) ||
    / is /.test(found[2] ?? "")
  )
    return null;
  return `Is ${subject.replace(/^(The|A|An) /, (article) => article.toLowerCase())} ${found[2]}?`;
};
// What an agent found, less the citation it closes on (", per the finding ..."), which the card's
// sources list: the question asks about the finding, never about its source.
// Only a closing clause after a comma, with no clause of its own after it; never the whole text.
const uncited = (text: string): string => {
  const cut = unstop(text).replace(
    /, (?:per|according to|citing) (?:the|a) (?:finding|message|record|source)\b[^,;]*$/i,
    "",
  );
  return cut.trim() === "" ? unstop(text) : cut;
};
const rightThat = (sentence: string): string => `Is this right: ${told(sentence)}?`;

// A fact's question is the kind registry's (`ontology/kinds.json`, `ask`), so the dashboard's words
// for a kind cannot drift from the registry: about the owner (`you`), about someone else (`them`), and
// `otherwise` where the first does not read.
type KindAsk = { you: string; them: string; otherwise?: string };
const ASKS = KIND_REGISTRY_DATA.kinds as unknown as Readonly<Record<string, { ask: KindAsk }>>;
// A preference's polarity as the verb after "Do you"; an affiliation's relation after "as".
const POLARITY_VERBS: Readonly<Record<string, string>> = {
  prefers: "prefer",
  avoids: "avoid",
  likes: "like",
  dislikes: "dislike",
};
const AFFILIATION_AS: Readonly<Record<string, string>> = {
  employee: "an employee",
  founder: "a founder",
  owner: "an owner",
  member: "a member",
  student: "a student",
  alumnus: "a former student",
  advisor: "an advisor",
  investor: "an investor",
  board: "a board member",
  contractor: "a contractor",
  volunteer: "a volunteer",
};
const valueWords = (kind: string, field: string, value: string): string | null => {
  if (field === "polarity") return POLARITY_VERBS[value] ?? null;
  if (field === "relation" && kind === "affiliation") return AFFILIATION_AS[value] ?? null;
  if (field === "relation")
    return (RELATIONSHIP_WORDS as Readonly<Record<string, string>>)[value] ?? value.replaceAll("_", " ");
  return told(value);
};

// A registry template filled: `{field}` its value in words, `{a|b}` the first present, `[...]` only
// when every field in it is present; null when a field outside brackets is missing.
function fillAsk(
  kind: string,
  template: string,
  fields: Readonly<Record<string, string>>,
  who: string,
  whose: string,
): string | null {
  let missing = false;
  const fill = (text: string): string =>
    text.replace(/\{([a-z_|]+)\}/g, (_match, names: string) => {
      for (const name of names.split("|")) {
        if (name === "who") return who;
        if (name === "whose") return whose;
        const value = fields[name];
        const words = value === undefined || value.trim() === "" ? null : valueWords(kind, name, value);
        if (words !== null) return words;
      }
      missing = true;
      return "";
    });
  const optional = template.replace(/\[([^\]]*)\]/g, (_match, inner: string) => {
    const was = missing;
    missing = false;
    const filled = fill(inner);
    const lacks = missing;
    missing = was;
    return lacks ? "" : filled;
  });
  const out = fill(optional);
  return missing ? null : out;
}

// A fact's question, about the owner or about someone by name, from the registry.
function aboutFact(parts: QuestionParts, you: boolean): string {
  const { type, said } = parts;
  const who = you ? "you" : (parts.about ?? "this person");
  const fallback = (): string =>
    said === null
      ? you
        ? "Is this true of you?"
        : `Is this right about ${who}?`
      : you
        ? rightThat(said)
        : (asYesNo(said) ?? rightThat(said));
  const entry = type === null ? undefined : ASKS[type];
  if (entry === undefined) return fallback();
  const fields: Record<string, string> = { ...parts.fields };
  // A preference read from its sentence where its fields are not on the card ("Prefers window seats").
  const lead = /^(Prefers|Avoids|Likes|Dislikes) (.+)$/.exec(said ?? "");
  if (type === "preference") {
    fields.polarity ??= lead?.[1]?.toLowerCase() ?? "prefers";
    if (fields.object === undefined && lead?.[2] !== undefined) fields.object = lead[2];
  }
  // A need or a client preference may come with its thing as `what`.
  if ((type === "need" || type === "capability") && fields.object === undefined && fields.what !== undefined)
    fields.object = fields.what;
  let template = you ? entry.ask.you : entry.ask.them;
  const state = fields.state;
  if (type === "situation" && state !== undefined) {
    if (readsAsState(state)) fields.state = lowerState(state);
    else template = entry.ask.otherwise ?? template;
  }
  return fillAsk(type ?? "", template, fields, who, you ? "your" : `${who}'s`) ?? fallback();
}

const RULING_ASKS: Readonly<Record<string, FactAsk>> = {
  veto: { before: "Still never use", after: "" },
  reject: { before: "Still mark", after: "as not true" },
  retire: { before: "Still mark", after: "as no longer true" },
};

// Work handed to the owner (theirs to do), asked as whether they did it: "Did you write
// back to Dana?" where its words open with a verb, else "Have you done this yet: ...?".
// A title spliced into an agent's sentence ("Follow up on Find out who runs the garden with ..."),
// said as what it is about: its leading verb of finding out dropped ("who runs the garden"), else
// the title in quotes.
const TOPIC_LEADS = /^(?:find out|look into|read up on|check whether|check if|learn whether)\s+/i;
const topicOf = (title: string): string => {
  const plain = unstop(title).trim();
  return TOPIC_LEADS.test(plain) ? plain.replace(TOPIC_LEADS, "") : `"${plain}"`;
};
// "Follow up on <title> with <someone>" and "Follow up on <title>", where the title is another
// piece of work's (it opens with a capital verb of its own): one question in plain order.
const followUp = (what: string): string | null => {
  // The last " with " names whom with, where the title before it is more than its verb: a title
  // of one verb keeps its own "with" ("Meet with Ada" is the title, not "Meet" with Ada). A title
  // with a "with" of its own and none after it can still be split there: the words alone cannot
  // tell them apart.
  const split = /^Follow up on ([A-Z][a-z]+\s+\S[\s\S]*)(?: with ([^,;]+?))$/.exec(unstop(what));
  const found = split ?? /^Follow up on ([A-Z][a-z]+\b[\s\S]*)$/.exec(unstop(what));
  if (found === null) return null;
  const title = found[1] ?? "";
  if (!VERBS.has(title.split(/\s/)[0]?.toLowerCase() ?? "") && !TOPIC_LEADS.test(title)) return null;
  const topic = topicOf(title);
  return found[2] === undefined
    ? `Did you follow up on ${topic}?`
    : `Did you follow up with ${found[2]} about ${topic}?`;
};
export const handedQuestion = (what: string | null): string => {
  if (what === null) return "Have you done this yet?";
  const spliced = followUp(what);
  if (spliced !== null) return spliced;
  const act = imperative(what);
  if (act !== null) return `Did you ${act}?`;
  // An introduction named as a noun ("Intro to Ada through Marta") is one the owner makes.
  const intro = /^(intro|introduction)\b([\s\S]*)$/i.exec(unstop(what));
  return intro === null
    ? `Have you done this yet: ${told(what)}?`
    : `Did you make the ${(intro[1] ?? "").toLowerCase()}${intro[2] ?? ""}?`;
};

// The one question a card asks, or, for a notice about one fact read later, the ask its words fill, by
// its kind, so a kind with no question fails to compile. `said` is the content with no full stop.
type Asked = { question: string; factAsk?: FactAsk };
const rightOrAsk = (said: string | null): Asked => ({ question: said === null ? "Is this right?" : rightThat(said) });
const QUESTIONS: Readonly<Record<KnownCardKind, (parts: QuestionParts, said: string | null) => Asked>> = {
  about_you: (parts) => ({ question: aboutFact(parts, true) }),
  agent_claim: (parts) => ({ question: aboutFact(parts, parts.about === "You") }),
  client_preference: (parts, said) => ({
    question:
      fillAsk(
        "client_preference",
        ASKS.client_preference?.ask.you ?? "",
        { what: parts.fields.what ?? said ?? "" },
        "you",
        "your",
      ) ?? "Should your agents remember this about how you like them to work?",
  }),
  same_person: (parts) => ({
    question:
      parts.first !== null && parts.second !== null
        ? `Are ${parts.first} and ${parts.second} the same person?`
        : "Are these two the same person?",
  }),
  same_person_batch: () => ({ question: "Code and your agents could not settle these pairs. Is each one person?" }),
  question_rule: (parts) => ({
    question: parts.fields.__rule ?? "You keep answering this kind of question the same way. Stop asking it?",
  }),
  shared_address: (parts) => ({
    question:
      parts.address !== null
        ? `Is ${parts.address} shared by more than one person?`
        : "Is this address shared by more than one person?",
  }),
  same_fact: (parts) => ({
    question:
      parts.first !== null && parts.second !== null
        ? `Do "${unstop(parts.first)}" and "${unstop(parts.second)}" say the same thing?`
        : "Do these two say the same thing?",
  }),
  relation_audit: (parts) => ({
    question:
      parts.said?.trim().endsWith("?") === true ? parts.said.trim() : "Do these two statements relate as shown?",
  }),
  opportunity_decision: (parts, said) => {
    if (said === null) return { question: parts.yours ? "Go ahead with this yourself?" : "Should an agent do this?" };
    const act = imperative(said);
    if (act === null)
      return {
        question: parts.yours
          ? `Go ahead with this yourself: ${told(said)}?`
          : `Should an agent take this on: ${told(said)}?`,
      };
    return { question: parts.yours ? `Go ahead and ${act} yourself?` : `Should an agent ${act}?` };
  },
  research_request: (parts) => ({
    question:
      parts.about === null
        ? "Let an agent search the web for this?"
        : `Let an agent search the web about ${parts.about}?`,
  }),
  owner_question: (_parts, said) => ({
    question: said === null ? "Is this still true for you?" : said.endsWith("?") ? said : `${said}?`,
  }),
  idea: (_parts, said) => ({
    question: said === null ? "Is this worth doing?" : `Worth doing: ${told(imperative(said) ?? said)}?`,
  }),
  lesson: (_parts, said) => ({ question: said === null ? "Is this lesson right?" : rightThat(said) }),
  reminder: (_parts, said) => ({
    question: said === null ? "Have you done this?" : `Have you done this yet: ${told(imperative(said) ?? said)}?`,
  }),
  goal_proposal: (parts, said) => {
    const ask = goalChangeOf(parts.change)?.ask;
    const goal = parts.goal === null ? "" : unstop(parts.goal);
    const proposed = said === null ? goal : said;
    return { question: ask === undefined ? "Make this change to your goals?" : ask(goal, proposed) };
  },
  draft_waiting: (parts) => {
    const to = parts.to === null ? "" : ` to ${parts.to}`;
    return {
      question:
        parts.subject === null
          ? `Keep this draft${to} for you to send?`
          : `Keep the draft "${unstop(parts.subject)}"${to} for you to send?`,
    };
  },
  outcome: (parts, said) => {
    const what = parts.asked ?? parts.found ?? said;
    if (parts.handed) return { question: handedQuestion(what) };
    return {
      question:
        parts.found === null && said === null
          ? "Was this useful?"
          : `Was this useful: ${told(uncited(parts.found ?? said ?? ""))}?`,
    };
  },
  // A card with one answer says what happened, plainly, and its one answer acknowledges it; a
  // terminal command for doing otherwise is behind the evidence.
  calibration_drift: (parts) => ({
    // Asked as a question the owner answers with its one reply.
    question:
      parts.where === null
        ? "A model's answers drifted from yours. Keep deciding this yourself?"
        : `A model's answers drifted from yours. Keep deciding yourself about ${parts.where.charAt(0).toLowerCase()}${parts.where.slice(1)}?`,
  }),
  ignore_narrowed: (parts) => ({
    question:
      parts.domains.length === 0
        ? "Some addresses you ignore moved to a new domain, where others are not ignored"
        : `Others at ${parts.domains.join(" and ")} are no longer ignored`,
  }),
  stale_restatement: (parts) => {
    const agent = parts.agent ?? "the agent";
    const said = `Tell ${agent} that a fact it repeats is out of date`;
    return { question: said, factAsk: { before: `Tell ${agent} that`, after: "is out of date", told: said } };
  },
  ruling_carry: (parts) => {
    const ask = RULING_ASKS[parts.verdict ?? ""];
    if (parts.candidates === 1 && ask !== undefined) return { question: factQuestion(ask, null), factAsk: ask };
    if (parts.candidates === 0) return { question: "One of your rulings has no fact left to apply to" };
    if (parts.candidates === 1) return { question: "One of your rulings lost the fact it applied to" };
    return { question: `One of your rulings may apply to one of ${parts.candidates} facts` };
  },
  notice: (parts, said) => {
    if (parts.run !== null) {
      const why = RUN_CODES[parts.run] ?? (parts.run === "none" ? null : "it ended with an error");
      return { question: why === null ? "A run stopped without saying why" : `A run stopped because ${why}` };
    }
    return { question: said ?? "A notice from the system" };
  },
  // A box health card, said by its title (boxHealthWords); the owner looks, then marks it seen.
  box_health: (_parts, said) => ({ question: capital(said ?? "Something on the box needs a look") }),
  // These shape themselves from their lines (cards.ts), and never come here.
  tier_proposal: (_parts, said) => rightOrAsk(said),
  time_effort: (_parts, said) => rightOrAsk(said),
  grant_suggestion: (_parts, said) => rightOrAsk(said),
  grant_lift_suggestion: (_parts, said) => rightOrAsk(said),
};
export function questionOf(parts: QuestionParts): Asked {
  const said = parts.said === null ? null : unstop(parts.said);
  if (parts.gone) return { question: "The fact this asked about has since been removed. Clear it?" };
  return Object.hasOwn(QUESTIONS, parts.kind) ? QUESTIONS[parts.kind as KnownCardKind](parts, said) : rightOrAsk(said);
}

// An answer as a plain reply that says what it does. `done`: the toast's past tense, where the
// answer's own is not enough.
