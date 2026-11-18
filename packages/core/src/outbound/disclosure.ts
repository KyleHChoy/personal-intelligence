import {
  ContactCandidate,
  type RevealedClaim,
  type RevealedContact,
  UseOnlyCandidate,
} from "@intelligence/contracts/personal";
import { MONTH_NAMES } from "../days.ts";

// The disclosure check at rung 0: the use-only claims a draft reveals to someone who was not on
// their source thread, by id, tie and index, never text, less those the owner released with
// --reveal. Pure.
export type RevealedClaimsInput = {
  subject: string;
  body: string;
  candidates: readonly UseOnlyCandidate[];
  released: readonly string[];
};

// A text value ties a claim only from this many code points, so a date or one common word ties
// nothing.
const MIN_TIE = 12;

// Compared without width, case or spacing: NFKC, lower case, each run of white space one space.
// A format character (general category Cf: a zero-width space or joiner, a soft hyphen, a word
// joiner, a byte order mark) prints nothing and is dropped, so it cannot split a value.
const normal = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ");

export function revealedClaims({ subject, body, candidates, released }: RevealedClaimsInput): RevealedClaim[] {
  const text = normal(`${subject}\n${body}`);
  const skip = new Set(released);
  const revealed: RevealedClaim[] = [];
  for (const raw of candidates) {
    // A candidate that does not parse throws: the caller's check then fails, never passes.
    const candidate = UseOnlyCandidate.parse(raw);
    if (skip.has(candidate.id) || !candidate.thirdParty || candidate.isPublic || !candidate.offThread) continue;
    if (candidate.citedItem) {
      revealed.push({ id: candidate.id, tie: "cited_item", valueIndex: null });
      continue;
    }
    const index = candidate.textValues.findIndex((value) => {
      const needle = normal(value).trim();
      return [...needle].length >= MIN_TIE && text.includes(needle);
    });
    if (index >= 0) revealed.push({ id: candidate.id, tie: "text_value", valueIndex: index });
  }
  return revealed;
}

// Pure.
export type RevealedContactsInput = {
  subject: string;
  body: string;
  candidates: readonly ContactCandidate[];
  released: readonly RevealedContact[];
};

// A phone ties by its last digits, from this many.
const PHONE_TAIL = 7;
// A word of a name names its contact only from this many code points.
const MIN_NAME_WORD = 4;

// Runs of letters and digits, in the normal form: "maren's" holds "maren", "marked" is one token.
const tokensOf = (text: string): string[] => normal(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const length = (text: string): number => [...text].length;

// Whether `needle`'s tokens are in `tokens`, in a row.
function holdsRun(tokens: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let at = 0; at + needle.length <= tokens.length; at += 1)
    if (needle.every((one, offset) => tokens[at + offset] === one)) return true;
  return false;
}

// The contact's name is in the text: one of its names or nicknames whole, or a word of one of at
// least four code points, as whole tokens. A contact with no such word is named by nothing, and
// ties by phone alone.
function named(tokens: readonly string[], names: readonly string[]): boolean {
  const split = names.map(tokensOf);
  const words = split.flat().filter((word) => length(word) >= MIN_NAME_WORD);
  if (words.length === 0) return false;
  return words.some((word) => tokens.includes(word)) || split.some((name) => holdsRun(tokens, name));
}

// The numbers in a text: each run of digits and the separators a number is written with
// (white space, `.`, `-` and the other dashes, `(`, `)`, `+`, `/`), as its digits alone and
// the places where a digit group ended (after a separator, or at the run's end).
const NUMBER = /[\d(+][\d\s.\-\u2010-\u2015\u2212()+/]*\d/gu;
type NumberRun = { digits: string; ends: ReadonlySet<number> };
function numbersOf(text: string): NumberRun[] {
  return [...text.matchAll(NUMBER)].map(([run]) => {
    let digits = "";
    const ends = new Set<number>();
    for (const char of run) {
      if (/\d/.test(char)) digits += char;
      else if (digits !== "") ends.add(digits.length);
    }
    ends.add(digits.length);
    return { digits, ends };
  });
}

// A phone's last seven digits, ending a digit group of a number in the text: so a separator, or the
// number's end, follows them, and digits may come before them (a country code). Seven digits inside
// a longer group tie nothing, so an order or account number that happens to hold the phone's last
// seven digits does not count as the phone.
function phoneTies(numbers: readonly NumberRun[], phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < PHONE_TAIL) return false;
  const tail = digits.slice(-PHONE_TAIL);
  return numbers.some(({ digits: run, ends }) => {
    for (let at = run.indexOf(tail); at >= 0; at = run.indexOf(tail, at + 1))
      if (ends.has(at + tail.length)) return true;
    return false;
  });
}

// A birthday's month, by name or its first three letters, next to its day as a number with or
// without st, nd, rd or th, in either order. A token is a whole run of digits, so March 3 does
// not tie March 30.
function birthdayTies(tokens: readonly string[], { month, day }: { month: number; day: number }): boolean {
  const name = MONTH_NAMES[month - 1] ?? "";
  const isMonth = (token: string | undefined): boolean => token === name || token === name.slice(0, 3);
  const isDay = (token: string | undefined): boolean => {
    const match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(token ?? "");
    return match !== null && Number(match[1]) === day;
  };
  return tokens.some((token, at) => isMonth(token) && (isDay(tokens[at - 1]) || isDay(tokens[at + 1])));
}

// A link's tie. The hosts whose subdomains (a country's, `m.`,
// `mobile.`) are one site, folded on both sides.
const FOLDED_HOSTS = ["linkedin.com", "twitter.com", "x.com"];
const X_HOSTS = ["x.com", "twitter.com"];
// A host where one starts: the text's start, `//`, or a character no host holds.
const HOST_START = "(^|//|[^a-z0-9.@/-])";
const WWW = new RegExp(`${HOST_START}www\\.`, "gu");
const FOLDED = new RegExp(
  `${HOST_START}[\\p{L}\\p{N}-]{1,63}\\.(?=(?:${FOLDED_HOSTS.map((one) => one.replace(".", "\\.")).join("|")})(?![\\p{L}\\p{N}-]))`,
  "gu",
);
// A port right after a host of two or more labels, before a path, a query, a fragment, white space
// or the end; never a `:` inside a path.
const PORT = new RegExp(`${HOST_START}((?:[\\p{L}\\p{N}-]+\\.)+[\\p{L}]{2,63}):\\d{1,5}(?=[/?#\\s]|$)`, "gu");

// The draft's text with every `www.` that starts a host, every subdomain of a folded host and
// every port after a host taken out.
const linkText = (text: string): string => text.replace(WWW, "$1").replace(FOLDED, "$1").replace(PORT, "$1$2");

// The forms of one stored link a draft may write: its host without `www.`, a folded host's
// subdomain or a port (x.com and twitter.com each other's), then its path as stored and
// percent-decoded, in the normal form. `path` is empty for a link to a host alone.
function linkForms(url: string): { needles: string[]; path: boolean } {
  const bare = normal(url).replace(/^https?:\/\//u, "");
  const slash = bare.indexOf("/");
  const written = (slash < 0 ? bare : bare.slice(0, slash)).replace(/:\d+$/u, "").replace(/^www\./u, "");
  const host = FOLDED_HOSTS.find((one) => written.endsWith(`.${one}`)) ?? written;
  const path = slash < 0 ? "" : bare.slice(slash);
  let decoded = path;
  try {
    decoded = normal(decodeURIComponent(path));
  } catch {
    // A path that does not decode is compared as stored.
  }
  const hosts = X_HOSTS.includes(host) ? X_HOSTS : [host];
  return { needles: [...new Set(hosts.flatMap((one) => [`${one}${path}`, `${one}${decoded}`]))], path: path !== "" };
}

// Whether `needle` stands in `text` as a whole link. Before it: the start or a character no host
// holds (never a letter, digit, `.`, `-`, `%`, `+` or `@`, so a subdomain and an address do not
// tie). After it: anything but a character a path goes on with (a letter, a digit, `%` or `-`), a
// run of `.`, `_` and `~` counting as an end only when no such character follows it (a sentence's
// end, `...`, markdown's `_x_` and `~~x~~`). So `github.com/jane` ties `**github.com/jane**` and
// `(github.com/jane)`, and not `github.com/janet`, `github.com/jane_doe` or `github.com/jane.dev`.
// Only ASCII blocks a start: a stored host is ASCII (an `xn--` label is refused), so a letter of any
// other script before it, such as text in a language written without spaces, ends what came before.
const BEFORE = /[a-z0-9.%+@-]/u;
const CONTINUES = /[\p{L}\p{N}%-]/u;
// Letters of scripts written without spaces: one after a link whose needle ends in ASCII ends it
// (`linkedin.com/in/jane-doeさん`).
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function standsIn(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1];
    if (before !== undefined && BEFORE.test(before)) continue;
    let end = at + needle.length;
    while (end < text.length && /[._~]/u.test(text[end] as string)) end += 1;
    const after = text[end];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is all of ASCII, asking whether the needle ends in an ASCII character, so it must start at the null character
    if (after === undefined || !CONTINUES.test(after) || (/[\x00-\x7f]$/u.test(needle) && UNSPACED.test(after)))
      return true;
  }
  return false;
}

export function revealedContacts({ subject, body, candidates, released }: RevealedContactsInput): RevealedContact[] {
  const text = normal(`${subject}\n${body}`);
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const numbers = numbersOf(text);
  const bare = linkText(text);
  const key = (one: RevealedContact): string => `${one.id}:${one.field}:${one.index ?? ""}`;
  const skip = new Set(released.map(key));
  const revealed: RevealedContact[] = [];
  // An organization's name or a title of at least twelve code points, as the send proxy's text
  // tie has it.
  const holds = (value: string | null): boolean => {
    const needle = value === null ? "" : normal(value).trim();
    return length(needle) >= MIN_TIE && text.includes(needle);
  };
  for (const raw of candidates) {
    // A candidate that does not parse throws: the caller's check then fails, never passes.
    const candidate = ContactCandidate.parse(raw);
    const found: RevealedContact[] = [];
    candidate.phones.forEach((phone, index) => {
      if (phoneTies(numbers, phone)) found.push({ id: candidate.id, field: "phone", index });
    });
    // A link ties as a whole link in the text, whatever scheme, `www.`, port or percent-encoding
    // the draft writes. One with a path names its person alone; one to a host alone (a company's
    // home page) ties only beside the contact's name, as an organization or a title does.
    const isNamed = named(tokens, candidate.names);
    (candidate.links ?? []).forEach((url, index) => {
      const { needles, path } = linkForms(url);
      if ((path || isNamed) && needles.some((needle) => standsIn(bare, needle)))
        found.push({ id: candidate.id, field: "link", index });
    });
    if (isNamed) {
      candidate.organizations.forEach(({ name, title }, index) => {
        if (holds(name)) found.push({ id: candidate.id, field: "organization", index });
        if (holds(title)) found.push({ id: candidate.id, field: "title", index });
      });
      if (candidate.birthday !== null && birthdayTies(tokens, candidate.birthday))
        found.push({ id: candidate.id, field: "birthday", index: null });
    }
    revealed.push(...found.filter((one) => !skip.has(key(one))));
  }
  return revealed;
}
