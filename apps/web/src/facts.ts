import { type FactView, KEY_FIELDS, type Who } from "@intelligence/contracts/personal";
import { agentName } from "./agent-words.ts";
import { AFFILIATION_WORDS, factTypeWords, POLARITY_WORDS, RELATIONSHIP_WORDS, sourceWords } from "./enum-words.ts";
import { dateWords, whenWords } from "./time-words.ts";
import { capital } from "./words.ts";

// A fact as one sentence in words, from its type and typed fields, as the design's rows read: never
// its type's code, its field names or an id. Shared by a card's claim (whose fields come as text
// lines) and a fact the store serves (`FactView`, whose fields are typed values).

// A field's value as text: a person or organization by name (else address), a text by its words.
export function valueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return null;
  if (typeof value === "object") {
    const one = value as { untrusted?: unknown; name?: unknown; address?: unknown };
    if (typeof one.untrusted === "string") return one.untrusted;
    if ("name" in one || "address" in one) return valueText(one.name) ?? valueText(one.address);
  }
  return null;
}

// The key phrase of each owner-side kind's version 4 claim, the field a correction of its words
// goes in; a fact the store serves gives it as `what`.
export const PHRASE_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEY_FIELDS).map(([kind, fields]) => [kind, fields.phrase]),
);
// A day or a time in words ("1 Mar 2027"): a calendar day as itself, a time as its day here.
function dayOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const when = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(when.getTime()) ? value : dateWords(when);
}

const has = <T extends string>(map: Readonly<Record<T, string>>, key: string | undefined): key is T =>
  key !== undefined && Object.hasOwn(map, key);
const possessive = (who: string): string => (who === "You" ? "your" : `${who}'s`);

// The sentence for a fact of `type` with `fields` as text, about `subject` ("You" for the owner, a
// name, or null when no line names it).
export function sentenceOf(type: string, fields: Readonly<Record<string, string>>, subject: string | null): string {
  const who = subject ?? "Someone";
  const what = fields.what;
  const org = fields.organization ?? fields.organization_name;
  switch (type) {
    case "role":
      return `${who === "You" ? "You are " : `${who}: `}${fields.title ?? "a role"}${org === undefined ? "" : ` at ${org}`}`;
    case "affiliation":
      return `${who} ${has(AFFILIATION_WORDS, fields.relation) ? AFFILIATION_WORDS[fields.relation] : "is connected to"} ${org ?? "an organization"}`;
    case "relationship":
      return `${fields.counterparty ?? "Someone"} is ${possessive(who)} ${has(RELATIONSHIP_WORDS, fields.relation) ? RELATIONSHIP_WORDS[fields.relation] : "connection"}`;
    // An offer the map's links open.
    case "intro_offer":
      return fields.offer === "suggested"
        ? `${who} suggested you meet ${fields.person ?? "someone"}`
        : `${who} offered to introduce you to ${fields.person ?? "someone"}`;
    case "preference":
      return `${has(POLARITY_WORDS, fields.polarity) ? POLARITY_WORDS[fields.polarity] : "Prefers"} ${what ?? "something"}`;
    case "goal":
    case "need":
    case "capability":
    case "constraint":
    case "situation": {
      if (what === undefined) return `${factTypeWords(type)}${subject === null ? "" : ` of ${subject}`}`;
      const by = dayOf(fields.by);
      const until = dayOf(fields.until);
      return [capital(what), by === undefined ? null : `by ${by}`, until === undefined ? null : `until ${until}`]
        .filter((one) => one !== null)
        .join(", ");
    }
    // A view on its topic, where an organization's process stands,
    // and a place the owner has been.
    case "view":
      return what === undefined
        ? `${factTypeWords(type)}${subject === null ? "" : ` of ${subject}`}`
        : fields.topic === undefined
          ? capital(what)
          : `On ${fields.topic}: ${what}`;
    case "status": {
      const since = dayOf(fields.since);
      return [
        `${org ?? "An organization"}: ${what ?? "a process"} is ${fields.state ?? "under way"}`,
        since === undefined ? null : `since ${since}`,
      ]
        .filter((one) => one !== null)
        .join(", ");
    }
    case "visited": {
      const when = dayOf(fields.when);
      return [
        `${who === "You" ? "You have been to" : `${who} has been to`} ${what ?? "a place"}`,
        when === undefined ? null : `on ${when}`,
      ]
        .filter((one) => one !== null)
        .join(", ");
    }
    case "transaction.receipt":
      return `${fields.merchant ?? "A purchase"}${fields.amount === undefined ? "" : `, ${fields.amount}${fields.currency === undefined ? "" : ` ${fields.currency}`}`}`;
    case "known_person":
      return `${fields.name ?? "Someone"}${fields.known_how === undefined ? "" : `, known through ${fields.known_how}`}`;
    case "owner_tie":
      return `${who}: your ${fields.relation?.replaceAll("_", " ") ?? "contact"}`;
    case "connection":
      return `${who} and ${fields.other ?? "someone"}`;
    case "link":
      return fields.label ?? fields.url ?? "A link";
    // What the owner did, by its theme, as its row on Your activity says it.
    case "activity.worked_on":
      return `Worked on ${fields.project ?? fields.repository ?? fields.document ?? "a project"}`;
    case "activity.messaged":
      return `Messaged ${fields.counterparty ?? "someone"}`;
    case "activity.met":
      return `Met ${fields.counterparty ?? "someone"}`;
    case "activity.researched": {
      const theme = fields.project ?? fields.topic;
      if (theme !== undefined) return `Researched ${theme}`;
      const category =
        fields.category === undefined || fields.category === "other" ? "Browsing" : capital(fields.category);
      return `${category} on ${fields.host ?? "the web"}`;
    }
    case "project.status":
      return what ?? `The project is ${fields.status ?? "under way"}`;
    default:
      if (what !== undefined) return what;
      return `${factTypeWords(type)}${subject === null ? "" : ` of ${subject}`}`;
  }
}

const whoName = (who: Who | null): string | null =>
  who === null ? null : who.kind === "owner" ? "You" : (valueText(who.name) ?? valueText(who.address));

// A fact the store serves, as its sentence.
export function factSentence(fact: FactView): string {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(fact.fields as Record<string, unknown>)) {
    const text = valueText(value);
    if (text !== null) fields[name] = text;
  }
  return sentenceOf(fact.type, fields, whoName(fact.subject));
}

// The answer from the owner to an agent's question, relayed by that agent, ranks below what the owner said
// directly, and says so: its own tier, owner_relayed.
export const isAnswer = (fact: FactView): boolean => fact.tier === "owner_relayed" && fact.channel !== undefined;
// What an agent quoted the owner saying, kept by the owner's standing permission for that
// agent without a card: the granted-release tier with the agent that relayed it.
const isGranted = (fact: FactView): boolean => fact.tier === "researched" && fact.channel !== undefined;
// Where a fact came from, in words: one helper, so a row and its opened claim say the same.
export const factFromWords = (fact: FactView): string =>
  fact.sourceMark === "agent_chat"
    ? "From your chats with agents"
    : isAnswer(fact)
      ? `Your answer to ${agentName(fact.channel as string)}`
      : isGranted(fact)
        ? `You told ${agentName(fact.channel as string)}, kept without asking`
        : fact.tier === "observed"
          ? "On your Mac"
          : fact.tier === "owner" || fact.tier === "owner_confirmed" || fact.provenance === "owner"
            ? YOU_SAID
            : fact.agentReported
              ? "An agent (inferred)"
              : sourceWords(fact.source);
// Who said a fact, apart from where it came from: the person, then when. `owners`: the owner said it.
const YOU_SAID = "You said";
export function factSaidParts(fact: FactView): { from: string; owners: boolean; rest: string[] } {
  const from = factFromWords(fact);
  const by = whoName(fact.statedBy);
  return {
    from,
    owners: from === YOU_SAID,
    rest: [by === null || by === "You" ? null : by, capital(whenWords(fact.at))].filter(
      (part): part is string => part !== null && part !== "",
    ),
  };
}
export function factSaidBy(fact: FactView): string {
  const { from, rest } = factSaidParts(fact);
  return [from, ...rest].filter((part) => part !== "").join(" · ");
}
