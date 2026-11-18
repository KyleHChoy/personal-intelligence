import { QuestionRulesData } from "@intelligence/contracts/personal";
import { addressesInQuote } from "../addresses.ts";
import { organizationOfDomain } from "../domains.ts";
import { personLink } from "../items/person-links.ts";
import { repoFile } from "../repo-root.ts";

// Same-person questions go to agents; this holds the rules made from the owner's own answers. Pure:
// what code decides. No model reads or writes any of it.

export const questionRules: () => QuestionRulesData = repoFile("ontology/questions.json", (text) =>
  QuestionRulesData.parse(JSON.parse(text)),
);

const wordsOf = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((one) => one !== "");

const squeezed = (text: string): string => wordsOf(text).join(" ");

// Words that say nothing about who someone is: greetings, sign-offs, mail furniture. Code cannot judge
// what a sentence means, so this only removes what plainly carries nothing, and a second agent must agree.
const STOCK = new Set(
  "the and for with from this that have has you your our are was were will would can could please thanks thank regards kind best sincerely cheers yours warm warmly many hello dear hey sent iphone android mobile device email mail message reply wrote original forwarded unsubscribe confidential disclaimer phone tel cell fax office direct ext".split(
    " ",
  ),
);

// The words of a quote left once the people's names and stock words are out, of three characters or more
// and holding a letter: a phone number's digits say nothing of who someone is.
const beyondName = (quote: string, names: readonly string[]): string[] => {
  const name = new Set(names.flatMap(wordsOf));
  return wordsOf(quote).filter(
    (word) => !name.has(word) && !STOCK.has(word) && [...word].length >= 3 && /\p{L}/u.test(word),
  );
};

export type QuoteOf = {
  quote: string;
  text: string | null;
  // Which person's log the cited message is on: "a", "b", or neither to code.
  side?: "a" | "b" | null;
};

// Why an answer's quotes do not hold, or null. Each must stand in its message's text, as the agent read it,
// and say something beyond the names the two people carry. A code that claims a fact code can check is
// checked: `shared_address` needs a quote on one person's message holding the other person's address, and
// `shared_phone` one phone in a quote from each side. A shared name proves nothing, however sure an agent is.
export function quoteRefusal(
  quotes: readonly QuoteOf[],
  names: readonly string[],
  claim?: { because: string; addresses: { a: readonly string[]; b: readonly string[] } },
): "quote_not_found" | "name_only" | "claim_unproved" | null {
  for (const one of quotes)
    if (one.text === null || !squeezed(one.text).includes(squeezed(one.quote))) return "quote_not_found";
  if (!quotes.every((one) => beyondName(one.quote, names).length >= 2)) return "name_only";
  if (claim?.because === "shared_address") {
    const held = (side: "a" | "b"): ReadonlySet<string> =>
      new Set(claim.addresses[side].map((one) => one.toLowerCase()));
    const crosses = quotes.some(
      (one) =>
        (one.side === "a" && addressesInQuote(one.quote).some((found) => held("b").has(found))) ||
        (one.side === "b" && addressesInQuote(one.quote).some((found) => held("a").has(found))),
    );
    if (!crosses) return "claim_unproved";
  }
  // A family or an office shares a line: a phone alone is never enough.
  if (claim?.because === "shared_phone") return "claim_unproved";
  return null;
}

// What each of two people's records say, as cited, and whether a same can rest on it.
// `row`: what it stands on, where it is known. Two values from one row, a card listing both people, agree on nothing.
export type RecordValue = { field: "name" | "address" | "company" | "phone" | "link"; value: string; row?: string };
const companyKey = (value: string): string =>
  wordsOf(value)
    .filter(
      (word) =>
        ![
          "inc",
          "incorporated",
          "llc",
          "ltd",
          "limited",
          "corp",
          "corporation",
          "company",
          "co",
          "plc",
          "gmbh",
          "llp",
          "lp",
          "the",
        ].includes(word),
    )
    .join(" ");
// What a card's company field holds that says nothing of an employer two people could share, or differ on.
const NOT_AN_EMPLOYER = new Set([
  "self",
  "self employed",
  "angel",
  "angel investor",
  "freelance consultant",
  "independent contractor",
  "advisor",
  "board member",
  "us army",
  "army",
  "us navy",
  "navy",
  "us air force",
  "air force",
  "us marine corps",
  "marine corps",
  "military",
  "harvard",
  "stanford",
  "mit",
  "yale",
  "princeton",
  "oxford",
  "cambridge",
  "berkeley",
  "columbia",
  "selfemployed",
  "student",
  "freelance",
  "freelancer",
  "consultant",
  "independent",
  "independent consultant",
  "contractor",
  "entrepreneur",
  "founder",
  "investor",
  "retired",
  "unemployed",
  "homemaker",
  "none",
  "n a",
  "na",
  "unknown",
  "personal",
  "private",
  "home",
  "family",
  "various",
  "stealth",
  "stealth startup",
]);
const SCHOOL_WORDS = new Set(["university", "universidad", "college", "school", "institute", "academy", "polytechnic"]);
// A company as code compares it: the empty string for what is no employer, which agrees with nothing.
const employerKey = (value: string): string => {
  const key = companyKey(value);
  return NOT_AN_EMPLOYER.has(key) || key.split(" ").some((word) => SCHOOL_WORDS.has(word)) ? "" : key;
};
// Whether each side names an employer and none of one side's is the other's. A move looks the same as two
// people, so this only ever holds a pair back.
export function employersDiffer(a: readonly string[], b: readonly string[]): boolean {
  const named = (list: readonly string[]): Set<string> => new Set(list.map(employerKey).filter((one) => one !== ""));
  const [ours, theirs] = [named(a), named(b)];
  return ours.size > 0 && theirs.size > 0 && ![...ours].some((one) => theirs.has(one));
}

// A link that names one person: a LinkedIn profile, or an account's own page on a host of accounts. A firm's
// homepage is on every colleague's card, so it names nobody.
const profileOf = (value: string): string | null => {
  const link = personLink(value);
  if (link === null) return null;
  const { pathname } = new URL(link.url);
  const path = pathname.split("/").filter((one) => one !== "");
  const named =
    link.kind === "linkedin"
      ? path.length === 2 && path[0] === "in"
      : (link.kind === "x" || link.kind === "github") && path.length === 1;
  return named ? `${link.kind}/${path.join("/")}`.toLowerCase() : null;
};
// Only a LinkedIn profile is sure to be one person's: `github.com/northwind` and `x.com/northwindhq_example` read the same
// as an account of a person's own.
const isLinkedIn = (one: RecordValue): boolean =>
  one.field === "link" && (profileOf(one.value) ?? "").startsWith("linkedin/");
const keyOf = (one: RecordValue): string =>
  one.field === "company"
    ? employerKey(one.value)
    : one.field === "link"
      ? (profileOf(one.value) ?? "")
      : one.field === "address"
        ? one.value.trim().toLowerCase()
        : squeezed(one.value);
const agree = (a: readonly RecordValue[], b: readonly RecordValue[], field: RecordValue["field"]): boolean =>
  a.some(
    (one) =>
      one.field === field &&
      keyOf(one) !== "" &&
      b.some(
        (other) =>
          other.field === field && keyOf(other) === keyOf(one) && (one.row === undefined || one.row !== other.row),
      ),
  );

// A domain that says nothing of an employer: a school's, a government's, an alumni address for life.
const NOT_AN_EMPLOYER_DOMAIN =
  /(^|\.)(alumni|alum)\.|\.k12\.|\.(edu|gov|mil|int)(\.[a-z]{2})?$|\.(ac|sch|gouv|govt)\.[a-z]{2}$/u;
// What may follow a firm's name on a card when its domain is the name alone: Northwind Capital at northwind.example.
const FIRM_WORDS = new Set(
  "capital partners group ventures holdings labs technologies technology tech consulting advisors solutions systems software management investments fund funds international global services".split(
    " ",
  ),
);
// The firm an address is at, as one word, or null. A mail provider's domain says nothing of one.
const firmOf = (address: string): string | null => {
  const domain = address
    .slice(address.indexOf("@") + 1)
    .trim()
    .toLowerCase();
  if (NOT_AN_EMPLOYER_DOMAIN.test(domain)) return null;
  const firm = organizationOfDomain(domain)?.split(".")[0];
  return firm === undefined || firm.length < 3 ? null : firm;
};
// An address at a firm and a card at that firm, by whole words.
const addressAtCompany = (a: readonly RecordValue[], b: readonly RecordValue[]): boolean =>
  a.some((one) => {
    if (one.field !== "address") return false;
    const firm = firmOf(one.value);
    if (firm === null) return false;
    return b.some((other) => {
      if (other.field !== "company") return false;
      const key = employerKey(other.value);
      if (key === "") return false;
      const words = key.split(" ");
      return words.join("") === firm || (words[0] === firm && words.slice(1).every((word) => FIRM_WORDS.has(word)));
    });
  });

// What code holds against any same, read from all each person's records hold, not from what an answer cites.
export type SameFacts = {
  // They carry a name in common.
  sharedName: boolean;
  // People beyond these two who carry a name the two share, under the pair's label.
  otherHolders: number;
  // They share a name no fingerprint on either side stands for, so who else carries it can't be fully counted.
  nameUncounted: boolean;
  companies: { a: readonly string[]; b: readonly string[] };
  sharedPhone: boolean;
  // ontology/questions.json's switch, passed here only to say otherwise.
  rareFullName?: boolean;
};
export type AgainstSame = "common_name" | "differing_companies" | "shared_line";
// The father and son on one line, the two front desks, three of one name: why a same can't stand, or null.
export function againstSame(facts: SameFacts): AgainstSame | null {
  if (facts.nameUncounted || facts.otherHolders > 0) return "common_name";
  if (facts.sharedPhone) return "shared_line";
  return employersDiffer(facts.companies.a, facts.companies.b) ? "differing_companies" : null;
}

// Why a same on these cited values can't stand, or null. Code can compare values and cannot judge meaning, so
// two agents must also agree. One exact address or one LinkedIn profile on both sides outranks what is against a
// same; nothing else does. Any other agreement also takes a name they share: colleagues share a firm. A name alone
// stands only where the owner has turned that on: two words or more and nothing against it.
export function recordsRefusal(
  because: string,
  a: readonly RecordValue[],
  b: readonly RecordValue[],
  facts: SameFacts,
): "no_agreement" | AgainstSame | null {
  if (because === "shared_address") return agree(a, b, "address") ? null : "no_agreement";
  if (because === "same_link" && agree(a.filter(isLinkedIn), b, "link")) return null;
  const against = againstSame(facts);
  if (against !== null) return against;
  if (because === "same_link") return facts.sharedName && agree(a, b, "link") ? null : "no_agreement";
  if (because === "same_company") return facts.sharedName && agree(a, b, "company") ? null : "no_agreement";
  if (because === "address_matches_company")
    return facts.sharedName && (addressAtCompany(a, b) || addressAtCompany(b, a)) ? null : "no_agreement";
  if (because !== "rare_full_name" || !(facts.rareFullName ?? questionRules().rareFullName)) return "no_agreement";
  const named = a.filter((one) => one.field === "name" && wordsOf(one.value).length >= 2);
  return agree(named, b, "name") ? null : "no_agreement";
}

// Keeps one pair for each join a cluster needs, in the order given: once A and B, and B and C, are
// asked, A and C is settled by their answers, and comes back only if one answer is `different`.
// An asked pair stands in for another only within its label: a pair under a wider label than this one,
// which its viewers cannot see, must change nothing they are asked.
export function spanningPairs<T>(
  pairs: readonly T[],
  sides: (pair: T) => readonly [string, string],
  labelOf: (pair: T) => readonly string[] = () => [],
): { kept: T[]; left: number } {
  const kept: T[] = [];
  const reaches = (from: string, to: string, label: ReadonlySet<string>): boolean => {
    const seen = new Set([from]);
    const waiting = [from];
    while (waiting.length > 0) {
      const at = waiting.pop();
      for (const one of kept) {
        if (!labelOf(one).every((part) => label.has(part))) continue;
        const [x, y] = sides(one);
        const next = x === at ? y : y === at ? x : null;
        if (next === null || seen.has(next)) continue;
        if (next === to) return true;
        seen.add(next);
        waiting.push(next);
      }
    }
    return false;
  };
  for (const pair of pairs) {
    const [a, b] = sides(pair);
    if (!reaches(a, b, new Set(labelOf(pair)))) kept.push(pair);
  }
  return { kept, left: pairs.length - kept.length };
}

// Pairs into batches of at most `most`, each person's cluster whole unless it alone is larger.
export function intoBatches<T>(
  pairs: readonly T[],
  sides: (pair: T) => readonly [string, string],
  most: number,
): T[][] {
  const parent = new Map<string, string>();
  const find = (one: string): string => {
    let root = one;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(one, root);
    return root;
  };
  for (const pair of pairs) {
    const [a, b] = sides(pair);
    parent.set(find(b), find(a));
  }
  const clusters = new Map<string, T[]>();
  for (const pair of pairs) {
    const root = find(sides(pair)[0]);
    clusters.set(root, [...(clusters.get(root) ?? []), pair]);
  }
  const batches: T[][] = [];
  let open: T[] = [];
  for (const cluster of clusters.values()) {
    if (open.length > 0 && open.length + cluster.length > most) {
      batches.push(open);
      open = [];
    }
    open.push(...cluster);
    while (open.length > most) {
      batches.push(open.slice(0, most));
      open = open.slice(most);
    }
  }
  if (open.length > 0) batches.push(open);
  return batches;
}

// What a question's answers leave it, a wrong join being the worst outcome and a wrong split a silent one, since a
// job change reads as two people. `same` or `different`: two agents agree. `second`: one has answered and another
// cleared agent could. `owner`: they disagree, neither could tell, a lone answer has nobody to check it, or
// nobody is cleared to be asked at all. `wait`: nobody has answered yet. `clients`: the agents cleared now.
export function afterAnswers(
  answers: readonly { client: string; verdict: "same" | "different" | "cant_tell" }[],
  clients: readonly string[],
): "same" | "different" | "second" | "owner" | "wait" {
  const of = (verdict: string): Set<string> =>
    new Set(answers.filter((one) => one.verdict === verdict).map((one) => one.client));
  const [same, different, cant] = [of("same"), of("different"), of("cant_tell")];
  if (same.size > 0 && different.size > 0) return "owner";
  if (same.size >= 2) return "same";
  if (different.size >= 2) return "different";
  const said = new Set([...same, ...different, ...cant]);
  if (said.size >= 2) return "owner";
  if (said.size === 0) return clients.length === 0 ? "owner" : "wait";
  return clients.some((one) => !said.has(one)) ? "second" : "owner";
}

// The answer on each kind a rule may give: only what stops a question and acts on nothing. A yes on
// an agent's fact is a release, and a release is the owner's on that record alone, so `confirm` can
// never be a rule; a go is work begun, so a planner's yes cannot either. A same-person rule rules
// either way.
const RULE_ANSWERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  about_you: ["reject"],
  agent_claim: ["reject"],
  idea: ["no"],
  opportunity_decision: ["no_go"],
  same_person: ["same", "different"],
});

// Whether a pattern may carry a rule with this answer. A same on a shared name never does; nor on a
// local part unless the owner knows both people, since an address can be chosen to spell a name.
export function ruleAllowed(kind: string, pattern: string, answer: string): boolean {
  if (!(RULE_ANSWERS[kind] ?? []).includes(answer)) return false;
  if (kind === "same_person" && answer === "same") return pattern === "same_person:local_part:2";
  return true;
}

export type PatternAnswer = { kind: string; pattern: string; answer: string; at: string };
export type RuleDue = { kind: string; pattern: string; answer: string; answers: number };

// The patterns whose last `after` answers all agree and that no rule row holds yet, in any status:
// a rule the owner declined or lifted is the owner's no, and is not proposed again. Answers are the owner's own alone,
// as the caller read them.
export function rulesDue(
  answers: readonly PatternAnswer[],
  held: ReadonlySet<string>,
  after: number = questionRules().ruleAfterAnswers,
): RuleDue[] {
  const byPattern = new Map<string, PatternAnswer[]>();
  for (const one of answers) {
    const key = `${one.kind}\n${one.pattern}`;
    byPattern.set(key, [...(byPattern.get(key) ?? []), one]);
  }
  const due: RuleDue[] = [];
  for (const rows of byPattern.values()) {
    const last = [...rows].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, after);
    const [first] = last;
    if (first === undefined || last.length < after || last.some((one) => one.answer !== first.answer)) continue;
    if (!ruleAllowed(first.kind, first.pattern, first.answer)) continue;
    if (held.has(ruleKey(first))) continue;
    due.push({ kind: first.kind, pattern: first.pattern, answer: first.answer, answers: last.length });
  }
  return due.sort((x, y) => (ruleKey(x) < ruleKey(y) ? -1 : 1));
}
export const ruleKey = (one: { kind: string; pattern: string; answer: string }): string =>
  `${one.kind}\n${one.pattern}\n${one.answer}`;
