import { sendAddress } from "@intelligence/contracts/personal";

// Trimmed and lower-cased. An address has exactly one "@", a non-empty local part, and a domain
// with at least one dot and no empty label. Anything else is null.
export function normalizeAddress(text: string): string | null {
  const address = text.trim().toLowerCase();
  const parts = address.split("@");
  if (parts.length !== 2) return null;
  const [local = "", domain = ""] = parts;
  const labels = domain.split(".");
  if (local === "" || labels.length < 2 || labels.includes("")) return null;
  return address;
}

const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const STRICT = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

export function strictAddress(value: string): boolean {
  const at = value.indexOf("@");
  return value.length <= 254 && at >= 1 && at <= 64 && STRICT.test(value);
}

// Trimmed, then the addr-spec inside `<` and `>` when the value holds one pair of them, else the
// whole value, through the send proxy's sendAddress.
export function addressOf(value: string): { address: string } | { refused: string | null } {
  const trimmed = value.trim();
  const open = trimmed.indexOf("<");
  const close = trimmed.indexOf(">");
  const paired = open !== -1 && close > open && trimmed.lastIndexOf("<") === open && trimmed.lastIndexOf(">") === close;
  const candidate = paired ? trimmed.slice(open + 1, close) : trimmed;
  const address = sendAddress(candidate);
  return address === null ? { refused: normalizeAddress(candidate) } : { address };
}

// The store checks each strictly before it fingerprints it.
export function addressesIn(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)].map((match) => match[0]);
}

// The addresses a quote holds, loosely: lower-cased, a trailing full stop dropped.
const QUOTED_ADDRESS = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[^\s<>"'(),;:]+/gu;
export const addressesInQuote = (text: string): string[] =>
  [...text.matchAll(QUOTED_ADDRESS)].map((one) => one[0].toLowerCase().replace(/\.$/u, ""));

// A local part is dot-atoms of ASCII atext, a domain two or more labels of letters, digits and inner hyphens.
// Neither side may touch another character of an address or any non-ASCII character, so an address inside a
// word is none. An apostrophe and a backtick are atext, and also wrap addresses: a token that starts with them
// is given both with and without them. Lower-cased, as an address fingerprint's input is, each once, in order.
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~\\-";
const INNER_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const TOKEN_ADDRESS = new RegExp(
  `(?<![${ATEXT}.@]|[^\\x00-\\x7F])[${ATEXT}]+(?:\\.[${ATEXT}]+)*@${INNER_LABEL}(?:\\.${INNER_LABEL})+(?![A-Za-z0-9@-]|\\.[A-Za-z0-9]|[^\\x00-\\x7F])`,
  "g",
);

export function findAddresses(text: string): string[] {
  const found = [...text.matchAll(TOKEN_ADDRESS)].flatMap(([address]) => {
    const unquoted = address.replace(/^['`]+/, "");
    return unquoted === address || unquoted.startsWith("@") ? [address] : [address, unquoted];
  });
  return [...new Set(found.map((address) => address.toLowerCase()))];
}
