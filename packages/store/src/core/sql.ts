import { CodedError } from "@intelligence/contracts/personal";

// An SQL fragment: text written in the code, never a value. A value goes to the database as a
// parameter ($1, $2, ...), so it is never read as SQL. The brand keeps the two apart: a plain string
// is no fragment, and only `sql`, `fixed` and `sqlWords` make one.
declare const fragment: unique symbol;
export type Sql = string & { readonly [fragment]: true };

// A string fixed when the code is written: a literal, a union of literals or a fragment. The type
// checker refuses a `string` that is only known at run time.
export type Fixed<T extends string> = string extends T ? never : T;

// A fragment from a template whose every piece is itself a fragment.
export function sql(strings: TemplateStringsArray, ...pieces: readonly Sql[]): Sql {
  let text = strings[0] ?? "";
  for (const [i, piece] of pieces.entries()) text += piece + (strings[i + 1] ?? "");
  return text as Sql;
}

// A literal, or a union of literals, as a fragment.
export const fixed = <T extends string>(text: Fixed<T>): Sql => text as string as Sql;

const WORD = /^[a-z][a-z0-9_]*$/;

// Code words as SQL text literals, for `in (...)`. A word is lower case, digits and underscores:
// anything else could be a value, and is refused.
export function sqlWords(words: readonly string[]): Sql {
  if (!words.every((word) => WORD.test(word))) throw new CodedError("not_a_code_word");
  return words.map((word) => `'${word}'`).join(", ") as Sql;
}
