import type { CardLine } from "@intelligence/contracts/personal";

// A card's lines as the terminal shows them: who wrote each, its words and its refs, without the key
// and parts a page reads, so a test pins the terminal's text as it always has.
export const asWords = (lines: readonly CardLine[]): Omit<CardLine, "key" | "value">[] =>
  lines.map(({ key: _key, value: _value, ...shown }) => shown);
