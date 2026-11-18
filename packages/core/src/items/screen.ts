import type { RestrictedCategory } from "@intelligence/contracts/personal";
import { leadOf, matchesAnyTerm } from "./hold.ts";

// The restricted-category screen at rung 0. A message whose subject, or the first `leadChars` code
// points of whose text, holds one of a category's terms is restricted to that category, when the
// category is on.

// The fixed list, a constant of this package and nothing else, as RECOVERY_MARKERS is. A change
// is a new `version` in a reviewed pull request, which reaches stored mail through sync's term
// pass. `intimate` has no term: it is the decide model's alone.
export const RESTRICTED_TERMS: {
  readonly version: number;
  readonly leadChars: number;
  readonly terms: { readonly [C in RestrictedCategory]: readonly string[] };
} = Object.freeze({
  version: 1,
  leadChars: 2000,
  terms: Object.freeze({
    health: Object.freeze([
      "diagnosis",
      "prescription",
      "lab results",
      "test results",
      "medical record",
      "patient portal",
      "explanation of benefits",
      "therapy session",
    ]),
    money: Object.freeze([
      "bank statement",
      "account statement",
      "brokerage statement",
      "tax return",
      "credit report",
      "pay stub",
      "loan application",
      "wire transfer",
    ]),
    legal: Object.freeze([
      "subpoena",
      "summons",
      "court date",
      "settlement agreement",
      "cease and desist",
      "legal notice",
      "attorney client privileged",
    ]),
    intimate: Object.freeze([]),
  }),
});

// The on categories one of whose terms the subject or the text's lead holds, sorted, each once.
// A category that is not on is never returned.
export function restrictedCategories(
  about: { subject: string | null; text: string | null },
  on: readonly RestrictedCategory[],
): RestrictedCategory[] {
  const lead = leadOf(about.text, RESTRICTED_TERMS.leadChars);
  const matched = on.filter((category) => {
    const terms = RESTRICTED_TERMS.terms[category];
    return matchesAnyTerm(about.subject, terms) || matchesAnyTerm(lead, terms);
  });
  return [...new Set(matched)].sort();
}
