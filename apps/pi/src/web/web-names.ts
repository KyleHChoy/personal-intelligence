import {
  CARD_MENTIONS_MOST,
  CardLine,
  type CardMention,
  ID_TOKEN,
  LineSource,
  type NamedOpen,
  neutralWords,
} from "@intelligence/contracts/personal";

// Names, not ids: before a read's answer leaves `pi web`, every id an agent, a model or a source wrote into text the owner
// reads is put in the owner's words, all of one answer's ids named in one batch. Only text is touched, never a field the page
// uses as an id: a value inside { untrusted }; a card line's words that code did not write, and the words of its parts (code's
// lines are the page's own headings, ids and codes); and the words of a report or a proposal the work sheet shows as plain
// strings (`PROSE`), when they hold a space, so a cursor, a code or an id field is never one. The words are only substituted
// for the id: the text is never read for anything else, and nothing in it is followed (invariant 1). A card gains `mentions`:
// what its lines named that the owner can see and the page opens.

export type Named = { words: string; open: NamedOpen | null };
export type NamesOf = (tokens: readonly string[]) => Promise<ReadonlyMap<string, Named>>;

// The reads served as they are: a message is a source's own words (a checksum in an email is never
// a fact), and a draft is what will be sent, so the owner reads exactly that.
export const AS_WRITTEN: ReadonlySet<string> = new Set(["message", "draft"]);

// The plain-string fields of agent work the owner's reads serve (ShownWork's reports and proposals).
export const PROSE: ReadonlySet<string> = new Set([
  "summary",
  "deliverable",
  "uncertain",
  "next",
  "reason",
  "draft",
  "intent",
]);
// A report's sources and candidates: a ref, or a short text of the agent's.
export const PROSE_LISTS: ReadonlySet<string> = new Set(["sources", "candidates"]);
const LINE_SOURCES: ReadonlySet<string> = new Set(LineSource.options);
// A card line's fields, by its contract, and the two of them that are lists.
const LINE_KEYS: ReadonlySet<string> = new Set(Object.keys(CardLine.shape));
const LINE_LISTS: ReadonlySet<string> = new Set(["refs", "value"]);

type Json = unknown;
type Spot = { holder: Record<string, Json> | Json[]; key: string | number; text: string };

// A card line: its text, who wrote it, on a code line the refs of what it names, and its key and
// typed parts.
const isLine = (value: Record<string, Json>): boolean =>
  typeof value.text === "string" &&
  typeof value.from === "string" &&
  LINE_SOURCES.has(value.from) &&
  Object.keys(value).every((key) => LINE_KEYS.has(key) && (!LINE_LISTS.has(key) || Array.isArray(value[key])));
const isCard = (value: Record<string, Json>): boolean =>
  typeof value.id === "string" && value.id.startsWith("crd_") && Array.isArray(value.lines);

// Every place in `value` whose text may hold an id, and each card with the texts of its lines.
function spotsIn(value: Json, spots: Spot[], cards: Map<Record<string, Json>, string[]>): void {
  if (Array.isArray(value)) {
    for (const one of value) spotsIn(one, spots, cards);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, Json>;
  if (isLine(object)) {
    if (object.from !== "code") {
      spots.push({ holder: object, key: "text", text: object.text as string });
      // The words of its parts are the same words, named the same way.
      for (const part of (object.value as Json[] | undefined) ?? [])
        if (typeof part === "object" && part !== null && (part as Record<string, Json>).kind === "text")
          spots.push({
            holder: part as Record<string, Json>,
            key: "text",
            text: (part as Record<string, Json>).text as string,
          });
    }
    return;
  }
  if (isCard(object))
    cards.set(
      object,
      (object.lines as Json[]).flatMap((line) =>
        typeof line === "object" &&
        line !== null &&
        isLine(line as Record<string, Json>) &&
        (line as Record<string, Json>).from !== "code"
          ? [(line as Record<string, Json>).text as string]
          : [],
      ),
    );
  for (const [key, field] of Object.entries(object)) {
    if (typeof field === "string") {
      if (key === "untrusted" || (PROSE.has(key) && /\s/.test(field))) spots.push({ holder: object, key, text: field });
    } else if (PROSE_LISTS.has(key) && Array.isArray(field)) {
      field.forEach((one, index) => {
        if (typeof one === "string") spots.push({ holder: field, key: index, text: one });
        else spotsIn(one, spots, cards);
      });
    } else spotsIn(field, spots, cards);
  }
}

const tokensIn = (text: string): string[] => text.match(ID_TOKEN) ?? [];

// The text with each id in its words. Neutral words that start the text or a line start with a
// capital; a name or a title is said exactly as its source wrote it.
function wordsIn(text: string, named: ReadonlyMap<string, Named>): string {
  return text.replace(ID_TOKEN, (token, offset: number) => {
    const words = named.get(token)?.words ?? neutralWords(token);
    const opens = offset === 0 || /\n\s*$/.test(text.slice(0, offset));
    return opens && words === neutralWords(token) ? words.charAt(0).toUpperCase() + words.slice(1) : words;
  });
}

// `value` (a read's answer, parsed JSON), its texts in the owner's words. It is changed in place and
// returned. One call of `namesOf` for every id in it, none when it holds no id.
export async function inOwnerWords<T>(value: T, namesOf: NamesOf): Promise<T> {
  const spots: Spot[] = [];
  const cards = new Map<Record<string, Json>, string[]>();
  spotsIn(value, spots, cards);
  const tokens = [...new Set(spots.flatMap((spot) => tokensIn(spot.text)))];
  if (tokens.length === 0) return value;
  const named = await namesOf(tokens);
  for (const card of cards.keys()) {
    const mentions: CardMention[] = [];
    for (const token of new Set((cards.get(card) ?? []).flatMap(tokensIn))) {
      const one = named.get(token);
      if (
        one?.open != null &&
        !mentions.some((known) => known.open.kind === one.open?.kind && known.open.id === one.open.id)
      )
        mentions.push({ words: one.words, open: one.open });
    }
    if (mentions.length > 0) card.mentions = mentions.slice(0, CARD_MENTIONS_MOST);
  }
  for (const spot of spots) (spot.holder as Record<string | number, Json>)[spot.key] = wordsIn(spot.text, named);
  return value;
}
