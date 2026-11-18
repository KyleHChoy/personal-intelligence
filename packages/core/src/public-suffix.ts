import { domainToASCII } from "node:url";
import { repoFile } from "./repo-root.ts";

// The registrable domain of a host by the Public Suffix List: the public suffix and one label more,
// so `mail.example.co.uk` and `example.co.uk` are one organization's. The algorithm is the list's
// own (https://publicsuffix.org/list/): the matching rule with the most labels wins, an exception
// rule wins over every other, and an unlisted top level is a suffix of one label (the implicit
// `*`). Both sections of the list count, as browsers count them. The list is vendored, unchanged in
// its rules, at ontology/public-suffix-list.dat.

export type SuffixRules = {
  readonly exact: ReadonlySet<string>;
  readonly wildcard: ReadonlySet<string>;
  readonly exception: ReadonlySet<string>;
};

// A label sequence in its ASCII (punycode) form, or null when it has none.
const ascii = (labels: string): string | null => {
  const form = domainToASCII(labels);
  return form === "" ? null : form;
};

// The rules of a list's text: the first word of each line that is not a comment. A rule is kept in
// its ASCII form, so a host matches whether it is written in Unicode or in punycode.
export function parseSuffixRules(text: string): SuffixRules {
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const line of text.split("\n")) {
    const rule = line.trim().split(/\s/)[0] ?? "";
    if (rule === "" || rule.startsWith("//")) continue;
    const [set, rest] = rule.startsWith("!")
      ? [exception, rule.slice(1)]
      : rule.startsWith("*.")
        ? [wildcard, rule.slice(2)]
        : [exact, rule];
    const form = ascii(rest);
    if (form !== null) set.add(form);
  }
  return { exact, wildcard, exception };
}

// The registrable domain of `host` under `rules`, in the host's own lower-case form, or null when
// the host is itself a public suffix, has an empty label, or has no ASCII form. Pure.
export function registrableDomainIn(rules: SuffixRules, host: string): string | null {
  const given = host.toLowerCase();
  const labels = given.split(".");
  if (labels.some((label) => label === "")) return null;
  const form = ascii(given);
  if (form === null) return null;
  const parts = form.split(".");
  // IDNA maps each label to one label, so a count of labels in one form is a count in the other.
  if (parts.length !== labels.length) return null;
  const tail = (n: number): string => parts.slice(parts.length - n).join(".");
  let suffix = 1;
  for (let n = parts.length; n >= 1; n -= 1) {
    if (rules.exception.has(tail(n))) {
      suffix = n - 1;
      break;
    }
    if (rules.exact.has(tail(n)) || (n > 1 && rules.wildcard.has(tail(n - 1)))) {
      suffix = Math.max(suffix, n);
    }
  }
  return labels.length > suffix ? labels.slice(labels.length - suffix - 1).join(".") : null;
}

// The vendored list's rules, read once, on first use.
export const publicSuffixRules: () => SuffixRules = repoFile("ontology/public-suffix-list.dat", parseSuffixRules);

export const registrableDomain = (host: string): string | null => registrableDomainIn(publicSuffixRules(), host);
