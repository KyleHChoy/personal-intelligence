import { MintedId, type PublicIdentifier } from "@intelligence/contracts";
import { PageUrl, ULID_PATTERN } from "@intelligence/contracts/personal";

// The URLs and identifiers of the research lane. Code only: nothing here resolves a host or fetches
// anything.

// A page URL in its canonical form (lower-case host, no fragment), or undefined for text that
// is not one.
export function canonicalUrl(text: string): PageUrl | undefined {
  const parsed = PageUrl.safeParse(text);
  return parsed.success ? parsed.data : undefined;
}

// A path segment shaped like a token: 16 or more of these characters, with a digit and a letter.
const TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const tokenShaped = (segment: string): boolean => TOKEN.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);

// A query string (even an empty one), a fragment (even an empty one), a user part, a port other
// than the scheme's default, any percent-encoded byte, or a token-shaped path segment. Read from
// the URL as the parser serializes it, so a byte the parser encodes is counted too. Text that does
// not parse is private.
export function isPrivateUrl(text: string): boolean {
  const url = URL.parse(text);
  if (url === null) return true;
  const { href, username, password, port, pathname } = url;
  return (
    href.includes("?") ||
    href.includes("#") ||
    href.includes("%") ||
    username !== "" ||
    password !== "" ||
    port !== "" ||
    pathname.split("/").some(tokenShaped)
  );
}

// A name is refused when it is a whole personal id (a three-letter prefix, "_" and 26 Crockford base32
// characters), a whole id the shared contracts mint (MintedId: a UUID, a hex digest of 16 or more
// characters, and the rest), when it holds six or more digits, or when one of its tokens, split at spaces,
// hyphens and dots, holds a run of eight or more hex characters with two or more digits. A domain is
// refused when one of its labels holds six or more digits. "Mary-Jane Okoro", "al-Ahram", "t-mobile" and
// "Cafe24" are names.
const PERSONAL_ID = new RegExp(`^[a-z]{3}_${ULID_PATTERN}$`);
const digits = (text: string): number => text.match(/\d/g)?.length ?? 0;
const hexRun = (token: string): boolean => (token.match(/[0-9a-f]{8,}/gi) ?? []).some((run) => digits(run) >= 2);

export const idShaped = ({ kind, value }: PublicIdentifier): boolean =>
  kind === "domain"
    ? value.split(".").some((label) => digits(label) >= 6)
    : PERSONAL_ID.test(value) ||
      MintedId.safeParse(value).success ||
      digits(value) >= 6 ||
      value.split(/[\s.-]+/).some(hexRun);
