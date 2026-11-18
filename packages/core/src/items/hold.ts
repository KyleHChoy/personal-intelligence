// A password reset, a sign-in link or a one-time code arrives as ordinary mail, and an agent
// steered by another message could find it and send it out. Code only: a marker is matched as text,
// nothing a message says is followed, and the answer only holds something back. Provisional until
// the owner confirms it.

// The fixed list. A constant of this package and nothing else: no configuration, and no term
// from a message or from the owner's data. A change to it is a new `version`. It decides which
// mail is kept from agents, so it and its two lists are frozen: nothing changes it at run time.
export const RECOVERY_MARKERS: {
  readonly version: number;
  readonly terms: readonly string[];
  readonly senders: readonly string[];
  readonly leadChars: number;
} = Object.freeze({
  version: 1,
  terms: Object.freeze([
    "one-time code",
    "verification code",
    "security code",
    "reset your password",
    "sign-in link",
    "magic link",
    "confirm your email",
  ]),
  // Each a whole local part, before any "+" tag, in lower case.
  senders: Object.freeze(["no-reply", "noreply", "accounts", "security", "verify"]),
  leadChars: 2000,
});

// NFKC, lower case, and every run of characters that are neither letters nor digits as one space.
const normalized = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{Nd}]+/gu, " ");

// A value as whole words: normalized, with a leading and a trailing space.
const wordsOf = (value: string): string => ` ${normalized(value)} `;

// Whether a value holds any of the terms as whole words: a term, normalized, with a space on each side, is in
// the value's words. A value of null matches nothing.
export function matchesAnyTerm(value: string | null, terms: readonly string[]): boolean {
  if (value === null) return false;
  const words = wordsOf(value);
  return terms.some((term) => words.includes(wordsOf(term)));
}

// The first `leadChars` code points of a text. They are within twice as many UTF-16 units.
export const leadOf = (text: string | null, leadChars: number): string | null =>
  text === null ? null : [...text.slice(0, 2 * leadChars)].slice(0, leadChars).join("");

const matches = (value: string | null): boolean => matchesAnyTerm(value, RECOVERY_MARKERS.terms);

// Whether a message is held: its subject matches a term, the first `leadChars` code points of
// its text do, or its sender's local part is on the list and its whole text matches one. A
// pure function of the three values and the list.
export function recoveryHold(about: { subject: string | null; sender?: string; text: string | null }): boolean {
  const { subject, sender, text } = about;
  const { senders, leadChars } = RECOVERY_MARKERS;
  const lead = leadOf(text, leadChars);
  const local = (sender ?? "").toLowerCase().split("@")[0]?.split("+")[0] ?? "";
  return matches(subject) || matches(lead) || (senders.includes(local) && matches(text));
}
