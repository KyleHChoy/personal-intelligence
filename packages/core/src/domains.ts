import { normalizeAddress } from "./addresses.ts";
import { registrableDomain } from "./public-suffix.ts";

// Mail providers anyone can sign up with, the mail domains of internet providers, address relays,
// and hosting providers that hand out addresses. An address on one, or on a domain under one, says
// nothing about an organization. A pinned, general list: nothing here is one owner's, and an entry
// is added by a pull request.
export const CONSUMER_DOMAINS: readonly string[] = Object.freeze([
  // Free mail.
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "live.com",
  "live.co.uk",
  "live.fr",
  "live.ca",
  "msn.com",
  "windowslive.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "yahoo.co.in",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.com.br",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.it",
  "yahoo.es",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "tuta.com",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "mail.com",
  "email.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "ya.ru",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "rambler.ru",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sohu.com",
  "aliyun.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "hushmail.com",
  "mailfence.com",
  "posteo.de",
  "posteo.net",
  "mailbox.org",
  "runbox.com",
  "disroot.org",
  "riseup.net",
  "startmail.com",
  "libero.it",
  "virgilio.it",
  "tiscali.it",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "t-online.de",
  "freenet.de",
  "seznam.cz",
  "wp.pl",
  "o2.pl",
  "interia.pl",
  "onet.pl",
  "rediffmail.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "juno.com",
  "netzero.net",
  // Internet providers' mail.
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "ntlworld.com",
  "talktalk.net",
  "shaw.ca",
  "rogers.com",
  "sympatico.ca",
  "telus.net",
  "bigpond.com",
  "optusnet.com.au",
  "xtra.co.nz",
  // Address relays: each address stands for someone whose own domain it hides.
  "privaterelay.appleid.com",
  "duck.com",
  "mozmail.com",
  "simplelogin.com",
  "simplelogin.fr",
  "anonaddy.com",
  "anonaddy.me",
  "addy.io",
  // Hosting providers that hand out addresses on their own domain.
  "secureserver.net",
]);

const PROVIDERS = new Set(CONSUMER_DOMAINS);

// Whether a domain is a provider's: listed, or under a listed domain.
export function consumerDomain(domain: string): boolean {
  const labels = domain.split(".");
  return labels.some((_, i) => PROVIDERS.has(labels.slice(i).join(".")));
}

// The registrable domain every fold here takes: the vendored list's. The one seam is for tests:
// the repository's synthetic data names organizations under the documentation domains,
// `quarry.example.org` beside `harbor.example.org`, and its tests run with `useDocumentationFold`
// of `@intelligence/personal-core/testing`, installed by the test runner's setup file. Production code never calls it, and nothing here names a domain.
let registrable: (host: string) => string | null = registrableDomain;
export function useRegistrableDomain(fold?: (host: string) => string | null): void {
  registrable = fold ?? registrableDomain;
}

// The key a domain is fingerprinted under wherever it is matched to an organization: its
// registrable domain, so every subdomain is one organization's, or the domain itself when it has
// none.
export function foldDomain(domain: string): string {
  return registrable(domain) ?? domain;
}

// The organization a domain stands for: its folded domain. Null for a provider's domain, a
// public suffix, and a domain with no registrable part.
export function organizationOfDomain(domain: string): string | null {
  if (consumerDomain(domain) || registrable(domain) === null) return null;
  const folded = foldDomain(domain);
  return consumerDomain(folded) ? null : folded;
}

// The organization domain of a normalized address. Null for an address that does not normalize,
// and for any domain organizationOfDomain answers null for.
export function organizationDomain(address: string): string | null {
  const domain = normalizeAddress(address)?.split("@")[1];
  return domain === undefined ? null : organizationOfDomain(domain);
}

// The domain an extraction mention names: `domain:<d>` with `<d>` a domain as an address would hold it,
// in lower case. Null for anything else.
export function mentionDomain(value: string): string | null {
  if (!value.startsWith("domain:")) return null;
  const domain = value.slice("domain:".length);
  if (domain.includes("@") || domain.trim() !== domain) return null;
  return normalizeAddress(`postmaster@${domain}`)?.split("@")[1] ?? null;
}

// The organization a `domain:` mention names: the mention's domain, folded.
export function mentionOrganization(value: string): string | null {
  const domain = mentionDomain(value);
  return domain === null ? null : organizationOfDomain(domain);
}
