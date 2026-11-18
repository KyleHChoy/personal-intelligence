import { PageUrl } from "@intelligence/contracts/personal";

// How a command reads on the page, and which address may be copied.

// The scripts whose words rightly hold a zero-width joiner or non-joiner: in a word of one of these,
// with a letter or mark of that script on both sides, one is spelling.
const JOINING_SCRIPTS = [
  "Arabic",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
];
const JOINER_IN_A_WORD = JOINING_SCRIPTS.map(
  (script) => `(?<=\\p{scx=${script}})(?<=[\\p{L}\\p{M}])[\\u200C\\u200D](?=\\p{scx=${script}})(?=[\\p{L}\\p{M}])`,
).join("|");
// An emoji's own parts: its colour selector, and the joiner between two emoji.
const PART_OF_AN_EMOJI =
  "(?<=\\p{Extended_Pictographic})\\uFE0F|(?<=[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]\\uFE0F?)\\u200D(?=\\p{Extended_Pictographic})";

// What a shell would take differently from what the eye sees, written out as `pi send show` writes
// what it prints: every code point a terminal could obey or that prints nothing, unassigned ones and
// lone surrogates among them. Here a line feed and a tab too, which a page shows as a space and a
// shell does not, and every blank but the plain space. A false alarm teaches the owner to pass the
// warning by, so an emoji's parts and a word's joiners are left where they belong, and only there.
const UNSEEN = new RegExp(
  `(?!${PART_OF_AN_EMOJI}|${JOINER_IN_A_WORD})(?:[\\p{C}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u2800]|(?! )\\p{Zs})`,
  "gu",
);
const writtenOut = (one: string): string =>
  `<U+${(one.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`;

const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

export function visibleCommand(line: string): { shown: string; hidden: number; rightToLeft: boolean } {
  return {
    shown: line.replace(UNSEEN, writtenOut),
    hidden: line.match(UNSEEN)?.length ?? 0,
    rightToLeft: RIGHT_TO_LEFT.test(line),
  };
}

// What a shell would run on its own, in an address that is otherwise a good one. `&` stays: it is in
// most query strings.
const SHELL_WORDS = /[;|$`<>]/;

// Whether a string an agent cited is a web address to offer Copy for. An agent may cite any short
// string as a source, so nothing else gets a button that writes it to the clipboard. PageUrl reads with
// `URL.parse`, which an older browser lacks: there it offers no Copy.
export function mayCopyAddress(address: string): boolean {
  if (SHELL_WORDS.test(address)) return false;
  try {
    return PageUrl.safeParse(address).success;
  } catch {
    return false;
  }
}
