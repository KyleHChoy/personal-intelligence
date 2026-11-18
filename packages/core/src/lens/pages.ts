// The words of a history page, as code reads them to tell whether a page names a person and to
// choose a block's topic, and the drain's credential net for a page's title and query. Pure, with
// pinned tables; nothing here is a model's.

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const POSSESSIVE = /['’]s$/u;
const INNER = /[-_./+]/;

export const TEXT_WORDS_MAX = 40;

const folded = (text: string, most = TEXT_WORDS_MAX): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, most);

// A word with no letter or digit is no word. `most` is how many words are read (a title is read
// whole).
export function words(text: string, most = TEXT_WORDS_MAX): string[] {
  return folded(text, most)
    .map((word) => word.replace(EDGE, "").replace(POSSESSIVE, "").replace(EDGE, ""))
    .filter((word) => LETTER_OR_DIGIT.test(word));
}

// A URL's path as text: decoded where it decodes, its slashes as spaces. Its host is not a text.
export function pathText(url: string): string {
  const path = URL.parse(url)?.pathname ?? "";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A path that does not decode is read as written.
  }
  return decoded.replaceAll("/", " ");
}

const runsOf = (sequence: readonly string[], most: number, into: Set<string>): void => {
  for (let from = 0; from < sequence.length; from += 1) {
    for (let length = 1; length <= most && from + length <= sequence.length; length += 1)
      into.add(sequence.slice(from, from + length).join(" "));
  }
};

// Three times: the words as written, so "dr. lovelace" meets an alias written so; as `words` gives
// them; and with each word split again at `-`, `_`, `.`, `/` and `+`, so "ada-example" in a path is
// also "ada example". `wordsMost` is how many words of the text are read: a window or thread title
// is read whole, since its title keys reach past the fortieth word.
export function wordRuns(text: string, most = 4, wordsMost = TEXT_WORDS_MAX): string[] {
  const runs = new Set<string>();
  runsOf(folded(text, wordsMost), most, runs);
  const whole = words(text, wordsMost);
  runsOf(whole, most, runs);
  if (whole.some((word) => INNER.test(word)))
    runsOf(
      whole.flatMap((word) => word.split(INNER).filter((part) => LETTER_OR_DIGIT.test(part))),
      most,
      runs,
    );
  return [...runs];
}

const SECRET_FORMATS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let at = 0; at < digits.length; at += 1) {
    let digit = Number(digits[digits.length - 1 - at]);
    if (at % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

// A one-time code: 4 to 8 digits within 20 characters of a phrase only codes take, or "code" right
// before 6 to 8 digits where no postal, PIN or area word names it.
const CODE_PHRASE =
  "(?:otp|passcode|one[- ]time (?:code|password)|verification code|security code|login code|sign[- ]in code|2fa code|auth(?:entication)? code)";
const ONE_TIME = [
  new RegExp(`\\b${CODE_PHRASE}\\b\\D{0,20}\\b\\d{4,8}\\b`, "i"),
  new RegExp(`\\b\\d{4,8}\\b\\D{0,20}\\b${CODE_PHRASE}\\b`, "i"),
  /(?<!\b(?:zip|postal|post|pin|area|vs)\s)\bcode[:\s]\s*\d{6,8}\b/i,
];

// A known secret format; a run of at least 24 letters and digits holding upper case, lower case and
// a digit in a word with no `@` or `.`; 13 to 19 digits, spaces or dashes between groups, that pass
// Luhn's check; or a one-time code (ONE_TIME). An email address, a host, a version, a SKU, a commit
// hash, a year and a postal code are none of these.
export function credentialShaped(text: string): boolean {
  if (SECRET_FORMATS.some((format) => format.test(text))) return true;
  for (const word of text.split(/\s+/u)) {
    if (word.includes("@") || word.includes(".")) continue;
    if (
      (word.match(/[A-Za-z0-9]{24,}/g) ?? []).some((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run))
    )
      return true;
  }
  for (const match of text.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return ONE_TIME.some((pattern) => pattern.test(text));
}

// Pinned: a change moves topics, so their fact keys.
export const TOPIC_STOP_WORDS: ReadonlySet<string> = new Set([
  ...[
    "a",
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "because",
    "been",
    "before",
    "being",
  ],
  ...[
    "below",
    "between",
    "both",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "down",
    "during",
    "each",
    "few",
    "for",
    "from",
    "further",
  ],
  ...[
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "here",
    "hers",
    "him",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "me",
    "more",
  ],
  ...[
    "most",
    "my",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "our",
    "ours",
    "out",
    "over",
    "own",
    "same",
    "she",
  ],
  ...[
    "should",
    "so",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "too",
  ],
  ...[
    "under",
    "until",
    "up",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
  ],
  ...[
    "you",
    "your",
    "yours",
    "vs",
    "via",
    "new",
    "home",
    "page",
    "untitled",
    "inbox",
    "dashboard",
    "search",
    "results",
    "login",
    "sign",
  ],
]);
