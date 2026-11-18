import { ContactQualityRules } from "@intelligence/contracts/personal";
import { consumerDomain } from "../domains.ts";
import { isProfileKey } from "../profile-key.ts";
import { repoFile } from "../repo-root.ts";

// What a saved or imported contact's organization names and addresses may make claims of, by
// code, with no model. A contact tool fills an organization from the contact's own email domain,
// and a LinkedIn export puts headline text where an organization goes; a function's mailbox saved
// as a contact is no person. So:
// - a name that is a domain makes no organization: one related to the contact's own address
//   domains (the same, a parent or a subdomain) makes neither the affiliation nor the role, since
//   the tool, not the contact, wrote it; any other is no name;
// - a name shaped like a headline makes no organization: a refused character (a comma, a bar, an
//   at sign, a line break), more words than the rules allow, a first-person start or a dangling
//   end, read after one trailing parenthetical is set aside;
// - a provider's domain (a mail provider of consumerDomain's list, or a messaging or texting
//   provider of the rules') never names an organization, the contact's own or not, and leaves a
//   role its title alone, since it says nothing of where anyone works;
// - a title shaped like a headline makes no role: a refused character (a hash, a bar, an at sign, a
//   line break), a nested parenthetical, a first-person start, a dangling end, or a word that needs
//   an organization after it and has none ("at and", "at,"). A comma and a long title are kept:
//   "VP, Engineering" is a title;
// - a contact whose every email address is a function's mailbox, by its local part alone, makes no
//   claim about a person.
// The words and the bound are `ontology/contact-quality.json`. Pure.

// The rule table, parsed once.
export const contactQualityRules: () => ContactQualityRules = repoFile("ontology/contact-quality.json", (text) =>
  ContactQualityRules.parse(JSON.parse(text)),
);

// A contact's email addresses, in lower case: its identifiers that are no profile, proposal,
// meeting or phone key.
const emailsOf = (addresses: readonly string[]): string[] =>
  addresses.filter((one) => !isProfileKey(one) && one.includes("@")).map((one) => one.toLowerCase());

// A local part or a list word with - _ . dropped, so `ux.research`, `ux_research` and `uxresearch`
// are one.
const squashed = (local: string): string => local.replaceAll(/[-_.]/gu, "");

// The local part of an address before any +tag.
const localOf = (address: string): string => address.slice(0, address.lastIndexOf("@")).split("+")[0] ?? "";

// Whether the contact is a function's mailbox: it has an email address, and every one has a local
// part on the rules' list.
export function mailboxContact(
  addresses: readonly string[],
  rules: ContactQualityRules = contactQualityRules(),
): boolean {
  const emails = emailsOf(addresses);
  if (emails.length === 0) return false;
  const roles = new Set(rules.roleLocalParts.map(squashed));
  return emails.every((email) => roles.has(squashed(localOf(email))));
}

// The domains of a contact's email addresses, each once.
export const ownDomainsOf = (addresses: readonly string[]): string[] => [
  ...new Set(emailsOf(addresses).map((email) => email.slice(email.lastIndexOf("@") + 1))),
];

// A host name of at least two labels ending in letters.
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

// A name read as a domain: in lower case, with a scheme, a leading `www.` and a trailing slash set
// aside. Null when it is not one.
function domainOf(name: string): string | null {
  const bare = name
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/\/$/u, "")
    .replace(/^www\./u, "");
  return DOMAIN.test(bare) ? bare : null;
}

// The same domain, or one under the other.
const related = (a: string, b: string): boolean => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

// A word as the start and end rules compare it: lower case, curly apostrophes straight, and the
// marks around it set aside (an ampersand and an apostrophe kept).
const wordOf = (word: string): string =>
  word
    .toLowerCase()
    .replaceAll(/[‘’]/gu, "'")
    .replace(/^[^\p{L}\p{N}&']+/u, "")
    .replace(/[^\p{L}\p{N}&']+$/u, "");

// A name less one comma that stands before a legal suffix alone ("Example Works, Inc."), which is
// part of a name and no headline's.
function withoutLegalSuffix(name: string, rules: ContactQualityRules): string {
  const at = name.lastIndexOf(",");
  if (at < 0) return name;
  const suffix = name
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "");
  return rules.legalSuffixes.includes(suffix) ? name.slice(0, at).trimEnd() : name;
}

export type OrganizationReading = { kind: "name"; name: string } | { kind: "own_domain" } | { kind: "refused" };

// What an organization name, already trimmed and non-empty, makes. A name's one trailing
// parenthetical is a description: the name before it is read, and is what is kept.
export function organizationReading(
  name: string,
  ownDomains: readonly string[],
  rules: ContactQualityRules = contactQualityRules(),
): OrganizationReading {
  // A provider's domain says nothing of where anyone works, so a title beside it stands alone.
  if (providerDomain(name, rules)) return { kind: "refused" };
  const domain = domainOf(name);
  if (domain !== null)
    return ownDomains.some((own) => related(domain, own)) ? { kind: "own_domain" } : { kind: "refused" };
  const named = name.replace(/\s*\([^()]*\)\s*$/u, "").trim();
  if (named === "") return { kind: "refused" };
  const read = withoutLegalSuffix(named, rules);
  if ([...read].some((char) => rules.refusedCharacters.includes(char))) return { kind: "refused" };
  const words = read.split(/\s+/u).filter((one) => one !== "");
  if (words.length > rules.organizationMostWords) return { kind: "refused" };
  const [first, last] = [wordOf(words[0] ?? ""), wordOf(words.at(-1) ?? "")];
  if (rules.firstPersonStarts.includes(first) || rules.danglingEnds.includes(last)) return { kind: "refused" };
  return { kind: "name", name: named };
}

// Whether a name is a provider's domain, or a domain under one: a mail provider's (consumerDomain's
// list) or a messaging or texting provider's (the rules').
export function providerDomain(name: string, rules: ContactQualityRules = contactQualityRules()): boolean {
  const domain = domainOf(name);
  if (domain === null) return false;
  return consumerDomain(domain) || rules.providerDomains.some((one) => domain === one || domain.endsWith(`.${one}`));
}

// Whether a parenthetical holds another: "(#Dean (Current))".
function nested(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (depth > 1) return true;
  }
  return false;
}

// Whether a title, already trimmed and non-empty, makes a role.
export function titleKept(title: string, rules: ContactQualityRules = contactQualityRules()): boolean {
  if ([...title].some((char) => rules.titleRefusedCharacters.includes(char)) || nested(title)) return false;
  const raws = title.split(/\s+/u);
  const words = raws.map(wordOf);
  for (const [i, word] of words.entries()) {
    if (!rules.titleOrphanWords.includes(word)) continue;
    // A mark right after the word ("at,") or no name after it ("at and", "at &", "at").
    const next = words[i + 1];
    if (/[,;:]$/u.test(raws[i] ?? "") || next === undefined || next === "" || next === "and" || next === "&")
      return false;
  }
  const [first, last] = [words[0] ?? "", words.at(-1) ?? ""];
  return !rules.firstPersonStarts.includes(first) && !rules.danglingEnds.includes(last);
}
