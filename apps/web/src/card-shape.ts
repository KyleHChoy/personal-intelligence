import type { WebWriteName } from "@intelligence/contracts/personal";
import type { DoneLabel } from "./card-words.ts";

export type FactAsk = { before: string; after: string; told?: string };
export type Reply = { label: string; done?: string };

// `by` says whose words it is, whatever those words say of themselves.
export type CardRow = { k: string; v: string; by?: string };
export type CardShape = {
  // The one question the card asks, in plain English: its row's title, and with its answers and
  // `cites` all it shows by default. Everything else is its evidence.
  question: string;
  // A notice about one fact asks with that fact's words, once read (card-parts.tsx FactCardItem).
  factAsk?: FactAsk;
  // The messages and meetings it came from, each opening to itself: shown under the question.
  cites: CardCite[];
  // Its answers as plain replies, each saying what it does (card-kinds.ts `replies`).
  replies: Readonly<Record<string, Reply>>;
  // What the terminal command it shows does, in words, said over it.
  commandWhy: string | null;
  // The content as stored: the claim as a sentence, the proposed work, the planner's words.
  title: string;
  // Who or what it is about, by name, and where it came from: the line under the title.
  sub: string;
  // Where its content came from, in words (`FROM_WORDS` in card-lines.ts).
  from: string;
  // Its title is an agent's words: whose, said wherever the title is shown.
  agentTitled?: string;
  rows: CardRow[];
  notes: string[];
  // A command the owner types in a terminal, shown as one. Never with an id in it. `then`: the command
  // they type after it, with what the first shows.
  command: string | null;
  then?: string;
  // The write that resolves it on this page, where one exists, before the card's own answer.
  resolve: { write: WebWriteName; body: Record<string, unknown>; words: DoneLabel } | null;
  // Its claim has since been removed: nothing is left to confirm.
  gone: boolean;
  // What the owner's acknowledgement decides, in words, on a card whose one answer only acknowledges:
  // "Keep the cap" says more than "Seen". Null keeps the answer's own words.
  ack: string | null;
  // The fact a notice is about, by its claim, which the page reads for its words and opens;
  // `lead` goes before its words in the title.
  fact: { id: string; lead: string } | null;
  // The ignore an ignore_narrowed card is about, by its ruling, which the opened card names.
  ignore?: string;
  // A result's parts, each a heading over its words, read as prose: what
  // was asked and by whom, what was found, what was delivered, the next step, what is not sure.
  sections?: CardRow[];
  // Its sources by name; a message opens to itself. `id` is null for a web page.
  sources?: CardSource[];
  // A same-fact card's two sides, as its toast says what it ruled.
  pair?: { first: string; second: string };
  // An about-you card's Edit, the one field the owner's corrected value goes in and the value the
  // agent proposed.
  edit?: { field: string; value: string; lead: string };
};
// A card that shapes itself from its lines, whose answers do nothing beyond its kind's: all it has that
// another card's lines would give it is set here.
export const shapeOfCode = (
  card: Pick<CardShape, "question" | "title" | "replies" | "sub" | "rows" | "notes"> & Partial<CardShape>,
): CardShape => ({
  cites: [],
  commandWhy: null,
  from: "From the system",
  command: null,
  resolve: null,
  gone: false,
  ack: null,
  fact: null,
  ...card,
});
export type CardSource = { kind: string; id: string | null; words: string };
// A message or meeting a card came from: its subject or title, and who sent it where known.
export type CardCite = { kind: "message" | "meeting"; id: string; subject: string; from: string | null };
