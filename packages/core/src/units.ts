// Units every part of Personal Intelligence counts in: a tenth, and the length of a text in code points, which every text limit counts.

// A number rounded to one decimal place.
export const tenths = (value: number): number => Math.round(value * 10) / 10;

export const codePoints = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};
