import {
  type CardLine,
  type CardLineKey,
  type CardLinePart,
  CardLineRef,
  keyedLine,
  type LineSource,
  linePart,
} from "@intelligence/contracts/personal";

// A line code wrote, by its key and parts, its words rendered from them (contracts' cardLineText),
// with what it names by id as its `refs`, so a page reads the parts and ids and never the words. A
// candidate whose kind is not a person, a message, a goal or a fact, or whose id is not well formed
// for its kind, names nothing: `refs` is left out when none is left.
export function codeLine(
  key: CardLineKey,
  value: readonly CardLinePart[] = [],
  named: readonly { kind: string; id: string | null }[] = [],
): CardLine {
  const refs: CardLineRef[] = [];
  for (const candidate of named) {
    const parsed = CardLineRef.safeParse(candidate);
    if (parsed.success && !refs.some((ref) => ref.kind === parsed.data.kind && ref.id === parsed.data.id))
      refs.push(parsed.data);
  }
  return keyedLine("code", key, value, refs);
}

// A line whose words a source, an agent or the owner wrote, under the key code gives it.
export const saidLine = (
  from: Exclude<LineSource, "code" | "model">,
  key: CardLineKey,
  value: readonly CardLinePart[],
): CardLine => keyedLine(from, key, value);

export { linePart as part };

// A heading, an agent's words, a value that would not open, and a stored value as text: the lines
// every card kind writes the same way.
export const headingLine = (name: string): CardLine => codeLine("heading", [linePart.code(name)]);
export const agentLine = (text: string): CardLine => ({ text, from: "agent" });
export const unreadableLine = (what: string): CardLine => codeLine("unreadable", [linePart.code(what)]);
export const shownValue = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

// Who wrote a work row's words, by its `created_by`: the owner's are the owner's own, a client's an
// agent's, and a run's or the reasoner's a model's. One rule for every card that shows such words.
export const writerOf = (createdBy: string): Extract<LineSource, "owner" | "agent" | "model"> =>
  createdBy === "owner" ? "owner" : createdBy.startsWith("client:") ? "agent" : "model";

// A card's kind, author and time, each a code line.
export const headLines = (card: { kind: string; author: string; createdAt: string }): CardLine[] => [
  codeLine("kind", [linePart.code(card.kind)]),
  codeLine("author", [linePart.code(card.author)]),
  codeLine("at", [linePart.time(card.createdAt)]),
];
// A ref of a card's, a code line naming it.
export const refLine = (key: "ref" | "target", ref: { kind: string; id: string }): CardLine =>
  codeLine(key, [linePart.id(ref.kind, ref.id)], [ref]);

// The card's kind, author, time and refs, each a code line.
export const codeLines = (
  card: Parameters<typeof headLines>[0] & { refs: readonly { kind: string; id: string }[] },
): CardLine[] => [...headLines(card), ...card.refs.map((ref) => refLine("ref", ref))];

// A ruling_carry card's question (admin-reattach.ts questionBody) as its parts: the ruling, its
// verdict, the generation, how many candidates past the listed ones, then each listed candidate.
export const rulingLostParts = (
  ruling: string,
  verdict: string,
  generation: number,
  listed: readonly string[],
  more: number,
) => [
  linePart.id("ruling", ruling),
  linePart.code(verdict),
  linePart.count(generation),
  linePart.count(more),
  ...listed.map((claim) => linePart.id("fact", claim)),
];

// A row a work row or a proposal rests on, by its kind and id.
export const basisLine = (ref: { ref_kind: string; ref_id: string }): CardLine =>
  codeLine("basis", [linePart.id(ref.ref_kind, ref.ref_id)], [{ kind: ref.ref_kind, id: ref.ref_id }]);

// A ruling_carry card's body (admin-reattach.ts questionBody), parsed at read into its parts, so a
// card raised before lines had keys reads the same: a body these parts do not render again
// exactly is kept as its words.
const RULING_LOST =
  /^ruling (\S+) \((\S+)\) lost its claim at generation (\d+); candidates: (.*?)(?:; more candidates: (\d+))?; which claim does it apply to\?/;
export function rulingLostLine(text: string): CardLine {
  const found = RULING_LOST.exec(text);
  if (found === null) return { text, from: "code" };
  const [, ruling = "", verdict = "", generation = "0", listed = "", more = "0"] = found;
  const claims = listed.startsWith("none found") ? [] : listed.split(" ");
  const line = codeLine("ruling_lost", rulingLostParts(ruling, verdict, Number(generation), claims, Number(more)));
  return line.text === text ? line : { text, from: "code" };
}
