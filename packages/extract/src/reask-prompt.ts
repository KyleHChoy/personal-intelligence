import { type Prompt, promptTextHash } from "@intelligence/personal-models";

// The one re-ask: a lane's own prompt, its version's text untouched, with this note after it and
// one slot more. The slot holds codes of code's own, never a word of the first answer or of the
// evidence, which stays in its own slot alone (invariant 1). A prompt's text decides its call key,
// so this text is pinned by test.

export const REASK_SUFFIX = "_reask";

// The codes the slot may hold, what each means, and all a wording refusal can be.
export const WORDING_ISSUES = ["not_in_passage", "part_of_line"] as const;
export type WordingIssue = (typeof WORDING_ISSUES)[number];

export const REASK_NOTE = [
  "This message was asked once already. Every claim of that answer was refused because a text value was not the words of the segment its span names. The refused slot lists how, by code, and says nothing else:",
  "- not_in_passage: the value's words are not in that segment.",
  "- part_of_line: a statement was part of a sentence or line, not the whole of it.",
  "Answer again from the message alone. Copy each text value character for character from the segment its span names, or leave that claim out. Never reword a value to fit. Claims is empty when the message states nothing you can copy.",
].join("\n");

const reaskOf = (base: Prompt): Prompt => {
  const { textHash: _textHash, ...rest } = base;
  const prompt = {
    ...rest,
    id: `${base.id}${REASK_SUFFIX}`,
    instructions: `${base.instructions}\n\n${REASK_NOTE}`,
    slots: Object.freeze([...base.slots, "refused"]),
  };
  return Object.freeze({ ...prompt, textHash: promptTextHash(prompt) });
};

export const reaskPrompts = (bases: readonly Prompt[]): readonly Prompt[] => bases.map(reaskOf);
